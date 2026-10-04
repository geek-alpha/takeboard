import { status as comfyStatus } from './comfy.ts';
import { chatJson, longFormTokens } from './llm.ts';
import { releaseImagePort } from './gpu.ts';
import { runNode } from './jobs.ts';
import { optimizePrompt } from './prompts.ts';
import { collectRefs } from './refs.ts';
import { exportFilm, handoffShot } from './sequence.ts';
import { loadProject, newId, saveProject } from './store.ts';
import { frameRatio } from './workflows.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import type { Project, Story, StoryBeat, TakeNode } from '../shared/types.ts';

/**
 * 剧情模式：一条从「剧本」到「画布」的路。
 *
 * 分工只有一句话：剧情是数据的真相源，画布是它的实例化。
 *  - 导入或助手创作 → Story（分镜表）
 *  - 填模板 → 每镜建一对节点（首帧 + 出片），提示词写进 node.draft，边连好
 *  - 一条龙 → 出全部首帧 → 释放生图实例 → 出全部片 → 合成，产物照旧进 take 栈
 *
 * 为什么词写在 node.draft 而不是建一堆 text 节点：一镜一个文本节点会让画布爆炸，
 * 而 draft 就在节点上，点开就能改，跑的时候天然当默认值。
 */

/** 每镜默认时长：跟项目默认出片时长同一个源，别在两处各写一个数 */
export const DEFAULT_SECONDS = DEFAULT_SETTINGS.videoSeconds;

export function newBeat(partial: Partial<StoryBeat> = {}): StoryBeat {
  return {
    id: partial.id || newId('beat'),
    title: String(partial.title ?? '新镜头'),
    action: String(partial.action ?? ''),
    image: String(partial.image ?? ''),
    video: String(partial.video ?? ''),
    seconds: Number(partial.seconds) > 0 ? Number(partial.seconds) : DEFAULT_SECONDS,
    aspect: partial.aspect ? String(partial.aspect) : undefined,
    line: partial.line ? String(partial.line) : undefined,
    imageNodeId: partial.imageNodeId,
    videoNodeId: partial.videoNodeId,
  };
}

export function emptyStory(): Story {
  return { title: '', logline: '', style: '', beats: [], source: 'manual', updatedAt: Date.now() };
}

/**
 * 归一化：剧情会从 JSON、前端表单、模型输出三个方向进来，
 * 每个字段都可能缺或给错类型，统一在这里兜住，下游就不用到处判空。
 */
export function normalizeStory(raw: unknown, base?: Story): Story {
  const r = (raw ?? {}) as Partial<Story> & { shots?: unknown; beats?: unknown };
  const list = Array.isArray(r.beats) ? r.beats : Array.isArray(r.shots) ? r.shots : base?.beats ?? [];
  const beats = (list as Partial<StoryBeat>[]).map((b) => newBeat(b));
  return {
    title: String(r.title ?? base?.title ?? '').trim(),
    logline: String(r.logline ?? base?.logline ?? '').trim(),
    style: String(r.style ?? base?.style ?? '').trim(),
    beats,
    source: (r.source as Story['source']) ?? base?.source ?? 'manual',
    updatedAt: Date.now(),
  };
}

/** 读剧情。老项目没这个字段就给空的，调用方不用判 undefined。 */
export function readStory(projectId: string): Story {
  return loadProject(projectId).story ?? emptyStory();
}

/**
 * 写剧情：读-改-写，只动 story 一块（跟 take 并发写盘同一个纪律）。
 * 填过模板的镜头会带着 imageNodeId/videoNodeId 回来，别在归一化里丢掉——丢了就会重复建节点。
 */
export function writeStory(projectId: string, patch: Partial<Story>): Story {
  const p = loadProject(projectId);
  const before = p.story;
  const keepNode = new Map((before?.beats ?? []).map((b) => [b.id, b]));
  const next = normalizeStory({ ...patch, source: patch.source ?? before?.source ?? 'manual' }, before);
  next.beats = next.beats.map((b) => {
    const old = keepNode.get(b.id);
    if (!old) return b;
    return { ...b, imageNodeId: b.imageNodeId ?? old.imageNodeId, videoNodeId: b.videoNodeId ?? old.videoNodeId };
  });
  p.story = next;
  saveProject(p);
  return next;
}

/** 只改某一镜（实时编辑走这条，不重排其他镜头、不碰节点）。 */
export function editBeat(projectId: string, beatId: string, patch: Partial<StoryBeat>): Story {
  const story = readStory(projectId);
  const at = story.beats.findIndex((b) => b.id === beatId || b.title === beatId);
  if (at < 0) {
    throw new Error(`剧情里没有「${beatId}」这一镜。现有：${story.beats.map((b) => b.title).join('、') || '（空的）'}`);
  }
  story.beats[at] = newBeat({ ...story.beats[at], ...patch, id: story.beats[at].id });
  return writeStory(projectId, { ...story, source: 'manual' });
}

/** 排好序的镜头（剧情顺序就是数组顺序）。 */
export function beatsOf(p: Project): StoryBeat[] {
  return p.story?.beats ?? [];
}

/**
 * 这一镜在画布上的两个节点（填过模板才有）。节点被人删了就当作没有，不报错——
 * 剧情和画布会短暂不同步，这里选择让调用方看到「还没填」而不是抛异常打断整条流程。
 */
