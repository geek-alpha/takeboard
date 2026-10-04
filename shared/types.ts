/**
 * Takeboard 核心契约 —— 改这个文件之前先读完这段。
 *
 * 铁律一：任何产物都进 take 栈，永不覆盖。「推倒重来」= 新增 take + 重新引脚，不靠删除。
 * 铁律二：边缘（Edge）自带引脚。pin='active' 跟随上游当前版本；pin=<takeId> 钉死那一版。
 *         所以重跑上游不会悄悄改变下游——要变，得显式重新引脚。
 * 铁律三：每个 take 记 provenance（inputs: nodeId -> takeId），链路才可重演。
 */

import type { OpId } from './ops.ts';

export type MediaKind = 'image' | 'video' | 'audio';
export type TakeStatus = 'running' | 'done' | 'failed';
export type TakeSource = 'comfy' | 'import' | 'op' | 'text';
export type NodeKind = MediaKind | 'text' | 'op' | 'note';

export interface Probe {
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  bytes?: number;
}

export interface TakeParams {
  workflow?: string;
  prompt?: string;
  negative?: string;
  seed?: number;
  width?: number;
  height?: number;
  seconds?: number;
  steps?: number;
  [k: string]: unknown;
}

export interface Take {
  id: string;
  nodeId: string;
  createdAt: number;
  finishedAt?: number;
  status: TakeStatus;
  source: TakeSource;
  kind: MediaKind;
  /** 相对 projects/<id>/media/ 的路径 */
  file?: string;
  poster?: string;
  params: TakeParams;
  /** provenance：nodeId -> takeId。重演链路靠它 */
  inputs: Record<string, string>;
  /** op 节点的算子名：trim / concat / thumbs / transcode */
  op?: string;
  jobId?: string;
  /** ComfyUI 的 prompt_id：落盘后服务重启也能接着把产物收回来 */
  promptId?: string;
  error?: string;
  probe?: Probe;
  label?: string;
  /** text 节点承载的文本 */
  text?: string;
}

export interface TakeNode {
  id: string;
  kind: NodeKind;
  title: string;
  x: number;
  y: number;
  takes: Take[];
  /** 当前引脚指向的 take —— 版本引脚的真相源 */
  activeTake?: string;
  collapsed?: boolean;
  note?: string;
  /** 预设参数：还没跑之前就有的词与档位，跑的时候当默认值 */
  draft?: NodeDraft;
}

/**
 * 节点的预设参数。优先级：本次显式 params > draft > 上游文本节点 > 上一版继承。
 * 剧情填模板写的就是它 —— 词存在节点上，跑之前就能改，不用先堆一堆文本节点。
 */
export interface NodeDraft {
  prompt?: string;
  negative?: string;
  seconds?: number;
  aspect?: string;
  workflow?: string;
}

/** 剧情里的一镜。字段按「能直接填模板、能直接跑」设计，不留要人再翻译一层的东西。 */
export interface StoryBeat {
  id: string;
  /** 镜头名，也是填充后节点的标题 */
  title: string;
  /** 这一镜发生什么（中文，给人看也给模型当语境） */
  action: string;
  /** 生图词：一张静态画面 */
  image: string;
  /** 出片词：从首帧开始发生什么 */
  video: string;
  seconds: number;
  /** 画幅档位；不给就跟随首帧 */
  aspect?: string;
  /** 台词/旁白 */
  line?: string;
  /** 填模板后回填：这镜占了哪两个节点，重填时不重建 */
  imageNodeId?: string;
  videoNodeId?: string;
}

export interface Story {
  title: string;
  /** 一句话故事 */
  logline: string;
  /** 视觉风格，进提示词优化当风格倾向 */
  style: string;
  beats: StoryBeat[];
  /** import = 导入剧本 / ai = 助手创作 / manual = 手改 */
  source: 'import' | 'ai' | 'manual';
  updatedAt: number;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  /** 'active' = 跟随上游当前版本；否则是钉死的 takeId */
  pin: 'active' | string;
  toPort?: string;
  createdAt: number;
  /** 'firstframe' = 接戏显式接过来的首帧：出片只认它，别的图片入边让位 */
  role?: 'firstframe';
}

export interface ProjectView {
  x: number;
  y: number;
  zoom: number;
}

export interface TransitionSettings {
  /** 'none' = 硬切（走 concat）；其余是 ffmpeg xfade 的 transition 名 */
  type: string;
  /** 每处过渡时长 s */
  duration: number;
}

