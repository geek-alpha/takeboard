import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import type { ProjectSettings } from '../shared/types.ts';

/**
 * 机器级默认项目设置：落 data/defaults.json，新建的项目一出生就带这些值。
 *
 * 分界线跟 machine.json 一样 ——「换项目还要不要重配」。画幅/时长/像素预算/模板/ffmpeg
 * 换了项目也一样，写死在 DEFAULT_SETTINGS 里就等于每建一个项目都要手改一遍设置面板。
 * 这里存的是「本机习惯」，项目自己的 settings 仍然是唯一生效值，随时可以在面板里单独改。
 */

// 不 import store.ROOT：store 要 import 本文件（createProject 继承默认值），反过来引会成环
const ROOT = process.env.TAKEBOARD_ROOT ? path.resolve(process.env.TAKEBOARD_ROOT) : process.cwd();
const FILE = path.join(ROOT, 'data', 'defaults.json');

export function defaultsFilePath(): string {
  return FILE;
}

const str = (v: unknown): string => String(v ?? '').trim();

function num(v: unknown, min: number, max: number, name: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} 不是数字（${String(v)}）`);
  if (n < min || n > max) throw new Error(`${name} 要在 ${min}~${max}（现在 ${n}）`);
  return n;
}

function httpUrl(v: string, name: string): string {
  if (!/^https?:\/\//i.test(v)) throw new Error(`${name} 要带 http:// 或 https://（现在 ${v}）`);
  return v.replace(/\/+$/, '');
}

/**
 * 存盘前逐项校验。这些值是「所有新项目的起点」，写错一个画幅就是后面每个项目都建歪，
 * 所以错必须在这一下报出来，不能等生成时才发现。
 */
function check(next: Partial<ProjectSettings>): Partial<ProjectSettings> {
  const out: Partial<ProjectSettings> = {};
  const comfyHost = str(next.comfyHost);
  if (comfyHost) out.comfyHost = httpUrl(comfyHost, '出片实例地址');
  const imageHost = str(next.imageHost);
  if (imageHost) out.imageHost = httpUrl(imageHost, '生图实例地址');
  for (const k of ['workflowImage', 'workflowVideo', 'workflowDir', 'ffmpeg', 'ffprobe'] as const) {
    if (next[k] === undefined) continue;
    const v = str(next[k]);
    if (!v) throw new Error(`${k} 不能存成空值（要恢复默认就把这一项从 data/defaults.json 里删掉）`);
    out[k] = v;
  }
  if (next.releaseImageBeforeVideo !== undefined) out.releaseImageBeforeVideo = !!next.releaseImageBeforeVideo;

  if (next.frameSize !== undefined) {
    const v = str(next.frameSize);
    // 空 = 跟模板自己的尺寸；给值就得是 宽x高
    if (v && !/^\d{2,5}x\d{2,5}$/.test(v)) throw new Error(`生图默认画幅要写成 宽x高（如 720x1280），现在给的是 ${v}`);
    if (v) out.frameSize = v;
  }
  const seconds = num(next.videoSeconds, 1, 60, '出片默认时长');
  if (seconds !== undefined) out.videoSeconds = seconds;
  const mp = num(next.videoMegapixels, 0.1, 4, '出片像素预算');
  if (mp !== undefined) out.videoMegapixels = mp;

  if (next.transition !== undefined) {
    const t = next.transition;
    if (!t || typeof t !== 'object') throw new Error('过渡设置要是一个对象 {type,duration}');
    const duration = num(t.duration, 0, 10, '过渡时长') ?? 0.5;
    out.transition = { type: str(t.type) || 'fade', duration };
  }
  return out;
}

export function loadDefaults(): Partial<ProjectSettings> {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<ProjectSettings>;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function saveDefaults(next: Partial<ProjectSettings>): Partial<ProjectSettings> {
  // JSON 往返丢 undefined：没填的项不该把磁盘上的旧值抹掉
  const patch = JSON.parse(JSON.stringify(next ?? {})) as Partial<ProjectSettings>;
  const clean = check({ ...loadDefaults(), ...patch });
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

/** 新建项目的 settings：内置默认 + 本机默认。 */
export function projectDefaults(): ProjectSettings {
  return { ...DEFAULT_SETTINGS, ...loadDefaults() };
}
