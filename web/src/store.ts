import { create } from 'zustand';
import { api, type StoryEvent, type StoryStatus, type TemplateInfo } from './api';
import type { ComfyStatus, JobProgress, NodeKind, Project, ProjectSummary, StoryBeat, Take, TakeNode, TakeParams } from '@shared/types';

export function activeTakeOf(node: TakeNode | undefined): Take | undefined {
  if (!node) return undefined;
  return node.takes.find((t) => t.id === node.activeTake) ?? node.takes[node.takes.length - 1];
}

export function takeIndex(node: TakeNode, takeId: string): number {
  return node.takes.findIndex((t) => t.id === takeId);
}

/** 引脚解析：与 server/store.ts 的 resolveTake 同一套规则（'active' = 跟随 activeTake）。 */
export function resolveTake(node: TakeNode | undefined, pin: 'active' | string): Take | undefined {
  if (!node) return undefined;
  if (pin !== 'active') return node.takes.find((t) => t.id === pin);
  return node.takes.find((t) => t.id === node.activeTake) ?? node.takes[node.takes.length - 1];
}

export interface WireInfo {
  edgeId: string;
  nodeId: string;
  title: string;
  pin: 'active' | string;
  takeId?: string;
  /** 现在生效的版本号（1-based），0 = 上游还没 take */
  index: number;
  /** 本节点当前那一版当时吃的版本号，0 = 没记录 */
  usedIndex: number;
  /** 本版吃的版本 ≠ 现在生效的版本：这一版过期了 */
  stale: boolean;
}

/** 本节点的每条入边：上游是谁、现在生效哪一版、本版是不是已经过期。 */
export function wiresOf(project: Project | undefined, nodeId: string): WireInfo[] {
  if (!project) return [];
  const node = project.nodes.find((n) => n.id === nodeId);
  const active = resolveTake(node, 'active');
  return project.edges
    .filter((e) => e.to === nodeId)
    .map((e) => {
      const up = project.nodes.find((n) => n.id === e.from);
      const take = resolveTake(up, e.pin);
      const usedId = active?.inputs?.[e.from];
      const at = (id?: string) => (up && id ? up.takes.findIndex((t) => t.id === id) + 1 : 0);
      return {
        edgeId: e.id,
        nodeId: e.from,
        title: up?.title ?? e.from,
        pin: e.pin,
        takeId: take?.id,
        index: at(take?.id),
        usedIndex: at(usedId),
        stale: !!usedId && !!take && usedId !== take.id,
      };
    });
}

/** take 的输入摘要：「山巅独行 v2 · 首帧 v1」，chip 的 tooltip 靠它说清这一版吃过谁。 */
export function inputsSummary(project: Project | undefined, take: Take | undefined): string {
  if (!project || !take) return '';
  return Object.entries(take.inputs ?? {})
    .map(([nodeId, takeId]) => {
      const up = project.nodes.find((n) => n.id === nodeId);
      return `${up?.title ?? nodeId} v${up ? takeIndex(up, takeId) + 1 : 0}`;
    })
    .join(' · ');
}

interface State {
  projects: ProjectSummary[];
  project?: Project;
  selected?: string;
  jobs: Record<string, JobProgress>;
  comfy?: { video: ComfyStatus; image: ComfyStatus };
  templates: TemplateInfo[];
  error?: string;
  busy: boolean;
  /** 剧情 + 它跟画布的对应关系 */
  story?: StoryStatus;
  /** 一条龙/精修的当前进展（后端推过来的） */
  storyMsg: string;
  /** 一条龙在跑（按钮该禁掉） */
  storyRunning: boolean;

