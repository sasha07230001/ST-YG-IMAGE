<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import PromptSendPreview from '@/components/PromptSendPreview.vue';
import Icon from '@/components/Icon.vue';
import Collapsible from '@/components/Collapsible.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import { composePositiveLayers, simpleDefaults, templateSupportsNegative, type ComfySimpleConfig } from '@/backends/comfyTemplates';
import {
  LAYER_LABELS,
  LAYER_ORDER,
  buildNegativeLayers,
  normalizeLayerOrder,
  type PromptLayerId,
} from '@/backends/promptLayers';
import { activeComfyPreset } from '@/state/settings';
import type { ImageCharacterPrompt } from '@/autoTag/protocol';

/**
 * 「发送预览」页 —— 三层提示词的试衣间。
 *
 * 它要回答的问题只有一个:**这一次出图,送进 ComfyUI 正面提示词框的到底是哪一串?**
 *
 * 为什么单独开一页而不是塞在渠道页里:
 * 1. 拼装结果跨三个来源(渠道页的固定正面、角色管理页的档案、这一楼的正文编译结果),
 *    任何单页都只能看到自己那一格,用户得来回翻三页才能拼出全貌;
 * 2. 调词是反复试的活,试的时候不该改动线上配置——所以这一页所有输入都是**草稿**,
 *    唯一的写入口是「存回渠道页」按钮,且明确指出会覆盖哪一格;
 * 3. 它还兼作回归工具:分层、去重、预算三个开关的可见效果在这里一眼就能比出来,
 *    不用真跑一次出图去猜。
 *
 * 数据来源有三条路:从当前渠道预设拉、手填、或完全恢复默认。默认拉一次当前预设,
 * 这样打开页面看到的就是「现在真会发的东西」,而不是一张空表。
 */

const preset = activeComfyPreset();

const current = computed(() => preset.simple);
const isSimple = computed(() => preset.mode === 'simple');

/** 这一页的全部输入都是草稿:改到满意再存,避免调词时把线上配置搅乱。 */
const draftFixed = ref(current.value.positive ?? '');
const draftNegative = ref(current.value.negative ?? '');
/** 本图排除词(动态负面)的草稿。出图时由 AI 按正文编译,这里填示例方便试。 */
const draftNegativeDynamic = ref('extra people, duplicate character');
const draftStory = ref('1girl, silver hair, red eyes, standing in the rain');
const draftStoryNl = ref('');
const draftCharacters = ref<ImageCharacterPrompt[]>([]);

/** 当前架构吃不吃负面。Flux 系恒不吃,预览要如实说明这一格填了也白填。 */
const negativeSupported = computed(() => templateSupportsNegative(current.value.template));

/** 拼接规则也先在本地改,同样靠「存回」按钮落地。 */
const local = ref<ComfySimpleConfig>({ ...current.value });

/**
 * 层顺序。`local.layerOrder` 是老配置里可能没有的键,用 normalize 补齐后再持有,
 * 免得模板里 v-for 拿到 undefined。
 */
const layerOrder = computed<PromptLayerId[]>({
  get: () => normalizeLayerOrder(local.value.layerOrder),
  set: value => {
    local.value = { ...local.value, layerOrder: normalizeLayerOrder(value) };
  },
});

/** 「固定正面(第 N 层)」——N 随拖动变,标题不能写死。 */
function ordinal(id: PromptLayerId): number {
  return layerOrder.value.indexOf(id) + 1;
}

/** 拖动中的层,及悬停目标层。 */
const dragLayer = ref<PromptLayerId | null>(null);
const overLayer = ref<PromptLayerId | null>(null);

function onLayerDragStart(id: PromptLayerId, event: DragEvent) {
  dragLayer.value = id;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  }
}

function onLayerDragOver(id: PromptLayerId, event: DragEvent) {
  if (!dragLayer.value) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  overLayer.value = id;
}

/** 松手:把被拖的层插到目标位置(插入位移,不是交换)。 */
function onLayerDrop(target: PromptLayerId) {
  const from = dragLayer.value;
  dragLayer.value = null;
  overLayer.value = null;
  if (!from || from === target) return;
  const next = layerOrder.value.filter(id => id !== from);
  const at = next.indexOf(target);
  next.splice(at < 0 ? next.length : at, 0, from);
  layerOrder.value = next;
}

