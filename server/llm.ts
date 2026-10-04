import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './store.ts';

/**
 * OpenAI 兼容的 chat 客户端。只依赖 fetch，不引第三方 SDK——
 * 工作台的其余部分（comfy/ffmpeg）也是这个风格：直连，少一层。
 *
 * 配置优先级：进程环境变量 > data/llm.json（设置面板存的）> 项目根 .env > 内置默认。
 * 日常改配置走设置面板，落 data/llm.json；.env 只当兜底和临时覆盖。key 不进仓库（data/ 已忽略）。
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** 网关额外要求的请求头（TAKEBOARD_LLM_HEADERS 给 JSON） */
  extraHeaders: Record<string, string>;
  /** 有没有配 key —— 前端据此提示「去设置面板里填」 */
  configured: boolean;
  /** key 是哪来的：环境变量 / data/llm.json / .env / 没有 */
  source: 'env' | 'file' | 'dotenv' | 'none';
}

/** data/llm.json 的形状。字段都可缺——缺的往下一级（.env / 内置默认）退。 */
export interface LlmFileSettings {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

let dotenvCache: { at: number; values: Record<string, string> } | null = null;

/** 网关要的会话标识：同一进程内保持稳定即可。 */
const opencodeSession = `takeboard-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

function readDotenv(): Record<string, string> {
  const file = path.join(ROOT, '.env');
  try {
    const st = fs.statSync(file);
    if (dotenvCache && dotenvCache.at === st.mtimeMs) return dotenvCache.values;
    const values: Record<string, string> = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      values[m[1]] = v;
    }
    dotenvCache = { at: st.mtimeMs, values };
    return values;
  } catch {
    dotenvCache = { at: 0, values: {} };
    return {};
  }
}

/** 每项都先看进程环境，再看 data/llm.json，最后看 .env —— 临时覆盖不用改文件。 */
function pick(keys: string[], fromFile?: string): { value?: string; source: LlmConfig['source'] } {
  for (const k of keys) {
    const v = process.env[k];
    if (v) return { value: v, source: 'env' };
  }
  if (fromFile) return { value: fromFile, source: 'file' };
  const dot = readDotenv();
  for (const k of keys) {
    const v = dot[k];
    if (v) return { value: v, source: 'dotenv' };
  }
  return { source: 'none' };
}

const LLM_FILE = path.join(ROOT, 'data', 'llm.json');

/** 环境变量名 → 它们压着文件时，界面要提醒「改文件不生效」。 */
const ENV_KEYS = [
  'TAKEBOARD_LLM_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'TAKEBOARD_LLM_API_KEY',
  'OPENAI_API_KEY',
  'TAKEBOARD_LLM_MODEL',
  'OPENAI_MODEL',
  'TAKEBOARD_LLM_TEMPERATURE',
  'TAKEBOARD_LLM_MAX_TOKENS',
  'TAKEBOARD_LLM_TIMEOUT_MS',
  'TAKEBOARD_LLM_HEADERS',
];

export function llmFilePath(): string {
  return LLM_FILE;
}

export function loadLlmFile(): LlmFileSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(LLM_FILE, 'utf8')) as LlmFileSettings;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function numOf(v: unknown, min: number, max: number, name: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} 不是数字（${String(v)}）`);
  if (n < min || n > max) throw new Error(`${name} 要在 ${min}~${max}（现在 ${n}）`);
  return n;
}

