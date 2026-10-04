import fs from 'node:fs';
import path from 'node:path';
import { chatJson, dataUrl, llmConfig, userWithImages } from './llm.ts';
import { thumb } from './media.ts';
import { collectRefs } from './refs.ts';
import { LOGS_DIR, loadProject, mediaAbs, saveProject } from './store.ts';
import type { Project, Take, TakeNode } from '../shared/types.ts';

/**
 * 抽卡评审：让模型真的看图，给每一版打分排序，挑出该留的那张。
 *
 * 关键在「真的看图」——把 take 的产物压成缩略图，以 data URL 送进多模态请求。
 * 只看参数和种子猜好坏是不行的：同一个提示词抽 4 张，崩不崩手、主体糊没糊，
 * 参数里一个字都没有。
 *
 * 一次请求最多塞 BATCH 张：图多了注意力会摊薄，分数也不稳。超出的分批，
 * 提示词里统一打分口径，跨批的分数才勉强可比。
 */

const BATCH = 4;

const SYS = '你是短视频的选片导演，眼睛毒，说话直。你只输出 JSON，不写解释。';

const DEFAULT_CRITERIA = `评分维度（综合成一个 0-100 分）：
- 提示词还原度：画面有没有真的拍出提示词里说的东西
- 构图与主体：主体清不清楚、位置合不合理、有没有被裁掉
- 光影与氛围：光的方向、层次、气氛到不到位
- 细节崩坏：手指、五官、肢体、文字、边缘粘连等硬伤（有硬伤直接压到 60 以下）
- 作为视频首帧的可用性：构图有没有给后续运动留出空间`;

export interface ReviewRequest {
  projectId: string;
  /** 节点 id 或标题 */
  nodeId: string;
  /** 只评这几版（takeId 或 v 序号）；不给就评最近 max 版 */
  takeIds?: string[];
  criteria?: string;
  /** 默认 6，上限 12 */
  max?: number;
  /** 评完把最高分那版设为当前引脚 */
  pinBest?: boolean;
  /** 对照画面：显式指定（node:标题@v2 / take:xxx / path:...），逗号分隔 */
  refs?: string[];
  /** 自动带上游和相邻镜头当对照，默认开。跨镜连贯靠它，不然每版都是孤立打分 */
  autoRefs?: boolean;
}

export interface TakeScore {
  takeId: string;
  v: number;
  score: number;
  verdict: string;
  issues?: string;
}

export interface ReviewResult {
  nodeId: string;
  nodeTitle: string;
  reviewed: number;
  batch: number;
  scores: TakeScore[];
  best?: string;
  reason: string;
  model: string;
  /** 评完之后引脚指向哪一版 */
  pinned?: string;
  /** 评审时用到的对照画面 */
  refs?: string[];
  /** 没参与评审的版本和原因 */
  skipped: string[];
}

const clip = (s: string | undefined, n: number): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function findNode(p: Project, ref: string): TakeNode {
  const want = String(ref ?? '').trim();
  const hit =
    p.nodes.find((n) => n.id === want) ??
    p.nodes.find((n) => n.title === want) ??
    p.nodes.find((n) => n.title.includes(want) || n.id.includes(want));
  if (!hit) throw new Error(`项目「${p.name}」里找不到节点「${want}」。现有：${p.nodes.map((n) => `${n.title}(${n.id})`).join('、') || '（空的）'}`);
  return hit;
}

/** takeId 或 v 序号，两种都要吃——人给的是「v3」，代码里存的是 take_xxxx。 */
function findTake(node: TakeNode, ref: string): Take {
  const want = String(ref ?? '').trim();
  const byIndex = /^v?(\d+)$/.exec(want);
  const hit = node.takes.find((t) => t.id === want) ?? (byIndex ? node.takes[Number(byIndex[1]) - 1] : undefined);
  if (!hit) throw new Error(`节点「${node.title}」没有「${want}」这一版。现有：${node.takes.map((t, i) => `v${i + 1}`).join('、') || '（还没有版本）'}`);
  return hit;
}