function onLayerDragEnd() {
  dragLayer.value = null;
  overLayer.value = null;
}

/** 把固定正面挪回最前。CLIP 对越靠前越敏感,这是唯一值得一键纠正的顺序。 */
function restoreDefaultOrder() {
  layerOrder.value = [...LAYER_ORDER];
}

/** 固定正面不在首位时的提醒(不硬拦,只提示)。 */
const fixedNotFirst = computed(() => layerOrder.value[0] !== 'fixed');

/** 空中转站/内置链时,tag 正文之外可能还带自然语言段;这里如实展示哪一段会被用。 */
const effectiveCharacters = computed(() =>
  draftCharacters.value.filter(
    character => character.name?.trim() || character.tag?.trim() || character.nl?.trim(),
  ),
);

const defaultCharacters: ImageCharacterPrompt[] = [
  { name: '綾瀬', tag: 'silver hair, red eyes, long hair', nl: '' },
];

/** 空角色表时给一份示例,让用户直接看到角色层长什么样,而不用先手打。 */
function loadSampleCharacters() {
  draftCharacters.value = defaultCharacters.map(c => ({ ...c }));
}

function addCharacter() {
  draftCharacters.value = [
    ...draftCharacters.value,
    { name: `角色 ${draftCharacters.value.length + 1}`, tag: '', nl: '' },
  ];
}

function removeCharacter(index: number) {
  draftCharacters.value = draftCharacters.value.filter((_, i) => i !== index);
}

/** 统计格:一眼看出「有没有被砍」。 */
const stats = computed(() => {
  const result = composePositiveLayers(local.value, {
    prompt: draftStory.value,
    nl: draftStoryNl.value,
    characters: effectiveCharacters.value,
    characterTag: effectiveCharacters.value
      .map(c => c.tag?.trim())
      .filter(Boolean)
      .join(', '),
    // 预览不真的出图,尺寸只为满足 SimpleGenValues 的形状;占位符替换用不到
    seed: 0,
    width: 0,
    height: 0,
  });
  return result;
});

/** 负面的统计:与正向分开展示,因为两边的坑不同(正面怕超长,负面怕被挤掉)。 */
const negStats = computed(() =>
  buildNegativeLayers(
    { builtin: draftNegative.value, dynamic: draftNegativeDynamic.value },
    {
      separator: local.value.layerSeparator || ', ',
      dedupe: local.value.dedupeTags !== false,
      budget: 0,
    },
  ),
);

/** 与渠道页已保存的值比对,提醒「这页看到的和线上不一样」。 */
const drift = computed(() => {
  const saved = current.value;
  const diff: string[] = [];
  if ((saved.positive ?? '') !== draftFixed.value) diff.push('固定正面');
  if ((saved.negative ?? '') !== draftNegative.value) diff.push('固定负面');
  if ((saved.layered !== false) !== (local.value.layered !== false)) diff.push('分层开关');
  if ((saved.layerSeparator || ', ') !== (local.value.layerSeparator || ', ')) diff.push('层间连接符');
  if ((saved.dedupeTags !== false) !== (local.value.dedupeTags !== false)) diff.push('去重');
  if ((saved.tagBudget || 0) !== (local.value.tagBudget || 0)) diff.push('tag 预算');
  return diff;
});

const savedFlash = ref('');
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function flash(text: string) {
  savedFlash.value = text;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (savedFlash.value = ''), 2000);
}

/** 写回渠道页:只覆盖固定正面/负面与三条拼接规则,不动模型、采样、工作流。 */
function saveToPreset() {
  const target = preset.simple;
  target.positive = draftFixed.value;
  target.negative = draftNegative.value;
  target.layered = local.value.layered !== false;
  target.layerSeparator = local.value.layerSeparator || ', ';
  target.dedupeTags = local.value.dedupeTags !== false;
  target.tagBudget = Math.max(0, Math.round(local.value.tagBudget || 0));
  flash('已存回渠道页的当前工作流预设');
}

