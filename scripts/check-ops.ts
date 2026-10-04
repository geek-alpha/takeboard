/**
 * 算子层离线自检：不碰 ComfyUI，只用 ffmpeg 现场造素材，把每个算子真跑一遍。
 *
 * 为什么要有它：算子全是 ffmpeg 命令行，参数写错不会在 tsc 阶段暴露，只有真跑才知道。
 * 跑法：npm run check:ops
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { burnSubtitle, extractAudio, frame, mixAudio, muxAudio, probe, splitCues, srtText, xfadeConcat } from '../server/media.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { OPS } from '../shared/ops.ts';

const ff = process.env.TAKEBOARD_FFMPEG ?? DEFAULT_SETTINGS.ffmpeg;
const fp = process.env.TAKEBOARD_FFPROBE ?? DEFAULT_SETTINGS.ffprobe;
const dir = path.join(os.tmpdir(), 'takeboard-check-ops');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✔ ${name}`);
    pass++;
  } catch (e) {
    console.log(`✘ ${name} — ${e instanceof Error ? e.message : String(e)}`);
    fail++;
  }
}
function need(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}
function exists(p: string, minBytes = 1000): boolean {
  return fs.existsSync(p) && fs.statSync(p).size > minBytes;
}

// 素材：3 秒带声音的测试片 + 1 秒的「BGM」
const clip = path.join(dir, 'clip.mp4');
execFileSync(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
const bgm = path.join(dir, 'bgm.m4a');
execFileSync(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220', '-t', '1', '-c:a', 'aac', bgm]);

check('lastframe：尾帧出整帧图', () => {
  const out = path.join(dir, 'last.jpg');
  frame(ff, clip, out, 'end');
  need(exists(out), '尾帧图没生成或太小');
});

check('firstframe：首帧出整帧图', () => {
  const out = path.join(dir, 'first.jpg');
  frame(ff, clip, out, 0);
  need(exists(out), '首帧图没生成');
});

check('extractaudio：抽出的音轨能播（有 duration）', () => {
  const out = path.join(dir, 'audio.m4a');
  extractAudio(ff, clip, out);
  const info = probe(fp, out);
  need(exists(out), '音轨没生成');
  need((info.duration ?? 0) > 2.5, `音轨时长不对：${info.duration}`);
});

check('muxaudio：BGM 混进片子且保留原声，时长不变', () => {
  const out = path.join(dir, 'mux.mp4');
  muxAudio(ff, clip, [{ file: bgm, volume: 0.3, loop: true }], out, { keepOriginal: true });
  const info = probe(fp, out);
  need(info.hasAudio, '成品没有音轨');
  need(Math.abs((info.duration ?? 0) - 3) < 0.6, `时长跑偏：${info.duration}`);
});

check('muxaudio：keepOriginal=false 时只留配上去的声音', () => {
  const out = path.join(dir, 'mux-replace.mp4');
  muxAudio(ff, clip, [{ file: bgm, volume: 1, loop: true }], out, { keepOriginal: false });
  const info = probe(fp, out);
  need(info.hasAudio, '替换后没有音轨');
  need(Math.abs((info.duration ?? 0) - 3) < 0.6, `时长跑偏：${info.duration}`);
});

check('mixaudio：两路音轨混成一条', () => {
  const out = path.join(dir, 'mix.m4a');
  mixAudio(ff, [{ file: bgm, volume: 0.4 }, { file: bgm, volume: 0.6, start: 0.5 }], out, 2);
  const info = probe(fp, out);
  need(exists(out), '混音没生成');
  need(Math.abs((info.duration ?? 0) - 2) < 0.4, `混音时长不对：${info.duration}`);
});

check('subtitle：文本 → srt → 烧进画面', () => {
  const text = '风从山口灌下来，他抬手压住斗篷。\n再往前就是断崖。';
  const cues = splitCues(text, { duration: 3, cps: 4.5 });
  need(cues.length >= 2, `分条数不对：${cues.length}`);
  need(cues[0].start === 0, `第一条没从 0 开始：${cues[0].start}`);
  need(cues[cues.length - 1].end <= 3.05, `最后一条超出片长：${cues[cues.length - 1].end}`);
  const srt = path.join(dir, 'sub.srt');
  fs.writeFileSync(srt, srtText(cues), 'utf8');
  const body = fs.readFileSync(srt, 'utf8');
  need(body.includes('-->') && body.includes('断崖'), 'srt 内容不对');
  const out = path.join(dir, 'sub.mp4');
  burnSubtitle(ff, clip, out, srt, { fontSize: 20, alignment: 2, marginV: 20 });
  const info = probe(fp, out);
  need(info.width === 320 && info.height === 240, `画面规格变了：${info.width}x${info.height}`);
  need(Math.abs((info.duration ?? 0) - 3) < 0.6, `时长跑偏：${info.duration}`);
});

check('xfade：三镜叠化，总时长 = 各镜之和 − 过渡 × 过渡处数', () => {
  const out = path.join(dir, 'xfade3.mp4');
  const d = probe(fp, clip).duration ?? 3;
  const res = xfadeConcat(ff, [clip, clip, clip], out, {
    durations: [d, d, d],
    hasAudio: [true, true, true],
    duration: 0.5,
    transition: 'fade',
    width: 320,
    height: 240,
    fps: 24,
  });
  const info = probe(fp, out);
  need(res.used === 0.5 && res.joints === 2, `过渡没生效：used=${res.used} joints=${res.joints}`);
  const expect = d * 3 - 1;
  need(Math.abs((info.duration ?? 0) - expect) < 0.35, `总时长该是 ${expect.toFixed(2)}，实际 ${info.duration}`);
  need(info.hasAudio, '叠化后丢了音轨');
  need(info.width === 320 && info.height === 240, `画面规格变了：${info.width}x${info.height}`);
});

check('xfade：过渡比片段还长时自动收紧到最短段的一半', () => {
  const short = path.join(dir, 'short.mp4');
  execFileSync(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', short]);
  const out = path.join(dir, 'xfade-short.mp4');
  const res = xfadeConcat(ff, [short, short], out, { durations: [1, 1], hasAudio: [false, false], duration: 2, width: 320, height: 240, fps: 24 });
  need(res.used === 0.5, `该收紧到 0.5，实际 ${res.used}`);
  const info = probe(fp, out);
  need(Math.abs((info.duration ?? 0) - 1.5) < 0.3, `时长该是 1.5，实际 ${info.duration}`);
});

check('xfade：有镜没音轨时用静音补齐，声音不丢', () => {
  const silent = path.join(dir, 'silent.mp4');
  execFileSync(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  const out = path.join(dir, 'xfade-mixed.mp4');
  const d = probe(fp, clip).duration ?? 3;
  xfadeConcat(ff, [clip, silent], out, { durations: [d, 3], hasAudio: [true, false], duration: 0.5, width: 320, height: 240, fps: 24 });
  const info = probe(fp, out);
  need(info.hasAudio, '混合音轨时整条音轨丢了');
  need(Math.abs((info.duration ?? 0) - (d + 3 - 0.5)) < 0.35, `时长跑偏：${info.duration}`);
});

check('算子清单：id 唯一、都有产物类型', () => {
  const ids = OPS.map((o) => o.id);
  need(ids.length >= 10, `算子数偏少：${ids.length}`);
  need(new Set(ids).size === ids.length, '算子 id 有重复');
  for (const o of OPS) {
    need(!!o.produces && !!o.hint && o.takes.length > 0, `${o.id} 缺产物类型/说明/输入声明`);
  }
});

console.log(`\n${pass} 通过 / ${fail} 失败 · 产物在 ${dir}`);
process.exit(fail ? 1 : 0);
