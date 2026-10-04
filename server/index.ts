import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { status as comfyStatus } from './comfy.ts';
import { agentStatus, resetSession, resolveApproval, runAgent, TOOLS, GUARDED } from './agent.ts';
import { optimizePrompt } from './prompts.ts';
import {
  applyStory,
  cancelStory,
  draftStory,
  editBeat,
  importScript,
  refineStory,
  runStory,
  storyRunning,
  storyStatus,
  writeStory,
} from './story.ts';
import { collectRefs, refsText } from './refs.ts';
import { reviewTakes } from './review.ts';
import { diagnose } from './diagnose.ts';
import { releaseImagePort, portReport, SELF_PORT, VIDEO_PORT } from './gpu.ts';
import { machineStatus, saveMachine, startInstance, stopInstance } from './machine.ts';
import { llmPublic, saveLlmFile, testLlm } from './llm.ts';
import { defaultsFilePath, loadDefaults, projectDefaults, saveDefaults } from './defaults.ts';
import { firstFrameOf, jobsSnapshot, replay, resumeJobs, runNode, runOp, runSweep } from './jobs.ts';
import { probe, makePoster } from './media.ts';
import { exportFilm, handoffShot, sequenceOf } from './sequence.ts';
import { opsHelp } from '../shared/ops.ts';
import {
  ROOT,
  createProject,
  inboundEdges,
  listProjects,
  loadProject,
  mediaAbs,
  mediaDir,
  newId,
  nodeOf,
  projectFile,
  relMedia,
  saveProject,
  trashProject,
  uniquePath,
  updateNode,
} from './store.ts';
import { frameRatio, listTemplates } from './workflows.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import type { Edge, JobProgress, NodeKind, Project, Take, TakeNode, TakeParams } from '../shared/types.ts';

const PORT = Number(process.env.TAKEBOARD_PORT ?? 4317);
const DIST = path.join(ROOT, 'dist', 'web');

const app = express();
app.use(express.json({ limit: '64mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(text);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', jobs: jobsSnapshot(), root: ROOT }));
});

const emit = (ev: JobProgress) => broadcast({ type: 'job', ...ev });

type Handler = (req: express.Request, res: express.Response) => Promise<unknown> | unknown;
const h = (fn: Handler): express.RequestHandler => (req, res, next) => {
  Promise.resolve(fn(req, res))
    .then((out) => {
      // 处理器可以直接 return 对象，也可以自己 res.json；两条路都得能出结果
      if (out !== undefined && !res.headersSent) res.json(out);
    })
    .catch(next);
};

/** Express 5 把 params 的值类型放宽成 string | string[]，路由里只用得到 string。 */
const q = (req: express.Request): Record<string, string> => req.params as unknown as Record<string, string>;

const KIND_DEFAULT_TITLE: Record<NodeKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '提示词',
  op: '算子',
  note: '批注',
};

// ── 项目 ─────────────────────────────────────────────────────────────
app.get('/api/health', h(async () => ({
  ok: true,
  root: ROOT,
  pid: process.pid,
  projects: listProjects().length,
  comfy: await comfyStatus('http://127.0.0.1:8188'),
  jobs: jobsSnapshot().length,
})));

app.get('/api/projects', h((_req, res) => res.json(listProjects())));

app.post('/api/projects', h((req, res) => {
  const name = String(req.body?.name ?? '').trim() || '未命名工作台';
  res.json(createProject(name));
}));

app.get('/api/projects/:id', h((req, res) => res.json(loadProject(q(req).id))));

/**
 * 画布整图存盘。合并策略（有意为之）：
 *  - 拓扑、位置、引脚以画布为准（那是人在摆的东西）
 *  - take 只增不减：磁盘上有、请求里没有的 take 一律保留
 *    ——否则后台作业刚出完的片子会被一次陈旧的存盘抹掉
 * 删 take 只能走显式 DELETE。
 */
app.put('/api/projects/:id', h((req, res) => {
  const incoming = req.body as Project;
  const disk = loadProject(q(req).id);
  const merged: Project = {
    ...disk,
    name: incoming.name ?? disk.name,
    view: incoming.view ?? disk.view,
    settings: { ...disk.settings, ...(incoming.settings ?? {}) },
    nodes: (incoming.nodes ?? []).map((n) => {
      const old = disk.nodes.find((x) => x.id === n.id);
      const extra = (old?.takes ?? []).filter((t) => !(n.takes ?? []).some((x) => x.id === t.id));
      return { ...n, takes: [...(n.takes ?? []), ...extra] };
    }),
    edges: incoming.edges ?? disk.edges,
  };
  const saved = saveProject(merged);
  broadcast({ type: 'project', projectId: saved.id, rev: saved.rev });
  res.json(saved);
}));

