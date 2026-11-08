/**
 * 正向提示词「分层拼接」的唯一口径。
 *
 * ## 为什么要分层
 *
 * 0.5.0 的最终 CLIP 文本原本由两处各自拼:
 *
 *   - `relay/prompt.ts` 的 `composePositive(style, core)` —— 恒定画风词 + 模型编译出的画面 tag;
 *   - `generate.ts` 里 `appendCharacterPrompts(prompt, archive.text)` —— 把角色档案追加在末尾。
 *
 * 两条拼接各自都对,但**没人能一眼看到最后那一串长什么样**。用户真正想调的是
 * 「哪一段排在哪」:质量词必须抢最前(采样器只吃前 75 token),角色外貌要压住剧情里的
 * 临时状态,而剧情 tag 是每次都换的那一段。三层各管一段语义,拼接顺序一旦固定下来,
 * 就应该有一个地方**同时**能算、能看、能复制——那就是本模块。
 *
 * ## 层与顺序
 *
 * | 层 | 内容 | 来源 |
 * |---|---|---|
 * | `fixed` | 固定正面:画质词、画风词、LoRA 触发词 | 渠道页「固定正面」/ 提示词页「恒定画风词」 |
 * | `character` | 角色层:常驻档案 + 临时状态 + 本张的多角色 tag | `autoTag/characterPrompts`、`<characters>` |
 * | `story` | 剧情层:模型按本楼正文编译出的画面 tag(或自然语言) | `<tag>` / `<nl>` |
 *
 * 顺序即 `LAYER_ORDER`:fixed → character → story。
 * 这与 0.5.0 原本「恒定词前置、角色档案压末尾」的结论一致——CLIP 对越靠前的 token 越敏感,
 * 所以画风词必须在最前;而剧情 tag 里已经写了这一楼发生了什么,角色档案跟在它后面
 * 才有「补充这个人具体长这样」的效果,同时仍压得住临时状态。
 *
 * ## 反面也有层
 *
 * 阴性段不是简单地「固定 + 追加」:`buildNegativeLayers` 把负面拆成
 * 「固定负面(用户定的基线)」与「本图排除(AI 按画面写的)」两段,默认高优先保前者。
 * 详见下文负面段那一大块注释。
 *
 * ## 本模块是纯函数
 *
 * 不 import settings、不碰宿主。理由:它要同时被后端组装(comfyui/comfyTemplates)、
 * 出图中段(generate.ts)、以及三个 UI 预览点引用。带上 settings 就会把整条依赖
 * 拖进单测与公开接口。
 */

/** 三个层的 id。顺序即默认拼接顺序,见 LAYER_ORDER。 */
export type PromptLayerId = 'fixed' | 'character' | 'story';

/** 默认拼接顺序,也是 UI 上「插入位次」的编号来源。用户可在提示词设置里改。 */
export const LAYER_ORDER: readonly PromptLayerId[] = ['fixed', 'character', 'story'] as const;

/** 每层的显示名(UI 与图注共用一份,别处不要再写死字符串)。 */
export const LAYER_LABELS: Record<PromptLayerId, string> = {
  fixed: '固定正面',
  character: '角色',
  story: '剧情',
};

/** 每层「管什么」的一句话说明(预览里鼠标悬浮可见)。 */
export const LAYER_HINTS: Record<PromptLayerId, string> = {
  fixed: '画质词 / 画风词 / LoRA 触发词。排最前:CLIP 对越靠前的 token 越敏感,不少工作流只吃前 75 个。',
  character: '角色的固定外貌档案与本楼临时状态。排在剧情之后,才能压住剧情里临时换掉的穿着。',
  story: '模型按本楼正文编译出的画面 tag(开启自然语言时用自然语言)。每张图都会变的那一段。',
};

/** 一次拼接的输入。所有字段都可空,空层不会在成品里留下多余分隔符。 */
export interface PromptLayerSource {
  /** 固定正面。 */
  fixed?: string;
  /**
   * 角色层。两种给法,可同时给(先 characters 再 characterTag):
   * - `characters`:结构化多角色(NAI 4.5/V5 与手动编辑弹窗里的那份);
   * - `characterTag`:已合成好的一串(角色档案的常驻 + 临时),由
   *   `autoTag/characterPrompts.composeCharacterPrompts` 产出。
   */
  characters?: Array<{ name?: string; tag?: string; nl?: string }>;
  characterTag?: string;
  /** 剧情层:画面 tag。 */
  story?: string;
  /** 剧情层的自然语言版本;`preferNaturalLanguage` 为真且非空时替掉 story。 */
  storyNl?: string;
}

