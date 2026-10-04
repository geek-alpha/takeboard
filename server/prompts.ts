import { chatJson, longFormTokens, userWithImages } from './llm.ts';
import { classifyMode, loadH3Skill, type H3Mode } from './h3-skill.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { frameRatio } from './workflows.ts';
import type { RefImage } from './refs.ts';

/**
 * 提示词优化：把糙想法变成能喂给模型的词。
 *
 * 两套语境差别很大，别混：
 *  - image（z-image / sdxl 系）：一张静态画面，要写清主体、构图、光、材质、镜头、风格
 *  - video（MiniMax H3 i2v）：首帧图已经在提示词外面给模型了，词里只管「接下来发生什么」——
 *    主体动作、镜头运动、时间演进。重述静态外观会跟首帧打架，这是 i2v 最常见的翻车点。
 *
 * 光有文字语境不够：项目里已经有画面时，模型得真的看见那些画面（参考图走多模态），
 * 否则它写的「冷雨夜」可能跟上一镜的暖阳对不上——剧情连贯就是这么断的。
 */

export type PromptTarget = 'image' | 'video';

export interface OptimizeRequest {
  idea: string;
  target: PromptTarget;
  count?: number;
  /** 风格倾向：电影感 / 赛博朋克 / 手绘 … */
  style?: string;
  /** 改进要求：更暗、换个机位 … */
  refine?: string;
  /** 要改的现有提示词 */
  current?: string;
  /** refine=既有词是定稿，只许规范化（默认：有 current 就是它）；rewrite=允许推翻重写 */
  mode?: 'refine' | 'rewrite';
  /** 补充语境：项目名、节点标题、首帧长什么样 */
  context?: string;
  /** 参考画面（已压好的 data URL）：模型看着已有画面写词，跨镜才连得上 */
  refs?: RefImage[];
  /** 剧情线：项目里各镜头按顺序的提示词 */
  story?: string;
  /** 这段词属于哪个节点（模型据此知道自己在写第几镜） */
  nodeTitle?: string;
  /** 出片目标时长（秒）：H3 技能的 TARGET 段要用它算镜头预算 */
  seconds?: number;
  /** 画幅，如 16:9 / 9:16 —— 同样进 TARGET 段 */
  ratio?: string;
}

export interface PromptCandidate {
  text: string;
  note?: string;
  /** 精修模式下：相对既有词改了哪几处（一处没改就是空数组） */
  changes?: string[];
}

export interface OptimizeResult {
  candidates: PromptCandidate[];
  /** 这次走的是哪条路：精修（保住设定）还是重写 */
  mode?: 'refine' | 'rewrite';
  negative?: string;
  tips?: string;
  /** 实际送进模型的参考画面（没给就是空） */
  refs?: string[];
}

const IMAGE_RULES = `你给文生图模型写提示词（z-image / SDXL 一系）。要求：
- 全英文，逗号分隔的短语流，不要整句、不要「a photo of」这种废话开头
- 必须覆盖：主体及其动作/状态、环境、构图与机位、光线、材质质感、镜头与焦段、风格、画质
- 具体胜于华丽：写「湿透的深灰羊毛大衣贴在肩上」，不写「史诗般震撼」
- 一张图只讲一个瞬间，别塞叙事、别塞多个场景
- 每条候选给不同的取舍（机位/光/风格各偏一点），让人有得选，别写三个近义词版本
- 中文想法的原意不能丢：主体是谁、在干什么，必须保持`;

/** 两个语境共用的连续性条款：参考画面给到就必须接得上，否则跨镜就断。 */
const CONTINUITY = `
连续性（给了参考画面才适用，没给就别编）：
- 参考画面里已经确立的东西——人物长相、服装、发型、道具、场景、光线基调、色调、画风——默认不改，只动机位、动作瞬间和构图取舍
- 人物的既定设定（黑脸、黑发、固定服饰这类反复出现的特征）必须原样沿用，别自己换一套
- 真要推翻某条设定，只在改进要求里明说了才推翻，并在 note 里说清推翻了什么
- 别把参考里没出现的人、物件、文字凭空加进画面`;

