/**
 * 配置回归：LLM 基础配置（data/llm.json）与本机默认项目设置（data/defaults.json）。
 *
 * 这两块都是「设置界面能改、改完立刻生效」的东西，所以断言要盯三件事：
 * 优先级（环境变量 > 文件 > .env）、脱敏（完整 key 不出服务端）、继承（新项目拿到本机默认）。
 * 全程在临时 TAKEBOARD_ROOT 里跑，不碰真 data/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'takeboard-check-config-'));
process.env.TAKEBOARD_ROOT = tmp;
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
fs.writeFileSync(path.join(tmp, '.env'), 'TAKEBOARD_LLM_API_KEY=sk-from-dotenv\nTAKEBOARD_LLM_MODEL=model-from-dotenv\n', 'utf8');

const llm = await import('../server/llm.ts');
const defaults = await import('../server/defaults.ts');
const store = await import('../server/store.ts');
const { DEFAULT_SETTINGS } = await import('../shared/types.ts');

let failed = 0;
const ok = (cond: boolean, msg: string, got?: unknown) => {
  if (!cond) failed++;
  console.log(`${cond ? '✔' : '✘'} ${msg}${got === undefined ? '' : `  —— ${got}`}`);
};
const throws = (fn: () => unknown, want: string, msg: string) => {
  try {
    fn();
    failed++;
    console.log(`✘ ${msg}  —— 没报错`);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    ok(text.includes(want), msg, text);
  }
};

// ── 1. 没文件时退到 .env ────────────────────────────────────────────────
ok(llm.llmConfig().source === 'dotenv', '没存文件时 key 来自 .env', llm.llmConfig().source);
ok(llm.llmConfig().model === 'model-from-dotenv', '.env 里的模型生效', llm.llmConfig().model);

// ── 2. 存文件后文件优先于 .env ──────────────────────────────────────────
llm.saveLlmFile({ baseUrl: 'https://example.com/v1/', apiKey: 'sk-file-key-1234567890', model: 'model-from-file', temperature: 0.3, maxTokens: 2048 });
const cfg = llm.llmConfig();
ok(cfg.source === 'file', '存了文件后 key 来自文件', cfg.source);
ok(cfg.baseUrl === 'https://example.com/v1', 'baseUrl 去掉尾部斜杠', cfg.baseUrl);
ok(cfg.model === 'model-from-file', '文件里的模型压过 .env', cfg.model);
ok(cfg.temperature === 0.3 && cfg.maxTokens === 2048, '数值项落盘生效', `${cfg.temperature}/${cfg.maxTokens}`);

// ── 3. 环境变量压过文件 ─────────────────────────────────────────────────
process.env.TAKEBOARD_LLM_MODEL = 'model-from-env';
ok(llm.llmConfig().model === 'model-from-env', '环境变量压过文件', llm.llmConfig().model);
ok(llm.llmPublic().envOverride === true, '有环境变量时界面能收到提醒', llm.llmPublic().envOverride);
delete process.env.TAKEBOARD_LLM_MODEL;

// ── 4. 脱敏：完整 key 不出服务端 ────────────────────────────────────────
const pub = llm.llmPublic();
ok(!JSON.stringify(pub).includes('sk-file-key-1234567890'), '公开配置里没有完整 key', pub.apiKeyMasked);
ok(pub.apiKeyMasked.startsWith('sk-f') && pub.apiKeyMasked.endsWith('7890'), '脱敏串保留头尾便于辨认', pub.apiKeyMasked);
ok(pub.apiKeyInFile === true, '标注 key 存在文件里', pub.apiKeyInFile);

// ── 5. key 留空 = 不改；clearApiKey 才删 ────────────────────────────────
llm.saveLlmFile({ model: 'model-2' });
ok(llm.loadLlmFile().apiKey === 'sk-file-key-1234567890', 'apiKey 留空不会把已存的 key 抹掉', llm.loadLlmFile().apiKey);
ok(llm.loadLlmFile().model === 'model-2', '只改模型时其它字段保留', llm.loadLlmFile().model);
llm.saveLlmFile({ clearApiKey: true });
ok(!llm.loadLlmFile().apiKey, 'clearApiKey 才真删 key', llm.loadLlmFile().apiKey);
ok(llm.llmConfig().source === 'dotenv', '删掉文件里的 key 后退回 .env', llm.llmConfig().source);

// ── 6. 存盘校验 ─────────────────────────────────────────────────────────
throws(() => llm.saveLlmFile({ baseUrl: 'api.example.com/v1' }), 'http://', 'baseUrl 缺协议要报错');
throws(() => llm.saveLlmFile({ temperature: 9 }), 'temperature', 'temperature 越界要报错');
throws(() => llm.saveLlmFile({ timeoutMs: 100 }), 'timeoutMs', 'timeoutMs 太小要报错');

// ── 7. 本机默认：存了以后新项目继承 ─────────────────────────────────────
ok(Object.keys(defaults.loadDefaults()).length === 0, '没存过时本机默认为空', JSON.stringify(defaults.loadDefaults()));
defaults.saveDefaults({ frameSize: '1280x720', videoSeconds: 5, videoMegapixels: 0.6, workflowVideo: 'minimax-h3-i2v-turbo' });
const eff = defaults.projectDefaults();
ok(eff.frameSize === '1280x720' && eff.videoMegapixels === 0.6, '本机默认覆盖内置默认', `${eff.frameSize}/${eff.videoMegapixels}`);
ok(eff.ffmpeg === DEFAULT_SETTINGS.ffmpeg, '没覆盖的项仍走内置默认', eff.ffmpeg.slice(-12));

const p = store.createProject('配置回归');
ok(p.settings.frameSize === '1280x720', '新项目继承本机默认画幅', p.settings.frameSize);
ok(p.settings.videoMegapixels === 0.6, '新项目继承本机默认像素预算', p.settings.videoMegapixels);
ok(p.settings.videoSeconds === 5, '新项目继承本机默认时长', p.settings.videoSeconds);

// ── 8. 本机默认的校验 ───────────────────────────────────────────────────
throws(() => defaults.saveDefaults({ frameSize: '720*1280' }), '宽x高', '画幅格式写错要报错');
throws(() => defaults.saveDefaults({ videoMegapixels: 99 }), '出片像素预算', '像素预算越界要报错');
throws(() => defaults.saveDefaults({ comfyHost: '127.0.0.1:8188' }), 'http://', '实例地址缺协议要报错');
ok(defaults.loadDefaults().frameSize === '1280x720', '校验失败不写盘（旧值还在）', defaults.loadDefaults().frameSize);

// ── 9. 默认值只有一个源：时长/画幅不许在别处再写一个数 ─────────────────
const workflows = await import('../server/workflows.ts');
const prompts = await import('../server/prompts.ts');
const story = await import('../server/story.ts');
ok(workflows.frameRatio() === '9:16', '不给尺寸时按内置默认画幅算比例', workflows.frameRatio());
ok(story.DEFAULT_SECONDS === DEFAULT_SETTINGS.videoSeconds, '剧情每镜默认时长跟项目默认同源', story.DEFAULT_SECONDS);
// skillMode 显式给：临时 root 下读不到技能文件，但 TARGET 段是纯拼装，离线就能验
// 只从 TARGET 段里取值：技能正文自己带示例（duration_s: 8 / ratio: 16:9），全文搜会被它带偏
const tgt = prompts.promptUserText({ idea: '测试', target: 'video' }, [], 'i2va');
const ms = [...tgt.matchAll(/\nTARGET:\nduration_s: ([^\n]*)\nratio: ([^\n]*)/g)];
const m = ms[ms.length - 1];
ok(!!m, '拼出了 TARGET 段（时长+画幅）', m ? `${m[1]} / ${m[2]}` : '没找到');
ok(m?.[1] === String(DEFAULT_SETTINGS.videoSeconds), 'TARGET 的时长跟项目默认', m?.[1]);
ok(
  m?.[2].split(/\s+#/)[0] === workflows.frameRatio(DEFAULT_SETTINGS.frameSize),
  'TARGET 的画幅跟项目默认画幅（不是模板写死的 16:9）',
  m?.[2],
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n✘ ${failed} 项没过` : '\n✔ 全部通过');
process.exit(failed ? 1 : 0);
