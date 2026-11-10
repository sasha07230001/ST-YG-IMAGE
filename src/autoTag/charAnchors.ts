import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import {
  CHAR_TAG_FIELD_LABELS,
  CHAR_TAG_FIELDS,
  applyCharTagOps,
  type CharTagAutoOp,
  type CharTagEntry,
  type CharTagField,
} from '@/state/charTags';
import { getTagGenChannel } from '@/state/settings';
import type { ProfileFields } from '@/state/charProfiles';

/**
 * 角色固定外貌库的「锚定」侧。
 *
 * 生成 tag 前把库文本(全部条目)拼进请求:AI 看得到每个角色当前的字段值,才能判断
 * 需不需要改;画面 tag 里它照抄库中字段值,不使用占位符。
 *
 * 为什么不用 @角色名 占位符(v0.1.2 起撤回):原设计让 AI 只写 @小雪、由插件替换成
 * 完整字段串,本意是杜绝复述漂移。实测有三个结构性问题:
 * - 同一角色被引用多次时逐次展开,一张图里出现三份完整外貌 + 三个 1boy,
 *   模型据此画出多个重叠躯干(正向权重乘三,负面词压不住)。
 * - 规范里「40 个 tag 以内」的预算无法执行:AI 数 @小雪 是 1 个,实际展开成 6 个。
 * - 库脏数据被无条件放大:动作/场景词误入 outfit 字段时,每次展开都带上它。
 * 库文本本就在同一上下文里、字段值明明白白列着,照抄可见文本比凭记忆复述可靠,
 * 原设计高估了漂移风险。故改回「库只作参考,AI 自己写全」。
 *
 * applyCharRefs 系函数保留:模型偶发写出 @名字 时仍会被替换掉,不至于把字面量
 * 送进生图。即从主路径降级为兜底。
 *
 * 建档由主请求在同一次输出里完成(changes 的 field="new"):柏宝书的中文外貌本来就
 * 随角色参考块发给了主请求,它还额外有世界书、角色卡与目标正文佐证,比独立的转换
 * 请求判断得更准。建档与用档同属一次推理,后续 tag 才能围绕刚确立的外貌协调。
 *
 * 主流程顺序:先落 changes(本楼发生的变化当楼生效) → 再兜底替换残留的 @占位符。
 */

/** 把库条目渲染成给 AI 看的一行(字段式明细 + 占位符提示);锁定条目带 [locked] 标记。 */
export function formatEntryForPrompt(entry: CharTagEntry, locked = false): string {
  const parts: string[] = [];
  for (const f of CHAR_TAG_FIELDS) {
    const v = entry.fields[f]?.trim();
    if (v) parts.push(`${CHAR_TAG_FIELD_LABELS[f]}=${v}`);
  }
  if (!parts.length && entry.raw.trim()) parts.push(`tag=${entry.raw.trim()}`);
  if (entry.nl.trim()) parts.push(`nl=${entry.nl.trim()}`);
  return `- ${entry.name}${locked ? ' [locked]' : ''}: ${parts.join(', ') || '(未记录字段)'}`;
}

/**
 * 库文本:发给 AI 的角色库部分。AI 依据它决定 changes,并在 tag/nl 中照抄对应字段;
 * 名单与字段值都由插件生成,AI 只读。锁定名(全局库)带 [locked] 标记并在头部声明不可变。
 */
export function buildLibraryText(entries: CharTagEntry[], lockedNames?: ReadonlySet<string>): string {
  if (!entries.length) return '';
  const lines = entries.map(entry => formatEntryForPrompt(entry, lockedNames?.has(entry.name) ?? false));
  const lockedNote = lockedNames?.size
    ? '; entries marked [locked] are global and immutable: never report changes for them, always copy their fields as-is'
    : '';
  return `【角色固定外貌库】[system-maintained; copy fields verbatim into character prompts${lockedNote}]\n${lines.join('\n')}`;
}

/** 旧接口兼容:runner 之外仍有调用方依赖锚定文本形态。 */
export function buildAnchorText(entries: CharTagEntry[], lockedNames?: ReadonlySet<string>): string {
  return buildLibraryText(entries, lockedNames);
}

/* ============ 中文外貌 → 结构化字段 的批量转换 ============ */

