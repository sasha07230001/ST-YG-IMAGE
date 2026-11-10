import { cleanPromptFragment, composeCharacterPrompts, isUsableFragment } from '@/autoTag/characterPrompts';
import { CHAR_TAG_FIELDS, type CharTagEntry, type CharTagField } from '@/state/charTags';
import { getContext } from '@/st/context';
import { reactive } from 'vue';

/**
 * 角色档案 —— 0.7 起取代旧的「角色管理」。
 *
 * ## 两层结构
 *
 * | 层 | 在哪 | 谁写 | 作用 |
 * |---|---|---|---|
 * | **档案库**(ProfileBook) | extensionSettings,跨聊天 | **只有用户** | 存角色的初始人设(外貌/体型/常驻气质)与**触发关键词** |
 * | **本聊天档案**(ChatProfile) | chatMetadata,按聊天隔离 | **AI 读正文后写** | 实际进「角色层」的那份:随剧情生长,可回滚 |
 *
 * ## 为什么分两层
 *
 * 旧实现把「固定外貌」和「本聊天已经发生的变化」混在同一张表里,只靠一个
 * `[locked]` 标记区分能否被 AI 改。结果是:用户想维护「这个角色的设定」时,
 * 手上那份已经被剧情改过了;而 AI 想看「她现在长什么样」时,又会被用户手写的
 * 初始设定盖回去。分成两层后两边各管各的:
 *
 * - 档案库是**模板**:用户塞进去什么,永远是什么,AI 只读。
 * - 本聊天档案是**实例**:关键词在本聊天被提及 → 从档案库复制一份初始档案 → 之后
 *   由 AI 按正文持续更新(此时档案库那一份仍原封不动,换个聊天还是干净的)。
 *
 * ## 关键词为什么必要
 *
 * 旧实现靠「名字出现在正文里就算在场」,于是:别人叫一声「小雪」,隔壁聊天的小雪
 * 也会被拖进画面。关键词把「谁」和「怎么被提到」解耦:角色的正式名是一回事,
 * 触发词(昵称、称号、职业、旧姓)是另一回事,只有用户列进 `keywords` 的才算命中。
 *
 * ## 本聊天档案不进楼层 extra
 *
 * 旧实现的 AI 变化存在目标楼 `extra[BBI_CHAR_EXTRA_KEY]` 里,靠重放算出「第 N 楼时
 * 她是什么样」。代价是:删楼/换 swipe 就得全部重算,而且用户手动改动会与重放结果
 * 打架。新实现把结果直接写成**当前状态**(chatMetadata 一份),AI 每次读正文后
 * 就地更新,历史另存一份可回滚的快照。楼层号只用来标「这条是什么时候变的」。
 */

/* ============ 档案库(跨聊天,只读给 AI) ============ */

const BOOK_KEY = 'baibai_image_char_profile_book';
const BOOK_EVENT = 'st-baibai-image:char-profile-changed';
const SCHEMA_VERSION = 1;

/**
 * 档案字段。
 *
 * 直接从 `CHAR_TAG_FIELDS` 派生:字段清单只在 charTags.ts 维护一份,
 * 这里加一句 Record 就能跟上,不会出现"新槽位能填但存不下"的错位。
 * 语义上仍分两类:不变的外貌(fandom…extra)与默认穿戴(outfit + 各槽位 + 各饰品位),
 * 后者只是模板 —— AI 每楼改的是本聊天档案的 `state`。
 */
export type ProfileFields = Record<CharTagField, string>;

export interface ProfileEntry {
  /** 角色正式名(与正文/档案库一致;AI 引用时用这个名字)。 */
  name: string;
  /** 触发关键词:本聊天正文里出现任意一条,就把这个角色拉进本聊天档案。 */
  keywords: string[];
  /** 初始外貌字段。 */
  fields: ProfileFields;
  /** 整串 tag(字段为空时用它)。 */
  raw: string;
  /** 自然语言外貌(可选)。 */
  nl: string;
  /** 一句话人设/备注,只给 AI 当建档依据,不进 CLIP。 */
  desc: string;
  /** 是否在每次生成时都把这条档案发给 AI 当参考(默认 true)。 */
  enabled: boolean;
}

interface ProfileBook {
  schemaVersion: number;
  revision: number;
  entries: ProfileEntry[];
}

export const profileBook = reactive<{ entries: ProfileEntry[] }>({ entries: [] });
let fingerprint = '';
let revision = 0;
let listenerBound = false;

export function emptyProfileFields(): ProfileFields {
  const fields = {} as ProfileFields;
  for (const field of CHAR_TAG_FIELDS) fields[field] = '';
  return fields;
}

