<script setup lang="ts">
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { convertProfileFromText } from '@/autoTag/charAnchors';
import { readBookMemory } from '@/autoTag/bookMemory';
import {
  CHAR_TAG_FIELDS,
  CHAR_TAG_FIELD_HINTS,
  CHAR_TAG_FIELD_LABELS,
  type CharTagField,
} from '@/state/charTags';
import {
  chatProfiles,
  listProfileBook,
  resolvePresentProfiles,
  dropChatProfile,
  emptyProfileFields,
  findChatProfile,
  findProfile,
  hydrateChatProfiles,
  keywordHits,
  profileBook,
  profileEntryTag,
  removeProfile,
  reseedChatProfile,
  rollbackChatProfile,
  seedChatProfilesFromText,
  updateChatProfile,
  upsertProfile,
  type ChatProfile,
  type ChatProfileChange,
  type ProfileEntry,
  type ProfileFields,
} from '@/state/charProfiles';
import { getContext } from '@/st/context';
import { computed, reactive, ref } from 'vue';

/**
 * 角色档案 —— 取代旧的「角色管理」。
 *
 * 两层,各管各的:
 * - **档案库**(上):用户自己往里塞角色,带触发关键词。只有用户能改,AI 只读。
 * - **本聊天角色档案**(下):关键词在本聊天正文里被提到 → 从档案库复制一份 → AI 读剧情
 *   持续更新它;出图时角色层的词**实时**从这里取,不再另外维护一份「常驻提示词」。
 *
 * 页面上任何一次保存都直接写回这两层,没有中间草稿表:预览用的就是出图用的那份数据。
 */

type Scope = 'book' | 'chat';

interface Draft {
  name: string;
  keywords: string;
  fields: ProfileFields;
  raw: string;
  nl: string;
  /** 这一刻的穿戴与身体状态:只有本聊天档案有,档案库那一层永远是模板。 */
  state: string;
  /** 用户追加的提示词:本聊天档案专用,AI 每楼照常更新别的格子,不动这一格。 */
  mine: string;
  desc: string;
  enabled: boolean;
}

/* 每格的填写提示来自字段表本身(见 charTags.CHAR_TAG_FIELD_HINTS),这里不再各写一份。 */

/* ============ 草稿 ============ */

const draft = ref<Draft | null>(null);
const editingName = ref<string | null>(null);
const draftScope = ref<Scope>('book');
const historyOpen = ref(false);
const regenerating = ref(false);
const confirmDeleteOpen = ref(false);
const confirmRollbackOpen = ref(false);
const pendingRollback = ref<{ name: string; record: ChatProfileChange } | null>(null);
const filter = ref('');

function emptyDraft(scope: Scope): Draft {
  return {
    name: '',
    keywords: '',
    fields: emptyProfileFields(),
    raw: '',
    nl: '',
    state: '',
    mine: '',
    desc: '',
    enabled: scope === 'book',
  };
}

function openBookEntry(entry: ProfileEntry) {
  editingName.value = entry.name;
  draftScope.value = 'book';
  draft.value = {
    name: entry.name,
    keywords: entry.keywords.join(', '),
    fields: { ...emptyProfileFields(), ...entry.fields },
    raw: entry.raw,
    nl: entry.nl,
    state: '',
    mine: '',
    desc: entry.desc,
    enabled: entry.enabled,
  };
  historyOpen.value = false;
}

function openChatEntry(entry: ChatProfile) {
  editingName.value = entry.name;
  draftScope.value = 'chat';
  draft.value = {
    name: entry.name,
    keywords: (findProfile(entry.name)?.keywords ?? entry.matched).join(', '),
    fields: { ...emptyProfileFields(), ...entry.fields },
    raw: entry.raw,
    nl: entry.nl,
    state: entry.state ?? '',
    mine: entry.mine ?? '',
    desc: findProfile(entry.name)?.desc ?? '',
    enabled: true,
  };
  historyOpen.value = false;
}

function addEntry(scope: Scope) {
  editingName.value = null;
  draftScope.value = scope;
  draft.value = emptyDraft(scope);
  historyOpen.value = false;
}

function closeEntry() {
  draft.value = null;
  editingName.value = null;
  regenerating.value = false;
  historyOpen.value = false;
}

/* ============ 折叠(本机视图偏好) ============ */

const COLLAPSE_KEYS: Record<Scope, string> = {
  book: 'bbi.ui.charBookCollapsed.v1',
  chat: 'bbi.ui.charChatProfileCollapsed.v1',
};
function loadCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function persistCollapsed(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* localStorage 不可用时就只在本次会话生效 */
  }
}
const bookCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.book));
const chatCollapsed = ref(loadCollapsed(COLLAPSE_KEYS.chat));
function toggleFold(scope: Scope) {
  const target = scope === 'book' ? bookCollapsed : chatCollapsed;
  target.value = !target.value;
  persistCollapsed(COLLAPSE_KEYS[scope], target.value);
}

