import { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { StoryBeatRow } from '../api';
import { DEFAULT_SETTINGS } from '@shared/types';
import type { StoryBeat } from '@shared/types';

/**
 * 剧情面板：剧本进、画布出。
 *
 * 两条路进剧情 —— 导入（贴文本或选文件）和助手创作 —— 出口都是同一件事：
 * 填模板把每镜变成画布上的首帧 + 出片节点，然后可以一条龙跑初版。
 * 改词是就地改、离开输入框即存，不打断正在写的下一句。
 */

function BeatCard({
  beat,
  index,
  onSave,
  onPick,
  onRun,
  running,
}: {
  beat: StoryBeatRow;
  index: number;
  onSave: (patch: Partial<StoryBeat>) => void;
  onPick: (nodeId?: string) => void;
  onRun: () => void;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<StoryBeat>(beat);

  // 换镜或外部改了（精修回填）就重读，正在打字的那一格不受影响
  useEffect(() => setDraft(beat), [beat.id, beat.image, beat.video, beat.action, beat.seconds, beat.title]);

  const field = (key: keyof StoryBeat, label: string, rows = 2, placeholder = '') => (
    <div className="field">
      <label>{label}</label>
      <textarea
        rows={rows}
        value={String(draft[key] ?? '')}
        placeholder={placeholder}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        onBlur={() => {
          if (String(beat[key] ?? '') !== String(draft[key] ?? '')) onSave({ [key]: draft[key] } as Partial<StoryBeat>);
        }}
      />
    </div>
  );

  return (
    <div className="story-beat">
      <div className="row" style={{ gap: 6 }}>
        <button className="ghost" style={{ padding: '1px 6px' }} onClick={() => setOpen(!open)} title="展开/收起">
          {open ? '▾' : '▸'}
        </button>
        <b style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {index + 1}. {beat.title}
        </b>
        <span className="badge">{beat.seconds}s</span>
        {beat.imageNodeId && (
          <button
            className="ghost"
            style={{ padding: '1px 6px', fontSize: 11 }}
            title="跳到画布上这一镜的首帧节点"
            onClick={() => onPick(beat.imageNodeId)}
          >
            首帧{beat.imageDone ? ' ✓' : ''}
          </button>
        )}
        {beat.videoNodeId && (
          <button
            className="ghost"
            style={{ padding: '1px 6px', fontSize: 11 }}
            title="跳到画布上这一镜的出片节点"
            onClick={() => onPick(beat.videoNodeId)}
          >
            片{beat.videoDone ? ' ✓' : ''}
          </button>
        )}
        <button
          className="ghost"
          style={{ padding: '1px 6px', fontSize: 11 }}
          disabled={running}
          title="只跑这一镜：建节点 → 首帧 → 释放生图显存 → 出片（不合成全片）"
          onClick={onRun}
        >
          ▶ 跑
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 6 }}>
          <div className="field">
            <label>镜头名</label>
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              onBlur={() => beat.title !== draft.title && onSave({ title: draft.title })}
            />
          </div>
          {field('action', '这一镜发生什么（中文，给人看也给模型当语境）', 3)}
          {field('image', '生图词（首帧，英文静态画面）', 4, '留空就用「发生什么」那句兜底')}
          {field('video', '出片词（从首帧开始发生什么，英文）', 4, '留空就用「发生什么」那句兜底')}
          <div className="grid2">
            <div className="field">
              <label>时长 s</label>
              <input
                type="number"
                step={0.5}
                min={1}
                value={draft.seconds}
                onChange={(e) => setDraft({ ...draft, seconds: Number(e.target.value) || 0 })}
                onBlur={() => beat.seconds !== draft.seconds && onSave({ seconds: draft.seconds })}
              />
            </div>
            <div className="field">
              <label>画幅档位（留空跟随首帧）</label>
              <input
                value={draft.aspect ?? ''}
                placeholder="跟随首帧"
                onChange={(e) => setDraft({ ...draft, aspect: e.target.value })}
                onBlur={() => (beat.aspect ?? '') !== (draft.aspect ?? '') && onSave({ aspect: draft.aspect })}
              />
            </div>
          </div>
          {field('line', '台词/旁白（没有就留空）', 2)}
        </div>
      )}
    </div>
  );
}