/** 关键词清洗:去重、去空白、去超长项(触发词不该是一句话)。 */
export function normalizeKeywords(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，、\n]/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const key = typeof item === 'string' ? item.trim() : '';
    if (!key || key.length > 24) continue;
    const lower = key.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(key);
  }
  return out;
}

function normalizeProfileFields(raw: unknown): ProfileFields {
  const fields = emptyProfileFields();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fields;
  for (const field of CHAR_TAG_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === 'string') fields[field] = value.trim();
  }
  return fields;
}

function normalizeProfileEntry(raw: unknown): ProfileEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<ProfileEntry>;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!name) return null;
  const fields = normalizeProfileFields(row.fields);
  const legacyTags = typeof (row as { tags?: unknown }).tags === 'string' ? String((row as { tags?: unknown }).tags).trim() : '';
  const rawTag = typeof row.raw === 'string' ? row.raw.trim() : legacyTags;
  const keywords = normalizeKeywords(row.keywords);
  // 名字本身就是最强的触发词:用户没填关键词时,名字出现即命中
  if (!keywords.length) keywords.push(name);
  return {
    name,
    keywords,
    fields,
    raw: rawTag,
    nl: typeof row.nl === 'string' ? row.nl.trim() : '',
    desc: typeof row.desc === 'string' ? row.desc : '',
    enabled: row.enabled !== false,
  };
}

export function normalizeProfileBook(raw: unknown): ProfileEntry[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as Partial<ProfileBook>).entries ?? [])
      : [];
  const out: ProfileEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const entry = normalizeProfileEntry(item);
    if (!entry) continue;
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function profileEntryTag(entry: Pick<ProfileEntry, 'fields' | 'raw'>): string {
  const fields = CHAR_TAG_FIELDS.map(field => (entry.fields[field] ?? '').trim()).filter(Boolean);
  return fields.length ? fields.join(', ') : (entry.raw ?? '').trim();
}

function fingerprintOf(entries: ProfileEntry[]): string {
  return JSON.stringify(entries);
}

function persistBook(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  revision += 1;
  const store: ProfileBook = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    entries: JSON.parse(JSON.stringify(profileBook.entries)) as ProfileEntry[],
  };
  // 写进 `extension_settings.baibai_image` 里面那一格:与其它设置同一个命名空间,
  // 导出/备份/导入一体带走;读的那头 readBookStore() 同时认旧版顶层键。
  const ext = ctx.extensionSettings as Record<string, unknown>;
  const host = (ext.baibai_image ?? {}) as Record<string, unknown>;
  host[BOOK_KEY] = store;
  ext.baibai_image = host;
  fingerprint = fingerprintOf(store.entries);
  ctx.saveSettingsDebounced?.();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent(BOOK_EVENT, { detail: { revision: store.revision, source: 'ST-BaiBai-Image' } }),
    );
  }
}

function applyBook(entries: ProfileEntry[]): void {
  const next = fingerprintOf(entries);
  if (next === fingerprint) return;
  profileBook.entries = entries;
  fingerprint = next;
}

/**
 * 档案库存在哪:先看 `extension_settings.baibai_image` 里面那份(现行口径),
 * 再回退到顶层键(旧版留下的),两处都认才谈得上「升级不丢数据」。
 */
function readBookStore(): unknown {
  const ext = getContext()?.extensionSettings;
  if (!ext) return null;
  const inner = ext.baibai_image as { baibai_image_char_profile_book?: unknown } | undefined;
  const nested = inner?.baibai_image_char_profile_book;
  if (nested) return nested;
  return ext[BOOK_KEY];
}

