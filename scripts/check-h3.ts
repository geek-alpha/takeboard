/**
 * H3 技能装配回归：技能文件改了、路径挪了，这里先炸，别等模型写出废词才发现。
 *
 * 检查的是「装配出来的规则正文里真的有关键硬约束」，不是文件存在与否——
 * 段落标题改了导致 section 取空，是这套渐进披露最可能的静默失败。
 */
import { classifyMode, h3Layers, loadH3Skill, skillDir } from '../server/h3-skill.ts';
import { promptRules, promptUserText } from '../server/prompts.ts';
import type { RefImage } from '../server/refs.ts';

let failed = 0;
const ok = (cond: boolean, msg: string, got?: unknown) => {
  if (!cond) failed++;
  console.log(`${cond ? '✔' : '✘'} ${msg}${got === undefined ? '' : `  —— ${got}`}`);
};

const i2va = loadH3Skill('i2va');
ok(!i2va.missing, 'i2va 装配成功（技能目录读得到）', i2va.missing ?? `${i2va.text.length} 字`);
ok(i2va.files.includes('references/base-multishot-format.md'), 'i2va 装了 base 多镜头格式层', i2va.files.join(', '));
for (const key of ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music', 'MM:SS']) {
  ok(i2va.text.includes(key), `i2va 规则里有硬约束「${key}」`);
}

const ref2va = loadH3Skill('ref2va');
ok(ref2va.files.includes('references/ref2va-format.md'), 'ref2va 装了 ref2va 格式层', ref2va.files.join(', '));
for (const key of ['subject_definitions', 'retention_analysis', 'detailed_description']) {
  ok(ref2va.text.includes(key), `ref2va 规则里有字段「${key}」`);
}
ok(!ref2va.text.includes('Multi-Shot Planning Rules'), 'ref2va 不夹带 base 层（一层只管一个 mode）');

ok(classifyMode(['首帧', '上一镜结尾']) === 'i2va', '有首帧 → i2va');
ok(classifyMode(['用户指定']) === 'ref2va', '只有点名参考 → ref2va');
ok(classifyMode([]) === 't2va', '什么都没有 → t2va');

// 边界：H3 是出片规范，生图一律不装——两套语境不许串门
const frame = (role: string): RefImage => ({ label: `${role} · 测试`, role, file: 'test.png', dataUrl: 'data:image/png;base64,' });
const img = promptRules('image', [frame('参考')]);
const marks = ['overall_soundscape', 'non_diegetic_music', 'MM:SS', 'i2va', 'integrated_multimodal_description'];
const leaked = marks.filter((k) => img.rules.includes(k));
ok(
  !img.skillMode && !leaked.length,
  '生图不装 H3（无 mode、无 H3 字段）',
  leaked.length ? `漏了 ${leaked.join('、')}` : `内置规则 ${img.rules.length} 字`,
);

const vid = promptRules('video', [frame('首帧')]);
ok(vid.skillMode === 'i2va', '出片带首帧 → i2va 装配', vid.skillMode);
ok(vid.rules.includes('overall_soundscape'), '出片规则里有 H3 硬约束', `${vid.rules.length} 字`);
ok(!vid.rules.includes('z-image'), '出片规则里不夹带生图条文');
ok(!promptRules('image').rules.includes('MM:SS'), '纯文字生图同样不装 H3');

const layers = h3Layers();
ok(layers.every((l) => l.bytes > 0), '每一层都读得到', layers.map((l) => `${l.file}=${l.bytes}`).join(' '));
ok(layers.length >= 3, '至少 SKILL.md + 两个格式层', layers.length);

const dir = skillDir();
process.env.H3_SKILL_DIR = dir + '__不存在__';
const gone = loadH3Skill('i2va');
ok(!!gone.missing && !gone.text, '技能不在磁盘上时给出 missing、不抛异常（调用方好回退）', gone.missing);
process.env.H3_SKILL_DIR = dir;

// 精修契约：既有词必须原样进 prompt，还带着冻结清单。
// 这层写错就会「改版」：模型把既有词当想法，重新创作一遍。
const existing =
  'A woman in a wet grey wool coat stands on a rainy rooftop at night, neon reflections on the floor, medium shot, slow push in';
const base = { idea: '天台雨夜等信', target: 'video' as const, current: existing, seconds: 6, ratio: '16:9' };
const refText = promptUserText(base, [frame('首帧')], 'i2va');
ok(refText.includes(existing), '精修：既有词原样进了 prompt（模型真看得到）');
ok(refText.includes('冻结清单') && refText.includes('只许动这四类'), '精修：带了冻结清单与允许改动范围');
ok(refText.includes('"changes"'), '精修：schema 里要求逐条报改动');
ok(refText.includes('精修对象'), '精修：BRIEF 标成精修对象，不是「想法」');
const rewriteText = promptUserText({ ...base, mode: 'rewrite' }, [frame('首帧')], 'i2va');
ok(!rewriteText.includes('冻结清单') && rewriteText.includes('允许重写'), '重写模式：不带冻结清单，既有版标成可推翻');
const imgRef = promptUserText({ idea: '天台雨夜', target: 'image', current: existing });
ok(imgRef.includes('既有提示词（精修对象') && !imgRef.includes('原始想法：'), '生图精修：既有词独立成块，不当想法喂');
const fresh = promptUserText({ idea: '天台雨夜等信', target: 'image' });
ok(fresh.includes('原始想法') && !fresh.includes('冻结清单'), '没有既有词：仍是创作模式，不受契约约束');

console.log(failed ? `\n✘ ${failed} 项没过` : '\n✔ 全部通过');
process.exit(failed ? 1 : 0);
