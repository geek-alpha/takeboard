import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/types.ts';

/**
 * 工作流模板的「旋钮发现」。
 * 不写死节点号——模板改一次节点号就全变（hero_batch.py 里那条教训），
 * 一律按 class_type + 连线结构找。
 */

export interface TemplateBinding {
  nodeId: string;
  class: string;
  field: string;
  role: 'prompt' | 'negative' | 'width' | 'height' | 'seed' | 'steps' | 'seconds' | 'image' | 'prefix' | 'fps' | 'aspect';
}

export interface TemplateInfo {
  id: string;
  file: string;
  title: string;
  description: string;
  host?: string;
  promptPrefix?: string;
  negative?: string;
  size?: string;
  /** ResolutionSelector 的档位名；模板 meta 里的 aspect_ratios 可覆盖内置表 */
  aspectOptions?: string[];
  steps?: number;
  default?: boolean;
  nodeCount: number;
  bindings: TemplateBinding[];
}

type Wf = Record<string, any>;

const entries = (wf: Wf): Array<[string, any]> =>
  Object.entries(wf).filter(([, n]) => n && typeof n === 'object' && n.class_type);

function isRef(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';
}

/**
 * 这个字段能不能直接写？
 * 模板里很多字段是连线引用（H3 的 131.width 实际是 ["115",0]）——
 * 往引用上写数字等于把工作流写坏，必须回溯到源节点的数值输入。
 * 推不回去（多输出的自定义节点）就宁可不给旋钮。
 */
function settableTarget(wf: Wf, nodeId: string, field: string): { nodeId: string; field: string } | null {
  const node = wf[nodeId];
  if (!node) return null;
  const value = node.inputs?.[field];
  if (value === undefined) return null;
  if (!isRef(value)) return { nodeId, field };
  const src = wf[value[0]];
  if (!src) return null;
  for (const cand of ['value', field]) {
    if (typeof src.inputs?.[cand] === 'number') return { nodeId: value[0], field: cand };
  }
  return null;
}

/**
 * ResolutionSelector 这类节点：宽高是「比例 + 百万像素」现算出来的，没有数值字段可写。
 * 硬推 width/height 只会落空——H3 的视频比例就这么一直跟模板写死的那档，跟首帧无关。
 * 档位表实测自 8188 的 object_info。
 */
const ASPECT_PRESETS: string[] = [
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
];

/** 档位名 → 比例。「下游定的档位能不能落在这个模板的档位表上」全靠它。 */
export function ratioOfAspect(name: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:xX×]\s*(\d+(?:\.\d+)?)/.exec(name);
  if (!m) return 0;
  const h = Number(m[2]);
  return h > 0 ? Number(m[1]) / h : 0;
}

/** 图片实际像素 → 最接近的档位名。按对数距离比：比例是乘性的，1.78 与 1.6 的差距该和 0.56 与 0.625 对称。 */
export function snapAspect(width: number, height: number, options?: string[]): { aspect: string; ratio: number } {
  const target = width / height;
  const pick = (names: string[]) => {
    let best: { name: string; ratio: number } | undefined;
    for (const name of names) {
      const ratio = ratioOfAspect(name);
      if (!ratio) continue;
      if (!best || Math.abs(Math.log(ratio / target)) < Math.abs(Math.log(best.ratio / target))) best = { name, ratio };
    }
    return best;
  };
  const best = pick(options?.length ? options : ASPECT_PRESETS) ?? pick(ASPECT_PRESETS);
  return best ? { aspect: best.name, ratio: best.ratio } : { aspect: '', ratio: target };
}

