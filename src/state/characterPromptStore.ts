import {
  composeCharacterPrompts,
  isTransientStale,
  pruneTransientPrompts,
  DEFAULT_CHAT_BASE_PROMPT,
  DEFAULT_TRANSIENT_PROMPT,
  type CharacterPromptResult,
  type ChatBasePrompt,
  type TransientPromptEntry,
  type TransientPromptState,
} from '@/autoTag/characterPrompts';
import { composeProfilesForPresent } from '@/state/charProfiles';
import { getContext } from '@/st/context';
import {
  normalizeCharacterPromptSettings,
  type CharacterPromptSettings,
} from '@/state/settings';
import { reactive } from 'vue';

/**
 * 常驻 / 临时提示词的读写层:按聊天隔离,存 `chatMetadata['yg_character_prompts']`。
 *
 * ## 为什么放 chatMetadata 而不是 extensionSettings
 *
 * 这两份内容都是**这个聊天自己的设定**——本聊天里她是黑丝秘书,换个聊天她是校服剑士。
 * 放全局设置会让两个聊天互相污染,而用户完全看不出是哪边改的。
 * chatMetadata 随聊天 jsonl 一起保存、随聊天删除,天然就是「每聊天一份」。
 *
 * ## 为什么临时词也要持久化
 *
 * 绘图姬·中转站把它放在 extensionSettings 里再靠「楼号」判定过期,
 * 换聊天就得清空重来。放 chatMetadata 的代价是它跟着聊天走(这正合语义),
 * 好处是:swipe 回去、刷新页面、关掉酒馆再开,她穿什么都还在。
 *
 * ## 响应式
 *
 * `basePrompt` / `temporaryPrompt` 是 reactive 的派生缓存,UI 直接读它渲染;
 * 真源仍是 chatMetadata。任何写操作 → 立刻同步内存 → 落盘(防抖)。
 * 与 charTags.ts 同构:reactive 只是缓存,不做第二套真相。
 */

const META_KEY = 'yg_character_prompts';

export const basePrompt = reactive<ChatBasePrompt>({ ...DEFAULT_CHAT_BASE_PROMPT, byChar: {} });
export const temporaryPrompt = reactive<TransientPromptState>({
  enabled: DEFAULT_TRANSIENT_PROMPT.enabled,
  entries: [],
});

let hydrated = false;

function readStore(): CharacterPromptSettings | null {
  const raw = getContext()?.chatMetadata?.[META_KEY];
  if (!raw) return null;
  return normalizeCharacterPromptSettings(raw);
}

/** 从 chatMetadata 读进内存(切聊天、启动、打开角色页前都该调一次;幂等)。 */
export function hydrateCharacterPrompts(): void {
  const store = readStore() ?? {
    base: DEFAULT_CHAT_BASE_PROMPT,
    transient: DEFAULT_TRANSIENT_PROMPT,
  };
  replaceState(store);
  hydrated = true;
}

function replaceState(store: CharacterPromptSettings): void {
  basePrompt.enabled = store.base.enabled;
  basePrompt.general = store.base.general;
  basePrompt.byChar = { ...store.base.byChar };
  temporaryPrompt.enabled = store.transient.enabled;
  temporaryPrompt.entries = store.transient.entries.map(entry => ({ ...entry }));
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 落盘。防抖 300ms:用户在文本框里打字时每按一个键就 saveMetadata 会把 ST 拖垮。
 *
 * 刻意不用 saveMetadataDebounced 直接顶上去:ST 那个防抖是全局共享的,
 * 我们频繁调用会把它自己那点写入挤掉(柏宝书与柏宝绘都吃过这个亏)。
 */
function persistCharacters(): void {
  const context = getContext();
  if (!context?.chatMetadata) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const ctx = getContext();
    if (!ctx?.chatMetadata) return;
    const store: CharacterPromptSettings = {
      base: {
        enabled: basePrompt.enabled,
        general: basePrompt.general,
        byChar: { ...basePrompt.byChar },
      },
      transient: {
        enabled: temporaryPrompt.enabled,
        entries: temporaryPrompt.entries.map(entry => ({ ...entry })),
      },
    };
    ctx.chatMetadata[META_KEY] = store;
    ctx.saveMetadataDebounced?.();
  }, 300);
}

