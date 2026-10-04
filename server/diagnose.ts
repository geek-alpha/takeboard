import fs from 'node:fs';
import { chatJson, llmConfig } from './llm.ts';
import { status as comfyStatus } from './comfy.ts';
import { portReport, VIDEO_PORT } from './gpu.ts';
import { loadProject } from './store.ts';
import type { ComfyStatus, Project, Take, TakeNode } from '../shared/types.ts';

/**
 * 失败诊断：take 挂了不该只留一行红字。
 *
 * 先过本地规则表——「ECONNREFUSED」这种错误，规则比模型判得又快又准，还不花钱。
 * 规则不命中再交给模型读 error 原文判断。结论里必须带证据（命中的那条错误原文、
 * 探测到的实例状态），否则就是猜。
 */

export interface DiagnoseRequest {
  projectId: string;
  /** 不给就扫全项目失败的版本 */
  nodeId?: string;
  /** 只诊断这几版（takeId 或 v 序号） */
  takeIds?: string[];
  /** 规则不命中时是否交给模型，默认 true */
  useLlm?: boolean;
}

export interface Diagnosis {
  nodeId: string;
  nodeTitle: string;
  takeId: string;
  v: number;
  error: string;
  cause: string;
  fix: string;
  evidence: string[];
  from: 'rule' | 'llm' | 'none';
  confidence: 'high' | 'medium' | 'low';
}

export interface DiagnoseResult {
  items: Diagnosis[];
  env: string;
}

interface Rule {
  re: RegExp;
  cause: string;
  fix: string;
}

const RULES: Rule[] = [
  {
    re: /服务重启，作业中断|无法接回/,
    cause: '服务重启时这条作业还没落盘 prompt_id，接不回来',
    fix: '重跑这一版（run）；resumeJobs 只能接回已经记下 prompt_id 的作业',
  },
  {
    re: /out of memory|CUDA error|allocation on device/i,
    cause: '显存不够',
    fix: '出片前先 release_image 杀掉 8888（两个实例抢同一块显存）；或把档位换小一档、秒数缩短',
  },
  {
    re: /ECONNREFUSED|fetch failed|socket hang up|ECONNRESET/i,
    cause: '连不上 ComfyUI 实例',
    fix: '看 env_status：生图节点要 8888 在线、出片节点要 8188 在线；哪个不在就把哪个拉起来',
  },
  {
    re: /出片需要上游一张成品图当首帧/,
    cause: '出片节点没有首帧输入',
    fix: '把图片节点连到出片节点（link），或者先把上游图节点跑出版本',
  },
  {
    re: /首帧文件不在盘上|ENOENT.*media/,
    cause: '上游产物文件不在盘上',
    fix: '重跑上游那一版，或把引脚换到别的版本',
  },
  {
    re: /找不到模板|模板不存在|no template|Cannot find module/i,
    cause: '模板 id 或模板目录不对',
    fix: '用 templates 看可用 id；settings.workflowDir 要指向 Easel 的 workflows 目录',
  },
  {
    re: /ffmpeg|ffprobe/i,
    cause: 'ffmpeg / ffprobe 路径不对或调用失败',
    fix: '项目 settings 里 ffmpeg / ffprobe 写成绝对路径',
  },
  {
    re: /等待超时|timed out|timeout|TimeoutError/i,
    cause: '等待超过上限，作业可能还在跑',
    fix: '出片是分钟级的（8s 片子 4070 上要 4~9 分钟）：run 时给更大的 timeout_s，或先用 jobs_status 看还在不在跑',
  },
  {
    re: /aspect/i,
    cause: '比例档位名不在模板支持的列表里',
    fix: '用 templates 看 aspectOptions，档位名要一字不差（如 "2:3 (Portrait Photo)"）',
  },
  {
    re: /没给出合法 JSON/,
    cause: 'LLM 没按格式回',
    fix: '重试一次；持续失败就把 TAKEBOARD_LLM_MODEL 换成更稳的模型',
  },
  {
    re: /invalid prompt|prompt not found|Prompt outputs failed validation|执行失败/i,
    cause: '工作流被 ComfyUI 拒绝执行',
    fix: '多半是模板里缺模型文件或参数越界：去 8188 界面手动跑一次同一模板，看它报什么',
  },
];

const clip = (s: string | undefined, n: number): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const vOf = (node: TakeNode, takeId: string): number => node.takes.findIndex((t) => t.id === takeId) + 1;

function findNode(p: Project, ref: string): TakeNode {
  const want = String(ref ?? '').trim();
  const hit =
    p.nodes.find((n) => n.id === want) ??
    p.nodes.find((n) => n.title === want) ??
    p.nodes.find((n) => n.title.includes(want) || n.id.includes(want));
  if (!hit) throw new Error(`项目「${p.name}」里找不到节点「${want}」。现有：${p.nodes.map((n) => `${n.title}(${n.id})`).join('、') || '（空的）'}`);
  return hit;
}

function findTake(node: TakeNode, ref: string): Take {
  const want = String(ref ?? '').trim();
  const byIndex = /^v?(\d+)$/.exec(want);
  const hit = node.takes.find((t) => t.id === want) ?? (byIndex ? node.takes[Number(byIndex[1]) - 1] : undefined);
  if (!hit) throw new Error(`节点「${node.title}」没有「${want}」这一版`);
  return hit;
}

const fmt = (c: ComfyStatus): string => (c.alive ? `在线 显存 ${c.vramFree ? `${(c.vramFree / 1e9).toFixed(1)}G` : '—'} 队列 ${c.running ?? 0}/${c.pending ?? 0}` : `离线（${c.error ?? '无响应'}）`);