/** '720x1280' → {width,height}。认不出就返回 undefined——脏值当尺寸写进工作流会直接跑挂 */
export function parseSize(v: unknown): { width: number; height: number } | undefined {
  const m = /^\s*(\d{2,5})\s*[x*×]\s*(\d{2,5})\s*$/i.exec(String(v ?? ''));
  if (!m) return undefined;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** 尺寸 → 约分后的比例如 '9:16'（给模型看的人话，不是档位名） */
export function ratioLabel(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(Math.round(w), Math.round(h)) || 1;
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}

/**
 * 画幅 → 比例如 '9:16'。
 * 写词时告诉模型的画幅必须跟实际出片一致：模板写死 16:9 而项目是竖版 720x1280，
 * 模型会按横版规划构图，出片被重构图。size 省略就用项目默认画幅。
 */
export function frameRatio(size?: string): string {
  const s = parseSize(size) ?? parseSize(DEFAULT_SETTINGS.frameSize);
  return s ? ratioLabel(s.width, s.height) : '9:16';
}

export function discoverBindings(wf: Wf): TemplateBinding[] {
  const out: TemplateBinding[] = [];
  const push = (nodeId: string, cls: string, field: string, role: TemplateBinding['role']) => {
    if (!out.some((b) => b.nodeId === nodeId && b.field === field)) out.push({ nodeId, class: cls, field, role });
  };

  // 采样器 → 顺着 positive/negative 连线回溯到文本编码节点，比按标题猜准
  const sampler = entries(wf).find(([, n]) => /KSampler|SamplerCustom/.test(String(n.class_type)));
  if (sampler) {
    const [sid, snode] = sampler;
    for (const [role, key] of [['prompt', 'positive'], ['negative', 'negative']] as const) {
      const ref = snode.inputs?.[key];
      if (isRef(ref)) {
        const target = wf[ref[0]];
        const field = target?.inputs?.text !== undefined ? 'text' : target?.inputs?.prompt !== undefined ? 'prompt' : null;
        if (target && field) push(ref[0], String(target.class_type), field, role);
      }
    }
    if (snode.inputs?.seed !== undefined) push(sid, String(snode.class_type), 'seed', 'seed');
    if (snode.inputs?.steps !== undefined) push(sid, String(snode.class_type), 'steps', 'steps');
    if (isRef(snode.inputs?.noise)) {
      const noise = wf[snode.inputs.noise[0]];
      if (noise?.inputs?.noise_seed !== undefined) push(snode.inputs.noise[0], String(noise.class_type), 'noise_seed', 'seed');
    }
  }

  for (const [id, n] of entries(wf)) {
    const cls = String(n.class_type);
    const inp = n.inputs ?? {};
    if (typeof inp.prompt === 'string') push(id, cls, 'prompt', 'prompt');
    if (typeof inp.text === 'string' && !out.some((b) => b.nodeId === id)) {
      // 没被采样器连线指到的文本节点：生图模板里通常是负向
      push(id, cls, 'text', out.some((b) => b.role === 'prompt') ? 'negative' : 'prompt');
    }
    for (const [field, roleName] of [['width', 'width'], ['height', 'height'], ['fps', 'fps']] as const) {
      const target = settableTarget(wf, id, field);
      if (target) push(target.nodeId, String(wf[target.nodeId].class_type), target.field, roleName);
    }
    if (typeof inp.aspect_ratio === 'string') push(id, cls, 'aspect_ratio', 'aspect');
    if (inp.image !== undefined && /LoadImage/.test(cls)) push(id, cls, 'image', 'image');
    if (inp.filename_prefix !== undefined && /Save/.test(cls)) push(id, cls, 'filename_prefix', 'prefix');
    if (inp.noise_seed !== undefined) push(id, cls, 'noise_seed', 'seed');
    if (inp.seed !== undefined && !out.some((b) => b.nodeId === id && b.field === 'seed')) push(id, cls, 'seed', 'seed');
  }

  // 秒数：H3 模板用一个独立 PrimitiveFloat 节点喂 length
  const primitive = entries(wf).find(([, n]) => /PrimitiveFloat|PrimitiveInt/.test(String(n.class_type)) && typeof n.inputs?.value === 'number');
  if (primitive) push(primitive[0], String(primitive[1].class_type), 'value', 'seconds');
  return out;
}

function readMeta(file: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(`${file.replace(/\.json$/, '')}.meta.json`, 'utf8'));
  } catch {
    return {};
  }
}

export function listTemplates(dir: string): TemplateInfo[] {
  if (!fs.existsSync(dir)) return [];
  const out: TemplateInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.meta.json')) continue;
    const file = path.join(dir, name);
    try {
      const wf = JSON.parse(fs.readFileSync(file, 'utf8')) as Wf;
      const meta = readMeta(file);
      out.push({
        id: name.replace(/\.json$/, ''),
        file,
        title: meta.title ?? name,
        description: meta.description ?? '',
        host: meta.host,
        promptPrefix: meta.prompt_prefix,
        negative: meta.negative,
        size: meta.size,
        aspectOptions: Array.isArray(meta.aspect_ratios) ? meta.aspect_ratios : ASPECT_PRESETS,
        steps: meta.steps,
        default: !!meta.default,
        nodeCount: entries(wf).length,
        bindings: discoverBindings(wf),
      });
    } catch {
      // 坏模板不进清单，免得画布上点一下炸一次
    }
  }
  return out.sort((a, b) => Number(!!b.default) - Number(!!a.default));
}

export function loadTemplate(dir: string, id: string): { workflow: Wf; info: TemplateInfo } {
  const info = listTemplates(dir).find((t) => t.id === id);
  if (!info) throw new Error(`模板不存在: ${id}（目录 ${dir}）`);
  return { workflow: JSON.parse(fs.readFileSync(info.file, 'utf8')) as Wf, info };
}