app.delete('/api/projects/:id', h((req, res) => res.json({ trashed: trashProject(q(req).id) })));

// ── 节点 ─────────────────────────────────────────────────────────────
app.post('/api/projects/:id/nodes', h((req, res) => {
  const p = loadProject(q(req).id);
  const kind = (req.body?.kind ?? 'image') as NodeKind;
  const node: TakeNode = {
    id: newId('n'),
    kind,
    title: String(req.body?.title ?? KIND_DEFAULT_TITLE[kind] ?? kind),
    x: Number(req.body?.x ?? 0),
    y: Number(req.body?.y ?? 0),
    takes: [],
    note: req.body?.note,
  };
  if (kind === 'text') {
    const text = String(req.body?.text ?? '');
    node.takes.push({
      id: newId('take'),
      nodeId: node.id,
      createdAt: Date.now(),
      status: 'done',
      source: 'text',
      kind: 'image',
      text,
      params: { prompt: text },
      inputs: {},
    });
    node.activeTake = node.takes[0].id;
  }
  p.nodes.push(node);
  saveProject(p);
  res.json(node);
}));

app.patch('/api/projects/:id/nodes/:nodeId', h((req, res) => {
  const { title, x, y, activeTake, collapsed, note, kind } = req.body ?? {};
  const patch: Partial<TakeNode> = {};
  if (title !== undefined) patch.title = String(title);
  if (x !== undefined) patch.x = Number(x);
  if (y !== undefined) patch.y = Number(y);
  if (activeTake !== undefined) patch.activeTake = String(activeTake);
  if (collapsed !== undefined) patch.collapsed = !!collapsed;
  if (note !== undefined) patch.note = String(note);
  if (kind !== undefined) patch.kind = kind as NodeKind;
  res.json(updateNode(q(req).id, q(req).nodeId, patch));
}));

app.delete('/api/projects/:id/nodes/:nodeId', h((req, res) => {
  const p = loadProject(q(req).id);
  p.nodes = p.nodes.filter((n) => n.id !== q(req).nodeId);
  p.edges = p.edges.filter((e) => e.from !== q(req).nodeId && e.to !== q(req).nodeId);
  saveProject(p);
  res.json({ ok: true });
}));

// ── 边 / 引脚 ────────────────────────────────────────────────────────
app.post('/api/projects/:id/edges', h((req, res) => {
  const p = loadProject(q(req).id);
  const from = String(req.body?.from ?? '');
  const to = String(req.body?.to ?? '');
  nodeOf(p, from);
  nodeOf(p, to);
  if (from === to) throw new Error('不能连到自己');
  const edge: Edge = {
    id: newId('e'),
    from,
    to,
    pin: req.body?.pin ?? 'active',
    toPort: req.body?.toPort,
    createdAt: Date.now(),
  };
  p.edges.push(edge);
  saveProject(p);
  res.json(edge);
}));

app.patch('/api/projects/:id/edges/:edgeId', h((req, res) => {
  const p = loadProject(q(req).id);
  const edge = p.edges.find((e) => e.id === q(req).edgeId);
  if (!edge) throw new Error('边不存在');
  if (req.body?.pin !== undefined) edge.pin = String(req.body.pin);
  saveProject(p);
  res.json(edge);
}));

app.delete('/api/projects/:id/edges/:edgeId', h((req, res) => {
  const p = loadProject(q(req).id);
  p.edges = p.edges.filter((e) => e.id !== q(req).edgeId);
  saveProject(p);
  res.json({ ok: true });
}));