export interface PromptLayerOptions {
  /** 层间连接符,默认 `', '`。 */
  separator?: string;
  /** 是否跨层去重(按 `tagKey` 归一后比),默认 true。 */
  dedupe?: boolean;
  /** tag 数上限;0 = 不限。超了从**末层末尾**开始砍(保固定正面与角色核心)。 */
  budget?: number;
  /** 剧情层是否优先用自然语言(Flux/Anima 吃自然语言)。 */
  preferNaturalLanguage?: boolean;
  /**
   * 拼接顺序。默认 `LAYER_ORDER`(固定正面 → 角色 → 剧情)。
   *
   * 用户可以把层拖到别处,但**固定正面在最前**是软约束:CLIP 对越靠前的 token
   * 越敏感,把画风基线排到末尾等于主动把它送进垃圾桶。UI 拦一下(`pinFixedFirst`),
   * 坚持要这么排的也放行——用户可能就是想用剧情词压过画风词。
   *
   * 非法 id 会被丢掉,缺失的层按默认顺序补在末尾,所以传进来的数组不用自己清洗。
   */
  order?: readonly PromptLayerId[];
}

/**
 * 清洗顺序数组:白名单过滤 + 去重 + 用默认顺序补齐缺失层(补在末尾)。
 *
 * 为什么补齐而不是丢掉:少传一个 `story` 就会让 AI 编译出的画面词凭空消失,
 * 那是很难查的静默失败;补在末尾至少「看得见」。
 */
export function normalizeLayerOrder(raw: unknown): PromptLayerId[] {
  const out: PromptLayerId[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const id = String(item ?? '').trim() as PromptLayerId;
      if (LAYER_ORDER.includes(id) && !out.includes(id)) out.push(id);
    }
  }
  for (const id of LAYER_ORDER) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 检查固定正面是否排在最前。不满足时给出「挪回最前」的顺序,
 * 由调用方决定是提示还是直接纠正。
 */
export function pinFixedFirst(order: readonly PromptLayerId[]): {
  order: PromptLayerId[];
  corrected: boolean;
} {
  const clean = normalizeLayerOrder(order);
  if (clean[0] === 'fixed') return { order: clean, corrected: false };
  const rest = clean.filter(id => id !== 'fixed');
  return { order: ['fixed', ...rest], corrected: true };
}


export interface PromptLayer {
  id: PromptLayerId;
  label: string;
  /** 本层最终进成品的文本(已去重、可能已被预算截断)。 */
  text: string;
  /** 本层 tag 数。 */
  tagCount: number;
  /** 本层字符数。 */
  chars: number;
  /** 被预算砍掉了一部分。 */
  truncated: boolean;
  /** 给用户看的一句话状态(被砍 / 被整层去重 / 未启用)。 */
  note?: string;
}

export interface PromptLayersResult {
  /** 各层,恒为 3 条且按本次实际使用的顺序排;空层的 text 为空串。 */
  layers: PromptLayer[];
  /** 拼好的成品串。 */
  text: string;
  chars: number;
  tagCount: number;
  /** 跨层去重一共删掉几个 tag。 */
  droppedDuplicates: number;
  /** 因预算被砍掉的 tag 数。 */
  droppedByBudget: number;
  /** 同层内重复出现的角色名(只保留第一份)。 */
  duplicateCharacters: string[];
  /** 本次实际使用的拼接顺序(已清洗)。UI 的拖动回显读它。 */
  order: PromptLayerId[];
}

const DEFAULT_SEPARATOR = ', ';

/**
 * tag 归一化键:用于跨层去重。
 *
 * 顺序不能反 —— 必须先砍权重后缀再脱括号,否则 `(Silver_Hair):1.2` 会先脱括号变成
 * `silver_hair:1.2` 再砍后缀,留下一个孤零零的右括号 `silver hair)`。
 */
export function tagKey(tag: string): string {
  return String(tag ?? '')
    .toLowerCase()
    .replace(/:\s*-?[\d.]+$/, '')
    .replace(/\\/g, '')
    .replace(/[()[\]{}]/g, '')
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

/**
 * 切 tag。分隔符是逗号(全半角)、顿号、换行;括号内的逗号不切
 * (`(a, b):1.1` 是一个权重组,拆开就成了两个残 tag)。
 */
export function splitTags(text: string): string[] {
  const src = String(text ?? '');
  const out: string[] = [];
  let depth = 0;
  let buffer = '';
  const flush = () => {
    const tag = buffer.trim();
    if (tag) out.push(tag);
    buffer = '';
  };
  for (const ch of src) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || ch === '，' || ch === '、' || ch === '\n' || ch === '\r')) {
      flush();
      continue;
    }
    buffer += ch;
  }
  flush();
  return out;
}

