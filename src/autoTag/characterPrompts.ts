import {
  CHAR_TAG_FIELDS,
  type CharTagEntry,
  type CharTagField,
} from '@/state/charTags';

/**
 * 角色档案提示词的「三段式」——本模块是它们的唯一口径。
 *
 * ## 为什么是三段
 *
 * 原本柏宝绘只有一层「角色固定外貌」:发色、瞳色、体型这类**几乎不变**的东西。
 * 它的问题在换装与受伤这类**随剧情变化**的状态上:
 *
 * 1. **永久污染** —— 这一楼她换上黑色蕾丝内衣,下一楼换回白裙,固定档案里
 *    还挂着 `black lace bra`;
 * 2. **互相打架** —— 固定 raw 写着 `white dress`,临时状态写着 `black lace bra`,
 *    两串都进 CLIP,采样器按 token 权重骑墙,衣服糊成一片;
 * 3. **不可回退** —— swipe / 回档之后,没人知道档案被哪一楼改过。
 *
 * 所以拆成三层,各管各的:
 *
 * | 层 | 管什么 | 谁来变 | 送进 CLIP 的位置 |
 * |---|---|---|---|
 * | **固定档案**(`CharTagEntry.fields`) | 发色/瞳色/体型/标志特征——「这个人长什么样」 | AI 建档与永久变化(染发、留疤、长大) | 角色档案段(模型已写进 tag 时由本体去重) |
 * | **常驻提示词**(`chars.basePrompt`) | 用户对该角色**这一整个聊天**的补充设定:口癖、随身物件、恒定气质 | **只有用户手改**,AI 永不触碰 | 正向提示词**末尾** |
 * | **临时提示词**(`chars.transient[key].prompt`) | 此刻穿戴、身体状态、伤痕/饰品/束缚——「这一刻她是什么样」 | AI 每楼可读可写,用户可冻结/清空 | 正向提示词**末尾**,同槽位覆盖常驻 |
 *
 * ## 为什么插在末尾而不是开头
 *
 * 恒定画风词已经在最前面(见 relay/prompt.ts 的 composePositive):CLIP 对越靠前的
 * token 越敏感,画风基线必须抢那个位置。角色档案放在「模型编译出的画面 tag」之后,
 * 按权重的实际效果是——**画面描述说画什么,角色档案补充这个人具体长这样**,
 * 两者冲突时画面描述优先,这通常正是想要的(剧情刚说换了衣服,就需要覆盖掉旧穿着)。
 * 但它**仍在最终负面词之前**,所以不会被后半段截断影响。
 *
 * 本模块全是纯函数,不碰宿主,单测直接跑。
 */

/** 常驻提示词(每聊天的固定补充设定)。 */
export interface ChatBasePrompt {
  /** 是否启用。关掉后本聊天的常驻词不进 CLIP,但内容保留。 */
  enabled: boolean;
  /** 全局通用那一段(不针对某个角色),如「画风保持冷色调,人物面部不要过于写实」。 */
  general: string;
  /** 按角色分开的段落,键是角色名(与固定档案同名,逐字匹配)。 */
  byChar: Record<string, string>;
}

/** 临时提示词的一条(每个角色至多一条)。 */
export interface TransientPromptEntry {
  /** 角色名(与固定档案同名)。 */
  name: string;
  /** 此刻的穿着/状态短 tag 串,直接进 CLIP。空串 = 回到固定档案。 */
  prompt: string;
  /** 冻结后 AI 不再改写这条。 */
  frozen: boolean;
  /** 最后更新于哪一楼;换聊天 / 大幅回档时据此判定是否过期。 */
  floor: number;
  /** 最后更新时间,卡片显示「N 分钟前」用。 */
  at: number;
}

/** 临时提示词(按聊天隔离)。 */
export interface TransientPromptState {
  /** 是否启用。关掉 = 完全回到「只用固定档案 + 常驻词」。 */
  enabled: boolean;
  entries: TransientPromptEntry[];
}