// ── take ─────────────────────────────────────────────────────────────
/** 登记已有素材为 take：外部文件、画布上拖进来的图，都从这儿进栈。 */
app.post('/api/projects/:id/nodes/:nodeId/takes', h((req, res) => {
  const p = loadProject(q(req).id);
  const node = nodeOf(p, q(req).nodeId);
  const takeId = newId('take');
  const dir = path.join(mediaDir(p.id), node.id);
  fs.mkdirSync(dir, { recursive: true });

  if (req.body?.text !== undefined && !req.body?.path) {
    const text = String(req.body.text);
    const take: Take = {
      id: takeId,
      nodeId: node.id,
      createdAt: Date.now(),
      status: 'done',
      source: 'text',
      kind: 'image',
      text,
      params: { prompt: text },
      inputs: {},
      label: req.body?.label,
    };
    node.takes.push(take);
    node.activeTake = take.id;
    saveProject(p);
    return res.json(take);
  }

  const src = path.resolve(String(req.body?.path ?? ''));
  if (!fs.existsSync(src)) throw new Error(`文件不存在: ${src}`);
  const ext = path.extname(src);
  const abs = uniquePath(dir, `${takeId}${ext}`);
  fs.copyFileSync(src, abs);
  const kind: Take['kind'] = /\.(mp4|webm|mov|mkv)$/i.test(ext) ? 'video' : /\.(mp3|wav|m4a|aac|flac)$/i.test(ext) ? 'audio' : 'image';
  let poster: string | undefined;
  let probeInfo;
  try {
    probeInfo = probe(p.settings.ffprobe, abs);
    if (kind === 'video') {
      const posterAbs = path.join(dir, `${takeId}.jpg`);
      makePoster(p.settings.ffmpeg, abs, posterAbs, 0.2);
      poster = relMedia(p.id, posterAbs);
    }
  } catch {
    // 探测失败也照样进栈：素材先留住，规格回头再补
  }
  const take: Take = {
    id: takeId,
    nodeId: node.id,
    createdAt: Date.now(),
    finishedAt: Date.now(),
    status: 'done',
    source: 'import',
    kind,
    file: relMedia(p.id, abs),
    poster,
    probe: probeInfo,
    params: (req.body?.params ?? {}) as TakeParams,
    inputs: {},
    label: req.body?.label ?? path.basename(src),
  };
  node.takes.push(take);
  node.activeTake = take.id;
  if (node.kind === 'text' || node.kind === 'note' || node.kind === 'op') node.kind = kind;
  saveProject(p);
  res.json(take);
}));

/** 引脚切换：把某个 take 钉成当前版本。这是「推倒重来」的核心动作。 */
app.patch('/api/projects/:id/nodes/:nodeId/takes/:takeId', h((req, res) => {
  const p = loadProject(q(req).id);
  const node = nodeOf(p, q(req).nodeId);
  const take = node.takes.find((t) => t.id === q(req).takeId);
  if (!take) throw new Error('take 不存在');
  if (req.body?.label !== undefined) take.label = String(req.body.label);
  if (req.body?.active !== false) node.activeTake = take.id;
  saveProject(p);
  res.json({ node, take });
}));

app.delete('/api/projects/:id/nodes/:nodeId/takes/:takeId', h((req, res) => {
  const p = loadProject(q(req).id);
  const node = nodeOf(p, q(req).nodeId);
  const take = node.takes.find((t) => t.id === q(req).takeId);
  if (!take) throw new Error('take 不存在');
  node.takes = node.takes.filter((t) => t.id !== take.id);
  if (node.activeTake === take.id) node.activeTake = node.takes[node.takes.length - 1]?.id;
  for (const e of p.edges) if (e.pin === take.id) e.pin = 'active';
  saveProject(p);
  res.json({ ok: true, media: take.file ? mediaAbs(p.id, take.file) : undefined });
}));

// ── 执行 ─────────────────────────────────────────────────────────────
app.post('/api/projects/:id/run', h((req, res) => {
  const take = runNode(
    {
      projectId: q(req).id,
      nodeId: String(req.body?.nodeId ?? ''),
      mode: req.body?.mode,
      params: req.body?.params,
      overrides: req.body?.overrides,
      label: req.body?.label,
    },
    emit,
  );
  res.json(take);
}));

app.post('/api/projects/:id/sweep', h((req, res) => {
  const takes = runSweep(
    {
      projectId: q(req).id,
      nodeId: String(req.body?.nodeId ?? ''),
      mode: req.body?.mode,
      params: req.body?.params,
      overrides: req.body?.overrides,
      label: req.body?.label,
    },
    Number(req.body?.count ?? 4),
    emit,
  );
  res.json({ takes });
}));

app.post('/api/projects/:id/ops', h((req, res) => {
  const take = runOp(q(req).id, String(req.body?.nodeId ?? ''), String(req.body?.op ?? 'concat'), req.body?.params ?? {}, emit);
  res.json(take);
}));