export function StoryPanel() {
  const project = useStore((s) => s.project);
  const story = useStore((s) => s.story);
  const msg = useStore((s) => s.storyMsg);
  const busy = useStore((s) => s.busy);
  const editBeat = useStore((s) => s.editBeat);
  const importScript = useStore((s) => s.importScript);
  const draftStory = useStore((s) => s.draftStory);
  const applyStory = useStore((s) => s.applyStory);
  const refineStory = useStore((s) => s.refineStory);
  const runStory = useStore((s) => s.runStory);
  const cancelStory = useStore((s) => s.cancelStory);
  const storyRunning = useStore((s) => s.storyRunning);
  const setSelected = useStore((s) => s.setSelected);

  const [script, setScript] = useState('');
  const [idea, setIdea] = useState('');
  const [shots, setShots] = useState(6);
  const [seconds, setSeconds] = useState(project?.settings.videoSeconds ?? DEFAULT_SETTINGS.videoSeconds);
  const [refineFirst, setRefineFirst] = useState(true);
  const [handoff, setHandoff] = useState(true);
  const [showImport, setShowImport] = useState(false);

  if (!project) return <div className="inspector dim">先开一个工作台</div>;

  const beats = story?.beats ?? [];
  const pick = (nodeId?: string) => {
    if (!nodeId) return;
    setSelected(nodeId);
  };

  return (
    <div className="inspector story">
      <div className="section">
        <h3>剧情{story?.title ? ` · ${story.title}` : ''}</h3>
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="badge">镜头 {beats.length}</span>
          <span className="badge">已填 {story?.filled ?? 0}</span>
          <span className="badge">出片 {story?.done ?? 0}</span>
          <span className="badge">全片 {story?.totalSeconds ?? 0}s</span>
          {story?.source && <span className="badge">来自 {story.source === 'ai' ? '助手' : story.source === 'import' ? '导入' : '手改'}</span>}
        </div>
        {story?.logline && <div className="dim" style={{ marginTop: 6 }}>{story.logline}</div>}
        {msg && <div className="warn" style={{ marginTop: 6 }}>{msg}</div>}
      </div>

      <div className="section">
        <h3>进剧情</h3>
        <div className="field">
          <label>一句话想法 → 助手写分镜</label>
          <textarea rows={2} value={idea} placeholder="例：雨夜天台，一个没脸的人等一封信" onChange={(e) => setIdea(e.target.value)} />
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          <label className="row dim" style={{ gap: 4, width: 'auto' }}>
            镜头
            <input type="number" min={1} max={24} value={shots} onChange={(e) => setShots(Number(e.target.value) || 6)} style={{ width: 54 }} />
          </label>
          <label className="row dim" style={{ gap: 4, width: 'auto' }}>
            每镜 s
            <input type="number" min={1} step={0.5} value={seconds} onChange={(e) => setSeconds(Number(e.target.value) || DEFAULT_SETTINGS.videoSeconds)} style={{ width: 54 }} />
          </label>
          <button className="primary" disabled={busy} onClick={() => void draftStory(idea, { shots, seconds })}>
            ✦ 写剧情
          </button>
          <button className="ghost" onClick={() => setShowImport(!showImport)}>
            {showImport ? '收起导入' : '导入剧本'}
          </button>
        </div>
        {showImport && (
          <div style={{ marginTop: 8 }}>
            <div className="field">
              <label>贴剧本：分镜表 / 场景段落 / JSON 都行，镜头头用 ##、镜头1、1. 或【】</label>
              <textarea rows={5} value={script} onChange={(e) => setScript(e.target.value)} placeholder={'## 镜头1 天台\n画面：wet rooftop, neon glow, ...\n动作：she turns slowly toward the light\n时长：6s'} />
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              <button disabled={busy || !script.trim()} onClick={() => void importScript(script).then((n) => n && setScript(''))}>
                导入
              </button>
              <button className="ghost" disabled={busy || !script.trim()} onClick={() => void importScript(script, false).then((n) => n && setScript(''))}>
                追加
              </button>
              <label className="row dim" style={{ gap: 4, width: 'auto' }}>
                或选文件
                <input
                  type="file"
                  accept=".txt,.md,.json,.fountain,.csv"
                  style={{ width: 160 }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) setScript(await f.text());
                  }}
                />
              </label>
            </div>
          </div>
        )}
      </div>

      <div className="section" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <h3>镜头</h3>
        <div className="story-list">
          {beats.length ? (
            beats.map((b, i) => (
              <BeatCard
                key={b.id}
                beat={b}
                index={i}
                onSave={(patch) => void editBeat(b.id, patch)}
                onPick={pick}
                onRun={() => void runStory({ beats: [b.id], film: false, refine: false })}
                running={busy || storyRunning}
              />
            ))
          ) : (
            <div className="dim">还没有剧情。上面写一句话让助手写，或者贴一段剧本进来。</div>
          )}
        </div>
      </div>

      <div className="section">
        <h3>跑</h3>
        <div className="row wrap" style={{ gap: 6 }}>
          <button disabled={busy || !beats.length} onClick={() => void applyStory()} title="每镜建首帧+出片节点，词写进节点预设，连线排好">
            填模板
          </button>
          <button disabled={busy || !beats.length} onClick={() => void refineStory('video')} title="逐镜装上 H3 技能，把出片词写成规范格式（慢，要花钱）">
            精修出片词
          </button>
          <button disabled={busy || !beats.length} onClick={() => void refineStory('both')} title="首帧词和出片词都精修一遍">
            精修两边
          </button>
        </div>
        <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
          <label className="row dim" style={{ gap: 4, width: 'auto' }} title="装 H3 技能把词写成规范格式：首帧词生图前精修，出片词每镜出片前精修——那时上一镜的尾帧才真的在">
            <input type="checkbox" checked={refineFirst} onChange={(e) => setRefineFirst(e.target.checked)} style={{ width: 'auto' }} />
            精修词
          </label>
          <label className="row dim" style={{ gap: 4, width: 'auto' }} title="把上一镜的尾帧接成本镜首帧，画面才真的连得上；关了就是硬切">
            <input type="checkbox" checked={handoff} onChange={(e) => setHandoff(e.target.checked)} style={{ width: 'auto' }} />
            接戏
          </label>
          <button className="primary" disabled={busy || storyRunning || !beats.length} onClick={() => void runStory({ refine: refineFirst, handoff, film: true })}>
            ▶ 一条龙跑初版
          </button>
          <button className="ghost" onClick={() => void cancelStory()}>
            叫停
          </button>
        </div>
        <div className="dim" style={{ marginTop: 6, fontSize: 11 }}>
          一条龙：填模板 → 精修首帧词 → 首帧 → 释放生图实例显存 → 逐镜（精修出片词 → 接上一镜尾帧 → 出片，失败自动重试 2 次）→ 合成。串行跑，进度看这里。
        </div>
      </div>
    </div>
  );
}