/** 把若干串按 tag 合并成一个数组(去空、可去重、保顺序)。 */
function collectTags(parts: Array<string | undefined>, dedupe: boolean): { tags: string[]; dropped: number } {
  const seen = new Set<string>();
  const tags: string[] = [];
  let dropped = 0;
  for (const part of parts) {
    for (const tag of splitTags(part ?? '')) {
      if (dedupe) {
        const key = tagKey(tag);
        if (key && seen.has(key)) {
          dropped += 1;
          continue;
        }
        if (key) seen.add(key);
      }
      tags.push(tag);
    }
  }
  return { tags, dropped };
}

/** 角色层文本:结构化角色优先,再拼已合成的档案串。 */
function characterParts(source: PromptLayerSource): string[] {
  const parts: string[] = [];
  const seenNames = new Set<string>();
  for (const character of source.characters ?? []) {
    const name = String(character?.name ?? '').trim();
    if (name) {
      if (seenNames.has(name)) continue;
      seenNames.add(name);
    }
    const tag = String(character?.tag ?? '').trim();
    const nl = String(character?.nl ?? '').trim();
    if (tag) parts.push(tag);
    else if (nl) parts.push(nl);
  }
  const archive = String(source.characterTag ?? '').trim();
  if (archive) parts.push(archive);
  return parts;
}

/** 同层内重复的角色名(只保留第一份,其余记下来给 UI 提示)。 */
function duplicateCharacterNames(source: PromptLayerSource): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const character of source.characters ?? []) {
    const name = String(character?.name ?? '').trim();
    if (!name) continue;
    if (seen.has(name)) {
      if (!dup.includes(name)) dup.push(name);
      continue;
    }
    seen.add(name);
  }
  return dup;
}

/**
 * 三层一起算。**这是全链路唯一的拼接实现** —— 后端组装、出图中段与 UI 预览
 * 都调用它,谁也别自己再写一遍 join,否则四面就会漂。
 */
export function buildPromptLayers(
  source: PromptLayerSource,
  options: PromptLayerOptions = {},
): PromptLayersResult {
  const separator = options.separator ?? DEFAULT_SEPARATOR;
  const dedupe = options.dedupe !== false;
  const budget = Math.max(0, Math.floor(Number(options.budget) || 0));
  const nlFirst = options.preferNaturalLanguage === true;
  // 顺序可被用户改;清洗后一定是一个含全部三层的合法排列
  const order = normalizeLayerOrder(options.order);

  const storyText = nlFirst
    ? String(source.storyNl ?? '').trim() || String(source.story ?? '').trim()
    : String(source.story ?? '').trim();

  const rawParts: Record<PromptLayerId, string[]> = {
    fixed: [String(source.fixed ?? '')],
    character: characterParts(source),
    story: [storyText],
  };

  // 跨层去重:后出现的层让位给先出现的层。注意「先出现」现在按 order 算,
  // 把剧情层拖到最前,剧情词就会反过来压住固定正面里的同名词。
  const seen = new Set<string>();
  const kept: Record<PromptLayerId, string[]> = { fixed: [], character: [], story: [] };
  let droppedDuplicates = 0;
  for (const id of order) {
    for (const part of rawParts[id]) {
      for (const tag of splitTags(part)) {
        if (dedupe) {
          const key = tagKey(tag);
          if (key && seen.has(key)) {
            droppedDuplicates += 1;
            continue;
          }
          if (key) seen.add(key);
        }
        kept[id].push(tag);
      }
    }
  }

  // 预算:从末层末尾开始砍
  let droppedByBudget = 0;
  if (budget > 0) {
    const total = order.reduce((sum, id) => sum + kept[id].length, 0);
    let excess = total - budget;
    for (let i = order.length - 1; i >= 0 && excess > 0; i -= 1) {
      const list = kept[order[i]];
      while (excess > 0 && list.length > 0) {
        list.pop();
        excess -= 1;
        droppedByBudget += 1;
      }
    }
  }

  const layers: PromptLayer[] = order.map(id => {
    const tags = kept[id];
    const text = tags.join(separator);
    const rawCount = rawParts[id].reduce((sum, part) => sum + splitTags(part).length, 0);
    const truncated = tags.length < rawCount && droppedByBudget > 0 && tags.length > 0;
    const notes: string[] = [];
    if (truncated && tags.length < rawCount) notes.push(`超出 tag 预算,砍掉 ${rawCount - tags.length} 个`);
    if (rawCount > 0 && tags.length === 0) notes.push('全部被前层的重复项吸收');
    return {
      id,
      label: LAYER_LABELS[id],
      text,
      tagCount: tags.length,
      chars: text.length,
      truncated: truncated && tags.length < rawCount,
      note: notes.length ? notes.join('；') : undefined,
    };
  });

  const text = layers
    .map(layer => layer.text)
    .filter(Boolean)
    .join(separator);

  return {
    layers,
    text,
    chars: text.length,
    tagCount: layers.reduce((sum, layer) => sum + layer.tagCount, 0),
    droppedDuplicates,
    droppedByBudget,
    duplicateCharacters: duplicateCharacterNames(source),
    order,
  };
}

