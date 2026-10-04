/**
 * 内置助手的端到端冒烟：真调一次 LLM，看它能不能自己看清画布、自己动工具。
 *
 *   npx tsx scripts/agent-smoke.ts                          # 默认问一句现状
 *   npx tsx scripts/agent-smoke.ts --project <id> --ask "..." 
 *
 * 需要服务在跑（npm run start）。这个脚本会真花钱、真改画布——写类指令别拿正式项目试。
 */
const base = `http://127.0.0.1:${process.env.TAKEBOARD_PORT ?? '4317'}`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pick = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const ask = pick('--ask') ?? '现在画布上有什么？一句话说清。';
  const projectId = pick('--project');

  const status = await (await fetch(`${base}/api/agent/status`)).json() as any;
  console.log(`[status] configured=${status.configured} model=${status.model} tools=${status.tools} source=${status.source}`);
  if (!status.configured) {
    console.log('没配 LLM key：在项目根 .env 里填 TAKEBOARD_LLM_API_KEY');
    process.exit(1);
  }

  const res = await fetch(`${base}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: ask, projectId }),
  });
  if (!res.ok || !res.body) {
    console.log(`[chat] HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let final = '';
  let tools = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      switch (ev.type) {
        case 'round':
          console.log(`\n[轮 ${ev.round}]`);
          break;
        case 'assistant':
          console.log(`[助手] ${ev.text}`);
          break;
        case 'tool':
          if (ev.status === 'running') {
            tools++;
            console.log(`  → ${ev.name} ${JSON.stringify(ev.args)}`);
          } else {
            console.log(`  ${ev.status === 'ok' ? '✔' : '✘'} ${ev.name} (${ev.ms}ms) ${ev.result ?? ''}`);
          }
          break;
        case 'confirm':
          console.log(`  [审批请求] ${ev.label}`);
          break;
        case 'error':
          console.log(`[错误] ${ev.message}`);
          process.exitCode = 1;
          break;
        case 'done':
          final = ev.text;
          break;
      }
    }
  }
  console.log(`\n[最终] ${final}\n[工具调用 ${tools} 次]`);
}

void main();