/** 存盘前逐项校验：写错的 key/地址要当场报出来，不然要等下一次对话才知道。 */
function checkLlm(next: LlmFileSettings): LlmFileSettings {
  const out: LlmFileSettings = {};
  const baseUrl = String(next.baseUrl ?? '').trim();
  if (baseUrl) {
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`baseUrl 要带 http:// 或 https://（现在给的是 ${baseUrl}）`);
    out.baseUrl = baseUrl.replace(/\/+$/, '');
  }
  const apiKey = String(next.apiKey ?? '').trim();
  if (apiKey) out.apiKey = apiKey;
  const model = String(next.model ?? '').trim();
  if (model) out.model = model;
  const temperature = numOf(next.temperature, 0, 2, 'temperature');
  if (temperature !== undefined) out.temperature = temperature;
  const maxTokens = numOf(next.maxTokens, 1, 200_000, 'maxTokens');
  if (maxTokens !== undefined) out.maxTokens = Math.round(maxTokens);
  const timeoutMs = numOf(next.timeoutMs, 5_000, 1_800_000, 'timeoutMs');
  if (timeoutMs !== undefined) out.timeoutMs = Math.round(timeoutMs);
  if (next.extraHeaders !== undefined) {
    const h = next.extraHeaders;
    if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error('extraHeaders 要是一个 JSON 对象');
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) if (String(k).trim()) clean[String(k).trim()] = String(v);
    if (Object.keys(clean).length) out.extraHeaders = clean;
  }
  return out;
}

/**
 * 存 LLM 配置。apiKey 留空 = 没改（界面回显的是脱敏占位符，写回去会把真 key 弄丢）。
 * 要清掉磁盘上的 key 传 clearApiKey。
 */