function bindBookListener(): void {
  if (listenerBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listenerBound = true;
  window.addEventListener(BOOK_EVENT, () => {
    const raw = readBookStore();
    if (raw) applyBook(normalizeProfileBook(raw));
  });
}

/**
 * 启动时领养已有档案库(跨设备同步靠它 + 广播事件)。
 *
 * 这里查两处而不是一处:新版本把档案库写在 `extension_settings.baibai_image` 里面
 * (与其它设置同一个命名空间,导出/备份一体),早期版本写在该命名空间的顶层。
 * 只读顶层会在升级后让用户的档案库「凭空消失」—— 明明档案页写着 1 条,渠道页却是 0 个角色。
 */
export function initProfileBook(): void {
  const raw = readBookStore();
  if (raw) applyBook(normalizeProfileBook(raw));
  bindBookListener();
}

/**
 * 档案库整块(给「合并视图」用:同一个角色可能只在档案库里、还没在本聊天建档)。
 * 返回只读快照,改动一律走 upsertProfile —— 档案库不允许 AI 碰。
 */
export function listProfileBook(): ProfileEntry[] {
  return profileBook.entries.map(entry => ({
    ...entry,
    keywords: [...entry.keywords],
    fields: { ...entry.fields },
  }));
}

export function findProfile(name: string): ProfileEntry | undefined {
  const key = name.trim().toLowerCase();
  return profileBook.entries.find(entry => entry.name.toLowerCase() === key);
}

export function upsertProfile(entry: ProfileEntry, oldName?: string): boolean {
  const name = entry.name.trim();
  if (!name) return false;
  const normalized = normalizeProfileEntry({ ...entry, name });
  if (!normalized) return false;
  const old = oldName?.trim();
  if (old && old.toLowerCase() !== name.toLowerCase()) {
    const index = profileBook.entries.findIndex(item => item.name.toLowerCase() === old.toLowerCase());
    if (index >= 0) profileBook.entries.splice(index, 1);
  }
  const index = profileBook.entries.findIndex(item => item.name.toLowerCase() === name.toLowerCase());
  if (index >= 0) profileBook.entries[index] = normalized;
  else profileBook.entries.push(normalized);
  persistBook();
  return true;
}

export function removeProfile(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  const index = profileBook.entries.findIndex(entry => entry.name.toLowerCase() === key);
  if (index < 0) return false;
  profileBook.entries.splice(index, 1);
  persistBook();
  return true;
}

/* ============ 本聊天档案(chatMetadata,AI 可写) ============ */

const CHAT_KEY = 'yg_char_profiles';

/**
 * 状态档(穿戴 + 身体状态)在历史里记成字段名 `state`。
 *
 * 为什么单列一个字段而不复用 outfit:outfit 是「固定着装」,属于外貌档案;
 * 换了件裙子、被抓破衣服、怀孕、被打伤这些是**这一刻的样子**,下一秒就可能变,
 * 写进 outfit 会让角色永远穿着那件衣服。两者混在一个字段里,UI 也没法分栏显示。
 */
export type ChatProfileStateField = 'state';

export interface ChatProfileChange {
  field: CharTagField | ChatProfileStateField | 'new' | 'kw' | 'nl' | 'raw' | 'mine';
  from: string;
  to: string;
  reason: string;
  /** 触发这次变化的楼层;-1 = 手动。 */
  floor: number;
  at: number;
}

export interface ChatProfile {
  /** 角色正式名(与档案库同名;档案库里没有的临时角色也允许存在)。 */
  name: string;
  /** 这份档案的初始来源:档案库哪条。空串 = 档案库里已经没有这条了。 */
  from: string;
  fields: ProfileFields;
  raw: string;
  nl: string;
  /**
   * 这一刻的穿戴与身体状态(英文 danbooru 短 tag 串)。
   *
   * 由 AI 每楼按正文改写:换衣服、脱下、衣物破损、湿透、受伤、怀孕、发胖、染指甲……
   * 都属于这里。它与 `fields` 的分工是「会变」与「不变」:外貌档案只放长期特征,
   * 这一格放此刻的样子。出图时它会随角色层一起发出,所以每次更新完立刻反映到图里。
   */
  state: string;
  /**
   * 用户随时追加的提示词(AI 永不改写)。
   *
   * 存在的理由:整份档案是 AI 按剧情维护的,"我想让她永远戴那条项链"这类**用户意志**
   * 没有地方落 —— 写进 fields 会被 AI 视作可补全的字段,写进 state 下一楼就被穿戴记录顶掉。
   * 这一格只属于用户:它排在固定外貌之后参与角色层拼接,删空即失效,
   * 而 AI 每楼照常更新 fields 与 state,两边互不干扰。
   */
  mine: string;
  /** 命中的关键词(建这份档案时的依据,UI 显示与排查用)。 */
  matched: string[];
  /** 建档楼层。 */
  floor: number;
  /** 最近一次更新时间。 */
  at: number;
  /** 最近一次更新时是否由 AI 写入。 */
  by: 'ai' | 'manual' | 'seed';
  history: ChatProfileChange[];
}

const HISTORY_CAP = 40;

export const chatProfiles = reactive<{ entries: ChatProfile[] }>({ entries: [] });

function normalizeChatProfile(raw: unknown): ChatProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<ChatProfile>;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!name) return null;
  const history: ChatProfileChange[] = [];
  for (const item of Array.isArray(row.history) ? row.history.slice(-HISTORY_CAP) : []) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Partial<ChatProfileChange>;
    const field = typeof rec.field === 'string' ? rec.field : '';
    if (!field) continue;
    history.push({
      field: field as ChatProfileChange['field'],
      from: typeof rec.from === 'string' ? rec.from : '',
      to: typeof rec.to === 'string' ? rec.to : '',
      reason: typeof rec.reason === 'string' ? rec.reason : '',
      floor: typeof rec.floor === 'number' && Number.isFinite(rec.floor) ? Math.floor(rec.floor) : -1,
      at: typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : 0,
    });
  }
  return {
    name,
    from: typeof row.from === 'string' ? row.from : '',
    fields: normalizeProfileFields(row.fields),
    raw: typeof row.raw === 'string' ? row.raw.trim() : '',
    nl: typeof row.nl === 'string' ? row.nl.trim() : '',
    // 旧档案没有 state 键:当成「还没有穿戴记录」,不是「什么都没穿」
    state: typeof row.state === 'string' ? row.state.trim() : '',
    mine: typeof row.mine === 'string' ? row.mine.trim() : '',
    matched: normalizeKeywords(row.matched),
    floor: typeof row.floor === 'number' && Number.isFinite(row.floor) ? Math.floor(row.floor) : 0,
    at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0,
    by: row.by === 'ai' || row.by === 'manual' ? row.by : 'seed',
    history,
  };
}

