import fs from 'node:fs';
import path from 'node:path';
import { chat, llmConfig, textOf, type ChatMessage, type ToolDef } from './llm.ts';
import { status as comfyStatus } from './comfy.ts';
import { portReport, releaseImagePort, VIDEO_PORT } from './gpu.ts';
import { startInstance, stopInstance } from './machine.ts';
import { firstFrameOf, jobsSnapshot, replay, runNode, runOp, runSweep, downstreamAspect } from './jobs.ts';
import { exportFilm, handoffShot, sequenceOf } from './sequence.ts';
import { opHelp, opsBrief } from '../shared/ops.ts';
import { optimizePrompt } from './prompts.ts';
import { SKILLS, findSkill, skillCatalog, skillsBrief } from './skills.ts';
import { applyStory, draftStory, editBeat, importScript, refineStory, runStory, storyStatus, writeStory } from './story.ts';
import { collectRefs, refsText, type RefImage } from './refs.ts';
import { reviewTakes, reviewText } from './review.ts';
import { diagnose, diagnoseText } from './diagnose.ts';
import {
  createProject,
  listProjects,
  loadProject,
  mediaDir,
  newId,
  relMedia,
  saveProject,
  uniquePath,
} from './store.ts';
import { frameRatio, listTemplates } from './workflows.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import type { JobProgress, NodeKind, Project, Take, TakeNode } from '../shared/types.ts';

/**
 * 内置助手：LLM + 工具循环，工具直接落在 server 的能力函数上。
 * 不走 HTTP 自调自己——同一进程里调函数，省一层序列化，也不会被自己的端口绕晕。
 *
 * 删除类动作（删节点/删版本/杀生图进程）走审批门：模型只能「申请」，由人在面板上点头。
 */

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'round'; round: number }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; args: Record<string, unknown>; status: 'running' | 'ok' | 'error'; result?: string; ms?: number }
  | { type: 'confirm'; id: string; label: string; tool: string; args: Record<string, unknown> }
  | { type: 'confirm_result'; id: string; approved: boolean }
  | { type: 'job'; job: JobProgress }
  | { type: 'project'; projectId: string }
  | { type: 'done'; text: string; usage?: Record<string, number> }
  | { type: 'error'; message: string };

export type Emit = (ev: AgentEvent) => void;

export const SYSTEM = `你是 Takeboard 的内置助手。你不是给建议的顾问——你直接动手改这张画布：建节点、写提示词、连线、跑版本、抽卡、切引脚。

## 这个工作台的模型（先记住，再动手）
- 节点 node = 画布上的素材位，kind 有 image / video / audio / text / op / note
- take = 节点下的一版产物，只增不减；跑一次多一版，旧版永远在
- activeTake = 节点当前的引脚（下游默认吃这一版）
- 边 edge = 有向连接，自带 pin：'active' 跟随上游当前版本，'<takeId>' 钉死那一版
- take.inputs = provenance，记着这一版吃的是上游哪几版

## 铁律
1. 绝不覆盖。要改就新增一版（run / put_text / sweep），没有「改这一版」这种操作。
2. 提示词放 text 节点，连线喂给生图/出片节点——改一次词，下游下一次跑自动吃到。优先级：本次显式给的 > 上游文本节点当前版本 > 上一版继承。
3. 出片比例跟首帧，不跟模板默认：不要手写 width/height，用 aspect 档位（面板选「跟随首帧」或给档位名）。
4. 显存纪律：生图实例 8888 与出片实例 8188 抢同一块显存。出片前可以 release_image 杀掉 8888；8188 是禁区，绝不许碰。
5. 出量靠 sweep（同参数连跑 N 版、种子递进），不要自己写循环。
6. 出片是分钟级长任务：run / sweep 默认等到出结果才返回，别急着断言失败。

## 干活方式
- 先 board 看清现状再动手；拿不准节点 id 就先看，别猜。
- 一次把该做的做完：建节点 → 写词 → 连线 → 跑，中间不要停下来问人。
- 提示词别自己硬编：先调 optimize_prompt 拿到专业版（生图给静态画面，出片给运动/运镜/时间演进）。它返回的负面词单独走 params.negative，绝不要拼进 prompt 正文。
- 节点上已有定稿的词要「优化」时，把那段词放进 current——它走精修：设定冻结、只规范化、改动逐条报回来。塞 idea 会被当成新想法重写，那不是优化是改版。
- 出片时把节点当前的 seconds / aspect 顺手传给 optimize_prompt，镜头预算才对得上。
- 技能规范正文一律不常驻（省 token），索引如下。要层级或原文用 skill 工具查，别凭记忆写格式：
${skillsBrief()}
- 项目里已经有画面时，optimize_prompt 会自动把上游产物、相邻镜头当参考图送给模型（出片节点的上游图就是它的首帧），还会带上剧情线——写词之前先看 board，有已出的画面就别关掉参考（auto=false），否则新词接不上前面。
- 要参考别的镜头或用户自己截的图，给 ref 参数：节点标题、node:标题@v2、take:xxx、path:绝对路径，逗号分隔。
- 挑片子用 review_takes：它把产物压成缩略图真的送进模型看图打分，还会拿相邻镜头当对照判连贯度，能指出崩坏并挑出最优。别按种子或参数猜哪张好。
- 有 failed 的版本先用 diagnose 看原因，再决定是重跑、改参数还是先起实例。
- 回复用中文，短、具体：做了什么、画布现在什么状态、下一步建议什么。
- 做片子先看剧情：story 看分镜表。没剧情就 write_story 写一份（或 import_script 导入），改词用 edit_story，然后 fill_template 落到画布（每镜一对节点，词写在节点预设里），要规范出片词先 refine_story，要初版就 run_story 一条龙。别跳过剧情一镜一镜手搓——那是没剧情时的退路。`

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const S = (description: string) => ({ type: 'string', description });
const N = (description: string) => ({ type: 'number', description });

/** 删除类动作要人点头，标记在工具名上，执行前拦一道。 */
export const GUARDED = new Set(['delete_node', 'delete_take', 'release_image', 'stop_instance']);