export function nodesOfBeat(p: Project, beat: StoryBeat): { image?: TakeNode; video?: TakeNode } {
  const find = (id?: string) => (id ? p.nodes.find((n) => n.id === id) : undefined);
  return { image: find(beat.imageNodeId), video: find(beat.videoNodeId) };
}

// ── 剧本解析 ─────────────────────────────────────────────────────────────
// 纯函数，不碰模型不碰盘：导入的剧本五花八门，先离线切成分镜表，切不动再上 AI。

export interface ParsedScript {
  title: string;
  logline: string;
  style: string;
  beats: StoryBeat[];
}

const RE_JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;
const RE_MD_HEAD = /^#{1,6}\s*(.+?)\s*$/;
const RE_BRACKET = /^[【\[]\s*(.+?)\s*[】\]]\s*$/;
const RE_SHOT = /^(?:镜头|分镜|shot|scene|场景)\s*([0-9一二三四五六七八九十]+)?\s*[:：.、\-—]?\s*(.*)$/i;
const RE_ORDERED = /^(\d{1,3})\s*[.、)）]\s*(.+)$/;
const RE_FIELD =
  /^(画面|视觉|静态|生图|图片|首帧|image|prompt|动作|运镜|出片|视频|运动|video|台词|对白|旁白|line|时长|秒|seconds|duration)\s*[:：]\s*(.*)$/i;
const RE_META = /^(片名|剧名|标题|一句话|logline|简介|风格|style)\s*[:：]\s*(.*)$/i;

const FIELD_IMAGE = new Set(['画面', '视觉', '静态', '生图', '图片', '首帧', 'image', 'prompt']);
const FIELD_VIDEO = new Set(['动作', '运镜', '出片', '视频', '运动', 'video']);
const FIELD_LINE = new Set(['台词', '对白', '旁白', 'line']);
const FIELD_SECONDS = new Set(['时长', '秒', 'seconds', 'duration']);
const FIELD_STYLE = new Set(['风格', 'style']);
const FIELD_TITLE = new Set(['片名', '剧名', '标题']);

/** 「6s」「6 秒」「0:06」「1分30秒」都吃。 */
export function parseSeconds(v: string): number | undefined {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const clock = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  let total = 0;
  let hit = false;
  const rest = s.replace(/(\d+(?:\.\d+)?)\s*(?:分|min\b)/i, (_, n: string) => {
    total += Number(n) * 60;
    hit = true;
    return '';
  });
  const sec = /(\d+(?:\.\d+)?)/.exec(rest);
  if (sec) {
    total += Number(sec[1]);
    hit = true;
  }
  return hit && total > 0 ? Math.round(total * 10) / 10 : undefined;
}

/** 镜头头：返回名字（可能为空）。不是镜头头就返回 null。 */
function headOf(line: string): string | null {
  const md = RE_MD_HEAD.exec(line);
  if (md) return md[1].replace(/^镜头\s*[0-9一二三四五六七八九十]*\s*[:：.、]?\s*/i, '').trim();
  const shot = RE_SHOT.exec(line);
  if (shot) return (shot[2] ?? '').trim() || `镜头${shot[1] ?? ''}`;
  const br = RE_BRACKET.exec(line);
  if (br) return br[1].trim();
  const ord = RE_ORDERED.exec(line);
  if (ord) return ord[2].trim();
  return null;
}