function readChatStore(): ChatProfile[] {
  const raw = getContext()?.chatMetadata?.[CHAT_KEY];
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)
      ? ((raw as { entries: unknown[] }).entries)
      : [];
  const out: ChatProfile[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const entry = normalizeChatProfile(item);
    if (!entry) continue;
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let hydrated = false;

function persistChat(): void {
  const ctx = getContext();
  if (!ctx?.chatMetadata) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const inner = getContext();
    if (!inner?.chatMetadata) return;
    inner.chatMetadata[CHAT_KEY] = {
      schemaVersion: SCHEMA_VERSION,
      entries: JSON.parse(JSON.stringify(chatProfiles.entries)) as ChatProfile[],
    };
    inner.saveMetadataDebounced?.();
  }, 250);
}

export function flushChatProfiles(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  const ctx = getContext();
  if (!ctx?.chatMetadata) return;
  ctx.chatMetadata[CHAT_KEY] = {
    schemaVersion: SCHEMA_VERSION,
    entries: JSON.parse(JSON.stringify(chatProfiles.entries)) as ChatProfile[],
  };
  ctx.saveMetadataDebounced?.();
}

/**
 * 从 chatMetadata 读进内存。
 *
 * **必须幂等到「内容没变就不动引用」**:读出来是普通对象数组,直接 `entries = next` 会
 * 新建引用,凡是 `computed` 里读过 `chatProfiles.entries` 的组件全部重新求值;而求值过程
 * 又会调 `ensureChatProfiles()` —— 于是变成无限重新渲染,面板一打开就卡死。
 *
 * 所以这里先比内容指纹(签名相同的对象字面量),只有真的变了才替换。
 */
export function hydrateChatProfiles(): void {
  const next = readChatStore();
  const nextKey = JSON.stringify(next);
  if (nextKey !== chatFingerprint) {
    chatFingerprint = nextKey;
    chatProfiles.entries = next;
  }
  hydrated = true;
}

/** 上一次 hydrate 读进来的内容指纹:相同就不动数组引用,避免 computed 抖动。 */
let chatFingerprint = '';

/**
 * 确保本聊天档案已读进内存。
 *
 * 这里**每次都重读**,不是只在第一次:插件启动时 chatMetadata 可能还没加载完
 * (`hydrateWhenReady` 只等 getContext 存在,不等聊天数据),那一次读到的就是空数组。
 * 一旦被标成 hydrated,后面所有入口都等着这块空缓存 —— 于是出现「渠道页 0 个角色,
 * 点一下角色档案页就正常」这种看人下菜碟的假 bug。
 *
 * 重读的代价只是把一个几十条的对象读进内存;漏读的代价是用户看不到任何角色词。
 */
export function ensureChatProfiles(): void {
  const ctx = getContext();
  // 没有聊天上下文时(测试的假 ctx、或 ST 还没进聊天)重读只会把内存里的东西清掉,
  // 那不叫「确保已就绪」。真正的空聊天由 readChatStore 返回空数组来体现。
  if (!ctx?.chatMetadata) return;
  // 有未落盘的改动时也要重读:此刻内存比磁盘新,重读会把刚播的种丢掉。
  if (persistTimer) return;
  hydrateChatProfiles();
}

export function findChatProfile(name: string): ChatProfile | undefined {
  const key = name.trim().toLowerCase();
  return chatProfiles.entries.find(entry => entry.name.toLowerCase() === key);
}

/* ============ 关键词命中 → 建本聊天档案 ============ */

/**
 * 关键词是否出现在文本里。
 *
 * ASCII 关键词按词边界比(`rin` 不该被 `grinning` 命中),中文关键词直接包含判定
 * (中文没有词边界,按边界比会一个都命中不了)。
 */
export function keywordHits(text: string, keyword: string): boolean {
  const key = keyword.trim();
  if (!key || !text) return false;
  if (!/[\x00-\x7f]/.test(key)) return text.includes(key);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').test(text);
}

