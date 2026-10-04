import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { status as comfyStatus } from './comfy.ts';
import { killPid, listenersOn, portReport, SELF_PORT, waitPortFree } from './gpu.ts';
import { jobsSnapshot } from './jobs.ts';
import { LOGS_DIR, ROOT } from './store.ts';
import type { InstanceAction, InstanceRecipe, InstanceStatus, MachineSettings } from '../shared/types.ts';

/**
 * 两个 ComfyUI 实例的启停开关：生图 8888、出片 8188。
 *
 * 配方落 data/machine.json —— 命令、cwd、端口全在磁盘上，换机器/挪目录改文件就行。
 * 默认值来自实测：8888 在 D:\AI\ComfyUI_drawing，8188 在 D:\AI\ComfyUI，同一个 conda env。
 * host 用来探活、command 用来起服务，两者要一致 —— 设置面板把它们并排放，改一个另一个得跟着改。
 */

const MACHINE_FILE = path.join(ROOT, 'data', 'machine.json');
const COMFY_PY = 'C:\\Users\\wangxingfeng\\anaconda3\\envs\\comfyui\\python.exe';
const OUT_DIR = 'D:/AI/01videos/temp';

const DEFAULT_MACHINE: MachineSettings = {
  instances: [
    {
      id: 'image',
      label: '生图实例',
      host: 'http://127.0.0.1:8888',
      cwd: 'D:\\AI\\ComfyUI_drawing',
      command: `"${COMFY_PY}" main.py --output-directory ${OUT_DIR} --port 8888`,
      bootSeconds: 240,
      enabled: true,
    },
    {
      id: 'video',
      label: '出片实例',
      host: 'http://127.0.0.1:8188',
      cwd: 'D:\\AI\\ComfyUI',
      command: `"${COMFY_PY}" main.py --output-directory ${OUT_DIR} --port 8188`,
      bootSeconds: 300,
      enabled: true,
    },
  ],
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tail(file: string, lines = 20): string {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n').slice(-4000);
  } catch {
    return '';
  }
}

/** 手改 JSON 少个键就让整个面板崩掉不值得 —— 缺的字段拿默认配方兜。 */
function normalize(r: Partial<InstanceRecipe>, id: string): InstanceRecipe {
  const base = DEFAULT_MACHINE.instances.find((d) => d.id === id) ?? DEFAULT_MACHINE.instances[0];
  return {
    id,
    label: String(r.label ?? base.label),
    host: String(r.host ?? base.host),
    cwd: String(r.cwd ?? base.cwd),
    command: String(r.command ?? base.command),
    bootSeconds: Number(r.bootSeconds) || base.bootSeconds,
    enabled: r.enabled !== false,
  };
}

export function loadMachine(): MachineSettings {
  if (!fs.existsSync(MACHINE_FILE)) return { instances: DEFAULT_MACHINE.instances.map((i) => ({ ...i })) };
  try {
    const raw = JSON.parse(fs.readFileSync(MACHINE_FILE, 'utf8')) as { instances?: Array<Partial<InstanceRecipe> & { id?: string }> };
    const list = (raw.instances ?? []).map((r) => normalize(r, String(r.id ?? '')));
    return { instances: list.length ? list : DEFAULT_MACHINE.instances.map((i) => ({ ...i })) };
  } catch {
    return { instances: DEFAULT_MACHINE.instances.map((i) => ({ ...i })) };
  }
}

/** 存盘前逐项校验。命令写错一个字符，报错要指到是哪个实例的哪个字段。 */
function checkRecipe(r: InstanceRecipe): InstanceRecipe {
  const id = String(r.id ?? '').trim();
  if (!id) throw new Error('实例缺 id');
  const host = String(r.host ?? '').trim();
  let port = 0;
  try {
    port = Number(new URL(host).port);
  } catch {
    throw new Error(`${id}: host 不是合法地址（${host}）`);
  }
  if (!port) throw new Error(`${id}: host 要带端口，例 http://127.0.0.1:8888`);
  if (port === SELF_PORT) throw new Error(`${id}: ${port} 是 Takeboard 自己的端口`);
  const command = String(r.command ?? '').trim();
  if (!command) throw new Error(`${id}: 启动命令不能空`);
  const cwd = String(r.cwd ?? '').trim();
  if (!cwd) throw new Error(`${id}: 工作目录不能空`);
  if (!fs.existsSync(cwd)) throw new Error(`${id}: 工作目录不存在 ${cwd}`);
  if (command.includes(`--port ${port}`) === false && command.includes(`--port=${port}`) === false) {
    throw new Error(`${id}: 命令里的端口跟 host 的 ${port} 对不上（命令要有 --port ${port}）`);
  }
  return {
    id,
    label: String(r.label ?? id),
    host,
    cwd,
    command,
    bootSeconds: Math.min(900, Math.max(15, Number(r.bootSeconds) || 180)),
    enabled: r.enabled !== false,
  };
}

export function saveMachine(next: MachineSettings): MachineSettings {
  const list = Array.isArray(next?.instances) ? next.instances : [];
  if (!list.length) throw new Error('至少要留一个实例');
  const clean = list.map(checkRecipe);
  if (new Set(clean.map((i) => i.id)).size !== clean.length) throw new Error('实例 id 重复');
  fs.mkdirSync(path.dirname(MACHINE_FILE), { recursive: true });
  fs.writeFileSync(MACHINE_FILE, JSON.stringify({ instances: clean }, null, 2), 'utf8');
  return { instances: clean };
}