/** 整段就是 JSON（带不带 ``` 围栏都行）。认不出来返回 undefined。 */
function tryJsonScript(raw: string): ParsedScript | undefined {
  const body = (RE_JSON_FENCE.exec(raw)?.[1] ?? raw).trim();
  if (!/^[[{]/.test(body)) return undefined;
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    return undefined;
  }
  const list = Array.isArray(data) ? data : (data.beats ?? data.shots ?? data.镜头 ?? data.scenes);
  if (!Array.isArray(list) || !list.length) return undefined;
  return {
    title: String(data.title ?? data.片名 ?? '').trim(),
    logline: String(data.logline ?? data.一句话 ?? '').trim(),
    style: String(data.style ?? data.风格 ?? '').trim(),
    beats: list.map((b: any, i: number) =>
      newBeat({
        title: String(b.title ?? b.标题 ?? b.镜头 ?? `镜头${i + 1}`).trim(),
        action: String(b.action ?? b.动作 ?? b.描述 ?? '').trim(),
        image: String(b.image ?? b.画面 ?? b.首帧词 ?? b.imagePrompt ?? '').trim(),
        video: String(b.video ?? b.出片词 ?? b.videoPrompt ?? '').trim(),
        seconds: parseSeconds(String(b.seconds ?? b.时长 ?? '')) ?? DEFAULT_SECONDS,
        aspect: b.aspect ?? b.画幅,
        line: b.line ?? b.台词,
      }),
    ),
  };
}

/**
 * 剧本文本 → 分镜表。识别顺序：JSON → 镜头头（## / 【】/ 镜头N / 1.）→ 空行分段。
 * 认出来的东西都只是「初稿」：词多半是中文画面描述，后面可以让 H3 逐镜精修。
 */
export function parseScript(text: string): ParsedScript {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('剧本是空的');
  const fromJson = tryJsonScript(raw);
  if (fromJson) return fromJson;

  const out: ParsedScript = { title: '', logline: '', style: '', beats: [] };
  let cur: StoryBeat | undefined;
  let field: 'action' | 'image' | 'video' | 'line' | null = null;
  /** 这一镜吃到过「画面：」这类字段行没有 —— 有就是结构化分镜，空行不断镜 */
  let hasField = false;

  const push = (v: string) => {
    if (!cur) return;
    const val = v.trim();
    if (!val) return;
    if (field === 'image') cur.image = cur.image ? `${cur.image}\n${val}` : val;
    else if (field === 'video') cur.video = cur.video ? `${cur.video}\n${val}` : val;
    else if (field === 'line') cur.line = cur.line ? `${cur.line} ${val}` : val;
    else cur.action = cur.action ? `${cur.action}\n${val}` : val;
  };

  const flush = () => {
    if (cur && (cur.action || cur.image || cur.video || cur.line)) out.beats.push(cur);
    cur = undefined;
  };

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      // 自由段落（从没出现过字段行）里空行就是分镜边界；结构化分镜里的空行只是分段
      if (cur && !hasField) flush();
      field = null;
      continue;
    }
    // 第一个一级标题是片名，不是镜头（## 才是镜头头）
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1 && !cur && !out.beats.length && !out.title) {
      out.title = h1[1].trim();
      continue;
    }
    const meta = RE_META.exec(line);
    // 片名/一句话/风格在「不在镜头里」时生效：正文里的「风格：」不该被吞掉
    if (meta && !cur) {
      const key = meta[1].toLowerCase();
      if (FIELD_TITLE.has(key)) {
        if (!out.title) out.title = meta[2].trim();
      } else if (key === '一句话' || key === 'logline' || key === '简介') out.logline = meta[2].trim();
      else out.style = meta[2].trim();
      continue;
    }
    const f = RE_FIELD.exec(line);
    if (f && cur) {
      const key = f[1].toLowerCase();
      hasField = true;
      if (FIELD_SECONDS.has(key)) {
        cur.seconds = parseSeconds(f[2]) ?? cur.seconds;
        field = null;
        continue;
      }
      if (FIELD_STYLE.has(key)) {
        cur.action = cur.action ? `${cur.action}\n风格：${f[2]}` : `风格：${f[2]}`;
        field = 'action';
        continue;
      }
      field = FIELD_IMAGE.has(key) ? 'image' : FIELD_VIDEO.has(key) ? 'video' : FIELD_LINE.has(key) ? 'line' : 'action';
      push(f[2]);
      continue;
    }
    const head = headOf(line);
    if (head !== null) {
      flush();
      cur = newBeat({ title: head || `镜头${out.beats.length + 1}` });
      hasField = false;
      field = 'action';
      continue;
    }
    if (!cur) {
      cur = newBeat({ title: `镜头${out.beats.length + 1}` });
      hasField = false;
    }
    push(line);
  }
  flush();

  // 一个镜头头都没认出来：按空行分段，一段一镜
  if (!out.beats.length) {
    for (const block of raw.split(/\n\s*\n/)) {
      const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const first = lines[0].replace(/^#+\s*/, '');
      out.beats.push(
        newBeat({
          title: first.length > 24 ? `镜头${out.beats.length + 1}` : first,
          action: (first.length > 24 ? lines : lines.slice(1)).join('\n'),
        }),
      );
    }
  }
  if (!out.title && out.beats.length) out.title = out.beats[0].title;
  return out;
}

/** 导入剧本 → 落盘成剧情。replace=false 时追加到现有镜头后面。 */
export function importScript(projectId: string, text: string, opts: { replace?: boolean; title?: string } = {}): Story {
  const parsed = parseScript(text);
  if (!parsed.beats.length) throw new Error('这段剧本里没切出任何镜头');
  const before = readStory(projectId);
  const beats = opts.replace === false ? [...before.beats, ...parsed.beats] : parsed.beats;
  return writeStory(projectId, {
    title: opts.title || parsed.title || before.title || '未命名',
    logline: parsed.logline || before.logline,
    style: parsed.style || before.style,
    beats,
    source: 'import',
  });
}

// ── 填充模板 ─────────────────────────────────────────────────────────────
// 每镜一对节点：首帧（image）+ 出片（video）。词写进 node.draft，边连好，位置排开。
// 重填不重建：已经填过的镜头只更新 draft 和参数，已经跑出来的版本一个都不动。

const COL_W = 380;
const ROW_H = 440;

export interface ApplyOptions {
  /** 只填这几镜（beat id 或标题）；不给就全部 */
  beats?: string[];
  /** 起点坐标 */
  x0?: number;
  y0?: number;
  /** 默认画幅档位，写进 draft */
  aspect?: string;
}

export interface ApplyResult {
  created: Array<{ beat: string; image: string; video: string }>;
  updated: string[];
  edges: number;
  total: number;
}

function uniqueTitle(p: Project, want: string, keepId?: string): string {
  const taken = new Set(p.nodes.filter((n) => n.id !== keepId).map((n) => n.title));
  if (!taken.has(want)) return want;
  let i = 2;
  while (taken.has(`${want} ${i}`)) i++;
  return `${want} ${i}`;
}

