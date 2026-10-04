import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataUrl } from './llm.ts';
import { grab, probe } from './media.ts';
import { LOGS_DIR, loadProject, mediaAbs } from './store.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import type { Project, Take, TakeNode } from '../shared/types.ts';

/**
 * 参考画面收集：写词和评审都得「看着已有画面」说话，不然新词跟上一镜对不上。
 *
 * 三个来源：
 *  - 上游链路（沿边反向 BFS）：上游当前引脚产物。出片节点的上游图片就是它的首帧
 *  - 剧情相邻（按 x 排的上一镜/下一镜）：跨镜连贯靠它，视频取尾帧
 *  - 显式指定：node:标题@v3 / take:xxx / path:绝对路径 / file:media 相对路径
 *
 * 视频一律给「切片」不给整段：首尾各一帧才看得出动作往哪走、光往哪变。
 * 图一律压到长边 640 的 jpeg——模型看图不吃分辨率，吃的是 token 预算。
 */

const MAX_EDGE = 640;

export type Frame = 'still' | 'head' | 'tail';

export interface RefImage {
  /** 给人看的一行：角色 · 来源 · 哪一帧 */
  label: string;
  /** 角色标记，模型按这个理解图的地位（首帧 / 上一镜结尾 …） */
  role: string;
  file: string;
  dataUrl: string;
}

export interface RefBundle {
  images: RefImage[];
  /** 实际送进去的参考清单（前端和 agent 都拿它说话） */
  labels: string[];
  /** 剧情线：项目里各镜头按顺序的提示词，让新词接得上前后 */
  story: string;
  /** 这次是围着哪个节点收的（模型据此知道自己在写第几镜） */
  nodeTitle?: string;
  /** 想给但没给的（没有产物、找不到节点），不静默吞掉 */
  skipped: string[];
}

export interface RefRequest {
  projectId: string;
  /** 以哪个节点为视角收集（自动模式靠它找上游和相邻镜头） */
  nodeId?: string;
  /** 显式指定，逗号分隔 */
  refs?: string[];
  /** 自动带上游 + 相邻镜头，默认开 */
  auto?: boolean;
  /** 最多几张，默认 6、上限 10 —— 图多了注意力摊薄 */
  max?: number;
  target?: 'image' | 'video';
}

const clip = (s: string, n: number): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const usable = (t: Take | undefined): t is Take =>
  !!t && t.status === 'done' && !!t.file && (t.kind === 'image' || t.kind === 'video');

/** 当前引脚指向的版本；没引脚就用最后一版。 */
export function activeOf(node: TakeNode): Take | undefined {
  const hit = node.activeTake ? node.takes.find((t) => t.id === node.activeTake) : undefined;
  return hit ?? node.takes[node.takes.length - 1];
}

/**
 * 当前版本里「能看的」那一版。引脚指到跑挂/进行中的版本上时不能就当作没参考——
 * 往下退到最后一版有产物的，参考才收得满。
 */
export function usableActiveOf(node: TakeNode): Take | undefined {
  const act = activeOf(node);
  if (usable(act)) return act;
  return [...node.takes].reverse().find((t) => usable(t));
}

export function vOf(node: TakeNode, takeId: string): number {
  return node.takes.findIndex((t) => t.id === takeId) + 1;
}

/** 节点 id / 标题 / 标题片段都能认——人给的和模型给的往往不是 id。 */
export function findNode(p: Project, ref: string): TakeNode {
  const want = String(ref ?? '').trim();
  const hit =
    p.nodes.find((n) => n.id === want) ??
    p.nodes.find((n) => n.title === want) ??
    p.nodes.find((n) => n.title.includes(want) || n.id.includes(want));
  if (!hit) {
    throw new Error(`项目「${p.name}」里找不到节点「${want}」。现有：${p.nodes.map((n) => `${n.title}(${n.id})`).join('、') || '（空的）'}`);
  }
  return hit;
}

/** v 序号或 takeId 都吃。 */
export function findTake(node: TakeNode, ref: string): Take {
  const want = String(ref ?? '').trim();
  const byIndex = /^v?(\d+)$/.exec(want);
  const hit = node.takes.find((t) => t.id === want) ?? (byIndex ? node.takes[Number(byIndex[1]) - 1] : undefined);
  if (!hit) {
    throw new Error(`节点「${node.title}」没有「${want}」这一版。现有：${node.takes.map((_, i) => `v${i + 1}`).join('、') || '（还没有版本）'}`);
  }
  return hit;
}

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;