export interface ProjectSettings {
  /** 出片实例 */
  comfyHost: string;
  /** 生图实例（出片前要释放的那个） */
  imageHost: string;
  workflowImage: string;
  workflowVideo: string;
  workflowDir: string;
  ffmpeg: string;
  ffprobe: string;
  /** 出片前自动杀掉 8888 让出显存（8188 绝不碰） */
  releaseImageBeforeVideo: boolean;
  /** 出成片时镜间的过渡（预览台可改；旧项目里没有这个字段，按默认兜） */
  transition?: TransitionSettings;
  /** 生图默认画幅，如 720x1280（竖版 9:16）。节点或面板显式给的宽高优先于它 */
  frameSize?: string;
  /** 出片默认时长（秒）。节点 draft 里给了 seconds 就用它 */
  videoSeconds?: number;
  /**
   * 出片像素预算。H3 这类模板的宽高由 ResolutionSelector（档位 + 百万像素）现算，
   * 没有数值落点——想提画质只能抬这个数，代价是显存。
   */
  videoMegapixels?: number;
}

export interface Project {
  id: string;
  name: string;
  rev: number;
  createdAt: number;
  updatedAt: number;
  nodes: TakeNode[];
  edges: Edge[];
  view: ProjectView;
  settings: ProjectSettings;
  /** 剧情：导入或助手创作的分镜表。填充模板、一条龙跑初版都读它 */
  story?: Story;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  nodeCount: number;
  takeCount: number;
}

/** 预览序列里的一镜：已经排好顺序的一条片子的一段。 */
export interface Shot {
  nodeId: string;
  title: string;
  takeId: string;
  /** 节点内的版本号（1-based），跟画布上显示的 v 号一致 */
  index: number;
  file: string;
  poster?: string;
  duration: number;
  hasAudio: boolean;
  /** 画布坐标：预览面板靠 x 排剧情顺序，y 只用来消平手 */
  x: number;
  y: number;
}

export interface SequenceView {
  source: string;
  shots: Shot[];
  totalSeconds: number;
  /** 排不进片子的节点：没出片 / 出的不是视频 / 跑挂了 */
  skipped: Array<{ nodeId: string; title: string; why: string }>;
}

export interface ComfyStatus {
  host: string;
  alive: boolean;
  comfyuiVersion?: string;
  vramTotal?: number;
  vramFree?: number;
  device?: string;
  running?: number;
  pending?: number;
  error?: string;
}

export interface GpuPortReport {
  port: number;
  pid: number | null;
  cmdline?: string;
  killed?: boolean;
}

export interface JobProgress {
  jobId: string;
  projectId: string;
  nodeId: string;
  takeId: string;
  phase: 'submit' | 'queue' | 'running' | 'download' | 'done' | 'failed';
  promptId?: string;
  detail?: string;
  queue?: { running: number; pending: number };
  elapsedMs: number;
  error?: string;
}

export interface OpRequest {
  nodeId: string;
  /** 算子清单与参数定义在 shared/ops.ts —— 前端下拉、助手描述都从那儿来，别在这儿另列一份 */
  op: OpId;
  params?: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: Required<ProjectSettings> = {
  comfyHost: 'http://127.0.0.1:8188',
  imageHost: 'http://127.0.0.1:8888',
  workflowImage: 'z-image-guangyu',
  workflowVideo: 'minimax-h3-i2v-turbo',
  workflowDir: 'D:\\AI\\repos\\Easel\\skills\\shared\\comfy\\workflows',
  ffmpeg: 'D:\\AI\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe',
  ffprobe: 'D:\\AI\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffprobe.exe',
  releaseImageBeforeVideo: true,
  transition: { type: 'fade', duration: 0.5 },
  // 竖版 720x1280（9:16）：短视频平台的通行画幅。出片跟首帧吸附，自然落在 9:16 档
  frameSize: '720x1280',
  videoSeconds: 5,
  // 0.6 是 8188 实测不爆显存的预算。抬它换画质是亏本买卖：H3 一跑就是几分钟，
  // 中途 OOM 整条作业全废，720p 级的画幅本来也用不满更高的像素预算。
  videoMegapixels: 0.6,
};

/** 一个 ComfyUI 实例的启停配方。落 data/machine.json——改它不用改代码。 */
export interface InstanceRecipe {
  id: string;
  label: string;
  /** 探活地址，端口以它为准 */
  host: string;
  cwd: string;
  /** 完整命令行。端口写在命令里，改端口要连命令一起改 */
  command: string;
  /** 起完最多等几秒端口才监听（模型加载慢，默认给足） */
  bootSeconds: number;
  enabled: boolean;
}

export interface MachineSettings {
  instances: InstanceRecipe[];
}

/** 实时状态 = 配方 + 现在有没有在跑 */
export interface InstanceStatus {
  recipe: InstanceRecipe;
  port: number;
  listening: boolean;
  pid: number | null;
  cmdline?: string;
  alive: boolean;
  vramFree?: number;
  running?: number;
  pending?: number;
  error?: string;
}

export interface InstanceAction {
  id: string;
  action: 'start' | 'stop';
  ok: boolean;
  pid?: number | null;
  cmdline?: string;
  detail: string;
  /** 起不来时给日志尾巴，省得人去翻文件 */
  log?: string;
  /** true = 有作业在跑，要 force 才继续 */
  busy?: boolean;
}
