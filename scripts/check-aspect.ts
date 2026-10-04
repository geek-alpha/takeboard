/**
 * 比例继承回归：视频模板的宽高由 ResolutionSelector（比例+百万像素）现算时，
 * 数值旋钮没有落点，首帧图的比例必须自己落到 aspect_ratio 上——
 * 不然视频永远跟模板写死的那档（H3 是 16:9），竖图/方图都会被重构图。
 */
import * as templates from '../server/workflows.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';

const DIR = 'D:\\AI\\repos\\Easel\\skills\\shared\\comfy\\workflows';
let failed = 0;
const ok = (cond: boolean, msg: string, got?: unknown) => {
  if (!cond) failed++;
  console.log(`${cond ? '✔' : '✘'} ${msg}${got === undefined ? '' : `  —— ${got}`}`);
};

const { workflow, info } = templates.loadTemplate(DIR, 'minimax-h3-i2v');
const aspectBindings = info.bindings.filter((b) => b.role === 'aspect');
ok(aspectBindings.length === 1, 'H3 模板暴露出 aspect 旋钮', JSON.stringify(aspectBindings));
ok(
  !info.bindings.some((b) => b.role === 'width' || b.role === 'height'),
  'H3 模板确实没有宽高数值落点（这就是比例一直不跟首帧的原因）',
);

const cases: Array<[number, number, string]> = [
  [1024, 576, '16:9 (Widescreen)'],
  [1024, 1536, '2:3 (Portrait Photo)'],
  [1024, 1024, '1:1 (Square)'],
  [1080, 1920, '9:16 (Portrait Widescreen)'],
  [1024, 768, '4:3 (Standard)'],
  [1536, 1024, '3:2 (Photo)'],
];
for (const [w, h, want] of cases) {
  const got = templates.snapAspect(w, h, info.aspectOptions).aspect;
  ok(got === want, `${w}x${h} → ${want}`, got);
}

const wf = JSON.parse(JSON.stringify(workflow)) as Record<string, any>;
templates.bindWorkflow(wf, info, { aspect: '2:3 (Portrait Photo)' });
ok(wf['115'].inputs.aspect_ratio === '2:3 (Portrait Photo)', 'bindWorkflow 把比例写到节点115.aspect_ratio', wf['115'].inputs.aspect_ratio);
ok(Array.isArray(wf['131'].inputs.width) && wf['131'].inputs.width[0] === '115', '131.width 仍是连线引用（没被写坏）', JSON.stringify(wf['131'].inputs.width));
ok(wf['174'].inputs.image === workflow['174'].inputs.image, '首帧图没被动', wf['174'].inputs.image);

// 像素预算：0.6 是出片默认档（8188 实测不爆显存的预算），它必须真的落到 ResolutionSelector 上
const MP = DEFAULT_SETTINGS.videoMegapixels;
ok(MP === 0.6, '出片像素预算默认 0.6（抬它爆显存）', MP);
templates.bindWorkflow(wf, info, { megapixels: MP });
const rs = Object.entries(wf).filter(([, n]: [string, any]) => /ResolutionSelector/.test(String(n.class_type)));
ok(rs.length > 0, '模板里有 ResolutionSelector 节点', rs.map(([id]) => id).join(','));
ok(
  rs.every(([, n]: [string, any]) => n.inputs.megapixels === MP),
  'bindWorkflow 把像素预算写到 ResolutionSelector.megapixels',
  rs.map(([id, n]: [string, any]) => `${id}=${n.inputs.megapixels}`).join(' '),
);

console.log(failed ? `\n✘ ${failed} 项没过` : '\n✔ 全部通过');
process.exit(failed ? 1 : 0);