export interface KeywordMatch {
  /** 档案库里的条目。 */
  entry: ProfileEntry;
  /** 命中的关键词。 */
  matched: string[];
}

/**
 * 在文本里找命中的档案库条目。
 *
 * `exclude` 用来跳过「已经有本聊天档案」的角色:它们不需要再从档案库播种。
 */
export function matchProfileKeywords(text: string, options: { exclude?: string[] } = {}): KeywordMatch[] {
  const haystack = String(text ?? '');
  if (!haystack.trim()) return [];
  const skip = new Set((options.exclude ?? []).map(name => name.trim().toLowerCase()).filter(Boolean));
  const out: KeywordMatch[] = [];
  for (const entry of profileBook.entries) {
    if (!entry.enabled) continue;
    if (skip.has(entry.name.toLowerCase())) continue;
    const matched = entry.keywords.filter(keyword => keywordHits(haystack, keyword));
    if (matched.length) out.push({ entry, matched });
  }
  return out;
}

/** 把档案库条目复制成本聊天档案(初始状态,floor = 命中楼层)。 */
export function seedChatProfile(entry: ProfileEntry, matched: string[], floor: number): ChatProfile {
  const profile: ChatProfile = {
    name: entry.name,
    from: entry.name,
    fields: { ...entry.fields },
    raw: entry.raw,
    nl: entry.nl,
    state: '',
    mine: '',
    matched: normalizeKeywords(matched),
    floor,
    at: Date.now(),
    by: 'seed',
    history: [
      {
        field: 'new',
        from: '',
        to: profileEntryTag(entry),
        reason: matched.length ? `命中关键词 ${matched.join(' / ')}` : '按档案库建档',
        floor,
        at: Date.now(),
      },
    ],
  };
  const index = chatProfiles.entries.findIndex(item => item.name.toLowerCase() === profile.name.toLowerCase());
  if (index >= 0) chatProfiles.entries.splice(index, 1, profile);
  else chatProfiles.entries.push(profile);
  persistChat();
  return profile;
}

/**
 * 扫描正文,把命中关键词、尚未建档的角色拉进本聊天档案。返回新建的条目名。
 *
 * 调用点:runner 每楼跑自动 tag 之前、角色页打开时。种子只做一次(已建档的不重复复制),
 * 之后这份档案由 AI 按剧情改写 —— 档案库里那份永远不会被覆盖。
 */
export function seedChatProfilesFromText(text: string, floor: number): string[] {
  ensureChatProfiles();
  const existing = chatProfiles.entries.map(entry => entry.name);
  const matches = matchProfileKeywords(text, { exclude: existing });
  if (!matches.length) return [];
  for (const match of matches) seedChatProfile(match.entry, match.matched, floor);
  return matches.map(match => match.entry.name);
}

/** 手动作废一份本聊天档案(下次正文再提到关键词会重新播种)。 */
export function dropChatProfile(name: string): boolean {
  const key = name.trim().toLowerCase();
  const index = chatProfiles.entries.findIndex(entry => entry.name.toLowerCase() === key);
  if (index < 0) return false;
  chatProfiles.entries.splice(index, 1);
  persistChat();
  return true;
}

/** 从档案库重新播种(覆盖 AI 已改的内容,历史保留)。 */
export function reseedChatProfile(name: string, floor: number): boolean {
  ensureChatProfiles();
  const entry = findProfile(name);
  if (!entry) return false;
  const current = findChatProfile(name);
  const before = current ? { ...current.fields } : null;
  const next = seedChatProfile(entry, entry.keywords.filter(keyword => keyword.trim() === name.trim()), floor);
  next.history = current?.history ?? [];
  next.history.push({
    field: 'new',
    from: before ? Object.values(before).join(', ') : '',
    to: profileEntryTag(entry),
    reason: '从档案库重新播种',
    floor,
    at: Date.now(),
  });
  persistChat();
  return true;
}

/* ============ 手动编辑与回滚 ============ */

export interface ChatProfilePatch {
  fields?: Partial<ProfileFields>;
  raw?: string;
  nl?: string;
  /** 这一刻的穿戴/身体状态(用户也可以手改,改完立刻进角色层)。 */
  state?: string;
  /** 用户追加的提示词(AI 不写;改它不会把这份档案标记成「手动维护」)。 */
  mine?: string;
}

