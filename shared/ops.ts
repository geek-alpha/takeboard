import type { MediaKind } from './types.ts';

export type OpId =
  | 'concat'
  | 'xfade'
  | 'trim'
  | 'poster'
  | 'firstframe'
  | 'lastframe'
  | 'extractaudio'
  | 'muxaudio'
  | 'mixaudio'
  | 'subtitle';

export interface OpParamDef {
  key: string;
  label: string;
  type: 'number' | 'text' | 'textarea' | 'bool' | 'select' | 'color';
  def?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  hint?: string;
}

export interface OpDef {
  id: OpId;
  name: string;
  hint: string;
  produces: MediaKind;
  /** 要吃哪些输入（视频/音频/文本），第一个视频输入永远当主片 */
  takes: Array<'video' | 'audio' | 'text'>;
  /** 允许几路输入：1=只吃一路，n=多路，'*'=不限 */
  inputs: 1 | number | '*';
  params: OpParamDef[];
}

const VIDEO_OUT: MediaKind = 'video';

/**
 * 算子清单 —— 前端下拉、参数面板、助手工具描述全从这一份来。
 * 加新算子只改这里 + server/jobs.ts 的 runOp 分支，两边靠 OpId 类型对齐。
 */
export const OPS: OpDef[] = [
  {
    id: 'concat',
    name: '拼接',
    hint: '按入边顺序首尾接成一条片子，自动统一分辨率与帧率',
    produces: VIDEO_OUT,
    takes: ['video'],
    inputs: '*',
    params: [
      { key: 'width', label: '宽（留空跟随第一段）', type: 'number', min: 64, max: 4096, step: 2 },
      { key: 'height', label: '高（留空跟随第一段）', type: 'number', min: 64, max: 4096, step: 2 },
      { key: 'fps', label: '帧率（留空跟随第一段）', type: 'number', min: 1, max: 120, step: 1 },
    ],
  },
  {
    id: 'xfade',
    name: '过渡拼接',
    hint: '按入边顺序接成一条片子，镜与镜之间做叠化/黑场/划像等过渡；比硬切有呼吸感',
    produces: VIDEO_OUT,
    takes: ['video'],
    inputs: '*',
    params: [
      {
        key: 'transition',
        label: '过渡效果',
        type: 'select',
        def: 'fade',
        options: [
          'fade',
          'dissolve',
          'fadeblack',
          'fadewhite',
          'wipeleft',
          'wiperight',
          'wipeup',
          'wipedown',
          'slideleft',
          'slideright',
          'circleopen',
          'circleclose',
          'pixelize',
          'zoomin',
          'smoothleft',
          'radial',
        ],
        hint: 'fade=叠化 · dissolve=溶解 · fadeblack=黑场 · fadewhite=白场 · wipe*=划像 · slide*=推移 · circle*=圆开圆合 · pixelize=像素化 · zoomin=推近 · smoothleft=平滑推移 · radial=径向',
      },
      {
        key: 'duration',
        label: '每处过渡时长 s',
        type: 'number',
        def: 0.5,
        min: 0.05,
        max: 5,
        step: 0.05,
        hint: '相邻两镜重叠的秒数；片子总时长 = 各镜之和 − 过渡时长 × 过渡处数',
      },
      { key: 'width', label: '宽（留空跟随第一段）', type: 'number', min: 64, max: 4096, step: 2 },
      { key: 'height', label: '高（留空跟随第一段）', type: 'number', min: 64, max: 4096, step: 2 },
      { key: 'fps', label: '帧率（留空跟随第一段）', type: 'number', min: 1, max: 120, step: 1 },
    ],
  },
  {
    id: 'trim',
    name: '截取',
    hint: '从某一秒起截一段',
    produces: VIDEO_OUT,
    takes: ['video'],
    inputs: 1,
    params: [
      { key: 'start', label: '起点 s', type: 'number', def: 0, min: 0, step: 0.1 },
      { key: 'duration', label: '时长 s', type: 'number', def: 3, min: 0.1, step: 0.1 },
    ],
  },
  {
    id: 'poster',
    name: '抽帧（海报）',
    hint: '抽某一时刻一帧当封面',
    produces: 'image',
    takes: ['video'],
    inputs: 1,
    params: [{ key: 'at', label: '时刻 s', type: 'number', def: 0.2, min: 0, step: 0.1 }],
  },
  {
    id: 'firstframe',
    name: '首帧',
    hint: '抽第一帧存成图，直接当下一镜的首帧喂给出片',
    produces: 'image',
    takes: ['video'],
    inputs: 1,
    params: [{ key: 'at', label: '时刻 s', type: 'number', def: 0, min: 0, step: 0.05 }],
  },
  {
    id: 'lastframe',
    name: '尾帧',
    hint: '抽最后一帧存成图 —— 接戏的快捷动作：这镜结尾长什么样，下一镜就从它开',
    produces: 'image',
    takes: ['video'],
    inputs: 1,
    params: [],
  },
  {
    id: 'extractaudio',
    name: '抽音轨',
    hint: '把片子的声音单独抽出来当素材（BGM、旁白、环境音）',
    produces: 'audio',
    takes: ['video'],
    inputs: 1,
    params: [{ key: 'bitrate', label: '码率', type: 'select', def: '192k', options: ['128k', '192k', '256k', '320k'] }],
  },
  {
    id: 'muxaudio',
    name: '配音 / 加 BGM',
    hint: '第一路视频是画面，其余入边当声音混进去；原声可留可弃',
    produces: VIDEO_OUT,
    takes: ['video', 'audio'],
    inputs: '*',
    params: [
      { key: 'keepOriginal', label: '保留片子原声', type: 'bool', def: true },
      { key: 'originalVolume', label: '原声音量', type: 'number', def: 1, min: 0, max: 4, step: 0.05 },
      { key: 'volume', label: '配上去的音量', type: 'number', def: 0.3, min: 0, max: 4, step: 0.05 },
      { key: 'start', label: '声音第几秒进', type: 'number', def: 0, min: 0, step: 0.1 },
      { key: 'loop', label: '声音短了就循环铺满', type: 'bool', def: true },
    ],
  },
  {
    id: 'mixaudio',
    name: '混音',
    hint: '只混声音：多路音轨（配音 + BGM）合成一条音频素材',
    produces: 'audio',
    takes: ['audio'],
    inputs: '*',
    params: [
      { key: 'volume', label: '各路音量', type: 'number', def: 1, min: 0, max: 4, step: 0.05 },
      { key: 'start', label: '第几秒进', type: 'number', def: 0, min: 0, step: 0.1 },
      { key: 'loop', label: '短了就循环铺满', type: 'bool', def: false },
      { key: 'duration', label: '成品时长 s（留空跟随最长轨）', type: 'number', min: 0.1, step: 0.1 },
    ],
  },
  {
    id: 'subtitle',
    name: '字幕',
    hint: '把文本烧进画面（硬字幕），旁挂一份 srt 随时改样式重烧',
    produces: VIDEO_OUT,
    takes: ['video', 'text'],
    inputs: '*',
    params: [
      { key: 'text', label: '字幕文本（留空则用连进来的文本节点）', type: 'textarea', hint: '换行即分条；也可以留空吃文本节点' },
      { key: 'fontSize', label: '字号', type: 'number', def: 24, min: 8, max: 120, step: 1 },
      { key: 'alignment', label: '位置', type: 'select', def: '2', options: ['2', '1', '3', '5', '8'] },
      { key: 'marginV', label: '边距 px', type: 'number', def: 28, min: 0, max: 400, step: 1 },
      { key: 'outline', label: '描边', type: 'number', def: 2, min: 0, max: 10, step: 1 },
      { key: 'color', label: '颜色', type: 'color', def: '#FFFFFF' },
      { key: 'cps', label: '每秒几字（估时间轴）', type: 'number', def: 4.5, min: 0.5, max: 20, step: 0.5 },
    ],
  },
];