const CONVERT_SPEC = `你是角色档案转换器。用户会用**口语**描述一个角色(可能是中文、夹着形容词和琐碎细节),你要把它拆成固定字段的 danbooru 短 tag:英文小写、逗号分隔、多词用空格连接(不要用下划线、不要加权重括号)。

字段与要求:
- name(角色名):从描述里取;用户没说就留空字符串,由界面上的名字那一格接管。
- sex(性别):1girl / 1boy / androgynous 等。年龄线索换算成 loli / teen / milf 之类,成年默认不写。
- hair(头发):必须同时给颜色与长度/发型,如 silver hair, long hair, low ponytail。
- eyes(眼睛):瞳色优先,如 red eyes。描述没提就留空。
- skin(肤色):pale skin / tan / dark skin;白皙是默认,没提可留空。
- body(体型):petite / tall / slim / large breasts / wide hips 等,按描述写。
- extra(标志特征):刺青、疤痕、异色瞳、泪痣、尖耳这类长期不变的东西。
- outfit(整体印象):如 gothic lolita、school uniform、bunny suit。只有一句话式的整体风格才写这里。
- top(上衣):shirt / hoodie / sailor collar / crop top / tank top。
- inner(内衣):bra / sports bra / lace bra / no bra。
- panties(内裤):panties / lace-trimmed panties / no panties / thigh strap。
- bottom(下装):pleated skirt / jeans / shorts / hakama。
- socks(袜子):pantyhose / black thighhighs / knee socks / garter belt。透明度与颜色必须写清。
- shoes(鞋子):sneakers / mary janes / boots / barefoot。
- special(特殊槽位):披肩、围巾、腰带、项圈、腰带束具,以及**塞进体内的道具**——vibrator、anal plug、egg vibrator、remote control 这类。有就照写,别回避。
- accHand(饰品·手部):ring / bracelet / gloves / handcuffs。
- accNeck(饰品·首部):necklace / choker / earrings / hairpin / veil。
- accFoot(饰品·足部):anklet / toe ring / bare feet ornament。
- accBreast(饰品·乳部):breast piercing / pasties / nipple clamps / breast harness。
- accPussy(饰品·阴部):clit piercing / pussy jewelry。

规则:
1. **妆容、表情、动作、场景、情绪一律不写** —— 那些属于每楼变化的 state,不是档案。
2. 用户写了哪一格就填哪一格;没提的格子**留空字符串**,不要脑补。
3. 同一件东西只写进最具体的那个槽位,不要既写 inner 又写 outfit。
4. 穿戴描写要**具体到类型、颜色、材质、长度/透明度**:"黑色蕾丝内裤"→"black lace-trimmed panties",不要只写"underwear"。
5. 只返回一个 JSON 对象:
{"name":"角色名","sex":"1girl","hair":"silver hair, long hair","eyes":"red eyes","skin":"","body":"petite","extra":"","outfit":"","top":"white shirt","inner":"black lace bra","panties":"black lace-trimmed panties","bottom":"pleated skirt","socks":"black pantyhose","shoes":"mary janes","special":"","accHand":"","accNeck":"silver necklace","accFoot":"","accBreast":"","accPussy":""}
不要 Markdown 代码块、不要解释、不要在 JSON 前后写任何字。`;

/** 字段值清洗:换行压成空格、剥 bbi_image 系子标签字面量(防止污染注入格式)。 */
function sanitizeTagValue(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (!text) return '';
  if (/<\/?(?:bbi_image|tag|nl|size)\b/i.test(text)) return '';
  return text;
}