/** 立刻落盘(切聊天前、页面卸载前用)。 */
export function flushCharacterPrompts(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  persistCharacters();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const ctx = getContext();
  if (!ctx?.chatMetadata) return;
  ctx.chatMetadata[META_KEY] = {
    base: { enabled: basePrompt.enabled, general: basePrompt.general, byChar: { ...basePrompt.byChar } },
    transient: { enabled: temporaryPrompt.enabled, entries: temporaryPrompt.entries.map(e => ({ ...e })) },
  };
  ctx.saveMetadataDebounced?.();
}

/* ============ 常驻词 ============ */

export function setBaseEnabled(enabled: boolean): void {
  basePrompt.enabled = enabled;
  persistCharacters();
}

export function setBaseGeneral(text: string): void {
  basePrompt.general = text;
  persistCharacters();
}

/** 写某个角色的常驻段;传空串 = 删除该段(不留空键)。 */
export function setBaseForChar(name: string, text: string): void {
  const key = name.trim();
  if (!key) return;
  if (text.trim()) basePrompt.byChar[key] = text;
  else delete basePrompt.byChar[key];
  // 触发 reactive 更新:对象整体重建,Vue 才认得出「键被删了」
  basePrompt.byChar = { ...basePrompt.byChar };
  persistCharacters();
}

export function removeBaseForChar(name: string): void {
  setBaseForChar(name, '');
}

/* ============ 临时词 ============ */

/** 写某角色的临时状态;prompt 为空 = 清空这条(回到固定档案)。 */
export function setTransientForChar(
  name: string,
  prompt: string,
  options: { floor?: number; frozen?: boolean } = {},
): void {
  const key = name.trim();
  if (!key) return;
  const index = temporaryPrompt.entries.findIndex(entry => entry.name === key);
  const text = prompt.trim();
  if (!text) {
    if (index >= 0) temporaryPrompt.entries.splice(index, 1);
    persistCharacters();
    return;
  }
  const next: TransientPromptEntry = {
    name: key,
    prompt: text,
    frozen: options.frozen ?? (index >= 0 ? temporaryPrompt.entries[index].frozen : false),
    floor: options.floor ?? (index >= 0 ? temporaryPrompt.entries[index].floor : 0),
    at: Date.now(),
  };
  if (index >= 0) temporaryPrompt.entries.splice(index, 1, next);
  else temporaryPrompt.entries.push(next);
  persistCharacters();
}

export function setTransientFrozen(name: string, frozen: boolean): void {
  const entry = temporaryPrompt.entries.find(item => item.name === name.trim());
  if (!entry) return;
  entry.frozen = frozen;
  persistCharacters();
}

export function clearTransient(name: string): void {
  setTransientForChar(name, '');
}

/** 全部清空(换聊天/大幅回档的「手动」按钮也用它)。 */
export function clearAllTransients(): void {
  temporaryPrompt.entries.splice(0, temporaryPrompt.entries.length);
  persistCharacters();
}

export function setTransientEnabled(enabled: boolean): void {
  temporaryPrompt.enabled = enabled;
  persistCharacters();
}

/**
 * 读临时状态前先按楼号清一遍过期项,返回**当前楼层有效**的条目。
 *
 * 与 pruneTransientPrompts 的分工:那个是纯函数(判定规则),这个是副作用版
 * (清完还要落盘 + 更新 UI)。过期判定口径见 characterPrompts.isTransientStale。
 */
export function transientsAtFloor(floor: number): TransientPromptEntry[] {
  const before = temporaryPrompt.entries.length;
  const kept = pruneTransientPrompts(temporaryPrompt.entries, floor);
  if (kept.length !== before) {
    temporaryPrompt.entries.splice(0, temporaryPrompt.entries.length, ...kept);
    persistCharacters();
  }
  return kept.filter(entry => !isTransientStale(entry.floor, floor));
}

/** 某条是否已过期(UI 标灰用)。 */
export function isEntryStale(entry: TransientPromptEntry, floor: number): boolean {
  return isTransientStale(entry.floor, floor);
}

/* ============ 本聊天角色档案(给渠道页的可见列表) ============ */

/**
 * 本聊天角色档案的可编辑视图:每行一个角色,同时给出「档案里的固定外貌」与「用户手写的追加词」。
 *
 * 为什么要这一层:`byChar` 只存用户手写的那段,档案给的固定外貌并不在里面
 * (那是 charProfiles 的事)。渠道页要让用户看见「这个角色进角色层时到底发出什么」,
 * 所以把两份拼成一行只读的 `effective`,再单独把可写的那格 `override` 交回给界面。
 * 合成走 composeCharacterPrompts,与出图同一份实现 —— 预览与实发不允许有两套口径。
 */
