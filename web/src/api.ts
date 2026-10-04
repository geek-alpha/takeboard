import type { ComfyStatus, Edge, GpuPortReport, InstanceAction, InstanceRecipe, InstanceStatus, JobProgress, NodeKind, Project, ProjectSettings, ProjectSummary, SequenceView, Story, StoryBeat, Take, TakeNode, TakeParams } from '@shared/types';

/** 接戏结果：尾帧节点 + 它连到了哪一镜（后端 handoffShot 的返回） */
export interface HandoffResult {
  from: { nodeId: string; title: string; takeId: string; index: number };
  to: { nodeId: string; title: string };
  frameNode: TakeNode;
  frameTake: Take;
}

async function j<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(typeof data === 'object' && data?.error ? data.error : `${res.status} ${text.slice(0, 300)}`);
  return data as T;
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
const patch = (url: string, body: unknown) => fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const del = (url: string) => fetch(url, { method: 'DELETE' });

export interface TemplateBinding {
  nodeId: string;
  class: string;
  field: string;
  role: string;
}
export interface TemplateInfo {
  id: string;
  title: string;
  description: string;
  host?: string;
  promptPrefix?: string;
  negative?: string;
  size?: string;
  /** 比例档位名（后端唯一真相源）；模板没有 aspect 旋钮时也给默认表 */
  aspectOptions?: string[];
  steps?: number;
  default?: boolean;
  nodeCount: number;
  bindings: TemplateBinding[];
}

/** 服务端回的 LLM 配置：key 只有脱敏串，完整值不出服务端 */
export interface LlmConfigPublic {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  extraHeaders: Record<string, string>;
  /** key 从哪来：env（环境变量压着）/ file（面板存的）/ dotenv（项目根 .env）/ none */
  source: 'env' | 'file' | 'dotenv' | 'none';
  apiKeyMasked: string;
  apiKeySet: boolean;
  apiKeyInFile: boolean;
  file: string;
  /** 有环境变量压着文件：面板改了不生效 */
  envOverride: boolean;
}

/** 提交给服务端的改动。apiKey 留空 = 不改，要清掉传 clearApiKey */
export interface LlmConfigPatch {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  clearApiKey?: boolean;
}

export interface LlmTestResult {
  ok: boolean;
  detail: string;
  ms: number;
  model: string;
  baseUrl: string;
}

export interface DefaultsPayload {
  defaults: Partial<ProjectSettings>;
  effective: ProjectSettings;
  file: string;
}

