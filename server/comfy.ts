import fs from 'node:fs';
import path from 'node:path';
import type { ComfyStatus } from '../shared/types.ts';

export interface OutputItem {
  filename: string;
  subfolder: string;
  type: string;
}

async function req(url: string, init?: RequestInit, timeoutMs = 60_000): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${body}`.slice(0, 800));
  }
  return res;
}

async function json<T>(url: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const res = await req(url, init, timeoutMs);
  return (await res.json()) as T;
}

export async function systemStats(host: string): Promise<any> {
  return json(`${host}/system_stats`);
}

export async function queueState(host: string): Promise<{ queue_running: any[]; queue_pending: any[] }> {
  return json(`${host}/queue`);
}

export async function status(host: string): Promise<ComfyStatus> {
  try {
    const s = await systemStats(host);
    const q = await queueState(host).catch(() => ({ queue_running: [], queue_pending: [] }));
    const dev = s.devices?.[0] ?? {};
    return {
      host,
      alive: true,
      comfyuiVersion: s.system?.comfyui_version,
      device: dev.name,
      vramTotal: dev.vram_total,
      vramFree: dev.vram_free,
      running: q.queue_running?.length ?? 0,
      pending: q.queue_pending?.length ?? 0,
    };
  } catch (err) {
    return { host, alive: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 上传首帧。返回可直接写进 LoadImage.image 的名字。 */
export async function uploadImage(host: string, absPath: string, subfolder = 'takeboard'): Promise<string> {
  const buf = fs.readFileSync(absPath);
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(buf)]), path.basename(absPath));
  form.append('overwrite', 'true');
  if (subfolder) form.append('subfolder', subfolder);
  const res = await req(`${host}/upload/image`, { method: 'POST', body: form }, 300_000);
  const data = (await res.json()) as { name?: string; subfolder?: string };
  const name = data.name ?? path.basename(absPath);
  return data.subfolder ? `${data.subfolder}/${name}` : name;
}

export async function submit(host: string, workflow: unknown): Promise<string> {
  const res = await req(
    `${host}/prompt`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow }) },
    180_000,
  );
  const data = (await res.json()) as { prompt_id?: string; error?: unknown };
  if (!data.prompt_id) throw new Error(`提交被拒: ${JSON.stringify(data).slice(0, 600)}`);
  return data.prompt_id;
}

export async function history(host: string, promptId: string): Promise<any | null> {
  const data = await json<Record<string, any>>(`${host}/history/${promptId}`, undefined, 60_000);
  return data[promptId] ?? null;
}

export function collectOutputs(record: any): OutputItem[] {
  const out: OutputItem[] = [];
  for (const nodeOut of Object.values<any>(record?.outputs ?? {})) {
    for (const bucket of Object.values<any>(nodeOut ?? {})) {
      if (!Array.isArray(bucket)) continue;
      for (const item of bucket) {
        if (item && typeof item === 'object' && typeof item.filename === 'string') {
          out.push({ filename: item.filename, subfolder: item.subfolder ?? '', type: item.type ?? 'output' });
        }
      }
    }
  }
  return out;
}

export async function fetchOutput(host: string, item: OutputItem): Promise<Buffer> {
  const query = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder, type: item.type });
  const res = await req(`${host}/view?${query}`, undefined, 600_000);
  return Buffer.from(await res.arrayBuffer());
}

export async function interrupt(host: string): Promise<void> {
  await req(`${host}/interrupt`, { method: 'POST' }, 30_000);
}

export function errorDetail(record: any): string {
  const msgs = record?.status?.messages ?? [];
  for (const m of msgs) {
    if (Array.isArray(m) && m[0] === 'execution_error') return JSON.stringify(m[1]).slice(0, 600);
  }
  return '';
}

/**
 * 轮询到出结果。8188 重启会同时清空 /queue 和 /history，
 * 连查 3 次都不见就当任务丢了——否则会空等到超时。
 */
export async function waitForCompletion(
  host: string,
  promptId: string,
  opts: { timeoutMs: number; intervalMs?: number; onTick?: (q: { running: number; pending: number }, elapsedMs: number) => void },
): Promise<any> {
  const interval = opts.intervalMs ?? 5_000;
  const t0 = Date.now();
  let miss = 0;
  while (Date.now() - t0 < opts.timeoutMs) {
    await new Promise((r) => setTimeout(r, interval));
    let rec: any = null;
    try {
      rec = await history(host, promptId);
    } catch {
      continue;
    }
    if (rec) {
      const state = rec.status?.status_str;
      if (state === 'success' || state === 'error') return rec;
      continue;
    }
    let live = true;
    try {
      const q = await queueState(host);
      live = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].some((it: any[]) => it[1] === promptId);
      opts.onTick?.({ running: q.queue_running?.length ?? 0, pending: q.queue_pending?.length ?? 0 }, Date.now() - t0);
    } catch {
      live = true;
    }
    miss = live ? 0 : miss + 1;
    if (miss >= 3) throw new Error(`任务 ${promptId.slice(0, 8)} 已从服务端消失（疑似实例重启）`);
  }
  throw new Error(`等待超时 ${Math.round(opts.timeoutMs / 1000)}s（prompt ${promptId.slice(0, 8)}）`);
}
