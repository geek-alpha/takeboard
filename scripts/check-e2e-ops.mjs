/**
 * 端到端算子检查：对着正在跑的服务真建项目、真跑算子、真查预览序列。
 *
 * 跟 check:ops 的分工：check:ops 只验 ffmpeg 那层（不碰服务），这里验「入边怎么解、产物怎么进 take 栈、
 * 序列怎么排、出成片有没有把成片自己拼进去」。前置：服务已在 4317（scripts/restart.ps1）。
 *
 * 跑法：npm run check:e2e
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.TAKEBOARD_BASE ?? 'http://127.0.0.1:4317';
const FF = process.env.TAKEBOARD_FFMPEG ?? 'D:\\AI\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffmpeg.exe';
const dir = path.join(os.tmpdir(), 'takeboard-e2e');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) pass++;
  else fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(res) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then(j);
const get = (p) => fetch(BASE + p).then(j);
const P = (id) => `/api/projects/${encodeURIComponent(id)}`;

async function waitTake(projectId, nodeId, takeId, ms = 90000) {
  const t0 = Date.now();
  for (;;) {
    const p = await get(P(projectId));
    const t = p.nodes.find((n) => n.id === nodeId)?.takes.find((x) => x.id === takeId);
    if (t && t.status !== 'running') return t;
    if (Date.now() - t0 > ms) throw new Error(`等 take 超时（${takeId}）`);
    await sleep(500);
  }
}

// 素材：3 秒带声音的测试片 + 1 秒 BGM
const clip = path.join(dir, 'clip.mp4');
execFileSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
const bgm = path.join(dir, 'bgm.m4a');
execFileSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220', '-t', '1', '-c:a', 'aac', bgm]);

const health = await get('/api/health');
if (!health?.root) {
  console.log(`✘ 服务没起来（${BASE}）：先跑 scripts/restart.ps1`);
  process.exit(1);
}

const proj = await post('/api/projects', { name: `算子验证-${Date.now() % 10000}` });
if (!proj?.id) {
  console.log(`✘ 建项目失败：${JSON.stringify(proj)}`);
  process.exit(1);
}
console.log(`项目：${proj.name} (${proj.id})\n`);

async function addMedia(kind, title, file) {
  const node = await post(`${P(proj.id)}/nodes`, { kind, title });
  await post(`${P(proj.id)}/nodes/${node.id}/takes`, { path: file });
  return node;
}
const opNode = (title) => post(`${P(proj.id)}/nodes`, { kind: 'op', title });
const link = (from, to) => post(`${P(proj.id)}/edges`, { from, to });
const runOp = async (nodeId, op, params) => {
  const t = await post(`${P(proj.id)}/ops`, { nodeId, op, params });
  if (!t?.id) throw new Error(`算子没返回 take：${JSON.stringify(t)}`);
  return waitTake(proj.id, nodeId, t.id);
};

const shotA = await addMedia('video', '镜头A', clip);
const shotB = await addMedia('video', '镜头B', clip);
const bgmNode = await addMedia('audio', 'BGM', bgm);

// 1. 尾帧
try {
  const node = await opNode('尾帧');
  await link(shotA.id, node.id);
  const t = await runOp(node.id, 'lastframe', {});
  check('lastframe：尾帧落成图片 take', t.status === 'done' && t.kind === 'image' && /\.jpg$/.test(t.file ?? ''), `${t.status} ${t.file ?? t.error}`);
} catch (e) {
  check('lastframe：尾帧落成图片 take', false, String(e));
}

// 2. 字幕（文本走参数）
try {
  const node = await opNode('字幕');
  await link(shotA.id, node.id);
  const t = await runOp(node.id, 'subtitle', { text: '风从山口灌下来，他抬手压住斗篷。\n再往前就是断崖。', fontSize: 20 });
  check('subtitle：烧字幕出片 + 旁挂 srt', t.status === 'done' && t.params?.srtFile && Number(t.params?.cues) >= 2, `${t.status} cues=${t.params?.cues} srt=${t.params?.srtFile ?? t.error}`);
} catch (e) {
  check('subtitle：烧字幕出片 + 旁挂 srt', false, String(e));
}

// 3. 配音 / BGM（视频 + 音频两路入边）
try {
  const node = await opNode('配音');
  await link(shotA.id, node.id);
  await link(bgmNode.id, node.id);
  const t = await runOp(node.id, 'muxaudio', { volume: 0.3, loop: true, keepOriginal: true });
  check('muxaudio：原声 + BGM 混进片子', t.status === 'done' && t.probe?.hasAudio === true, `${t.status} hasAudio=${t.probe?.hasAudio}`);
} catch (e) {
  check('muxaudio：原声 + BGM 混进片子', false, String(e));
}

// 4. 预览序列：只收镜头，不算算子产物
const seq1 = await get(`${P(proj.id)}/sequence`);
check(
  'sequence：排到两镜、时长 6s 左右、不含算子产物',
  seq1.shots.length === 2 && Math.abs(seq1.totalSeconds - 6) < 0.8,
  `${seq1.shots.length} 镜 / ${seq1.totalSeconds}s · ${seq1.shots.map((s) => s.title).join('→')}`,
);

// 5. 出成片
let filmNodeId = null;
try {
  const out = await post(`${P(proj.id)}/export`, {});
  const t = await waitTake(proj.id, out.node.id, out.take.id);
  filmNodeId = out.node.id;
  check('export：建「成片」节点并拼成一条', t.status === 'done' && Math.abs((t.probe?.duration ?? 0) - 6) < 0.8, `${t.status} ${t.probe?.duration ?? t.error}s`);
} catch (e) {
  check('export：建「成片」节点并拼成一条', false, String(e));
}

// 6. 导出之后再查序列：不该把成片自己也当成镜头
const seq2 = await get(`${P(proj.id)}/sequence`);
check('sequence：出成片后序列仍是两镜（没自己套自己）', seq2.shots.length === 2, `${seq2.shots.length} 镜 · ${seq2.shots.map((s) => s.title).join('→')}`);

// 7. 以成片为终点看序列：这时才把它算进来
if (filmNodeId) {
  const seq3 = await get(`${P(proj.id)}/sequence?end=${encodeURIComponent(filmNodeId)}`);
  check('sequence?end=成片：终点上游 3 镜', seq3.shots.length === 3, `${seq3.shots.length} 镜 · ${seq3.shots.map((s) => s.title).join('→')}`);
}

// 8. 接戏：本镜尾帧 → 下一镜首帧（真建节点、真连线、真抽帧）
let handoff = null;
let tailTake = null;
try {
  handoff = await post(`${P(proj.id)}/handoff`, { from: shotA.id });
  tailTake = await waitTake(proj.id, handoff.frameNode.id, handoff.frameTake.id);
  check(
    'handoff：本镜尾帧接下一镜，尾帧落成图',
    handoff.to.nodeId === shotB.id && tailTake.status === 'done' && tailTake.kind === 'image',
    `${handoff.from.title}v${handoff.from.index}→${handoff.to.title} · ${tailTake.status} ${tailTake.file ?? tailTake.error}`,
  );
  const p2 = await get(P(proj.id));
  const edge = p2.edges.find((e) => e.to === shotB.id && e.role === 'firstframe');
  check('handoff：连线标了 firstframe（出片只认它）', !!edge && edge.from === handoff.frameNode.id, edge ? `${edge.from}→${edge.to}` : '没找到显式首帧边');
  const ff = await get(`${P(proj.id)}/firstframe?nodeId=${shotB.id}`);
  check('firstframe：下一镜的首帧就是这张尾帧', ff.frame?.nodeId === handoff.frameNode.id && ff.frame?.takeId === tailTake.id, JSON.stringify(ff));
} catch (e) {
  check('handoff：本镜尾帧接下一镜，尾帧落成图', false, String(e));
}

// 9. 显式接的首帧优先：另外再连一张图进来也抢不走它
if (handoff && tailTake?.status === 'done') {
  try {
    const decoy = await opNode('别的图');
    await link(shotA.id, decoy.id);
    const decoyTake = await runOp(decoy.id, 'poster', { at: 0.5 });
    await link(decoy.id, shotB.id);
    const ff2 = await get(`${P(proj.id)}/firstframe?nodeId=${shotB.id}`);
    check(
      'firstframe：后接的普通图抢不走显式接的首帧',
      ff2.frame?.nodeId === handoff.frameNode.id,
      `图 ${decoyTake.status} · 首帧仍是 ${ff2.frame?.nodeId === handoff.frameNode.id ? '尾帧' : ff2.frame?.nodeId ?? ff2.blockedBy}`,
    );
  } catch (e) {
    check('firstframe：后接的普通图抢不走显式接的首帧', false, String(e));
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败 · 项目留在 ${proj.name}（画布上能看见这些算子节点）`);
process.exit(fail ? 1 : 0);