export const DEFAULT_CHAT_BASE_PROMPT: ChatBasePrompt = {
  enabled: true,
  general: '',
  byChar: {},
};

export const DEFAULT_TRANSIENT_PROMPT: TransientPromptState = {
  enabled: true,
  entries: [],
};

/**
 * 临时档案的过期判定。
 *
 * 纪律(与绘图姬·中转站一致,理由也一致):
 * - **同聊天、往回 ≤2 楼或往后任意楼 → 保留**:重跑上一层、继续剧情都是常规操作;
 * - **往回跳 3 楼以上 / 换聊天 → 作废**:已经过了,那条时间线上的黑色蕾丝不该还穿着;
 * - **正文明确说「脱光了」** → 模型给空串,这一层被清空,回到固定档案。
 *
 * `entryFloor` 是那条状态记录的楼层,`currentFloor` 是现在要出图/要读的楼层。
 */
export const TRANSIENT_KEEP_BACKWARD_FLOORS = 2;

export function isTransientStale(entryFloor: number, currentFloor: number): boolean {
  if (!Number.isFinite(entryFloor) || !Number.isFinite(currentFloor)) return false;
  // 往后(entryFloor < currentFloor)永远保留:剧情在往前走,状态继续有效
  if (currentFloor >= entryFloor) return false;
  return entryFloor - currentFloor > TRANSIENT_KEEP_BACKWARD_FLOORS;
}

/** 清掉过期条目,返回新数组(不就地改)。 */
export function pruneTransientPrompts(entries: TransientPromptEntry[], currentFloor: number): TransientPromptEntry[] {
  return entries.filter(entry => !isTransientStale(entry.floor, currentFloor));
}

/* ============ 文本清洗与合成 ============ */

/**
 * 档案/提示词文本清洗:折叠空白、剥掉会污染 tag 格式的子标签字面量。
 *
 * 与 autoTag/charAnchors.ts 的 sanitizeTagValue 同口径 —— 这些串最终会进
 * CLIp 文本节点、也会被序列化进 `<bbi_image>`,混进 `</bbi_image>` 会把注入格式截断。
 */
const FORBIDDEN_LITERAL = /<\/?(?:bbi_image|tag|nl|negative|characters|size)\b/i;

