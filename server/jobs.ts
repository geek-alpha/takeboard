import fs from 'node:fs';
import path from 'node:path';
import * as comfy from './comfy.ts';
import * as templates from './workflows.ts';
import { burnSubtitle, concat, extractAudio, frame, makePoster, mixAudio, muxAudio, probe, splitCues, srtText, trim, xfadeConcat, type AudioTrack } from './media.ts';
import { OP_IDS, opDef } from '../shared/ops.ts';
import { releaseImagePort } from './gpu.ts';
import {
  LOGS_DIR,
  appendTake,
  inboundEdges,
  listProjects,
  loadProject,
  mediaAbs,
  mediaDir,
  newId,
  nodeOf,
  patchTake,
  relMedia,
  resolveTake,
} from './store.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import type { Edge, JobProgress, MediaKind, Project, Take, TakeNode, TakeParams } from '../shared/types.ts';

export type Emit = (ev: JobProgress) => void;

const running = new Map<string, JobProgress>();

export function jobsSnapshot(): JobProgress[] {
  return [...running.values()];
}

export interface RunRequest {
  projectId: string;
  nodeId: string;
  mode?: 'image' | 'video';
  params?: TakeParams;
  overrides?: Record<string, unknown>;
  label?: string;
}

/** 入边上游的生效 take —— 解析规则只有 store.resolveTake 一份，别在这儿重写。 */
function upstreamTake(p: Project, e: Edge): Take | undefined {
  return resolveTake(
    p.nodes.find((n) => n.id === e.from),
    e.pin,
  );
}

/** 上游文本/提示词来源：文本节点优先，其次上游 take 用过的提示词。 */
function promptFromUpstream(p: Project, nodeId: string): string | undefined {
  for (const e of inboundEdges(p, nodeId)) {
    const t = upstreamTake(p, e);
    if (t?.text) return t.text;
    if (typeof t?.params?.prompt === 'string' && t.params.prompt) return t.params.prompt;
  }
  return undefined;
}

export interface UpstreamFrame {
  file: string;
  nodeId: string;
  takeId: string;
  width?: number;
  height?: number;
}

/**
 * 上游首帧：入边里第一个「有成品图」的 take，连它的实际像素一起带出来（比例继承要用）。
 *
 * 带 role='firstframe' 的边是接戏显式接过来的，优先于其他图入边；它没成品就**不偷偷退回旧图**——
 * 退回等于静默接错戏，画面看着像新镜、其实开在上一版旧首帧上。这时 blockedBy 带回那个节点的标题，
 * 调用方拿它报一句人看得懂的话。
 */
export function firstFrameFromUpstream(p: Project, nodeId: string): { frame?: UpstreamFrame; blockedBy?: string } {
  const inbound = inboundEdges(p, nodeId);
  const explicit = inbound.filter((e) => e.role === 'firstframe');
  const scan = (edges: Edge[]): { frame?: UpstreamFrame; blockedBy?: string } => {
    for (const e of edges) {
      const up = p.nodes.find((n) => n.id === e.from);
      const t = upstreamTake(p, e);
      if (!up || !t) continue;
      if (t.kind === 'image' && t.status === 'done' && t.file) {
        return { frame: { file: t.file, nodeId: up.id, takeId: t.id, width: t.probe?.width, height: t.probe?.height } };
      }
    }
    return {};
  };
  if (explicit.length) {
    const hit = scan(explicit);
    if (hit.frame) return hit;
    const blocked = p.nodes.find((n) => n.id === explicit[0].from);
    return { blockedBy: blocked?.title ?? explicit[0].from };
  }
  return scan(inbound);
}

/** 这一镜的首帧实际是谁给的（面板显示 + 回归断言用）。 */
export function firstFrameOf(projectId: string, nodeId: string): { frame?: UpstreamFrame; blockedBy?: string } {
  return firstFrameFromUpstream(loadProject(projectId), nodeId);
}

/** 首帧实际像素：take 里 probe 过的直接用，没有就现场探（手工登记的老素材可能没 probe）。 */
function frameSize(
  projectId: string,
  frame: { file: string; width?: number; height?: number },
  settings: Project['settings'],
): { width: number; height: number } | undefined {
  if (frame.width && frame.height) return { width: frame.width, height: frame.height };
  try {
    const info = probe(settings.ffprobe, mediaAbs(projectId, frame.file));
    if (info.width && info.height) return { width: info.width, height: info.height };
  } catch {
    // 探不出来就不带比例，退回模板默认档
  }
  return undefined;
}

