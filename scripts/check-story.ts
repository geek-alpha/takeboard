import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 剧情模式的离线自检：解析、落盘、填模板、统计。
 * 不碰 LLM 也不碰 ComfyUI —— 剧本切得对不对、模板填得对不对，本来就该在没网没显卡时能验。
 * 数据写在系统临时目录（TAKEBOARD_ROOT），跑完删掉，不碰真项目。
 */
const ROOT = path.join(os.tmpdir(), `takeboard-check-story-${process.pid}`);
process.env.TAKEBOARD_ROOT = ROOT;
fs.mkdirSync(path.join(ROOT, 'projects'), { recursive: true });

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
const eq = (name: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(name, String(got));
  else bad(name, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
};
const has = (name: string, got: string, needle: string) => {
  if (got?.includes(needle)) ok(name, needle);
  else bad(name, `「${String(got).slice(0, 80)}」里没有「${needle}」`);
};

const SCRIPT = `# 雨夜信
一句话：一个没脸的人在雨夜天台等一封信
风格：cinematic, cold neon

## 镜头1 天台
画面：wet rooftop, neon reflections, faceless figure in a grey coat, low angle
动作：she turns slowly toward the city light, coat flapping in the wind
时长：6s

## 镜头2 信
画面：close-up of a soaked envelope on wet concrete, shallow depth of field
动作：camera pushes in as the envelope corner lifts
时长：4s
台词：这是最后一封了
`;

async function main() {
  const store = await import('../server/store.ts');
  const story = await import('../server/story.ts');

  // ── 1. 时长解析 ─────────────────────────────────────────────────────
  eq('时长 6', story.parseSeconds('6'), 6);
  eq('时长 6s', story.parseSeconds('6s'), 6);
  eq('时长 0:06', story.parseSeconds('0:06'), 6);
  eq('时长 1分30秒', story.parseSeconds('1分30秒'), 90);
  eq('时长 空', story.parseSeconds(''), undefined);

  // ── 2. 分镜表解析 ───────────────────────────────────────────────────
  const p1 = story.parseScript(SCRIPT);
  eq('分镜表：片名', p1.title, '雨夜信');
  has('分镜表：一句话', p1.logline, '没脸');
  eq('分镜表：风格', p1.style, 'cinematic, cold neon');
  eq('分镜表：镜头数', p1.beats.length, 2);
  eq('分镜表：第一镜名（去掉「镜头1」前缀）', p1.beats[0].title, '天台');
  has('分镜表：画面进 image', p1.beats[0].image, 'wet rooftop');
  has('分镜表：动作进 video', p1.beats[0].video, 'turns slowly');
  eq('分镜表：时长', p1.beats[0].seconds, 6);
  eq('分镜表：台词', p1.beats[1].line, '这是最后一封了');

  // ── 3. 别的写法：镜头N / 1. / 【】 ─────────────────────────────────
  const p2 = story.parseScript('镜头1：推门\n画面：a hand pushes a rusty door\n\n镜头2：进屋\n画面：dust floating in a beam of light');
  eq('镜头N 写法：镜头数', p2.beats.length, 2);
  eq('镜头N 写法：第一镜名', p2.beats[0].title, '推门');
  const p3 = story.parseScript('1. 开场\n画面：empty street at dawn\n2. 走近\n画面：boots splashing through a puddle');
  eq('序号写法：镜头数', p3.beats.length, 2);
  eq('序号写法：第一镜名', p3.beats[0].title, '开场');
  const p4 = story.parseScript('【开场】\n画面：empty street\n【收尾】\n画面：a closed door');
  eq('【】写法：镜头数', p4.beats.length, 2);

  // ── 4. JSON 与空行分段 ──────────────────────────────────────────────
  const p5 = story.parseScript('```json\n{"title":"测试","beats":[{"title":"A","action":"走","image":"a walk","video":"walking forward","seconds":3}]}\n```');
  eq('JSON 写法：片名', p5.title, '测试');
  eq('JSON 写法：镜头数', p5.beats.length, 1);
  eq('JSON 写法：时长', p5.beats[0].seconds, 3);
  const p6 = story.parseScript('一个人在雨里站着，伞破了。\n\n然后他抬头看天。');
  eq('无镜头头：按空行分段', p6.beats.length, 2);
  has('无镜头头：段落进了 action', p6.beats[0].action, '伞破了');

  // ── 5. 落盘 / 改一镜 ────────────────────────────────────────────────
  const proj = store.createProject('剧情自检');
  const saved = story.importScript(proj.id, SCRIPT);
  eq('导入落盘：镜头数', saved.beats.length, 2);
  eq('导入落盘：再读一致', story.readStory(proj.id).beats.length, 2);

  const second = saved.beats[1].id;
  story.editBeat(proj.id, second, { title: '信封', seconds: 4.5 });
  const afterEdit = story.readStory(proj.id);
  eq('改一镜：改到了', afterEdit.beats[1].title, '信封');
  eq('改一镜：时长改了', afterEdit.beats[1].seconds, 4.5);
  eq('改一镜：没动其他镜', afterEdit.beats[0].title, '天台');

  // ── 6. 填模板 ──────────────────────────────────────────────────────
  const applied = story.applyStory(proj.id);
  eq('填模板：新建镜数', applied.created.length, 2);
  eq('填模板：连线数', applied.edges, 2);
  const p = store.loadProject(proj.id);
  eq('填模板：节点数 = 2 镜 × 2', p.nodes.length, 4);
  const img0 = p.nodes.find((n) => n.id === p.story!.beats[0].imageNodeId)!;
  const vid0 = p.nodes.find((n) => n.id === p.story!.beats[0].videoNodeId)!;
  eq('填模板：首帧节点类型', img0.kind, 'image');
  eq('填模板：出片节点类型', vid0.kind, 'video');
  has('填模板：词写进了节点预设', img0.draft!.prompt!, 'wet rooftop');
  eq('填模板：出片时长进预设', vid0.draft!.seconds, 6);
  eq('填模板：首帧标题带后缀', img0.title, '天台·首帧');
  eq('填模板：出片标题就是镜头名', vid0.title, '天台');
  eq('填模板：连线方向', p.edges.filter((e) => e.from === img0.id && e.to === vid0.id).length, 1);

  // 幂等：再填一次不该重复建节点
  const again = story.applyStory(proj.id);
  eq('重填：不新建', again.created.length, 0);
  eq('重填：全部走更新', again.updated.length, 2);
  eq('重填：节点数没变', store.loadProject(proj.id).nodes.length, 4);

  // 剧情改了词 → 重填后节点预设跟着变（剧情是真相源）
  story.editBeat(proj.id, second, { image: 'a new envelope prompt' });
  story.applyStory(proj.id);
  const p2n = store.loadProject(proj.id);
  const img1 = p2n.nodes.find((n) => n.id === p2n.story!.beats[1].imageNodeId)!;
  has('重填：词跟着剧情走', img1.draft!.prompt!, 'a new envelope prompt');

  // ── 7. 统计 ────────────────────────────────────────────────────────
  const st = story.storyStatus(proj.id);
  eq('统计：镜头数', st.beats.length, 2);
  eq('统计：已填', st.filled, 2);
  eq('统计：已出片', st.done, 0);
  eq('统计：总时长', st.totalSeconds, 10.5);
  eq('统计：状态未跑', [st.beats[0].imageDone, st.beats[0].videoDone], [false, false]);

  // ── 8. 没剧情时的行为 ──────────────────────────────────────────────
  const empty = store.createProject('空项目');
  eq('没剧情：读出来是空的', story.readStory(empty.id).beats.length, 0);
  let threw = '';
  try {
    story.applyStory(empty.id);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  has('没剧情：填模板会明说', threw, '还没有剧情');

  // 同名镜头不该撞标题
  story.writeStory(empty.id, { title: '同名', beats: [{ title: '一样的', action: 'a', image: '', video: '', seconds: 3 } as any, { title: '一样的', action: 'b', image: '', video: '', seconds: 3 } as any] });
  story.applyStory(empty.id);
  const titles = store.loadProject(empty.id).nodes.map((n) => n.title);
  eq('同名镜头：标题不撞', new Set(titles).size, titles.length);

  // ── 9. 重试：一条龙的每一步都套着它 ──────────────────────────────
  let calls = 0;
  const once = await story.withRetry('偶发', 2, async () => {
    calls++;
    if (calls < 2) throw new Error('偶发挂了');
    return 'ok';
  });
  eq('重试：第二次成功', once, 'ok');
  eq('重试：只跑了两次', calls, 2);

  const tried: number[] = [];
  let hard = 0;
  let boom = '';
  try {
    await story.withRetry(
      '一直挂',
      2,
      async () => {
        hard++;
        throw new Error('一直挂');
      },
      { onRetry: (i) => tried.push(i.attempt) },
    );
  } catch (e) {
    boom = e instanceof Error ? e.message : String(e);
  }
  eq('重试：一直挂就试满 3 次', hard, 3);
  eq('重试：报了两次重试', tried, [1, 2]);
  has('重试：错误里说明重试过', boom, '重试 2 次都没过');

  let after = 0;
  try {
    await story.withRetry(
      '叫停',
      3,
      async () => {
        after++;
        throw new Error('挂了');
      },
      { aborted: () => after >= 1 },
    );
  } catch {
    // 预期抛
  }
  eq('重试：叫停不重试', after, 1);

  let zero = 0;
  try {
    await story.withRetry('不重试', 0, async () => {
      zero++;
      throw new Error('原样抛');
    });
  } catch {
    // 预期抛
  }
  eq('重试：retries=0 只试一次', zero, 1);
}

main()
  .then(() => {
    console.log(`\n结果：${pass} 通过 · ${fail} 失败`);
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  })
  .catch((err) => {
    console.error('自检自己崩了：', err);
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(1);
  });