/** 从回复里抠出第一个 JSON 对象(容忍 think 块、代码块与前后废话)。 */
function firstJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '');
  const candidates: string[] = [];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  candidates.push(cleaned.trim());
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const value: unknown = JSON.parse(candidate.slice(start, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

/** 把一层对象洗成字段集合;空值全丢,只留真的写了字的格子。 */
function fieldsOf(raw: unknown): Partial<ProfileFields> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<ProfileFields> = {};
  for (const field of CHAR_TAG_FIELDS) {
    const tag = sanitizeTagValue((raw as Record<string, unknown>)[field]);
    if (tag) out[field] = tag;
  }
  return out;
}

export interface ParsedProfile {
  /** 模型从描述里认出的名字;没认出来就是空串,由界面已有的名字接管。 */
  name: string;
  fields: Partial<ProfileFields>;
  /** 整串 tag:模型另外给了一整句时才用。 */
  raw: string;
  /** 一句自然语言外貌描述(NAI 用),没给就是空串。 */
  nl: string;
}

/**
 * 解析口语描述转换结果。
 *
 * 兼容两种形状:新契约的单角色扁平对象(带 name),以及旧的多角色
 * `{"角色名":{字段…}}` —— 后者取第一条也能用,用户不会因为版本差异填不出格子。
 */
export function parseProfileDraft(raw: string): ParsedProfile {
  const value = firstJsonObject(raw);
  if (!value) return { name: '', fields: {}, raw: '', nl: '' };
  const obj = value as Record<string, unknown>;

  const own = fieldsOf(obj);
  const hasOwnFields = Object.keys(own).length > 0;
  if (hasOwnFields) {
    return {
      name: sanitizeTagValue(obj.name),
      fields: own,
      raw: sanitizeTagValue(obj.raw),
      nl: sanitizeTagValue(obj.nl),
    };
  }

  for (const [key, inner] of Object.entries(obj)) {
    const fields = fieldsOf(inner);
    if (Object.keys(fields).length) {
      return { name: sanitizeTagValue(key), fields, raw: '', nl: '' };
    }
  }
  // 一条字段都没有:名字与整串照样保留 —— 用户可能只想让 AI 从口语里认出这个人叫什么,
  // 或者把整句原样落进 raw 那一格,这比丢掉整次转换有用。
  return { name: sanitizeTagValue(obj.name), fields: {}, raw: sanitizeTagValue(obj.raw), nl: sanitizeTagValue(obj.nl) };
}

/**
 * 把一段口语描述转成档案草稿。一次请求只转一个角色 —— 用户点的是"这一条"的转化按钮,
 * 批量反而会让模型把几个人的穿戴混在一起。
 *
 * 渠道与自动 tag 主流程同口径:指派渠道优先,未指派跟随主 API。
 * 请求异常向上抛,调用方 catch 后提示用户(不静默丢描述)。
 */
export async function convertProfileFromText(
  text: string,
  signal?: AbortSignal,
  nameHint = '',
): Promise<ParsedProfile> {
  const story = String(text ?? '').trim();
  if (!story) return { name: '', fields: {}, raw: '', nl: '' };
  const messages: ChatMsg[] = [
    { role: 'system', content: CONVERT_SPEC },
    {
      role: 'user',
      content: nameHint.trim()
        ? `角色名:${nameHint.trim()}\n描述:${story}`
        : `描述:${story}`,
    },
  ];
  const channel = getTagGenChannel();
  const raw = channel
    ? await requestCompletion(channel, messages, { signal, source: '角色档案转换' })
    : await requestViaMainApi(messages, { signal, source: '角色档案转换' });
  return parseProfileDraft(raw);
}

/* ============ 主流程入口 ============ */

/**
 * 生成前的库准备:把当前库渲染成请求里的库文本。
 *
 * 纯函数、无请求 —— 建档已交给主请求(见文件头)。保留这层是因为调用方还需要
 * 「库文本 + 库条目」这对组合,且 @占位符替换要以同一份 entries 为基线。
 * 空库返回 text=null,调用方据此不启用 @占位符。
 */
export interface ResolvedCharAnchors {
  text: string | null;
  entries: CharTagEntry[];
}

export function resolveCharAnchors(
  entriesBefore: CharTagEntry[],
  lockedNames?: ReadonlySet<string>,
): ResolvedCharAnchors {
  const text = buildLibraryText(entriesBefore, lockedNames);
  return { text: text || null, entries: entriesBefore };
}

/* ============ @占位符 替换 ============ */

/** @名 占位符;名字允许中文/字母/数字/点/下划线/间隔号(常见角色名形态)。 */
const REF_PATTERN = /@([\p{L}\p{N}_.·]+)/gu;

function joinEntryTag(entry: CharTagEntry): string {
  // 与 state/charTags.buildEntryTag 同构;重复这一小段以避开循环依赖
  if (entry.raw.trim() && CHAR_TAG_FIELDS.every(f => !(entry.fields[f] ?? '').trim())) {
    return entry.raw.trim();
  }
  return CHAR_TAG_FIELDS.map(f => (entry.fields[f] ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

/** 压缩替换后残留的分隔符垃圾:连续逗号、行首行尾逗号。 */
function tidySeparators(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/,\s*,/g, ',').replace(/\s+,/g, ',').replace(/,\s+/g, ', ');
    if (next === out) break;
    out = next;
  }
  return out.replace(/^[\s,]+/, '').replace(/[\s,]+$/, '').trim();
}

/**
 * AI 输出文本里的 @占位符 处理:库里有的 → 替换成最新 tag 串(nl 模式优先条目的自然语言句);
 * 没有的 → 剥掉(连带尾随分隔符)。返回处理后的文本与未知名字列表(调用方可用于告警)。
 */
export function applyCharRefs(
  text: string,
  entries: CharTagEntry[],
  mode: 'tag' | 'nl' = 'tag',
): { text: string; unknown: string[] } {
  const byName = new Map(entries.map(e => [e.name, e]));
  const unknown: string[] = [];
  const seen = new Set<string>();
  const replaced = text.replace(REF_PATTERN, (_full, name: string) => {
    const entry = byName.get(name);
    if (entry) {
      if (mode === 'nl' && entry.nl.trim()) return entry.nl.trim();
      return joinEntryTag(entry);
    }
    if (!seen.has(name)) {
      seen.add(name);
      unknown.push(name);
    }
    return '';
  });
  return { text: tidySeparators(replaced), unknown };
}

export interface PositionedCharOp {
  op: CharTagAutoOp;
  sourceLine: number;
}

/**
 * 按图片位置解析 @占位符。
 *
 * 建档(new)全楼生效:新角色的固定外貌是本楼**全程成立的事实**,不是「从某处开始」的
 * 变化——同一楼里位置更靠前的图片也可能有这个角色在场。若按位置门控,那些图片的
 * @占位符会查不到条目而被整个剥掉,角色变成没有外貌。
 * 永久变化(set)才按位置门控:染发之前的图片必须用旧档案。
 */
export function applyPositionedCharRefs(
  text: string,
  entries: CharTagEntry[],
  ops: PositionedCharOp[],
  sourceLine: number,
  mode: 'tag' | 'nl' = 'tag',
  locked?: ReadonlySet<string>,
): { text: string; unknown: string[] } {
  const activeOps = ops
    .filter(item => item.op.kind === 'new' || item.sourceLine <= sourceLine)
    .map(item => item.op);
  return applyCharRefs(text, applyCharTagOps(entries, activeOps, -1, locked), mode);
}