const VIDEO_RULES = `你给图生视频模型写提示词（MiniMax H3 image-to-video，首帧图由模型单独拿到）。要求：
- 全英文。只写「从这一帧开始发生了什么」，不要重述画面里已有的静态外观、不要重新描述人物长相和场景
- 按时间写：主体动作（含幅度与速度）→ 镜头运动（推/拉/摇/跟/手持/固定）→ 光影与氛围变化 → 收尾状态
- 动作要能在一段短片里做完，且是一个连贯动作，不要塞两段不相关的戏
- 明确写出镜头是固定还是运动；不写的话模型会乱晃
- 需要环境动起来就写清（风、水、烟、人群、光线扫过），这是让画面「活」的关键
- 每条候选给不同的运动方案（比如：固定镜头只让人物动 / 缓慢推近 / 环绕），让人有得选`;

/** 出片语境的额外连续性：i2v 的首帧、跨镜接戏都在这里。 */
const VIDEO_CONTINUITY = `
接戏（只对出片）：
- 标着「首帧」的那张就是第 0 帧：只写它之后发生什么，不要重述它的外观
- 标着「上一镜结尾」的：动作方向、视线、光线、运动趋势要能接上，不要突然换方向或换光
- 标着「下一镜开头」的：收尾状态要能接到它，别把人物走到接不上的位置
- 参考里的首帧和上一镜结尾对不上时（光线/服装/机位打架），在 tips 里直接说出来，别默默选一个`;

/**
 * 技能规定「输出只含规定字段」，但 takeboard 的接口是 JSON 候选。
 * 这层说清优先级：字段格式听技能的，外层壳听 takeboard 的——两边都不许越界。
 */
const H3_DELIVERY = `# 交付形态（takeboard 接口，覆盖技能里「只输出字段」那一条）
技能规定的那套字段（i2va/fl2va 的 instruction 行、integrated_multimodal_description、overall_soundscape、non_diegetic_music）整体放进候选的 text 字段，一个字段都别省，字段内部严格照技能的格式规范（时间戳、机位写法、台词标记）。
text 之外只包一层 JSON 外壳，别在 text 里写「候选一」「以下是」这类前言。
negative 只对生图有意义，出片留空字符串。`;

/**
 * 精修契约：既有词是定稿，模型只许规范化。
 * 少了这一层，模型会把既有词当成「想法」重新创作一遍——改出来的东西像换了个片子。
 */
const REFINE_CONTRACT = `# 这次是「精修既有提示词」，不是重写（最高优先级，压过上面所有创作条款）
既有提示词是定稿。你的活是把它规范化、补足、去噪，不是重新写一段。

冻结清单（改任何一条都算失败）：
- 主体：是谁、几个人、长相/服装/发型/道具
- 场景：地点、时间、天气、光线基调、色调、画风
- 结构：镜头数量与顺序、每个镜头的核心动作
- 台词：内容与说话人

只许动这四类：
- 格式：按规范重排字段、时间戳、机位写法、声景与配乐分栏
- 颗粒度：既有词里含糊或缺的维度补具体（缺运镜就补，但必须是既有动作能承载的运镜）
- 措辞：模糊词换精确词、删重复与废话、术语统一
- 语病：语法与拼写

判定标准：新旧两段并排，你能指出的每一处差异都要写进 changes；指不出的差异就是违约。
既有词写了的，不许「顺手升级」成你更喜欢的版本；既有词没写的，补足时也不许改它的走向。
候选之间也只能在措辞与颗粒度上分岔——不许拿运镜、画风、光线当候选卖点，那是改设定，不是给人选。`;

