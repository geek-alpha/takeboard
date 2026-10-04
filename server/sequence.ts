import { loadProject, newId, nodeOf, resolveTake, saveProject } from './store.ts';
import { runOp, type Emit } from './jobs.ts';
import type { Project, SequenceView, Shot, Take, TakeNode } from '../shared/types.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';

function playable(node: TakeNode): Take | undefined {
  const t = resolveTake(node, 'active');
  if (t && t.status === 'done' && t.file && t.kind === 'video') return t;
  return undefined;
}

function upstreamClosure(p: Project, endId: string): Set<string> {
  // 终点自己也算 —— 「到这条成片为止」意味着这条成片要在序列里，否则看不到配好音的那一版
  const keep = new Set<string>([endId]);
  const stack = [endId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of p.edges) {
      if (e.to !== id || keep.has(e.from)) continue;
      keep.add(e.from);
      stack.push(e.from);
    }
  }
  return keep;
}

/**
 * 预览序列：把画布上的出片节点按剧情顺序（x 轴）排成一条片子。
 *
 * 给了 endNode 就只收它上游那串（「这部片以谁为结尾」）；没给就是整张画布。
 * 前端拿它做实时预览，助手拿它回答「现在这条片子多长、有哪几镜」。
 */
export function sequenceOf(projectId: string, endNodeId?: string): SequenceView {
  const p = loadProject(projectId);
  let pool = p.nodes;
  let source = '画布上全部出片节点（按 x 排剧情顺序，不算子产物）';
  if (endNodeId) {
    const end = nodeOf(p, endNodeId);
    const keep = upstreamClosure(p, end.id);
    pool = p.nodes.filter((n) => keep.has(n.id));
    source = `终点「${end.title}」上游的镜头（按 x 排剧情顺序）`;
  }

  const shots: Shot[] = [];
  const skipped: SequenceView['skipped'] = [];
  for (const n of pool) {
    // 算子产物（成片/字幕版/配音版）不算镜头 —— 否则「出成片」之后序列里会多出上一次的成片，
    // 再导一次就自己套自己。想看某条成片，就把它选成终点（end），那时它在上游闭包里。
    if (n.kind === 'op' && !endNodeId) continue;
    const t = resolveTake(n, 'active');
    if (!t) continue;
    const ok = playable(n);
    if (!ok) {
      if (n.kind === 'video') {
        skipped.push({
          nodeId: n.id,
          title: n.title,
          why: t.status !== 'done' ? t.status : t.kind !== 'video' ? `产物是 ${t.kind}` : '没有文件',
        });
      }
      continue;
    }
    shots.push({
      nodeId: n.id,
      title: n.title,
      takeId: ok.id,
      index: n.takes.findIndex((x) => x.id === ok.id) + 1,
      file: ok.file!,
      poster: ok.poster,
      duration: ok.probe?.duration ?? 0,
      hasAudio: !!ok.probe?.hasAudio,
      x: n.x,
      y: n.y,
    });
  }
  shots.sort((a, b) => a.x - b.x || a.y - b.y);
  const totalSeconds = Math.round(shots.reduce((a, s) => a + s.duration, 0) * 100) / 100;
  return { source, shots, totalSeconds, skipped };
}

export interface ExportResult {
  take: Take;
  node: TakeNode;
  shots: number;
}

/**
 * 一键出成片：照预览序列建（或复用）一个算子节点，把镜头按顺序连上去跑拼接。
 *
 * 画布会真的多出节点和连线 —— 「预览里看到的就是导出的」，出问题能顺着画布查。
 */
export function exportFilm(projectId: string, opts: { end?: string; name?: string; params?: Record<string, unknown> }, emit: Emit): ExportResult {
  const p = loadProject(projectId);
  const seq = sequenceOf(projectId, opts.end);
  if (!seq.shots.length) throw new Error('序列里没有可出片的镜头（镜头节点要先有跑完的视频版本）');
  const title = opts.name?.trim() || '成片';
  let found = p.nodes.find((n) => n.kind === 'op' && n.title === title);
  if (!found) {
    const maxX = p.nodes.reduce((a, n) => Math.max(a, n.x), 0);
    found = {
      id: newId('node'),
      kind: 'op',
      title,
      x: maxX + 320,
      y: p.nodes.filter((n) => n.x === maxX).reduce((a, n) => Math.max(a, n.y), 0),
      takes: [],
    };
    p.nodes.push(found);
  }
  const opNode = found;
  for (const s of seq.shots) {
    if (p.edges.some((e) => e.from === s.nodeId && e.to === opNode.id)) continue;
    p.edges.push({ id: newId('e'), from: s.nodeId, to: opNode.id, pin: 'active', createdAt: Date.now() });
  }
  saveProject(p);
  // 镜间过渡是项目级设置：预览台改一次，之后每次出成片都按它来（'none' 就是硬切）
  const tr = p.settings.transition ?? DEFAULT_SETTINGS.transition!;
  const useFade = tr.type !== 'none' && seq.shots.length > 1;
  const params = useFade ? { transition: tr.type, duration: tr.duration, ...(opts.params ?? {}) } : (opts.params ?? {});
  const take = runOp(projectId, opNode.id, useFade ? 'xfade' : 'concat', params, emit);
  return { take, node: opNode, shots: seq.shots.length };
}