/** 预览序列：把画布上的镜头按剧情顺序排成一条片子。实时预览面板和助手都读它。 */
app.get('/api/projects/:id/sequence', h((req, res) => {
  const end = req.query.end ? String(req.query.end) : undefined;
  res.json(sequenceOf(q(req).id, end));
}));

/**
 * 一键出成片：照预览序列建（或复用）一个算子节点，把镜头按顺序连上去跑拼接。
 * 实现只有一份（server/sequence.ts 的 exportFilm），助手走的是同一个函数。
 */
app.post('/api/projects/:id/export', h((req, res) => {
  res.json(
    exportFilm(
      q(req).id,
      {
        end: req.body?.end ? String(req.body.end) : undefined,
        name: req.body?.name ? String(req.body.name) : undefined,
        params: req.body?.params,
      },
      emit,
    ),
  );
}));

/**
 * 接戏：本镜尾帧接成下一镜首帧。不传 to 就接画布上 x 排在它后面的那一镜。
 * 实现只有一份（server/sequence.ts 的 handoffShot），助手走同一个函数。
 */
app.post('/api/projects/:id/handoff', h((req, res) => {
  res.json(
    handoffShot(
      q(req).id,
      {
        from: String(req.body?.from ?? ''),
        to: req.body?.to ? String(req.body.to) : undefined,
        params: req.body?.params,
      },
      emit,
    ),
  );
}));

/** 这一镜的首帧实际是谁给的：面板上要能看见「首帧 ← 尾帧·镜头A」，接戏没接上一眼看得出来。 */
app.get('/api/projects/:id/firstframe', h((req, res) => {
  res.json(firstFrameOf(q(req).id, String(req.query.nodeId ?? '')));
}));

app.post('/api/projects/:id/replay', h((req, res) => {
  res.json(replay(q(req).id, String(req.body?.nodeId ?? ''), emit));
}));

app.get('/api/jobs', h((_req, res) => res.json(jobsSnapshot())));

// ── 环境 ─────────────────────────────────────────────────────────────
app.get('/api/comfy/status', h(async (req, res) => {
  const p = req.query.project ? loadProject(String(req.query.project)) : null;
  const host = String(req.query.host ?? p?.settings.comfyHost ?? 'http://127.0.0.1:8188');
  const imageHost = String(req.query.imageHost ?? p?.settings.imageHost ?? 'http://127.0.0.1:8888');
  res.json({ video: await comfyStatus(host), image: await comfyStatus(imageHost) });
}));

app.get('/api/gpu', h((_req, res) => {
  res.json({ videoPort: portReport(VIDEO_PORT), imagePort: portReport(8888) });
}));

app.post('/api/gpu/release-image', h((req, res) => {
  res.json(releaseImagePort(Number(req.body?.port ?? 8888)));
}));

// ── 实例启停（生图 8888 / 出片 8188 都能一键拉取和关闭）────────────────
app.get('/api/machine', h(async (_req, res) => {
  res.json({ selfPort: SELF_PORT, instances: await machineStatus() });
}));

app.put('/api/machine', h((req, res) => {
  res.json(saveMachine({ instances: req.body?.instances ?? [] }));
}));

app.post('/api/machine/instances/:id/start', h(async (req, res) => {
  res.json(await startInstance(String(req.params.id)));
}));

app.post('/api/machine/instances/:id/stop', h((req, res) => {
  res.json(stopInstance(String(req.params.id), { force: !!req.body?.force }));
}));

// ── 配置：LLM 基础配置 + 本机默认项目设置 ─────────────────────────────
// 两块都是「换项目也不用重配」的机器级配置，所以落在 data/ 而不是项目里。
// key 只出脱敏串，完整值永不回前端。
app.get('/api/llm', h((_req, res) => res.json(llmPublic())));
app.put('/api/llm', h((req, res) => {
  saveLlmFile(req.body ?? {});
  res.json(llmPublic());
}));
app.post('/api/llm/test', h(async (_req, res) => res.json(await testLlm())));

app.get('/api/defaults', h((_req, res) => res.json({ defaults: loadDefaults(), effective: projectDefaults(), file: defaultsFilePath() })));
app.put('/api/defaults', h((req, res) => {
  const defaults = saveDefaults(req.body?.defaults ?? req.body ?? {});
  res.json({ defaults, effective: projectDefaults(), file: defaultsFilePath() });
}));