const vOf = (node: TakeNode, takeId: string): number => node.takes.findIndex((t) => t.id === takeId) + 1;

/** 缩略图按 takeId 落盘缓存：take 不可变，图生成一次就够。 */
function thumbOf(p: Project, take: Take): string {
  const out = path.join(LOGS_DIR, 'review', `${take.id}.jpg`);
  if (fs.existsSync(out)) return out;
  const isVideo = take.kind === 'video';
  const rel = isVideo ? take.poster ?? take.file : take.file;
  if (!rel) throw new Error(`take ${take.id} 没有产物文件`);
  return thumb(p.settings.ffmpeg, mediaAbs(p.id, rel), out, 640, isVideo);
}

interface BatchAnswer {
  scores?: { id?: string; score?: number; verdict?: string; issues?: string }[];
  best?: string;
  reason?: string;
}

/** 模型返回的 id 可能是 "1"、"v2"、也可能抄了 takeId——都往批内序号上对。 */
function pickIndex(raw: string | undefined, batch: Take[]): number {
  const want = String(raw ?? '').trim();
  const direct = batch.findIndex((t) => t.id === want);
  if (direct >= 0) return direct;
  const num = /^v?(\d+)$/.exec(want);
  if (num) {
    const i = Number(num[1]) - 1;
    if (i >= 0 && i < batch.length) return i;
  }
  return -1;
}