export interface CharacterPromptRow {
  /** 角色名(与档案同名)。 */
  name: string;
  /** 档案给的固定外貌串(只读;空 = 还没建档或档案没词)。 */
  profile: string;
  /** 用户手写的追加/覆盖词(可写,存 byChar)。 */
  override: string;
  /** 此刻的临时穿戴(AI 写,只读)。 */
  transient: string;
  /** 临时词是否被冻结(AI 不再改写)。 */
  frozen: boolean;
  /** 这一行最终进角色层的串(档案 + 手写 + 穿戴,已去重)。 */
  effective: string;
}

export function listCharacterPromptRows(): CharacterPromptRow[] {
  const names: string[] = [];
  const push = (name: string | undefined | null) => {
    const key = String(name ?? '').trim();
    if (key && !names.includes(key)) names.push(key);
  };
  for (const name of Object.keys(basePrompt.byChar)) push(name);
  for (const entry of temporaryPrompt.entries) push(entry.name);
  return names.map(name => {
    const profile = composeProfilesForPresent([name]);
    const override = String(basePrompt.byChar[name] ?? '').trim();
    const entry = temporaryPrompt.entries.find(item => item.name === name);
    const transient = entry ? entry.prompt.trim() : '';
    const merged = composeCharacterPrompts({
      entries: [],
      base: { enabled: basePrompt.enabled, general: '', byChar: { [name]: override } },
      transient: { enabled: temporaryPrompt.enabled, entries: entry ? [entry] : [] },
      present: [name],
      generalOnly: false,
    }).text;
    return {
      name,
      profile,
      override,
      transient,
      frozen: entry?.frozen === true,
      effective: merged,
    };
  });
}

/* ============ 出图取用 ============ */

export interface ResolveOptions {
  /** 当前楼层(清过期临时词用);缺省取聊天的最后一条。 */
  floor?: number;
  /** 本画面在场的角色名。空 = 只取通用常驻词。 */
  present?: string[];
  /** 只要通用常驻词(公开接口默认走这条,不替第三方带上角色私设)。 */
  generalOnly?: boolean;
  /**
   * 是否先重读 chatMetadata。缺省 true。
   * 楼层卡片用默认值(用户可能刚在角色页改过常驻词);
   * 公开接口传 false —— 它只取一行通用常驻词,没必要为此动聊天状态。
   */
  reload?: boolean;
}

/**
 * 出图时把「角色档案提示词」合成出来 —— 楼层卡片、公开接口、调试预览的唯一入口。
 *
 * 每次都会重新从 chatMetadata 读一遍(reload 时):用户可能刚在角色页改了常驻词、
 * 或者刚在楼里点了「更新临时状态」,内存缓存未必是最新的。
 */
export function resolveCharacterPrompts(options: ResolveOptions = {}): CharacterPromptResult {
  const context = getContext();
  if (options.reload !== false && context?.chatMetadata) {
    hydrateCharacterPrompts();
  } else if (!hydrated) {
    hydrateCharacterPrompts();
  }
  const floor = options.floor ?? Math.max(0, (context?.chat?.length ?? 1) - 1);
  const entries = transientsAtFloor(floor);
  return composeCharacterPrompts({
    entries: [],
    base: basePrompt,
    transient: { enabled: temporaryPrompt.enabled, entries },
    present: options.present,
    generalOnly: options.generalOnly,
  });
}

/** 角色页「预览」用:直接用当前内存状态,不动磁盘、不改楼层判定。 */
export function previewCharacterPrompts(present: string[]): CharacterPromptResult {
  if (!hydrated) hydrateCharacterPrompts();
  return composeCharacterPrompts({
    entries: [],
    base: basePrompt,
    transient: { enabled: temporaryPrompt.enabled, entries: temporaryPrompt.entries },
    present,
  });
}

/**
 * 切聊天后重建内存状态。由 bindCharacterPromptSync() 挂到 CHAT_CHANGED 上。
 * 幂等:重复调用不会重复订阅(与各 bind* 同一条纪律)。
 */
let bound = false;
export function bindCharacterPromptSync(): void {
  if (bound) return;
  const context = getContext();
  const events = context?.eventTypes;
  if (!context?.eventSource || !events?.CHAT_CHANGED) return;
  bound = true;
  context.eventSource.on(events.CHAT_CHANGED, () => {
    // 先落盘旧聊天:防抖队列里可能还有没写完的改动,切走就丢了
    flushCharacterPrompts();
    hydrateCharacterPrompts();
  });
}