export function updateChatProfile(name: string, patch: ChatProfilePatch, floor = -1, reason = '手动编辑'): boolean {
  ensureChatProfiles();
  const profile = findChatProfile(name);
  if (!profile) return false;
  const at = Date.now();
  let changed = false;
  let touchedBeyondMine = false;
  if (patch.fields) {
    for (const field of CHAR_TAG_FIELDS) {
      const value = patch.fields[field];
      if (typeof value !== 'string') continue;
      const clean = value.trim();
      if (clean === profile.fields[field]) continue;
      profile.history.push({ field, from: profile.fields[field], to: clean, reason, floor, at });
      profile.fields[field] = clean;
      changed = true;
      touchedBeyondMine = true;
    }
  }
  for (const key of ['raw', 'nl', 'state', 'mine'] as const) {
    const value = patch[key];
    if (typeof value !== 'string') continue;
    const clean = value.trim();
    if (clean === profile[key]) continue;
    profile.history.push({ field: key, from: profile[key], to: clean, reason, floor, at });
    profile[key] = clean;
    changed = true;
    // 只有"用户追加提示词"这一格变了,不算手写整份档案:
    // AI 之后照常更新 fields/state,界面上也不该显示成「手动」。
    if (key !== 'mine') touchedBeyondMine = true;
  }
  if (!changed) return false;
  profile.at = at;
  if (touchedBeyondMine) profile.by = 'manual';
  if (profile.history.length > HISTORY_CAP) {
    profile.history.splice(0, profile.history.length - HISTORY_CAP);
  }
  persistChat();
  return true;
}

export function rollbackChatProfile(name: string, record: ChatProfileChange): boolean {
  const profile = findChatProfile(name);
  if (!profile) return false;
  if (record.field === 'new') return dropChatProfile(name);
  const patch: ChatProfilePatch = {};
  if (record.field === 'raw') patch.raw = record.from;
  else if (record.field === 'nl') patch.nl = record.from;
  else if (record.field === 'state') patch.state = record.from;
  else if (record.field === 'mine') patch.mine = record.from;
  else if (record.field === 'kw') return false;
  else patch.fields = { [record.field]: record.from } as Partial<ProfileFields>;
  return updateChatProfile(name, patch, -1, '手动回滚');
}

/* ============ 本聊天档案的 AI 写入 ============ */

/**
 * AI 报上来的档案更新。与 `autoTag/protocol.ts` 的 `changes` 一一对应:
 * `field:"new"` → 新建档案;其他字段 → 改现有档案。
 *
 * 为什么不直接复用 CharChange:那边带 position,按楼层位置生效(旧实现重放模型);
 * 这里的本聊天档案是**当前状态**,AI 报的一条变化就地生效,不需要位置。
 */
export interface ProfileUpdate {
  name: string;
  field: CharTagField | 'new' | 'raw' | 'nl' | 'state';
  value: string;
  nl: string;
  /** 建档那一刻的穿戴/身体状态(只有 field:"new" 会带;空 = 交给这一楼的状态记录)。 */
  state?: string;
  reason: string;
}

export interface ProfileUpdateResult {
  created: string[];
  updated: string[];
  /** 字段值与原值相同的条目数(不算变化)。 */
  unchanged: number;
}

/**
 * 把 AI 的 changes 应用到本聊天档案。
 *
 * 规则:
 * - `field:"new"` 且已存在 → 按「补空缺」处理(只填原来为空的字段),不推翻已有档案;
 * - 其他字段 → 直接覆盖(剧情里染了发就是染了,不会自己变回去);
 * - 档案库里有的角色**也改本聊天档案**,档案库本身永远不动(用户维护的那份);
 * - hair/eyes 同时为空的新档案直接丢弃 —— 没有身份锚点的档案会把角色画成路人。
 */