/* ============ 列表 ============ */

const bookEntries = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return profileBook.entries;
  return profileBook.entries.filter(
    entry =>
      entry.name.toLowerCase().includes(q) ||
      entry.keywords.some(keyword => keyword.toLowerCase().includes(q)),
  );
});
const bookFoldable = computed(() => profileBook.entries.length > 0);
const bookShown = computed(() => !bookCollapsed.value || !bookFoldable.value);

const chatRows = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const list = chatProfiles.entries;
  if (!q) return list;
  return list.filter(entry => entry.name.toLowerCase().includes(q));
});
const chatFoldable = computed(() => chatProfiles.entries.length > 0);
const chatShown = computed(() => !chatCollapsed.value || !chatFoldable.value);

const currentFloor = computed(() => Math.max(0, (getContext()?.chat?.length ?? 1) - 1));

/** 近 6 楼正文:在场判定的唯一输入。 */
const recentStory = computed(() => {
  const ctx = getContext();
  if (!ctx?.chat?.length) return '';
  return ctx.chat
    .slice(-6)
    .map(message => message?.mes ?? '')
    .join('\n');
});

/**
 * 哪些角色此刻算在场。直接调 `resolvePresentProfiles` —— 与出图时的判定
 * 是**同一个函数**,不再本地复写一份「近 6 楼里有关键词就够了」的近似逻辑
 * (那样两边一旦漂移,页面说在场、出图却取不到词,人就开始怀疑数据没写进去)。
 * 它同时吃「本聊天档案已种子化/已记下的关键词」与「档案库里用户手写的关键词」。
 */
const presentNow = computed(() => new Set<string>(resolvePresentProfiles({ story: recentStory.value })));

/**
 * 出图时真正发给 CLIP 的角色层(与 generate.ts 同一口径的只读预览)。
 *
 * 本聊天档案里没有、或档案串为空(用户手动建了个空壳/旧数据丢了 fields)时,
 * 退回档案库里的初始外貌 —— 出图也是这么兜底的,所以这里显示的就是真会发的那串。
 */
const livePromptRows = computed(() => {
  const book = listProfileBook();
  const rows: { name: string; tag: string; from: 'chat' | 'book' }[] = [];
  for (const name of presentNow.value) {
    const entry = chatProfiles.entries.find(item => item.name.toLowerCase() === name.toLowerCase());
    const chatTag = entry ? profileEntryTag(entry) : '';
    if (chatTag) {
      rows.push({ name, tag: chatTag, from: 'chat' });
      continue;
    }
    const fallback = book.find(item => item.name.toLowerCase() === name.toLowerCase());
    const bookTag = fallback ? profileEntryTag(fallback) : '';
    if (bookTag) rows.push({ name, tag: bookTag, from: 'book' });
  }
  return rows;
});

function chipsOf(entry: Pick<ProfileEntry, 'fields' | 'raw'>): { label: string; value: string }[] {
  const chips: { label: string; value: string }[] = [];
  for (const field of CHAR_TAG_FIELDS) {
    const value = entry.fields[field]?.trim();
    if (value) chips.push({ label: CHAR_TAG_FIELD_LABELS[field], value });
  }
  return chips;
}

const draftTag = computed(() => {
  const d = draft.value;
  return d ? profileEntryTag({ fields: d.fields, raw: d.raw }) : '';
});

const editingHistory = computed<ChatProfileChange[]>(() => {
  if (!editingName.value || draftScope.value !== 'chat') return [];
  return findChatProfile(editingName.value)?.history ?? [];
});

/* ============ 保存 / 删除 ============ */

function confirmEntry() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('角色名不能为空', 'YG 插图师');
    return;
  }
  if (!draftTag.value) {
    toastr.warning('至少填一个外貌字段(或整串 tag)', 'YG 插图师');
    return;
  }
  const keywords = d.keywords
    .split(/[,，、\n]/)
    .map(item => item.trim())
    .filter(Boolean);

  if (draftScope.value === 'chat') {
    // 本聊天档案:存在就改字段,不存在就先按当前草稿播种再改
    if (!findChatProfile(name)) {
      upsertProfile(
        {
          name,
          keywords: keywords.length ? keywords : [name],
          fields: d.fields,
          raw: d.raw,
          nl: d.nl,
          desc: d.desc,
          enabled: true,
        },
        undefined,
      );
      seedChatProfilesFromText(name, currentFloor.value);
    }
    const ok = updateChatProfile(
      name,
      { fields: d.fields, raw: d.raw, nl: d.nl, state: d.state, mine: d.mine },
      currentFloor.value,
      editingName.value ? '手动编辑' : '手动建档',
    );
    if (ok || findChatProfile(name)) {
      toastr.success(`「${name}」的本聊天档案已保存`, 'YG 插图师');
      closeEntry();
    } else {
      toastr.warning('保存失败:档案可能已被删除', 'YG 插图师');
    }
    return;
  }

  const ok = upsertProfile(
    {
      name,
      keywords: keywords.length ? keywords : [name],
      fields: d.fields,
      raw: d.raw,
      nl: d.nl,
      desc: d.desc,
      enabled: d.enabled,
    },
    editingName.value ?? undefined,
  );
  if (ok) {
    toastr.success(`「${name}」已存入档案库(所有聊天共用,AI 只读)`, 'YG 插图师');
    closeEntry();
  }
}

