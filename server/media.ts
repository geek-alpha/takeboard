import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Probe } from '../shared/types.ts';

function run(bin: string, args: string[], timeout = 1_800_000): string {
  return execFileSync(bin, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

export function probe(ffprobe: string, file: string): Probe {
  const raw = run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 120_000);
  const data = JSON.parse(raw);
  const video = (data.streams ?? []).find((s: any) => s.codec_type === 'video');
  const audio = (data.streams ?? []).find((s: any) => s.codec_type === 'audio');
  let fps: number | undefined;
  if (video?.r_frame_rate?.includes('/')) {
    const [num, den] = video.r_frame_rate.split('/').map(Number);
    if (den) fps = Math.round((num / den) * 1000) / 1000;
  }
  return {
    duration: data.format?.duration ? Math.round(Number(data.format.duration) * 1000) / 1000 : undefined,
    width: video?.width,
    height: video?.height,
    fps,
    hasAudio: !!audio,
    bytes: data.format?.size ? Number(data.format.size) : fs.statSync(file).size,
  };
}

/** 首帧抽图当海报：画布上视频节点不靠播放也能看。 */
export function makePoster(ffmpeg: string, video: string, out: string, at = 0.2): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  run(ffmpeg, ['-y', '-v', 'error', '-ss', String(at), '-i', video, '-frames:v', '1', '-q:v', '3', out], 120_000);
  return out;
}

export function trim(ffmpeg: string, src: string, out: string, start: number, duration: number): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  run(ffmpeg, [
    '-y', '-v', 'error',
    '-ss', String(start), '-i', src, '-t', String(duration),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    out,
  ]);
  return out;
}

export interface ConcatOptions {
  width?: number;
  height?: number;
  fps?: number;
  listFile: string;
}