export function saveLlmFile(next: LlmFileSettings & { clearApiKey?: boolean }): LlmFileSettings {
  const prev = loadLlmFile();
  // JSON 往返顺手丢掉 undefined，免得「没填的字段」把磁盘上的旧值覆盖成空
  const patch = JSON.parse(JSON.stringify(next)) as LlmFileSettings;
  const merged: LlmFileSettings = { ...prev, ...patch };
  const key = String(next.apiKey ?? '').trim();
  if (next.clearApiKey) delete merged.apiKey;
  else if (key) merged.apiKey = key;
  else if (prev.apiKey) merged.apiKey = prev.apiKey;
  const clean = checkLlm(merged);
  fs.mkdirSync(path.dirname(LLM_FILE), { recursive: true });
  fs.writeFileSync(LLM_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

/** 脱敏：完整 key 永不出服务端，界面只显示头尾。 */
function maskKey(k: string): string {
  if (!k) return '';
  return k.length <= 10 ? '••••••' : `${k.slice(0, 4)}••••••${k.slice(-4)}`;
}

export interface LlmPublic extends Omit<LlmConfig, 'apiKey' | 'configured'> {
  apiKeyMasked: string;
  apiKeySet: boolean;
  /** 磁盘上有没有 key（界面区分「面板里存过」和「只在 .env 里」） */
  apiKeyInFile: boolean;
  file: string;
  /** 有环境变量压着文件：面板改了不生效，得先撤掉它 */
  envOverride: boolean;
}

/** 给界面看的配置：脱敏 + 标注来源，用来渲染设置面板。 */
export function llmPublic(): LlmPublic {
  const cfg = llmConfig();
  const file = loadLlmFile();
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    extraHeaders: cfg.extraHeaders,
    source: cfg.source,
    apiKeyMasked: maskKey(cfg.apiKey),
    apiKeySet: !!cfg.apiKey,
    apiKeyInFile: !!file.apiKey,
    file: LLM_FILE,
    envOverride: ENV_KEYS.some((k) => !!process.env[k]),
  };
}

/** 改完配置按一下「测一下」：真发一轮最小请求，省得下次对话才发现 key 是错的。 */
export async function testLlm(): Promise<{ ok: boolean; detail: string; ms: number; model: string; baseUrl: string }> {
  const cfg = llmConfig();
  const at = Date.now();
  try {
    const r = await chat([{ role: 'user', content: '只回一个字：好' }], [], { maxTokens: 64, temperature: 0 });
    const text = textOf(r.message.content).trim();
    return {
      ok: true,
      detail: `通了（${Date.now() - at}ms）· ${cfg.model} 回了「${text.slice(0, 40) || '空正文，但连接正常'}」`,
      ms: Date.now() - at,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - at, model: cfg.model, baseUrl: cfg.baseUrl };
  }
}

export function llmConfig(): LlmConfig {
  const file = loadLlmFile();
  const base = pick(['TAKEBOARD_LLM_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'], file.baseUrl);
  const key = pick(['TAKEBOARD_LLM_API_KEY', 'OPENAI_API_KEY'], file.apiKey);
  const model = pick(['TAKEBOARD_LLM_MODEL', 'OPENAI_MODEL'], file.model);
  const temp = pick(['TAKEBOARD_LLM_TEMPERATURE'], file.temperature === undefined ? undefined : String(file.temperature));
  const max = pick(['TAKEBOARD_LLM_MAX_TOKENS'], file.maxTokens === undefined ? undefined : String(file.maxTokens));
  const timeout = pick(['TAKEBOARD_LLM_TIMEOUT_MS'], file.timeoutMs === undefined ? undefined : String(file.timeoutMs));
  const headers = pick(
    ['TAKEBOARD_LLM_HEADERS'],
    file.extraHeaders && Object.keys(file.extraHeaders).length ? JSON.stringify(file.extraHeaders) : undefined,
  );
  let extraHeaders: Record<string, string> = {};
  if (headers.value) {
    try {
      extraHeaders = JSON.parse(headers.value);
    } catch {
      throw new Error(`额外请求头不是合法 JSON 对象（来自 ${headers.source === 'file' ? '设置面板' : 'TAKEBOARD_LLM_HEADERS'}）：${headers.value}`);
    }
  }
  const baseUrl = (base.value ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  // OpenCode Go 套餐网关要一个会话标识头，缺了直接 400 MissingSessionID；值不校验，给个稳定的就行
  if (/opencode\.ai/.test(baseUrl) && !extraHeaders['x-opencode-session']) extraHeaders['x-opencode-session'] = opencodeSession;
  return {
    baseUrl,
    apiKey: key.value ?? '',
    model: model.value ?? 'gpt-4o-mini',
    temperature: Number(temp.value ?? 0.7),
    maxTokens: Number(max.value ?? 4096),
    timeoutMs: Number(timeout.value ?? 180_000),
    extraHeaders,
    configured: !!key.value,
    source: key.source,
  };
}

/**
 * 长正文调用的额度下限。剧本 JSON、多候选提示词都算长正文。
 * 推理 token 也算进 max_tokens，按默认 4096 写多镜剧本会被切在半句上——
 * 这类调用一律走这里，别再各写各的 Math.max。
 */
export function longFormTokens(floor = 8192): number {
  return Math.max(llmConfig().maxTokens, floor);
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 多模态内容块。评审要靠它把图真的送进模型——只给文件名模型看不到画面。 */
export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  message: ChatMessage;
  /** 这轮是不是模型自己收尾的（没有要调工具） */
  finished: boolean;
  usage?: Record<string, number>;
  /** 为什么停下：stop=正常收尾，length=撞上 max_tokens 被截断（正文可能就是空的） */
  finishReason?: string;
}

/** 本地文件 → data URL。评审传图用这个，不需要把文件挂到静态目录上。 */
export function dataUrl(file: string, mime = 'image/jpeg'): string {
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

/** 一段文字 + 若干张图。图放前面：有些网关会把纯文本块当成「无图」直接降级。 */
export function userWithImages(text: string, images: string[]): ChatMessage {
  if (!images.length) return { role: 'user', content: text };
  const parts: ContentPart[] = images.map((url) => ({ type: 'image_url', image_url: { url } }));
  parts.push({ type: 'text', text });
  return { role: 'user', content: parts };
}

/** 多模态 content 里把文本挑出来：content 现在可能是数组，直接 .trim() 会炸。 */
export function textOf(content: string | ContentPart[] | null | undefined): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * 一次 chat 往返。tools 为空就不带工具字段——提示词优化这类纯文本任务不需要。
 * 失败信息里带上服务端返回体，排查时不用去猜是 key 错还是模型名错。
 */
export async function chat(
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  opts: { temperature?: number; model?: string; maxTokens?: number } = {},
): Promise<ChatResult> {
  const cfg = llmConfig();
  if (!cfg.configured) throw new Error(`没配 LLM key：打开「⚙ 设置 → LLM · 助手」填一个（落 ${LLM_FILE}），或写进 ${path.join(ROOT, '.env')} 的 TAKEBOARD_LLM_API_KEY`);

  const body: Record<string, unknown> = {
    model: opts.model ?? cfg.model,
    messages,
    temperature: opts.temperature ?? cfg.temperature,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, ...cfg.extraHeaders },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    throw new Error(`连不上 LLM（${cfg.baseUrl}）：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`LLM ${res.status} ${res.statusText}：${text.slice(0, 600)}`);

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`LLM 返回不是 JSON：${text.slice(0, 300)}`);
  }
  const choice = data?.choices?.[0];
  const msg = choice?.message;
  if (!msg) throw new Error(`LLM 返回里没有 choices[0].message：${text.slice(0, 300)}`);

  const message: ChatMessage = {
    role: 'assistant',
    content: msg.content ?? '',
    tool_calls: Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined,
  };
  return { message, finished: !message.tool_calls, usage: data?.usage, finishReason: choice?.finish_reason ?? undefined };
}

/**
 * 让模型吐一个 JSON 对象。提示词里已要求「只输出 JSON」，这里再兜一层代码块/多余文字的清理。
 *
 * 空正文会重试一次：推理模型的 reasoning 也算进 max_tokens，额度被推理吃光时正文就是空的。
 * 撞 length 说明是额度不够，重试没用，直接把 finish_reason 和用量报出来。
 */
export async function chatJson<T>(messages: ChatMessage[], opts: { temperature?: number; model?: string; maxTokens?: number } = {}): Promise<T> {
  let last = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { message, finishReason, usage } = await chat(messages, [], opts);
    const raw = textOf(message.content).trim();
    if (!raw) {
      last = `finish=${finishReason ?? '?'} usage=${JSON.stringify(usage ?? {})}`;
      // 推理 token 也算进 max_tokens：额度被推理吃光时正文就是空的。
      // 这种「空正文」跟「JSON 不合法」是同一个病（额度不够），报错得说人话。
      if (finishReason === 'length') {
        throw new Error(
          `正文被 max_tokens 截断（额度 ${opts.maxTokens ?? llmConfig().maxTokens}，用量 ${JSON.stringify(usage ?? {})}）：` +
            `长正文调用请传 maxTokens: longFormTokens()。`,
        );
      }
      continue;
    }
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    const body = (fenced ? fenced[1] : raw).trim();
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    const slice = start >= 0 && end > start ? body.slice(start, end + 1) : body;
    try {
      return JSON.parse(slice) as T;
    } catch {
      // 撞 length 时正文是断的，JSON 必然不合法——重试一次没用，直接把现场报出来。
      // 以前这里不分 finish_reason 一律 throw，调用方只看到「没给出合法 JSON」，
      // 根本不知道是额度不够，于是「写剧本老被截断」查不到根上。
      if (finishReason === 'length') {
        throw new Error(
          `正文被 max_tokens 截断（额度 ${opts.maxTokens ?? llmConfig().maxTokens}，用量 ${JSON.stringify(usage ?? {})}）：` +
            `长正文调用请传 maxTokens: longFormTokens()。尾部：${raw.slice(-200)}`,
        );
      }
      throw new Error(`模型没给出合法 JSON（finish=${finishReason ?? '?'}）：${raw.slice(0, 400)}`);
    }
  }
  throw new Error(`模型没给出正文：${last}`);
}