/**
 * 生图节点的比例该听谁的：下游出片节点已经定死的档位。
 * 反过来的情况不采纳——下游比例若是从首帧吸附来的，那比例本来就是从这张图算出来的，
 * 再喂回去等于绕成环，还会把「换张图重跑」的继承压死。
 */
export interface DownstreamAspect {
  nodeId: string;
  nodeTitle: string;
  aspect: string;
  from: string;
  usable: boolean;
}

export function downstreamAspect(p: Project, nodeId: string): DownstreamAspect | undefined {
  const seen = new Set<string>([nodeId]);
  const queue = p.edges.filter((e) => e.from === nodeId).map((e) => e.to);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = p.nodes.find((x) => x.id === id);
    if (!n) continue;
    if (n.kind === 'video') {
      const active = n.takes.find((t) => t.id === n.activeTake) ?? n.takes[n.takes.length - 1];
      const aspect = typeof active?.params?.aspect === 'string' ? active.params.aspect : undefined;
      if (aspect) {
        const from = typeof active?.params?.aspectFrom === 'string' ? active.params.aspectFrom : '';
        return { nodeId: n.id, nodeTitle: n.title, aspect, from, usable: !/^首帧/.test(from) };
      }
    }
    for (const e of p.edges.filter((x) => x.from === id)) queue.push(e.to);
  }
  return undefined;
}

function provenance(p: Project, nodeId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of inboundEdges(p, nodeId)) {
    const t = upstreamTake(p, e);
    if (t) out[e.from] = t.id;
  }
  return out;
}

function emitProgress(emit: Emit, ev: JobProgress) {
  running.set(ev.jobId, ev);
  if (ev.phase === 'done' || ev.phase === 'failed') setTimeout(() => running.delete(ev.jobId), 60_000);
  emit(ev);
}

function takeKindFor(mode: 'image' | 'video'): MediaKind {
  return mode === 'video' ? 'video' : 'image';
}

function pickOutput(items: comfy.OutputItem[], mode: 'image' | 'video'): comfy.OutputItem | undefined {
  const videoExt = /\.(mp4|webm|mov|mkv)$/i;
  const imageExt = /\.(png|jpg|jpeg|webp)$/i;
  return items.find((i) => (mode === 'video' ? videoExt : imageExt).test(i.filename)) ?? items[0];
}

/** 把 ComfyUI 的产物落到项目 media 里，抽帧、探测、入栈。重启续跑也走这条路。 */
async function finalizeOutputs(
  projectId: string,
  nodeId: string,
  takeId: string,
  host: string,
  mode: 'image' | 'video',
  record: any,
  settings: Project['settings'],
  note?: (phase: JobProgress['phase'], detail?: string) => void,
): Promise<string> {
  const items = comfy.collectOutputs(record);
  const chosen = pickOutput(items, mode);
  if (!chosen) throw new Error('任务成功但没拿到产物');
  note?.('download', `下载 ${chosen.filename}`);
  const buf = await comfy.fetchOutput(host, chosen);
  const ext = path.extname(chosen.filename) || (mode === 'video' ? '.mp4' : '.png');
  const dir = path.join(mediaDir(projectId), nodeId);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, `${takeId}${ext}`);
  fs.writeFileSync(abs, buf);

  let poster: string | undefined;
  let probeInfo;
  try {
    probeInfo = probe(settings.ffprobe, abs);
    if (mode === 'video') {
      const posterAbs = path.join(dir, `${takeId}.jpg`);
      makePoster(settings.ffmpeg, abs, posterAbs, 0.2);
      poster = relMedia(projectId, posterAbs);
    }
  } catch (err) {
    fs.appendFileSync(path.join(LOGS_DIR, 'probe-errors.log'), `${new Date().toISOString()} ${abs} ${String(err)}\n`);
  }

  const file = relMedia(projectId, abs);
  patchTake(projectId, nodeId, takeId, { status: 'done', file, poster, finishedAt: Date.now(), probe: probeInfo });
  return file;
}

/**
 * 起一个作业：立刻返回 take（status=running），真正干活在后台。
 * 画布上先出现一张「正在出」的卡，出完原地变成成品——不阻塞任何人。
 */