export const TOOLS: ToolDef[] = [
  fn('list_projects', '列出全部工作台（项目）：id、名字、节点数、版本数', {}),
  fn(
    'board',
    '看一个工作台的全貌：节点（含当前版本）、take 栈摘要、连线（含引脚）、在跑的作业。动手前先看这个。',
    { project: S('项目 id 或名字') },
    ['project'],
  ),
  fn(
    'node_detail',
    '看单个节点的细节：当前生效参数、提示词来自谁、每个 take 的参数与状态。',
    { project: S('项目 id 或名字'), node: S('节点 id 或标题') },
    ['project', 'node'],
  ),
  fn('templates', '列出可用的 ComfyUI 模板 + 自动发现的旋钮（哪些字段能改）+ 装在哪台实例', { project: S('项目 id 或名字，给了才能按实例过滤') }),
  fn('env_status', '看两个 ComfyUI 实例（8188 出片 / 8888 生图）是否在线、显存、队列，以及端口占用', {}),
  fn(
    'start_instance',
    '一键起 ComfyUI 实例（image=生图 8888 / video=出片 8188）。等端口监听，起不来会带回日志尾巴。启动要几十秒。',
    { id: S('实例 id：image / video') },
    ['id'],
  ),
  fn(
    'stop_instance',
    '一键关 ComfyUI 实例（image / video）。有作业在跑时会先拦一道，确认要打断就带 force。',
    { id: S('实例 id：image / video'), force: N('有作业在跑时传 1 = 确认打断它们') },
    ['id'],
  ),
  fn('jobs_status', '看在跑的作业进度', {}),
  fn('create_project', '新建工作台', { name: S('名字') }, ['name']),
  fn(
    'add_node',
    '加一个节点。kind: image / video / audio / text / op / note。text 节点用来放提示词。',
    { project: S('项目 id 或名字'), kind: S('节点类型'), title: S('标题'), x: N('画布 x'), y: N('画布 y'), text: S('text/note 节点的初始文本') },
    ['project', 'kind'],
  ),
  fn(
    'update_node',
    '改节点属性：标题、位置、批注。注意改不了 take 的参数——那要跑新版本。',
    { project: S('项目 id 或名字'), node: S('节点 id 或标题'), title: S('新标题'), x: N('x'), y: N('y'), note: S('批注') },
    ['project', 'node'],
  ),
  fn(
    'put_text',
    '给 text 节点新增一版文本（不覆盖旧版）。提示词就这么迭代。',
    { project: S('项目 id 或名字'), node: S('节点 id 或标题'), text: S('新文本') },
    ['project', 'node', 'text'],
  ),
  fn(
    'import_media',
    '把本地已有的文件登记成一版（外拍素材、别处出的片子）。给绝对路径。',
    { project: S('项目 id 或名字'), node: S('节点 id 或标题'), path: S('本地文件绝对路径') },
    ['project', 'node', 'path'],
  ),
  fn(
    'link',
    '连线：from 的输出喂给 to。pin 默认 active（跟随上游当前版本），也可给 takeId 钉死某一版。',
    { project: S('项目 id 或名字'), from: S('上游节点 id 或标题'), to: S('下游节点 id 或标题'), pin: S("'active' 或某个 takeId") },
    ['project', 'from', 'to'],
  ),
  fn('unlink', '删掉一条连线', { project: S('项目 id 或名字'), edge: S('边 id（board 里能看到）') }, ['project', 'edge']),
  fn(
    'run',
    '跑一版新 take（不覆盖旧版）。params 可给 prompt / negative / seed / seconds / steps / workflow / aspect。默认等到出结果。',
    {
      project: S('项目 id 或名字'),
      node: S('节点 id 或标题'),
      mode: S('image 或 video（不给自己判断）'),
      params: {
        type: 'object',
        description: '参数，如 {"prompt":"...","seed":123}。seconds / aspect 省略就按项目默认（出片时长、首帧比例），别照抄别的项目的数',
      },
      wait: { type: 'boolean', description: '是否等出结果，默认 true' },
      timeout_s: N('等待上限秒数，默认 600'),
    },
    ['project', 'node'],
  ),
  fn(
    'sweep',
    '抽卡：同参数连跑 count 版，种子逐个递进。出量靠它。',
    {
      project: S('项目 id 或名字'),
      node: S('节点 id 或标题'),
      count: N('张数，默认 4'),
      params: { type: 'object', description: '参数' },
      mode: S('image 或 video'),
      timeout_s: N('等待上限秒数，默认 900'),
    },
    ['project', 'node'],
  ),
  fn(
    'op',
    `算子节点（剪辑动作）：${opsBrief()}。算子 id 和参数用 ops_help 查，别猜参数名；接戏的快捷动作走 lastframe。`,
    {
      project: S('项目 id 或名字'),
      node: S('节点 id 或标题'),
      op: S('算子 id（用 ops_help 查）'),
      params: { type: 'object', description: '算子参数，键名见 ops_help' },
      timeout_s: N('等待上限秒数，默认 300'),
    },
    ['project', 'node', 'op'],
  ),
  fn(
    'ops_help',
    '算子说明书：不传 op 列全部算子，传 op 给这个算子的入边要求和全部参数（键名/默认值/范围）。要动算子之前先查一次。',
    { op: S('算子 id，如 lastframe / muxaudio / subtitle；不传就列清单') },
  ),
  fn(
    'sequence',
    '看预览序列：画布上的镜头按剧情顺序（x 轴）排成一条片子，返回顺序、每镜时长与版本、总时长、哪些节点排不进去（没出片/跑挂）。剪片前先看它。',
    { project: S('项目 id 或名字'), end: S('只看以这个节点为结尾的上游镜头（id 或标题），不给就是整张画布') },
    ['project'],
  ),
  fn(
    'export_film',
    '一键出成片：照预览序列在画布上建（或复用）算子节点「成片」，把镜头按顺序连上去跑拼接，产物进 take 栈。',
    { project: S('项目 id 或名字'), end: S('以谁为结尾（id 或标题）'), name: S('成片节点名，默认「成片」'), timeout_s: N('等待上限秒数，默认 600') },
    ['project'],
  ),
  fn(
    'handoff_shots',
    '接戏：把这一镜的尾帧接成下一镜的首帧——在画布上真建尾帧节点并连线（边标 firstframe，出片只认它），跑完再跑下一镜就开在这张尾帧上。不传 to 就接 x 排在它后面的那一镜。',
    {
      project: S('项目 id 或名字'),
      from: S('哪一镜的结尾（节点 id 或标题）'),
      to: S('接到哪一镜（不给=按画布 x 顺序的下一镜）'),
      timeout_s: N('等尾帧跑完的秒数，默认 300'),
    },
    ['project', 'from'],
  ),
  fn(
    'first_frame',
    '查这一镜的首帧实际是谁给的（面板上也能看）：来源节点/take/文件；接戏接来的尾帧还没跑完时，会告诉卡在哪个节点。',
    { project: S('项目 id 或名字'), node: S('出片节点 id 或标题') },
    ['project', 'node'],
  ),
  fn('replay', '从某节点起沿链把下游全部重跑一遍（版本链重演）', { project: S('项目 id 或名字'), node: S('节点 id 或标题') }, ['project', 'node']),
  fn(
    'pin',
    '把节点的当前引脚切到某一版（take 可给 takeId，也可给 "v2" 这种序号）',
    { project: S('项目 id 或名字'), node: S('节点 id 或标题'), take: S('takeId 或 v 序号') },
    ['project', 'node', 'take'],
  ),
  fn('delete_node', '删节点（含它全部 take）。需要人确认。', { project: S('项目 id 或名字'), node: S('节点 id 或标题') }, ['project', 'node']),
  fn(
    'delete_take',
    '删掉某一版产物。不可逆，需要人确认。',
    { project: S('项目 id 或名字'), node: S('节点 id 或标题'), take: S('takeId 或 v 序号') },
    ['project', 'node', 'take'],
  ),
  fn('release_image', '杀掉生图实例 8888 让出显存（8188 绝不碰）。需要人确认。', {}),
  fn(
    'optimize_prompt',
    '把粗糙的想法变成专业提示词，返回多个候选。target=image 给生图（静态画面：主体/构图/光影/材质/镜头/风格）；target=video 给出片，按 MiniMax H3 技能规范输出多镜头结构化提示词（首帧已在图里，只写接下来发生什么）。默认自动参考项目里已有的画面（上游产物、相邻镜头，出片节点还会带上游图当首帧）和剧情线——除非 node 或 ref 都没给。',
    {
      idea: S('原始想法，可以是中文、可以很糙'),
      target: S('image 或 video'),
      count: N('候选数，默认 3'),
      style: S('风格倾向，如 电影感 / 赛博朋克 / 手绘'),
      refine: S('改进要求，如「更暗更压抑」「换个机位」'),
      current: S('既有提示词。给了就是精修：它的设定冻结，只做规范化，改动逐条报回来'),
      mode: S('refine（默认，保住既有设定）或 rewrite（允许推翻重写）'),
      project: S('项目 id 或名字（给了才会去收集参考画面和剧情线）'),
      node: S('这段词属于哪个节点（id 或标题）——参考图就是围着它收的'),
      ref: S('额外指定的参考：节点标题 / node:标题@v2 / take:xxx / path:绝对路径，逗号分隔'),
      auto: { type: 'boolean', description: '自动带上游与相邻镜头当参考，默认 true' },
      seconds: N('出片时长（秒，4-15）—— H3 按它算镜头预算，不给自己猜'),
      ratio: S('画幅，如 16:9 / 9:16'),
    },
    ['idea', 'target'],
  ),
  fn(
    'skill',
    '查技能规范（正文不常驻，别凭记忆写格式）：不给参数列技能与各层大小；给 mode 看该 mode 会装哪些文件；给 layer 读那一层原文（写高级长提示词时读 references/creative-showcase.md）。出片的词由 optimize_prompt 自动装配，这里用于自查与取质量标杆。',
    { skill: S('技能 id，默认 h3'), mode: S('h3 的 mode：i2va / ref2va / t2va / fl2va / l2va，默认 i2va'), layer: S('要读的层，如 references/creative-showcase.md') },
  ),
  fn(
    'review_takes',
    '抽卡评审：把几版产物压成缩略图真的送进模型看图，给每版打分排序、指出硬伤、挑出最优。挑片子用它，别靠种子和参数猜。',
    {
      project: S('项目 id 或名字'),
      node: S('节点 id 或标题'),
      take: S('只评这几版，逗号分隔（takeId 或 v 序号）；不给我就评最近 max 版'),
      criteria: S('评分标准，不给用默认（还原度/构图/光影/崩坏/当首帧可用性）'),
      max: N('最多评几版，默认 6'),
      pin_best: { type: 'boolean', description: '评完把最高分那版设为当前引脚，默认 false' },
      ref: S('额外对照画面：节点标题 / node:标题@v2 / take:xxx / path:绝对路径，逗号分隔'),
      auto_refs: { type: 'boolean', description: '自动拿上游和相邻镜头当对照判连贯度，默认 true' },
    },
    ['project', 'node'],
  ),
  fn(
    'diagnose',
    '失败诊断：读失败版本的错误原文，先过本地规则表（显存不够/实例没起/缺首帧/路径错/超时/模板被拒），不命中再问模型，给出原因和具体改法。',
    {
      project: S('项目 id 或名字'),
      node: S('节点 id 或标题；不给就扫全项目失败的版本'),
      take: S('只诊这几版（takeId 或 v 序号），逗号分隔'),
      use_llm: { type: 'boolean', description: '规则不命中时是否问模型，默认 true' },
    },
    ['project'],
  ),
  fn('story', '看剧情：分镜表 + 它跟画布的对应（哪几镜没填、哪几镜有成品）。动剧情之前先看。', { project: S('项目 id 或名字') }, ['project']),
  fn(
    'write_story',
    '让助手写一份剧情（给一句话想法）→ 落盘。要规范出片词再 refine_story。',
    {
      project: S('项目 id 或名字'),
      idea: S('一句话想法 / 故事梗概'),
      shots: N('要几镜，默认 6'),
      seconds: N('每镜几秒，不给就跟项目默认出片时长'),
      style: S('视觉风格'),
    },
    ['project', 'idea'],
  ),
  fn(
    'import_script',
    '导入剧本：分镜表/场景段落/JSON 自动切成镜头。镜头头认 ##、镜头1、1.、【】。',
    { project: S('项目 id 或名字'), text: S('剧本文本'), replace: { type: 'boolean', description: 'true=整份替换（默认），false=追加' }, title: S('片名') },
    ['project', 'text'],
  ),
  fn(
    'edit_story',
    '改剧情里的一镜（实时生效）。改完 fill_template 才落到节点上。',
    {
      project: S('项目 id 或名字'),
      beat: S('哪一镜：镜头名或 beat id'),
      title: S('新镜头名'),
      action: S('这一镜发生什么（中文）'),
      image: S('生图词（英文静态画面）'),
      video: S('出片词（从首帧开始发生什么）'),
      seconds: N('时长秒'),
      aspect: S('画幅档位，留空跟随首帧'),
      line: S('台词/旁白'),
    },
    ['project', 'beat'],
  ),
  fn(
    'fill_template',
    '按剧情填模板：每镜建「XX·首帧」+「XX」两节点、词进节点预设、连好线。重填只更新不重建。',
    { project: S('项目 id 或名字'), beats: S('只填这几镜（镜头名，逗号分隔），不给就全部') },
    ['project'],
  ),
  fn(
    'refine_story',
    '逐镜精修提示词（出片词走 H3 规范）。慢且花钱，要质量才开。',
    { project: S('项目 id 或名字'), beats: S('只精修这几镜（镜头名，逗号分隔），不给就全部'), target: S('image / video / both，默认 both') },
    ['project'],
  ),
  fn(
    'run_story',
    '一条龙跑初版：填模板 → 精修首帧词 → 首帧 → 释放显存 → 逐镜（精修出片词 → 接上一镜尾帧 → 出片，失败自动重试）→ 合成。分钟级长任务。',
    {
      project: S('项目 id 或名字'),
      beats: S('只跑这几镜（镜头名，逗号分隔），不给就全部'),
      refine: { type: 'boolean', description: '精修提示词再跑（装 H3 技能），默认 true；出片词在每镜出片前精修，那时能看着上一镜的尾帧写' },
      handoff: { type: 'boolean', description: '出片前把上一镜尾帧接成本镜首帧，默认 true（关了就是硬切）' },
      retries: { type: 'number', description: '每步失败重试几次，默认 2（最多试 3 次）' },
      film: { type: 'boolean', description: '出完片合成成片，默认 true' },
      timeout_s: N('单镜等待上限秒数，默认 900'),
    },
    ['project'],
  ),
];