app.get('/api/templates', h((req, res) => {
  const p = req.query.project ? loadProject(String(req.query.project)) : null;
  const dir = String(req.query.dir ?? p?.settings.workflowDir ?? DEFAULT_SETTINGS.workflowDir);
  res.json({ dir, templates: listTemplates(dir) });
}));

// ── 剧情 ─────────────────────────────────────────────────────────────
/** 剧情 + 它跟画布的对应关系（哪几镜还没填、哪几镜已有成品）。 */
app.get('/api/projects/:id/story', h((req, res) => res.json(storyStatus(q(req).id))));

/** 整份存盘：导入、AI 创作、面板批量改都走它。 */
app.put('/api/projects/:id/story', h((req, res) => {
  const id = q(req).id;
  const story = writeStory(id, req.body ?? {});
  broadcast({ type: 'story', projectId: id, detail: '剧情已更新' });
  res.json(story);
}));

/** 改一镜（实时编辑走这条，不重排其他镜头）。 */
app.patch('/api/projects/:id/story/beats/:beatId', h((req, res) => {
  const id = q(req).id;
  const story = editBeat(id, q(req).beatId, req.body ?? {});
  broadcast({ type: 'story', projectId: id, detail: `改了「${String(req.body?.title ?? q(req).beatId)}」` });
  res.json(story);
}));

/** 导入剧本：纯文本/分镜表/JSON 都能吃，切不动就用 AI 创作那条路。 */
app.post('/api/projects/:id/story/import', h((req, res) => {
  const story = importScript(q(req).id, String(req.body?.text ?? ''), {
    replace: req.body?.replace,
    title: req.body?.title ? String(req.body.title) : undefined,
  });
  broadcast({ type: 'story', projectId: q(req).id, detail: `导入了 ${story.beats.length} 镜` });
  res.json(story);
}));

/** 让助手写剧情。save=false 只返回草稿不落盘（给人先看一眼）。 */
app.post('/api/projects/:id/story/draft', h(async (req, res) => {
  const id = q(req).id;
  const p = loadProject(id);
  const drafted = await draftStory({
    idea: String(req.body?.idea ?? ''),
    shots: req.body?.shots === undefined ? undefined : Number(req.body.shots),
    seconds: req.body?.seconds === undefined ? undefined : Number(req.body.seconds),
    style: req.body?.style ? String(req.body.style) : undefined,
    ratio: req.body?.ratio ? String(req.body.ratio) : undefined,
    context: [p.story?.logline ? `已有故事：${p.story.logline}` : '', String(req.body?.context ?? '')].filter(Boolean).join('\n') || undefined,
  });
  const story = req.body?.save === false ? { ...drafted, updatedAt: Date.now() } : writeStory(id, drafted);
  broadcast({ type: 'story', projectId: id, detail: `助手写了 ${drafted.beats.length} 镜` });
  res.json(story);
}));

/** 按剧情填模板：建节点、写 draft、连线、排位置。已填过的镜头只更新，不重建。 */
app.post('/api/projects/:id/story/apply', h((req, res) => {
  const id = q(req).id;
  const out = applyStory(id, { beats: req.body?.beats, aspect: req.body?.aspect ? String(req.body.aspect) : undefined });
  broadcast({ type: 'project', projectId: id });
  broadcast({ type: 'story', projectId: id, detail: `填了 ${out.created.length} 镜 · 复用 ${out.updated.length} 镜` });
  res.json(out);
}));

/** 逐镜精修：装上 H3 技能把出片词写成规范格式。后台跑，进度走 WS。 */
app.post('/api/projects/:id/story/refine', h((req, res) => {
  const id = q(req).id;
  const say = (ev: unknown) => broadcast({ type: 'story', projectId: id, ...(ev as Record<string, unknown>) });
  void refineStory(
    id,
    { beats: req.body?.beats, target: req.body?.target, refs: req.body?.refs },
    (p) => say({ phase: 'refine', detail: `精修 ${p.index}/${p.total}：${p.title}·${p.target === 'video' ? '出片' : '首帧'}`, index: p.index, total: p.total }),
  )
    .then((r) => {
      const why = r.failed.length ? ` · 失败 ${r.failed.length}（${r.failed[0].title}：${r.failed[0].why.slice(0, 90)}）` : '';
      say({ phase: 'done', detail: `精修完 ${r.refined} 条${r.changed.length ? ` · 改动 ${r.changed.length} 处` : ' · 设定未动'}${why}` });
      broadcast({ type: 'story', projectId: id });
    })
    .catch((err) => say({ phase: 'failed', detail: err instanceof Error ? err.message : String(err) }));
  res.json({ started: true });
}));

