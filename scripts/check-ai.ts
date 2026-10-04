import fs from 'node:fs';
import path from 'node:path';
import { diagnose } from '../server/diagnose.ts';
import { downstreamAspect } from '../server/jobs.ts';
import { thumb } from '../server/media.ts';
import { collectRefs } from '../server/refs.ts';
import { reviewTakes } from '../server/review.ts';
import { LOGS_DIR, listProjects, loadProject, mediaAbs } from '../server/store.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { OPS, opHelp, opsBrief, opsHelp } from '../shared/ops.ts';
import { SYSTEM, TOOLS } from '../server/agent.ts';
import type { Project } from '../shared/types.ts';

/**
 * AI 原生那几层的离线自检：缩略图、下游档位推导、评审入口校验、失败诊断规则。
 * 不碰 LLM 也不碰 ComfyUI——这几件事本来就该在没网没显卡时也能验。
 * 评审与诊断的真跑（要模型）另说，那是 check 之外的事。
 */

let pass = 0;
let fail = 0;
const ok = (name: string, extra = '') => {
  pass++;
  console.log(`  ✔ ${name}${extra ? ` · ${extra}` : ''}`);
};
const bad = (name: string, why: string) => {
  fail++;
  console.log(`  ✘ ${name} · ${why}`);
};

/** 随便找个项目里真实的图片产物，用来验缩略图。 */
function firstImageTake() {
  for (const s of listProjects()) {
    const p = loadProject(s.id);
    for (const n of p.nodes) {
      for (const t of n.takes) {
        if (t.kind === 'image' && t.status === 'done' && t.file) return { p, n, t };
      }
    }
  }
  return undefined;
}

console.log('takeboard · AI 层自检');

// ① 缩略图：模型看到的是压过的图，这条不成立，评审就是在看原图烧 token
const sample = firstImageTake();
if (!sample) {
  bad('缩略图', '项目里没有已完成的图片产物，先跑一张图再验');
} else {
  const src = mediaAbs(sample.p.id, sample.t.file!);
  const out = path.join(LOGS_DIR, 'review', 'check-thumb.jpg');
  try {
    thumb(sample.p.settings.ffmpeg, src, out, 640, false);
    const a = fs.statSync(src).size;
    const b = fs.statSync(out).size;
    if (b > 0 && b < a) ok('缩略图', `${Math.round(a / 1024)}KB → ${Math.round(b / 1024)}KB`);
    else bad('缩略图', `压完 ${b} 字节，原图 ${a} 字节，没起到压缩作用`);
  } catch (e) {
    bad('缩略图', e instanceof Error ? e.message : String(e));
  }
}

// ② 下游档位：生图该不该跟下游出片的档位走
const mkProject = (aspectFrom: string): Project =>
  ({
    id: 'check',
    name: 'check',
    rev: 1,
    createdAt: 0,
    updatedAt: 0,
    view: { x: 0, y: 0, zoom: 1 },
    settings: DEFAULT_SETTINGS,
    nodes: [
      { id: 'img', kind: 'image', title: '首帧', x: 0, y: 0, takes: [] },
      {
        id: 'vid',
        kind: 'video',
        title: '出片',
        x: 260,
        y: 0,
        activeTake: 't1',
        takes: [
          {
            id: 't1',
            nodeId: 'vid',
            createdAt: 0,
            status: 'done',
            source: 'comfy',
            kind: 'video',
            params: { aspect: '2:3 (Portrait Photo)', aspectFrom },
            inputs: {},
          },
        ],
      },
    ],
    edges: [{ id: 'e1', from: 'img', to: 'vid', pin: 'active', createdAt: 0 }],
  }) as unknown as Project;

const explicit = downstreamAspect(mkProject('面板指定'), 'img');
if (explicit?.aspect === '2:3 (Portrait Photo)' && explicit.usable) ok('下游档位继承', `${explicit.nodeTitle} ${explicit.aspect}`);
else bad('下游档位继承', `拿到 ${JSON.stringify(explicit)}`);

const fromFrame = downstreamAspect(mkProject('首帧 1024x1536'), 'img');
if (fromFrame && !fromFrame.usable) ok('首帧来源的档位不回流', 'usable=false，不会绕成环');
else bad('首帧来源的档位不回流', `usable=${fromFrame?.usable}`);

// ③ 评审入口：没有 key 或版本不够时要当场说清，而不是发一堆图出去
const p0 = listProjects()[0];
if (!p0) {
  bad('评审入口校验', '一个项目都没有');
} else {
  const proj = loadProject(p0.id);
  try {
    await reviewTakes({ projectId: p0.id, nodeId: '__不存在__' });
    bad('评审入口校验', '节点不存在却没报错');
  } catch (e) {
    ok('评审入口校验', (e instanceof Error ? e.message : String(e)).slice(0, 60));
  }
  const textNode = proj.nodes.find((n) => n.kind === 'text' && n.takes.length < 2);
  if (textNode) {
    try {
      await reviewTakes({ projectId: p0.id, nodeId: textNode.id });
      bad('版本不足时拒绝评审', '却没报错');
    } catch (e) {
      ok('版本不足时拒绝评审', (e instanceof Error ? e.message : String(e)).slice(0, 60));
    }
  }
}