/**
 * 按剧情把画布填成一套可跑的流水线。
 * 已经填过的镜头走「更新」：节点还在就改 draft，节点被删了就重建这一镜。
 */
export function applyStory(projectId: string, opts: ApplyOptions = {}): ApplyResult {
  const p = loadProject(projectId);
  const story = p.story;
  if (!story?.beats.length) throw new Error('这个工作台还没有剧情。先导入剧本或让助手写一个。');

  const want = opts.beats?.length
    ? story.beats.filter((b) => opts.beats!.some((r) => r === b.id || r === b.title || b.title.includes(r)))
    : story.beats;
  if (!want.length) throw new Error(`没匹配到镜头：${opts.beats!.join('、')}`);

  const x0 = opts.x0 ?? 120;
  const y0 = opts.y0 ?? 120;
  const result: ApplyResult = { created: [], updated: [], edges: 0, total: want.length };

  // 新镜头接着现有内容排，别压在已有的节点上
  const maxX = p.nodes.length ? Math.max(...p.nodes.map((n) => n.x)) + COL_W : x0;
  const baseX = Math.max(x0, maxX);

  want.forEach((beat, i) => {
    const x = baseX + i * COL_W;
    // 「跟随首帧」不是档位名，别当成面板指定传给下游（传了会压住首帧实际比例）
    const rawAspect = beat.aspect ?? opts.aspect;
    const aspect = rawAspect && !/^(跟随|auto|首帧)/i.test(rawAspect) ? rawAspect : undefined;
    const imageDraft = {
      prompt: (beat.image || beat.action).trim(),
      aspect,
      workflow: p.settings.workflowImage,
    };
    const videoDraft = {
      prompt: (beat.video || beat.action).trim(),
      seconds: beat.seconds,
      aspect,
      workflow: p.settings.workflowVideo,
    };

    let img = beat.imageNodeId ? p.nodes.find((n) => n.id === beat.imageNodeId) : undefined;
    let vid = beat.videoNodeId ? p.nodes.find((n) => n.id === beat.videoNodeId) : undefined;

    if (img && img.kind !== 'image') img = undefined;
    if (vid && vid.kind !== 'video') vid = undefined;

    if (!img) {
      img = { id: newId('node'), kind: 'image', title: uniqueTitle(p, `${beat.title}·首帧`), x, y: y0, takes: [] };
      p.nodes.push(img);
      beat.imageNodeId = img.id;
      result.created.push({ beat: beat.title, image: img.id, video: '' });
    } else {
      img.draft = { ...(img.draft ?? {}), ...imageDraft };
      result.updated.push(`${beat.title}·首帧`);
    }
    img.draft = { ...(img.draft ?? {}), ...imageDraft };

    if (!vid) {
      vid = { id: newId('node'), kind: 'video', title: uniqueTitle(p, beat.title), x, y: y0 + ROW_H, takes: [] };
      p.nodes.push(vid);
      beat.videoNodeId = vid.id;
      const rec = result.created.find((c) => c.beat === beat.title);
      if (rec) rec.video = vid.id;
    } else {
      vid.draft = { ...(vid.draft ?? {}), ...videoDraft };
    }
    vid.draft = { ...(vid.draft ?? {}), ...videoDraft };

    const linked = p.edges.some((e) => e.from === img!.id && e.to === vid!.id);
    if (!linked) {
      p.edges.push({ id: newId('edge'), from: img.id, to: vid.id, pin: 'active', createdAt: Date.now() });
      result.edges++;
    }
  });

  story.updatedAt = Date.now();
  p.story = story;
  saveProject(p);
  return result;
}

/** 剧情与画布的对应关系：哪几镜还没填、哪几镜已有成品。面板和助手都读它。 */
export interface StoryStatus {
  title: string;
  logline: string;
  style: string;
  source: string;
  beats: Array<{
    id: string;
    title: string;
    action: string;
    seconds: number;
    image: string;
    video: string;
    line?: string;
    /** 填过模板才有的节点 id */
    imageNodeId?: string;
    videoNodeId?: string;
    /** 首帧出了没、片子出了没 */
    imageDone: boolean;
    videoDone: boolean;
    takes: number;
  }>;
  filled: number;
  done: number;
  totalSeconds: number;
}

export function storyStatus(projectId: string): StoryStatus {
  const p = loadProject(projectId);
  const beats = beatsOf(p);
  const doneOf = (node?: TakeNode): boolean => !!node?.takes.some((t) => t.status === 'done' && t.file);
  const rows = beats.map((b) => {
    const { image, video } = nodesOfBeat(p, b);
    return {
      id: b.id,
      title: b.title,
      action: b.action,
      seconds: b.seconds,
      image: b.image,
      video: b.video,
      line: b.line,
      imageNodeId: image?.id,
      videoNodeId: video?.id,
      imageDone: doneOf(image),
      videoDone: doneOf(video),
      takes: (image?.takes.length ?? 0) + (video?.takes.length ?? 0),
    };
  });
  return {
    title: p.story?.title ?? '',
    logline: p.story?.logline ?? '',
    style: p.story?.style ?? '',
    source: p.story?.source ?? '',
    beats: rows,
    filled: rows.filter((r) => r.imageNodeId && r.videoNodeId).length,
    done: rows.filter((r) => r.videoDone).length,
    totalSeconds: Math.round(rows.reduce((s, r) => s + r.seconds, 0) * 10) / 10,
  };
}