/**
 * 一帧缩略图落盘并按 take/文件缓存：take 不可变，抽一次就够。
 * 视频取 at，图片忽略 at（-ss 对静图没意义）。
 */
function frameFile(p: Project, src: string, key: string, at?: number, video = false): string {
  const suffix = video ? `-${at !== undefined ? String(at).replace('.', '_') : 'head'}` : '';
  const out = path.join(LOGS_DIR, 'refs', `${key}${suffix}.jpg`);
  if (fs.existsSync(out)) return out;
  return grab(p.settings.ffmpeg, src, out, video ? at ?? 0.3 : undefined, MAX_EDGE);
}

function takeFrame(p: Project, take: Take, frame: Frame): string {
  const src = mediaAbs(p.id, take.file!);
  if (take.kind === 'image') return frameFile(p, src, take.id);
  const dur = take.probe?.duration ?? probe(p.settings.ffprobe, src).duration ?? DEFAULT_SETTINGS.videoSeconds;
  const at = frame === 'tail' ? Math.max(dur - 0.3, 0.05) : 0.3;
  return frameFile(p, src, take.id, at, true);
}

/** 任意文件路径也能当参考（用户自己截的图、别的项目导出的片子）。 */
function rawFrame(p: Project, raw: string, frame: Frame): string {
  const abs = path.isAbsolute(raw) ? raw : mediaAbs(p.id, raw);
  if (!fs.existsSync(abs)) throw new Error(`参考文件不存在：${abs}`);
  const key = `user-${crypto.createHash('sha1').update(abs).digest('hex').slice(0, 10)}`;
  if (!VIDEO_EXT.test(abs)) return frameFile(p, abs, key);
  const dur = probe(p.settings.ffprobe, abs).duration ?? DEFAULT_SETTINGS.videoSeconds;
  const at = frame === 'tail' ? Math.max(dur - 0.3, 0.05) : 0.3;
  return frameFile(p, abs, key, at, true);
}

/** 上游节点，近的优先（出片节点的直接上游就是首帧，要排最前）。 */
function upstreamOf(p: Project, node: TakeNode): TakeNode[] {
  const out: TakeNode[] = [];
  const seen = new Set<string>([node.id]);
  let ring = [node.id];
  while (ring.length) {
    const next: string[] = [];
    for (const id of ring) {
      for (const e of p.edges.filter((e) => e.to === id)) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        const up = p.nodes.find((n) => n.id === e.from);
        if (up) {
          out.push(up);
          next.push(up.id);
        }
      }
    }
    ring = next;
  }
  return out;
}

/** 剧情顺序：按画布上从左到右、从上到下。约定成俗，不额外加字段。 */
function storyOrder(p: Project): TakeNode[] {
  return [...p.nodes].sort((a, b) => a.x - b.x || a.y - b.y);
}

function storyOf(p: Project, self?: TakeNode): string {
  const lines: string[] = [];
  let i = 0;
  for (const n of storyOrder(p)) {
    const t = usableActiveOf(n);
    const mark = n.id === self?.id ? '  ← 正在改的就是它' : '';
    if (n.kind === 'text' || n.kind === 'note') {
      const txt = clip(activeOf(n)?.text ?? '', 200);
      if (!txt) continue;
      i++;
      lines.push(`${i}. 文本「${n.title}」：${txt}${mark}`);
      continue;
    }
    if (!t) continue;
    i++;
    const dim = t.probe?.width ? ` ${t.probe.width}x${t.probe.height}` : '';
    const secs = t.kind === 'video' && t.probe?.duration ? ` ${t.probe.duration}s` : '';
    const kind = t.kind === 'video' ? '出片' : '画面';
    lines.push(`${i}. ${kind}「${n.title}」v${vOf(n, t.id)}${dim}${secs}：${clip(String(t.params?.prompt ?? ''), 160) || '（无提示词）'}${mark}`);
  }
  return lines.join('\n');
}

/** 显式参考项的写法：node:标题@v2 / take:xxx / path:C:\a.png / file:media/x.png */
interface Spec {
  kind: 'node' | 'take' | 'path' | 'file';
  ref: string;
  v?: string;
}

function parseSpec(raw: string): Spec {
  const s = String(raw ?? '').trim();
  const m = /^(node|take|path|file):(.*)$/i.exec(s);
  const body = m ? m[2].trim() : s;
  const at = /@(v?\d+|take_[A-Za-z0-9_-]+)$/.exec(body);
  const ref = at ? body.slice(0, at.index).trim() : body;
  const kind = (m?.[1]?.toLowerCase() as Spec['kind']) ?? 'node';
  return { kind, ref, v: at?.[1] };
}