// ④ 失败诊断：规则表命中不花钱，也不该依赖网络
let failed = 0;
for (const s of listProjects()) {
  const p = loadProject(s.id);
  for (const n of p.nodes) failed += n.takes.filter((t) => t.status === 'failed').length;
}
if (!failed) {
  ok('失败诊断', '当前没有失败的版本可诊（规则表未被触发）');
} else {
  const target = listProjects().find((s) => loadProject(s.id).nodes.some((n) => n.takes.some((t) => t.status === 'failed')))!;
  const out = await diagnose({ projectId: target.id, useLlm: false });
  if (out.items.length && out.items.every((d) => d.cause && d.fix)) {
    ok('失败诊断', `${out.items.length} 条 · 首条「${out.items[0].cause}」(${out.items[0].from})`);
  } else {
    bad('失败诊断', `返回 ${JSON.stringify(out.items).slice(0, 200)}`);
  }
}

// ⑤ 参考画面：写词和评审都得看得见已出的画面，这条不成立，跨镜连贯就是空话
const chained = listProjects()
  .map((s) => loadProject(s.id))
  .find((p) => {
    const v = p.nodes.find((n) => n.kind === 'video' && n.takes.some((t) => t.status === 'done' && t.file));
    const up = p.nodes.find((n) => n.kind === 'image' && n.takes.some((t) => t.status === 'done' && t.file));
    return !!v && !!up;
  });
if (!chained) {
  bad('参考画面', '没有「既有首帧图又有成片」的项目可验');
} else {
  const vid = chained.nodes.find((n) => n.kind === 'video' && n.takes.some((t) => t.status === 'done' && t.file))!;
  try {
    const b = await collectRefs({ projectId: chained.id, nodeId: vid.id, max: 6 });
    const roles = b.images.map((i) => i.role);
    if (b.images.length >= 2) ok('参考画面收集', `${b.images.length} 张：${b.labels.join('；')}`);
    else bad('参考画面收集', `只收到 ${b.images.length} 张：${JSON.stringify(b.labels)}`);
    if (roles.includes('首帧')) ok('出片节点带首帧', '上游图片被标成「首帧」');
    else bad('出片节点带首帧', `角色只有 ${roles.join('、')}`);
    if (b.labels.some((l) => /开头|结尾/.test(l))) ok('视频给切片', '视频参考抽的是首/尾帧，不是整段');
    else bad('视频给切片', `标签里没有首/尾帧标记：${b.labels.join('；')}`);
    if (b.images.every((i) => i.dataUrl.startsWith('data:image/jpeg;base64,'))) ok('参考图已压成缩略图', 'jpeg data URL');
    else bad('参考图已压成缩略图', '有不带 data URL 前缀的项');
    if (b.story.includes(vid.title)) ok('剧情线', `${b.story.split('\n').length} 行，含当前节点标记`);
    else bad('剧情线', `没有当前节点「${vid.title}」：${b.story.slice(0, 120)}`);

    // 显式指定：点名字取指定版本。版本号挑真有产物的那版 —— 失败版本本来就该收不到
    const goodAt = vid.takes.findIndex((t) => t.status === 'done' && t.file) + 1;
    const pinned = await collectRefs({ projectId: chained.id, nodeId: vid.id, refs: [`node:${vid.title}@v${goodAt}`], auto: false, max: 3 });
    if (pinned.images.length === 1 && pinned.labels[0].includes(`v${goodAt}`)) ok('指定节点版本当参考', pinned.labels[0]);
    else bad('指定节点版本当参考', `${JSON.stringify(pinned.labels)} ${JSON.stringify(pinned.skipped)}`);

    // 指定到没产物的那一版（跑挂的），要明确说是哪版取不到，而不是悄悄少一张
    const deadAt = vid.takes.findIndex((t) => !t.file) + 1;
    if (deadAt) {
      const dead = await collectRefs({ projectId: chained.id, nodeId: vid.id, refs: [`node:${vid.title}@v${deadAt}`], auto: false, max: 2 });
      if (!dead.images.length && dead.skipped.some((s) => s.includes(`v${deadAt}`))) ok('指定到无产物的版本进 skipped', dead.skipped[0].slice(0, 70));
      else bad('指定到无产物的版本进 skipped', JSON.stringify({ images: dead.images.length, skipped: dead.skipped }));
    }

    // 任意文件路径也能当参考（用户自己截的图）
    const anyImg = chained.nodes.flatMap((n) => n.takes).find((t) => t.kind === 'image' && t.status === 'done' && t.file);
    if (anyImg) {
      const abs = mediaAbs(chained.id, anyImg.file!);
      const one = await collectRefs({ projectId: chained.id, refs: [`path:${abs}`], auto: false, max: 2 });
      if (one.images.length === 1 && one.labels[0].includes('用户指定')) ok('指定路径当参考', one.labels[0]);
      else bad('指定路径当参考', JSON.stringify(one.labels));
    }

    // 找不到的参考不能把整轮弄挂，要落到 skipped 里说清楚
    const miss = await collectRefs({ projectId: chained.id, nodeId: vid.id, refs: ['node:__没有这个节点__'], auto: false, max: 2 });
    if (!miss.images.length && miss.skipped.length) ok('取不到的参考进 skipped', miss.skipped[0].slice(0, 70));
    else bad('取不到的参考进 skipped', JSON.stringify({ images: miss.images.length, skipped: miss.skipped }));
  } catch (e) {
    bad('参考画面收集', e instanceof Error ? e.message : String(e));
  }
}

