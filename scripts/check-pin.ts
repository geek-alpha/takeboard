/**
 * 引脚语义回归检查 —— 跑法：npx tsx scripts/check-pin.ts
 *
 * 查的是这条铁律：边上的 pin=active 跟随上游节点的「当前引脚」（activeTake），
 * 不是「最后追加的那一版」。曾经服务端三处各写一份 takes[last]，
 * 后果是切了上游引脚下游纹丝不动、所有版本纠缠在一起。
 *
 * 走真 HTTP + 真作业（concat，几秒），只认行为不认代码。
 * 两个 take 故意登记同一个文件：查的是 takeId 有没有跟着引脚走，与画面内容无关。
 */
const API = process.env.TAKEBOARD_API ?? 'http://127.0.0.1:4317';
const SRC = 'D:\\AI\\repos\\takeboard\\projects\\英雄史诗-6703\\media\\n_a88bc1cc32\\take_c45999a49a.mp4';

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.error ?? text.slice(0, 200)}`);
  return data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function nodeOf(pid: string, nodeId: string): Promise<any> {
  const p = await call('GET', `/api/projects/${pid}`);
  return p.nodes.find((n: any) => n.id === nodeId);
}

async function runOp(pid: string, nodeId: string): Promise<any> {
  const take = await call('POST', `/api/projects/${pid}/ops`, { nodeId, op: 'concat', params: {} });
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const done = (await nodeOf(pid, nodeId)).takes.find((t: any) => t.id === take.id);
    if (done && done.status !== 'running') {
      if (done.status === 'failed') throw new Error(`concat 失败：${done.error}`);
      return done;
    }
    await sleep(1200);
  }
  throw new Error('作业超时');
}

let failed = 0;
function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? '✔' : '✘'} ${label}  —— ${detail}`);
  if (!ok) failed++;
}

const project = await call('POST', '/api/projects', { name: `引脚检查-${Date.now() % 100000}` });
const pid = project.id;
const a = await call('POST', `/api/projects/${pid}/nodes`, { kind: 'video', title: '素材A', x: 0, y: 0 });
const v1 = await call('POST', `/api/projects/${pid}/nodes/${a.id}/takes`, { path: SRC });
const v2 = await call('POST', `/api/projects/${pid}/nodes/${a.id}/takes`, { path: SRC });
const b = await call('POST', `/api/projects/${pid}/nodes`, { kind: 'op', title: '拼接', x: 420, y: 0 });
const edge = await call('POST', `/api/projects/${pid}/edges`, { from: a.id, to: b.id, pin: 'active' });
console.log(`项目 ${pid}\n上游 ${a.id}  v1=${v1.id}  v2=${v2.id}\n边 ${edge.id} pin=${edge.pin}\n`);

const cur1 = await nodeOf(pid, a.id);
check('登记两版后，当前引脚落在最新一版', cur1.activeTake === v2.id, `activeTake=${cur1.activeTake}`);

const t1 = await runOp(pid, b.id);
check('作业① 吃的是当前引脚 v2', t1.inputs?.[a.id] === v2.id, `inputs[上游]=${t1.inputs?.[a.id]}`);

await call('PATCH', `/api/projects/${pid}/nodes/${a.id}/takes/${v1.id}`, { active: true });
const cur2 = await nodeOf(pid, a.id);
check('切引脚 → v1', cur2.activeTake === v1.id, `activeTake=${cur2.activeTake}`);

const t2 = await runOp(pid, b.id);
check('切完引脚，作业② 立刻改吃 v1', t2.inputs?.[a.id] === v1.id, `inputs[上游]=${t2.inputs?.[a.id]}`);

// 钉死的边：上游怎么切都不许动
await call('PATCH', `/api/projects/${pid}/edges/${edge.id}`, { pin: v2.id });
await call('PATCH', `/api/projects/${pid}/nodes/${a.id}/takes/${v2.id}`, { active: true });
await call('PATCH', `/api/projects/${pid}/nodes/${a.id}/takes/${v1.id}`, { active: true });
const t3 = await runOp(pid, b.id);
check('钉死的边不随上游引脚变动（推倒重来的安全带）', t3.inputs?.[a.id] === v2.id, `inputs[上游]=${t3.inputs?.[a.id]}`);

console.log(failed ? `\n✘ ${failed} 项不合格` : '\n✔ 全部通过');
process.exit(failed ? 1 : 0);
