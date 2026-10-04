/**
 * take —— 命令行驱动的 Takeboard。
 * 大白（agent）靠它把工作台当手用：建节点、登记素材、跑作业、切引脚、重演。
 *
 * 用法: npm run take -- <cmd> [args] [--flags]
 */
import { resolveTake } from './store.ts';

const API = process.env.TAKEBOARD_API ?? 'http://127.0.0.1:4317';

type Flags = Record<string, string | boolean>;

function parse(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(typeof data === 'object' && data?.error ? data.error : `${res.status} ${text.slice(0, 300)}`);
  return data;
}

function num(v: string | boolean | undefined): number | undefined {
  return v === undefined || v === true ? undefined : Number(v);
}

/** run / sweep 共用的参数装配：提示词、尺寸、种子、模板都能从命令行给。 */
function runParams(flags: Flags): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (typeof flags.prompt === 'string') params.prompt = flags.prompt;
  if (typeof flags.negative === 'string') params.negative = flags.negative;
  if (typeof flags.template === 'string') params.workflow = flags.template;
  if (num(flags.seconds) !== undefined) params.seconds = num(flags.seconds);
  if (num(flags.seed) !== undefined) params.seed = num(flags.seed);
  if (num(flags.w) !== undefined) params.width = num(flags.w);
  if (num(flags.h) !== undefined) params.height = num(flags.h);
  if (num(flags.steps) !== undefined) params.steps = num(flags.steps);
  if (num(flags.timeout) !== undefined) params.timeoutS = num(flags.timeout);
  return params;
}

/** 一行看清这一版拿什么参数跑的；提示词太长就截断，看全文用 take show。 */
function brief(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const bits: string[] = [];
  if (params.workflow) bits.push(String(params.workflow));
  if (typeof params.prompt === 'string' && params.prompt) {
    const flat = params.prompt.replace(/\s+/g, ' ');
    bits.push(`「${flat.slice(0, 36)}${flat.length > 36 ? '…' : ''}」`);
  }
  for (const k of ['seed', 'width', 'height', 'seconds', 'steps']) {
    if (params[k] !== undefined) bits.push(`${k}=${params[k]}`);
  }
  return bits.join(' ');
}

const HELP = `take — Takeboard 视频工作台命令行

  status                            服务 / 出片实例 / 端口占用
  ls                                项目清单
  new <name>                        建项目
  board <project>                   节点 + take 总览
  add <project> <kind> <title>      建节点（kind: image|video|text|op|note）[--x --y --text]
  takes <project> <nodeId>          该节点的 take 栈
  import <project> <nodeId> <file>  登记素材为 take
  prompt <project> <nodeId> <text>  更新文本节点的内容
  run <project> <nodeId>            跑一次 → 新 take [--mode --prompt --negative --seconds --seed --w --h --steps --timeout --template]
  sweep <project> <nodeId>          抽卡：同参数连跑 N 版，seed 逐个递进 [--n 4 以及 run 的全部参数]
  show <project> <nodeId>           该节点当前生效的参数 / 提示词 / 上游来源
  op <project> <nodeId> <op>        算子 [--start --duration --width --height --fps --at]
  pin <project> <nodeId> <takeId>   切引脚（推倒重来的核心动作）
  link <project> <from> <to>        连边 [--pin active|<takeId>]
  replay <project> <nodeId>         沿链重演下游
  jobs                              在跑的作业
  gpu-release                       杀 8888 让出显存（8188 不碰）
  templates [--dir]                 模板 + 已发现的旋钮
`;

