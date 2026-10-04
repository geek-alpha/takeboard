import { useEffect, useRef, useState } from 'react';
import { api, streamAgentChat, type AgentEvent, type AgentStatus } from '../api';
import { useStore } from '../store';

/**
 * 内置助手面板：一轮对话里它说了什么、调了哪些工具、要删东西时停下来问人——
 * 全画出来。黑盒式的「AI 正在思考…」在这里没有位置。
 */

type Item =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string }
  | { id: number; kind: 'tool'; name: string; args: string; status: 'running' | 'ok' | 'error'; result?: string; ms?: number }
  | { id: number; kind: 'confirm'; reqId: string; label: string; answer?: string }
  | { id: number; kind: 'error'; text: string };

const QUICK: Array<{ label: string; ask: string }> = [
  { label: '看画布', ask: '看一遍画布，指出最该修的三个问题，短一点。' },
  { label: '搭链路', ask: '给这个项目搭一条完整的出片链路：提示词节点 → 首帧图 → 出片，提示词用 optimize_prompt 生成后存进去，然后连好线。' },
  { label: '抽 4 版', ask: '挑当前最该出量的那个节点，抽 4 版，出完告诉我哪一版参数最好。' },
  { label: '体检', ask: '看环境状态：两个 ComfyUI 实例在线吗、显存在谁手里、有没有卡住的作业。' },
];

const argsBrief = (args: Record<string, unknown>): string => {
  const s = JSON.stringify(args);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
};

/** 联合类型上的 Omit 不分发，会丢各分支自己的字段——用条件类型包一层。 */
type NoId<T> = T extends { id: number } ? Omit<T, 'id'> : never;

export function AgentPanel() {
  const project = useStore((s) => s.project);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AgentStatus>();
  const sessionRef = useRef<string | undefined>(undefined);
  const idRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.agentStatus().then(setStatus).catch(() => setStatus(undefined));
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [items.length, busy]);

  const push = (item: NoId<Item>) => setItems((list) => [...list, { ...item, id: ++idRef.current } as Item]);

  const onEvent = (ev: AgentEvent) => {
    switch (ev.type) {
      case 'session':
        sessionRef.current = ev.sessionId;
        break;
      case 'assistant':
        push({ kind: 'assistant', text: ev.text });
        break;
      case 'tool':
        setItems((list) => {
          if (ev.status === 'running') {
            return [...list, { id: ++idRef.current, kind: 'tool', name: ev.name, args: argsBrief(ev.args), status: 'running' }];
          }
          // 收尾事件没带 id，配最近一个同名 running 的那条
          const at = list.map((i) => i).reverse().findIndex((i) => i.kind === 'tool' && i.name === ev.name && i.status === 'running');
          if (at < 0) {
            return [...list, { id: ++idRef.current, kind: 'tool', name: ev.name, args: argsBrief(ev.args), status: ev.status, result: ev.result, ms: ev.ms }];
          }
          const idx = list.length - 1 - at;
          const copy = [...list];
          copy[idx] = { ...(copy[idx] as Extract<Item, { kind: 'tool' }>), status: ev.status, result: ev.result, ms: ev.ms };
          return copy;
        });
        break;
      case 'confirm':
        push({ kind: 'confirm', reqId: ev.id, label: ev.label });
        break;
      case 'confirm_result':
        setItems((list) => list.map((i) => (i.kind === 'confirm' && i.reqId === ev.id ? { ...i, answer: ev.approved ? '已批准' : '已拒绝' } : i)));
        break;
      case 'project':
        // 画布被助手改了：立刻重新拉一遍，别让人看着旧图
        void useStore.getState().refresh();
        break;
      case 'job':
        // 作业进度走 WS，那边更全，这里不重复处理
        break;
      case 'error':
        push({ kind: 'error', text: ev.message });
        break;
      case 'done':
        break;
    }
  };

  const send = async (text: string) => {
    const ask = text.trim();
    if (!ask || busy) return;
    push({ kind: 'user', text: ask });
    setInput('');
    setBusy(true);
    try {
      await streamAgentChat({ text: ask, projectId: project?.id, sessionId: sessionRef.current }, onEvent);
    } catch (err) {
      push({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const answer = async (reqId: string, approve: boolean) => {
    try {
      await api.agentApprove(reqId, approve);
      setItems((list) => list.map((i) => (i.kind === 'confirm' && i.reqId === reqId ? { ...i, answer: approve ? '已批准' : '已拒绝' } : i)));
    } catch (err) {
      push({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const newSession = async () => {
    await api.agentReset(sessionRef.current).catch(() => undefined);
    sessionRef.current = undefined;
    setItems([]);
  };

  return (
    <div className="agent">
      <div className="agent-head">
        <span className="pill">{status?.configured ? `✦ ${status.model}` : '没配 LLM'}</span>
        <span className="dim">{status?.tools ?? 0} 个工具</span>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="ghost" onClick={() => void newSession()} disabled={busy}>
          新会话
        </button>
      </div>

      {!status?.configured && (
        <div className="agent-item error">
          还没配模型：在项目根 <span className="mono">.env</span> 里填 TAKEBOARD_LLM_API_KEY（可连同 BASE_URL / MODEL 一起给），然后重启服务。
        </div>
      )}

      <div className="agent-list" ref={listRef}>
        {items.length === 0 && (
          <div className="dim" style={{ padding: '6px 2px' }}>
            它直接动手改这张画布：建节点、写提示词、连线、跑版本、抽卡、切引脚。删东西之前会停下来问你。
          </div>
        )}
        {items.map((it) => {
          if (it.kind === 'user') return <div key={it.id} className="agent-item user">{it.text}</div>;
          if (it.kind === 'assistant') return <div key={it.id} className="agent-item assistant">{it.text}</div>;
          if (it.kind === 'error') return <div key={it.id} className="agent-item error">{it.text}</div>;
          if (it.kind === 'tool')
            return (
              <div key={it.id} className={`agent-item tool ${it.status}`}>
                <div className="mono">
                  {it.status === 'running' ? '→' : it.status === 'ok' ? '✔' : '✘'} {it.name}
                  {it.ms !== undefined ? ` (${it.ms}ms)` : ''}
                </div>
                <div className="mono dim">{it.args}</div>
                {it.result && <div className="mono result">{it.result}</div>}
              </div>
            );
          return (
            <div key={it.id} className="agent-item confirm">
              <div>⚠ {it.label}</div>
              {it.answer ? (
                <div className="dim">{it.answer}</div>
              ) : (
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="primary" onClick={() => void answer(it.reqId, true)}>
                    批准
                  </button>
                  <button onClick={() => void answer(it.reqId, false)}>拒绝</button>
                </div>
              )}
            </div>
          );
        })}
        {busy && <div className="dim">… 在干活</div>}
      </div>

      <div className="agent-quick">
        {QUICK.map((q) => (
          <button key={q.label} className="ghost" disabled={busy} onClick={() => void send(q.ask)} title={q.ask}>
            {q.label}
          </button>
        ))}
      </div>

      <div className="agent-input">
        <textarea
          rows={3}
          placeholder="要它干什么？Ctrl+Enter 发送"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button className="primary" disabled={busy || !input.trim()} onClick={() => void send(input)}>
          发送
        </button>
      </div>
    </div>
  );
}