export function runNode(req: RunRequest, emit: Emit): Take {
  const p = loadProject(req.projectId);
  const node = nodeOf(p, req.nodeId);
  const mode: 'image' | 'video' = req.mode ?? (node.kind === 'video' ? 'video' : 'image');
  const prev = node.takes[node.takes.length - 1];
  // 节点预设（剧情填模板写的就是它）：压在上一版继承之上、本次显式之下。
  // 它比上游文本节点优先——词是用户直接写在节点上的，比「连线即数据流」更具体。
  const draft = node.draft ?? {};
  const draftParams: TakeParams = {};
  if (draft.prompt?.trim()) draftParams.prompt = draft.prompt;
  if (draft.negative?.trim()) draftParams.negative = draft.negative;
  if (draft.seconds !== undefined) draftParams.seconds = draft.seconds;
  if (draft.aspect) draftParams.aspect = draft.aspect;
  if (draft.workflow) draftParams.workflow = draft.workflow;
  const params: TakeParams = { ...(prev?.params ?? {}), ...draftParams, ...(req.params ?? {}) };
  // 上游文本节点是显式数据源：连线即数据流，改了词下一版就该生效。
  // 少了这一条，上一版继承下来的旧提示词会把上游新词压住——连了线也是摆设。
  const asked = typeof req.params?.prompt === 'string' && req.params.prompt.trim() ? req.params.prompt : undefined;
  params.prompt = asked ?? draft.prompt?.trim() ?? promptFromUpstream(p, node.id) ?? params.prompt ?? '';

  const take: Take = {
    id: newId('take'),
    nodeId: node.id,
    createdAt: Date.now(),
    status: 'running',
    source: 'comfy',
    kind: takeKindFor(mode),
    params,
    inputs: provenance(p, node.id),
    label: req.label,
  };
  appendTake(p.id, node.id, take);

  const job: JobProgress = {
    jobId: newId('job'),
    projectId: p.id,
    nodeId: node.id,
    takeId: take.id,
    phase: 'submit',
    elapsedMs: 0,
  };
  take.jobId = job.jobId;
  patchTake(p.id, node.id, take.id, { jobId: job.jobId });
  emitProgress(emit, job);

  void execute(p.id, node.id, take.id, job, mode, req, emit);
  return take;
}

/**
 * 抽卡：同一套参数连跑 N 版，种子逐个递进。
 * 选优靠人眼，出量靠这里——每一版都进 take 栈，才有得比。
 */
export function runSweep(req: RunRequest, count: number, emit: Emit): Take[] {
  const n = Math.max(1, Math.min(24, Math.floor(count)));
  const base = typeof req.params?.seed === 'number' ? req.params.seed : Math.floor(Math.random() * 2 ** 31);
  const out: Take[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      runNode({ ...req, params: { ...req.params, seed: base + i }, label: req.label ?? `抽卡 ${i + 1}/${n}` }, emit),
    );
  }
  return out;
}