function askRemove() {
  confirmDeleteOpen.value = true;
}

function confirmRemove() {
  confirmDeleteOpen.value = false;
  const name = editingName.value;
  if (!name) return;
  if (draftScope.value === 'book') {
    removeProfile(name);
    toastr.success(`已从档案库删除「${name}」;已建的本聊天档案不受影响`, 'YG 插图师');
  } else {
    dropChatProfile(name);
    toastr.info(`已删除「${name}」的本聊天档案;正文再提到关键词会重新播种`, 'YG 插图师');
  }
  closeEntry();
}

function askRemoveBook(entry: ProfileEntry) {
  editingName.value = entry.name;
  draftScope.value = 'book';
  confirmDeleteOpen.value = true;
}

function askRemoveChat(entry: ChatProfile, event: Event) {
  event.stopPropagation();
  editingName.value = entry.name;
  draftScope.value = 'chat';
  confirmDeleteOpen.value = true;
}

/* ============ 口语描述 → 字段 ============ */

/** 字段分组:一屏塞 20 个格子会看不清,分成三段,每组自带说明。 */
const FIELD_GROUPS: Array<{ title: string; hint: string; fields: CharTagField[] }> = [
  {
    title: '外貌(长期不变)',
    hint: '发色、瞳色、体型、标志。这些进每张图,不该随剧情变。',
    fields: ['fandom', 'sex', 'hair', 'eyes', 'skin', 'body', 'extra'],
  },
  {
    title: '默认着装(槽位)',
    hint: '没换衣服时保持的样子。每楼真正的穿戴由 AI 写进本聊天档案的「此刻状态」。',
    fields: ['outfit', 'top', 'inner', 'panties', 'bottom', 'socks', 'shoes'],
  },
  {
    title: '饰品与特殊槽位',
    hint: '按部位拆开;特殊槽位放披肩、围巾、项圈,以及塞进体内的道具。',
    fields: ['accHand', 'accNeck', 'accFoot', 'accBreast', 'accPussy', 'special'],
  },
];

const profileText = ref('');
const converting = ref(false);

/**
 * 把口语描述交给模型转成字段。
 *
 * 只覆盖**模型真的返回了内容**的格子,用户之前手填的、描述里没提的格子保持原样 ——
 * 否则点一次"自动转化"就等于把已经填好的东西清空。
 */
async function convertDraft() {
  const d = draft.value;
  if (!d) return;
  const text = profileText.value.trim();
  if (!text) {
    toastr.info('先在上面写一段口语描述,例如「银灰长发、红色眼睛,穿黑蕾丝内裤和白色过膝袜」', 'YG 插图师');
    return;
  }
  converting.value = true;
  try {
    const parsed = await convertProfileFromText(text, undefined, d.name.trim());
    const filled = Object.keys(parsed.fields).length;
    if (!filled && !parsed.name && !parsed.raw) {
      toastr.warning('模型没有给出可用的字段,可以再点一次或手动填写', 'YG 插图师');
      return;
    }
    if (!d.name.trim() && parsed.name) d.name = parsed.name;
    d.fields = { ...d.fields, ...parsed.fields };
    if (parsed.raw && !d.raw.trim()) d.raw = parsed.raw;
    if (parsed.nl && !d.nl.trim()) d.nl = parsed.nl;
    // 关键词那一格也从描述里补:名字本身一定算一个触发词。
    if (!d.keywords.trim() && d.name.trim()) d.keywords = d.name.trim();
    toastr.success(`已填入 ${filled} 个字段${filled ? '' : '(只认出了名字)'},检查一遍再点「完成」`, 'YG 插图师');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), 'YG 插图师');
  } finally {
    converting.value = false;
  }
}

/* ============ 从柏宝书补字段 / 重新播种 ============ */