export async function collectRefs(req: RefRequest): Promise<RefBundle> {
  const p = loadProject(req.projectId);
  const max = Math.min(Math.max(req.max ?? 6, 1), 10);
  const self = req.nodeId ? findNode(p, req.nodeId) : undefined;
  const skipped: string[] = [];
  const images: RefImage[] = [];
  const seen = new Set<string>();

  /** 同一个 take 同一帧只给一次：上游和相邻镜头经常指到同一版。 */
  const push = (role: string, label: string, file: string, dedupeKey: string) => {
    if (seen.has(dedupeKey) || images.length >= max) return;
    seen.add(dedupeKey);
    images.push({ role, label, file, dataUrl: dataUrl(file) });
  };

  const fromTake = (role: string, node: TakeNode, take: Take, frame: Frame, tag = '') => {
    try {
      const file = takeFrame(p, take, frame);
      // 视频一定标出看的是哪一帧：模型不知道的话会把开头当成结尾，接戏就接反了
      const which = take.kind === 'video' ? (frame === 'tail' ? '结尾' : '开头') : tag;
      push(role, `${role}·「${node.title}」v${vOf(node, take.id)}${which ? ` ${which}` : ''}`, file, `${take.id}:${frame}`);
    } catch (e) {
      skipped.push(`${role}「${node.title}」v${vOf(node, take.id)}：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ① 显式指定优先——人点名要看的东西不能被自动收集挤掉
  for (const spec of req.refs ?? []) {
    const raw = String(spec ?? '').trim();
    if (!raw) continue;
    try {
      const s = parseSpec(raw);
      if (s.kind === 'path' || s.kind === 'file') {
        const file = rawFrame(p, s.ref, 'still');
        push('用户指定', `用户指定·${path.basename(s.ref)}`, file, `raw:${s.ref}`);
        continue;
      }
      if (s.kind === 'take') {
        const hit = p.nodes.flatMap((n) => n.takes.map((t) => ({ n, t }))).find((x) => x.t.id === s.ref);
        if (!usable(hit?.t)) throw new Error(`没有 take「${s.ref}」的可用产物`);
        fromTake('用户指定', hit!.n, hit!.t, hit!.t.kind === 'video' ? 'head' : 'still', '');
        continue;
      }
      const node = findNode(p, s.ref);
      const take = s.v ? findTake(node, s.v) : usableActiveOf(node);
      if (!usable(take)) throw new Error('这一版没有可用产物');
      fromTake('用户指定', node, take, take.kind === 'video' ? 'head' : 'still', '');
    } catch (e) {
      skipped.push(`参考「${raw}」：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (req.auto !== false && self) {
    // ② 上游链路：出片节点的上游图片就是首帧，必须让模型看到
    for (const up of upstreamOf(p, self)) {
      if (up.kind !== 'image' && up.kind !== 'video') continue;
      const t = usableActiveOf(up);
      if (!t) {
        skipped.push(`上游「${up.title}」没有可用产物`);
        continue;
      }
      const isFirst = self.kind === 'video' && up.kind === 'image' && images.length === 0;
      const role = isFirst ? '首帧' : '上游参考';
      fromTake(role, up, t, t.kind === 'video' ? 'tail' : 'still');
    }
    // ③ 本节点当前版本：改词之前先让模型知道现在长什么样
    const own = usableActiveOf(self);
    if (own) fromTake('本节点当前版本', self, own, own.kind === 'video' ? 'head' : 'still');

    // ④ 剧情相邻：上一镜结尾 / 下一镜开头，跨镜连贯全靠这两张
    const order = storyOrder(p);
    const at = order.findIndex((n) => n.id === self.id);
    const prev = order.slice(0, at).reverse().find((n) => usableActiveOf(n));
    const next = order.slice(at + 1).find((n) => usableActiveOf(n));
    if (prev) fromTake('上一镜结尾', prev, usableActiveOf(prev)!, usableActiveOf(prev)!.kind === 'video' ? 'tail' : 'still');
    if (next) fromTake('下一镜开头', next, usableActiveOf(next)!, 'head');
  }

  return { images, labels: images.map((i) => i.label), story: storyOf(p, self), nodeTitle: self?.title, skipped };
}

/** 一段给人看的话：用了哪些参考。 */
export function refsText(b: RefBundle): string {
  const lines = b.images.length ? [`参考画面 ${b.images.length} 张：${b.labels.join('；')}`] : ['参考画面：无（还没有可用产物）'];
  if (b.skipped.length) lines.push(`没给上的：${b.skipped.join('；')}`);
  return lines.join('\n');
}