export function cleanPromptFragment(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  if (!text.trim()) return '';
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

/** 判断一段文本是否可用作 CLIP 片段(剔除整段是标签字面量的脏数据)。 */
export function isUsableFragment(raw: unknown): boolean {
  const text = cleanPromptFragment(raw);
  return !!text && !FORBIDDEN_LITERAL.test(text);
}

/* ============ CLIP 合并的唯一口径 ============ */

/**
 * 逗号分隔的 tag 串合并:去空、按小写去重、保持顺序。
 *
 * 与 relay/prompt.ts 的 joinTags 同语义,但这里**刻意不 import 它**:
 * 本模块会被出图中段(generate.ts)与角色页共同引用,而 relay 那一侧要 import settings,
 * 引入它会把「纯函数模块 → settings → 全插件」这条重依赖带进单测与公开接口。
 */
export function mergeTagText(...parts: Array<string | undefined | null>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const piece of String(part ?? '').split(',')) {
      const tag = piece.trim();
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return out.join(', ');
}

/** 字段拼接:与 state/charTags.buildEntryTag 同构(重复这一小段以避开循环依赖)。 */
export function entryTag(entry: Pick<CharTagEntry, 'fields' | 'raw'>): string {
  const fields = CHAR_TAG_FIELDS.map(field => (entry.fields[field] ?? '').trim()).filter(Boolean);
  if (!fields.length) return (entry.raw ?? '').trim();
  return fields.join(', ');
}

export interface CharacterPromptInput {
  /** 固定档案条目(用于「常驻/临时里写了角色名」时附上前缀与档案锚点)。 */
  entries: CharTagEntry[];
  /** 常驻词。 */
  base: ChatBasePrompt;
  /** 临时词。 */
  transient: TransientPromptState;
  /**
   * 本次画面里出现的角色名(来自 tag 的 characters[] 或正文点名)。
   * 空数组 = 无法判断在场者,此时**只取通用常驻词**,不把所有人的临时状态都塞进去
   * ——把不在场角色的穿衣状态写进这张图,是「凭空多一个人」的头号成因。
   */
  present?: string[];
  /** 只要通用常驻词、不要任何角色级内容(公开接口调用时用它,避免悄悄带上别人的私设)。 */
  generalOnly?: boolean;
  /**
   * 用户自己追加的词(按角色名)。
   *
   * 与常驻段分开走:常驻段里既有外貌也有固定着装,换装时要按词丢掉同类穿戴;
   * 而用户写的「永远戴那条项链」这类意志不该被一次换装顶掉。
   * 所以这里单独一段,永远保留在原位(排在常驻之后、临时之前)。
   */
  pinned?: Record<string, string>;
}

export interface CharacterPromptResult {
  /** 追加到正向提示词末尾的那一串(已去重、逗号分隔)。可以为空串。 */
  text: string;
  /** 本次实际用到的条目名(日志/调试用)。 */
  names: string[];
}

/**
 * 合成「角色档案提示词」——常驻 + 临时,输出一串逗号分隔的片段。
 *
 * 顺序:通用常驻 → 各角色常驻 → 各角色临时。
 * 临时在最后:同槽位覆盖靠的就是「后者赢」(见 mergeTransientTags 的说明),
 * 真正的去重由 composePositive 在最终拼接时按小写做。
 */
export function composeCharacterPrompts(input: CharacterPromptInput): CharacterPromptResult {
  const present = new Set((input.present ?? []).map(name => name.trim()).filter(Boolean));
  const names = [...present];
  const parts: string[] = [];

  if (input.base.enabled && isUsableFragment(input.base.general)) {
    parts.push(cleanPromptFragment(input.base.general));
  }

  if (input.generalOnly) {
    return { text: parts.join(', '), names: [] };
  }

  // 常驻:按角色名逐字匹配;只取在场者的(无人在场时不取任何角色级内容)。
  // 该角色有临时状态时不做「整段跳过」:常驻串里既有外貌也有固定着装,
  // 整段丢掉会把发色瞳色一起抹掉。改为只丢掉与临时同类的穿戴词(见 stripOutfitTags),
  // 这样「常驻 white dress + 临时 black lace bra」不会同时进 CLIP(糊衣服的老问题),
  // 而 long black hair、red eyes 仍然保留。
  const used: string[] = [];
  for (const name of names) {
    const text = input.base.byChar[name];
    const transientText =
      input.transient.enabled
        ? cleanPromptFragment(input.transient.entries.find(item => item.name === name)?.prompt ?? '')
        : '';
    const kept =
      transientText && isUsableFragment(transientText) && isUsableFragment(text)
        ? stripOutfitTags(cleanPromptFragment(text), transientText)
        : isUsableFragment(text)
          ? cleanPromptFragment(text)
          : '';
    if (kept) {
      parts.push(kept);
      used.push(name);
    }
  }

  // 用户追加词:不算穿戴,不参与替换,原样排在常驻之后、临时之前。
  if (input.pinned) {
    for (const name of names) {
      const text = cleanPromptFragment(input.pinned[name] ?? '');
      if (isUsableFragment(text)) parts.push(text);
    }
  }

  // 临时:同槽位覆盖靠的是「串内去重时谁在前」——所以临时那串必须插到
  // 该角色常驻段**原来的位置**再删掉常驻段,而不是简单追加到末尾。
  // 直接 append 会让「常驻白裙 + 临时黑蕾丝」两串一起进 CLIP(最常糊衣服的那种)。
  if (input.transient.enabled) {
    for (const name of names) {
      const entry = input.transient.entries.find(item => item.name === name);
      if (!entry || !entry.prompt.trim()) continue;
      const text = cleanPromptFragment(entry.prompt);
      if (!isUsableFragment(text)) continue;
      const baseText = input.base.enabled ? cleanPromptFragment(input.base.byChar[name] ?? '') : '';
      // 常驻串还在时,穿戴已经在 stripOutfitTags 里并进那一串了 —— 不再重复追加,
      // 否则同一件衣服会出现两遍(CLIP 里重复等于加强权重,画面会被那件衣服吃掉)。
      if (baseText && parts.some(part => part.includes(text.split(',')[0]?.trim() ?? text))) continue;
      parts.push(text);
    }
  }

  // 去重(小写)+ 去空,保持顺序
  return { text: mergeTagText(...parts), names: used };
}

/**
 * 判定一个 tag 是否属于「穿戴 / 身体状态」——也就是会被同一角色的临时状态顶掉的那部分。
 *
 * 为什么要判:常驻段是「外貌 + 固定着装」混成的一串(档案里的 hair/eyes 与 outfit 都拼在一起),
 * 早先的实现在角色有了临时状态时**整段跳过**常驻段,结果换了衣服的角色连发色瞳色一起消失。
 * 只替换穿戴相关的词,才能做到「换了衣服,人还是那个人」。
 *
 * 判据用词表而不是模型:这里要的是确定性 —— 出现 white dress / skirt / pantyhose /
 * nude / wet 这类词就算穿戴,long black hair、red eyes 不算。
 */
const OUTFIT_WORDS = [
  'dress', 'skirt', 'shirt', 'blouse', 'sweater', 'hoodie', 'jacket', 'coat', 'cloak', 'cape',
  'kimono', 'yukata', 'uniform', 'suit', 'vest', 'tie', 'necktie', 'bowtie', 'ribbon', 'scarf',
  'gloves', 'gauntlets', 'bra', 'panties', 'underwear', 'lingerie', 'bikini', 'swimsuit',
  'leotard', 'bodysuit', 'stockings', 'pantyhose', 'thighhighs', 'socks', 'boots', 'shoes',
  'sandals', 'heels', 'hat', 'cap', 'hood', 'mask', 'glasses', 'eyewear', 'necklace', 'choker',
  'earrings', 'bracelet', 'ring', 'belt', 'armor', 'apron', 'robe', 'pajamas', 'nightgown',
  'shorts', 'pants', 'trousers', 'jeans', 'leggings', 'clothes', 'outfit', 'costume', 'nude',
  'naked', 'topless', 'bottomless', 'wet', 'soaked', 'torn', 'ripped', 'stained', 'bruise',
  'bandage', 'wound', 'pregnant', 'sweat', 'makeup', 'lipstick', 'tattoo',
];

function isOutfitTag(tag: string): boolean {
  const key = tag.toLowerCase();
  return OUTFIT_WORDS.some(word => key.includes(word));
}

/** 按逗号切成 tag;保留原顺序,不做大小写或括号归一。 */
function splitTagList(text: string): string[] {
  return text
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

/**
 * 临时状态给定时,常驻段里还剩什么:把常驻串切成 tag,丢掉与临时串同类的穿戴词,
 * 其余(发色、瞳色、体型…)原样保留。
 */
function stripOutfitTags(baseText: string, transientText: string): string {
  const keep = splitTagList(baseText).filter(tag => !isOutfitTag(tag));
  const extra = splitTagList(transientText).filter(tag => !keep.some(item => item.toLowerCase() === tag.toLowerCase()));
  return [...keep, ...extra].join(', ');
}

/**
 * 追加到正向提示词:恒定画风词在前、画面描述居中、角色档案在后(见文件头)。
 * 空串原样返回,调用方不必判空。
 */
export function appendCharacterPrompts(prompt: string, addition: string): string {
  const base = String(prompt ?? '').trim();
  const extra = String(addition ?? '').trim();
  if (!extra) return base;
  if (!base) return extra;
  // 以逗号收尾的串直接接上,否则补一个分隔
  return base.endsWith(',') ? `${base} ${extra}` : `${base}, ${extra}`;
}

/* ============ 从模型输出里读临时状态 ============ */

/**
 * 解析「临时档案读取」那一跳的模型输出。
 *
 * 宽容到极致:模型可能给 JSON、可能给「角色: tag 串」的清单、也可能夹着解释。
 * 解析不出的条目直接丢,绝不因为一条坏数据让整次出图失败——临时状态只是锦上添花。
 */
export function parseTransientReply(
  raw: string,
  known: string[],
): Array<{ name: string; prompt: string; cleared: boolean }> {
  const text = String(raw ?? '').replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>/gi, '');
  const out: Array<{ name: string; prompt: string; cleared: boolean }> = [];
  const knownSet = new Set(known.map(name => name.trim()).filter(Boolean));

  const push = (name: string, prompt: string) => {
    const key = name.trim();
    if (!key) return;
    if (knownSet.size && !knownSet.has(key)) return;
    if (out.some(item => item.name === key)) return;
    const cleaned = cleanPromptFragment(prompt);
    if (cleaned && !isUsableFragment(cleaned)) return;
    out.push({ name: key, prompt: cleaned, cleared: !cleaned });
  };

  // ① 先试 JSON:{"角色名": "tag 串"} 或 [{"name": "...", "prompt": "..."}]
  const json = firstJson(text);
  if (json) {
    if (Array.isArray(json)) {
      for (const item of json) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const name = typeof row.name === 'string' ? row.name : '';
        const prompt = typeof row.prompt === 'string' ? row.prompt : typeof row.tag === 'string' ? row.tag : '';
        if (name) push(name, prompt);
      }
      if (out.length) return out;
    } else if (typeof json === 'object') {
      for (const [name, value] of Object.entries(json as Record<string, unknown>)) {
        if (typeof value === 'string') push(name, value);
        else if (value && typeof value === 'object') {
          const row = value as Record<string, unknown>;
          const prompt = typeof row.prompt === 'string' ? row.prompt : typeof row.tag === 'string' ? row.tag : '';
          push(name, prompt);
        }
      }
      if (out.length) return out;
    }
  }

  // ② 兜底:逐行「名字: 串」/「名字 —— 串」
  for (const line of text.split(/\n+/)) {
    const match = line.match(/^\s*[-*·\d.、]*\s*([^\s:：\-—]{1,24})\s*[:：\-—]\s*(.+)$/);
    if (!match) continue;
    push(match[1], match[2]);
  }
  return out;
}