  boot: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  createProject: (name: string) => Promise<void>;
  refresh: () => Promise<void>;
  setSelected: (id?: string) => void;
  addNode: (kind: NodeKind, x: number, y: number, text?: string) => Promise<void>;
  patchNode: (nodeId: string, patch: Partial<TakeNode>) => Promise<void>;
  moveNode: (nodeId: string, x: number, y: number) => Promise<void>;
  deleteNode: (nodeId: string) => Promise<void>;
  connect: (from: string, to: string) => Promise<void>;
  toggleEdgePin: (edgeId: string, pin: 'active' | string) => Promise<void>;
  deleteEdge: (edgeId: string) => Promise<void>;
  importPath: (nodeId: string, path: string) => Promise<void>;
  putText: (nodeId: string, text: string) => Promise<void>;
  activate: (nodeId: string, takeId: string) => Promise<void>;
  deleteTake: (nodeId: string, takeId: string) => Promise<void>;
  run: (nodeId: string, params?: TakeParams) => Promise<void>;
  sweep: (nodeId: string, count: number, params?: TakeParams) => Promise<void>;
  replay: (nodeId: string) => Promise<void>;
  releaseImage: () => Promise<void>;
  refreshEnv: () => Promise<void>;
  dismissError: () => void;
  refreshStory: () => Promise<void>;
  editBeat: (beatId: string, patch: Partial<StoryBeat>) => Promise<void>;
  importScript: (text: string, replace?: boolean) => Promise<number>;
  draftStory: (idea: string, opts?: { shots?: number; seconds?: number; style?: string }) => Promise<number>;
  applyStory: () => Promise<void>;
  refineStory: (target: 'image' | 'video' | 'both') => Promise<void>;
  runStory: (opts?: { refine?: boolean; handoff?: boolean; film?: boolean; beats?: string[] }) => Promise<void>;
  cancelStory: () => Promise<void>;
}

export const useStore = create<State>((set, get) => {
  const guard = async (fn: () => Promise<void>) => {
    set({ busy: true });
    try {
      await fn();
      set({ error: undefined });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  };

  const reload = async () => {
    const p = get().project;
    if (p) set({ project: await api.project(p.id) });
  };

  return {
    projects: [],
    jobs: {},
    templates: [],
    busy: false,
    storyMsg: '',
    storyRunning: false,

    boot: () =>
      guard(async () => {
        const projects = await api.projects();
        set({ projects });
        const first = projects[0];
        if (first) await get().openProject(first.id);
        await get().refreshEnv();
      }),

    openProject: (id) =>
      guard(async () => {
        const project = await api.project(id);
        set({ project, selected: undefined });
        const { templates } = await api.templates(id);
        set({ templates });
        set({ story: await api.story(id), storyMsg: '' });
      }),

    createProject: (name) =>
      guard(async () => {
        const p = await api.createProject(name);
        set({ projects: await api.projects() });
        await get().openProject(p.id);
      }),

    refresh: () => guard(reload),

    setSelected: (id) => set({ selected: id }),

    addNode: (kind, x, y, text) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        const node = await api.addNode(p.id, { kind, x, y, text });
        await reload();
        set({ selected: node.id });
      }),

    patchNode: (nodeId, patch) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.patchNode(p.id, nodeId, patch);
        await reload();
      }),

    moveNode: (nodeId, x, y) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        // 位置高频变动，只打 PATCH，不整图回读，免得拖拽时画面抖
        await api.patchNode(p.id, nodeId, { x, y });
        set({
          project: { ...p, nodes: p.nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n)) },
        });
      }),

    deleteNode: (nodeId) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.deleteNode(p.id, nodeId);
        await reload();
      }),

    connect: (from, to) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.addEdge(p.id, from, to);
        await reload();
      }),

    toggleEdgePin: (edgeId, pin) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.patchEdge(p.id, edgeId, pin);
        await reload();
      }),

    deleteEdge: (edgeId) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.deleteEdge(p.id, edgeId);
        await reload();
      }),

    importPath: (nodeId, path) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.importPath(p.id, nodeId, path);
        await reload();
      }),

    putText: (nodeId, text) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.putText(p.id, nodeId, text);
        await reload();
      }),

    activate: (nodeId, takeId) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.activateTake(p.id, nodeId, takeId);
        await reload();
      }),

    deleteTake: (nodeId, takeId) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.deleteTake(p.id, nodeId, takeId);
        await reload();
      }),

    run: (nodeId, params) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.run(p.id, nodeId, params);
        await reload();
      }),

    sweep: (nodeId, count, params) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.sweep(p.id, nodeId, count, params);
        await reload();
      }),

    replay: (nodeId) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.replay(p.id, nodeId);
        await reload();
      }),

    releaseImage: () =>
      guard(async () => {
        await api.releaseImage(8888);
        await get().refreshEnv();
      }),

    refreshEnv: () =>
      guard(async () => {
        const p = get().project;
        set({ comfy: await api.comfy(p?.id), jobs: Object.fromEntries((await api.jobs()).map((j) => [j.jobId, j])) });
      }),

    dismissError: () => set({ error: undefined }),

    refreshStory: () =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        set({ story: await api.story(p.id) });
      }),

    editBeat: (beatId, patch) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.editBeat(p.id, beatId, patch);
        set({ story: await api.story(p.id) });
      }),

    importScript: async (text, replace) => {
      const p = get().project;
      if (!p) return 0;
      let n = 0;
      await guard(async () => {
        const story = await api.importScript(p.id, { text, replace });
        n = story.beats.length;
        set({ story: await api.story(p.id), storyMsg: `导入了 ${n} 镜` });
      });
      return n;
    },

    draftStory: async (idea, opts) => {
      const p = get().project;
      if (!p) return 0;
      let n = 0;
      await guard(async () => {
        const story = await api.draftStory(p.id, { idea, ...opts });
        n = story.beats.length;
        set({ story: await api.story(p.id), storyMsg: `助手写了 ${n} 镜，先看一遍再填模板` });
      });
      return n;
    },

    applyStory: () =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        const out = await api.applyStory(p.id);
        set({ storyMsg: `填了 ${out.created.length} 镜 · 复用 ${out.updated.length} 镜 · 连线 ${out.edges} 条` });
        await reload();
        set({ story: await api.story(p.id) });
      }),

    refineStory: (target) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        await api.refineStory(p.id, { target });
        set({ storyMsg: '精修开跑了，进度在下面' });
      }),

    runStory: (opts) =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        const one = opts?.beats?.length === 1;
        const r = await api.runStory(p.id, { refine: opts?.refine, handoff: opts?.handoff, film: opts?.film, beats: opts?.beats });
        if (!r.started) {
          set({ storyMsg: r.why ?? '没起来' });
          return;
        }
        set({
          storyRunning: true,
          storyMsg: one ? '跑这一镜：首帧 → 释放显存 → 出片' : '一条龙开跑：填模板 → 首帧 → 释放显存 → 出片 → 合成',
        });
      }),

    cancelStory: () =>
      guard(async () => {
        const p = get().project;
        if (!p) return;
        const r = await api.cancelStory(p.id);
        set({ storyMsg: r.cancelled ? '已叫停（这一镜跑完就停）' : '没在跑' });
      }),
  };
});