export function applyProfileUpdates(updates: ProfileUpdate[], floor: number): ProfileUpdateResult {
  ensureChatProfiles();
  const created: string[] = [];
  const updated: string[] = [];
  let unchanged = 0;
  const at = Date.now();
  for (const update of updates) {
    const name = update.name.trim();
    const value = String(update.value ?? '').trim();
    if (!name) continue;
    if (update.field === 'new') {
      const book = findProfile(name);
      const seeded = book
        ? { fields: { ...book.fields }, raw: book.raw, nl: book.nl }
        : { fields: emptyProfileFields(), raw: '', nl: '' };
      const existing = findChatProfile(name);
      if (existing) {
        // 已建档:只补空缺,不推翻 AI 之前按剧情改出来的样子
        const patch: ChatProfilePatch = {};
        const fields: Partial<ProfileFields> = {};
        for (const field of CHAR_TAG_FIELDS) {
          const next = seeded.fields[field];
          if (next && !existing.fields[field]) fields[field] = next;
        }
        if (Object.keys(fields).length) patch.fields = fields;
        if (seeded.raw && !existing.raw) patch.raw = seeded.raw;
        if (seeded.nl && !existing.nl) patch.nl = seeded.nl;
        if (updateChatProfile(name, patch, floor, update.reason || 'AI 补全档案')) updated.push(name);
        else unchanged += 1;
        continue;
      }
      if (!value) {
        // AI 没给字段串:退回档案库初始值
        if (!profileEntryTag(seeded)) continue;
        const profile = seedChatProfile(
          book ?? {
            name,
            keywords: [name],
            fields: seeded.fields,
            raw: seeded.raw,
            nl: seeded.nl,
            desc: '',
            enabled: true,
          },
          update.reason ? [update.reason] : [],
          floor,
        );
        profile.by = 'ai';
        created.push(name);
        continue;
      }
      // AI 给了整串:按 tag 串建档
      const profile: ChatProfile = {
        name,
        from: book?.name ?? '',
        fields: seeded.fields,
        raw: value,
        nl: update.nl.trim(),
        // 用户追加的提示词只属于用户:AI 建档时留空,并且永远不写它
        mine: '',
        // AI 建档时若已经在正文里写了她穿什么,一并记成这一刻的状态
        state: String(update.state ?? '').trim(),
        matched: [],
        floor,
        at,
        by: 'ai',
        history: [
          { field: 'new', from: '', to: value, reason: update.reason || 'AI 建档', floor, at },
        ],
      };
      chatProfiles.entries.push(profile);
      created.push(name);
      continue;
    }
    if (!value) continue;
    const existing = findChatProfile(name);
    if (!existing) {
      // 档案里没有这个角色:AI 报的字段变化当作建档依据,先建再写
      const book = findProfile(name);
      const profile: ChatProfile = {
        name,
        from: book?.name ?? '',
        fields: { ...(book?.fields ?? emptyProfileFields()) },
        raw: book?.raw ?? '',
        nl: book?.nl ?? '',
        state: '',
        mine: '',
        matched: [],
        floor,
        at,
        by: 'ai',
        history: [],
      };
      chatProfiles.entries.push(profile);
    }
    const patch: ChatProfilePatch =
      update.field === 'raw'
        ? { raw: value }
        : update.field === 'nl'
          ? { nl: value }
          : update.field === 'state'
            ? { state: value }
            : { fields: { [update.field]: value } as Partial<ProfileFields> };
    if (updateChatProfile(name, patch, floor, update.reason || 'AI 更新档案')) updated.push(name);
    else unchanged += 1;
  }
  if (created.length || updated.length) persistChat();
  return { created, updated, unchanged };
}

/* ============ 给 AI 看的库文本 ============ */
/** 字段式明细,一行一个角色;只在需要人工排查时用(默认走 tag 串)。 */
export function formatProfileForPrompt(entry: Pick<ChatProfile, 'name' | 'fields' | 'raw'>): string {
  const tag = profileEntryTag(entry);
  return `- ${entry.name}: ${tag || '(未记录)'}`;
}

/**
 * AI 请求里「角色档案」区块的文本。
 *
 * 只给 **本聊天档案**(它才是这一场戏里她实际的样子),不给整个档案库 ——
 * 档案库是给用户塞角色用的,几百条全塞进上下文既费 token 又与本次画面无关。
 * 关键词都没命中、本聊天档案为空时,这段退化成一句说明,不占消息位。
 */
export function buildChatProfileBlock(entries: ChatProfile[], matchedNow: string[] = []): string {
  const list = entries.filter(entry => profileEntryTag(entry) || entry.mine.trim());
  if (!list.length) return '';
  const now = new Set(matchedNow.map(name => name.trim().toLowerCase()));
  const lines = list.map(entry => {
    const mark = now.has(entry.name.toLowerCase()) ? '[本次命中]' : '[本聊天已有]';
    const outfit = entry.state.trim()
      ? `｜此刻: ${entry.state.trim()}`
      : '｜此刻: (还没有记录,按本楼正文定一次)';
    const mine = entry.mine.trim() ? `｜用户追加(照抄,别改别删): ${entry.mine.trim()}` : '';
    const tag = [profileEntryTag(entry), mine].filter(Boolean).join(' ');
    return `- ${entry.name}${mark}: ${tag}${outfit}`;
  });
  return `【本聊天角色档案】[由 AI 按正文维护;外貌照抄、此刻按正文改写]\n${lines.join('\n')}`;
}

/**
 * 本次画面要用哪些角色档案 —— 角色层取词的**唯一口径**。
 *
 * 顺序:
 * 1. `characters[]` 里点名的(NAI 结构化多角色字段、手动重写时点名的);
 * 2. AI 刚写出的 tag/nl 里出现名字的;
 * 3. 本楼正文里命中关键词的(别人在场但一句没提时靠它兜底);
 * 4. 上一楼已经在场的(剧情连续,别因为这一句没写名字就把人剥光)。
 *
 * 一个都没认出来时返回空数组 —— 调用方只发通用常驻词。
 * 宁可少带一个人,也不要把没出场的角色的衣服穿到别人身上。
 */
