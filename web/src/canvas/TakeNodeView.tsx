import { Handle, Position, type NodeProps } from '@xyflow/react';
import { mediaUrl } from '../api';
import { activeTakeOf, useStore, type WireInfo } from '../store';
import type { TakeNode } from '@shared/types';

export interface TakeNodeData {
  node: TakeNode;
  projectId: string;
  /** 每条入边的生效版本 —— 让「这一版吃的是上游哪一版」肉眼可见 */
  wires: WireInfo[];
  /** takeId → 「上游 v2 · 首帧 v1」 */
  takeInputs: Record<string, string>;
  onTakeMenu?: (ev: React.MouseEvent, takeId: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  image: 'img',
  video: 'vid',
  audio: 'aud',
  text: 'txt',
  op: 'op',
  note: 'note',
};

function Preview({ projectId, node }: { projectId: string; node: TakeNode }) {
  const active = activeTakeOf(node);
  if (node.kind === 'text') {
    const text = active?.text ?? '';
    return text ? <div className="text-preview">{text}</div> : <div className="empty">空提示词</div>;
  }
  if (!active) return <div className="empty">还没有 take<br />点「跑一版」或「登记」</div>;
  if (active.status === 'running') {
    return <div className="empty">出片中…<br /><span className="dim mono">{active.jobId ?? ''}</span></div>;
  }
  if (active.status === 'failed') {
    return <div className="empty err">失败<br /><span className="mono">{active.error?.slice(0, 120)}</span></div>;
  }
  if (!active.file) return <div className="empty">无产物</div>;
  const url = mediaUrl(projectId, active.file);
  if (active.kind === 'video') {
    return <video src={url} poster={active.poster ? mediaUrl(projectId, active.poster) : undefined} muted loop controls preload="metadata" />;
  }
  if (active.kind === 'audio') return <audio src={url} controls />;
  return <img src={url} alt={active.label ?? active.id} />;
}

/** 入边条：谁喂我、喂的是第几版、我这一版是不是已经过期了。 */
function Wires({ wires }: { wires: WireInfo[] }) {
  if (!wires.length) return null;
  return (
    <div className="wires">
      {wires.map((w) => (
        <span
          key={w.edgeId}
          className={`wire${w.pin === 'active' ? '' : ' pinned'}${w.stale ? ' stale' : ''}`}
          title={[
            `上游「${w.title}」`,
            w.pin === 'active' ? '跟版：上游切版本我就跟着切' : `钉死 v${w.index}`,
            `现在生效：${w.index ? `v${w.index}` : '没有 take'}`,
            `本版用的是：${w.usedIndex ? `v${w.usedIndex}` : '未记录'}`,
          ].join('\n')}
        >
          ← {w.title} {w.index ? `v${w.index}` : '—'}
          {w.stale ? ` · 本版还是 v${w.usedIndex}` : ''}
        </span>
      ))}
    </div>
  );
}

export function TakeNodeView({ data, selected }: NodeProps) {
  const d = data as unknown as TakeNodeData;
  const { node, projectId } = d;
  const active = activeTakeOf(node);
  const run = useStore((s) => s.run);
  const replay = useStore((s) => s.replay);
  const activate = useStore((s) => s.activate);
  const importPath = useStore((s) => s.importPath);
  const patchNode = useStore((s) => s.patchNode);
  const setSelected = useStore((s) => s.setSelected);
  const busy = useStore((s) => s.busy);

  const running = active?.status === 'running';
  const failed = active?.status === 'failed';

  const register = () => {
    const path = window.prompt('登记一个本地文件为 take（绝对路径）', 'D:\\AI\\repos\\Easel\\outputs\\hero-epic\\clips\\shot-01.mp4');
    if (path) void importPath(node.id, path.trim());
  };

  return (
    <div className={`take-node${selected ? ' selected' : ''}${running ? ' running' : ''}${failed ? ' failed' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <header>
        <span className="kind">{KIND_LABEL[node.kind] ?? node.kind}</span>
        <input
          className="title"
          value={node.title}
          onChange={(e) => void patchNode(node.id, { title: e.target.value })}
          onFocus={() => setSelected(node.id)}
        />
        <span className="badge">{node.takes.length > 0 ? `v${node.takes.length}` : ''}</span>
      </header>
      <Wires wires={d.wires ?? []} />
      <div className="body" onDoubleClick={() => setSelected(node.id)}>
        <Preview projectId={projectId} node={node} />
      </div>
      <footer>
        <div className="actions">
          <button
            className="primary"
            disabled={busy || running || node.kind === 'text' || node.kind === 'note'}
            onClick={() => void run(node.id)}
            title="用当前参数再出一版（新增 take，不覆盖旧的）"
          >
            ▶ 跑一版
          </button>
          <button disabled={busy} onClick={() => void replay(node.id)} title="从这个节点起，沿链把下游全部重跑">
            ⟳ 下游
          </button>
          <button disabled={busy} onClick={register} title="把本地已有文件登记成 take">
            ⤓ 登记
          </button>
        </div>
        <div className="stack">
          {node.takes.map((t, i) => {
            const inputs = d.takeInputs?.[t.id];
            return (
              <span
                key={t.id}
                className={`chip${t.id === active?.id ? ' active' : ''}${t.status === 'running' ? ' running' : ''}${t.status === 'failed' ? ' failed' : ''}`}
                title={[
                  `v${i + 1} · ${t.status} · ${t.source}`,
                  t.label ?? t.file ?? t.text?.slice(0, 40) ?? '',
                  inputs ? `输入：${inputs}` : '',
                  '右键：钉为当前版本 / 删除',
                ]
                  .filter(Boolean)
                  .join('\n')}
                onClick={() => void activate(node.id, t.id)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  d.onTakeMenu?.(ev, t.id);
                }}
              >
                v{i + 1}
              </span>
            );
          })}
        </div>
      </footer>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