/**
 * 只拼规则正文，不碰模型——两套语境互不串门，这条边界要能离线验。
 * 生图：内置静态规则，不装 H3。H3 是出片规范（时间轴/声景/运镜），塞给生图既是纯浪费又会带偏静态画面。
 * 出片：装 H3 技能（按参考帧判 mode），技能读不到才回退内置短规则。
 */
export function promptRules(target: PromptTarget, refs: RefImage[] = []): { rules: string; skillMode?: H3Mode } {
  // 技能正文里已有 continuity 条款；内置的 CONTINUITY 还带着项目特有的既定设定（固定服饰/无脸角色），两套并存
  if (target === 'image') return { rules: `${IMAGE_RULES}${refs.length ? CONTINUITY : ''}` };

  const skill = loadH3Skill(classifyMode(refs.map((r) => r.role)));
  const base = skill.text ? skill.text : VIDEO_RULES;
  const rules = `${base}${refs.length ? CONTINUITY : ''}${refs.length && !skill.text ? VIDEO_CONTINUITY : ''}${skill.text ? `\n\n${H3_DELIVERY}` : ''}`;
  return { rules, skillMode: skill.text ? skill.mode : undefined };
}

/**
 * 拼 user 文本：规则 + 语境。抽出来是为了能离线验——这层写错，模型就会「改版」而不是精修。
 * 精修（给了 current 又没点名 rewrite）走契约模式：既有词是定稿，只许规范化，改动逐条报。
 */
export function promptUserText(req: OptimizeRequest, refs: RefImage[] = [], skillMode?: H3Mode): string {
  const target: PromptTarget = req.target === 'video' ? 'video' : 'image';
  const count = Math.min(Math.max(req.count ?? 3, 1), 6);
  const existing = req.current?.trim();
  const refining = !!existing && req.mode !== 'rewrite';
  const idea = req.idea?.trim() ?? '';
  const lines: string[] = [];

  // 技能有自己的输入模板（BRIEF / MODE / KEYFRAMES / TARGET），照它的来，模型才在同一个语境里
  if (skillMode) {
    // 精修时既有词就是 BRIEF 本体：技能的 Step 2 拿它当素材，创作权限由下面的契约收走
    const brief = refining ? existing! : idea || existing || '';
    lines.push(`MODE: ${skillMode}`);
    lines.push(
      `BRIEF${refining ? '（既有提示词，精修对象：设定全部保留，按下面的精修契约规范化）' : ''}:\n${brief || '（空，靠下面给的方向自己发挥）'}`,
    );
    lines.push(
      `KEYFRAMES:\n${refs.length ? refs.map((r) => `${r.role}: ${r.label}`).join('\n') : '（没有附帧图，这次是纯文本出片）'}`,
    );
    lines.push(
      `TARGET:\nduration_s: ${req.seconds ?? DEFAULT_SETTINGS.videoSeconds}\nratio: ${req.ratio ?? frameRatio(DEFAULT_SETTINGS.frameSize)}${req.seconds === undefined ? '   # 节点没给时长，按项目默认时长规划镜头' : ''}`,
    );
  }
  if (req.nodeTitle) lines.push(`这段词属于节点「${req.nodeTitle}」（${target === 'video' ? '出片' : '生图'}）。`);
  if (refining) {
    // 技能模式下既有词已经在 BRIEF 里给过，别重复喂一遍
    if (!skillMode) lines.push(`# 既有提示词（精修对象，逐字对照）\n${existing}`);
    if (idea && idea !== existing) lines.push(`这一镜要讲什么（只作语境，不是改写指令）：${idea}`);
    lines.push(REFINE_CONTRACT);
  } else {
    if (!skillMode) lines.push(idea ? `原始想法：${idea}` : '原始想法：（空，靠下面给的方向自己发挥）');
    if (existing) lines.push(`既有版本（这次允许重写，设定可以推翻）：\n${existing}`);
  }
  if (req.style) lines.push(`风格倾向：${req.style}`);
  if (req.refine) lines.push(`改进要求：${req.refine}`);
  if (req.context) lines.push(`语境补充：${req.context}`);
  // 参考图是带角色的：模型得知道哪张是首帧、哪张是上一镜结尾，否则它会把两张当成两张无关的图
  if (refs.length) {
    lines.push(`参考画面 ${refs.length} 张，按下面顺序附在消息里：`);
    refs.forEach((r, i) => lines.push(`  第 ${i + 1} 张 = ${r.label}`));
  } else {
    lines.push('参考画面：没有（项目里还没有可用产物）。没有参考就不要编「跟上一镜一致」这种话。');
  }
  if (req.story) lines.push(`剧情线（按镜头顺序，已出过的画面写的是它的实际提示词）：\n${req.story}`);
  lines.push(`出 ${count} 条候选。`);

  const negative = target === 'image' ? '负面词，英文逗号分隔' : '留空';
  const tail = `"negative":"${negative}","tips":"给人看的中文建议，一句话，说清用哪条、跑之前注意什么"}`;
  const schema = refining
    ? `{"candidates":[{"text":"英文提示词","note":"这条的取舍，中文一句话","changes":["相对既有词改动的第 1 处，中文一句话，一处一条；一处没改就空数组"]}],${tail}`
    : `{"candidates":[{"text":"英文提示词","note":"这条的取舍，中文一句话"}],${tail}`;

  return `${promptRules(target, refs).rules}\n\n${lines.join('\n')}\n\n只输出 JSON，不要任何解释文字：\n${schema}`;
}