/**
 * 最近一次编译时**选中的那段正文**。预览要判「谁在场」,可它手上只有示例剧情串;
 * 拿真实正文去判才是用户那一刻想看的人。runner 每楼跑自动 tag 时记一笔,只存本机。
 */
let lastStoryText = '';

export function rememberStoryText(text: string): void {
  lastStoryText = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

export function lastRememberedStory(): string {
  return lastStoryText;
}
export function resolvePresentProfiles(options: {
  candidates?: Array<string | undefined | null>;
  prompt?: string;
  story?: string;
  previous?: string[];
}): string[] {
  ensureChatProfiles();
  const known = chatProfiles.entries.map(entry => entry.name);
  const knownByLower = new Map(known.map(name => [name.toLowerCase(), name]));
  const picked: string[] = [];
  const push = (name: string | undefined | null) => {
    const key = String(name ?? '').trim().toLowerCase();
    if (!key) return;
    const real = knownByLower.get(key);
    if (!real || picked.includes(real)) return;
    picked.push(real);
  };
  for (const name of options.candidates ?? []) push(name);
  const haystack = [options.prompt ?? '', options.story ?? ''].join('\n');
  if (haystack.trim()) {
    // 长名优先:先认「小雪乃」再认「小雪」,避免短名把长名吃掉
    for (const name of [...known].sort((a, b) => b.length - a.length)) {
      if (picked.includes(name)) continue;
      if (keywordHits(haystack, name)) push(name);
    }
    // 名字没出现、但用户给这个角色配的关键词出现了,同样算在场:
    // 正文常写「她」「学姐」或昵称,角色正式名一个字都不出现。
    for (const entry of chatProfiles.entries) {
      if (picked.some(name => name.toLowerCase() === entry.name.toLowerCase())) continue;
      const words = [...entry.matched, ...(findProfile(entry.name)?.keywords ?? [])];
      if (words.some(keyword => keywordHits(haystack, keyword))) push(entry.name);
    }
  }
  for (const name of options.previous ?? []) push(name);
  return picked;
}

/**
 * 角色层的成品串(常驻 + 临时,去重逗号分隔)。UI 预览与出图共用。
 *
 * 不能直接套 `composeCharacterPrompts`:它的常驻段读 `base.byChar[name]`,
 * 而本聊天档案的固定外貌存在 `fields/raw` 里。这里先把每条档案压成一句 tag
 * 塞进 `base.byChar`,再让那一份唯一实现负责拼接、去重与临时覆盖。
 */
export function composeProfilesForPresent(present: string[]): string {
  ensureChatProfiles();
  const byChar: Record<string, string> = {};
  const pinned: Record<string, string> = {};
  for (const entry of chatProfiles.entries) {
    if (!present.some(name => name.toLowerCase() === entry.name.toLowerCase())) continue;
    const tag = profileEntryTag(entry);
    if (tag) byChar[entry.name] = tag;
    // 用户追加词单独走 pinned 段:它不参与穿戴替换,换装不会把用户写的话顶掉。
    const mine = entry.mine.trim();
    if (mine) pinned[entry.name] = mine;
  }
  // 这一刻的穿戴与身体状态作为「临时词」交给同一份实现:它排在常驻外貌之后,
  // 并且对同一个角色会**替换**常驻段里同类的那几个词(见 composeCharacterPrompts),
  // 于是「换上黑色蕾丝裙」不会与档案里的 white dress 同时出现在提示词里,
  // 而发色、瞳色、体型这些没被替换的外貌词照旧保留 —— 换衣服不该把人也换掉。
  const transient = {
    enabled: true,
    entries: present
      .map(name => {
        const entry = chatProfiles.entries.find(item => item.name.toLowerCase() === name.toLowerCase());
        return entry && entry.state.trim()
          ? { name: entry.name, prompt: entry.state.trim(), floor: entry.floor, at: entry.at, frozen: false }
          : null;
      })
      .filter(
        (item): item is { name: string; prompt: string; floor: number; at: number; frozen: boolean } =>
          item !== null,
      ),
  };
  const result = composeCharacterPrompts({
    entries: [],
    base: { enabled: true, general: '', byChar },
    transient,
    pinned,
    present,
  });
  return result.text;
}

/** 一句档案的 CLIP 串(空字段时回退 raw),给 UI 与出图预览用。 */
export function chatProfileTag(entry: ChatProfile): string {
  return profileEntryTag(entry);
}

/** 清洗一段将被序列化进 tag 的文本(防 `</bbi_image>` 之类把注入格式截断)。 */
export function safeProfileText(raw: unknown): string {
  const text = cleanPromptFragment(raw);
  return isUsableFragment(text) ? text : '';
}