export async function reviewTakes(req: ReviewRequest): Promise<ReviewResult> {
  const p = loadProject(req.projectId);
  const node = findNode(p, req.nodeId);
  const usable = (t: Take) => t.status === 'done' && !!t.file && (t.kind === 'image' || t.kind === 'video');
  const skipped = node.takes
    .filter((t) => !usable(t))
    .map((t) => `v${vOf(node, t.id)} ${t.status}${t.error ? `（${clip(t.error, 60)}）` : ''}`);

  const max = Math.min(Math.max(req.max ?? 6, 1), 12);
  const pool = node.takes.filter(usable);
  const picks = req.takeIds?.length
    ? req.takeIds.map((r) => findTake(node, r)).filter(usable)
    : pool.slice(-max);
  if (picks.length < 2) {
    throw new Error(
      `「${node.title}」只有 ${picks.length} 版可用产物，没法评审。先 sweep 出几版再评${skipped.length ? `；不可用的：${skipped.join('、')}` : ''}`,
    );
  }

  const cfg = llmConfig();
  const criteria = req.criteria?.trim() || DEFAULT_CRITERIA;

  // 对照画面：上游（出片节点就是首帧）和相邻镜头。自己的当前版本不拿来做对照——
  // 它就在候选里，再当参照物会让模型拿一版候选去给另一版打分。
  let cross: { label: string; dataUrl: string }[] = [];
  let refLabels: string[] | undefined;
  try {
    const bundle = await collectRefs({
      projectId: p.id,
      nodeId: node.id,
      refs: req.refs,
      auto: req.autoRefs !== false,
      max: 5,
    });
    cross = bundle.images.filter((i) => !i.role.startsWith('本节点')).slice(0, 2).map((i) => ({ label: i.label, dataUrl: i.dataUrl }));
    refLabels = bundle.images.length ? bundle.labels : undefined;
    skipped.push(...bundle.skipped);
  } catch (e) {
    skipped.push(`对照画面没取到：${e instanceof Error ? e.message : String(e)}`);
  }

  const batches: Take[][] = [];
  for (let i = 0; i < picks.length; i += BATCH) batches.push(picks.slice(i, i + BATCH));

  const scores: TakeScore[] = [];
  let reason = '';
  for (const [bi, batch] of batches.entries()) {
    const shots = batch.map((t) => dataUrl(thumbOf(p, t)));
    const images = [...cross.map((c) => c.dataUrl), ...shots];
    const legend = [
      ...cross.map((c, i) => `第 ${i + 1} 张 = 对照画面（不评分、不编号）：${c.label}`),
      ...batch.map((t, i) => `第 ${cross.length + i + 1} 张 = 候选 v${vOf(node, t.id)}，编号 ${i + 1}`),
    ].join('\n');
    const asked = typeof batch[0]?.params?.prompt === 'string' ? clip(String(batch[0].params.prompt), 600) : '（这版没记提示词）';
    const crossNote = cross.length
      ? `
另外给了 ${cross.length} 张对照画面（已拍的相邻镜头），只用来判连贯度：候选里的人物长相/服装/场景/光线方向/色调跟对照接不接得上，接不上就扣分并写进 issues。对照画面本身不评分。`
      : '';
    const prompt = `下面按顺序给你 ${batch.length} 张候选画面${batches.length > 1 ? `（第 ${bi + 1}/${batches.length} 批，各批按同一口径打分）` : ''}。
它们是同一个提示词、同一台模型抽卡出来的不同版本（种子不同），要挑一张当视频首帧。

${legend}

提示词：${asked}
${crossNote}

${criteria}

要求：
- 只给「候选」打分，编号 1 就是 legend 里写着「编号 1」的那张；对照画面不给分
- 每张都给 0-100 分，分数要拉开差距，不要都给 80 分
- verdict 用中文一句话说清好在哪/差在哪，具体到画面里看得到的东西
- issues 只写硬伤，没有就留空字符串
- 明确指认哪张最好，并说清为什么它比第二名强

只输出 JSON，不要解释文字：
{"scores":[{"id":"1","score":86,"verdict":"...","issues":""}],"best":"1","reason":"中文一句话"}`;

    const out = await chatJson<BatchAnswer>([{ role: 'system', content: SYS }, userWithImages(prompt, images)], { temperature: 0.2 });
    for (const [i, take] of batch.entries()) {
      const got = (out.scores ?? []).find((s) => pickIndex(s?.id, batch) === i);
      scores.push({
        takeId: take.id,
        v: vOf(node, take.id),
        score: Math.max(0, Math.min(100, Math.round(Number(got?.score ?? 0)))),
        verdict: String(got?.verdict ?? '').trim() || '（模型没给评语）',
        issues: String(got?.issues ?? '').trim() || undefined,
      });
    }
    if (out.reason && !reason) reason = String(out.reason).trim();
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const at = Date.now();
  for (const s of scores) {
    const take = node.takes.find((t) => t.id === s.takeId);
    if (!take) continue;
    take.params = { ...take.params, aiReview: { score: s.score, verdict: s.verdict, issues: s.issues, at, model: cfg.model, criteria } };
  }

  let pinned: string | undefined;
  if (req.pinBest && best) {
    node.activeTake = best.takeId;
    pinned = `v${best.v}`;
  }
  saveProject(p);

  return {
    nodeId: node.id,
    nodeTitle: node.title,
    reviewed: scores.length,
    batch: batches.length,
    scores,
    best: best?.takeId,
    reason: reason || '（模型没给总结）',
    model: cfg.model,
    pinned,
    refs: refLabels,
    skipped,
  };
}

/** 给人看的一段话。agent 工具和 HTTP 路由共用，别各写一份。 */
export function reviewText(r: ReviewResult): string {
  const lines = [`「${r.nodeTitle}」评审 ${r.reviewed} 版（${r.batch} 批 · ${r.model}）：`];
  if (r.refs?.length) lines.push(`  对照画面：${r.refs.join('；')}`);
  for (const s of r.scores) {
    lines.push(`  v${s.v} 分 ${s.score}${s.issues ? ` · 硬伤：${s.issues}` : ''} · ${s.verdict}`);
  }
  const top = r.scores[0];
  lines.push(`最优：v${top.v}（${top.score} 分）${r.reason}`);
  if (r.pinned) lines.push(`已把当前引脚切到 v${top.v}`);
  if (r.skipped.length) lines.push(`没参与评审：${r.skipped.join('、')}`);
  return lines.join('\n');
}