/** 从一段文本里抠出第一个可解析的 JSON 值;失败返回 null。 */
function firstJson(text: string): unknown {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  candidates.push(text.trim());
  for (const candidate of candidates) {
    const start = candidate.search(/[[{]/);
    if (start < 0) continue;
    const slice = candidate.slice(start);
    for (let end = slice.length; end > 1; end -= 1) {
      const ch = slice[end - 1];
      if (ch !== '}' && ch !== ']') continue;
      try {
        return JSON.parse(slice.slice(0, end));
      } catch {
        // 继续缩短
      }
    }
  }
  return null;
}

/** 生成「临时档案读取」请求的规则段(与内置链同一份语气,不依赖后端)。 */
export function buildTransientTaskPrompt(known: string[]): string {
  const list = known.length ? known.join('、') : '(无固定档案角色)';
  return `你是剧情配图的服装与状态记录员。读下面的剧情正文,判断每个在场角色「这一刻」的穿戴与身体状态,输出简短的英文 danbooru 短 tag 串。

已知角色:${list}

规则:
1. 只记录**当前镜头可见**的穿戴与状态:服装、内衣、袜类、饰品、束缚、伤痕、湿身、表情基调这类**随时会变**的东西。
2. 不写发色、瞳色、体型这类固定外貌(它们另有一份档案,写了会重复)。
3. 一件衣服写成独立的部件 tag:写 black lace bra, black lace panties,不要写 black lace set(采样器对 set 这种组合词几乎没有概念,经常只画上半截)。
4. 正文明确脱下/换掉/受损时,按变化后的样子写;正文没提穿着就沿用你从上下文能推断的样子,不要凭空加戏。
5. 角色**已经全裸**时给空串(表示不需要这层的覆盖)。
6. 只输出 JSON,不要解释、不要 Markdown 代码块,格式:
{"角色名":"tag 串"}`;
}

/* ============ 在场角色判定 ============ */

/** 英文 tag 里的名字要按「词边界」比,否则 \`rin\` 会被 \`grinning\` 命中。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 名字在提示词里出现过吗;ASCII 名字要求两侧不是字母数字(避免 `rin` 被 `grinning` 命中)。
 *
 * `exclude` 是已经算给更长名字的字符区间:先在提示词里把这几个区间抹成等长占位再找,
 * 短名才不会把「小雪乃」当成自己。抹成占位而不是删掉,是为了不打乱后面的下标。
 */
function mentions(
  prompt: string,
  name: string,
  exclude: Array<{ at: number; len: number }> = [],
): boolean {
  if (!name) return false;
  let text = prompt;
  for (const span of [...exclude].sort((a, b) => b.at - a.at)) {
    text = text.slice(0, span.at) + '\u0000'.repeat(span.len) + text.slice(span.at + span.len);
  }
  if (!/[\x00-\x7f]/.test(name)) return text.includes(name);
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`,
    'i',
  );
  return pattern.test(text);
}

/**
 * 本图到底画了谁 —— 角色层取词的白名单。
 *
 * 为什么需要单独一步:ComfyUI 链路从不传 characters[](那是 NAI 4.5/V5 才有的结构化
 * 多角色字段),resolveCharacterPrompts 收到的 present 恒为空数组,于是它只返回
 * 「通用常驻词」,每个角色的固定外貌与临时穿戴全被丢掉 —— 表面上像是**角色提示词没被
 * 注入**,其实上游压根没告诉它画的是谁。
 *
 * 判定先用最保守、最便宜的信号:AI 刚按这一瞬间写出的提示词本身。
 *   - 结构化角色名一律算在场(NAI 链路,以及手动编辑弹窗里点名的那些);
 *   - 名字出现在提示词里就算在场(tag 英文名、nl 里的中文名都算);
 *   - 名字是库里另一个更长名字的前缀时**不算**并继续往后找(避免「小雪」把「小雪乃」拖进来);
 *   - 长名优先,短名在后,减少前缀吃掉整个名字的机会。
 *
 * 一个角色都没认出来时返回空数组 —— 调用方据此只发通用常驻词。
 * 宁可少带一个人,也不要把没出场的角色的套装穿到别人身上(那是凭空多一个人的头号成因)。
 */
export function pickPresentNames(
  candidates: Array<string | undefined | null>,
  prompt: string,
): string[] {
  const names = [...new Set(candidates.map(name => String(name ?? '').trim()).filter(Boolean))];
  if (!names.length) return [];
  const haystack = String(prompt ?? '');
  if (!haystack.trim()) return [];
  // 长名优先:先匹配「小雪乃」再匹配「小雪」
  const ordered = [...names].sort((a, b) => b.length - a.length);
  const claimed: string[] = [];
  /** 已经算给更长名字的字符区间:同一段字不能被短名再算一次。 */
  const spans: Array<{ at: number; len: number }> = [];
  for (const name of ordered) {
    if (!mentions(haystack, name, spans)) continue;
    claimed.push(name);
    let at = haystack.indexOf(name);
    while (at >= 0) {
      spans.push({ at, len: name.length });
      at = haystack.indexOf(name, at + name.length);
    }
  }
  // 输出保持候选原顺序,让提示词里的角色次序稳定(同一个人不会每次换位置)
  return names.filter(name => claimed.includes(name));
}