// ── 助手创作 / 逐镜精修 ───────────────────────────────────────────────────

export interface DraftRequest {
  idea: string;
  /** 想要几镜，默认 6 */
  shots?: number;
  /** 每镜时长，默认 5 秒 */
  seconds?: number;
  style?: string;
  ratio?: string;
  /** 已有语境：项目名、已有镜头、既定设定 */
  context?: string;
}

const DRAFT_SYSTEM = `你是短片编剧兼分镜师。把想法写成一张能直接开拍的分镜表。

每个镜头四样东西，缺一不可：
- title：镜头名，中文，4-8 字，说的是「这一镜在拍什么」
- action：这一镜发生什么，中文一句话，写清谁在哪做什么、镜头怎么走
- image：生图提示词，**英文**，逗号分隔的短语流。写这一镜的那个静止瞬间：主体、动作、环境、构图机位、光线、材质、镜头焦段、风格。不要写「a photo of」这类废话开头，不要叙事
- video：出片提示词，**英文**。首帧图模型已经拿到了，所以只写「从这一帧开始发生了什么」：主体动作（含幅度与速度）→ 镜头运动（推/拉/摇/跟/固定）→ 光影与氛围变化 → 收尾状态。不要重述画面里已有的静态外观
- seconds：这一镜几秒（整数）

纪律：
- 全片人物长相、服装、场景、光线基调、画风必须一致，这是短片能不能看的关键
- 相邻镜头要接得上：动作方向、视线、光线别突然翻转；上一镜结束的状态就是下一镜的起点
- 一镜只讲一件事，动作要能在这几秒里做完
- 台词只在真有台词时给（line 字段），没台词就别编`;

/** 让助手写一份剧情。产出的是「初稿」：出片词是画面级描述，要规范格式再走 refineStory。 */
export async function draftStory(req: DraftRequest): Promise<Omit<Story, 'updatedAt'>> {
  const shots = Math.min(Math.max(Math.round(req.shots ?? 6), 1), 24);
  const seconds = req.seconds && req.seconds > 0 ? req.seconds : DEFAULT_SECONDS;
  const lines = [
    `想法：${req.idea?.trim() || '（空，你自己定一个适合短片的故事）'}`,
    `镜头数：${shots}`,
    `每镜时长：约 ${seconds} 秒`,
  ];
  if (req.style) lines.push(`风格：${req.style}`);
  if (req.ratio) lines.push(`画幅：${req.ratio}`);
  if (req.context) lines.push(`已有语境（要接得上）：\n${req.context}`);

  const out = await chatJson<{ title?: string; logline?: string; style?: string; beats?: Partial<StoryBeat>[] }>(
    [
      { role: 'system', content: DRAFT_SYSTEM },
      {
        role: 'user',
        content: `${lines.join('\n')}

只输出 JSON，不要解释文字：
{"title":"片名","logline":"一句话故事","style":"视觉风格，英文短语","beats":[{"title":"镜头名","action":"中文一句话","image":"english image prompt","video":"english motion prompt","seconds":${seconds},"line":"台词，没有就省略"}]}`,
      },
    ],
    { temperature: 0.8, maxTokens: longFormTokens() },
  );

  const list = Array.isArray(out.beats) ? out.beats : [];
  if (!list.length) throw new Error(`没写出分镜：${JSON.stringify(out).slice(0, 300)}`);
  return {
    title: String(out.title ?? '').trim() || '未命名',
    logline: String(out.logline ?? '').trim(),
    style: String(out.style ?? req.style ?? '').trim(),
    beats: list.map((b, i) => newBeat({ ...b, title: String(b.title ?? `镜头${i + 1}`).trim(), seconds: Number(b.seconds) || seconds })),
    source: 'ai',
  };
}

export interface RefineOptions {
  /** 哪几镜（beat id 或标题）；不给就全部 */
  beats?: string[];
  target?: 'image' | 'video' | 'both';
  /** 带项目里已有的画面当参考（跨镜连贯靠它），默认开 */
  refs?: boolean;
  /** 精修哪几镜的语境：其他镜头的剧情线 */
  count?: number;
}

export interface RefineProgress {
  index: number;
  total: number;
  title: string;
  target: 'image' | 'video';
}

/**
 * 逐镜精修：把画面级的初稿过一遍 H3 技能（出片）和生图规范（首帧），写回剧情。
 *
 * 为什么要逐镜而不是一次出全片：H3 技能正文近两万字，一次塞进去让它写 8 镜，
 * 上下文全被技能占满、镜头反而写糊。逐镜装一次技能，每镜都在完整语境里写，这才是渐进披露的用法。
 */