// ⑤ 助手工具表：清单不许常驻进每轮上下文，细节按需查——省 token 的护栏，别退回老写法
{
  const names = TOOLS.map((t) => t.function.name);
  if (names.includes('ops_help')) ok('算子详情有按需入口', 'ops_help 工具在');
  else bad('算子详情有按需入口', '没有 ops_help，细节只能塞进常驻描述');

  // 技能规范同理：正文不进常驻，靠 skill 按需查，出片词由 optimize_prompt 装配
  if (names.includes('skill')) ok('技能有按需入口', 'skill 工具在');
  else bad('技能有按需入口', '没有 skill 工具，技能层级只能硬编');
  const optDesc = TOOLS.find((t) => t.function.name === 'optimize_prompt')?.function.description ?? '';
  if (optDesc.includes('H3')) ok('出片优化走 H3 技能', 'optimize_prompt 描述里点名 H3');
  else bad('出片优化走 H3 技能', '描述里没提 H3，助手不会把 seconds/aspect 一并传下去');

  // 渐进披露的硬指标：技能正文（字段名、格式条文、引用文件路径）一律不许出现在常驻 system 里
  const leakedSkill = ['overall_soundscape', 'non_diegetic_music', 'integrated_multimodal_description', 'i2va', 'references/'].filter((k) =>
    SYSTEM.includes(k),
  );
  if (!leakedSkill.length) ok('技能正文没常驻进 system', `system ${SYSTEM.length} 字，只留索引行`);
  else bad('技能正文没常驻进 system', `这些技能细节漏进了常驻提示：${leakedSkill.join('、')}`);
  if (SYSTEM.includes('h3 =') && SYSTEM.length < 4000) ok('常驻里有技能索引', `索引行进 system 了（${SYSTEM.length} 字）`);
  else bad('常驻里有技能索引', '索引行没进 system，助手不知道有哪些技能可查');

  const desc = TOOLS.find((t) => t.function.name === 'op')?.function.description ?? '';
  const missing = OPS.filter((o) => !desc.includes(o.id)).map((o) => o.id);
  if (desc && !missing.length) ok('常驻描述只带算子名', `${OPS.length} 个 id 全在 · ${desc.length} 字`);
  else bad('常驻描述只带算子名', missing.length ? `缺 ${missing.join('、')}` : '没有 op 工具');

  const leaked = OPS.filter((o) => desc.includes(o.hint)).map((o) => o.id);
  if (!leaked.length) ok('清单正文没常驻', `比塞清单省 ${opsHelp().length - opsBrief().length} 字/轮`);
  else bad('清单正文没常驻', `${leaked.join('、')} 的说明被塞进工具描述了`);

  // 按需查的那一份必须真查得到：每个算子的参数键名一个不少，否则助手只能猜参数
  const thin = OPS.filter((o) => {
    const h = opHelp(o.id);
    return h.includes('没有算子') || o.params.some((p) => !h.includes(p.key));
  }).map((o) => o.id);
  if (!thin.length) ok('按需说明书够用', `${OPS.length} 个算子的参数键名都能查到`);
  else bad('按需说明书够用', `${thin.join('、')} 查不到或参数不全`);

  const longest = TOOLS.map((t) => [t.function.name, t.function.description.length] as const).sort((a, b) => b[1] - a[1])[0];
  const total = TOOLS.reduce((s, t) => s + t.function.description.length, 0);
  const avg = Math.round(total / TOOLS.length);
  // 总量随工具数自然增长，卡平均值才有意义：每个工具的描述都该是「一句话说清做什么」
  if (longest[1] <= 260 && avg <= 60) ok('工具描述没长文', `最长 ${longest[0]} ${longest[1]} 字 · 平均 ${avg} 字 × ${TOOLS.length} 个`);
  else bad('工具描述没长文', `最长 ${longest[0]} ${longest[1]} 字 · 平均 ${avg} 字 × ${TOOLS.length} 个`);
}

console.log(`\n结果：${pass} 通过 · ${fail} 失败`);
process.exit(fail ? 1 : 0);
