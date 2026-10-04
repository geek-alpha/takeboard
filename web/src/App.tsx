import { useEffect, useState } from 'react';
import { Canvas } from './canvas/Canvas';
import { Inspector } from './panels/Inspector';
import { AgentPanel } from './panels/Agent';
import { StoryPanel } from './panels/Story';
import { SettingsPanel } from './panels/Settings';
import { PreviewBar } from './panels/PreviewBar';
import { api } from './api';
import { connectSocket, useStore } from './store';
import type { NodeKind } from '@shared/types';

function AddNodeButtons() {
  const addNode = useStore((s) => s.addNode);
  const project = useStore((s) => s.project);
  const busy = useStore((s) => s.busy);
  const add = (kind: NodeKind) => {
    const n = project?.nodes.length ?? 0;
    void addNode(kind, 60 + (n % 4) * 280, 60 + Math.floor(n / 4) * 240);
  };
  return (
    <div className="row" style={{ gap: 5 }}>
      <button disabled={busy || !project} onClick={() => add('text')}>＋文本</button>
      <button disabled={busy || !project} onClick={() => add('image')}>＋图</button>
      <button disabled={busy || !project} onClick={() => add('video')}>＋视频</button>
      <button disabled={busy || !project} onClick={() => add('op')}>＋算子</button>
    </div>
  );
}

function Topbar() {
  const projects = useStore((s) => s.projects);
  const project = useStore((s) => s.project);
  const openProject = useStore((s) => s.openProject);
  const createProject = useStore((s) => s.createProject);
  const comfy = useStore((s) => s.comfy);
  const releaseImage = useStore((s) => s.releaseImage);
  const refreshEnv = useStore((s) => s.refreshEnv);
  const busy = useStore((s) => s.busy);

  const vram = (n?: number) => (n ? `${(n / 1e9).toFixed(1)}G` : '—');

  return (
    <div className="topbar">
      <div className="brand">
        Take<span>board</span>
      </div>
      <select style={{ width: 200 }} value={project?.id ?? ''} onChange={(e) => void openProject(e.target.value)}>
        {!project && <option value="">（选项目）</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.takeCount} 版
          </option>
        ))}
      </select>
      <button
        disabled={busy}
        onClick={() => {
          const name = window.prompt('新工作台名字', '新片');
          if (name) void createProject(name);
        }}
      >
        新建
      </button>
      <AddNodeButtons />
      <div className="spacer" />
      <span className={`pill ${comfy?.video.alive ? 'on' : 'off'}`} title="出片实例 8188">
        <span className="dot" />
        出片 {comfy?.video.alive ? `显存 ${vram(comfy.video.vramFree)} · 队列 ${comfy.video.running ?? 0}/${comfy.video.pending ?? 0}` : '离线'}
      </span>
      <span className={`pill ${comfy?.image.alive ? 'on' : 'off'}`} title="生图实例 8888">
        <span className="dot" />
        生图 {comfy?.image.alive ? '在线' : '离线'}
      </span>
      <button disabled={busy || !comfy?.image.alive} onClick={() => void releaseImage()} title="杀掉 8888 让出显存（8188 不碰）">
        释放 8888
      </button>
      <button disabled={busy} onClick={() => void refreshEnv()}>
        刷新环境
      </button>
    </div>
  );
}

function JobsBar() {
  const jobs = useStore((s) => s.jobs);
  const list = Object.values(jobs).filter((j) => j.phase !== 'done');
  if (!list.length) return null;
  return (
    <div className="jobs-bar">
      {list.map((j) => (
        <div key={j.jobId} className={`job${j.phase === 'failed' ? ' failed' : ''}`}>
          <div>
            {j.phase} · {Math.round(j.elapsedMs / 1000)}s {j.queue ? `· 队列 ${j.queue.running}/${j.queue.pending}` : ''}
          </div>
          <div className="mono">{j.detail ?? j.error ?? j.nodeId}</div>
        </div>
      ))}
    </div>
  );
}

function StatusBar() {
  const project = useStore((s) => s.project);
  const busy = useStore((s) => s.busy);
  const jobs = useStore((s) => s.jobs);
  const running = Object.values(jobs).filter((j) => j.phase !== 'done' && j.phase !== 'failed').length;
  return (
    <div className="statusbar">
      <span>{busy ? '● 忙' : '○ 空闲'}</span>
      <span>在跑作业 {running}</span>
      {project && <span className="mono">{project.settings.workflowImage} → {project.settings.workflowVideo}</span>}
      <span className="spacer" style={{ flex: 1 }} />
      <span>双击空白加图 · 拖圆点连线 · 点连线切「跟版/钉版」· 点 v 号切引脚</span>
    </div>
  );
}

export function App() {
  const boot = useStore((s) => s.boot);
  const error = useStore((s) => s.error);
  const dismissError = useStore((s) => s.dismissError);
  const [tab, setTab] = useState<'inspector' | 'story' | 'settings' | 'agent'>('inspector');

  useEffect(() => {
    void boot();
    return connectSocket();
  }, [boot]);

  useEffect(() => {
    const t = setInterval(() => void useStore.getState().refreshEnv(), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'r' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        void useStore.getState().refresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Topbar />
      <div className="main" style={{ gridTemplateColumns: tab === 'agent' ? '1fr 430px' : tab === 'story' ? '1fr 420px' : tab === 'settings' ? '1fr 400px' : '1fr 330px' }}>
        <div className="canvas-wrap">
          <div className="canvas-inner">
            <Canvas />
          </div>
          <PreviewBar />
          <JobsBar />
          {error && (
            <div className="toast" onClick={dismissError} title="点一下关掉">
              ✘ {error}
            </div>
          )}
        </div>
        <div className="sidebar">
          <div className="tabs">
            <button className={tab === 'inspector' ? 'tab on' : 'tab'} onClick={() => setTab('inspector')}>
              检查器
            </button>
            <button className={tab === 'story' ? 'tab on' : 'tab'} onClick={() => setTab('story')}>
              🎬 剧情
            </button>
            <button className={tab === 'settings' ? 'tab on' : 'tab'} onClick={() => setTab('settings')}>
              ⚙ 设置
            </button>
            <button className={tab === 'agent' ? 'tab on' : 'tab'} onClick={() => setTab('agent')}>
              ✦ 助手
            </button>
          </div>
          <div className="tab-body">
            {tab === 'inspector' ? <Inspector /> : tab === 'story' ? <StoryPanel /> : tab === 'settings' ? <SettingsPanel /> : <AgentPanel />}
          </div>
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