/**
 * 一次调用出多候选。模型只输出 JSON，解析交给 llm.chatJson 兜底。
 */
export async function optimizePrompt(req: OptimizeRequest): Promise<OptimizeResult> {
  const target: PromptTarget = req.target === 'video' ? 'video' : 'image';
  const refs = req.refs ?? [];
  const { skillMode } = promptRules(target, refs);
  const existing = req.current?.trim();
  const refining = !!existing && req.mode !== 'rewrite';

  const role = skillMode
    ? '你是 MiniMax H3 的提示词预处理器：严格照技能规范输出结构化多镜头提示词，参考画面就是这部片子已拍的素材，连续性比单张好看更重要。外层仍按 takeboard 的 JSON 格式交付。'
    : '你是影视级的提示词工程师，输出干净、可直接投喂模型。参考画面就是这部片子已拍的素材，连续性比单张好看更重要。';
  const refineClause = refining
    ? ' 这次是精修既有提示词：它是定稿，设定一条都不许动，你只做规范化与补足，每一处改动都要报进 changes。'
    : '';

  const out = await chatJson<OptimizeResult>(
    [
      { role: 'system', content: `${role}${refineClause}` },
      userWithImages(promptUserText({ ...req, target }, refs, skillMode), refs.map((r) => r.dataUrl)),
    ],
    // 精修要的是忠实，不是灵感：温度压低
    {
      temperature: refining ? 0.4 : 0.9,
      // H3 正文加多候选本来就长，而推理 token 也算进 max_tokens：额度给足，别让正文被推理挤空
      maxTokens: longFormTokens(),
    },
  );

  const candidates = (out.candidates ?? [])
    .map((c) => ({
      text: String(c?.text ?? '').trim(),
      note: c?.note ? String(c.note) : undefined,
      changes: Array.isArray(c?.changes) ? c.changes.map((x) => String(x).trim()).filter(Boolean) : undefined,
    }))
    .filter((c) => c.text);
  if (!candidates.length) throw new Error(`优化器没给出候选：${JSON.stringify(out).slice(0, 300)}`);

  return {
    candidates,
    mode: refining ? 'refine' : 'rewrite',
    negative: out.negative?.trim() || undefined,
    tips: out.tips?.trim() || undefined,
    refs: refs.length ? refs.map((r) => r.label) : undefined,
  };
}