async function regenerateFromBook() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('先填写角色名', 'YG 插图师');
    return;
  }
  const ctx = getContext();
  const floor = (ctx?.chat.length ?? 0) - 1;
  if (!ctx || floor < 0) {
    toastr.info('当前没有打开的聊天', 'YG 插图师');
    return;
  }
  regenerating.value = true;
  try {
    const memory = readBookMemory(floor, ctx.chat[floor]?.mes ?? '', ctx.name1);
    const role = memory?.roles.find(item => item.name === name);
    if (!role?.desc) {
      toastr.info('柏宝书最新状态里没有该角色的外貌记录,可手动填写', 'YG 插图师');
      return;
    }
    const parsed = await convertProfileFromText(role.desc, undefined, name);
    if (!Object.keys(parsed.fields).length) {
      toastr.warning('模型没有返回该角色的 tag,请重试或手动填写', 'YG 插图师');
      return;
    }
    d.fields = { ...emptyProfileFields(), ...parsed.fields };
    d.raw = '';
    d.desc = role.desc;
    toastr.success('已按柏宝书最新外貌填好,点「完成」保存', 'YG 插图师');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), 'YG 插图师');
  } finally {
    regenerating.value = false;
  }
}

function askReseed(entry: ChatProfile, event: Event) {
  event.stopPropagation();
  if (reseedChatProfile(entry.name, currentFloor.value)) {
    toastr.success(`已按档案库重播「${entry.name}」,AI 之前改的内容被覆盖(历史仍可回滚)`, 'YG 插图师');
  } else {
    toastr.warning(`档案库里已经没有「${entry.name}」`, 'YG 插图师');
  }
}

/** 正文里现在就提到关键词、但还没建档的角色 → 一键播种。 */
const pendingSeed = computed(() => {
  const ctx = getContext();
  if (!ctx?.chat?.length) return [] as ProfileEntry[];
  const text = ctx.chat
    .slice(-6)
    .map(message => message?.mes ?? '')
    .join('\n');
  const have = new Set(chatProfiles.entries.map(entry => entry.name.toLowerCase()));
  return profileBook.entries.filter(
    entry =>
      entry.enabled &&
      !have.has(entry.name.toLowerCase()) &&
      entry.keywords.some(keyword => keywordHits(text, keyword)),
  );
});

function seedNow() {
  const names = seedChatProfilesFromText(
    (getContext()?.chat ?? [])
      .slice(-6)
      .map(message => message?.mes ?? '')
      .join('\n'),
    currentFloor.value,
  );
  if (names.length) toastr.success(`已为 ${names.join('、')} 建立本聊天档案`, 'YG 插图师');
  else toastr.info('正文里没有命中任何档案库关键词', 'YG 插图师');
}

/* ============ 历史与回滚 ============ */

function fieldLabel(field: ChatProfileChange['field']): string {
  if (field === 'new') return '建档';
  if (field === 'raw') return '整串';
  if (field === 'nl') return '自然语言';
  if (field === 'kw') return '关键词';
  if (field === 'state') return '此刻状态';
  if (field === 'mine') return '我追加的提示词';
  return CHAR_TAG_FIELD_LABELS[field];
}

function askRollback(record: ChatProfileChange) {
  if (!editingName.value) return;
  pendingRollback.value = { name: editingName.value, record };
  confirmRollbackOpen.value = true;
}

function confirmRollback() {
  confirmRollbackOpen.value = false;
  const pending = pendingRollback.value;
  pendingRollback.value = null;
  if (!pending) return;
  if (rollbackChatProfile(pending.name, pending.record)) {
    toastr.success(`已回滚「${pending.name}」的${fieldLabel(pending.record.field)}变更`, 'YG 插图师');
  } else {
    toastr.warning('回滚失败:条目可能已删除', 'YG 插图师');
  }
}

/* ============ 生命周期 ============ */

