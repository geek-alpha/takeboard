import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from './store.ts';
import type { GpuPortReport } from '../shared/types.ts';

/**
 * 显存纪律：生图实例(8888) 和出片实例(8188) 抢同一块 8G 显存。
 * 出片前必须让出生图实例——但只杀监听目标端口的那个进程，8188 一根汗毛都不许碰。
 * 这条规矩来自 hero-epic 那一轮：留着生图进程会把 H3 挤爆。
 */

export const VIDEO_PORT = 8188;

/** Takeboard 自己的端口。启停动作一律不许碰它——关服务把自己关了，没人能再开回来。 */
export const SELF_PORT = Number(process.env.PORT ?? 4317);

/** 同步等待。stop 全链路是同步的（execFileSync），这里不引异步。 */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function killPid(pid: number): void {
  execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
}

/** 等端口释放，返回还占着它的 pid（null = 干净了）。 */
export function waitPortFree(port: number, ms: number): number | null {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && listenersOn(port).length) sleep(400);
  return listenersOn(port)[0] ?? null;
}

function netstat(): string {
  return execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
}

export function listenersOn(port: number): number[] {
  const pids = new Set<number>();
  for (const line of netstat().split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 5 && f[3] === 'LISTENING' && f[1]?.endsWith(`:${port}`) && /^\d+$/.test(f[4])) pids.add(Number(f[4]));
  }
  return [...pids];
}

export function cmdlineOf(pid: number): string {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true },
    ).trim();
  } catch {
    return '';
  }
}

export function portReport(port: number): GpuPortReport {
  const pids = listenersOn(port);
  return { port, pid: pids[0] ?? null, cmdline: pids[0] ? cmdlineOf(pids[0]) : undefined };
}

/**
 * 释放生图实例，给自动流程（出片前让显存）用。
 * 8188 在这里仍是禁区：自动流程没有判断力，不许它顺手把出片实例关了。
 * 人手动关走 machine.stopInstance——那边允许 8188，但有作业在跑会先拦一道。
 */
export function releaseImagePort(port = 8888): GpuPortReport {
  if (port === VIDEO_PORT) throw new Error(`拒绝：${VIDEO_PORT} 是出片实例，绝不能杀`);
  const pids = listenersOn(port);
  if (!pids.length) return { port, pid: null };
  const pid = pids[0];
  const cmd = cmdlineOf(pid);
  if (cmd) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOGS_DIR, `image-server-launch-${port}.txt`), cmd, 'utf8');
  }
  killPid(pid);
  const left = waitPortFree(port, 10_000);
  if (left) return { port, pid, cmdline: cmd, killed: false };
  return { port, pid, cmdline: cmd, killed: true };
}