async function main(): Promise<void> {
  const { positional, flags } = parse(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  switch (cmd) {
    case 'status': {
      const health = await call('GET', '/api/health');
      const gpu = await call('GET', '/api/gpu');
      console.log(`服务 ${health.ok ? '活' : '死'}  root=${health.root}  项目 ${health.projects} 个  在跑作业 ${health.jobs}`);
      console.log(`出片 ${health.comfy.host} ${health.comfy.alive ? `活 v${health.comfy.comfyuiVersion} 显存 ${Math.round((health.comfy.vramFree ?? 0) / 1e9 * 10) / 10}/${Math.round((health.comfy.vramTotal ?? 0) / 1e9 * 10) / 10}G 队列 ${health.comfy.running}/${health.comfy.pending}` : `死 ${health.comfy.error ?? ''}`}`);
      console.log(`端口 8188 PID ${gpu.videoPort.pid ?? '—'} / 8888 PID ${gpu.imagePort.pid ?? '—'}`);
      break;
    }
    case 'ls': {
      for (const p of await call('GET', '/api/projects')) {
        console.log(`${p.id}\t${p.name}\t节点${p.nodeCount} take${p.takeCount}\t${new Date(p.updatedAt).toLocaleString()}`);
      }
      break;
    }
    case 'new':
      console.log(JSON.stringify(await call('POST', '/api/projects', { name: rest.join(' ') || '未命名工作台' }), null, 2));
      break;
    case 'board': {
      const p = await call('GET', `/api/projects/${rest[0]}`);
      console.log(`# ${p.name} (${p.id}) rev=${p.rev}`);
      for (const n of p.nodes) {
        const active = n.activeTake ?? n.takes[n.takes.length - 1]?.id;
        console.log(`  ${n.id}  [${n.kind}] ${n.title}  takes=${n.takes.length}  active=${active ?? '—'}`);
        for (const t of n.takes) {
          const mark = t.id === active ? '▶' : ' ';
          const spec = t.probe ? `${t.probe.width}x${t.probe.height} ${t.probe.duration ?? ''}s` : '';
          console.log(`    ${mark} ${t.id} ${t.status} ${t.file ?? t.text ?? ''} ${spec} ${brief(t.params)} ${t.error ?? ''}`.trimEnd());
        }
      }
      for (const e of p.edges) console.log(`  ${e.from} → ${e.to}  pin=${e.pin}`);
      break;
    }
    case 'add': {
      const [project, kind, ...title] = rest;
      const node = await call('POST', `/api/projects/${project}/nodes`, {
        kind,
        title: title.join(' ') || undefined,
        x: num(flags.x),
        y: num(flags.y),
        text: typeof flags.text === 'string' ? flags.text : undefined,
      });
      console.log(`${node.id}  ${node.title}`);
      break;
    }
    case 'takes': {
      const p = await call('GET', `/api/projects/${rest[0]}`);
      const n = p.nodes.find((x: any) => x.id === rest[1]);
      if (!n) throw new Error(`节点不存在: ${rest[1]}`);
      for (const t of n.takes) {
        console.log(`${t.id === n.activeTake ? '▶' : ' '} ${t.id}\t${t.status}\t${t.source}\t${t.file ?? t.text ?? ''}\t${t.label ?? ''}`);
      }
      break;
    }
    case 'import': {
      const [project, nodeId, file] = rest;
      console.log(JSON.stringify(await call('POST', `/api/projects/${project}/nodes/${nodeId}/takes`, { path: file }), null, 2));
      break;
    }
    case 'prompt': {
      const [project, nodeId, ...text] = rest;
      const take = await call('POST', `/api/projects/${project}/nodes/${nodeId}/takes`, { text: text.join(' ') });
      console.log(`新 take ${take.id}`);
      break;
    }
    case 'run': {
      const [project, nodeId] = rest;
      const params = runParams(flags);
      const n = num(flags.n) ?? 1;
      const mode = typeof flags.mode === 'string' ? flags.mode : undefined;
      if (n > 1) {
        const out = await call('POST', `/api/projects/${project}/sweep`, { nodeId, count: n, mode, params });
        console.log(`已起 ${out.takes.length} 版抽卡：${out.takes.map((t: any) => t.id).join(' ')}`);
        break;
      }
      const take = await call('POST', `/api/projects/${project}/run`, { nodeId, mode, params });
      console.log(`已起作业 take=${take.id}（${take.kind}）—— 用 take jobs / board 看进度`);
      break;
    }
    case 'sweep': {
      const [project, nodeId] = rest;
      const out = await call('POST', `/api/projects/${project}/sweep`, {
        nodeId,
        count: num(flags.n) ?? 4,
        mode: typeof flags.mode === 'string' ? flags.mode : undefined,
        params: runParams(flags),
      });
      console.log(`已起 ${out.takes.length} 版抽卡：${out.takes.map((t: any) => t.id).join(' ')}`);
      break;
    }
    case 'show': {
      const p = await call('GET', `/api/projects/${rest[0]}`);
      const node = p.nodes.find((n: any) => n.id === rest[1]);
      if (!node) throw new Error(`节点不存在: ${rest[1]}`);
      const active = node.takes.find((t: any) => t.id === node.activeTake) ?? node.takes[node.takes.length - 1];
      console.log(`${node.id}  [${node.kind}] ${node.title}  版本 ${node.takes.length}`);
      if (!active) {
        console.log('还没有任何 take');
        break;
      }
      console.log(`当前引脚 ${active.id}  ${active.status}  ${active.file ?? active.text ?? ''}`);
      const params: Record<string, unknown> = active.params ?? {};
      if (params.workflow) console.log(`模板 ${params.workflow}`);
      if (params.prompt) console.log(`提示词 ${params.prompt}`);
      const others = Object.entries(params).filter(([k]) => k !== 'prompt' && k !== 'workflow');
      if (others.length) console.log(others.map(([k, v]) => `${k}=${v}`).join('  '));
      for (const e of p.edges.filter((x: any) => x.to === node.id)) {
        const up = p.nodes.find((n: any) => n.id === e.from);
        const ut = resolveTake(up, e.pin);
        const what = ut?.text ? `提示词「${ut.text.slice(0, 60)}」` : ut?.file ?? ut?.id ?? '空';
        console.log(`上游 ${up?.title ?? e.from}  pin=${e.pin}  → ${what}`);
      }
      break;
    }
    case 'op': {
      const [project, nodeId, op] = rest;
      const params: Record<string, unknown> = {};
      for (const key of ['start', 'duration', 'width', 'height', 'fps', 'at']) {
        if (num(flags[key]) !== undefined) params[key] = num(flags[key]);
      }
      const take = await call('POST', `/api/projects/${project}/ops`, { nodeId, op, params });
      console.log(`算子作业 take=${take.id}`);
      break;
    }
    case 'pin': {
      const [project, nodeId, takeId] = rest;
      const out = await call('PATCH', `/api/projects/${project}/nodes/${nodeId}/takes/${takeId}`, { active: true });
      console.log(`引脚 → ${out.node.activeTake}`);
      break;
    }
    case 'link': {
      const [project, from, to] = rest;
      const edge = await call('POST', `/api/projects/${project}/edges`, {
        from,
        to,
        pin: typeof flags.pin === 'string' ? flags.pin : 'active',
      });
      console.log(`${edge.id}  ${from} → ${to} pin=${edge.pin}`);
      break;
    }
    case 'replay':
      console.log(JSON.stringify(await call('POST', `/api/projects/${rest[0]}/replay`, { nodeId: rest[1] }), null, 2));
      break;
    case 'jobs':
      for (const j of await call('GET', '/api/jobs')) {
        console.log(`${j.jobId} ${j.phase} ${j.nodeId} ${j.detail ?? ''} ${j.error ?? ''} ${Math.round(j.elapsedMs / 1000)}s`);
      }
      break;
    case 'gpu-release':
      console.log(JSON.stringify(await call('POST', '/api/gpu/release-image', {}), null, 2));
      break;
    case 'templates': {
      const out = await call('GET', `/api/templates${typeof flags.dir === 'string' ? `?dir=${encodeURIComponent(flags.dir)}` : ''}`);
      console.log(`目录 ${out.dir}`);
      for (const t of out.templates) {
        console.log(`\n${t.id}  ${t.title}${t.default ? ' ★' : ''}  host=${t.host ?? '—'} 节点${t.nodeCount}`);
        for (const b of t.bindings) console.log(`    ${b.role.padEnd(9)} 节点${b.nodeId} ${b.class}.${b.field}`);
      }
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(`✘ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