async function envReport(): Promise<{ text: string; video: ComfyStatus; image: ComfyStatus }> {
  const [video, image] = await Promise.all([comfyStatus('http://127.0.0.1:8188'), comfyStatus('http://127.0.0.1:8888')]);
  const vp = portReport(VIDEO_PORT);
  const ip = portReport(8888);
  const text = [
    `出片 8188：${fmt(video)}（pid ${vp.pid ?? '无'}）`,
    `生图 8888：${fmt(image)}（pid ${ip.pid ?? '无'}）`,
  ].join('\n');
  return { text, video, image };
}

interface LlmAnswer {
  cause?: string;
  fix?: string;
  evidence?: string[];
  confidence?: string;
}

/** 规则不命中时的兜底：把错误原文和环境一起给模型，让它判断。 */
async function askLlm(node: TakeNode, take: Take, env: string): Promise<LlmAnswer> {
  const prompt = `一个视频工作台的作业失败了，帮我判断原因和改法。

节点：${node.kind}「${node.title}」（${node.id}）
这一版的参数：${JSON.stringify(take.params ?? {})}
作业来源：${take.source}${take.op ? ` · 算子 ${take.op}` : ''}
错误原文：
${take.error ?? '（没有错误信息）'}

当前实例状态：
${env}

只输出 JSON：
{"cause":"中文一句话说清原因","fix":"中文一句话说清怎么改，要具体到操作","evidence":["你据以判断的错误片段"],"confidence":"high|medium|low"}`;
  const out = await chatJson<LlmAnswer>(
    [
      { role: 'system', content: '你是 ComfyUI 与 ffmpeg 的排障工程师，结论要能直接照着做，不猜。' },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.2 },
  );
  return out;
}

export async function diagnose(req: DiagnoseRequest): Promise<DiagnoseResult> {
  const p = loadProject(req.projectId);
  const { text: env, video, image } = await envReport();

  const targets: { node: TakeNode; take: Take }[] = [];
  if (req.nodeId) {
    const node = findNode(p, req.nodeId);
    const picks = req.takeIds?.length ? req.takeIds.map((r) => findTake(node, r)) : node.takes.filter((t) => t.status === 'failed');
    for (const t of picks) targets.push({ node, take: t });
  } else {
    for (const node of p.nodes) for (const take of node.takes) if (take.status === 'failed') targets.push({ node, take });
  }
  if (!targets.length) return { items: [], env };

  const items: Diagnosis[] = [];
  for (const { node, take } of targets) {
    const error = take.error ?? '';
    const hit = RULES.find((r) => r.re.test(error));
    if (hit) {
      // 连接类错误按实例状态说具体：笼统说「连不上」等于没说
      let cause = hit.cause;
      if (/ECONNREFUSED|fetch failed|socket hang up|ECONNRESET/i.test(error)) {
        if (node.kind === 'image' && !image.alive) cause = '生图实例 8888 没在跑';
        else if (node.kind === 'video' && !video.alive) cause = '出片实例 8188 没在跑';
      }
      items.push({
        nodeId: node.id,
        nodeTitle: node.title,
        takeId: take.id,
        v: vOf(node, take.id),
        error: clip(error, 300),
        cause,
        fix: hit.fix,
        evidence: [clip(error, 300), ...(cause !== hit.cause ? [cause === '生图实例 8888 没在跑' ? '探测到 8888 无监听' : '探测到 8188 无监听'] : [])],
        from: 'rule',
        confidence: 'high',
      });
      continue;
    }

    if (req.useLlm === false) {
      items.push({
        nodeId: node.id,
        nodeTitle: node.title,
        takeId: take.id,
        v: vOf(node, take.id),
        error: clip(error, 300),
        cause: '规则表没命中，也没让模型看',
        fix: '看错误原文；或让助手带 useLlm 再诊一次',
        evidence: [clip(error, 300)],
        from: 'none',
        confidence: 'low',
      });
      continue;
    }

    try {
      const out = await askLlm(node, take, env);
      items.push({
        nodeId: node.id,
        nodeTitle: node.title,
        takeId: take.id,
        v: vOf(node, take.id),
        error: clip(error, 300),
        cause: out.cause?.trim() || '模型也没给出明确原因',
        fix: out.fix?.trim() || '看错误原文自己判断',
        evidence: (out.evidence ?? []).map((e) => clip(String(e), 200)).slice(0, 4),
        from: 'llm',
        confidence: out.confidence === 'high' || out.confidence === 'low' ? out.confidence : 'medium',
      });
    } catch (err) {
      items.push({
        nodeId: node.id,
        nodeTitle: node.title,
        takeId: take.id,
        v: vOf(node, take.id),
        error: clip(error, 300),
        cause: '规则没命中，模型也调不通',
        fix: `${err instanceof Error ? err.message : String(err)}；先按错误原文人工看一眼`,
        evidence: [clip(error, 300)],
        from: 'none',
        confidence: 'low',
      });
    }
  }

  return { items, env };
}

/** 给人看的一段话。agent 工具与 HTTP 路由共用。 */
export function diagnoseText(r: DiagnoseResult): string {
  if (!r.items.length) return '没有失败的版本要诊断。';
  const lines = [`诊断 ${r.items.length} 条失败版本（规则表优先，未命中才问模型）：`];
  for (const d of r.items) {
    lines.push(`【${d.nodeTitle} v${d.v}】${d.from === 'rule' ? '规则命中' : d.from === 'llm' ? '模型判断' : '没定论'} · 把握 ${d.confidence}`);
    lines.push(`  原因：${d.cause}`);
    lines.push(`  改法：${d.fix}`);
    if (d.evidence.length) lines.push(`  证据：${d.evidence.join(' | ')}`);
  }
  lines.push(`实例状态：\n${r.env}`);
  return lines.join('\n');
}