export interface BindRequest {
  prompt?: string;
  negative?: string;
  seed?: number;
  width?: number;
  height?: number;
  seconds?: number;
  steps?: number;
  imageName?: string;
  prefix?: string;
  /** 比例档位名（ResolutionSelector 的 aspect_ratio）——宽高没有数值落点时的唯一抓手 */
  aspect?: string;
  /** ResolutionSelector 的像素预算（百万像素）。想提画质就抬它，代价是显存 */
  megapixels?: number;
}

/** 把请求里的值按 role 落到真实节点字段上，返回人话说明（画布上要展示改了什么）。 */
export function bindWorkflow(workflow: Wf, info: TemplateInfo, req: BindRequest): string[] {
  const applied: string[] = [];
  const role = (r: TemplateBinding['role']) => info.bindings.filter((b) => b.role === r);

  const set = (b: TemplateBinding, value: unknown, note: string) => {
    const node = workflow[b.nodeId];
    if (!node) return;
    node.inputs = node.inputs ?? {};
    if (Array.isArray(node.inputs[b.field]) && b.field !== 'image_paths') {
      applied.push(`⚠ ${note} 跳过：节点${b.nodeId}.${b.field} 被连线驱动，写进去会写坏工作流`);
      return;
    }
    node.inputs[b.field] = value;
    applied.push(`${note} → 节点${b.nodeId}(${b.class}).${b.field}`);
  };

  if (req.prompt !== undefined) {
    const text = info.promptPrefix && !req.prompt.startsWith(info.promptPrefix) ? `${info.promptPrefix}${req.prompt}` : req.prompt;
    for (const b of role('prompt')) set(b, text, '正向提示词');
  }
  if (req.negative !== undefined) {
    for (const b of role('negative')) set(b, req.negative, '负向提示词');
  }
  if (req.width !== undefined) for (const b of role('width')) set(b, req.width, '宽');
  if (req.height !== undefined) for (const b of role('height')) set(b, req.height, '高');
  if (req.steps !== undefined) for (const b of role('steps')) set(b, req.steps, '步数');
  if (req.seed !== undefined) for (const b of role('seed')) set(b, req.seed, '种子');
  if (req.aspect !== undefined) for (const b of role('aspect')) set(b, req.aspect, '宽高比');
  if (req.imageName !== undefined) for (const b of role('image')) set(b, req.imageName, '首帧');
  if (req.megapixels !== undefined) {
    // 像素预算没有「绑定」可言：ResolutionSelector 只暴露档位名，宽高是它自己算的
    for (const [id, node] of entries(workflow)) {
      if (!/ResolutionSelector/.test(String(node.class_type))) continue;
      node.inputs = node.inputs ?? {};
      node.inputs.megapixels = req.megapixels;
      applied.push(`像素预算 → 节点${id}(${node.class_type}).megapixels=${req.megapixels}`);
    }
  }
  if (req.prefix !== undefined) for (const b of role('prefix')) set(b, req.prefix, '产物前缀');
  if (req.seconds !== undefined) {
    for (const b of role('seconds')) set(b, req.seconds, '时长(秒)');
    // 有的模板把 length 写成字面量，那就得自己算帧数
    const fps = info.bindings.find((b) => b.role === 'fps');
    const fpsValue = fps ? Number(workflow[fps.nodeId]?.inputs?.fps) || 24 : 24;
    for (const [id, node] of entries(workflow)) {
      if (typeof node.inputs?.length === 'number') {
        node.inputs.length = Math.round(req.seconds * fpsValue);
        applied.push(`帧数 → 节点${id}(${node.class_type}).length=${node.inputs.length}`);
      }
    }
  }
  return applied;
}

/** --set 等价物：overrides 形如 { "131.inputs.prompt": "..." }，走点路径。 */
export function applyOverrides(workflow: Wf, overrides: Record<string, unknown>): string[] {
  const applied: string[] = [];
  for (const [dotted, raw] of Object.entries(overrides ?? {})) {
    const parts = dotted.split('.');
    let cursor: any = workflow;
    let ok = true;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor = cursor?.[parts[i]];
      if (cursor === undefined || cursor === null) {
        ok = false;
        break;
      }
    }
    const leaf = parts[parts.length - 1];
    if (!ok || cursor[leaf] === undefined) {
      applied.push(`⚠ 覆盖未命中: ${dotted}`);
      continue;
    }
    cursor[leaf] = raw;
    applied.push(`覆盖 ${dotted} = ${JSON.stringify(raw).slice(0, 60)}`);
  }
  return applied;
}