/** 画布上的出片节点按剧情顺序（x 轴）排 —— 接戏要接「下一个」，不管它跑没跑。 */
function shotOrder(p: Project): TakeNode[] {
  return p.nodes.filter((n) => n.kind === 'video').sort((a, b) => a.x - b.x || a.y - b.y);
}

export interface HandoffResult {
  from: { nodeId: string; title: string; takeId: string; index: number };
  to: { nodeId: string; title: string };
  frameNode: TakeNode;
  frameTake: Take;
}

/**
 * 接戏：把这一镜的结尾画面接成下一镜的第 0 帧。
 *
 * 三件事全落在画布上（看得见、能撤销）：
 *  1. 建/复用一个尾帧算子节点「尾帧·<本镜>」，连上本镜、跑一次 lastframe
 *  2. 尾帧节点连到下一镜，边标 role='firstframe' —— 出片只认它，别的图片入边让位
 *  3. 同一镜上只留一条显式首帧边：重复接戏是「改接」，不是叠一堆抢首帧
 */
export function handoffShot(
  projectId: string,
  opts: { from: string; to?: string; params?: Record<string, unknown> },
  emit: Emit,
): HandoffResult {
  const p = loadProject(projectId);
  const from = nodeOf(p, opts.from);
  if (from.kind !== 'video') throw new Error(`「${from.title}」不是出片节点，没有尾帧可接`);
  const cur = resolveTake(from, 'active');
  if (!cur || cur.status !== 'done' || !cur.file || cur.kind !== 'video') {
    throw new Error(`「${from.title}」还没有跑完的视频版本，接不了戏（先跑一版再接）`);
  }

  let to: TakeNode | undefined;
  if (opts.to) {
    to = nodeOf(p, opts.to);
  } else {
    const order = shotOrder(p);
    const at = order.findIndex((n) => n.id === from.id);
    to = order.slice(at + 1)[0];
    if (!to) throw new Error(`「${from.title}」已经是画布上最后一个出片节点（剧情顺序按 x 从左到右），没有下一镜可接`);
  }
  if (to.id === from.id) throw new Error('不能把一镜接给自己');
  if (to.kind !== 'video') throw new Error(`「${to.title}」不是出片节点，接不了首帧`);

  const title = `尾帧·${from.title}`;
  let frameNode = p.nodes.find((n) => n.kind === 'op' && n.title === title);
  if (!frameNode) {
    frameNode = {
      id: newId('node'),
      kind: 'op',
      title,
      x: (from.x + to.x) / 2,
      y: Math.max(from.y, to.y) + 200,
      takes: [],
    };
    p.nodes.push(frameNode);
  }
  // 复用旧节点时把入边掰回 active：否则尾帧钉在上一版的结尾上，本镜改了它也不动
  const feed = p.edges.find((e) => e.from === from.id && e.to === frameNode!.id);
  if (feed) feed.pin = 'active';
  else p.edges.push({ id: newId('e'), from: from.id, to: frameNode.id, pin: 'active', createdAt: Date.now() });

  p.edges = p.edges.filter((e) => !(e.to === to!.id && e.role === 'firstframe'));
  p.edges.push({ id: newId('e'), from: frameNode.id, to: to.id, pin: 'active', role: 'firstframe', createdAt: Date.now() });
  saveProject(p);

  // runOp 自己重新 loadProject，所以先落盘再跑
  const frameTake = runOp(projectId, frameNode.id, 'lastframe', opts.params ?? {}, emit);
  return {
    from: { nodeId: from.id, title: from.title, takeId: cur.id, index: from.takes.findIndex((t) => t.id === cur.id) + 1 },
    to: { nodeId: to.id, title: to.title },
    frameNode,
    frameTake,
  };
}
