import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type DefaultsPayload, type LlmConfigPatch, type LlmConfigPublic, type LlmTestResult } from '../api';
import { useStore } from '../store';
import { DEFAULT_SETTINGS } from '@shared/types';
import type { InstanceRecipe, InstanceStatus, ProjectSettings } from '@shared/types';

/**
 * 设置面板。两块分开，分界线是「换项目还要不要重配」：
 * - 机器级：两个 ComfyUI 实例（生图 8888 / 出片 8188）的启停配方，落 data/machine.json
 * - 项目级：模型/工作流模板、ffmpeg 路径、出片前要不要释放生图实例，落当前项目 settings
 */

const fmtVram = (n?: number) => (n ? `${(n / 1e9).toFixed(1)}G` : '—');

export function SettingsPanel() {
  const project = useStore((s) => s.project);
  const refresh = useStore((s) => s.refresh);
  const [status, setStatus] = useState<InstanceStatus[]>([]);
  const [recipes, setRecipes] = useState<InstanceRecipe[]>([]);
  const [selfPort, setSelfPort] = useState(0);
  const [pset, setPset] = useState<ProjectSettings | null>(null);
  const [llm, setLlm] = useState<LlmConfigPublic | null>(null);
  const [llmForm, setLlmForm] = useState<LlmConfigPatch>({});
  // key 永远从空开始：界面拿不到真 key，只在 placeholder 里显示脱敏串
  const [llmKey, setLlmKey] = useState('');
  const [llmTest, setLlmTest] = useState<LlmTestResult | null>(null);
  const [defaults, setDefaults] = useState<DefaultsPayload | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  // 正在手改配方时别让 5s 轮询把手打的字盖回去
  const dirty = useRef(false);

  const reload = useCallback(async () => {
    try {
      const r = await api.machine();
      setStatus(r.instances);
      setSelfPort(r.selfPort);
      if (!dirty.current) setRecipes(r.instances.map((i) => i.recipe));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [reload]);

  useEffect(() => {
    if (project) setPset({ ...project.settings });
  }, [project?.id]);

  useEffect(() => {
    void (async () => {
      try {
        const c = await api.llm();
        setLlm(c);
        setLlmForm({ baseUrl: c.baseUrl, model: c.model, temperature: c.temperature, maxTokens: c.maxTokens, timeoutMs: c.timeoutMs });
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    void api
      .defaults()
      .then(setDefaults)
      .catch(() => undefined);
  }, []);

  const patchRecipe = (i: number, patch: Partial<InstanceRecipe>) => {
    dirty.current = true;
    setRecipes((prev) => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  };
  const patchPset = (patch: Partial<ProjectSettings>) => setPset((prev) => (prev ? { ...prev, ...patch } : prev));

  const act = async (id: string, what: 'start' | 'stop') => {
    setBusy(`${what}:${id}`);
    setErr('');
    setMsg(what === 'start' ? `${id} 启动中…模型加载要几十秒，先别关这个页面` : `${id} 关闭中…`);
    try {
      if (what === 'start') {
        const r = await api.startInstance(id);
        setMsg(r.detail);
        if (!r.ok && r.log) setErr(r.log);
      } else {
        const r = await api.stopInstance(id);
        if (r.busy) {
          // 有作业在跑：关掉就是打断它们，让人自己点头
          if (confirm(`${r.detail}\n\n确定要关掉它吗？`)) {
            setMsg('带 force 再关一次…');
            setMsg((await api.stopInstance(id, true)).detail);
          } else {
            setMsg('没关。');
          }
        } else {
          setMsg(r.detail);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
      void reload();
    }
  };

  const saveRecipes = async () => {
    setErr('');
    try {
      const r = await api.saveMachine(recipes);
      dirty.current = false;
      setRecipes(r.instances);
      setMsg('实例配方已存 data/machine.json');
      void reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const saveProjectSettings = async () => {
    if (!project || !pset) return;
    setErr('');
    try {
      await api.saveProject({ ...project, settings: pset });
      setMsg('项目设置已存');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const saveLlmSettings = async () => {
    setErr('');
    setLlmTest(null);
    try {
      const key = llmKey.trim();
      const c = await api.saveLlm({ ...llmForm, ...(key ? { apiKey: key } : {}) });
      setLlm(c);
      setLlmKey('');
      setMsg(`LLM 配置已存 ${c.file}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const clearLlmKey = async () => {
    setErr('');
    setLlmTest(null);
    try {
      setLlm(await api.saveLlm({ clearApiKey: true }));
      setLlmKey('');
      setMsg('已从 data/llm.json 里删掉 key（环境变量或 .env 里的还在）');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const runLlmTest = async () => {
    setBusy('llm-test');
    setLlmTest(null);
    try {
      setLlmTest(await api.testLlm());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  /** 把当前项目的这一套存成「本机默认」，以后新建的项目直接带着它出生。 */
  const saveAsDefaults = async () => {
    if (!pset) return;
    setErr('');
    try {
      const r = await api.saveDefaults({ ...pset });
      setDefaults(r);
      setMsg(`已存为本机默认（${r.file}）——以后新建的项目都用它`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  /** 反过来：把本机默认套到当前这个项目上（老项目不用手改一遍）。 */
  const applyDefaultsHere = async () => {
    if (!project || !pset || !defaults) return;
    setErr('');
    try {
      const next = { ...pset, ...defaults.effective };
      setPset(next);
      await api.saveProject({ ...project, settings: next });
      setMsg('本项目已套上本机默认');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={{ display: 'grid', gap: 10, padding: 10, overflow: 'auto', alignContent: 'start' }}>
      <div className="section">
        <h3>实例 · 一键启停</h3>
        {recipes.map((r, i) => {
          const s = status.find((x) => x.recipe.id === r.id);
          return (
            <div key={r.id} className="story-beat" style={{ marginBottom: 8 }}>
              <div className="row" style={{ gap: 6 }}>
                <span style={{ color: s?.alive ? '#4ade80' : s?.listening ? '#facc15' : '#666' }}>●</span>
                <b style={{ flex: 1 }}>{r.label}</b>
                <span className="mono dim">{r.host}</span>
              </div>
              <div className="mono dim" style={{ margin: '4px 0', fontSize: 10 }}>
                {s?.listening
                  ? `PID ${s.pid} · 队列 ${s.running ?? 0}/${s.pending ?? 0} · 显存 ${fmtVram(s.vramFree)}${s.alive ? '' : ' · 端口在但不响应'}`
                  : '离线'}
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                <button className="primary" disabled={!!busy || !!s?.listening} onClick={() => void act(r.id, 'start')}>
                  {busy === `start:${r.id}` ? '启动中…' : '▶ 启动'}
                </button>
                <button className="ghost" disabled={!!busy || !s?.listening} onClick={() => void act(r.id, 'stop')}>
                  {busy === `stop:${r.id}` ? '关闭中…' : '■ 关闭'}
                </button>
              </div>
              <div className="field" style={{ marginTop: 6 }}>
                <label>启动命令（端口写在命令里，跟上面的地址保持一致）</label>
                <textarea className="mono" rows={2} value={r.command} onChange={(e) => patchRecipe(i, { command: e.target.value })} />
              </div>
              <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
                <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                  <label>探活地址</label>
                  <input className="mono" value={r.host} onChange={(e) => patchRecipe(i, { host: e.target.value })} />
                </div>
                <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                  <label>工作目录</label>
                  <input className="mono" value={r.cwd} onChange={(e) => patchRecipe(i, { cwd: e.target.value })} />
                </div>
              </div>
            </div>
          );
        })}
        <div className="row wrap" style={{ gap: 6 }}>
          <button disabled={!!busy} onClick={() => void saveRecipes()}>
            保存配方
          </button>
          <button
            className="ghost"
            disabled={!!busy}
            onClick={() => {
              dirty.current = false;
              void reload();
            }}
          >
            放弃改动
          </button>
        </div>
        <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
          配方存 data/machine.json，换机器改这里就行。Takeboard 自己（{selfPort}）拒绝被关。
        </div>
      </div>

      <div className="section">
        <h3>项目 · 模型与工具</h3>
        {!pset ? (
          <div className="dim">没打开项目。</div>
        ) : (
          <>
            <div className="field">
              <label>生图模板（走 8888）</label>
              <input className="mono" value={pset.workflowImage} onChange={(e) => patchPset({ workflowImage: e.target.value })} />
            </div>
            <div className="field">
              <label>出片模板（走 8188）</label>
              <input className="mono" value={pset.workflowVideo} onChange={(e) => patchPset({ workflowVideo: e.target.value })} />
            </div>
            <div className="field">
              <label>生图默认画幅（如 720x1280 竖版 9:16，留空跟模板）</label>
              <input className="mono" value={pset.frameSize ?? ''} onChange={(e) => patchPset({ frameSize: e.target.value })} />
            </div>
            <div className="field">
              <label>出片默认时长（秒）</label>
              <input
                type="number"
                className="mono"
                value={pset.videoSeconds ?? DEFAULT_SETTINGS.videoSeconds}
                onChange={(e) => patchPset({ videoSeconds: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="field">
              <label>出片像素预算（百万像素：抬它提画质，但更吃显存）</label>
              <input
                type="number"
                step="0.05"
                className="mono"
                value={pset.videoMegapixels ?? DEFAULT_SETTINGS.videoMegapixels}
                onChange={(e) => patchPset({ videoMegapixels: Number(e.target.value) || undefined })}
              />
            </div>
            <div className="field">
              <label>模板目录（ComfyUI workflow 的 .json 放哪）</label>
              <input className="mono" value={pset.workflowDir} onChange={(e) => patchPset({ workflowDir: e.target.value })} />
            </div>
            <div className="field">
              <label>ffmpeg</label>
              <input className="mono" value={pset.ffmpeg} onChange={(e) => patchPset({ ffmpeg: e.target.value })} />
            </div>
            <div className="field">
              <label>ffprobe</label>
              <input className="mono" value={pset.ffprobe} onChange={(e) => patchPset({ ffprobe: e.target.value })} />
            </div>
            <label className="row dim" style={{ gap: 6, marginBottom: 8 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={pset.releaseImageBeforeVideo}
                onChange={(e) => patchPset({ releaseImageBeforeVideo: e.target.checked })}
              />
              出片前自动关掉生图实例，让出显存
            </label>
            <div className="row wrap" style={{ gap: 6 }}>
              <button disabled={!!busy} onClick={() => void saveProjectSettings()}>
                保存项目设置
              </button>
              <button className="ghost" disabled={!!busy} onClick={() => void saveAsDefaults()}>
                存为本机默认
              </button>
              <button className="ghost" disabled={!!busy || !defaults} onClick={() => void applyDefaultsHere()}>
                套用本机默认
              </button>
            </div>
            <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
              「本机默认」存 {defaults?.file ?? 'data/defaults.json'}：新建的项目直接带着它出生，不用每建一个改一遍。
            </div>
          </>
        )}
      </div>

      <div className="section">
        <h3>LLM · 助手</h3>
        {!llm ? (
          <div className="dim">读配置中…</div>
        ) : (
          <>
            <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
              存 {llm.file}。优先级：环境变量 &gt; 这里存的 &gt; 项目根 .env。
              {llm.envOverride && <b style={{ color: '#facc15' }}> 现在有环境变量压着，这里改了不生效。</b>}
            </div>
            <div className="field">
              <label>接口地址 baseUrl（OpenAI 兼容，带 /v1）</label>
              <input className="mono" value={llmForm.baseUrl ?? ''} onChange={(e) => setLlmForm((p) => ({ ...p, baseUrl: e.target.value }))} />
            </div>
            <div className="field">
              <label>API Key（留空 = 不改；现在：{llm.apiKeySet ? `${llm.apiKeyMasked}（来自 ${llm.source}）` : '没配'}）</label>
              <input
                className="mono"
                type="password"
                placeholder={llm.apiKeySet ? '已配置，填新的才覆盖' : 'sk-...'}
                value={llmKey}
                onChange={(e) => setLlmKey(e.target.value)}
              />
            </div>
            <div className="field">
              <label>模型</label>
              <input className="mono" value={llmForm.model ?? ''} onChange={(e) => setLlmForm((p) => ({ ...p, model: e.target.value }))} />
            </div>
            <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label>temperature</label>
                <input
                  type="number"
                  step="0.1"
                  className="mono"
                  value={llmForm.temperature ?? 0.7}
                  onChange={(e) => setLlmForm((p) => ({ ...p, temperature: Number(e.target.value) }))}
                />
              </div>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label>maxTokens</label>
                <input
                  type="number"
                  className="mono"
                  value={llmForm.maxTokens ?? 4096}
                  onChange={(e) => setLlmForm((p) => ({ ...p, maxTokens: Number(e.target.value) }))}
                />
              </div>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label>超时 ms</label>
                <input
                  type="number"
                  className="mono"
                  value={llmForm.timeoutMs ?? 180000}
                  onChange={(e) => setLlmForm((p) => ({ ...p, timeoutMs: Number(e.target.value) }))}
                />
              </div>
            </div>
            <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
              <button disabled={!!busy} onClick={() => void saveLlmSettings()}>
                保存 LLM 配置
              </button>
              <button className="ghost" disabled={!!busy} onClick={() => void runLlmTest()}>
                {busy === 'llm-test' ? '测中…' : '测一下'}
              </button>
              {llm.apiKeyInFile && (
                <button className="ghost" disabled={!!busy} onClick={() => void clearLlmKey()}>
                  删掉存的 key
                </button>
              )}
            </div>
            {llmTest && (
              <div style={{ fontSize: 11, marginTop: 6, color: llmTest.ok ? '#4ade80' : '#f87171' }}>{llmTest.detail}</div>
            )}
          </>
        )}
      </div>

      {msg && (
        <div className="dim" style={{ fontSize: 11 }}>
          {msg}
        </div>
      )}
      {err && (
        <pre style={{ fontSize: 10, color: '#f87171', whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto', margin: 0 }}>{err}</pre>
      )}
    </div>
  );
}
