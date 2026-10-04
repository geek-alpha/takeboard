import { H3_MODES, h3Layers, loadH3Skill, readH3Layer, skillDir, type H3Mode } from './h3-skill.ts';

/**
 * 技能注册表：所有技能规范一律「常驻只留一行索引 + 正文按需查」，别往 system 里抄条文。
 *
 * 新增技能只在这儿加一条：助手的常驻提示与按需工具都不用改——
 * 索引行自动进 SYSTEM，层与原文走 skill 工具取。
 */

export interface SkillLayer {
  file: string;
  bytes: number;
}

export interface SkillDef {
  id: string;
  title: string;
  /** 什么时候该查它——就是进常驻索引的那一行 */
  when: string;
  /** 装配入口：正文怎么进上下文（自动装配 / 手动取） */
  entry: string;
  /** 有 mode 概念时的默认值（助手不传也能看装配结果） */
  defaultMode?: string;
  dir?(): string;
  layers(): SkillLayer[];
  read(layer: string): string;
  /** 可选：按 mode 装配整段正文，给「一次要装一大段规则」的技能用 */
  pack?(mode: string): { text: string; files: string[]; missing?: string };
}

const h3: SkillDef = {
  id: 'h3',
  title: 'MiniMax H3 出片提示词规范',
  when: '写出片提示词、要查多镜头时间轴/声景字段/质量标杆时',
  entry: 'optimize_prompt 出片时按参考帧自动判 mode 装配',
  defaultMode: 'i2va',
  dir: skillDir,
  layers: h3Layers,
  read: readH3Layer,
  pack: (mode) => {
    if (!H3_MODES.includes(mode as H3Mode)) {
      throw new Error(`h3 没有 mode「${mode}」。可选：${H3_MODES.join(' / ')}`);
    }
    const p = loadH3Skill(mode as H3Mode);
    return { text: p.text, files: p.files, missing: p.missing };
  },
};

export const SKILLS: SkillDef[] = [h3];

export function findSkill(id: string): SkillDef {
  const def = SKILLS.find((s) => s.id === id);
  if (!def) throw new Error(`没有技能「${id}」。现有：${SKILLS.map((s) => s.id).join('、')}`);
  return def;
}

/** 常驻索引：每行一个技能，正文一律不进 system。 */
export function skillsBrief(): string {
  return SKILLS.map((s) => `- ${s.id} = ${s.title}（${s.when}；${s.entry}）`).join('\n');
}

/** 按需工具的回执：目录 + 层 + 该 mode 装了什么。 */
export function skillCatalog(id: string, mode?: string): string {
  const def = findSkill(id);
  const lines = [`技能 ${def.id}：${def.title}`];
  if (def.dir) lines.push(`目录：${def.dir()}`);
  lines.push('层：');
  for (const l of def.layers()) lines.push(`  ${l.file}${l.bytes < 0 ? '（读不到）' : ` · ${l.bytes} 字节`}`);
  const m = mode ?? def.defaultMode;
  if (def.pack && m) {
    const p = def.pack(m);
    lines.push(p.missing ? `✘ ${p.missing}` : `mode=${m} 装配：${p.files.join(' + ')}（共 ${p.text.length} 字）`);
  }
  lines.push('要读某层原文就给 layer 参数。');
  return lines.join('\n');
}