export async function refineStory(
  projectId: string,
  opts: RefineOptions = {},
  onProgress?: (p: RefineProgress) => void,
): Promise<{ refined: number; failed: Array<{ title: string; why: string }>; changed: string[]; story: Story }> {
  const p = loadProject(projectId);
  const story = p.story;
  if (!story?.beats.length) throw new Error('这个工作台还没有剧情');

  const targets: Array<'image' | 'video'> =
    opts.target === 'image' ? ['image'] : opts.target === 'video' ? ['video'] : ['image', 'video'];
  const want = opts.beats?.length
    ? story.beats.filter((b) => opts.beats!.some((r) => r === b.id || r === b.title || b.title.includes(r)))
    : story.beats;

  const failed: Array<{ title: string; why: string }> = [];
  const changed: string[] = [];
  /** 精修出来的词要同步进哪个节点预设（nodeId → 词） */
  const draftPatch = new Map<string, string>();
  let refined = 0;
  let step = 0;

  for (const beat of want) {
    const { image, video } = nodesOfBeat(p, beat);
    // 剧情线：别的镜头在讲什么，跨镜一致靠它（自己那一条不重复喂）
    const storyLine = story.beats
      .filter((b) => b.id !== beat.id)
      .map((b, i) => `${i + 1}. ${b.title}：${b.action}`)
      .join('\n');

    for (const target of targets) {
      step++;
      onProgress?.({ index: step, total: want.length * targets.length, title: beat.title, target });
      // 既有词是精修对象（设定冻结），中文 action 才是语境。
      // 以前把既有词当「想法」喂进去，模型就按新创作重写了一遍——那是改版，不是优化。
      const existing = (target === 'video' ? beat.video : beat.image)?.trim();
      const idea = beat.action || beat.title;
      try {
        const node = target === 'video' ? video : image;
        const bundle = opts.refs === false || !node ? undefined : await collectRefs({ projectId, nodeId: node.id, target, auto: true });
        const out = await optimizePrompt({
          idea,
          current: existing || undefined,
          target,
          count: 1,
          style: story.style || undefined,
          context: `短片《${story.title || p.name}》：${story.logline}\n这一镜「${beat.title}」：${beat.action}`,
          story: storyLine || undefined,
          nodeTitle: beat.title,
          refs: bundle?.images,
          seconds: target === 'video' ? beat.seconds : undefined,
          ratio: target === 'video' ? (beat.aspect ?? frameRatio(p.settings.frameSize)) : undefined,
        });
        const text = out.candidates[0]?.text?.trim();
        if (!text) throw new Error('没给出候选');
        if (target === 'video') beat.video = text;
        else beat.image = text;
        if (node) draftPatch.set(node.id, text);
        refined++;
        for (const c of out.candidates[0]?.changes ?? []) changed.push(`${beat.title}·${target === 'video' ? '出片' : '首帧'}：${c}`);
      } catch (err) {
        failed.push({ title: `${beat.title}·${target === 'video' ? '出片' : '首帧'}`, why: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const saved = writeStory(projectId, { ...story, beats: story.beats, source: story.source });
  // 精修完的词必须同步进节点预设：runNode 取词的顺序是 draft.prompt 压过剧情里的词，
  // 只写 story 不写 draft，点完精修再跑出来的还是旧词（「精修了没变化」就是这么来的）。
  // 读-改-写，别整份覆盖——story 刚由 writeStory 落过盘了。
  if (draftPatch.size) {
    const p2 = loadProject(projectId);
    let hit = 0;
    for (const [nodeId, text] of draftPatch) {
      const n = p2.nodes.find((x) => x.id === nodeId);
      if (!n) continue;
      n.draft = { ...(n.draft ?? {}), prompt: text };
      hit++;
    }
    if (hit) saveProject(p2);
  }
  return { refined, failed, changed, story: saved };
}

// ── 一条龙：剧情 → 初版成片 ───────────────────────────────────────────────
// 顺序是硬的：出全部首帧（8888）→ 杀掉 8888 让出显存 → 出全部片（8188）→ 合成。
// 串行不是保守，是必须：两块实例抢同一块显存，并行就是一起 OOM。

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunStoryOptions {
  /** 只跑这几镜（beat id 或标题） */
  beats?: string[];
  /** 跑之前按剧情填模板，默认开 */
  apply?: boolean;
  /** 精修提示词（装 H3 技能），默认开。首帧词在生图前批量精修；出片词留到每镜出片前——那时上一镜的尾帧才真的在 */
  refine?: boolean;
  /** 每镜抽几版，默认 1 */
  count?: number;
  /** 出完片合成成片，默认开 */
  film?: boolean;
  /** 单镜等多久，默认 15 分钟 */
  timeoutMs?: number;
  /** 出片前把上一镜的尾帧接成本镜首帧，默认开。关了就是硬切，各镜各拍 */
  handoff?: boolean;
  /** 每步失败重试几次，默认 2（最多试 3 次） */
  retries?: number;
}

export interface RunStoryEvent {
  phase: 'apply' | 'refine' | 'image' | 'release' | 'handoff' | 'retry' | 'video' | 'export' | 'done' | 'failed';
  detail: string;
  index?: number;
  total?: number;
  nodeId?: string;
  takeId?: string;
}

export type StoryEmit = (ev: RunStoryEvent) => void;

export interface RunStoryResult {
  images: number;
  videos: number;
  film?: { nodeId: string; takeId: string };
  failed: Array<{ title: string; stage: string; why: string }>;
  seconds: number;
}

/** 跑着的项目（用来支持中断：长任务必须能停）。 */
const running = new Set<string>();

export function storyRunning(projectId: string): boolean {
  return running.has(projectId);
}

export function cancelStory(projectId: string): boolean {
  if (!running.has(projectId)) return false;
  running.delete(projectId);
  return true;
}

function imagePortOf(p: Project): number {
  const m = /:(\d+)\s*$/.exec(p.settings.imageHost ?? '');
  return m ? Number(m[1]) : 8888;
}

async function waitTake(projectId: string, nodeId: string, takeId: string, timeoutMs: number, signal: () => boolean): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (signal()) throw new Error('被叫停了');
    const p = loadProject(projectId);
    const take = p.nodes.find((n) => n.id === nodeId)?.takes.find((t) => t.id === takeId);
    if (!take) throw new Error('这一版不见了（节点被删？）');
    if (take.status === 'done') return;
    if (take.status === 'failed') throw new Error(take.error || '生成失败');
    if (Date.now() - t0 > timeoutMs) throw new Error(`等超时（${Math.round((Date.now() - t0) / 1000)}s）`);
    await sleep(2000);
  }
}

/**
 * 失败就重来：出片本来就是抽卡，偶发 OOM / 超时不该让整镜作废。
 *
 * 叫停（aborted）不重试——把叫停吞进重试里，用户按了停却还在跑，比失败更难收拾。
 */
export async function withRetry<T>(
  what: string,
  retries: number,
  fn: () => Promise<T>,
  opts: { aborted?: () => boolean; onRetry?: (info: { attempt: number; why: string }) => void } = {},
): Promise<T> {
  const aborted = opts.aborted ?? (() => false);
  for (let i = 0; ; i++) {
    if (aborted()) throw new Error('被叫停了');
    try {
      return await fn();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (aborted()) throw err;
      if (i >= retries) throw new Error(retries ? `${why}（重试 ${retries} 次都没过）` : why);
      opts.onRetry?.({ attempt: i + 1, why });
    }
  }
}

export async function runStory(projectId: string, opts: RunStoryOptions = {}, emit: StoryEmit = () => {}): Promise<RunStoryResult> {
  if (running.has(projectId)) throw new Error('这个工作台已经有一条龙在跑了');
  running.add(projectId);
  const signal = () => !running.has(projectId);
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const retries = Math.max(0, Math.min(Math.floor(opts.retries ?? 2), 5));
  const refine = opts.refine !== false;
  const handoff = opts.handoff !== false;
  const failed: RunStoryResult['failed'] = [];
  const result: RunStoryResult = { images: 0, videos: 0, failed, seconds: 0 };

  const attempt = <T>(what: string, fn: () => Promise<T>): Promise<T> =>
    withRetry(what, retries, fn, {
      aborted: signal,
      onRetry: ({ attempt: n, why }) => emit({ phase: 'retry', detail: `重试 ${n}/${retries}：${what}（上次：${why}）` }),
    });

  /** 出一版并等它跑完。跑挂就抛，重不重来交给 attempt。 */
  const runAndWait = async (nodeId: string, mode: 'image' | 'video'): Promise<void> => {
    const take = runNode({ projectId, nodeId, mode }, () => {});
    await waitTake(projectId, nodeId, take.id, timeoutMs, signal);
  };

  try {
    if (opts.apply !== false) {
      emit({ phase: 'apply', detail: '按剧情填模板' });
      const applied = applyStory(projectId, { beats: opts.beats });
      emit({ phase: 'apply', detail: `建了 ${applied.created.length} 镜 · 复用 ${applied.updated.length} 镜 · 连线 ${applied.edges} 条` });
    }

    const p0 = loadProject(projectId);
    const beats = opts.beats?.length
      ? (p0.story?.beats ?? []).filter((b) => opts.beats!.some((r) => r === b.id || r === b.title || b.title.includes(r)))
      : (p0.story?.beats ?? []);
    if (!beats.length) throw new Error('剧情里没有可跑的镜头');

    // ① 首帧词先精修：词就位再生图，否则跑的还是 draft 里那份糙词
    if (refine) {
      emit({ phase: 'refine', detail: '精修首帧词' });
      const r = await refineStory(projectId, { beats: opts.beats, target: 'image' }, (prog) =>
        emit({ phase: 'refine', detail: `首帧词 ${prog.index}/${prog.total}：${prog.title}`, index: prog.index, total: prog.total }),
      );
      for (const f of r.failed) failed.push({ title: f.title, stage: '精修', why: f.why });
    }

    // ② 首帧：一镜一镜来，串行吃同一块显存。先确认实例在——没起就早说，别让 6 镜挨个失败一遍
    const imgHost = loadProject(projectId).settings.imageHost;
    const imgAlive = await comfyStatus(imgHost);
    if (!imgAlive.alive) throw new Error(`生图实例 ${imgHost} 不在线，先把 8888 起起来再跑一条龙`);

    for (const [i, beat] of beats.entries()) {
      if (signal()) throw new Error('被叫停了');
      const { image } = nodesOfBeat(loadProject(projectId), beat);
      if (!image) {
        failed.push({ title: beat.title, stage: '首帧', why: '没有对应节点（先填模板）' });
        continue;
      }
      emit({ phase: 'image', detail: `首帧 ${i + 1}/${beats.length}：${beat.title}`, index: i + 1, total: beats.length, nodeId: image.id });
      try {
        await attempt(`${beat.title} 首帧`, () => runAndWait(image.id, 'image'));
        result.images++;
      } catch (err) {
        failed.push({ title: beat.title, stage: '首帧', why: err instanceof Error ? err.message : String(err) });
      }
    }

    // ③ 让出显存：出片实例 8188 绝不碰
    const p1 = loadProject(projectId);
    const vidAlive = await comfyStatus(p1.settings.comfyHost);
    if (!vidAlive.alive) throw new Error(`出片实例 ${p1.settings.comfyHost} 不在线`);
    if (p1.settings.releaseImageBeforeVideo) {
      const port = imagePortOf(p1);
      emit({ phase: 'release', detail: `释放生图实例（${port}）让出显存` });
      try {
        const rep = releaseImagePort(port);
        emit({ phase: 'release', detail: rep.pid ? `已杀 ${port} 的 pid ${rep.pid}` : `${port} 上本来没有进程` });
      } catch (err) {
        emit({ phase: 'release', detail: `释放失败（继续出片）：${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // ④ 出片：一镜一镜走「精修本镜词 → 接上一镜尾帧 → 出片」。
    // 精修放在这里而不是开头：要接上一镜的结尾，得先有上一镜的尾帧；一次跑完再精修，模型只看得到文字。
    let prev: TakeNode | undefined;
    for (const [i, beat] of beats.entries()) {
      if (signal()) throw new Error('被叫停了');
      const { image, video } = nodesOfBeat(loadProject(projectId), beat);
      if (!video) {
        failed.push({ title: beat.title, stage: '出片', why: '没有对应节点（先填模板）' });
        continue;
      }
      const first = image?.takes.find((t) => t.status === 'done' && t.file);
      // 没有自己的首帧、也没有上一镜尾帧可接，这镜出不来——早说，别让 runNode 拿一句模板报错回来
      if (!first && !(handoff && prev)) {
        failed.push({ title: beat.title, stage: '出片', why: '没有可用首帧（本镜首帧没出成，上一镜也没成，接不上）' });
        continue;
      }

      if (refine) {
        emit({ phase: 'refine', detail: `出片词 ${i + 1}/${beats.length}：${beat.title}`, index: i + 1, total: beats.length, nodeId: video.id });
        try {
          const r = await refineStory(projectId, { beats: [beat.id], target: 'video' }, () => {});
          for (const f of r.failed) failed.push({ title: f.title, stage: '精修', why: f.why });
        } catch (err) {
          failed.push({ title: `${beat.title}·出片词`, stage: '精修', why: err instanceof Error ? err.message : String(err) });
        }
      }

      if (handoff && prev) {
        emit({ phase: 'handoff', detail: `接戏 ${i + 1}/${beats.length}：「${prev.title}」尾帧 → 「${beat.title}」首帧`, index: i + 1, total: beats.length, nodeId: video.id });
        try {
          await attempt(`${beat.title} 接戏`, async () => {
            const out = handoffShot(projectId, { from: prev!.id, to: video.id }, () => {});
            await waitTake(projectId, out.frameNode.id, out.frameTake.id, timeoutMs, signal);
          });
        } catch (err) {
          // 接不上就退回本镜自己的首帧（硬切），别让整镜因为接戏失败作废
          failed.push({ title: beat.title, stage: '接戏', why: err instanceof Error ? err.message : String(err) });
        }
      }

      emit({ phase: 'video', detail: `出片 ${i + 1}/${beats.length}：${beat.title}`, index: i + 1, total: beats.length, nodeId: video.id });
      try {
        await attempt(`${beat.title} 出片`, () => runAndWait(video.id, 'video'));
        result.videos++;
        prev = video;
      } catch (err) {
        failed.push({ title: beat.title, stage: '出片', why: err instanceof Error ? err.message : String(err) });
        prev = undefined; // 这镜没成，下一镜没尾帧可接
      }
    }

    // ⑤ 合成：走画布上真实的算子节点，预览里看到的就是导出的
    if (opts.film !== false && result.videos) {
      const miss = beats.length - result.videos;
      if (miss > 0) {
        emit({ phase: 'export', detail: `成片会缺 ${miss} 镜（${failed.map((f) => f.title).join('、')}）——预览台连着播能看出来` });
      }
      emit({ phase: 'export', detail: '合成成片' });
      try {
        const out = exportFilm(projectId, {}, () => {});
        await waitTake(projectId, out.node.id, out.take.id, timeoutMs, signal);
        result.film = { nodeId: out.node.id, takeId: out.take.id };
      } catch (err) {
        failed.push({ title: '成片', stage: '合成', why: err instanceof Error ? err.message : String(err) });
      }
    }

    result.seconds = Math.round((Date.now() - t0) / 1000);
    emit({
      phase: 'done',
      detail: `初版跑完：首帧 ${result.images} · 出片 ${result.videos}${result.film ? ' · 成片 1' : ''}${failed.length ? ` · 失败 ${failed.length}` : ''}（${result.seconds}s）`,
    });
    return result;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    result.seconds = Math.round((Date.now() - t0) / 1000);
    emit({ phase: 'failed', detail: why });
    throw err;
  } finally {
    running.delete(projectId);
  }
}
