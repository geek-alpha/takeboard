import { useCallback, useEffect, useRef, useState } from 'react';
import { api, mediaUrl } from '../api';
import { useStore } from '../store';
import { opDef } from '@shared/ops';
import { DEFAULT_SETTINGS, type SequenceView, type TransitionSettings } from '@shared/types';

/** 过渡候选从算子定义取 —— 前端不再另维护一份，跟后端跑的是同一份清单 */
const TRANSITIONS: Array<{ value: string; label: string }> = [
  { value: 'none', label: '硬切' },
  ...(opDef('xfade')?.params.find((p) => p.key === 'transition')?.options ?? []).map((o) => ({ value: o, label: o })),
];

/** 秒 → m:ss.s */
function clock(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

/**
 * 预览台：画布上的镜头按剧情顺序（x 轴）连着播，剪哪一镜当场就看哪一镜，不用先渲染成片。
 *
 * 两个 video 元素轮换用：当前镜在播，另一个槽偷偷把下一镜 preload 好，切镜时不黑屏。
 * 「出成片」不是在这里偷偷合成 —— 它在画布上建一个算子节点把镜头连上去跑拼接，产物照样进 take 栈。
 */
export function PreviewBar() {
  const project = useStore((s) => s.project);
  const busy = useStore((s) => s.busy);
  const [seq, setSeq] = useState<SequenceView>();
  const [err, setErr] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [endNode, setEndNode] = useState('');
  const [idx, setIdx] = useState(0);
  const [slot, setSlot] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [pos, setPos] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [handoffMsg, setHandoffMsg] = useState('');
  const [trans, setTrans] = useState<TransitionSettings>(DEFAULT_SETTINGS.transition!);
  const syncedFor = useRef('');
  const refA = useRef<HTMLVideoElement | null>(null);
  const refB = useRef<HTMLVideoElement | null>(null);
  const refs = [refA, refB];
  /** 正在交叉叠化的两槽：from 淡出、to 淡入。null = 没在过渡 */
  const [cross, setCross] = useState<{ from: number; to: number } | null>(null);

  const projectId = project?.id;
  const rev = project?.rev;

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      setSeq(await api.sequence(projectId, endNode || undefined));
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, endNode]);

  useEffect(() => {
    void reload();
  }, [reload, rev]);

  // 过渡是项目级设置：只在切项目时把磁盘上的值读进来，不覆盖正在改的那个数
  useEffect(() => {
    if (!project || syncedFor.current === project.id) return;
    syncedFor.current = project.id;
    setTrans(project.settings.transition ?? DEFAULT_SETTINGS.transition!);
  }, [project]);

  const saveTrans = async (next: TransitionSettings) => {
    setTrans(next);
    if (!project) return;
    try {
      await api.saveProject({ ...project, settings: { ...project.settings, transition: next } });
      await useStore.getState().refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const shots = seq?.shots ?? [];
  const shot = shots[idx];
  const src = shot && projectId ? mediaUrl(projectId, shot.file) : undefined;

  /**
   * 过渡收尾。reset=true 用于中断（暂停/跳镜）：下一槽退回起点。
   * 正常播完那一下不能 reset —— 下一槽这时已经是当前镜，它得接着自己的进度往下播。
   */
  const clearCross = (reset: boolean) => {
    if (reset && cross) {
      const toEl = refs[cross.to].current;
      if (toEl) {
        toEl.pause();
        toEl.currentTime = 0;
      }
    }
    setCross(null);
  };

  /** 预览里的过渡时长：跟后端同一套收紧规则（不超过较短那一镜的一半），免得太长把镜头吃光 */
  const effT = (i: number) => {
    if (trans.type === 'none') return 0;
    const a = shots[i];
    const b = shots[i + 1];
    if (!a || !b) return 0;
    return Math.max(0, Math.min(trans.duration, Math.min(a.duration, b.duration) / 2));
  };

  /**
   * 镜尾前 T 秒就把另一槽起播 —— 两个 video 同时跑，才叫真叠化。
   * 以前是等这镜播完（画面已经僵在最后一帧）再淡入下一镜，动的先停住，看着假。
   */
  const onTick = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const el = e.currentTarget;
    if (el !== refs[slot].current) return;
    setPos(el.currentTime);
    if (!playing || cross) return;
    const T = effT(idx);
    const next = shots[idx + 1];
    const dur = el.duration;
    if (T <= 0 || !next || !projectId || !Number.isFinite(dur) || dur <= 0) return;
    const remain = dur - el.currentTime;
    if (remain > T || remain <= 0.03) return;
    const to = 1 - slot;
    const toEl = refs[to].current;
    if (!toEl) return;
    const nextSrc = mediaUrl(projectId, next.file);
    if (toEl.getAttribute('src') !== nextSrc) toEl.src = nextSrc;
    toEl.currentTime = 0;
    void toEl.play().catch(() => {});
    setCross({ from: slot, to });
  };

  /** 交叉中的两槽各挂什么类：CSS 负责淡出淡入，React 只决定什么时候开始、什么时候收 */
  const slotClass = (s: number) => {
    const cls = [slot === s ? 'on' : ''];
    if (cross?.to === s) cls.push('cross-in');
    if (cross?.from === s) cls.push('cross-out');
    return cls.filter(Boolean).join(' ');
  };

  /** 交叉的时长（秒）：交给 CSS transition，跟后端收紧后的值一致 */
  const crossT = cross ? effT(idx) : 0;

  // 换镜：当前槽加载并接着播，另一个槽把下一镜预载好
  useEffect(() => {
    const cur = refs[slot].current;
    const other = refs[1 - slot].current;
    if (!cur) return;
    if (!src) {
      cur.removeAttribute('src');
      return;
    }
    if (cur.getAttribute('src') !== src) {
      clearCross(true);
      cur.src = src;
      cur.currentTime = 0;
      setPos(0);
    }
    const next = shots[idx + 1];
    if (other) {
      if (next && projectId) {
        const nextSrc = mediaUrl(projectId, next.file);
        if (other.getAttribute('src') !== nextSrc) {
          other.src = nextSrc;
          other.load();
        }
      } else {
        other.removeAttribute('src');
      }
    }
    // refs 是两个固定 ref，不需要进依赖
  }, [src, slot, idx, projectId]);

  useEffect(() => {
    const cur = refs[slot].current;
    const other = refs[1 - slot].current;
    if (!playing) {
      clearCross(true);
      cur?.pause();
      return;
    }
    // 另一槽只在叠化时当"上一帧"用，已经淡出的别再耗解码
    if (other && !other.paused) other.pause();
    if (!cur) return;
    void cur.play().catch(() => setPlaying(false));
  }, [playing, slot, idx, src]);

  /** 一镜播完接下一镜：换槽 = 播的正是刚预载好的那一个。 */
  const advance = (el?: HTMLVideoElement) => {
    // 叠化时下一槽已经在播了，它播完不算一镜结束（不然会连跳两镜）
    if (el && el !== refs[slot].current) return;
    clearCross(false);
    if (idx + 1 < shots.length) {
      setSlot((s) => 1 - s);
      setIdx((i) => i + 1);
      setPlaying(true);
    } else {
      setPlaying(false);
    }
  };

  const goto = (i: number, autoplay = true) => {
    if (!shots.length) return;
    clearCross(true);
    const target = Math.max(0, Math.min(shots.length - 1, i));
    if (target === idx) {
      const cur = refs[slot].current;
      if (cur) cur.currentTime = 0;
      setPos(0);
      setPlaying(autoplay);
      return;
    }
    if (target === idx + 1) setSlot((s) => 1 - s);
    setIdx(target);
    setPlaying(autoplay);
  };

  const doExport = async () => {
    if (!projectId) return;
    setExporting(true);
    setErr('');
    try {
      await api.exportFilm(projectId, { end: endNode || undefined });
      await useStore.getState().refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const doHandoff = async () => {
    if (!projectId || !shot) return;
    setErr('');
    setHandoffMsg('');
    try {
      const out = await api.handoff(projectId, { from: shot.nodeId });
      setHandoffMsg(
        `接戏：「${out.from.title}」v${out.from.index} 的尾帧 → 「${out.to.title}」的首帧（节点「${out.frameNode.title}」正在抽帧，跑完再出片就开在这张尾帧上）`,
      );
      await useStore.getState().refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const total = seq?.totalSeconds ?? 0;
  const before = shots.slice(0, idx).reduce((a, s) => a + s.duration, 0);
  const elapsed = before + pos;
  const joints = Math.max(0, shots.length - 1);
  // 成片时长：每处过渡吃掉 duration 秒重叠
  const filmSeconds = trans.type === 'none' ? total : Math.max(0, total - trans.duration * joints);

  return (
    <div className={`preview-bar${collapsed ? ' collapsed' : ''}`}>
      <div className="pv-head" onClick={() => setCollapsed((c) => !c)}>
        <b>预览台</b>
        <span className="mono dim">{seq ? `${shots.length} 镜 · 成片 ${clock(filmSeconds)}` : '…'}</span>
        {seq?.skipped.length ? <span className="mono pv-warn">缺 {seq.skipped.map((s) => s.title).join('、')}</span> : null}
        <span className="spacer" />
        <span className="mono dim">{collapsed ? '▸ 展开' : '▾ 收起'}</span>
      </div>
      {!collapsed && (
        <div className="pv-body">
          <div
            className={`pv-stage${cross ? ' crossing' : ''}`}
            style={{ '--xfade': `${trans.type === 'none' ? 0 : trans.duration}s`, '--xt': `${crossT}s` } as React.CSSProperties}
          >
            <video ref={refA} className={slotClass(0)} playsInline muted={muted} onEnded={(e) => advance(e.currentTarget)} onTimeUpdate={onTick} />
            <video ref={refB} className={slotClass(1)} playsInline muted={muted} onEnded={(e) => advance(e.currentTarget)} onTimeUpdate={onTick} />
            {!shot && <div className="pv-empty">画布上还没有能播的镜头 —— 出片节点跑出至少一版，这里就能连着看</div>}
          </div>
          <div className="pv-side">
            <div className="row" style={{ gap: 5 }}>
              <button onClick={() => goto(idx - 1)} disabled={!shots.length} title="上一镜">
                ⏮
              </button>
              <button className="primary" onClick={() => setPlaying((p) => !p)} disabled={!shots.length} title="播放 / 暂停">
                {playing ? '⏸' : '▶'}
              </button>
              <button onClick={() => goto(idx + 1)} disabled={!shots.length} title="下一镜">
                ⏭
              </button>
              <button className="ghost" onClick={() => setMuted((m) => !m)} title="预览静音">
                {muted ? '🔇' : '🔊'}
              </button>
              <span className="mono dim">
                {clock(elapsed)} / {clock(total)}
              </span>
              {shots.length > 0 && (
                <span className="mono dim">
                  第 {idx + 1}/{shots.length} 镜
                </span>
              )}
              {shot && (
                <button
                  className="ghost"
                  disabled={busy || idx + 1 >= shots.length}
                  onClick={() => void doHandoff()}
                  title="把这一镜的结尾接成下一镜的第 0 帧：画布上会多出尾帧节点和一条显式首帧连线"
                >
                  ⤳ 接下一镜
                </button>
              )}
            </div>
            <div className="row" style={{ gap: 5, marginTop: 6 }}>
              <select
                value={trans.type}
                onChange={(e) => void saveTrans({ ...trans, type: e.target.value })}
                title="出成片时镜与镜之间的过渡：存进项目，以后每次出片都按它"
              >
                {TRANSITIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    过渡：{t.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                style={{ width: 62 }}
                step={0.1}
                min={0.05}
                max={5}
                value={trans.duration}
                disabled={trans.type === 'none'}
                onChange={(e) => void saveTrans({ ...trans, duration: Number(e.target.value) || 0.5 })}
                title="每处过渡时长（秒）；成片时长 = 各镜之和 − 这个数 × 过渡处数"
              />
              <span className="mono dim">s</span>
              {trans.type !== 'none' && (
                <span className="mono dim" title="预览台用叠化近似：成片里才是这个过渡的真效果">
                  预览按叠化
                </span>
              )}
            </div>
            <div className="row" style={{ gap: 5, marginTop: 6 }}>
              <select value={endNode} onChange={(e) => setEndNode(e.target.value)} title="只看以这个节点为结尾的上游镜头">
                <option value="">全画布（按 x 排剧情）</option>
                {(project?.nodes ?? [])
                  .filter((n) => n.takes.some((t) => t.kind === 'video'))
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      到「{n.title}」为止
                    </option>
                  ))}
              </select>
              <button disabled={busy || exporting || !shots.length} onClick={() => void doExport()} title="照这条序列在画布上建算子节点并拼成一条片子">
                {exporting ? '…' : '⤓ 出成片'}
              </button>
              <button className="ghost" onClick={() => void reload()} title="重排序列">
                ⟳
              </button>
            </div>
            <div className="mono dim" style={{ marginTop: 6 }}>
              {seq?.source}
            </div>
            {handoffMsg && (
              <div className="mono dim" style={{ marginTop: 4 }}>
                {handoffMsg}
              </div>
            )}
            {err && (
              <div className="mono err" style={{ marginTop: 4 }}>
                {err}
              </div>
            )}
          </div>
          <div className="tl">
            {shots.map((s, i) => (
              <button
                key={s.takeId}
                className={`tl-shot${i === idx ? ' on' : ''}`}
                style={{ flexGrow: Math.max(s.duration, 1) }}
                onClick={() => goto(i)}
                title={`${s.title} v${s.index} · ${s.duration.toFixed(1)}s${s.hasAudio ? ' · 有声音' : ''}`}
              >
                {s.poster && projectId ? <img src={mediaUrl(projectId, s.poster)} alt="" /> : <span className="tl-blank" />}
                <span className="tl-label">
                  {s.title} <i>v{s.index}</i>
                </span>
                <span className="tl-dur">{s.duration.toFixed(1)}s</span>
                {i === idx && <span className="tl-head" style={{ width: `${s.duration ? Math.min(100, (pos / s.duration) * 100) : 0}%` }} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