async function execute(
  projectId: string,
  nodeId: string,
  takeId: string,
  job: JobProgress,
  mode: 'image' | 'video',
  req: RunRequest,
  emit: Emit,
): Promise<void> {
  const t0 = Date.now();
  const tick = (phase: JobProgress['phase'], detail?: string, extra: Partial<JobProgress> = {}) => {
    job = { ...job, phase, detail, elapsedMs: Date.now() - t0, ...extra };
    emitProgress(emit, job);
  };
  try {
    const p = loadProject(projectId);
    const node = nodeOf(p, nodeId);
    const take = node.takes.find((t) => t.id === takeId)!;
    const settings = p.settings;
    const host = mode === 'video' ? settings.comfyHost : settings.imageHost;

    const st = await comfy.status(host);
    if (!st.alive) {
      throw new Error(
        `${mode === 'video' ? '出片' : '生图'}实例 ${host} 没在监听：${st.error ?? ''}`.trim() +
          (mode === 'image' ? '（生图实例平时是关着的，起它，或把 imageHost 指到 8188）' : ''),
      );
    }

    if (mode === 'video' && settings.releaseImageBeforeVideo) {
      const port = Number(new URL(settings.imageHost).port || 8888);
      try {
        const r = releaseImagePort(port);
        tick('submit', r.pid ? `已释放生图实例 ${port}（PID ${r.pid}）让出显存` : `生图实例 ${port} 未占用，无需释放`);
      } catch (err) {
        tick('submit', `释放生图实例失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const params = take.params;
    // 模板取「这次给的 > 上一版继承的 > 项目默认」：换模板只要给 params.workflow
    const templateId =
      (typeof params.workflow === 'string' && params.workflow) ||
      (mode === 'video' ? settings.workflowVideo : settings.workflowImage);
    const { workflow, info } = templates.loadTemplate(settings.workflowDir, templateId);
    let imageName: string | undefined;
    const pick = mode === 'video' ? firstFrameFromUpstream(p, nodeId) : undefined;
    const frame = pick?.frame;
    if (mode === 'video') {
      if (!frame) {
        if (pick?.blockedBy) throw new Error(`首帧「${pick.blockedBy}」还没跑完或没成：接戏接过来的那张尾帧要等它 done 再出片`);
        throw new Error('出片需要上游一张成品图当首帧：把图片节点连到本节点（或先跑图节点）');
      }
      const abs = mediaAbs(projectId, frame.file);
      if (!fs.existsSync(abs)) throw new Error(`首帧文件不在盘上: ${abs}`);
      tick('submit', `上传首帧 ${path.basename(abs)}`);
      imageName = await comfy.uploadImage(host, abs);
      take.inputs = { ...take.inputs, [frame.nodeId]: frame.takeId };
      patchTake(projectId, nodeId, takeId, { inputs: take.inputs });
    }

    // 比例继承：模板宽高由 ResolutionSelector（比例+百万像素）现算时，数值旋钮没有落点，
    // 视频比例就一直是模板写死的那档——首帧是竖图也按 16:9 出，画面被重构图。
    // 优先级跟提示词一样：本次显式给的 > 首帧实际比例 > 上一版继承的。
    // 让继承压住首帧，换张别的比例的图重跑还是老比例，等于没继承。
    let aspectNote = '';
    if (!info.bindings.some((b) => b.role === 'width' || b.role === 'height')) {
      const asked = typeof req.params?.aspect === 'string' ? req.params.aspect : undefined;
      let aspect = asked;
      let from = asked ? '面板指定' : '';
      if (!aspect && frame) {
        const size = frameSize(projectId, frame, settings);
        if (size) {
          aspect = templates.snapAspect(size.width, size.height, info.aspectOptions).aspect;
          from = `首帧 ${size.width}x${size.height}`;
        }
      }
      if (!aspect) {
        // 生图节点没有首帧可跟：下游出片已经定死的档位就是它的准绳，不然出片会把画面重构图
        const down = downstreamAspect(p, nodeId);
        if (down?.usable) {
          const ratio = templates.ratioOfAspect(down.aspect);
          aspect = info.aspectOptions?.includes(down.aspect)
            ? down.aspect
            : ratio
              ? templates.snapAspect(Math.round(ratio * 1000), 1000, info.aspectOptions).aspect
              : undefined;
          if (aspect) from = `下游出片「${down.nodeTitle}」${aspect === down.aspect ? '' : `（${down.aspect} 吸附）`}`;
        }
      }
      if (!aspect && typeof params.aspect === 'string') {
        aspect = params.aspect;
        from = '继承上一版';
      }
      if (aspect) {
        params.aspect = aspect;
        params.aspectFrom = from;
        aspectNote = `比例 ${aspect} ← ${from}`;
      }
    }

    // 默认画幅：项目设置里的 frameSize（默认 720x1280 竖版，短视频平台的通行画幅）。
    // 只对生图生效——出片的宽高由 ResolutionSelector 现算，写数值会被当连线驱动跳过。
    const dflt = mode === 'image' ? templates.parseSize(settings.frameSize) : undefined;
    const applied = templates.bindWorkflow(workflow, info, {
      prompt: String(params.prompt ?? ''),
      negative: typeof params.negative === 'string' ? params.negative : info.negative,
      seed: typeof params.seed === 'number' ? params.seed : undefined,
      width: typeof params.width === 'number' ? params.width : dflt?.width,
      height: typeof params.height === 'number' ? params.height : dflt?.height,
      seconds:
        typeof params.seconds === 'number'
          ? params.seconds
          : mode === 'video'
            ? (settings.videoSeconds ?? DEFAULT_SETTINGS.videoSeconds)
            : undefined,
      steps: typeof params.steps === 'number' ? params.steps : undefined,
      imageName,
      aspect: typeof params.aspect === 'string' ? params.aspect : undefined,
      megapixels: mode === 'video' ? settings.videoMegapixels : undefined,
      prefix: `takeboard/${nodeId}/${takeId}`,
    });
    const overridden = templates.applyOverrides(workflow, req.overrides ?? {});
    tick('submit', [aspectNote, ...applied, ...overridden].filter(Boolean).join(' · ').slice(0, 400) || '工作流已绑定');

    const promptId = await comfy.submit(host, workflow);
    // promptId 必须落盘：H3 一跑就是 4~9 分钟，服务重启不能把这条作业丢了
    patchTake(projectId, nodeId, takeId, { params: { ...params, workflow: templateId }, promptId });
    tick('queue', `已提交 ${promptId.slice(0, 8)}`, { promptId });

    const timeoutMs = typeof params.timeoutS === 'number' ? params.timeoutS * 1000 : mode === 'video' ? 2_400_000 : 1_200_000;
    const record = await comfy.waitForCompletion(host, promptId, {
      timeoutMs,
      intervalMs: mode === 'video' ? 8_000 : 3_000,
      onTick: (q, elapsedMs) => {
        job = { ...job, phase: 'running', elapsedMs, queue: q, promptId, detail: `排队 运行${q.running} 待跑${q.pending}` };
        emitProgress(emit, job);
      },
    });

    if (record.status?.status_str !== 'success') {
      throw new Error(`执行失败: ${comfy.errorDetail(record) || record.status?.status_str}`);
    }
    const file = await finalizeOutputs(projectId, nodeId, takeId, host, mode, record, settings, (phase, detail) =>
      tick(phase, detail),
    );
    tick('done', `完成 ${file} · ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    patchTake(projectId, nodeId, takeId, { status: 'failed', error: message.slice(0, 800), finishedAt: Date.now() });
    job = { ...job, phase: 'failed', error: message.slice(0, 800), elapsedMs: Date.now() - t0 };
    emitProgress(emit, job);
  }
}

/** 画布上的算子节点：拼接 / 截取 / 抽帧 / 尾帧 / 抽音轨 / 配音 / 混音 / 字幕。产物同样进 take 栈。 */
export function runOp(projectId: string, nodeId: string, op: string, params: Record<string, any>, emit: Emit): Take {
  const p = loadProject(projectId);
  const node = nodeOf(p, nodeId);
  const def = opDef(op);
  if (!def) throw new Error(`不认识的算子: ${op}（可用：${OP_IDS.join(' / ')}）`);
  const take: Take = {
    id: newId('take'),
    nodeId,
    createdAt: Date.now(),
    status: 'running',
    source: 'op',
    kind: def.produces,
    params,
    inputs: provenance(p, nodeId),
    op,
  };
  appendTake(projectId, nodeId, take);
  const job: JobProgress = { jobId: newId('job'), projectId, nodeId, takeId: take.id, phase: 'running', elapsedMs: 0 };
  emitProgress(emit, job);

  setTimeout(() => {
    try {
      const fresh = loadProject(projectId);
      const settings = fresh.settings;
      const ff = settings.ffmpeg;
      const num = (v: unknown, d?: number): number | undefined => {
        if (v === undefined || v === null || v === '') return d;
        const n = Number(v);
        return Number.isFinite(n) ? n : d;
      };

      const videos: string[] = [];
      const audios: string[] = [];
      const texts: string[] = [];
      for (const e of inboundEdges(fresh, nodeId)) {
        const t = upstreamTake(fresh, e);
        if (!t || t.status !== 'done') continue;
        if (t.kind === 'video' && t.file) videos.push(mediaAbs(projectId, t.file));
        else if (t.kind === 'audio' && t.file) audios.push(mediaAbs(projectId, t.file));
        if (t.text) texts.push(t.text);
      }
      if (!videos.length && !audios.length && !texts.length) throw new Error('算子节点没有可用输入（上游要有跑完的版本）');
      if (def.takes.includes('video') && !videos.length) throw new Error(`${def.name} 需要一路视频输入`);
      if (def.produces === 'audio' && !audios.length && !videos.length) throw new Error(`${def.name} 需要声音输入`);

      const dir = path.join(mediaDir(projectId), nodeId);
      fs.mkdirSync(dir, { recursive: true });

      /** 声音轨从入边来；params.tracks 给精细控制（助手用），否则所有音频入边按同一组参数铺。 */
      const tracksOf = (defaultVolume: number): AudioTrack[] => {
        if (Array.isArray(params.tracks) && params.tracks.length) {
          const list = (params.tracks as any[])
            .map((t) => ({ file: String(t.file ?? t.path ?? ''), volume: num(t.volume, 1)!, start: num(t.start, 0)!, loop: !!t.loop }))
            .filter((t) => t.file);
          if (list.length) return list;
        }
        const files = [...audios, ...(params.useVideoAudio ? videos : [])];
        if (!files.length) throw new Error('没有可用的声音输入（连一路音频节点，或用 params.tracks 指定文件）');
        return files.map((f) => ({ file: f, volume: num(params.volume, defaultVolume)!, start: num(params.start, 0)!, loop: !!params.loop }));
      };

      let out: string;
      let extra: Partial<Take> = {};

      if (op === 'concat') {
        const target = probe(settings.ffprobe, videos[0]);
        out = path.join(dir, `${take.id}.mp4`);
        concat(ff, videos, out, {
          width: num(params.width) ?? target.width,
          height: num(params.height) ?? target.height,
          fps: num(params.fps) ?? target.fps,
          listFile: path.join(LOGS_DIR, `concat-${take.id}.txt`),
        });
      } else if (op === 'xfade') {
        const target = probe(settings.ffprobe, videos[0]);
        const infos = videos.map((v) => probe(settings.ffprobe, v));
        out = path.join(dir, `${take.id}.mp4`);
        const res = xfadeConcat(ff, videos, out, {
          durations: infos.map((i) => i.duration ?? 0),
          hasAudio: infos.map((i) => !!i.hasAudio),
          duration: num(params.duration, 0.5) ?? 0.5,
          transition: params.transition ? String(params.transition) : 'fade',
          width: num(params.width) ?? target.width,
          height: num(params.height) ?? target.height,
          fps: num(params.fps) ?? target.fps,
          listFile: path.join(LOGS_DIR, `xfade-${take.id}.txt`),
        });
        // 过渡时长被压过、或干脆退回硬切，都得留痕：不然「时长对不上」查半天
        extra = { params: { ...params, transitionUsed: res.used, joints: res.joints } };
      } else if (op === 'trim') {
        out = path.join(dir, `${take.id}.mp4`);
        trim(ff, videos[0], out, num(params.start, 0)!, num(params.duration, 3)!);
      } else if (op === 'poster' || op === 'firstframe') {
        out = path.join(dir, `${take.id}.jpg`);
        frame(ff, videos[0], out, num(params.at, op === 'poster' ? 0.2 : 0)!);
      } else if (op === 'lastframe') {
        out = path.join(dir, `${take.id}.jpg`);
        frame(ff, videos[0], out, 'end');
      } else if (op === 'extractaudio') {
        out = path.join(dir, `${take.id}.m4a`);
        extractAudio(ff, videos[0], out, String(params.bitrate ?? '192k'));
      } else if (op === 'muxaudio') {
        out = path.join(dir, `${take.id}.mp4`);
        muxAudio(ff, videos[0], tracksOf(0.3), out, {
          keepOriginal: params.keepOriginal !== false,
          originalVolume: num(params.originalVolume, 1),
          duration: num(params.duration),
        });
      } else if (op === 'mixaudio') {
        out = path.join(dir, `${take.id}.m4a`);
        mixAudio(ff, tracksOf(1), out, num(params.duration));
      } else if (op === 'subtitle') {
        const text = String(params.text ?? '').trim() || texts.join('\n').trim();
        if (!text) throw new Error('没有字幕文本：算子参数里填 text，或把文本节点连进来');
        const vinfo = probe(settings.ffprobe, videos[0]);
        const cues = splitCues(text, {
          duration: num(params.duration) ?? vinfo.duration,
          cps: num(params.cps, 4.5),
          minSeconds: num(params.minSeconds, 0.8),
        });
        if (!cues.length) throw new Error('字幕文本解析后是空的');
        const srtAbs = path.join(dir, `${take.id}.srt`);
        fs.writeFileSync(srtAbs, srtText(cues), 'utf8');
        out = path.join(dir, `${take.id}.mp4`);
        burnSubtitle(ff, videos[0], out, srtAbs, {
          fontSize: num(params.fontSize, 24),
          alignment: num(params.alignment, 2),
          marginV: num(params.marginV, 28),
          outline: num(params.outline, 2),
          color: params.color ? String(params.color) : undefined,
        });
        extra = { params: { ...params, srtFile: relMedia(projectId, srtAbs), cues: cues.length } };
      } else {
        throw new Error(`算子 ${op} 还没接上实现`);
      }

      const probeInfo = probe(settings.ffprobe, out);
      let poster: string | undefined;
      if (/\.(mp4|webm|mov)$/i.test(out)) {
        const posterAbs = path.join(dir, `${take.id}.jpg`);
        makePoster(ff, out, posterAbs, 0.2);
        poster = relMedia(projectId, posterAbs);
      }
      patchTake(projectId, nodeId, take.id, {
        status: 'done',
        file: relMedia(projectId, out),
        poster,
        probe: probeInfo,
        finishedAt: Date.now(),
        ...extra,
      });
      emitProgress(emit, { ...job, phase: 'done', detail: `${def.name} 完成`, elapsedMs: Date.now() - take.createdAt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patchTake(projectId, nodeId, take.id, { status: 'failed', error: message.slice(0, 800), finishedAt: Date.now() });
      emitProgress(emit, { ...job, phase: 'failed', error: message.slice(0, 800), elapsedMs: Date.now() - take.createdAt });
    }
  }, 0);
  return take;
}

/** 沿链重演：从某节点起，按拓扑序把所有下游的 image/video 节点重跑一遍。 */
export function replay(projectId: string, nodeId: string, emit: Emit): { order: string[]; started: string[] } {
  const p = loadProject(projectId);
  const order: string[] = [];
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of p.edges.filter((x) => x.from === cur)) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      order.push(e.to);
      queue.push(e.to);
    }
  }
  const started: string[] = [];
  for (const id of order) {
    const n: TakeNode | undefined = p.nodes.find((x) => x.id === id);
    if (!n || (n.kind !== 'image' && n.kind !== 'video')) continue;
    runNode({ projectId, nodeId: id }, emit);
    started.push(id);
  }
  return { order, started };
}

/**
 * 重启续跑：H3 一跑 4~9 分钟，服务重启不能把在跑的作业丢成僵尸。
 * 凡是 status=running 的 take：
 *   - 记了 promptId 的 → 接着等产物，等到了就照常入栈
 *   - 没记 promptId 的 → 判失败（作业根本没提交出去，或者提交前就断了）
 */
export async function resumeJobs(emit: Emit): Promise<{ resumed: number; dropped: number }> {
  let resumed = 0;
  let dropped = 0;
  for (const summary of listProjects()) {
    const p = loadProject(summary.id);
    for (const node of p.nodes) {
      for (const take of node.takes) {
        if (take.status !== 'running') continue;
        if (!take.promptId) {
          patchTake(p.id, node.id, take.id, {
            status: 'failed',
            error: '服务重启，作业中断（没有记下 prompt_id，无法接回）',
            finishedAt: Date.now(),
          });
          dropped++;
          continue;
        }
        const mode: 'image' | 'video' = take.kind === 'video' ? 'video' : 'image';
        const host = mode === 'video' ? p.settings.comfyHost : p.settings.imageHost;
        const promptId = take.promptId;
        const job: JobProgress = {
          jobId: take.jobId ?? newId('job'),
          projectId: p.id,
          nodeId: node.id,
          takeId: take.id,
          phase: 'running',
          promptId,
          elapsedMs: Date.now() - take.createdAt,
          detail: '重启续跑：等产物',
        };
        emitProgress(emit, job);
        resumed++;
        void (async () => {
          try {
            const record = await comfy.waitForCompletion(host, promptId, {
              timeoutMs: mode === 'video' ? 2_400_000 : 1_200_000,
              intervalMs: 8_000,
              onTick: (q, elapsedMs) =>
                emitProgress(emit, { ...job, elapsedMs, queue: q, detail: `续跑中 运行${q.running} 待跑${q.pending}` }),
            });
            if (record.status?.status_str !== 'success') {
              throw new Error(`执行失败: ${comfy.errorDetail(record) || record.status?.status_str}`);
            }
            await finalizeOutputs(p.id, node.id, take.id, host, mode, record, p.settings);
            emitProgress(emit, { ...job, phase: 'done', elapsedMs: Date.now() - take.createdAt, detail: '续跑完成' });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            patchTake(p.id, node.id, take.id, { status: 'failed', error: message.slice(0, 800), finishedAt: Date.now() });
            emitProgress(emit, { ...job, phase: 'failed', error: message.slice(0, 800), elapsedMs: Date.now() - take.createdAt });
          }
        })();
      }
    }
  }
  return { resumed, dropped };
}
