import fs from 'node:fs';
import path from 'node:path';

/**
 * H3 提示词技能装配器。
 *
 * 技能本体在 skills/h3-video-prompt-enhancer（SKILL.md + references/*.md），
 * 这里只管「取哪几层」：常驻方法论骨架 + 当前 mode 的格式规范，质量标杆那层不默认装。
 * 规则只有技能文件这一份真相源——技能改了这边自动跟上，别往这儿抄条文。
 */

export type H3Mode = 'ref2va' | 't2va' | 'i2va' | 'fl2va' | 'l2va';

const DEFAULT_DIR = 'D:\\AI\\dabai\\skills\\h3-video-prompt-enhancer';

/** L1 骨架：方法论与硬约束，任何 mode 都装。 */
const SKELETON_SECTIONS = [
  'Step 0: Classify the Mode',
  'Step 1: Gather Parameters',
  'Step 2: Creative Enhancement',
  'Step 3: Format and Output',
];

/** L2 格式规范：一个 mode 只装一层。 */
const FORMAT_LAYER: Record<H3Mode, string> = {
  ref2va: 'references/ref2va-format.md',
  t2va: 'references/base-multishot-format.md',
  i2va: 'references/base-multishot-format.md',
  fl2va: 'references/base-multishot-format.md',
  l2va: 'references/base-multishot-format.md',
};

/** 合法 mode 一览：有哪几个格式层，就有哪几个 mode。 */
export const H3_MODES = Object.keys(FORMAT_LAYER) as H3Mode[];

/** L3 按需层：不默认装，要质量标杆时自己取。 */
export const OPTIONAL_LAYERS = ['references/creative-showcase.md'];

export interface H3SkillPack {
  mode: H3Mode;
  /** 拼好的规则正文：骨架 + 该 mode 的格式规范 */
  text: string;
  /** 这次真读了哪几个文件 */
  files: string[];
  /** 技能不在磁盘上时的原因；调用方据此回退到内置规则 */
  missing?: string;
}

export function skillDir(): string {
  return process.env.H3_SKILL_DIR || DEFAULT_DIR;
}

function readSkill(rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(skillDir(), rel), 'utf8');
  } catch {
    return undefined;
  }
}

/** 取一个二级标题下的整段（含它的三级子节），到下一个二级标题为止。 */
function section(md: string, heading: string): string {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## (?!#)/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

/**
 * 判 mode。takeboard 里最权威的信号是参考画面的角色：
 * 首帧在 → i2va（出片节点的上游图就是首帧）；没有首帧但有用户点名的参考 → ref2va；都没有 → t2va。
 */
export function classifyMode(roles: string[]): H3Mode {
  if (roles.some((r) => r.includes('首帧'))) return 'i2va';
  if (roles.some((r) => r.includes('用户指定'))) return 'ref2va';
  return 't2va';
}

/** 装配：骨架 + 该 mode 的格式层。 */
export function loadH3Skill(mode: H3Mode): H3SkillPack {
  const dir = skillDir();
  const md = readSkill('SKILL.md');
  if (!md) {
    return { mode, text: '', files: [], missing: `技能目录里没有 SKILL.md：${dir}（可用 H3_SKILL_DIR 指到别处）` };
  }
  const files = ['SKILL.md'];
  const parts = SKELETON_SECTIONS.map((h) => section(md, h)).filter(Boolean);
  if (!parts.length) {
    return { mode, text: '', files, missing: `SKILL.md 里没找到 Step 0~3 段落：${path.join(dir, 'SKILL.md')}` };
  }

  const rel = FORMAT_LAYER[mode];
  const fmt = readSkill(rel);
  if (fmt) files.push(rel);

  const text = [
    '# MiniMax H3 提示词规范（技能本体，按 mode 装配）',
    '',
    parts.join('\n\n'),
    fmt ? `# 本次 mode=${mode} 的格式规范\n\n${fmt.trim()}` : `（注意：格式规范 ${rel} 读不到，严格按上面的 Critical Format Rules 输出）`,
  ].join('\n');
  return { mode, text, files };
}

/** 技能装了哪几层、各多大——看清渐进层级用。bytes=-1 表示这一层读不到。 */
export function h3Layers(): { file: string; bytes: number }[] {
  const out: { file: string; bytes: number }[] = [];
  for (const rel of ['SKILL.md', ...Object.values(FORMAT_LAYER), ...OPTIONAL_LAYERS]) {
    if (out.some((o) => o.file === rel)) continue;
    const md = readSkill(rel);
    out.push({ file: rel, bytes: md ? Buffer.byteLength(md, 'utf8') : -1 });
  }
  return out;
}

/** 按需取一层原文。 */
export function readH3Layer(rel: string): string {
  const md = readSkill(rel);
  if (md === undefined) throw new Error(`没有这一层：${rel}（技能目录 ${skillDir()}，可用的看 h3_layers）`);
  return md;
}