export const api = {
  health: () => fetch('/api/health').then((r) => j<any>(r)),
  projects: () => fetch('/api/projects').then((r) => j<ProjectSummary[]>(r)),
  project: (id: string) => fetch(`/api/projects/${id}`).then((r) => j<Project>(r)),
  createProject: (name: string) => post('/api/projects', { name }).then((r) => j<Project>(r)),
  saveProject: (p: Project) =>
    fetch(`/api/projects/${p.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then((r) => j<Project>(r)),

  addNode: (projectId: string, body: { kind: NodeKind; title?: string; x?: number; y?: number; text?: string }) =>
    post(`/api/projects/${projectId}/nodes`, body).then((r) => j<TakeNode>(r)),
  patchNode: (projectId: string, nodeId: string, body: Partial<TakeNode>) =>
    patch(`/api/projects/${projectId}/nodes/${nodeId}`, body).then((r) => j<TakeNode>(r)),
  deleteNode: (projectId: string, nodeId: string) => del(`/api/projects/${projectId}/nodes/${nodeId}`).then((r) => j<unknown>(r)),

  addEdge: (projectId: string, from: string, to: string, pin: 'active' | string = 'active') =>
    post(`/api/projects/${projectId}/edges`, { from, to, pin }).then((r) => j<Edge>(r)),
  patchEdge: (projectId: string, edgeId: string, pin: 'active' | string) =>
    patch(`/api/projects/${projectId}/edges/${edgeId}`, { pin }).then((r) => j<Edge>(r)),
  deleteEdge: (projectId: string, edgeId: string) => del(`/api/projects/${projectId}/edges/${edgeId}`).then((r) => j<unknown>(r)),

  importPath: (projectId: string, nodeId: string, path: string) =>
    post(`/api/projects/${projectId}/nodes/${nodeId}/takes`, { path }).then((r) => j<Take>(r)),
  putText: (projectId: string, nodeId: string, text: string) =>
    post(`/api/projects/${projectId}/nodes/${nodeId}/takes`, { text }).then((r) => j<Take>(r)),
  activateTake: (projectId: string, nodeId: string, takeId: string) =>
    patch(`/api/projects/${projectId}/nodes/${nodeId}/takes/${takeId}`, { active: true }).then((r) => j<{ node: TakeNode; take: Take }>(r)),
  labelTake: (projectId: string, nodeId: string, takeId: string, label: string) =>
    patch(`/api/projects/${projectId}/nodes/${nodeId}/takes/${takeId}`, { label }).then((r) => j<{ node: TakeNode; take: Take }>(r)),
  deleteTake: (projectId: string, nodeId: string, takeId: string) =>
    del(`/api/projects/${projectId}/nodes/${nodeId}/takes/${takeId}`).then((r) => j<unknown>(r)),

  run: (projectId: string, nodeId: string, params?: TakeParams, mode?: 'image' | 'video') =>
    post(`/api/projects/${projectId}/run`, { nodeId, params, mode }).then((r) => j<Take>(r)),
  sweep: (projectId: string, nodeId: string, count: number, params?: TakeParams, mode?: 'image' | 'video') =>
    post(`/api/projects/${projectId}/sweep`, { nodeId, count, params, mode }).then((r) => j<{ takes: Take[] }>(r)),
  op: (projectId: string, nodeId: string, op: string, params?: Record<string, unknown>) =>
    post(`/api/projects/${projectId}/ops`, { nodeId, op, params }).then((r) => j<Take>(r)),
  sequence: (projectId: string, end?: string) =>
    fetch(`/api/projects/${projectId}/sequence${end ? `?end=${encodeURIComponent(end)}` : ''}`).then((r) => j<SequenceView>(r)),
  exportFilm: (projectId: string, body?: { end?: string; name?: string; params?: Record<string, unknown> }) =>
    post(`/api/projects/${projectId}/export`, body).then((r) => j<{ take: Take; node: TakeNode; shots: number }>(r)),
  /** 接戏：本镜尾帧接成下一镜首帧。不传 to 就接 x 排在它后面的那一镜。 */
  handoff: (projectId: string, body: { from: string; to?: string; params?: Record<string, unknown> }) =>
    post(`/api/projects/${projectId}/handoff`, body).then((r) => j<HandoffResult>(r)),
  firstFrame: (projectId: string, nodeId: string) =>
    fetch(`/api/projects/${projectId}/firstframe?nodeId=${encodeURIComponent(nodeId)}`).then((r) =>
      j<{ frame?: { file: string; nodeId: string; takeId: string }; blockedBy?: string }>(r),
    ),
  replay: (projectId: string, nodeId: string) =>
    post(`/api/projects/${projectId}/replay`, { nodeId }).then((r) => j<{ order: string[]; started: string[] }>(r)),

  comfy: (projectId?: string) =>
    fetch(`/api/comfy/status${projectId ? `?project=${projectId}` : ''}`).then((r) => j<{ video: ComfyStatus; image: ComfyStatus }>(r)),
  gpu: () => fetch('/api/gpu').then((r) => j<{ videoPort: GpuPortReport; imagePort: GpuPortReport }>(r)),
  releaseImage: (port = 8888) => post('/api/gpu/release-image', { port }).then((r) => j<GpuPortReport>(r)),

  // 实例启停（生图/出片都能一键拉取和关闭）
  machine: () => fetch('/api/machine').then((r) => j<{ selfPort: number; instances: InstanceStatus[] }>(r)),
  saveMachine: (instances: InstanceRecipe[]) =>
    fetch('/api/machine', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instances }) }).then((r) =>
      j<{ instances: InstanceRecipe[] }>(r),
    ),
  startInstance: (id: string) => post(`/api/machine/instances/${encodeURIComponent(id)}/start`, {}).then((r) => j<InstanceAction>(r)),
  stopInstance: (id: string, force = false) =>
    post(`/api/machine/instances/${encodeURIComponent(id)}/stop`, { force }).then((r) => j<InstanceAction>(r)),
  // 配置：LLM 基础配置 + 本机默认项目设置（机器级，换项目不用重配）
  llm: () => fetch('/api/llm').then((r) => j<LlmConfigPublic>(r)),
  saveLlm: (body: LlmConfigPatch) =>
    fetch('/api/llm', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<LlmConfigPublic>(r)),
  testLlm: () => post('/api/llm/test').then((r) => j<LlmTestResult>(r)),
  defaults: () => fetch('/api/defaults').then((r) => j<DefaultsPayload>(r)),
  saveDefaults: (defaults: Partial<ProjectSettings>) =>
    fetch('/api/defaults', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaults }) }).then((r) => j<DefaultsPayload>(r)),

  templates: (projectId?: string) =>
    fetch(`/api/templates${projectId ? `?project=${projectId}` : ''}`).then((r) => j<{ dir: string; templates: TemplateInfo[] }>(r)),
  jobs: () => fetch('/api/jobs').then((r) => j<JobProgress[]>(r)),

  // 内置助手
  agentStatus: () => fetch('/api/agent/status').then((r) => j<AgentStatus>(r)),
  agentOptimize: (body: OptimizeRequest) => post('/api/agent/optimize', body).then((r) => j<OptimizeResult>(r)),
  agentApprove: (id: string, approve: boolean) => post('/api/agent/approve', { id, approve }).then((r) => j<{ ok: boolean }>(r)),
  agentReview: (body: ReviewRequest) => post('/api/agent/review', body).then((r) => j<ReviewResult>(r)),
  agentDiagnose: (body: DiagnoseRequest) => post('/api/agent/diagnose', body).then((r) => j<DiagnoseResult>(r)),
  agentReset: (sessionId?: string) => post('/api/agent/reset', { sessionId }).then((r) => j<{ ok: boolean }>(r)),

  // 剧情
  story: (projectId: string) => fetch(`/api/projects/${projectId}/story`).then((r) => j<StoryStatus>(r)),
  saveStory: (projectId: string, story: Partial<Story>) =>
    fetch(`/api/projects/${projectId}/story`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(story) }).then((r) =>
      j<Story>(r),
    ),
  editBeat: (projectId: string, beatId: string, body: Partial<StoryBeat>) =>
    patch(`/api/projects/${projectId}/story/beats/${encodeURIComponent(beatId)}`, body).then((r) => j<Story>(r)),
  importScript: (projectId: string, body: { text: string; replace?: boolean; title?: string }) =>
    post(`/api/projects/${projectId}/story/import`, body).then((r) => j<Story>(r)),
  draftStory: (projectId: string, body: { idea: string; shots?: number; seconds?: number; style?: string; ratio?: string; context?: string; save?: boolean }) =>
    post(`/api/projects/${projectId}/story/draft`, body).then((r) => j<Story>(r)),
  applyStory: (projectId: string, body: { beats?: string[]; aspect?: string } = {}) =>
    post(`/api/projects/${projectId}/story/apply`, body).then((r) => j<ApplyResult>(r)),
  refineStory: (projectId: string, body: { beats?: string[]; target?: 'image' | 'video' | 'both'; refs?: boolean } = {}) =>
    post(`/api/projects/${projectId}/story/refine`, body).then((r) => j<{ started: boolean }>(r)),
  runStory: (projectId: string, body: { beats?: string[]; refine?: boolean; handoff?: boolean; retries?: number; apply?: boolean; film?: boolean; count?: number } = {}) =>
    post(`/api/projects/${projectId}/story/run`, body).then((r) => j<{ started: boolean; why?: string }>(r)),
  cancelStory: (projectId: string) => post(`/api/projects/${projectId}/story/cancel`).then((r) => j<{ cancelled: boolean }>(r)),
};

/** 剧情一镜 + 它跟画布的对应（后端 storyStatus） */
export interface StoryBeatRow extends StoryBeat {
  imageDone: boolean;
  videoDone: boolean;
  takes: number;
}

export interface StoryStatus {
  title: string;
  logline: string;
  style: string;
  source: string;
  beats: StoryBeatRow[];
  /** 已经填过模板的镜数 */
  filled: number;
  /** 已经有片子的镜数 */
  done: number;
  totalSeconds: number;
}

export interface ApplyResult {
  created: Array<{ beat: string; image: string; video: string }>;
  updated: string[];
  edges: number;
  total: number;
}

/** 一条龙/精修推过来的进度（后端 broadcast type='story'） */
export interface StoryEvent {
  type: 'story';
  projectId: string;
  phase?: 'apply' | 'refine' | 'image' | 'release' | 'video' | 'export' | 'done' | 'failed';
  detail?: string;
  index?: number;
  total?: number;
}

export interface AgentStatus {
  configured: boolean;
  model: string;
  baseUrl: string;
  source: string;
  tools: number;
  sessions: number;
  pending: number;
}

export interface PromptCandidate {
  text: string;
  note?: string;
  /** 精修模式下：相对既有词改了哪几处 */
  changes?: string[];
}

export interface OptimizeResult {
  candidates: PromptCandidate[];
  /** 这次走的是哪条路：精修（保住设定）还是重写 */
  mode?: 'refine' | 'rewrite';
  negative?: string;
  tips?: string;
  /** 实际送进模型的参考画面（没给就是空） */
  refsUsed?: string[];
  /** 带没带剧情线 */
  storyUsed?: boolean;
  /** 想给但没给上的参考 */
  skipped?: string[];
  warn?: string;
  refsText?: string;
}

export interface OptimizeRequest {
  idea: string;
  target: 'image' | 'video';
  count?: number;
  style?: string;
  refine?: string;
  current?: string;
  /** refine=保住既有设定只做规范化（默认，有 current 就是它）；rewrite=允许推翻重写 */
  mode?: 'refine' | 'rewrite';
  context?: string;
  /** 有项目才收得到参考画面 */
  projectId?: string;
  /** 围着哪个节点收参考（上游/相邻镜头都看它） */
  nodeId?: string;
  /** 额外指定：node:标题@v2 / take:xxx / path:绝对路径 */
  refs?: string[];
  /** 自动带上游与相邻镜头，默认开 */
  autoRefs?: boolean;
  /** 出片时长（秒）：H3 按它算镜头预算 */
  seconds?: number;
  /** 画幅，如 16:9 —— 同样进 H3 的 TARGET 段 */
  ratio?: string;
}

export interface TakeScore {
  takeId: string;
  v: number;
  score: number;
  verdict: string;
  issues?: string;
}

export interface ReviewRequest {
  projectId: string;
  nodeId: string;
  takeIds?: string[];
  criteria?: string;
  max?: number;
  pinBest?: boolean;
  /** 额外对照画面 */
  refs?: string[];
  /** 自动拿上游和相邻镜头当对照判连贯度，默认开 */
  autoRefs?: boolean;
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
  pinned?: string;
  /** 评审时用到的对照画面 */
  refs?: string[];
  skipped: string[];
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

export interface DiagnoseRequest {
  projectId: string;
  nodeId?: string;
  takeIds?: string[];
  useLlm?: boolean;
}

export interface DiagnoseResult {
  items: Diagnosis[];
  env: string;
}

/** 助手推过来的事件（与 server/agent.ts 的 AgentEvent 一一对应）。 */
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'round'; round: number }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; args: Record<string, unknown>; status: 'running' | 'ok' | 'error'; result?: string; ms?: number }
  | { type: 'confirm'; id: string; label: string; tool: string; args: Record<string, unknown> }
  | { type: 'confirm_result'; id: string; approved: boolean }
  | { type: 'job'; job: JobProgress }
  | { type: 'project'; projectId: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

export interface AgentChatRequest {
  text: string;
  projectId?: string;
  sessionId?: string;
  maxRounds?: number;
}

/**
 * 一轮对话的 SSE 流。事件逐条回调，断开由 AbortSignal 控。
 * 不用 EventSource：它只能发 GET，带不了 body。
 */
export async function streamAgentChat(req: AgentChatRequest, onEvent: (ev: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(6)) as AgentEvent);
      } catch {
        // 半截事件：SSE 分片边界上会出现，忽略即可
      }
    }
  }
}

export const mediaUrl = (projectId: string, file: string) => `/media/${projectId}/${file.split('/').map(encodeURIComponent).join('/')}`;