/** 一条龙：填模板 → （可选）精修 → 首帧 → 释放 8888 → 出片 → 合成。后台跑，进度走 WS。 */
app.post('/api/projects/:id/story/run', h((req, res) => {
  const id = q(req).id;
  if (storyRunning(id)) {
    res.json({ started: false, why: '这个工作台已经有一条龙在跑了' });
    return;
  }
  const say = (ev: unknown) => broadcast({ type: 'story', projectId: id, ...(ev as Record<string, unknown>) });
  void runStory(
    id,
    {
      beats: req.body?.beats,
      apply: req.body?.apply,
      // 没显式说不要就精修：一条龙默认要出「装过 H3 技能」的词，糙词跑出来的就是废片
      refine: req.body?.refine === undefined ? undefined : !!req.body.refine,
      handoff: req.body?.handoff === undefined ? undefined : !!req.body.handoff,
      retries: req.body?.retries === undefined ? undefined : Number(req.body.retries),
      count: req.body?.count === undefined ? undefined : Number(req.body.count),
      film: req.body?.film,
    },
    say,
  )
    .then((r) => broadcast({ type: 'project', projectId: id, summary: r }))
    .catch(() => broadcast({ type: 'project', projectId: id }));
  res.json({ started: true });
}));

/** 叫停一条龙（长任务必须能停）。 */
app.post('/api/projects/:id/story/cancel', h((req, res) => res.json({ cancelled: cancelStory(q(req).id) })));

// ── 内置助手 ─────────────────────────────────────────────────────────
app.get('/api/agent/status', h((_req, res) => res.json(agentStatus())));

/**
 * 一轮对话的全过程用 SSE 推出去：助手说的话、每次工具调用（含耗时与结果摘要）、
 * 审批请求、作业进度。前端据此把「它在干什么」当场画出来，而不是等一个黑盒返回。
 */
app.post('/api/agent/chat', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const send = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  // 出片是分钟级的，中间长时间没有事件，得给代理留个心跳
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  try {
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw new Error('说点什么');
    await runAgent(
      { sessionId: req.body?.sessionId, projectId: req.body?.projectId, text, maxRounds: req.body?.maxRounds },
      send,
    );
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearInterval(ping);
    res.write('event: end\ndata: {}\n\n');
    res.end();
  }
});

app.post('/api/agent/approve', h((req, res) => res.json({ ok: resolveApproval(String(req.body?.id ?? ''), !!req.body?.approve) })));
app.post('/api/agent/reset', h((req, res) => res.json({ ok: resetSession(String(req.body?.sessionId ?? '')) })));