/** 拼接：一律重编码，别指望 concat demuxer 直接 copy 能吃下不同来源的片子。 */
export function concat(ffmpeg: string, files: string[], out: string, opts: ConcatOptions): string {
  if (!files.length) throw new Error('拼接需要至少一个输入');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(path.dirname(opts.listFile), { recursive: true });
  fs.writeFileSync(opts.listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  const filters: string[] = [];
  if (opts.width && opts.height) {
    filters.push(`scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease`, `pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2:black`);
  }
  if (opts.fps) filters.push(`fps=${opts.fps}`);
  const args = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', opts.listFile];
  if (filters.length) args.push('-vf', filters.join(','), '-af', 'aresample=async=1:first_pts=0');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', out);
  run(ffmpeg, args);
  return out;
}

export interface XfadeOptions {
  /** 每段输入的时长（秒），顺序与 files 一致 —— offset 靠它递推，给错就会错位 */
  durations: number[];
  hasAudio?: boolean[];
  /** 每处过渡时长（秒） */
  duration?: number;
  transition?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** 退化回硬切时写 concat 的清单文件 */
  listFile?: string;
}

export interface XfadeResult {
  /** 实际用的每处过渡时长；0 表示退回硬切 */
  used: number;
  /** 过渡处数 */
  joints: number;
}

/**
 * 过渡拼接：相邻两镜重叠 duration 秒做 xfade，音轨同步 acrossfade。
 *
 * 跟 concat 的分工：concat 是硬切（demuxer 一把过），这里是逐对叠 —— 所以每段必须先归一化
 * （尺寸/帧率/像素格式/时间基），offset 必须按累计时长递推精确给，给错就是错位或黑帧。
 * 过渡时长会被压到「最短的那对的一半」以内；压到 0.05 以下就退回硬切，并在返回值里说清。
 */
export function xfadeConcat(ffmpeg: string, files: string[], out: string, opts: XfadeOptions): XfadeResult {
  if (!files.length) throw new Error('过渡拼接需要至少一个输入');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const n = files.length;
  const durs = files.map((_, i) => Math.max(0.05, opts.durations[i] ?? 0));

  if (n === 1) {
    transcode(ffmpeg, files[0], out, ['-c:a', 'aac', '-b:a', '192k']);
    return { used: 0, joints: 0 };
  }

  const limit = Math.min(...durs.slice(0, -1).map((d, i) => Math.min(d, durs[i + 1]) * 0.5));
  const want = opts.duration ?? 0.5;
  const T = Math.round(Math.min(want, limit) * 1000) / 1000;
  if (T < 0.05) {
    concat(ffmpeg, files, out, {
      width: opts.width,
      height: opts.height,
      fps: opts.fps,
      listFile: opts.listFile ?? path.join(path.dirname(out), `${path.basename(out, path.extname(out))}-list.txt`),
    });
    return { used: 0, joints: 0 };
  }

  const transition = /^[a-z]+$/.test(opts.transition ?? '') ? opts.transition! : 'fade';
  const hasAudio = opts.hasAudio ?? [];
  const anyAudio = hasAudio.some(Boolean);
  const W = opts.width;
  const H = opts.height;
  const F = opts.fps;

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const norm = ['setpts=PTS-STARTPTS'];
    if (W && H) norm.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`);
    norm.push('setsar=1');
    if (F) norm.push(`fps=${F}`);
    norm.push('format=yuv420p');
    parts.push(`[${i}:v]${norm.join(',')}[v${i}]`);
  }

  const args = ['-y', '-v', 'error'];
  for (const f of files) args.push('-i', f);

  // 没音轨的那几段用静音补上 —— acrossfade 少一路就整条链断掉，宁可用静音也别丢声音
  const audioInput: number[] = [];
  if (anyAudio) {
    let next = n;
    for (let i = 0; i < n; i++) {
      if (hasAudio[i]) {
        audioInput[i] = i;
      } else {
        audioInput[i] = next++;
        args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:d=${durs[i]}`);
      }
    }
    for (let i = 0; i < n; i++) {
      parts.push(`[${audioInput[i]}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
  }

  let vlab = 'v0';
  let alab = 'a0';
  let acc = durs[0];
  for (let k = 1; k < n; k++) {
    const off = Math.round((acc - T) * 1000) / 1000;
    const vout = k === n - 1 ? 'vout' : `vx${k}`;
    parts.push(`[${vlab}][v${k}]xfade=transition=${transition}:duration=${T}:offset=${off}[${vout}]`);
    vlab = vout;
    if (anyAudio) {
      const aout = k === n - 1 ? 'aout' : `ax${k}`;
      parts.push(`[${alab}][a${k}]acrossfade=d=${T}:c1=tri:c2=tri[${aout}]`);
      alab = aout;
    }
    acc = acc + durs[k] - T;
  }

  args.push('-filter_complex', parts.join(';'), '-map', `[${vlab}]`);
  if (anyAudio) args.push('-map', `[${alab}]`);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  if (anyAudio) args.push('-c:a', 'aac', '-b:a', '192k');
  args.push(out);
  run(ffmpeg, args);
  return { used: T, joints: n - 1 };
}

export function transcode(ffmpeg: string, src: string, out: string, extra: string[] = []): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  run(ffmpeg, ['-y', '-v', 'error', '-i', src, ...extra, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out]);
  return out;
}

/**
 * 抽某一时刻的一帧，长边压到 maxEdge 的 jpeg。at 省略就是原图（只对图片有意义）。
 *
 * 模型看图不需要原图：一张 2K 原图 base64 后好几 MB，纯烧 token 和带宽。
 * 视频的「切片」（首帧/尾帧）和评审缩略图都走这里，别再各写一份 ffmpeg 参数。
 */
export function grab(ffmpeg: string, src: string, out: string, at?: number, maxEdge = 640): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ['-y', '-v', 'error'];
  if (at !== undefined) args.push('-ss', String(at));
  args.push(
    '-i', src,
    '-vf', `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`,
    '-frames:v', '1',
    '-q:v', '5',
    out,
  );
  run(ffmpeg, args, 120_000);
  return out;
}

/** 评审用的缩略图：video=true 时先抽 0.3s 那帧。 */
export function thumb(ffmpeg: string, src: string, out: string, maxEdge = 640, video = false): string {
  return grab(ffmpeg, src, out, video ? 0.3 : undefined, maxEdge);
}

/** 抽某一帧存成整帧 jpg（不缩放）。at='end' 取最后一帧 —— 接戏的「尾帧」就走这里。 */
export function frame(ffmpeg: string, src: string, out: string, at: number | 'end' = 'end'): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (at === 'end') {
    // -sseof 从结尾回退取帧；短片回退 0.5s 可能越界，用 duration 兜一层
    let seek = 0.5;
    try {
      const d = probe(ffprobeOf(ffmpeg), src).duration ?? 0;
      if (d > 0) seek = Math.min(0.5, Math.max(0.04, d / 4));
    } catch {
      // 探测失败就按 0.5s 试，抽不出来会抛错，交给上层记进 take.error
    }
    run(ffmpeg, ['-y', '-v', 'error', '-sseof', String(-seek), '-i', src, '-update', '1', '-q:v', '2', out], 300_000);
  } else {
    run(ffmpeg, ['-y', '-v', 'error', '-ss', String(at), '-i', src, '-frames:v', '1', '-q:v', '2', out], 300_000);
  }
  return out;
}

/** 由 ffmpeg 路径推 ffprobe（同一套发行包，换目录时不用改两处配置）。 */
function ffprobeOf(ffmpeg: string): string {
  const probePath = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return fs.existsSync(probePath) ? probePath : ffmpeg;
}

/** 抽音轨。源没有音轨时 ffmpeg 会报错，这正是我们想让人看见的。 */
export function extractAudio(ffmpeg: string, src: string, out: string, bitrate = '192k'): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  run(ffmpeg, ['-y', '-v', 'error', '-i', src, '-vn', '-c:a', 'aac', '-b:a', bitrate, out], 600_000);
  return out;
}

export interface AudioTrack {
  file: string;
  /** 音量倍数，1 = 原样。BGM 一般 0.2~0.3，配音 1 */
  volume?: number;
  /** 第几秒进来 */
  start?: number;
  /** 比片子短时循环铺满（BGM 用） */
  loop?: boolean;
}

function trackFilter(track: AudioTrack, index: number): { parts: string[]; out: string } {
  const label = `a${index}`;
  const parts = [`volume=${track.volume ?? 1}`];
  const delay = Math.max(0, Math.round((track.start ?? 0) * 1000));
  if (delay > 0) parts.push(`adelay=${delay}:all=1`);
  parts.push('aresample=async=1:first_pts=0');
  return { parts, out: label };
}

/** 纯音频混音（配音 + BGM）：不出视频，只出声音轨。 */
export function mixAudio(ffmpeg: string, tracks: AudioTrack[], out: string, duration?: number): string {
  if (!tracks.length) throw new Error('混音需要至少一条音轨');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ['-y', '-v', 'error'];
  for (const t of tracks) {
    if (t.loop) args.push('-stream_loop', '-1');
    args.push('-i', t.file);
  }
  const chains = tracks.map((t, i) => {
    const { parts, out: label } = trackFilter(t, i);
    return `[${i}:a]${parts.join(',')}[${label}]`;
  });
  const inputs = tracks.map((_t, i) => `[a${i}]`).join('');
  chains.push(`${inputs}amix=inputs=${tracks.length}:duration=longest:dropout_transition=0:normalize=0[mix]`);
  // 给了时长就得精确到位：音轨比它短时补静音，否则成品时长看运气
  args.push('-filter_complex', duration ? `${chains.join(';')};[mix]apad[mixed]` : chains.join(';'));
  args.push('-map', duration ? '[mixed]' : '[mix]');
  if (duration) args.push('-t', String(duration));
  args.push('-c:a', 'aac', '-b:a', '192k', out);
  run(ffmpeg, args, 1_200_000);
  return out;
}

export interface MuxAudioOptions {
  /** 保留片子原声一起混（默认 true）；false = 给的声音完全替换原声 */
  keepOriginal?: boolean;
  /** 原声音量倍数（默认 1）—— 想让人声压过环境音就调它 */
  originalVolume?: number;
  /** 成品时长，省略跟随视频 */
  duration?: number;
}

/**
 * 把声音配到片子上：原声 + 配音 + BGM 一起混。
 *
 * 视频流先 copy（快），copy 不成（源封装怪）再重编码一遍 —— 这一步兜底是为了
 * 「给片子加 BGM」这种小操作别因为容器不兼容整条失败。
 */
export function muxAudio(ffmpeg: string, video: string, tracks: AudioTrack[], out: string, opts: MuxAudioOptions = {}): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const keep = opts.keepOriginal !== false;
  const info = probe(ffprobeOf(ffmpeg), video);
  const dur = opts.duration ?? info.duration;

  const build = (copyVideo: boolean): string[] => {
    const args = ['-y', '-v', 'error', '-i', video];
    for (const t of tracks) {
      if (t.loop) args.push('-stream_loop', '-1');
      args.push('-i', t.file);
    }
    const chains: string[] = [];
    const labels: string[] = [];
    if (keep && info.hasAudio) {
      chains.push(`[0:a]volume=${opts.originalVolume ?? 1},aresample=async=1:first_pts=0[a0]`);
      labels.push('[a0]');
    }
    tracks.forEach((t, i) => {
      const { parts, out: label } = trackFilter(t, i + 1);
      chains.push(`[${i + 1}:a]${parts.join(',')}[${label}]`);
      labels.push(`[${label}]`);
    });
    if (!labels.length) throw new Error('这条片子没有音轨，也没有给要配的声音');
    if (labels.length === 1) {
      chains.push(`${labels[0]}anull[aout]`);
    } else {
      chains.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[aout]`);
    }
    args.push('-filter_complex', chains.join(';'), '-map', '0:v', '-map', '[aout]');
    args.push(...(copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']));
    args.push('-c:a', 'aac', '-b:a', '192k');
    if (dur) args.push('-t', String(dur));
    else args.push('-shortest');
    args.push(out);
    return args;
  };

  try {
    run(ffmpeg, build(true), 1_800_000);
  } catch {
    run(ffmpeg, build(false), 1_800_000);
  }
  return out;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

function stamp(sec: number): string {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

export function srtText(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text.trim()}\n`)
    .join('\n');
}

export interface SplitOptions {
  /** 成片总长（秒）：给了就把整段话均摊进去 */
  duration?: number;
  start?: number;
  /** 每秒读几个字，中文口播 4~5 比较自然 */
  cps?: number;
  /** 一行最多几个字，超了按标点断 */
  maxChars?: number;
  /** 每条最少停留秒数，太短的闪一下就没了 */
  minSeconds?: number;
}

/**
 * 一整段文字 → 带时间轴的字幕条。
 *
 * 没有 ASR 时这是最省事的路子：按标点断句、按语速估时间。给了 duration 就均摊，
 * 否则按 cps 顺排（后者用来给配音配字幕，长度基本对得上）。
 */
export function splitCues(text: string, opts: SplitOptions = {}): Cue[] {
  const cps = opts.cps ?? 4.5;
  const maxChars = opts.maxChars ?? 18;
  const minSeconds = opts.minSeconds ?? 0.6;
  const start = opts.start ?? 0;

  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let buf = '';
    for (const ch of line) {
      buf += ch;
      if (/[。！？；…!?;]/.test(ch) || buf.length >= maxChars) {
        lines.push(buf.trim());
        buf = '';
      }
    }
    if (buf.trim()) lines.push(buf.trim());
  }
  if (!lines.length) return [];

  const weights = lines.map((l) => Math.max(1, l.length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const total = opts.duration ?? weights.reduce((a, w) => a + Math.max(minSeconds, w / cps), 0);

  let cursor = start;
  return lines.map((l, i) => {
    const span = Math.max(minSeconds, (weights[i] / totalWeight) * total);
    const cue = { start: cursor, end: cursor + span, text: l };
    cursor += span;
    return cue;
  });
}

export interface SubtitleStyle {
  fontName?: string;
  fontSize?: number;
  /** 1=左下 2=中下 3=右下 5=中上 7=左上 8=中上 9=右上 */
  alignment?: number;
  marginV?: number;
  outline?: number;
  /** 主色，ASS 的 &HBBGGRR 或 #RRGGBB 都行 */
  color?: string;
  bold?: boolean;
}

function assColor(input: string): string {
  if (input.startsWith('&H')) return input;
  const m = /^#?([0-9a-f]{6})$/i.exec(input);
  if (!m) return '&HFFFFFF';
  const [r, g, b] = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)];
  return `&H${b}${g}${r}`.toUpperCase();
}

/** ffmpeg filter 里的路径：Windows 反斜杠要换正斜杠、盘符冒号要转义。 */
function filterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function styleString(style: SubtitleStyle = {}): string {
  const bits = [
    `FontName=${style.fontName ?? 'Microsoft YaHei'}`,
    `FontSize=${style.fontSize ?? 24}`,
    `PrimaryColour=${assColor(style.color ?? '#FFFFFF')}`,
    `OutlineColour=&H00000000`,
    `BorderStyle=1`,
    `Outline=${style.outline ?? 2}`,
    `Shadow=1`,
    `Alignment=${style.alignment ?? 2}`,
    `MarginV=${style.marginV ?? 28}`,
    `Bold=${style.bold === false ? 0 : -1}`,
  ];
  return bits.join(',');
}

/**
 * 把字幕烧进画面（硬字幕）。顺带把 srt 旁挂出来，方便以后改样式重烧或换软字幕。
 */
export function burnSubtitle(ffmpeg: string, video: string, out: string, srtFile: string, style: SubtitleStyle = {}): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const vf = `subtitles='${filterPath(srtFile)}':force_style='${styleString(style)}'`;
  run(
    ffmpeg,
    [
      '-y', '-v', 'error',
      '-i', video,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      out,
    ],
    1_800_000,
  );
  return out;
}