// 页面打开时按当前聊天重读一遍:切聊天后 chatMetadata 已经换了,不重读会显示上一场的人。
hydrateChatProfiles();
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">角色档案</h2>
      <div class="yg-char-tools">
        <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="addEntry('book')">
          <Icon name="plus" /> 创建·档案库角色
        </button>
        <button class="bbi-btn bbi-btn-sm" type="button" @click="addEntry('chat')">
          <Icon name="plus" /> 创建·本聊天角色档案
        </button>
        <input v-model="filter" class="bbi-input yg-char-filter" placeholder="按名字或关键词筛选" />
      </div>
    </div>
    <hr class="bbi-rule" />

    <p class="bbi-field-hint">
      档案库是你自己塞角色用的模板,<strong>只有你能改,AI 只读</strong>。每个角色带一串触发关键词:本聊天的正文里提到任意一个,
      就会从档案库复制一份<strong>本聊天角色档案</strong>,之后由 AI 读剧情持续更新;出图时角色层的词就实时从那份档案取。
    </p>

    <!-- ===== 出图时角色层会发出去什么 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <span class="bbi-field-label">此刻角色层会发出的词(实时)</span>
        <span class="bbi-count">{{ livePromptRows.length }} 个在场</span>
      </div>
      <ul v-if="livePromptRows.length" class="yg-live-rows">
        <li v-for="row in livePromptRows" :key="row.name" class="yg-live-row">
          <span class="bbi-char-name">{{ row.name }}</span>
          <span v-if="row.from === 'book'" class="bbi-chip is-kw" title="本聊天还没建档,这里发的是档案库初始外貌">档案库兜底</span>
          <code class="yg-live-tag">{{ row.tag }}</code>
        </li>
      </ul>
      <p v-else class="bbi-char-empty">
        这一段现在为空:最近几楼没有提到任何档案库角色,模型这一楼也没写出角色 tag。
        先去档案库加一个角色、填上关键词(例如她的名字),正文里一提到就会自动建本聊天档案。
      </p>
      <p class="bbi-field-hint">
        取词口径:模型在 tag/nl 里写了名字 → 本楼正文命中关键词 → 上一楼在场者。一个都没认出就只发通用常驻词(宁可少带人,不把别人的衣服穿错)。
      </p>
    </div>

    <!-- ===== 档案库 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !bookFoldable }"
          :disabled="!bookFoldable"
          :aria-expanded="bookShown"
          :title="bookFoldable ? (bookShown ? '收起档案库' : '展开档案库') : ''"
          @click="toggleFold('book')"
        >
          <Icon v-if="bookFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !bookShown }" />
          <span class="bbi-field-label">档案库</span>
          <span v-if="bookFoldable" class="bbi-count">{{ profileBook.entries.length }}</span>
        </button>

      </div>
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !bookShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            跨所有聊天共用。填了「触发关键词」就按关键词命中(昵称、称号、职业都行);不填时角色名本身就是触发词。
          </p>
          <ul v-if="bookEntries.length" class="bbi-char-grid">
            <li v-for="entry in bookEntries" :key="entry.name" class="bbi-char-card">
              <button class="bbi-char-card-btn" type="button" @click="openBookEntry(entry)">
                <span class="bbi-char-card-head">
                  <span class="bbi-char-name">{{ entry.name }}</span>
                  <span class="bbi-char-pills">
                    <button
                      class="bbi-icon-mini yg-pill-x"
                      type="button"
                      title="从档案库删除"
                      @click="askRemoveBook(entry)"
                    >
                      <Icon name="trash" />
                    </button>
                  </span>
                </span>
                <span class="bbi-char-keywords">
                  <span v-for="keyword in entry.keywords" :key="keyword" class="bbi-chip is-kw">{{ keyword }}</span>
                </span>
                <span v-if="chipsOf(entry).length" class="bbi-char-chips">
                  <span v-for="chip in chipsOf(entry)" :key="chip.label" class="bbi-chip" :title="chip.label">
                    {{ chip.value }}
                  </span>
                </span>
                <span v-else class="bbi-char-raw">{{ entry.raw || '(没有外貌字段)' }}</span>
              </button>
            </li>
          </ul>
          <p v-else class="bbi-char-empty">
            档案库还是空的。点右上角「+」把常用角色连同触发关键词塞进来 —— 之后换任何聊天都不用重填。
          </p>
        </div>
      </div>
    </div>

    <!-- ===== 本聊天角色档案 ===== -->
    <div class="bbi-char-section">
      <div class="bbi-char-section-head">
        <button
          class="bbi-fold-head"
          type="button"
          :class="{ 'is-static': !chatFoldable }"
          :disabled="!chatFoldable"
          :aria-expanded="chatShown"
          :title="chatFoldable ? (chatShown ? '收起本聊天档案' : '展开本聊天档案') : ''"
          @click="toggleFold('chat')"
        >
          <Icon v-if="chatFoldable" name="chevron" class="bbi-fold-caret" :class="{ 'is-collapsed': !chatShown }" />
          <span class="bbi-field-label">本聊天角色档案</span>
          <span v-if="chatFoldable" class="bbi-count">{{ chatProfiles.entries.length }}</span>
        </button>

      </div>
      <div class="bbi-fold-wrap" :class="{ 'is-collapsed': !chatShown }">
        <div class="bbi-fold-inner">
          <p class="bbi-field-hint">
            只属于这个聊天,由 AI 读正文后更新;每条变更都能在这里看到并回滚。档案库那份永远不会被它改动。
          </p>

          <div v-if="pendingSeed.length" class="bbi-channel-bar">
            <span class="bbi-field-label">
              正文里提到了 {{ pendingSeed.map(entry => entry.name).join('、') }},还没建档
            </span>
            <button class="bbi-btn bbi-btn-sm" type="button" @click="seedNow">现在播种</button>
          </div>

          <ul v-if="chatRows.length" class="bbi-char-grid">
            <li v-for="entry in chatRows" :key="entry.name" class="bbi-char-card">
              <button class="bbi-char-card-btn" type="button" @click="openChatEntry(entry)">
                <span class="bbi-char-card-head">
                  <span class="bbi-char-name">{{ entry.name }}</span>
                  <span class="bbi-char-pills">
                    <span v-if="presentNow.has(entry.name)" class="bbi-char-pill is-ai">在场</span>
                    <span class="bbi-char-pill" :class="entry.by === 'ai' ? 'is-book' : 'is-chat'">
                      {{ entry.by === 'ai' ? 'AI 更新' : entry.by === 'manual' ? '手动' : '播种' }}
                    </span>
                    <span
                      v-if="entry.history.length"
                      class="bbi-char-history-badge"
                      :title="`${entry.history.length} 条变更记录`"
                    >
                      <Icon name="history" />{{ entry.history.length }}
                    </span>
                    <button
                      class="bbi-icon-mini yg-pill-x"
                      type="button"
                      title="删除本聊天档案"
                      @click="askRemoveChat(entry, $event)"
                    >
                      <Icon name="trash" />
                    </button>
                  </span>
                </span>
                <span v-if="chipsOf(entry).length" class="bbi-char-chips">
                  <span v-for="chip in chipsOf(entry)" :key="chip.label" class="bbi-chip" :title="chip.label">
                    {{ chip.value }}
                  </span>
                </span>
                <span v-else class="bbi-char-raw">{{ entry.raw }}</span>
              </button>
              <div class="yg-chat-card-foot">
                <span class="bbi-char-history-meta">
                  {{ entry.floor >= 0 ? `第${entry.floor}楼建档` : '手动建档' }}
                  <template v-if="entry.matched.length"> · 命中 {{ entry.matched.join(' / ') }}</template>
                </span>
                <button class="bbi-btn bbi-btn-sm" type="button" title="按档案库初始值覆盖" @click="askReseed(entry, $event)">
                  重新播种
                </button>
              </div>
            </li>
          </ul>
          <p v-else class="bbi-char-empty">
            本聊天还没有档案。等正文提到档案库里的关键词会自动建;也可以点右上角「+」直接建一份。
          </p>
        </div>
      </div>
    </div>

    <!-- ===== 编辑弹窗 ===== -->
    <ModalMask :open="!!draft" @close="closeEntry">
      <div v-if="draft" class="bbi-modal bbi-char-modal" role="dialog" aria-modal="true" aria-label="编辑角色档案">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingName ? '编辑' : '添加' }}
            <span class="bbi-char-pill" :class="draftScope === 'book' ? 'is-chat' : 'is-book'">
              {{ draftScope === 'book' ? '档案库' : '本聊天档案' }}
            </span>
          </span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closeEntry"><Icon name="close" /></button>
        </header>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">角色名</span>
          <input v-model="draft.name" class="bbi-input" placeholder="与正文/角色卡里的名字一致" />
        </label>
        <span class="bbi-field-hint">AI 引用时用这个名字(改名字不会自动改名到本聊天档案,建议同一角色两边同名)。</span>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">触发关键词</span>
          <input v-model="draft.keywords" class="bbi-input" placeholder="逗号分隔,如 小雪, 学姐, 小雪乃" />
        </label>
        <span class="bbi-field-hint">
          本聊天正文出现任意一个关键词 → 自动把本角色建成「本聊天档案」。留空则角色名本身当关键词。
        </span>

        <div class="bbi-modal-field">
          <span class="bbi-modal-label">口语描述 → 自动转化</span>
          <BbiTextarea
            v-model="profileText"
            :rows="3"
            :max-rows="8"
            placeholder="用大白话写,越细越好:银灰长发扎成低马尾、红色眼睛,戴一条细银链,白衬衫外面套黑色开衫,黑色蕾丝内裤,过膝白袜配玛丽珍鞋"
          />
          <div class="bbi-char-convert">
            <button class="bbi-btn" type="button" :disabled="converting" @click="convertDraft">
              <Icon name="sparkles" /> {{ converting ? '转化中…' : '自动转化为提示词' }}
            </button>
            <span class="bbi-field-hint">
              调一次模型:把这段口语拆进下面的格子(饰品按部位、着装按槽位)。**只填模型真的写了的格子**,你手填的内容不会被清掉。
            </span>
          </div>
        </div>

        <div v-for="group in FIELD_GROUPS" :key="group.title" class="bbi-modal-field">
          <span class="bbi-modal-label">{{ group.title }}</span>
          <div class="bbi-char-form">
            <label
              v-for="field in group.fields"
              :key="field"
              class="bbi-char-form-row"
              :class="{ 'is-wide': field === 'outfit' || field === 'special' }"
            >
              <span class="bbi-char-form-label">{{ CHAR_TAG_FIELD_LABELS[field] }}</span>
              <input v-model="draft.fields[field]" class="bbi-input" :placeholder="CHAR_TAG_FIELD_HINTS[field]" />
            </label>
          </div>
          <span class="bbi-field-hint">{{ group.hint }}</span>
        </div>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">整串模式(可选)</span>
          <BbiTextarea
            v-model="draft.raw"
            :rows="2"
            :max-rows="6"
            mono
            placeholder="留空则用上面的字段拼接;整串优先于字段"
          />
        </label>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">自然语言外貌(可选,NAI 用)</span>
          <BbiTextarea
            v-model="draft.nl"
            :rows="2"
            :max-rows="4"
            mono
            placeholder="一句连贯的英文外貌描述,NAI 4.5/V5 建档时的 nl"
          />
        </label>

        <label v-if="draftScope === 'chat'" class="bbi-modal-field">
          <span class="bbi-modal-label">此刻状态(本聊天档案)</span>
          <BbiTextarea
            v-model="draft.state"
            :rows="2"
            :max-rows="6"
            mono
            placeholder="这一刻的穿戴与身体状态:black lace dress, off shoulder, bare legs, wet hair"
          />
          <span class="bbi-field-hint">
            AI 每楼按正文自动改写这一格(换装、弄湿、受伤、怀孕、化妆都写这里),写进角色层时排在固定外貌之后、并替换掉档案里同类的穿戴词。留空 = 这一楼按正文自己定。
          </span>
        </label>

        <label v-if="draftScope === 'chat'" class="bbi-modal-field">
          <span class="bbi-modal-label">我追加的提示词(不影响 AI 更新)</span>
          <BbiTextarea
            v-model="draft.mine"
            :rows="2"
            :max-rows="6"
            mono
            placeholder="想让她永远带着的东西,例如 always wearing a silver pendant, mole under left eye"
          />
          <span class="bbi-field-hint">
            这一格只属于你:AI 每楼照常改写外貌字段与「此刻状态」,但永远不动这里。它排在固定外貌之后拼进角色层,不会因为换装被顶掉;清空即失效。
          </span>
        </label>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">人设备注(可选)</span>
          <BbiTextarea
            v-model="draft.desc"
            :rows="2"
            :max-rows="4"
            placeholder="给 AI 当建档依据的一句话,不进 CLIP"
          />
        </label>

        <label v-if="draftScope === 'book'" class="bbi-switch-row">
          <span class="bbi-field-label">参与关键词匹配</span>
          <input v-model="draft.enabled" type="checkbox" class="bbi-checkbox" />
        </label>

        <div class="bbi-char-preview">
          <span class="bbi-field-label">最终 tag 预览</span>
          <code class="bbi-char-preview-tag">{{ draftTag || '(空)' }}</code>
        </div>

        <div v-if="editingHistory.length" class="bbi-char-history">
          <button class="bbi-char-history-toggle" type="button" @click="historyOpen = !historyOpen">
            <span class="bbi-char-history-caret" :class="{ 'is-open': historyOpen }"><Icon name="chevron" /></span>
            变更历史({{ editingHistory.length }})
          </button>
          <ul v-if="historyOpen" class="bbi-char-history-list">
            <li v-for="(record, i) in [...editingHistory].reverse()" :key="i" class="bbi-char-history-item">
              <div class="bbi-char-history-main">
                <span class="bbi-char-history-field">{{ fieldLabel(record.field) }}</span>
                <span class="bbi-char-history-change">
                  <template v-if="record.from">{{ record.from }} → {{ record.to }}</template>
                  <template v-else>{{ record.to }}</template>
                </span>
                <span v-if="record.reason" class="bbi-char-history-reason">{{ record.reason }}</span>
                <span class="bbi-char-history-meta">
                  {{ record.floor >= 0 ? `第${record.floor}楼` : '手动' }}·{{ new Date(record.at).toLocaleString() }}
                </span>
              </div>
              <button class="bbi-btn bbi-btn-sm" type="button" title="把该字段回滚到变更前的值" @click="askRollback(record)">
                回滚
              </button>
            </li>
          </ul>
        </div>

        <footer class="bbi-modal-foot">
          <button v-if="editingName" class="bbi-btn bbi-btn-danger" type="button" @click="askRemove">
            <Icon name="trash" /> 删除
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button
            class="bbi-btn"
            type="button"
            title="读取柏宝书最新状态里该角色的外貌,重新转换成字段"
            :disabled="regenerating"
            @click="regenerateFromBook"
          >
            <Icon name="refresh" /> {{ regenerating ? '生成中…' : '从柏宝书生成' }}
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmEntry">完成</button>
        </footer>

        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="删除角色档案"
          confirm-text="删除"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemove"
        >
          <template v-if="draftScope === 'book'">
            从档案库删除「{{ editingName }}」?已经建好的本聊天档案不受影响,但换新聊天时不会再自动播种。
          </template>
          <template v-else>
            删除「{{ editingName }}」的本聊天档案?下次正文再提到关键词会重新从档案库播种。
          </template>
        </ConfirmDialog>
      </div>
    </ModalMask>

    <ConfirmDialog
      v-model:open="confirmRollbackOpen"
      title="回滚变更"
      confirm-text="回滚"
      tone="danger"
      top-layer
      @confirm="confirmRollback"
    >
      <template v-if="pendingRollback">
        把「{{ pendingRollback.name }}」的「{{ fieldLabel(pendingRollback.record.field) }}」从
        <code>{{ pendingRollback.record.to }}</code> 回滚到
        <code>{{ pendingRollback.record.from || '(空)' }}</code> ?
        建档记录的回滚会删除整个条目。
      </template>
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbi-count {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

.yg-char-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}
.yg-char-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.yg-char-filter {
  width: 220px;
}