/** 提示词优化：项目里有已出的画面时，把上游/相邻镜头当参考图一起送进去——写词看不见画面就接不上剧情。 */
app.post('/api/agent/optimize', h(async (req, res) => {
  const target = req.body?.target === 'video' ? 'video' : 'image';
  const specs = Array.isArray(req.body?.refs)
    ? req.body.refs.map(String)
    : String(req.body?.refs ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  const projectId = String(req.body?.projectId ?? '');
  const nodeId = req.body?.nodeId ? String(req.body.nodeId) : undefined;

  let bundle: Awaited<ReturnType<typeof collectRefs>> | undefined;
  let refsWarn = '';
  if (projectId) {
    try {
      bundle = await collectRefs({ projectId, nodeId, refs: specs, auto: req.body?.autoRefs !== false, target });
    } catch (e) {
      refsWarn = `参考画面没收上，这次按纯文字给：${e instanceof Error ? e.message : String(e)}`;
    }
  } else if (specs.length) {
    refsWarn = 'refs 要配 projectId 才能取到画面，这次只按文字给。';
  }

  // 没给时长/画幅就按项目默认：写词时的 TARGET 段得跟实际出片一致，
  // 否则词按 8 秒规划动作、片只出 5 秒，动作被砍在半路；画幅错了整条片子被重构图。
  let fallbackSeconds: number | undefined;
  let fallbackRatio: string | undefined;
  if (projectId) {
    try {
      const pset = loadProject(projectId).settings;
      fallbackSeconds = pset.videoSeconds;
      fallbackRatio = frameRatio(pset.frameSize);
    } catch {
      fallbackSeconds = undefined;
      fallbackRatio = undefined;
    }
  }

  const out = await optimizePrompt({
    idea: String(req.body?.idea ?? ''),
    target,
    count: Number(req.body?.count ?? 3),
    style: req.body?.style,
    refine: req.body?.refine,
    current: req.body?.current,
    mode: req.body?.mode === 'rewrite' ? 'rewrite' : req.body?.mode === 'refine' ? 'refine' : undefined,
    context: req.body?.context,
    refs: bundle?.images,
    story: bundle?.story,
    nodeTitle: bundle?.nodeTitle,
    seconds: Number(req.body?.seconds) > 0 ? Number(req.body?.seconds) : fallbackSeconds,
    ratio: req.body?.ratio ? String(req.body.ratio) : fallbackRatio,
  });
  res.json({
    ...out,
    refsUsed: bundle?.labels ?? [],
    storyUsed: !!bundle?.story,
    skipped: bundle?.skipped ?? [],
    warn: refsWarn || undefined,
    refsText: bundle ? refsText(bundle) : undefined,
  });
}));

/** 抽卡评审：图真的送进多模态请求，所以要等几秒到几十秒，前端拿 loading 顶着。 */
app.post('/api/agent/review', h(async (req, res) =>
  res.json(
    await reviewTakes({
      projectId: String(req.body?.projectId ?? ''),
      nodeId: String(req.body?.nodeId ?? ''),
      takeIds: Array.isArray(req.body?.takeIds) ? req.body.takeIds.map(String) : undefined,
      criteria: req.body?.criteria,
      max: req.body?.max,
      pinBest: !!req.body?.pinBest,
      refs: Array.isArray(req.body?.refs)
        ? req.body.refs.map(String)
        : String(req.body?.refs ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
      autoRefs: req.body?.autoRefs !== false,
    }),
  ),
));

app.post('/api/agent/diagnose', h(async (req, res) =>
  res.json(
    await diagnose({
      projectId: String(req.body?.projectId ?? ''),
      nodeId: req.body?.nodeId ? String(req.body.nodeId) : undefined,
      takeIds: Array.isArray(req.body?.takeIds) ? req.body.takeIds.map(String) : undefined,
      useLlm: req.body?.useLlm !== false,
    }),
  ),
));

/** 给我（agent）看的说明书：工作台能干什么、怎么调。 */
app.get('/api/agent/spec', h((req, res) => {
  res.json({
    what: 'Takeboard 视频工作台 —— 一切产物皆 take，排列组合，推倒重来',
    model: {
      node: '画布上的素材位（image/video/audio/text/op/note）',
      take: '节点下的一版产物，永不覆盖；新跑一次就多一版',
      activeTake: '节点的当前引脚',
      edge: '有向连接，自带 pin：active=跟随上游当前版本，<takeId>=钉死那一版',
      provenance: 'take.inputs 记录 nodeId→takeId，链路可重演',
    },
    endpoints: {
      'GET /api/health': '服务 + 出片实例状态',
      'GET /api/projects': '项目清单',
      'GET /api/projects/:id': '整张画布',
      'POST /api/projects/:id/nodes': '{kind,title,x,y,text?} 建节点',
      'POST /api/projects/:id/nodes/:nodeId/takes': '{path|text} 登记素材进 take 栈',
      'POST /api/projects/:id/run': '{nodeId,mode,params,overrides} 跑一次 → 新 take；params.workflow 可换模板',
      'POST /api/projects/:id/sweep': '{nodeId,count,params} 抽卡：同参数连跑 N 版，seed 逐个递进 → {takes}',
      'POST /api/projects/:id/ops': `{nodeId,op,params} 算子：${opsHelp()}`,
      'GET /api/projects/:id/sequence': '{end?} 预览序列：镜头按剧情顺序排成一条片子（时长/顺序/缺哪镜）',
      'POST /api/projects/:id/replay': '{nodeId} 沿链重演下游',
      'PATCH /api/projects/:id/nodes/:nodeId/takes/:takeId': '{active:true} 切引脚',
      'GET /api/gpu': '两个实例的端口占用',
      'POST /api/gpu/release-image': '杀 8888 让出显存（8188 绝不碰）',
      'GET /api/machine': '两个实例的配方 + 实时状态（端口/PID/显存）',
      'PUT /api/machine': '{instances} 存启停配方（命令/cwd/端口）',
      'POST /api/machine/instances/:id/start': '一键起实例（等端口监听，起不来返回日志尾巴）',
      'POST /api/machine/instances/:id/stop': '{force} 一键关实例（有作业在跑要 force）',
      'GET /api/llm': 'LLM 基础配置（key 只回脱敏串）+ 来源 env/file/dotenv',
      'PUT /api/llm': '{baseUrl,apiKey,model,temperature,maxTokens,timeoutMs,extraHeaders,clearApiKey} 存 data/llm.json；apiKey 留空=不改',
      'POST /api/llm/test': '用当前配置真发一轮最小请求，改完立刻知道通不通',
      'GET /api/defaults': '本机默认项目设置（新项目继承的那个）',
      'PUT /api/defaults': '{defaults} 存 data/defaults.json，以后新建的项目都用它',
      'GET /api/templates': 'ComfyUI 模板 + 发现到的旋钮',
      'GET /api/projects/:id/story': '剧情 + 它跟画布的对应（哪几镜没填/已有成品）',
      'PUT /api/projects/:id/story': '{title,logline,style,beats} 整份存盘',
      'PATCH /api/projects/:id/story/beats/:beatId': '{title,action,image,video,seconds,line} 改一镜',
      'POST /api/projects/:id/story/import': '{text,replace?} 导入剧本（分镜表/场景段落/JSON 自动切镜头）',
      'POST /api/projects/:id/story/draft': '{idea,shots?,seconds?,style?} 助手写一份剧情',
      'POST /api/projects/:id/story/apply': '{beats?} 按剧情填模板：每镜建「XX·首帧」+「XX」两节点、词进节点预设、连好线',
      'POST /api/projects/:id/story/refine': '{beats?,target?} 逐镜精修提示词（出片词走 H3 规范），后台跑、进度走 WS',
      'POST /api/projects/:id/story/run': '{beats?,refine?,film?} 一条龙：填模板→首帧→释放 8888→出片→合成，后台跑',
      'POST /api/projects/:id/story/cancel': '叫停一条龙',
    },
    cli: 'npm run take -- <cmd>，见 server/cli.ts',
    builtin_agent: {
      chat: 'POST /api/agent/chat {text, projectId?, sessionId?} → SSE，事件：assistant/tool/confirm/confirm_result/job/project/done/error',
      approve: 'POST /api/agent/approve {id, approve} 回应审批门（删节点/删版本/杀 8888）',
      optimize: 'POST /api/agent/optimize {idea, target:image|video, count?, style?, refine?, current?} → 提示词候选',
      review: 'POST /api/agent/review {projectId, nodeId, takeIds?, criteria?, max?, pinBest?} → 看图打分排序挑最优',
      diagnose: 'POST /api/agent/diagnose {projectId, nodeId?, takeIds?, useLlm?} → 失败版本的原因与改法',
      status: 'GET /api/agent/status 配置与工具数',
      tools: TOOLS.map((t) => t.function.name),
      guarded: [...GUARDED],
    },
    ws: '/ws 推 {type:"job",phase,nodeId,takeId,...} 和 {type:"project"}',
  });
}));

// ── 静态 ─────────────────────────────────────────────────────────────
app.use('/media', h((req, res) => {
  // 注意：app.use 挂载后 req.path 已剥掉 '/media' 前缀，必须用 originalUrl 取完整路径
  const raw = decodeURIComponent((req.originalUrl || req.url).split('?')[0]);
  const [projectId, ...rest] = raw.replace(/^\/media\/?/, '').split('/');
  const abs = mediaAbs(projectId, rest.join('/'));
  if (!fs.existsSync(abs)) {
    res.status(404).json({ error: 'media 不存在', projectId, rel: rest.join('/'), abs });
    return;
  }
  res.sendFile(abs);
}));

if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(DIST, 'index.html'));
  });
} else {
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.type('html').send(
      `<pre style="font:14px/1.6 ui-monospace">Takeboard 前端还没构建。\n开发模式：npm run dev（画布在 http://127.0.0.1:5317）\n生产模式：npm run build 后重启本服务</pre>`,
    );
  });
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  broadcast({ type: 'error', message });
  res.status(400).json({ error: message });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Takeboard server → http://127.0.0.1:${PORT}  root=${ROOT}`);
  void resumeJobs(emit).then((r) => {
    if (r.resumed || r.dropped) console.log(`重启续跑：接手 ${r.resumed} 条作业，作废 ${r.dropped} 条僵尸 take`);
  });
});