/** 只要成品串(后端组装用这个,不关心分层明细)。 */
export function composeLayeredPrompt(
  source: PromptLayerSource,
  options: PromptLayerOptions = {},
): string {
  return buildPromptLayers(source, options).text;
}

/* ==================================================================
 * 负面提示词
 * ==================================================================
 *
 * 负面层为什么不能直接复用 PromptLayerSource:正负两边的「层」不只是 id 不同,
 * 连语义都不对称。
 *
 * | | 正向 | 负面 |
 * |---|---|---|
 * | 固定层 | 质量词、画风词 —— 越多越好 | 通用负面词(低质/畸形) —— 定海神针,必须存活 |
 * | 动态层 | 剧情/角色 —— 每张都换 | 本画面专用排除词 —— 可能有,可能空 |
 * | 顺序 | 可拖动,决定谁占 CLIP 前 75 token | **不可拖**:负面两段谁先谁后对采样无差别 |
 *
 * 所以这里刻意不引入第四个 PromptLayerId,而是给负面一套独立的双段模型:
 * `builtin`(渠道页固定负面)+ `dynamic`(AI 按本画面编译)。两段的差别必须
 * 在预览里看得见 —— 用户真正会踩的坑是「固定负面被 AI 的动态词挤掉了」,
 * 而这个在合并成一串之后就再也查不出来。
 *
 * 为什么负面也有预算:CLIP 对负面的解析同样是 75 token 一段,某些采样器
 * (尤其 CFG 高的 SDXL 工作流)在负面超长时会把末尾权重摊薄。但默认 0(不限),
 * 因为砍负面比砍正向更危险:砍掉 anatomy 词直接换来六根手指。
 */

/** 负面提示词的层 id。与正向的 PromptLayerId 是两个命名空间,故意不重合。 */
export type NegativeLayerId = 'builtin' | 'dynamic';

/** 默认顺序。负面**不可拖动**,这个常量只用于遍历与显示编号。 */
export const NEGATIVE_LAYER_ORDER: readonly NegativeLayerId[] = ['builtin', 'dynamic'] as const;

/** 每层显示名。 */
export const NEGATIVE_LAYER_LABELS: Record<NegativeLayerId, string> = {
  builtin: '固定负面',
  dynamic: '本图排除',
};

/** 每层「管什么」的一句话说明。 */
export const NEGATIVE_LAYER_HINTS: Record<NegativeLayerId, string> = {
  builtin: '渠道页填的通用负面词(低质、畸形、水印等)。永远发在最前,不被动态词挤掉。',
  dynamic: 'AI 按本画面正文编译出的排除词,只排除与正文冲突或本构图容易误生成的东西。可为空。',
};

/** 一次负面拼接的输入。 */
export interface NegativeLayerSource {
  /** 固定负面(渠道页「固定负面」那一格)。 */
  builtin?: string;
  /** AI 动态负面(本画面专用,可空)。 */
  dynamic?: string;
}

export interface NegativeLayerOptions {
  /** 层间连接符,默认 `', '`。 */
  separator?: string;
  /** 是否跨段去重(按 `tagKey` 归一后比),默认 true。 */
  dedupe?: boolean;
  /** tag 数上限;0 = 不限。超了从**末段末尾**开始砍,即先砍动态词。 */
  budget?: number;
}

export interface NegativeLayer {
  id: NegativeLayerId;
  label: string;
  /** 本段最终进成品的文本。 */
  text: string;
  tagCount: number;
  chars: number;
  /** 被预算砍掉了一部分。 */
  truncated: boolean;
  note?: string;
}

