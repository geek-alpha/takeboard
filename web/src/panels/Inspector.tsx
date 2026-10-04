import { useEffect, useState } from 'react';
import { api, mediaUrl, type Diagnosis, type OptimizeResult, type ReviewResult, type TemplateInfo } from '../api';
import { activeTakeOf, useStore } from '../store';
import { DEFAULT_SETTINGS } from '@shared/types';
import type { Take, TakeNode, TakeParams } from '@shared/types';
import { OPS, opDef, type OpParamDef } from '@shared/ops';

/** 快捷动作：接戏常用的一键操作，不用先去选算子再填参数。 */
const QUICK_OPS: Array<{ op: string; label: string; tip: string; params: Record<string, unknown> }> = [
  { op: 'lastframe', label: '尾帧', tip: '抽最后一帧存成图 —— 下一镜的首帧就是它', params: {} },
  { op: 'firstframe', label: '首帧', tip: '抽第一帧存成图', params: { at: 0 } },
  { op: 'extractaudio', label: '抽音轨', tip: '把片子的声音单独抽成素材', params: { bitrate: '192k' } },
];

/** 算子参数控件：控件形状由 shared/ops.ts 的定义决定，加算子不用再改前端。 */
function OpField({ def, value, onChange }: { def: OpParamDef; value: unknown; onChange: (v: unknown) => void }) {
  const cur = value ?? def.def ?? (def.type === 'bool' ? false : '');
  if (def.type === 'bool') {
    return (
      <div className="field">
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={!!cur} onChange={(e) => onChange(e.target.checked)} style={{ width: 'auto' }} />
          {def.label}
        </label>
      </div>
    );
  }
  if (def.type === 'select') {
    return (
      <div className="field">
        <label>{def.label}</label>
        <select value={String(cur)} onChange={(e) => onChange(e.target.value)}>
          {(def.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (def.type === 'textarea') {
    return (
      <div className="field">
        <label>{def.label}</label>
        <textarea rows={4} value={String(cur)} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  }
  return (
    <div className="field">
      <label>{def.label}</label>
      <input
        type={def.type === 'number' ? 'number' : def.type === 'color' ? 'color' : 'text'}
        step={def.step}
        min={def.min}
        max={def.max}
        value={String(cur)}
        onChange={(e) => onChange(def.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
      />
    </div>
  );
}

function TakeRow({ projectId, node, take, index }: { projectId: string; node: TakeNode; take: Take; index: number }) {
  const activate = useStore((s) => s.activate);
  const deleteTake = useStore((s) => s.deleteTake);
  const [diag, setDiag] = useState<Diagnosis>();
  const [diagBusy, setDiagBusy] = useState(false);
  const isActive = (node.activeTake ?? node.takes[node.takes.length - 1]?.id) === take.id;
  const review = take.params?.aiReview as { score?: number; verdict?: string; issues?: string } | undefined;

  const runDiag = async () => {
    setDiagBusy(true);
    try {
      const out = await api.agentDiagnose({ projectId, nodeId: node.id, takeIds: [take.id] });
      setDiag(out.items[0]);
    } catch (e) {
      setDiag({
        nodeId: node.id,
        nodeTitle: node.title,
        takeId: take.id,
        v: index + 1,
        error: '',
        cause: e instanceof Error ? e.message : String(e),
        fix: '',
        evidence: [],
        from: 'none',
        confidence: 'low',
      });
    } finally {
      setDiagBusy(false);
    }
  };

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 6, padding: '4px 0', borderTop: '1px solid #20232c' }}>
      <span className={`chip${isActive ? ' active' : ''}`} onClick={() => void activate(node.id, take.id)} title="钉为当前版本">
        v{index + 1}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="mono dim" style={{ wordBreak: 'break-all' }}>
          {take.status} · {take.source}
          {take.op ? ` · ${take.op}` : ''} {take.probe ? `· ${take.probe.width}×${take.probe.height} ${take.probe.duration ?? ''}s` : ''}
          {take.params?.aspect ? ` · ${String(take.params.aspect)}` : ''}
        </div>
        <div className="mono" style={{ wordBreak: 'break-all' }}>
          {take.file ?? take.text?.slice(0, 60) ?? ''}
        </div>
        {review?.score !== undefined && (
          <div className="mono dim">
            ✦ 评审 {review.score} 分{review.issues ? ` · 硬伤：${review.issues}` : ''} · {review.verdict}
          </div>
        )}
        {take.error && (
          <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
            <div className="mono err" style={{ flex: 1, wordBreak: 'break-all' }}>
              {take.error.slice(0, 160)}
            </div>
            <button className="ghost" disabled={diagBusy} onClick={() => void runDiag()} title="读错误原文判断原因和改法">
              {diagBusy ? '…' : '✦ 诊断'}
            </button>
          </div>
        )}
        {diag && (
          <div className="mono dim" style={{ borderLeft: '2px solid #7c5cff', paddingLeft: 6 }}>
            原因：{diag.cause}
            {diag.fix && (
              <>
                <br />
                改法：{diag.fix}
              </>
            )}
            {diag.evidence.length > 0 && (
              <>
                <br />
                证据：{diag.evidence[0]}
              </>
            )}
          </div>
        )}
        {take.file && take.kind === 'image' && (
          <img src={mediaUrl(projectId, take.file)} style={{ width: 64, borderRadius: 4, marginTop: 4 }} />
        )}
      </div>
      <button className="ghost" title="删掉这一版" onClick={() => void deleteTake(node.id, take.id)}>
        ✕
      </button>
    </div>
  );
}

/**
 * 提示词优化器：就地出候选，点一条直接填回去。
 * target=video 时走 i2v 语境（只写运动/运镜），target=image 走静态画面语境——两套规则在 server/prompts.ts。
 */
function PromptOptimizer({
  value,
  target,
  nodeId,
  seconds,
  ratio,
  onPick,
}: {
  value: string;
  target: 'image' | 'video';
  nodeId: string;
  /** 出片时长/画幅：H3 靠它算镜头预算与画幅，生图不用 */
  seconds?: number;
  ratio?: string;
  onPick: (text: string) => void;
}) {
  const project = useStore((s) => s.project);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState('');
  const [refine, setRefine] = useState('');
  const [rewrite, setRewrite] = useState(false);
  const [refs, setRefs] = useState('');
  const [autoRefs, setAutoRefs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<OptimizeResult>();
  const [err, setErr] = useState('');

  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      setOut(
        await api.agentOptimize({
          idea: value,
          target,
          count: 3,
          style: style || undefined,
          refine: refine || undefined,
          current: value.trim() ? value : undefined,
          mode: rewrite ? 'rewrite' : undefined,
          context: project ? `项目「${project.name}」` : undefined,
          projectId: project?.id,
          nodeId,
          refs: refs
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          autoRefs,
          seconds: seconds && seconds > 0 ? seconds : undefined,
          ratio: ratio ? ratio.split(' ')[0] : undefined,
        }),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="ghost" style={{ marginTop: 6 }} onClick={() => setOpen(true)} title="让内置助手看着已出的画面把这段想法写成专业提示词">
        ✦ AI 优化{target === 'video' ? '（出片语境）' : '（生图语境）'}
      </button>
    );
  }

  return (
    <div className="optimizer">
      <div className="row">
        <input placeholder="风格倾向（可空，如 电影感 / 手绘）" value={style} onChange={(e) => setStyle(e.target.value)} />
        <button className="ghost" onClick={() => setOpen(false)}>
          收起
        </button>
      </div>
      <input placeholder="改进要求（可空，如 更暗更压抑 / 换成低机位）" value={refine} onChange={(e) => setRefine(e.target.value)} />
      {value.trim() ? (
        <label className="mono dim" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={rewrite} onChange={(e) => setRewrite(e.target.checked)} />
          允许重写（放开既有设定；默认精修：设定冻结、只做规范化、改动逐条报）
        </label>
      ) : null}
      <label className="mono dim" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={autoRefs} onChange={(e) => setAutoRefs(e.target.checked)} />
        自动参考已有画面（上游产物 · 相邻镜头 · 出片节点带首帧）
      </label>
      <input
        placeholder="额外参考（可空）：节点名@v2 / take_xxx / D:\参考图.png"
        value={refs}
        onChange={(e) => setRefs(e.target.value)}
      />
      <button className="primary" disabled={busy} onClick={() => void go()}>
        {busy ? '优化中…（要看参考图，等十几秒）' : '生成候选'}
      </button>
      {err && <div className="mono err">{err}</div>}
      {out?.warn && <div className="mono err">{out.warn}</div>}
      {out &&
        (out.refsUsed?.length ? (
          <div className="mono dim">
            参考 {out.refsUsed.length} 张：{out.refsUsed.join('；')}
            {out.storyUsed ? ' · 带剧情线' : ''}
          </div>
        ) : (
          <div className="mono dim">这次没有参考画面（项目里还没有可用产物）——跨镜连贯没法保证</div>
        ))}
      {out?.skipped?.length ? <div className="mono dim">没给上的：{out.skipped.join('；')}</div> : null}
      {out?.tips && <div className="dim">{out.tips}</div>}
      {out?.candidates.map((c, i) => (
        <div key={i} className="cand" onClick={() => onPick(c.text)} title="点一下用这条">
          <div className="mono dim">
            候选 {i + 1}
            {out.mode === 'refine' ? ' · 精修' : ''}
            {c.note ? ` · ${c.note}` : ''}
          </div>
          <div>{c.text}</div>
          {c.changes?.length ? <div className="mono dim">改动 {c.changes.length} 处：{c.changes.join('；')}</div> : null}
        </div>
      ))}
      {out?.negative && <div className="mono dim">负面词：{out.negative}</div>}
    </div>
  );
}

function NodeEditor({ node, projectId, templates }: { node: TakeNode; projectId: string; templates: TemplateInfo[] }) {
  const run = useStore((s) => s.run);
  const sweep = useStore((s) => s.sweep);
  const replay = useStore((s) => s.replay);
  const putText = useStore((s) => s.putText);
  const importPath = useStore((s) => s.importPath);
  const patchNode = useStore((s) => s.patchNode);
  const deleteNode = useStore((s) => s.deleteNode);
  const busy = useStore((s) => s.busy);
  const active = activeTakeOf(node);
  // 空着的时长要显示项目默认（后端跑起来用的就是它），别显示一个跟实际不符的数
  const defSeconds = useStore((s) => s.project?.settings?.videoSeconds ?? DEFAULT_SETTINGS.videoSeconds);
  const [form, setForm] = useState<TakeParams>({});
  const [importField, setImportField] = useState('');
  const [text, setText] = useState(active?.text ?? '');
  const [op, setOp] = useState('concat');
  const [opParams, setOpParams] = useState<Record<string, unknown>>({});
  const [opErr, setOpErr] = useState('');
  const opD = opDef(op);

  /** 跑算子：成功后刷新画布，新产物就躺在 take 栈里等切引脚。 */
  const execOp = async (which: string, params: Record<string, unknown>) => {
    const p = useStore.getState().project;
    if (!p) return;
    setOpErr('');
    try {
      await api.op(p.id, node.id, which, params);
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e));
    }
    await useStore.getState().refresh();
  };
  const [count, setCount] = useState(4);
  const [review, setReview] = useState<ReviewResult>();
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewErr, setReviewErr] = useState('');
  const activate = useStore((s) => s.activate);
  const [frameSrc, setFrameSrc] = useState<{ frame?: { file: string; nodeId: string; takeId: string }; blockedBy?: string }>();
  const [handoffMsg, setHandoffMsg] = useState('');
  const [handoffErr, setHandoffErr] = useState('');
  const project = useStore((s) => s.project);

  const doReview = async () => {
    setReviewBusy(true);
    setReviewErr('');
    try {
      setReview(await api.agentReview({ projectId, nodeId: node.id, max: 6 }));
    } catch (e) {
      setReviewErr(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewBusy(false);
    }
  };

  /** 接戏：本镜尾帧 → 下一镜首帧。真在画布上建节点和连线，不是内部偷接。 */
  const doHandoff = async () => {
    setHandoffErr('');
    setHandoffMsg('');
    try {
      const out = await api.handoff(projectId, { from: node.id });
      setHandoffMsg(`已接到「${out.to.title}」：节点「${out.frameNode.title}」正在抽尾帧，跑完再出片就开在它上面`);
      await useStore.getState().refresh();
    } catch (e) {
      setHandoffErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    setForm({ ...(active?.params ?? {}) });
    setText(active?.text ?? '');
  }, [active?.id, node.id]);

  // 首帧来源要能看见：接戏接没接上、卡在哪个节点，一眼看得出来
  useEffect(() => {
    if (node.kind !== 'video') {
      setFrameSrc(undefined);
      return;
    }
    let alive = true;
    api
      .firstFrame(projectId, node.id)
      .then((r) => {
        if (alive) setFrameSrc(r);
      })
      .catch(() => {
        if (alive) setFrameSrc(undefined);
      });
    return () => {
      alive = false;
    };
  }, [projectId, node.id, node.kind, active?.id, node.takes.length, project?.rev]);

  const frameFrom = frameSrc?.frame ? project?.nodes.find((n) => n.id === frameSrc.frame!.nodeId) : undefined;
  const frameFromTake = frameFrom?.takes.findIndex((t) => t.id === frameSrc?.frame?.takeId) ?? -1;

  const num = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value === '' ? undefined : Number(value) }));
  const str = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const isText = node.kind === 'text' || node.kind === 'note';
  const isOp = node.kind === 'op';

  const port = (u?: string) => {
    try {
      return u ? new URL(u).port : '';
    } catch {
      return '';
    }
  };
  const settings = useStore.getState().project?.settings;
  const wantPort = port(node.kind === 'video' ? settings?.comfyHost : settings?.imageHost);
  // 模板按实例过滤：生图节点不该看见只装了 H3 的 8188 模板，反之亦然
  const usable = templates.filter((t) => !t.host || !wantPort || t.host.includes(wantPort));
  const fallback = (node.kind === 'video' ? settings?.workflowVideo : settings?.workflowImage) ?? '—';
  // 比例：模板用 ResolutionSelector 时宽高数值旋钮没有落点，只能给档位名。
  // 档位表来自后端 info.aspectOptions（唯一真相源），别在前端再抄一份。
  const tinfo = usable.find((t) => t.id === (String(form.workflow ?? '') || fallback));
  const aspectOptions = tinfo?.bindings.some((b) => b.role === 'aspect') ? (tinfo.aspectOptions ?? []) : [];

  return (
    <>
      <div className="section">
        <h3>节点</h3>
        <div className="field">
          <label>标题</label>
          <input value={node.title} onChange={(e) => void patchNode(node.id, { title: e.target.value })} />
        </div>
        <div className="row wrap">
          <span className="pill">{node.kind}</span>
          <span className="pill mono">{node.id}</span>
          <span className="pill">{node.takes.length} 版</span>
        </div>
      </div>

      {isText ? (
        <div className="section">
          <h3>提示词（保存即成新 take）</h3>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy} onClick={() => void putText(node.id, text)}>
              保存为新 take
            </button>
          </div>
          <PromptOptimizer value={text} target="image" nodeId={node.id} onPick={setText} />
        </div>
      ) : isOp ? (
        <div className="section">
          <h3>算子</h3>
          <div className="field">
            <label>算子</label>
            <select
              value={op}
              onChange={(e) => {
                setOp(e.target.value);
                setOpParams({});
              }}
            >
              {OPS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id} · {o.name}
                </option>
              ))}
            </select>
            {opD && (
              <div className="mono dim">
                {opD.hint} · 吃 {opD.takes.join('+')} · 出 {opD.produces}
              </div>
            )}
          </div>
          <div className="row wrap" style={{ marginBottom: 8 }}>
            {QUICK_OPS.map((q) => (
              <button key={q.op} className="ghost" disabled={busy} title={q.tip} onClick={() => void execOp(q.op, q.params)}>
                ⚡ {q.label}
              </button>
            ))}
          </div>
          {(opD?.params ?? []).map((p) => (
            <OpField key={p.key} def={p} value={opParams[p.key]} onChange={(v) => setOpParams((s) => ({ ...s, [p.key]: v }))} />
          ))}
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void execOp(op, opParams)}>
              执行算子
            </button>
          </div>
          {opErr && (
            <div className="mono err" style={{ marginTop: 6 }}>
              {opErr}
            </div>
          )}
        </div>
      ) : (
        <div className="section">
          <h3>参数（改完点「跑一版」→ 新增 take）</h3>
          <div className="field">
            <label>提示词</label>
            <textarea value={String(form.prompt ?? '')} rows={6} onChange={(e) => str('prompt', e.target.value)} />
          </div>
          <PromptOptimizer
            value={String(form.prompt ?? '')}
            target={node.kind === 'video' ? 'video' : 'image'}
            nodeId={node.id}
            seconds={Number(form.seconds) || undefined}
            ratio={form.aspect ? String(form.aspect) : undefined}
            onPick={(t) => str('prompt', t)}
          />
          <div className="grid2">
            <div className="field">
              <label>模板</label>
              <select value={String(form.workflow ?? '')} onChange={(e) => str('workflow', e.target.value)}>
                <option value="">默认 · {fallback}</option>
                {usable.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>抽卡张数</label>
              <input
                type="number"
                value={String(count)}
                onChange={(e) => setCount(Math.max(1, Math.min(24, Number(e.target.value) || 1)))}
              />
            </div>
          </div>
          <div className="grid2">
            <div className="field">
              <label>种子 seed</label>
              <input type="number" value={String(form.seed ?? '')} onChange={(e) => num('seed', e.target.value)} />
            </div>
            <div className="field">
              <label>步数 steps</label>
              <input type="number" value={String(form.steps ?? '')} onChange={(e) => num('steps', e.target.value)} />
            </div>
            <div className="field">
              <label>宽</label>
              <input type="number" value={String(form.width ?? '')} onChange={(e) => num('width', e.target.value)} />
            </div>
            <div className="field">
              <label>高</label>
              <input type="number" value={String(form.height ?? '')} onChange={(e) => num('height', e.target.value)} />
            </div>
            {aspectOptions.length > 0 && (
              <div className="field">
                <label>比例</label>
                <select value={String(form.aspect ?? '')} onChange={(e) => str('aspect', e.target.value)}>
                  <option value="">跟随首帧（自动）</option>
                  {aspectOptions.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {node.kind === 'video' && (
              <>
                <div className="field">
                  <label>时长 s</label>
                  <input type="number" step="0.5" value={String(form.seconds ?? defSeconds)} onChange={(e) => num('seconds', e.target.value)} />
                </div>
                <div className="field">
                  <label>超时 s</label>
                  <input type="number" value={String(form.timeoutS ?? 2400)} onChange={(e) => num('timeoutS', e.target.value)} />
                </div>
              </>
            )}
          </div>
          <div className="row wrap">
            <button className="primary" disabled={busy} onClick={() => void run(node.id, form)}>
              ▶ 跑一版
            </button>
            <button disabled={busy} onClick={() => void sweep(node.id, count, form)}>
              ⚄ 抽 {count} 版
            </button>
            <button disabled={busy} onClick={() => void replay(node.id)}>
              ⟳ 沿链重演下游
            </button>
            {node.kind === 'video' && (
              <button disabled={busy} onClick={() => void doHandoff()} title="把这一镜的结尾接成下一镜的第 0 帧（画布上多出尾帧节点 + 一条显式首帧连线）">
                ⤳ 尾帧接下一镜
              </button>
            )}
            <button className="ghost" disabled={busy} onClick={() => void deleteNode(node.id)}>
              删节点
            </button>
          </div>
          <div className="dim" style={{ marginTop: 6 }}>
            当前用模板：{String(form.workflow ?? '') || fallback}
          </div>
          {node.kind === 'video' && (
            <div className="dim">
              首帧：
              {frameSrc?.frame
                ? `← 「${frameFrom?.title ?? '未知节点'}」${frameFromTake >= 0 ? ` v${frameFromTake + 1}` : ''}`
                : frameSrc?.blockedBy
                  ? `接的是「${frameSrc.blockedBy}」，但它还没跑完/没成 —— 等它 done 再出片`
                  : '还没有：把图片节点连进来，或点上面的「⤳ 尾帧接下一镜」'}
            </div>
          )}
          {handoffMsg && <div className="mono dim">{handoffMsg}</div>}
          {handoffErr && <div className="mono err">{handoffErr}</div>}
          {aspectOptions.length > 0 && (
            <div className="dim">
              比例：
              {active?.params?.aspect
                ? `${String(active.params.aspect)}（${String(active.params.aspectFrom ?? '—')}）`
                : '还没跑过 · 跑一版会按首帧实际比例自动定档'}
            </div>
          )}
        </div>
      )}

      <div className="section">
        <h3>登记已有素材</h3>
        <div className="row">
          <input placeholder="绝对路径，如 D:\...\shot-01.mp4" value={importField} onChange={(e) => setImportField(e.target.value)} />
          <button disabled={busy || !importField} onClick={() => void importPath(node.id, importField)}>
            登记
          </button>
        </div>
      </div>

      <div className="section">
        <h3>take 栈（点 v 号切引脚）</h3>
        <div className="row wrap" style={{ marginBottom: 6 }}>
          <button className="ghost" disabled={reviewBusy || node.takes.length < 2} onClick={() => void doReview()} title="把最近几版压成缩略图送进模型看图打分，挑出该留的那张">
            {reviewBusy ? '评审中…（要看图，等十几秒）' : '✦ AI 评审最近 6 版'}
          </button>
          {review?.best && (
            <button className="ghost" disabled={reviewBusy} onClick={() => void activate(node.id, review.best!)}>
              用最优 v{review.scores[0]?.v}（{review.scores[0]?.score} 分）
            </button>
          )}
        </div>
        {reviewErr && <div className="mono err">{reviewErr}</div>}
        {review && (
          <div className="cand" style={{ cursor: 'default' }}>
            {review.scores.map((s) => (
              <div key={s.takeId} className="mono" style={{ marginBottom: 2 }}>
                <span className="chip">v{s.v}</span> {s.score} 分{s.issues ? ` · 硬伤：${s.issues}` : ''} · <span className="dim">{s.verdict}</span>
              </div>
            ))}
            <div className="dim">最优 v{review.scores[0]?.v}：{review.reason}</div>
            {review.refs?.length ? <div className="mono dim">对照画面：{review.refs.join('；')}</div> : null}
            {review.skipped.length > 0 && <div className="mono dim">没评：{review.skipped.join('、')}</div>}
          </div>
        )}
        {node.takes.length === 0 && <div className="dim">空的</div>}
        {node.takes.map((t, i) => (
          <TakeRow key={t.id} projectId={projectId} node={node} take={t} index={i} />
        ))}
      </div>

      {active && Object.keys(active.inputs ?? {}).length > 0 && (
        <div className="section">
          <h3>这一版的来历（provenance）</h3>
          {Object.entries(active.inputs).map(([nodeId, takeId]) => {
            const up = useStore.getState().project?.nodes.find((n) => n.id === nodeId);
            const idx = up?.takes.findIndex((t) => t.id === takeId) ?? -1;
            return (
              <div key={nodeId} className="mono dim">
                {up?.title ?? nodeId} → v{idx + 1}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export function Inspector() {
  const project = useStore((s) => s.project);
  const selected = useStore((s) => s.selected);
  const templates = useStore((s) => s.templates);
  const refresh = useStore((s) => s.refresh);
  const busy = useStore((s) => s.busy);
  const setSelected = useStore((s) => s.setSelected);
  const node = project?.nodes.find((n) => n.id === selected);

  if (!project) return <div className="inspector dim">没有项目</div>;

  if (!node) {
    return (
      <div className="inspector">
        <div className="section">
          <h3>工作台</h3>
          <div className="mono dim">{project.id}</div>
          <div className="dim">节点 {project.nodes.length} · 连接 {project.edges.length} · rev {project.rev}</div>
        </div>
        <div className="section">
          <h3>模板</h3>
          {templates.map((t) => (
            <div key={t.id} className="row" style={{ gap: 6 }}>
              <span className="pill" style={{ borderColor: t.default ? '#7c5cff' : undefined }}>
                {t.id}
              </span>
              <span className="dim">{t.nodeCount} 节点 · {t.bindings.length} 旋钮{t.host ? ` · ${t.host}` : ''}</span>
            </div>
          ))}
        </div>
        <div className="section">
          <h3>节点清单（点一行打开检查器）</h3>
          {project.nodes.map((n) => (
            <div key={n.id} className="row" style={{ gap: 6, cursor: 'pointer' }} onClick={() => setSelected(n.id)} title="点一下在检查器里打开这个节点">
              <span className="chip">{n.kind}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title}</span>
              <span className="dim">{n.takes.length}</span>
            </div>
          ))}
        </div>
        <div className="section">
          <h3>操作提示</h3>
          <div className="dim">
            · 空白处双击 → 加图片节点<br />
            · 从节点右侧圆点拖到另一个节点 → 连线<br />
            · 点连线 → 在「跟版」和「钉死某版」之间切<br />
            · 点节点上的 v 号 → 切引脚（下游没钉死就跟着变）<br />
            · 「⟳ 下游」→ 从该节点起沿链全部重跑
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="inspector">
      <NodeEditor node={node} projectId={project.id} templates={templates} />
      <div className="row">
        <button className="ghost" disabled={busy} onClick={() => void refresh()}>
          刷新
        </button>
      </div>
    </div>
  );
}