// ── 引用解析：模型爱用标题，接口只认 id，两边都得吃 ─────────────────────
function findProject(ref: string): Project {
  const want = String(ref ?? '').trim();
  if (!want) throw new Error('没给项目');
  const projects = listProjects();
  const hit =
    projects.find((p) => p.id === want) ??
    projects.find((p) => p.name === want) ??
    projects.find((p) => p.name.includes(want) || p.id.includes(want));
  if (!hit) throw new Error(`找不到项目「${want}」。现有：${projects.map((p) => `${p.name}(${p.id})`).join('、') || '（一个都没有）'}`);
  return loadProject(hit.id);
}

function findNode(p: Project, ref: string): TakeNode {
  const want = String(ref ?? '').trim();
  if (!want) throw new Error('没给节点');
  const hit =
    p.nodes.find((n) => n.id === want) ??
    p.nodes.find((n) => n.title === want) ??
    p.nodes.find((n) => n.title.includes(want) || n.id.includes(want));
  if (!hit) throw new Error(`项目「${p.name}」里找不到节点「${want}」。现有：${p.nodes.map((n) => `${n.title}(${n.id})`).join('、') || '（空的）'}`);
  return hit;
}

function findTake(node: TakeNode, ref: string): Take {
  const want = String(ref ?? '').trim();
  const byIndex = /^v?(\d+)$/.exec(want);
  const hit =
    node.takes.find((t) => t.id === want) ??
    (byIndex ? node.takes[Number(byIndex[1]) - 1] : undefined) ??
    node.takes.find((t) => t.label === want);
  if (!hit) throw new Error(`节点「${node.title}」没有「${want}」这一版。现有：${node.takes.map((t, i) => `v${i + 1}`).join('、') || '（还没有版本）'}`);
  return hit;
}