export interface NegativeLayersResult {
  /** 恒为 2 条,顺序固定 固定负面 → 本图排除。 */
  layers: NegativeLayer[];
  /** 拼好的成品串。 */
  text: string;
  chars: number;
  tagCount: number;
  /** 动态段里与固定段重复而被吸收的 tag 数。 */
  droppedDuplicates: number;
  /** 因预算被砍掉的 tag 数。 */
  droppedByBudget: number;
  /** 负面不可拖顺序,这里恒等于 NEGATIVE_LAYER_ORDER;回传是为了与 PromptLayersResult 同形。 */
  order: NegativeLayerId[];
}

/**
 * 负面两段一起算。**全链路唯一的负面拼接实现**,与正向的 buildPromptLayers 对称:
 * 后端组装(composeNegative)、UI 预览、随图记录都调它。
 *
 * 默认 dedupe=true 的理由:AI 偶尔会把固定负面里的 lowres 又写一遍,重复不改变采样结果
 * 但会白白吃掉预算额度。budget 只砍动态段 —— 固定负面是用户自己定的基线,不该被系统动。
 */
export function buildNegativeLayers(
  source: NegativeLayerSource,
  options: NegativeLayerOptions = {},
): NegativeLayersResult {
  const separator = options.separator ?? DEFAULT_SEPARATOR;
  const dedupe = options.dedupe !== false;
  const budget = Math.max(0, Math.floor(Number(options.budget) || 0));
  const order = [...NEGATIVE_LAYER_ORDER];

  const rawParts: Record<NegativeLayerId, string[]> = {
    builtin: [String(source.builtin ?? '')],
    dynamic: [String(source.dynamic ?? '')],
  };

  const seen = new Set<string>();
  const kept: Record<NegativeLayerId, string[]> = { builtin: [], dynamic: [] };
  let droppedDuplicates = 0;
  for (const id of order) {
    for (const part of rawParts[id]) {
      for (const tag of splitTags(part)) {
        if (dedupe) {
          const key = tagKey(tag);
          if (key && seen.has(key)) {
            droppedDuplicates += 1;
            continue;
          }
          if (key) seen.add(key);
        }
        kept[id].push(tag);
      }
    }
  }

  // 预算只砍动态段末尾;动态段砍空了仍不够就停手,不碰固定负面。
  let droppedByBudget = 0;
  if (budget > 0) {
    const total = kept.builtin.length + kept.dynamic.length;
    let excess = total - budget;
    while (excess > 0 && kept.dynamic.length > 0) {
      kept.dynamic.pop();
      excess -= 1;
      droppedByBudget += 1;
    }
  }

  const layers: NegativeLayer[] = order.map(id => {
    const tags = kept[id];
    const text = tags.join(separator);
    const rawCount = rawParts[id].reduce((sum, part) => sum + splitTags(part).length, 0);
    const truncated = droppedByBudget > 0 && tags.length < rawCount;
    const notes: string[] = [];
    if (truncated) notes.push(`超出 tag 预算,砍掉 ${rawCount - tags.length} 个`);
    if (rawCount > 0 && tags.length === 0) notes.push('全部被固定负面的重复项吸收');
    return {
      id,
      label: NEGATIVE_LAYER_LABELS[id],
      text,
      tagCount: tags.length,
      chars: text.length,
      truncated,
      note: notes.length ? notes.join('；') : undefined,
    };
  });

  const text = layers
    .map(layer => layer.text)
    .filter(Boolean)
    .join(separator);

  return {
    layers,
    text,
    chars: text.length,
    tagCount: layers.reduce((sum, layer) => sum + layer.tagCount, 0),
    droppedDuplicates,
    droppedByBudget,
    order,
  };
}

/** 只要负面成品串(后端组装用这个)。 */
export function composeNegativeLayers(
  source: NegativeLayerSource,
  options: NegativeLayerOptions = {},
): string {
  return buildNegativeLayers(source, options).text;
}

/**
 * 把一串已拼好的 tag 文本拆回三层之外的原样返回(给「不分层」的旧口径用)。
 * 只是为了让调用方的分支少一个 if,不做任何归一。
 */
export function legacyJoin(...parts: Array<string | undefined>): string {
  return parts.map(part => (part ?? '').trim()).filter(Boolean).join(DEFAULT_SEPARATOR);
}

export { DEFAULT_SEPARATOR, collectTags };
