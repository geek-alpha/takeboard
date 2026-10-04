import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 实例启停的离线自检：配方读写、字段校验、拒绝自杀、没进程时的报告。
 * 不真起 ComfyUI —— 起服务要几十秒加一块显卡，那是端到端验证的活，
 * 不该压在每次提交都跑的脚本里。
 */
const ROOT = path.join(os.tmpdir(), `takeboard-check-machine-${process.pid}`);
process.env.TAKEBOARD_ROOT = ROOT;
fs.mkdirSync(path.join(ROOT, 'projects'), { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name: string, extra = '') => {
  pass++;
  console.log(`  ✔ ${name}${extra ? ` · ${extra}` : ''}`);
};
const bad = (name: string, why: string) => {
  fail++;
  console.log(`  ✘ ${name} · ${why}`);
};
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(name, String(got));
  else bad(name, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
};
const has = (name: string, got: string, needle: string) => {
  if (String(got).includes(needle)) ok(name, needle);
  else bad(name, `「${String(got).slice(0, 70)}」里没有「${needle}」`);
};
async function throws(name: string, fn: () => unknown, needle: string) {
  try {
    await fn();
    bad(name, '没抛错');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(needle)) ok(name, msg.slice(0, 60));
    else bad(name, `抛的是「${msg}」，要的是含「${needle}」`);
  }
}

const recipe = (over: Record<string, unknown>) => ({
  id: 'a',
  label: 'a',
  host: 'http://127.0.0.1:8888',
  cwd: ROOT,
  command: '"x" main.py --port 8888',
  bootSeconds: 60,
  enabled: true,
  ...over,
});

async function main() {
  const m = await import('../server/machine.ts');
  const gpu = await import('../server/gpu.ts');

  // ── 1. 默认配方 ─────────────────────────────────────────────────────
  const def = m.loadMachine();
  eq('默认配方：两个实例', def.instances.length, 2);
  eq('默认配方：生图端口', m.portOf(def.instances[0]), 8888);
  eq('默认配方：出片端口', m.portOf(def.instances[1]), 8188);
  has('默认配方：生图目录是 drawing', def.instances[0].cwd, 'ComfyUI_drawing');
  has('默认配方：出片目录是 ComfyUI', def.instances[1].cwd, 'ComfyUI');
  has('默认配方：命令里带端口', def.instances[0].command, '--port 8888');

  // ── 2. 存盘前校验 ───────────────────────────────────────────────────
  await throws('校验：host 没带端口', () => m.saveMachine({ instances: [recipe({ host: 'http://127.0.0.1' })] }), 'host 要带端口');
  await throws('校验：命令端口跟 host 不符', () => m.saveMachine({ instances: [recipe({ command: '"x" main.py --port 9999' })] }), '对不上');
  await throws('校验：工作目录不存在', () => m.saveMachine({ instances: [recipe({ cwd: 'D:\\__没有这个目录__' })] }), '工作目录不存在');
  await throws('校验：空清单', () => m.saveMachine({ instances: [] }), '至少要留一个实例');
  await throws(
    '校验：不许占 Takeboard 自己的端口',
    () => m.saveMachine({ instances: [recipe({ host: `http://127.0.0.1:${gpu.SELF_PORT}`, command: `"x" main.py --port ${gpu.SELF_PORT}` })] }),
    'Takeboard 自己的端口',
  );

  // ── 3. 存了能读回 ───────────────────────────────────────────────────
  const saved = m.saveMachine({
    instances: [recipe({ id: 'probe', label: '探针', host: 'http://127.0.0.1:45999', command: '"x" main.py --port 45999', bootSeconds: 20 })],
  });
  eq('存盘：读回 id', m.loadMachine().instances.map((i) => i.id), ['probe']);
  eq('存盘：读回端口', m.portOf(m.loadMachine().instances[0]), 45999);
  eq('存盘：bootSeconds 夹到上限', m.saveMachine({ instances: [{ ...saved.instances[0], bootSeconds: 99999 }] }).instances[0].bootSeconds, 900);
  eq('存盘：bootSeconds 夹到下限', m.saveMachine({ instances: [{ ...saved.instances[0], bootSeconds: 1 }] }).instances[0].bootSeconds, 15);

  // ── 4. 没进程时的状态与关闭 ─────────────────────────────────────────
  const st = await m.machineStatus();
  eq('状态：没监听就是离线', st[0].listening, false);
  eq('状态：没监听不报 pid', st[0].pid, null);
  eq('状态：没监听也不去 ping（不报 alive）', st[0].alive, false);

  const stop = m.stopInstance('probe');
  eq('关：没进程也算关成功', stop.ok, true);
  eq('关：没进程不报 pid', stop.pid, null);
  has('关：说清不用关', stop.detail, '没有监听进程');

  // ── 5. 起不来的路径：目录被删了就别 spawn ───────────────────────────
  // 手写 machine.json 绕过存盘校验，模拟「配方是旧的、目录后来没了」
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, 'data', 'machine.json'),
    JSON.stringify({ instances: [recipe({ id: 'ghost', label: '幽灵', host: 'http://127.0.0.1:45998', command: '"x" main.py --port 45998', cwd: 'D:\\__没有这个目录__' })] }),
    'utf8',
  );
  await throws('起：目录没了直接报错', () => m.startInstance('ghost'), '工作目录不存在');
  await throws('找：实例不存在时报可用的 id', () => m.instanceOf('不存在'), '没有这个实例');

  console.log(`\n结果：${pass} 通过 · ${fail} 失败`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

void main();