/** 从渠道页拉回(用户可能在别处改过)。 */
function pullFromPreset() {
  draftFixed.value = current.value.positive ?? '';
  draftNegative.value = current.value.negative ?? '';
  local.value = { ...current.value };
  flash('已从渠道页重新拉取');
}

function resetDefaults() {
  const base = simpleDefaults(current.value.template);
  local.value = { ...local.value, ...base, positive: local.value.positive, negative: local.value.negative };
  flash('拼接规则已恢复默认');
}

/** 首次进入时把角色表填成示例,免得两列里右半边空着看不出效果。 */
if (!draftCharacters.value.length) loadSampleCharacters();

watch(
  () => preset.id,
  () => {
    draftFixed.value = current.value.positive ?? '';
    draftNegative.value = current.value.negative ?? '';
    local.value = { ...current.value };
  },
);
</script>

<template>
  <section class="bbi-page">
    <header class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">发送预览</h2>
      <p class="bbi-page-intro">
        把「固定正面 → 角色 → 剧情」三层按顺序摊开,看清楚最后送进 ComfyUI 正面提示词框的那一串。
        左边改草稿,右边实时重算;满意了再点「存回渠道页」——调词过程不会动线上配置。
      </p>
    </header>

    <p v-if="!isSimple" class="pv-warn">
      <Icon name="bolt" :size="14" />
      当前工作流「{{ preset.name }}」是 <strong>custom</strong> 模式:工作流里只有 <code>%prompt%</code>
      一个占位符,固定正面与角色层没有位置。要先在「渠道」页把它切成「简易模式」,三层拼接才会生效。
    </p>

    <div class="pv-grid">
      <div class="pv-col">
        <Collapsible :title="`固定正面(第 ${ordinal('fixed')} 层)`" :open="true">
          <BbiTextarea v-model="draftFixed" :rows="4" placeholder="masterpiece, best quality, 画风词…" />
          <p class="bbi-field-hint">
            抢在最前最安全:CLIP 对越靠前的 token 越敏感,不少工作流只吃前 75 个 token。
            这一格与渠道页的「固定正面」是同一份数据,改完记得存回。
          </p>
        </Collapsible>

        <Collapsible :title="`角色(第 ${ordinal('character')} 层)`" :open="true">
          <div
            v-for="(character, index) in draftCharacters"
            :key="index"
            class="pv-char"
          >
            <div class="pv-char-head">
              <input v-model="character.name" class="bbi-input pv-char-name" type="text" placeholder="角色名" />
              <button class="bbi-btn bbi-btn-sm" type="button" @click="removeCharacter(index)">
                <Icon name="trash" :size="12" />
              </button>
            </div>
            <BbiTextarea v-model="character.tag" :rows="2" placeholder="appearance tags:silver hair, red eyes, school uniform" />
          </div>
          <div class="pv-char-ops">
            <button class="bbi-btn bbi-btn-sm" type="button" @click="addCharacter">
              <Icon name="plus" :size="12" /> 加一个角色
            </button>
            <button class="bbi-btn bbi-btn-sm" type="button" @click="loadSampleCharacters">
              <Icon name="sparkles" :size="12" /> 填示例
            </button>
          </div>
          <p class="bbi-field-hint">
            出图时这一层由「角色管理」页的固定外貌库 + 当楼临时提示词自动合成;
            这里填的是试衣稿,只影响预览。
          </p>
        </Collapsible>

        <Collapsible :title="`剧情(第 ${ordinal('story')} 层)`" :open="true">
          <BbiTextarea v-model="draftStory" :rows="4" placeholder="模型编译出的画面 tag…" />
          <p class="bbi-field-hint">
            出图时这一格来自「提示词」页那条链(内置 LLM 分析或中转站编译)对本楼正文的编译结果。
          </p>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">自然语言段(可选)</span></div>
            <BbiTextarea v-model="draftStoryNl" :rows="2" placeholder="正文式的自然语言描述,开启后优先于上面的 tag" />
          </div>
        </Collapsible>

        <!--
          负面:与正面并列成两段(不是第四层)。
          固定负面是用户自己定的基线,本图排除是 AI 每张都换的;谁被谁挤掉必须看得见。
        -->
        <Collapsible :title="negativeSupported === false ? '负面(本架构不支持)' : '负面'" :open="true">
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">固定负面</span></div>
            <BbiTextarea
              v-model="draftNegative"
              :rows="3"
              placeholder="worst quality, low quality, lowres, bad anatomy, bad hands, watermark…"
            />
            <p class="bbi-field-hint">
              就是渠道页「固定负面」那一格。永远发在最前,不会被本图排除词挤掉。
            </p>
          </div>

          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">本图排除(动态)</span></div>
            <BbiTextarea
              v-model="draftNegativeDynamic"
              :rows="2"
              placeholder="extra people, duplicate character…"
            />
            <p class="bbi-field-hint">
              出图时由 AI 按本楼正文编译,只排除与正文冲突或本构图容易误生成的内容,可为空。
              这里填的是试衣稿,只影响预览。
            </p>
          </div>

          <p v-if="negativeSupported === false" class="bbi-field-hint pv-order-warn">
            当前架构(Flux 系)没有真实负面输入:这两格填了也不会进工作流。
          </p>
          <p v-else class="bbi-field-hint">
            两段合并顺序固定为「固定负面 → 本图排除」,与正向的层顺序无关 ——
            负面两段谁先谁后对采样没有差别,能拖反而让人以为有区别。
          </p>
        </Collapsible>

        <Collapsible title="拼接规则" :open="true">
          <label class="bbi-switch-row">
            <span class="bbi-field-label">开启三层拼接</span>
            <input v-model="local.layered" type="checkbox" class="bbi-checkbox" />
          </label>
          <p class="bbi-field-hint">
            关掉就回到旧口径:只发「固定正面 + 剧情」,角色提示词不进 CLIP(与 0.5.0 之前一致)。
          </p>

          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">层间连接符</span></div>
            <select v-model="local.layerSeparator" class="bbi-input">
              <option value=", ">逗号 + 空格　,</option>
              <option value="、">顿号　、</option>
              <option value="&#10;">换行</option>
            </select>
          </div>

          <label class="bbi-switch-row">
            <span class="bbi-field-label">跨层去重(保先出现的那层)</span>
            <input v-model="local.dedupeTags" type="checkbox" class="bbi-checkbox" />
          </label>
          <p class="bbi-field-hint">
            固定正面已写过的词,角色层与剧情层不再重复。权重写法 <code>(silver hair:1.2)</code>
            与 <code>silver_hair</code> 会被认成同一个词。
          </p>

          <div class="bbi-num-row">
            <span class="bbi-field-label">tag 预算</span>
            <input v-model.number="local.tagBudget" class="bbi-input bbi-num" type="number" min="0" max="400" step="5" />
          </div>
          <p class="bbi-field-hint">0 = 不限。超了从末层末尾往前砍,固定正面永远保得住。</p>

          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">层顺序</span>
              <button class="bbi-btn bbi-btn-sm" type="button" @click="restoreDefaultOrder">
                恢复默认
              </button>
            </div>
            <ol class="pv-order">
              <li
                v-for="id in layerOrder"
                :key="id"
                class="pv-order-item"
                :class="{
                  'is-dragging': dragLayer === id,
                  'is-over': overLayer === id && dragLayer !== id,
                  'is-first': id === 'fixed',
                }"
                draggable="true"
                @dragstart="onLayerDragStart(id, $event)"
                @dragover="onLayerDragOver(id, $event)"
                @dragleave="overLayer = null"
                @drop.prevent="onLayerDrop(id)"
                @dragend="onLayerDragEnd"
              >
                <span class="pv-order-grip" aria-hidden="true">⋮⋮</span>
                <span class="pv-order-num">{{ layerOrder.indexOf(id) + 1 }}</span>
                <span class="pv-order-name">{{ LAYER_LABELS[id] }}</span>
              </li>
            </ol>
          </div>
          <p v-if="fixedNotFirst" class="bbi-field-hint pv-order-warn">
            固定正面已不在最前。CLIP 对越靠前的 token 越敏感,画风词排到后面可能吃不到权重。
          </p>
          <p v-else class="bbi-field-hint">
            拖动可改顺序;跨层去重按「先出现的层保留」判定,顺序会反过来影响谁被吸收。
          </p>

          <div class="pv-ops">
            <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="saveToPreset">存回渠道页</button>
            <button class="bbi-btn bbi-btn-sm" type="button" @click="pullFromPreset">从渠道页拉取</button>
            <button class="bbi-btn bbi-btn-sm" type="button" @click="resetDefaults">规则恢复默认</button>
          </div>
          <p v-if="savedFlash" class="pv-flash">{{ savedFlash }}</p>
          <p v-if="drift.length" class="pv-drift">
            与渠道页已保存的不一样:{{ drift.join('、') }}
          </p>
        </Collapsible>
      </div>

      <div class="pv-col pv-col-right">
        <PromptSendPreview
          :config="local"
          :mode="isSimple ? 'simple' : 'custom'"
          :fixed="draftFixed"
          :story="draftStory"
          :story-nl="draftStoryNl"
          :characters="effectiveCharacters"
          :negative-builtin="draftNegative"
          :negative-dynamic="draftNegativeDynamic"
          :negative-supported="negativeSupported"
          title="这一次会发出去的"
        />

        <div class="pv-stats">
          <div class="pv-stat">
            <span class="pv-stat-num">{{ stats.tagCount }}</span>
            <span class="pv-stat-label">tag 总数</span>
          </div>
          <div class="pv-stat">
            <span class="pv-stat-num">{{ stats.chars }}</span>
            <span class="pv-stat-label">字符数</span>
          </div>
          <div class="pv-stat">
            <span class="pv-stat-num">{{ stats.droppedDuplicates }}</span>
            <span class="pv-stat-label">去重删掉</span>
          </div>
          <div class="pv-stat">
            <span class="pv-stat-num">{{ stats.droppedByBudget }}</span>
            <span class="pv-stat-label">预算砍掉</span>
          </div>
          <div class="pv-stat">
            <span class="pv-stat-num">{{ effectiveCharacters.length }}</span>
            <span class="pv-stat-label">角色层人数</span>
          </div>
        </div>

        <p class="pv-tip">
          <Icon name="bolt" :size="13" />
          提示:CLIP 的实际上限约 75 token。tag 总数超过 60 就该开预算,否则后面那截基本没起作用。
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pv-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 980px) {
  .pv-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.pv-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.pv-col-right {
  position: sticky;
  top: 8px;
}

.pv-warn {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line-strong);
  border-left: 3px solid var(--bbi-warn, #b8860b);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--bbi-ink);
}

.pv-char {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  margin-bottom: 8px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.pv-char-head {
  display: flex;
  gap: 6px;
  align-items: center;
}
.pv-char-name {
  flex: 1 1 auto;
  min-width: 0;
}
.pv-char-ops {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
}

/* 层顺序列表:每行是一层,拖动改插入位次 */
.pv-order {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.pv-order-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  cursor: grab;
  user-select: none;
  font-size: 12px;
}
.pv-order-item:active {
  cursor: grabbing;
}
.pv-order-item.is-first {
  border-color: var(--bbi-accent);
}
.pv-order-item.is-dragging {
  opacity: 0.45;
}
/* 插入位置提示:一条实心 accent 上边线,比整行高亮更能表达「插到这里」 */
.pv-order-item.is-over {
  box-shadow: inset 0 2px 0 var(--bbi-accent);
}
.pv-order-grip {
  color: var(--bbi-text-dim);
  letter-spacing: -2px;
}
.pv-order-num {
  width: 1.2em;
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: var(--bbi-text-dim);
}
.pv-order-name {
  flex: 1 1 auto;
  min-width: 0;
}
.pv-order-warn {
  color: var(--bbi-warn);
}

.pv-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.pv-flash {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--bbi-accent);
}

.pv-drift {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--bbi-warn, #b8860b);
}

.pv-stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}
.pv-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 4px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.pv-stat-num {
  font-size: 16px;
  font-weight: 600;
  color: var(--bbi-ink);
  font-variant-numeric: tabular-nums;
}
.pv-stat-label {
  font-size: 10.5px;
  color: var(--bbi-ink-soft);
  white-space: nowrap;
}

.pv-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px 0 0;
  font-size: 11.5px;
  color: var(--bbi-ink-soft);
}
</style>