export const OP_IDS = OPS.map((o) => o.id);

export function opDef(id: string): OpDef | undefined {
  return OPS.find((o) => o.id === id);
}

/** 一行摘要：常驻助手工具描述用。整份清单每轮都进上下文是纯浪费，详情按需查 opHelp。 */
export function opsBrief(): string {
  return OPS.map((o) => `${o.id}(${o.name})`).join('、');
}

/** 一行话说清算子能干什么，给 API 自描述用。 */
export function opsHelp(): string {
  return OPS.map((o) => `${o.id}(${o.name})：${o.hint}`).join('；');
}

/** 单个算子的说明书：入边要求 + 全部参数。助手要动算子之前查它，别猜参数名。 */
export function opHelp(id: string): string {
  const o = opDef(id);
  if (!o) return `没有算子「${id}」。现有：${opsBrief()}`;
  const ins = o.inputs === '*' ? '不限' : `${o.inputs} 路`;
  const params = o.params.length
    ? o.params
        .map((p) => {
          const bits = [`${p.key}（${p.label}）${p.type}`];
          if (p.def !== undefined) bits.push(`默认 ${JSON.stringify(p.def)}`);
          if (p.min !== undefined || p.max !== undefined) bits.push(`范围 ${p.min ?? ''}~${p.max ?? ''}`);
          if (p.options) bits.push(`可选 ${p.options.join('/')}`);
          if (p.hint) bits.push(p.hint);
          return `  - ${bits.join(' · ')}`;
        })
        .join('\n')
    : '  （无参数）';
  return [
    `${o.id}（${o.name}）：${o.hint}`,
    `产物 ${o.produces} · 入边 ${o.takes.join(' + ')} · 允许 ${ins}`,
    `参数：\n${params}`,
  ].join('\n');
}