.bbi-char-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}
.bbi-char-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.bbi-fold-head {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.bbi-fold-head.is-static {
  cursor: default;
}
.bbi-fold-caret {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
  transition: transform 0.2s var(--bbi-ease), color 0.15s;
}
.bbi-fold-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbi-fold-head:hover:not(.is-static) .bbi-fold-caret,
.bbi-fold-head:focus-visible .bbi-fold-caret {
  color: var(--bbi-accent);
}

.bbi-fold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s var(--bbi-ease);
}
.bbi-fold-wrap.is-collapsed {
  grid-template-rows: 0fr;
}
.bbi-fold-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bbi-add-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbi-add-mini:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-empty {
  margin: 0;
  padding: 14px 16px;
  border: 1px dashed var(--bbi-line);
  border-radius: var(--bbi-radius);
  color: var(--bbi-ink-muted);
  font-size: 12.5px;
}

.bbi-char-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
.bbi-char-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bbi-char-card-btn {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    box-shadow var(--bbi-dur) var(--bbi-ease),
    transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-card-btn:hover {
  border-color: var(--bbi-accent);
  box-shadow: 0 8px 20px -12px var(--bbi-overlay);
  transform: translateY(-1px);
}
.bbi-char-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.bbi-char-name {
  font-size: 15px;
  font-weight: 600;
  word-break: break-word;
  min-width: 0;
}
.bbi-char-pills {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.bbi-char-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface-2);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
.bbi-char-pill.is-chat {
  color: var(--bbi-ink-soft);
}
.bbi-char-pill.is-book,
.bbi-char-pill.is-ai {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}

.bbi-char-keywords {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.bbi-char-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 52px;
  overflow: hidden;
}
.bbi-chip {
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  padding: 3px 9px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
.bbi-chip.is-kw {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
  background: transparent;
}
.bbi-char-raw {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.bbi-char-history-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  color: var(--bbi-ink-muted);
}

.bbi-char-modal {
  max-width: 600px;
}

.bbi-char-convert {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.bbi-char-convert .bbi-field-hint {
  flex: 1 1 220px;
  margin: 0;
}

.bbi-char-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 12px;
}
.bbi-char-form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.bbi-char-form-row.is-wide {
  grid-column: 1 / -1;
}
.bbi-char-form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink-soft);
}

