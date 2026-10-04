import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { projectDefaults } from './defaults.ts';
import type { Edge, Project, ProjectSummary, Take, TakeNode } from '../shared/types.ts';

export const ROOT = process.env.TAKEBOARD_ROOT ? path.resolve(process.env.TAKEBOARD_ROOT) : process.cwd();
export const PROJECTS_DIR = path.join(ROOT, 'projects');
export const LOGS_DIR = path.join(ROOT, 'logs');

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

export function projectDir(id: string): string {
  return path.join(PROJECTS_DIR, id);
}
export function mediaDir(id: string): string {
  return path.join(projectDir(id), 'media');
}
export function projectFile(id: string): string {
  return path.join(projectDir(id), 'project.json');
}

/** 解析 media 相对路径为绝对路径，越界直接抛——media 之外的文件一律不许碰。 */
export function mediaAbs(id: string, rel: string): string {
  const base = path.resolve(mediaDir(id));
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(`media 路径越界: ${rel}`);
  return abs;
}
export function relMedia(id: string, abs: string): string {
  return path.relative(mediaDir(id), abs).split(path.sep).join('/');
}

/** 在目录里取一个不重名的文件名。take 永不覆盖，所以命名必须唯一。 */
export function uniquePath(dir: string, filename: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 1;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${stem}-${n++}${ext}`);
  return candidate;
}

export function listProjects(): ProjectSummary[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const out: ProjectSummary[] = [];
  for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    try {
      const p = JSON.parse(fs.readFileSync(projectFile(entry.name), 'utf8')) as Project;
      out.push({
        id: p.id,
        name: p.name,
        updatedAt: p.updatedAt,
        nodeCount: p.nodes.length,
        takeCount: p.nodes.reduce((n, x) => n + x.takes.length, 0),
      });
    } catch {
      // 半截文件 / 不是项目目录，跳过
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadProject(id: string): Project {
  const file = projectFile(id);
  if (!fs.existsSync(file)) throw new Error(`项目不存在: ${id}`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Project;
  p.settings = { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) };
  p.nodes ??= [];
  p.edges ??= [];
  return p;
}

/** 原子落盘：先写 .tmp 再 rename，旧版留 .bak。rev 自增是乐观锁的锚。 */
export function saveProject(p: Project): Project {
  p.rev = (p.rev ?? 0) + 1;
  p.updatedAt = Date.now();
  const file = projectFile(p.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(mediaDir(p.id), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2), 'utf8');
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
  return p;
}

export function createProject(name: string): Project {
  const id = `${name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-|-$/g, '') || 'board'}-${crypto
    .randomBytes(2)
    .toString('hex')}`;
  const now = Date.now();
  const p: Project = {
    id,
    name,
    rev: 0,
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
    view: { x: 0, y: 0, zoom: 1 },
    // 本机默认（data/defaults.json）优先于内置默认：画幅/时长/模板这些不用每建一个项目改一遍
    settings: projectDefaults(),
  };
  fs.mkdirSync(mediaDir(id), { recursive: true });
  return saveProject(p);
}

/** 删项目只搬进 _trash，不真删——画布上的东西都是不可再生资源。 */
export function trashProject(id: string): string {
  const from = projectDir(id);
  if (!fs.existsSync(from)) throw new Error(`项目不存在: ${id}`);
  const dest = path.join(PROJECTS_DIR, '_trash', `${id}-${Date.now()}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(from, dest);
  return dest;
}

export function nodeOf(p: Project, nodeId: string): TakeNode {
  const n = p.nodes.find((x) => x.id === nodeId);
  if (!n) throw new Error(`节点不存在: ${nodeId}`);
  return n;
}

export function takeOf(p: Project, nodeId: string, takeId: string): Take {
  const t = nodeOf(p, nodeId).takes.find((x) => x.id === takeId);
  if (!t) throw new Error(`take 不存在: ${nodeId}/${takeId}`);
  return t;
}

export function activeTakeOf(p: Project, nodeId: string): Take | undefined {
  const n = nodeOf(p, nodeId);
  return resolveTake(n, 'active');
}

/**
 * 引脚解析的唯一定义。'active' = 跟随该节点的当前引脚（activeTake），其余值 = 钉死的 takeId。
 * 服务端每一处「取上游版本」都必须走这里。
 * 曾经三处各写一份 takes[last]，后果是切了上游引脚下游纹丝不动——版本全纠缠在一起。
 */
export function resolveTake(node: TakeNode | undefined, pin: 'active' | string): Take | undefined {
  if (!node) return undefined;
  if (pin !== 'active') return node.takes.find((t) => t.id === pin);
  return node.takes.find((t) => t.id === node.activeTake) ?? node.takes[node.takes.length - 1];
}

/** 上游节点 → 本节点的那条边（一个入端口一条）。 */
export function inboundEdges(p: Project, nodeId: string): Edge[] {
  return p.edges.filter((e) => e.to === nodeId);
}
export function outboundEdges(p: Project, nodeId: string): Edge[] {
  return p.edges.filter((e) => e.from === nodeId);
}

/** 沿入边往上取每个上游节点的「实际生效 take」：pin=active 跟随，否则钉死。 */
export function upstreamTakes(p: Project, nodeId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of inboundEdges(p, nodeId)) {
    const pinned = resolveTake(nodeOf(p, e.from), e.pin);
    if (pinned) out[e.from] = pinned.id;
  }
  return out;
}

/** 拓扑序（上游在前）。画布允许自由摆放，但重演必须按依赖顺序。 */
export function topoOrder(p: Project, roots: string[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const e of inboundEdges(p, id)) visit(e.from);
    order.push(id);
  };
  for (const r of roots) visit(r);
  return order;
}

/**
 * 读-改-写。作业跑在后台、UI 同时在存盘，两边都不能互相踩——
 * 所以任何写都先重新载盘，只改自己那一小块，再原子落盘。
 */
export function appendTake(projectId: string, nodeId: string, take: Take, makeActive = true): Take {
  const p = loadProject(projectId);
  const node = nodeOf(p, nodeId);
  node.takes.push(take);
  if (makeActive) node.activeTake = take.id;
  saveProject(p);
  return take;
}

export function patchTake(projectId: string, nodeId: string, takeId: string, patch: Partial<Take>): Take {
  const p = loadProject(projectId);
  const take = takeOf(p, nodeId, takeId);
  Object.assign(take, patch);
  saveProject(p);
  return take;
}

export function updateNode(projectId: string, nodeId: string, patch: Partial<TakeNode>): TakeNode {
  const p = loadProject(projectId);
  const node = nodeOf(p, nodeId);
  Object.assign(node, patch, { id: node.id, takes: node.takes });
  saveProject(p);
  return node;
}