export function instanceOf(id: string): InstanceRecipe {
  const found = loadMachine().instances.find((i) => i.id === id);
  if (!found) throw new Error(`没有这个实例：${id}（可用的有 ${loadMachine().instances.map((i) => i.id).join('/')}）`);
  return found;
}

export function portOf(recipe: InstanceRecipe): number {
  return Number(new URL(recipe.host).port);
}

/** 配方 + 现在到底在不在跑。没监听的实例不去 ping，省得白等一次连接超时。 */
export async function machineStatus(): Promise<InstanceStatus[]> {
  return Promise.all(
    loadMachine().instances.map(async (recipe) => {
      const port = portOf(recipe);
      const rep = portReport(port);
      const st = rep.pid ? await comfyStatus(recipe.host) : null;
      return {
        recipe,
        port,
        listening: !!rep.pid,
        pid: rep.pid,
        cmdline: rep.cmdline,
        alive: !!st?.alive,
        vramFree: st?.vramFree,
        running: st?.running,
        pending: st?.pending,
        error: st?.error,
      };
    }),
  );
}

/**
 * 一键起实例。spawn 完就轮询端口，不阻塞事件循环（模型加载几十秒，阻塞了 UI 全卡死）。
 * 进程起了又退（常见：显存不够、端口被占）就把日志尾巴一起返回，省得人去翻文件。
 */
export async function startInstance(id: string): Promise<InstanceAction> {
  const recipe = instanceOf(id);
  const port = portOf(recipe);
  if (port === SELF_PORT) throw new Error(`${port} 是 Takeboard 自己的端口，不能拿来起 ComfyUI`);
  const already = listenersOn(port)[0];
  if (already) return { id, action: 'start', ok: true, pid: already, detail: `${recipe.label} 已经在跑（${port}，PID ${already}）` };
  if (!fs.existsSync(recipe.cwd)) throw new Error(`工作目录不存在：${recipe.cwd}`);

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logFile = path.join(LOGS_DIR, `${id}-boot-${Date.now()}.log`);
  const fd = fs.openSync(logFile, 'a');
  // shell:true —— 命令是人在设置里写的完整命令行（带引号、可能带 &&），别让 node 拆参数
  const child = spawn(recipe.command, { cwd: recipe.cwd, shell: true, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  let spawnError = '';
  child.on('error', (err) => {
    spawnError = err instanceof Error ? err.message : String(err);
  });
  child.unref();
  fs.closeSync(fd);

  const deadline = Date.now() + recipe.bootSeconds * 1000;
  while (Date.now() < deadline) {
    const pid = listenersOn(port)[0];
    if (pid) return { id, action: 'start', ok: true, pid, detail: `${recipe.label} 起来了（${port}，PID ${pid}）`, log: tail(logFile) };
    if (spawnError) return { id, action: 'start', ok: false, pid: null, detail: `进程没起来：${spawnError}`, log: tail(logFile) };
    if (child.exitCode !== null) {
      return { id, action: 'start', ok: false, pid: null, detail: `进程起了又退了（exit ${child.exitCode}），${port} 没监听`, log: tail(logFile) };
    }
    await sleep(1000);
  }
  return {
    id,
    action: 'start',
    ok: false,
    pid: child.pid ?? null,
    detail: `等了 ${recipe.bootSeconds}s，${port} 还没监听（模型还在加载，或端口被别的东西占了）`,
    log: tail(logFile),
  };
}

/**
 * 一键关实例。
 * 8188 允许关（人手动要求），但两件事必须先拦：关自己、还有作业在跑。
 * 自动流程（出片前让显存）走 gpu.releaseImagePort，那边仍然只认生图端口。
 */
export function stopInstance(id: string, opts: { force?: boolean } = {}): InstanceAction {
  const recipe = instanceOf(id);
  const port = portOf(recipe);
  const rep = portReport(port);
  if (!rep.pid) return { id, action: 'stop', ok: true, pid: null, detail: `${port} 上没有监听进程，不用关` };
  if (port === SELF_PORT || rep.pid === process.pid) throw new Error(`拒绝：${port} 是 Takeboard 自己（PID ${rep.pid}），关了没人能再开`);

  const busy = jobsSnapshot().filter((j) => j.phase !== 'done' && j.phase !== 'failed');
  if (busy.length && !opts.force) {
    return {
      id,
      action: 'stop',
      ok: false,
      busy: true,
      pid: rep.pid,
      detail: `还有 ${busy.length} 个作业在跑（${[...new Set(busy.map((j) => j.phase))].join('/')}），关掉 ${port} 会把它们打断`,
    };
  }

  killPid(rep.pid);
  const left = waitPortFree(port, 20_000);
  if (left) return { id, action: 'stop', ok: false, pid: rep.pid, cmdline: rep.cmdline, detail: `杀过 ${rep.pid}，但 ${port} 还在监听（PID ${left}）` };
  return { id, action: 'stop', ok: true, pid: rep.pid, cmdline: rep.cmdline, detail: `已关掉 ${recipe.label}（${port}，PID ${rep.pid}）` };
}