.bbi-char-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-char-history-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  border: 0;
  background: none;
  padding: 2px 6px;
  color: var(--bbi-ink-muted);
  font-size: 12px;
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  border-radius: var(--bbi-radius-sm);
}
.bbi-char-history-toggle:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-char-history-caret {
  display: inline-flex;
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-history-caret.is-open {
  transform: rotate(180deg);
}
.bbi-char-history-list {
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 240px;
  overflow-y: auto;
}
.bbi-char-history-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.bbi-char-history-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.bbi-char-history-field {
  font-size: 11px;
  font-weight: 600;
  color: var(--bbi-accent);
}
.bbi-char-history-change {
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}
.bbi-char-history-reason {
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
.bbi-char-history-meta {
  font-size: 11px;
  color: var(--bbi-ink-muted);
}

.bbi-char-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.bbi-char-preview-tag {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}

.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 13px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.yg-pill-x {
  width: 24px;
  height: 24px;
}

.bbi-modal-foot {
  flex-wrap: wrap;
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

/* 此刻会发出的词:一行 = 名字 + 该角色的 tag 串 */
.yg-live-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.yg-live-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.yg-live-tag {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink);
  word-break: break-word;
}

.yg-chat-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px;
}

@media (max-width: 640px) {
  .bbi-char-grid {
    grid-template-columns: 1fr;
  }
  .bbi-char-form {
    grid-template-columns: 1fr;
  }
  .bbi-char-name {
    font-size: 14px;
  }
  .yg-char-filter {
    width: 100%;
  }
}
</style>