const activeOf = (node: TakeNode): Take | undefined => node.takes.find((t) => t.id === node.activeTake) ?? node.takes[node.takes.length - 1];
const vIndex = (node: TakeNode, takeId?: string): number => (takeId ? node.takes.findIndex((t) => t.id === takeId) + 1 : 0);
const clip = (s: string | undefined, n = 70): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function takeLine(node: TakeNode, take: Take): string {
  const bits = [`v${vIndex(node, take.id)}`, take.status, take.source];
  if (take.op) bits.push(take.op);
  if (take.probe) bits.push(`${take.probe.width}×${take.probe.height}${take.probe.duration ? ` ${take.probe.duration}s` : ''}`);
  if (take.params?.aspect) bits.push(String(take.params.aspect));
  if (take.file) bits.push(take.file);
  if (take.error) bits.push(`错误：${clip(take.error, 120)}`);
  return bits.join(' · ');
}

/** 一个节点的单行摘要：谁、几版、当前哪版、吃了谁的哪版。 */
function nodeLine(p: Project, node: TakeNode): string {
  const active = activeOf(node);
  const ins = Object.entries(active?.inputs ?? {})
    .map(([nid, tid]) => {
      const up = p.nodes.find((n) => n.id === nid);
      return `${up?.title ?? nid} v${up ? vIndex(up, tid) : '?'}`;
    })
    .join(' + ');
  const head = `[${node.id}] ${node.kind} 「${node.title}」 ${node.takes.length} 版 · 当前 ${active ? `v${vIndex(node, active.id)}` : '（空）'}`;
  const text = node.kind === 'text' || node.kind === 'note' ? ` · 文本：${clip(active?.text, 90)}` : '';
  const prompt = active?.params?.prompt ? ` · 词：${clip(String(active.params.prompt), 70)}` : '';
  const used = ins ? ` · 吃 ← ${ins}` : '';
  return head + text + prompt + used;
}

function boardText(p: Project, jobs: JobProgress[]): string {
  const lines: string[] = [];
  lines.push(`工作台「${p.name}」id=${p.id} rev=${p.rev}`);
  lines.push(`默认模板：生图 ${p.settings.workflowImage} · 出片 ${p.settings.workflowVideo} · 出片前释放 8888=${p.settings.releaseImageBeforeVideo}`);
  lines.push(`节点 ${p.nodes.length}：`);
  for (const n of p.nodes) lines.push(`  ${nodeLine(p, n)}`);
  if (!p.nodes.length) lines.push('  （空画布）');
  lines.push(`连线 ${p.edges.length}：`);
  for (const e of p.edges) {
    const up = p.nodes.find((n) => n.id === e.from);
    const down = p.nodes.find((n) => n.id === e.to);
    const eff = e.pin === 'active' ? `active（现在生效 v${vIndex(up!, activeOf(up!)?.id)}）` : `钉死 v${vIndex(up!, e.pin)}`;
    lines.push(`  [${e.id}] ${up?.title ?? e.from} → ${down?.title ?? e.to} · pin=${eff}`);
  }
  // 比例提示：生图节点出的比例跟下游出片档位不一致时，出片会按自己的档位重构图
  for (const n of p.nodes) {
    if (n.kind !== 'image') continue;
    const down = downstreamAspect(p, n.id);
    if (!down) continue;
    const active = activeOf(n);
    const mine = typeof active?.params?.aspect === 'string' ? String(active.params.aspect) : undefined;
    const tail = down.usable ? '（生图不指定档位时按它走）' : '（来自首帧吸附，不作上游依据）';
    lines.push(
      mine && mine !== down.aspect
        ? `比例提示：「${n.title}」当前版本 ${mine}，下游「${down.nodeTitle}」档位 ${down.aspect} —— 出片会按 ${down.aspect} 重构图`
        : `比例提示：「${n.title}」下游「${down.nodeTitle}」档位 ${down.aspect}${tail}`,
    );
  }
  const mine = jobs.filter((j) => j.projectId === p.id && j.phase !== 'done');
  lines.push(mine.length ? `在跑作业：${mine.map((j) => `${j.nodeId} ${j.phase} ${Math.round(j.elapsedMs / 1000)}s`).join('；')}` : '在跑作业：无');
  return lines.join('\n');
}

// ── 审批门 ───────────────────────────────────────────────────────────
interface Pending {
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

const pendingApprovals = new Map<string, Pending>();

/** 前端点了「批准/拒绝」后调这里。返回 false 表示这个请求已经超时或不存在了。 */
export function resolveApproval(id: string, approve: boolean): boolean {
  const p = pendingApprovals.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pendingApprovals.delete(id);
  p.resolve(approve);
  return true;
}

export function pendingApprovalCount(): number {
  return pendingApprovals.size;
}

function askApproval(emit: Emit, tool: string, args: Record<string, unknown>, label: string, timeoutMs = 300_000): Promise<boolean> {
  const id = newId('ok');
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      emit({ type: 'confirm_result', id, approved: false });
      resolve(false);
    }, timeoutMs);
    pendingApprovals.set(id, { resolve, timer });
    emit({ type: 'confirm', id, label, tool, args });
  });
}

// ── 等待产物 ─────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询到这些 take 全部不再是 running。返回一句给人看的总结。 */
async function waitTakes(projectId: string, takeIds: string[], timeoutMs: number, emit: Emit): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const p = loadProject(projectId);
    const found = p.nodes.flatMap((n) => n.takes.map((t) => ({ node: n, take: t }))).filter((x) => takeIds.includes(x.take.id));
    const running = found.filter((x) => x.take.status === 'running');
    last = found.map((x) => `${x.node.title} ${takeLine(x.node, x.take)}`).join('\n');
    if (found.length === takeIds.length && !running.length) return last;
    emit({ type: 'project', projectId });
    await sleep(2000);
  }
  return `等待超时（${Math.round(timeoutMs / 1000)}s），当前状态：\n${last}\n产物可能还在跑——用 jobs_status 或 board 再看一眼。`;
}

// ── 工具实现 ─────────────────────────────────────────────────────────
const KIND_TITLE: Record<string, string> = { image: '图片', video: '视频', audio: '音频', text: '提示词', op: '算子', note: '批注' };

/** 剧情一览：给助手看的一页纸，带上它跟画布的对应关系。 */
function storyText(p: Project): string {
  const s = storyStatus(p.id);
  if (!s.beats.length) {
    return `「${p.name}」还没有剧情。用 write_story 写一份（给一句话想法），或 import_script 导入已有剧本。`;
  }
  const lines = s.beats.map((b, i) => {
    const mark = b.videoDone ? '✅ 出片了' : b.imageDone ? '◐ 有首帧' : b.imageNodeId ? '○ 填了没跑' : '· 还没填到画布';
    return `${i + 1}. ${b.title}（${b.seconds}s）${mark}\n   发生什么：${b.action || '（空）'}\n   生图词：${clip(b.image, 150) || '（空，会用「发生什么」兜底）'}\n   出片词：${clip(b.video, 150) || '（空，会用「发生什么」兜底）'}${b.line ? `\n   台词：${b.line}` : ''}`;
  });
  return `《${s.title || p.name}》${s.logline ? ` —— ${s.logline}` : ''}\n风格：${s.style || '（没定）'} · 共 ${s.beats.length} 镜 · 总时长 ${s.totalSeconds}s · 已填模板 ${s.filled} 镜 · 已出片 ${s.done} 镜\n\n${lines.join('\n')}`;
}