/** 后端 WebSocket：作业进度直接灌进画布，不靠轮询。 */
export function connectSocket(): () => void {
  let ws: WebSocket | undefined;
  let closed = false;
  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'job') {
        const job = msg as JobProgress;
        useStore.setState((s) => ({ jobs: { ...s.jobs, [job.jobId]: job } }));
        if (job.phase === 'done' || job.phase === 'failed') {
          setTimeout(() => void useStore.getState().refresh(), 200);
        } else {
          // 作业在跑：把 take 状态就地标成 running，画布上立刻有反应
          useStore.setState((s) => {
            if (!s.project) return s;
            return {
              project: {
                ...s.project,
                nodes: s.project.nodes.map((n) =>
                  n.id === job.nodeId
                    ? { ...n, takes: n.takes.map((t) => (t.id === job.takeId ? { ...t, status: 'running' as const } : t)) }
                    : n,
                ),
              },
            };
          });
        }
      } else if (msg.type === 'story') {
        const ev = msg as StoryEvent;
        const ended = ev.phase === 'done' || ev.phase === 'failed';
        // 带 phase 的进度决定「在不在跑」，带 detail 的就地刷成最新一句
        useStore.setState({ ...(ev.phase ? { storyRunning: !ended } : {}), ...(ev.detail ? { storyMsg: ev.detail } : {}) });
        // 不带 phase 的是「剧情变了」通知——两种都重新拉一次
        if (!ev.phase || ended) {
          setTimeout(() => void useStore.getState().refreshStory(), 200);
        }
      } else if (msg.type === 'project') {
        void useStore.getState().refresh();
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