async function execTool(name: string, args: Record<string, any>, emit: Emit, hint?: string): Promise<string> {
  const a = args ?? {};
  const load = (): Project => findProject(String(a.project ?? hint ?? ''));
  const touch = (p: Project) => emit({ type: 'project', projectId: p.id });
  const jobEmit = (ev: JobProgress) => emit({ type: 'job', job: ev });

  switch (name) {
    case 'list_projects': {
      const ps = listProjects();
      return ps.length ? ps.map((p) => `${p.id} 「${p.name}」 节点 ${p.nodeCount} · 版本 ${p.takeCount}`).join('\n') : '还没有工作台，用 create_project 建一个。';
    }

    case 'board':
      return boardText(load(), jobsSnapshot());

    case 'node_detail': {
      const p = load();
      const node = findNode(p, a.node);
      const active = activeOf(node);
      const lines = [`[${node.id}] ${node.kind}「${node.title}」 位置 ${node.x},${node.y}  ${node.takes.length} 版`];
      const ins = p.edges.filter((e) => e.to === node.id);
      for (const e of ins) {
        const up = p.nodes.find((n) => n.id === e.from)!;
        const eff = e.pin === 'active' ? `active → 生效 v${vIndex(up, activeOf(up)?.id)}` : `钉死 v${vIndex(up, e.pin)}`;
        lines.push(`入边 [${e.id}] ← ${up.title}(${up.id}) ${eff}${up.kind === 'text' ? ` · 词：${clip(activeOf(up)?.text, 120)}` : ''}`);
      }
      if (active) {
        lines.push(`当前 v${vIndex(node, active.id)} 参数：${JSON.stringify(active.params ?? {})}`);
        if (active.text) lines.push(`当前文本：${active.text}`);
      }
      lines.push('版本栈：');
      for (const t of node.takes) lines.push(`  ${takeLine(node, t)}`);
      if (!node.takes.length) lines.push('  （还没有版本）');
      return lines.join('\n');
    }

    case 'templates': {
      const p = a.project || hint ? load() : null;
      const dir = p?.settings.workflowDir ?? DEFAULT_SETTINGS.workflowDir;
      const list = listTemplates(dir);
      return list
        .map((t) => {
          const knobs = t.bindings.map((b) => `${b.role}(${b.class}.${b.field})`).join(', ') || '无';
          return `${t.id} 「${t.title}」 host=${t.host ?? '默认'} 节点 ${t.nodeCount} 旋钮：${knobs}${t.aspectOptions?.length ? ` 比例档位：${t.aspectOptions.join(' | ')}` : ''}`;
        })
        .join('\n');
    }

    case 'env_status': {
      const [video, image] = await Promise.all([comfyStatus('http://127.0.0.1:8188'), comfyStatus('http://127.0.0.1:8888')]);
      const fmt = (c: typeof video) => (c.alive ? `在线 显存 ${c.vramFree ? (c.vramFree / 1e9).toFixed(1) + 'G' : '—'} 队列 ${c.running ?? 0}/${c.pending ?? 0}` : `离线 ${c.error ?? ''}`);
      const vp = portReport(VIDEO_PORT);
      const ip = portReport(8888);
      return `出片 8188：${fmt(video)}（pid ${vp.pid ?? '无'}）\n生图 8888：${fmt(image)}（pid ${ip.pid ?? '无'}）\n注意：出片前自动释放 8888；要关 8188 走 stop_instance，有作业在跑它会拦一道。`;
    }

    case 'jobs_status': {
      const jobs = jobsSnapshot().filter((j) => j.phase !== 'done');
      return jobs.length ? jobs.map((j) => `${j.jobId} ${j.nodeId} ${j.phase} ${Math.round(j.elapsedMs / 1000)}s ${j.detail ?? j.error ?? ''}`).join('\n') : '没有在跑的作业。';
    }

    case 'create_project': {
      const p = createProject(String(a.name ?? '未命名工作台'));
      touch(p);
      return `建好工作台「${p.name}」id=${p.id}（空画布）`;
    }

    case 'add_node': {
      const p = load();
      const kind = String(a.kind ?? 'image') as NodeKind;
      const node: TakeNode = {
        id: newId('n'),
        kind,
        title: String(a.title ?? KIND_TITLE[kind] ?? kind),
        x: Number(a.x ?? 80 + p.nodes.length * 260),
        y: Number(a.y ?? 80),
        takes: [],
      };
      if (kind === 'text' || kind === 'note') {
        const text = String(a.text ?? '');
        node.takes.push({
          id: newId('take'),
          nodeId: node.id,
          createdAt: Date.now(),
          finishedAt: Date.now(),
          status: 'done',
          source: 'text',
          kind: 'image',
          text,
          params: { prompt: text },
          inputs: {},
        });
        node.activeTake = node.takes[0].id;
      }
      p.nodes.push(node);
      saveProject(p);
      touch(p);
      return `加了 ${kind} 节点「${node.title}」id=${node.id} 位置 ${node.x},${node.y}`;
    }

    case 'update_node': {
      const p = load();
      const node = findNode(p, a.node);
      if (a.title !== undefined) node.title = String(a.title);
      if (a.x !== undefined) node.x = Number(a.x);
      if (a.y !== undefined) node.y = Number(a.y);
      if (a.note !== undefined) node.note = String(a.note);
      saveProject(p);
      touch(p);
      return `改了「${node.title}」：${JSON.stringify({ title: node.title, x: node.x, y: node.y })}`;
    }

    case 'put_text': {
      const p = load();
      const node = findNode(p, a.node);
      const text = String(a.text ?? '');
      const take: Take = {
        id: newId('take'),
        nodeId: node.id,
        createdAt: Date.now(),
        finishedAt: Date.now(),
        status: 'done',
        source: 'text',
        kind: 'image',
        text,
        params: { prompt: text },
        inputs: {},
        label: a.label,
      };
      node.takes.push(take);
      node.activeTake = take.id;
      if (node.kind !== 'text' && node.kind !== 'note') node.kind = 'text';
      saveProject(p);
      touch(p);
      return `「${node.title}」新增 v${node.takes.length}：${clip(text, 120)}`;
    }

    case 'import_media': {
      const p = load();
      const node = findNode(p, a.node);
      const src = path.resolve(String(a.path ?? ''));
      if (!fs.existsSync(src)) throw new Error(`文件不存在：${src}`);
      const dir = path.join(mediaDir(p.id), node.id);
      fs.mkdirSync(dir, { recursive: true });
      const takeId = newId('take');
      const abs = uniquePath(dir, `${takeId}${path.extname(src)}`);
      fs.copyFileSync(src, abs);
      const take: Take = {
        id: takeId,
        nodeId: node.id,
        createdAt: Date.now(),
        finishedAt: Date.now(),
        status: 'done',
        source: 'import',
        kind: node.kind === 'video' ? 'video' : 'image',
        file: relMedia(p.id, abs),
        params: {},
        inputs: {},
        label: path.basename(src),
      };
      node.takes.push(take);
      node.activeTake = take.id;
      saveProject(p);
      touch(p);
      return `登记进「${node.title}」：${take.file}`;
    }

    case 'link': {
      const p = load();
      const from = findNode(p, a.from);
      const to = findNode(p, a.to);
      if (from.id === to.id) throw new Error('不能连到自己');
      const pin = a.pin ? String(a.pin) : 'active';
      if (pin !== 'active' && !from.takes.some((t) => t.id === pin)) throw new Error(`上游「${from.title}」没有 takeId=${pin}`);
      const edge = { id: newId('e'), from: from.id, to: to.id, pin, createdAt: Date.now() } as Project['edges'][number];
      p.edges.push(edge);
      saveProject(p);
      touch(p);
      return `连好 [${edge.id}]：${from.title} → ${to.title} pin=${pin}`;
    }

    case 'unlink': {
      const p = load();
      const edge = p.edges.find((e) => e.id === a.edge);
      if (!edge) throw new Error(`没有 id=${a.edge} 的连线`);
      p.edges = p.edges.filter((e) => e.id !== edge.id);
      saveProject(p);
      touch(p);
      return `删了连线 [${edge.id}]`;
    }

    case 'run': {
      const p = load();
      const node = findNode(p, a.node);
      const take = runNode(
        { projectId: p.id, nodeId: node.id, mode: a.mode, params: a.params, overrides: a.overrides, label: a.label },
        jobEmit,
      );
      touch(p);
      if (a.wait === false) return `已提交「${node.title}」新版本 takeId=${take.id}（没等结果，用 board / jobs_status 看）`;
      const summary = await waitTakes(p.id, [take.id], Number(a.timeout_s ?? 600) * 1000, emit);
      return `「${node.title}」跑完：\n${summary}`;
    }

    case 'sweep': {
      const p = load();
      const node = findNode(p, a.node);
      const takes = runSweep(
        { projectId: p.id, nodeId: node.id, mode: a.mode, params: a.params, overrides: a.overrides, label: a.label },
        Number(a.count ?? 4),
        jobEmit,
      );
      touch(p);
      const summary = await waitTakes(p.id, takes.map((t) => t.id), Number(a.timeout_s ?? 900) * 1000, emit);
      return `「${node.title}」抽了 ${takes.length} 版：\n${summary}`;
    }

    case 'ops_help':
      return a.op ? opHelp(String(a.op)) : opsBrief();

    case 'op': {
      const p = load();
      const node = findNode(p, a.node);
      const take = runOp(p.id, node.id, String(a.op), a.params ?? {}, jobEmit);
      touch(p);
      const summary = await waitTakes(p.id, [take.id], Number(a.timeout_s ?? 300) * 1000, emit);
      return `算子 ${a.op} 完成：\n${summary}`;
    }

    case 'sequence': {
      const p = load();
      const end = a.end ? findNode(p, a.end) : undefined;
      const seq = sequenceOf(p.id, end?.id);
      const skip = seq.skipped.length ? `\n排不进去：${seq.skipped.map((s) => `${s.title}(${s.why})`).join('、')}` : '';
      if (!seq.shots.length) return `${seq.source}：还没有能播的镜头${skip}`;
      const lines = seq.shots.map((s, i) => `${i + 1}. ${s.title} v${s.index} · ${s.duration.toFixed(1)}s${s.hasAudio ? ' · 有声' : ''}`);
      return `${seq.source}：共 ${seq.shots.length} 镜 · ${seq.totalSeconds.toFixed(1)}s\n${lines.join('\n')}${skip}`;
    }

    case 'export_film': {
      const p = load();
      const end = a.end ? findNode(p, a.end) : undefined;
      const out = exportFilm(p.id, { end: end?.id, name: a.name ? String(a.name) : undefined }, jobEmit);
      touch(p);
      const summary = await waitTakes(p.id, [out.take.id], Number(a.timeout_s ?? 600) * 1000, emit);
      return `成片节点「${out.node.title}」拼了 ${out.shots} 镜：\n${summary}`;
    }

    case 'replay': {
      const p = load();
      const node = findNode(p, a.node);
      const out = replay(p.id, node.id, jobEmit);
      touch(p);
      return `从「${node.title}」重演下游：顺序 ${out.order.join(' → ')}，已启动 ${out.started.length} 个`;
    }

    case 'handoff_shots': {
      const p = load();
      const from = findNode(p, a.from);
      const to = a.to ? findNode(p, a.to) : undefined;
      const out = handoffShot(p.id, { from: from.id, to: to?.id }, jobEmit);
      touch(p);
      const summary = await waitTakes(p.id, [out.frameTake.id], Number(a.timeout_s ?? 300) * 1000, emit);
      return `接戏：「${out.from.title}」v${out.from.index} 的尾帧 → 「${out.to.title}」的首帧\n尾帧节点「${out.frameNode.title}」：\n${summary}`;
    }

    case 'first_frame': {
      const p = load();
      const node = findNode(p, a.node);
      const got = firstFrameOf(p.id, node.id);
      if (got.frame) {
        const src = p.nodes.find((n) => n.id === got.frame!.nodeId);
        return `「${node.title}」的首帧来自「${src?.title ?? got.frame.nodeId}」（take ${got.frame.takeId}）`;
      }
      if (got.blockedBy) return `「${node.title}」的首帧接的是「${got.blockedBy}」，但它还没跑完/没成 —— 等它 done 再出片`;
      return `「${node.title}」还没有首帧来源：把图片节点连到它，或用 handoff_shots 把上一镜的尾帧接过来`;
    }


    case 'pin': {
      const p = load();
      const node = findNode(p, a.node);
      const take = findTake(node, a.take);
      node.activeTake = take.id;
      saveProject(p);
      touch(p);
      return `「${node.title}」当前版本切到 v${vIndex(node, take.id)}（${take.file ?? clip(take.text, 40)}）`;
    }

    case 'delete_node': {
      const p = load();
      const node = findNode(p, a.node);
      p.nodes = p.nodes.filter((n) => n.id !== node.id);
      p.edges = p.edges.filter((e) => e.from !== node.id && e.to !== node.id);
      saveProject(p);
      touch(p);
      return `删了节点「${node.title}」（含 ${node.takes.length} 版）`;
    }

    case 'delete_take': {
      const p = load();
      const node = findNode(p, a.node);
      const take = findTake(node, a.take);
      const idx = vIndex(node, take.id);
      node.takes = node.takes.filter((t) => t.id !== take.id);
      if (node.activeTake === take.id) node.activeTake = node.takes[node.takes.length - 1]?.id;
      for (const e of p.edges) if (e.pin === take.id) e.pin = 'active';
      saveProject(p);
      touch(p);
      return `删了「${node.title}」v${idx}；当前版本现在是 v${vIndex(node, node.activeTake)}`;
    }

    case 'release_image': {
      const rep = releaseImagePort(8888);
      return rep.pid ? `8888 上的进程 ${rep.pid} ${rep.killed ? '已杀掉' : '没杀掉（可能还占着）'}` : '8888 上没有监听进程，不用杀';
    }

    case 'start_instance': {
      const r = await startInstance(String(a.id));
      return `${r.detail}${r.ok ? '' : `\n日志尾巴：\n${r.log || '(空)'}`}`;
    }

    case 'stop_instance': {
      const r = stopInstance(String(a.id), { force: !!Number(a.force) });
      return r.busy ? `没关：${r.detail}。确认要打断就再调一次并带 force=1。` : r.detail;
    }

    case 'optimize_prompt': {
      const target = a.target === 'video' ? 'video' : 'image';
      const specs = String(a.ref ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // 参考画面要围着一个节点收：给了 project/node 才去翻项目，纯文字润色不翻
      let refs: RefImage[] | undefined;
      let story: string | undefined;
      let nodeTitle: string | undefined;
      let note = '';
      // 时长/画幅没显式给就跟项目默认走：TARGET 段写错，模型就按错的时间轴和画幅规划镜头
      const proj = a.project || a.node ? load() : undefined;
      if (proj) {
        try {
          const self = a.node ? findNode(proj, a.node) : undefined;
          const bundle = await collectRefs({ projectId: proj.id, nodeId: self?.id, refs: specs, auto: a.auto !== false, target });
          refs = bundle.images.length ? bundle.images : undefined;
          story = bundle.story || undefined;
          nodeTitle = self?.title;
          note = refsText(bundle);
        } catch (e) {
          note = `参考画面没收上（照旧按纯文字给）：${e instanceof Error ? e.message : String(e)}`;
        }
      } else if (specs.length) {
        note = 'ref 要配 project 或 node 才能取到画面，这次只按文字给。';
      }
      const out = await optimizePrompt({
        idea: String(a.idea ?? ''),
        target,
        count: Number(a.count ?? 3),
        style: a.style,
        refine: a.refine,
        current: a.current,
        mode: a.mode === 'rewrite' ? 'rewrite' : a.mode === 'refine' ? 'refine' : undefined,
        refs,
        story,
        nodeTitle,
        seconds: Number(a.seconds) > 0 ? Number(a.seconds) : proj?.settings.videoSeconds,
        ratio: a.ratio ? String(a.ratio) : proj ? frameRatio(proj.settings.frameSize) : undefined,
      });
      const lines = out.candidates.map((c, i) => {
        const head = `候选 ${i + 1}${c.note ? `（${c.note}）` : ''}${c.changes?.length ? ` · 相对既有词改动 ${c.changes.length} 处` : ''}`;
        const ch = c.changes?.length ? `\n${c.changes.map((x) => `  · ${x}`).join('\n')}` : '';
        return `${head}：\n${c.text}${ch}`;
      });
      if (out.negative) lines.push(`负面词（单独给 params.negative，绝对不要拼进 prompt 正文）：\n${out.negative}`);
      if (out.tips) lines.push(`建议：${out.tips}`);
      if (note) lines.unshift(note);
      return lines.join('\n\n');
    }

    case 'skill': {
      const id = String(a.skill ?? '').trim() || SKILLS[0].id;
      const layer = String(a.layer ?? '').trim();
      if (layer) return findSkill(id).read(layer);
      return skillCatalog(id, String(a.mode ?? '').trim() || undefined);
    }

    case 'diagnose': {
      const p = load();
      const node = a.node ? findNode(p, a.node) : undefined;
      const refs = String(a.take ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const out = await diagnose({ projectId: p.id, nodeId: node?.id, takeIds: refs.length ? refs : undefined, useLlm: a.use_llm !== false });
      return diagnoseText(out);
    }

    case 'review_takes': {
      const p = load();
      const node = findNode(p, a.node);
      const refs = String(a.take ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const out = await reviewTakes({
        projectId: p.id,
        nodeId: node.id,
        takeIds: refs.length ? refs : undefined,
        criteria: a.criteria,
        max: a.max,
        pinBest: !!a.pin_best,
        refs: String(a.ref ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        autoRefs: a.auto_refs !== false,
      });
      touch(p);
      return reviewText(out);
    }

    case 'story': {
      const p = load();
      return storyText(p);
    }

    case 'write_story': {
      const p = load();
      const drafted = await draftStory({
        idea: String(a.idea ?? ''),
        shots: Number(a.shots) || undefined,
        seconds: Number(a.seconds) || undefined,
        style: a.style ? String(a.style) : undefined,
        context: p.story?.logline ? `已有故事：${p.story.logline}` : undefined,
      });
      writeStory(p.id, drafted);
      touch(p);
      return `写好剧情《${drafted.title}》（${drafted.beats.length} 镜，共 ${drafted.beats.reduce((s, b) => s + b.seconds, 0)}s）：\n${drafted.beats.map((b, i) => `${i + 1}. ${b.title}（${b.seconds}s）：${b.action}`).join('\n')}\n\n下一步：看一遍改一改，然后 fill_template 填到画布上；要规范出片词就先 refine_story。`;
    }

    case 'import_script': {
      const p = load();
      const story = importScript(p.id, String(a.text ?? ''), { replace: a.replace, title: a.title ? String(a.title) : undefined });
      touch(p);
      return `导入完成：《${story.title}》共 ${story.beats.length} 镜\n${story.beats.map((b, i) => `${i + 1}. ${b.title}：${clip(b.action || b.image, 60)}`).join('\n')}`;
    }

    case 'edit_story': {
      const p = load();
      const patch: Record<string, unknown> = {};
      for (const k of ['title', 'action', 'image', 'video', 'aspect', 'line']) if (a[k] !== undefined) patch[k] = String(a[k]);
      if (a.seconds !== undefined) patch.seconds = Number(a.seconds);
      if (!Object.keys(patch).length) throw new Error('没给要改的字段');
      const story = editBeat(p.id, String(a.beat ?? ''), patch);
      touch(p);
      const beat = story.beats.find((b) => b.title === patch.title) ?? story.beats.find((b) => b.title === String(a.beat)) ?? story.beats[0];
      return `改好「${beat?.title}」：${JSON.stringify(patch)}\n（还没落到节点上——fill_template 之后才是画布上的词）`;
    }

    case 'fill_template': {
      const p = load();
      const beats = String(a.beats ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const out = applyStory(p.id, { beats: beats.length ? beats : undefined });
      return `填好模板：新建 ${out.created.length} 镜 · 更新 ${out.updated.length} 镜 · 新连线 ${out.edges} 条（共 ${out.total} 镜）\n每镜一对节点：「XX·首帧」→「XX」，词写在节点预设参数里，点开就能改。`;
    }

    case 'refine_story': {
      const p = load();
      const beats = String(a.beats ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const out = await refineStory(
        p.id,
        { beats: beats.length ? beats : undefined, target: a.target },
        (prog) => emit({ type: 'assistant', text: `▸ 精修 ${prog.index}/${prog.total}：${prog.title}·${prog.target === 'video' ? '出片' : '首帧'}` }),
      );
      touch(p);
      const bad = out.failed.length ? `\n失败 ${out.failed.length} 条：${out.failed.map((f) => `${f.title}(${f.why})`).join('、')}` : '';
      return `精修完 ${out.refined} 条提示词${bad}\n出片词现在是 H3 规范格式（instruction 行 + 多镜时间轴 + 声景 + 配乐）。`;
    }

    case 'run_story': {
      const p = load();
      const beats = String(a.beats ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await runStory(
        p.id,
        {
          beats: beats.length ? beats : undefined,
          refine: a.refine === undefined ? undefined : !!a.refine,
          handoff: a.handoff === undefined ? undefined : !!a.handoff,
          retries: a.retries === undefined ? undefined : Number(a.retries),
          film: a.film !== false,
          timeoutMs: Number(a.timeout_s ?? 900) * 1000,
        },
        (ev) => {
          if (ev.phase === 'image' || ev.phase === 'video' || ev.phase === 'release' || ev.phase === 'handoff' || ev.phase === 'retry' || ev.phase === 'export' || ev.phase === 'failed') {
            emit({ type: 'assistant', text: `▸ ${ev.detail}` });
          }
        },
      );
      touch(p);
      const bad = res.failed.length ? `\n失败 ${res.failed.length} 条：\n${res.failed.map((f) => `- ${f.title}·${f.stage}：${f.why}`).join('\n')}` : '';
      return `初版跑完（${res.seconds}s）：首帧 ${res.images} · 出片 ${res.videos}${res.film ? ' · 成片 1' : ''}${bad}\n下一步：看预览台连着播一遍，挑哪一镜要重跑就单独 run。`;
    }

    default:
      throw new Error(`没有这个工具：${name}`);
  }
}

// ── 会话与循环 ───────────────────────────────────────────────────────
interface Session {
  history: ChatMessage[];
  updatedAt: number;
}

const sessions = new Map<string, Session>();
/** 历史裁剪双预算：条数管「聊太久」，字符管「单条巨大」（board 一次能吐上万字）。 */
const MAX_KEEP = 200;
const MAX_KEEP_CHARS = 240_000;
const SESSION_TTL = 6 * 60 * 60 * 1000;

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.updatedAt > SESSION_TTL) sessions.delete(id);
}

/**
 * 只裁「轮」不裁单条：tool 消息必须跟着它那条 assistant.tool_calls，否则下一轮会被 LLM 拒绝。
 * 条数上限不能太小——写剧本是十几轮的长活，砍掉前几镜它就断片重写。
 */
function trimHistory(history: ChatMessage[]): ChatMessage[] {
  let tail = history.slice(-MAX_KEEP);
  let chars = 0;
  let cut = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    chars += textOf(tail[i].content).length + JSON.stringify(tail[i].tool_calls ?? '').length;
    if (chars > MAX_KEEP_CHARS) {
      cut = i + 1;
      break;
    }
  }
  tail = tail.slice(cut);
  while (tail.length && tail[0].role === 'tool') tail = tail.slice(1);
  return tail;
}

/** 轮次用尽时的现场快照：把剧本台账摆出来，它才报得出「断在哪一镜」。 */
function progressSnapshot(projectId?: string): string {
  if (!projectId) return '（没有打开的画布，照上面工具结果自己总结）';
  try {
    const p = loadProject(projectId);
    const s = storyStatus(projectId);
    const lines = [`画布「${p.name}」：${p.nodes.length} 个节点 / ${p.edges.length} 条连线`];
    if (!s.beats.length) {
      lines.push('剧本：还没有');
    } else {
      const written = s.beats.filter((b) => b.image || b.video).length;
      lines.push(
        `剧本《${s.title || '未命名'}》共 ${s.beats.length} 镜：${written} 镜有词、${s.filled} 镜已落到画布、${s.done} 镜已出片`,
      );
      s.beats.forEach((b, i) => {
        const marks = [b.image ? '首帧词' : '', b.video ? '出片词' : '', b.imageDone ? '首帧已出' : '', b.videoDone ? '已出片' : ''].filter(Boolean);
        lines.push(`  ${i + 1}. ${b.title}${marks.length ? `（${marks.join('/')}）` : '（词还没写）'}`);
      });
    }
    return lines.join('\n');
  } catch {
    return '（读不到画布）';
  }
}

export function resetSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

export function agentStatus(): { configured: boolean; model: string; baseUrl: string; source: string; tools: number; sessions: number; pending: number } {
  const cfg = llmConfig();
  return {
    configured: cfg.configured,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    source: cfg.source,
    tools: TOOLS.length,
    sessions: sessions.size,
    pending: pendingApprovals.size,
  };
}

export interface AgentRun {
  sessionId?: string;
  /** 用户当前在看的项目：塞进系统提示，省一轮 board 调用 */
  projectId?: string;
  text: string;
  maxRounds?: number;
}

export async function runAgent(run: AgentRun, emit: Emit): Promise<{ sessionId: string; final: string }> {
  pruneSessions();
  const sessionId = run.sessionId?.trim() || newId('s');
  emit({ type: 'session', sessionId });

  const session = sessions.get(sessionId) ?? { history: [], updatedAt: Date.now() };
  sessions.set(sessionId, session);

  let context = '';
  if (run.projectId) {
    try {
      context = `\n\n## 用户当前打开的画布（多半就是在说这个）\n${boardText(loadProject(run.projectId), jobsSnapshot())}`;
    } catch {
      // 项目被删了就当作没有上下文，不打断对话
    }
  }

  const trimmed = trimHistory(session.history);
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM + context }, ...trimmed];
  messages.push({ role: 'user', content: run.text });

  const maxRounds = Math.min(Math.max(run.maxRounds ?? 60, 1), 120);
  let final = '';
  const saidParts: string[] = [];
  let usage: Record<string, number> | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    emit({ type: 'round', round });
    const res = await chat(messages, TOOLS);
    usage = res.usage ?? usage;
    const msg = res.message;
    messages.push(msg);
    const said = textOf(msg.content).trim();
    if (said) emit({ type: 'assistant', text: said });

    if (res.finished) {
      final = said || '（我这边没有要补充的了）';
      break;
    }

    // 模型经常「一边说要做什么、一边就把工具调了」。以前这种正文只在事件流里闪一下，
    // 不进 final，前端拿到的收尾话就是空的——看着像它没说话。攒起来，收尾时兜底。
    if (said) saidParts.push(said);

    for (const call of msg.tool_calls ?? []) {
      const name = call.function.name;
      let args: Record<string, any> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: `参数不是合法 JSON：${clip(call.function.arguments, 200)}` });
        continue;
      }

      if (GUARDED.has(name)) {
        const ok = await askApproval(emit, name, args, `助手想执行 ${name}：${clip(JSON.stringify(args), 200)}`);
        emit({ type: 'confirm_result', id: '', approved: ok });
        if (!ok) {
          messages.push({ role: 'tool', tool_call_id: call.id, name, content: '用户拒绝了这一步（或超时未响应）。别重试同一个动作，换个做法或者问用户。' });
          continue;
        }
      }

      emit({ type: 'tool', name, args, status: 'running' });
      const t0 = Date.now();
      try {
        const out = await execTool(name, args, emit, run.projectId);
        emit({ type: 'tool', name, args, status: 'ok', result: clip(out, 400), ms: Date.now() - t0 });
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: out });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: 'tool', name, args, status: 'error', result: message, ms: Date.now() - t0 });
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: `失败：${message}` });
      }
    }
  }

  if (!final) {
    // 轮次用完了还没收尾。光让它「说两句」只会得到一句含糊总结——
    // 把剧本台账摆回去，它才报得出「写到第几镜、断在哪」。
    messages.push({
      role: 'user',
      content: `轮次用完了（上限 ${maxRounds} 轮）。别道歉，也别复述过程。照着下面的现场快照，用两三句中文说清：已经做完什么、断在哪一步、下一步该做什么。\n\n${progressSnapshot(run.projectId)}`,
    });
    const res = await chat(messages, []);
    final = textOf(res.message.content).trim() || saidParts.slice(-2).join('\n\n') || '轮次用完了，没来得及总结。';
    messages.push(res.message);
    emit({ type: 'assistant', text: final });
  }

  // 只把本轮的增量存回会话：messages[0] 是 system，后面 trimmed 那一段是老历史
  session.history = trimHistory([...session.history, ...messages.slice(1 + trimmed.length)]);
  session.updatedAt = Date.now();
  emit({ type: 'done', text: final, usage });
  return { sessionId, final };
}
