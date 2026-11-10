<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import {
  LAYER_LABELS,
  NEGATIVE_LAYER_HINTS,
  LAYER_HINTS,
  buildNegativeLayers,
  buildPromptLayers,
  type NegativeLayer,
  type NegativeLayerId,
  type PromptLayer,
  type PromptLayerId,
} from '@/backends/promptLayers';
import type { ComfySimpleConfig } from '@/backends/comfyTemplates';
import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import {
  chatProfiles,
  lastRememberedStory,
  listProfileBook,
  profileEntryTag,
  resolvePresentProfiles,
} from '@/state/charProfiles';
import { basePrompt, characterLayerText } from '@/state/characterPromptStore';
import { computed, ref } from 'vue';

/**
 * 发送预览:把「这次真正写进 ComfyUI 的那几段字」原样摊开给用户看。
 *
 * 这一版的取舍(0.7 重写):
 *
 * 1. **按出口组织,而不是按层组织**。旧版把三段和两段排成两个长列表,用户看完仍然
 *    不知道「哪一段真的进了 %prompt%、哪一段根本没发出去」——那正是他踩坑的地方。
 *    现在先给两个出口卡片(%prompt% / %negative_prompt%),每个卡片里再按层摊开,
 *    层就落在它真实去往的出口里。
 * 2. **出口是否真的存在要标出来**。工作流里没有 %negative_prompt% 时,负面填了也不会
 *    生效;旧版把这个说成「当前架构不支持」,误导用户去换模板。现在只陈述事实并提供
 *    一键复制,让用户自己往工作流里补那个占位符。
 * 3. **custom 模式不再降级**。0.7 起 custom 模式的三层也在 generate.ts 里合成后写进
 *    %prompt%,所以预览与简易模式同一口径,不再出现「custom · 仅正文」这种谜语。
 * 4. 拼接仍然只用 `buildPromptLayers` / `buildNegativeLayers` 一份实现 ——
 *    预览与真实发送必须逐字一致,各写一份的话面板显示 40 个 tag、实际发 37 个,
 *    用户永远查不出原因。
 *
 * 四个调用点(渠道页 / 发送预览页 / 编辑弹窗 / NAI 面板)传的字段各有缺省:
 *   - 渠道页:固定正面与固定负面取自当前工作流,剧情层用示例串说明;
 *   - 发送预览页:五格全手填,可自由试;
 *   - 编辑弹窗:拿当楼草稿,是最接近真实的一次;
 *   - NAI 面板:不吃 %negative_prompt%,由 `negativeInWorkflow` 关掉负面卡片。
 */
const props = defineProps<{
  /** 拼接规则来源(分隔符 / 去重 / 预算 / 顺序)。给 null 用默认口径。 */
  config?: ComfySimpleConfig | null;
  /** custom / simple 只影响文案(custom 的唯一出口是 %prompt%)。 */
  mode?: 'custom' | 'simple';
  fixed?: string;
  story?: string;
  storyNl?: string;
  characters?: ImageCharacterPrompt[];
  /** 已合成的角色档案串(常驻 + 临时),与 characters 一起构成角色层。 */
  characterTag?: string;
  /** 最终负面串(固定 + 动态)。传了 `negativeDynamic` 时以分层口径重算,覆盖这里。 */
  negative?: string;
  /** 固定负面(渠道页那一格)。给了它就走分层,能看出两段谁被挤掉。 */
  negativeBuiltin?: string;
  /** AI 动态负面(本图专用)。 */
  negativeDynamic?: string;
  /**
   * 负面会不会真的送达。false = 工作流里没有 %negative_prompt%(或 Flux 这类没有负面
   * 输入的后端),此时照常显示负面串,但标成「不会送达」而不是假装发送成功。
   */
  negativeSupported?: boolean;
  title?: string;
  /**
   * story 是写死的一句示例(渠道页内嵌的那份就是这样)。
   * 显式标出来,比靠正则猜「这串像不像示例」可靠 ——
   * 猜错的代价是拿示例去判在场,一个角色都认不出来。
   */
  storyIsExample?: boolean;
  /** 嵌在窄栏里时收紧留白。 */
  compact?: boolean;
}>();

const customMode = computed(() => props.mode === 'custom');

/**
 * 角色层取词的兜底:调用方没给 characterTag 时,按 characters[] 里点名的角色
 * 从**本聊天角色档案**实时取词(与 generate.ts 的 composeProfilesForPresent 同一口径)。
 * 这样预览页/编辑弹窗不传东西也能看到真实会发出去的角色串。
 *
 * 判在场的正文:优先用调用方给的 `story`(编辑弹窗给的是当楼草稿,最准);
 * 没给就用**最近一次真编译时选中的那段正文**(`lastRememberedStory`)。
 * 渠道页只能给一行示例串,拿示例去判在场是一个人都认不出来的 ——
 * 那正是「发送预览·角色 = 0 tag」的成因,不能靠让用户手填正文来绕过。
 */
/**
 * 判在场用的正文。调用方标了 storyIsExample 或干脆没给 story 时,
 * 落回「最近一次真编译时选中的那段正文」。
 */
const liveStoryHint = computed(() => {
  const story = String(props.story ?? '').trim();
  return props.storyIsExample || !story ? lastRememberedStory() : story;
});

const liveCharacterNames = computed(() =>
  resolvePresentProfiles({
    candidates: (props.characters ?? []).map(item => item.name),
    prompt: [liveStoryHint.value, props.storyNl ?? ''].join(' '),
    story: liveStoryHint.value,
  }),
);

/**
 * 角色层这一格**会不会真的发出东西**。判据与出图完全同源:
 * `characterLayerText()` 非空 = 这一层有内容。上一版预览自己判在场,
 * 于是出现「渠道页明明列着角色,预览却说 0 tag」——这里不再保留第二套判定。
 */
const liveCharacterFilled = computed(
  () => basePrompt.enabled && !!liveCharacterTag.value.trim(),
);

/**
 * 角色层取词:**直接问出图那一个函数** `characterLayerText()`,预览不再另算一遍在场。
 *
 * 这张表的每一行 `effective` 已经是「档案固定外貌 + 手写追加词 + 此刻穿戴」合成好的串,
 * 而 `characterLayerText()` 就是 `generate.ts` 出图时调的那一个 —— 界面上看见什么,
 * 发出去的就是什么。上一版预览自己按在场筛,于是出现「渠道页列着 1 个角色、
 * 预览说 0 tag」两套口径,用户根本没法判断哪个是真的。
 */
const liveCharacterTag = computed(() => {
  if (props.characterTag && String(props.characterTag).trim()) return props.characterTag;
  if (!basePrompt.enabled) return '';
  // 直接调出图那一个函数,预览不再另算一遍「谁在场」。
  return characterLayerText();
});
const layeredOn = computed(() => props.config?.layered !== false);
/**
 * 预览行:PromptLayer 加「这一层这次到底发不发」。
 *
 * 独立成 interface 而不是 `PromptLayer & {...}`:交叉类型在联合推断里会被拆成
 * 「干净层 | 带 skipped 层」两个成员,`computed<T>` 的泛型对不上就报 TS2769。
 * 显式命名一个类型,数组元素从构造处就是同一形状。
 */
interface PreviewLayer extends PromptLayer {
  skipped: boolean;
  reason?: string;
}

const result = computed(() =>
  buildPromptLayers(
    {
      fixed: props.fixed,
      characters: props.characters,
      characterTag: props.characterTag || liveCharacterTag.value,
      story: props.story,
      storyNl: props.storyNl,
    },
    {
      separator: props.config?.layerSeparator,
      dedupe: props.config?.dedupeTags !== false,
      budget: props.config?.tagBudget,
    },
  ),
);

/**
 * 展示用的层列表。只有一种降级:分层被关掉。
 * 关掉后角色层整层不发送(回到 0.5.0 旧口径:固定正面 + 剧情),此时不假装它有内容。
 */
const layers = computed<PreviewLayer[]>((): PreviewLayer[] => {
  if (!layeredOn.value) {
    const sent = buildPromptLayers(
      { fixed: props.fixed, story: props.story, storyNl: props.storyNl },
      { separator: ', ', dedupe: false, budget: 0 },
    ).layers.filter(layer => layer.id !== 'character');
    const [fixedLayer, storyLayer] = sent;
    return [
      { ...fixedLayer, skipped: false },
      {
        id: 'character' as PromptLayerId,
        label: LAYER_LABELS.character,
        text: '',
        tagCount: 0,
        chars: 0,
        truncated: false,
        skipped: true,
        reason: '分层已关闭,角色层不发送',
      },
      { ...storyLayer, skipped: false },
    ];
  }
  return result.value.layers.map((layer): PreviewLayer => ({ ...layer, skipped: false }));
});

/** 实际成品串:三层合成后的那一串,原样写进 %prompt% / CLIP 文本节点。 */
const finalText = computed(() => {
  if (!layeredOn.value) {
    return [props.fixed, (props.storyNl ?? '').trim() || props.story]
      .map(part => String(part ?? '').trim())
      .filter(Boolean)
      .join(', ');
  }
  return result.value.text;
});

const finalChars = computed(() => finalText.value.length);
/** tag 数:分层关闭时结果里没有层信息,退回按成品串数逗号。 */
const finalTags = computed(() => {
  if (layeredOn.value) return result.value.tagCount;
  const text = finalText.value;
  if (!text.trim()) return 0;
  return text.split(',').filter(part => part.trim()).length;
});

/* ---------- 负面 ---------- */

/**
 * 负面取分层口径的前提:拿到了固定负面或动态负面这一格。
 * 只给 `negative`(已拼好的成品串)时不分层 —— 拼接信息已经丢了,硬拆只能靠猜。
 */
const negativeLayered = computed(
  () => props.negativeBuiltin !== undefined || props.negativeDynamic !== undefined,
);

const negativeResult = computed(() =>
  buildNegativeLayers(
    {
      builtin: props.negativeBuiltin ?? '',
      dynamic: props.negativeDynamic ?? '',
    },
    {
      separator: props.config?.layerSeparator,
      dedupe: props.config?.dedupeTags !== false,
      // 负面预算恒为 0:砍负面比砍正向危险得多,见 comfyTemplates.negativeOptionsOf
      budget: 0,
    },
  ),
);

interface PreviewNegLayer extends NegativeLayer {
  skipped: boolean;
  reason?: string;
}

/**
 * 负面展示行。只有一种降级:这一次根本送不到工作流。
 * 这时候仍然把串显示出来,因为用户要的往往是「那我手动贴进去」。
 */
const negativeLayers = computed<PreviewNegLayer[]>((): PreviewNegLayer[] => {
  if (props.negativeSupported === false) {
    return negativeResult.value.layers.map((layer): PreviewNegLayer => ({
      ...layer,
      skipped: true,
      reason: '工作流里没有 %negative_prompt%',
    }));
  }
  return negativeResult.value.layers.map((layer): PreviewNegLayer => ({ ...layer, skipped: false }));
});

const negativeText = computed(() => {
  if (negativeLayered.value) return negativeResult.value.text;
  return String(props.negative ?? '').trim();
});

const negativeChars = computed(() => negativeText.value.length);
const negativeTags = computed(() => {
  if (negativeLayered.value) return negativeResult.value.tagCount;
  const text = negativeText.value;
  if (!text.trim()) return 0;
  return text.split(',').filter(part => part.trim()).length;
});

/** 负面这一次到底会不会被送达。 */
const negativeDelivered = computed(() => props.negativeSupported !== false);

/* ---------- 复制 ---------- */

const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyFinal() {
  if (!finalText.value) return;
  try {
    await navigator.clipboard.writeText(finalText.value);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 1200);
  } catch {
    // 剪贴板被拒(非 https / 用户拒绝授权)时不静默:文本本来就是可选的
    copied.value = false;
  }
}

const negativeCopied = ref(false);
let negCopyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyNegative() {
  if (!negativeText.value) return;
  try {
    await navigator.clipboard.writeText(negativeText.value);
    negativeCopied.value = true;
    if (negCopyTimer) clearTimeout(negCopyTimer);
    negCopyTimer = setTimeout(() => (negativeCopied.value = false), 1200);
  } catch {
    negativeCopied.value = false;
  }
}

function hintOf(id: PromptLayerId): string {
  return LAYER_HINTS[id] ?? '';
}

function negHintOf(id: NegativeLayerId): string {
  return NEGATIVE_LAYER_HINTS[id] ?? '';
}

/** 出口名:custom 模式唯一入口是 %prompt%,简易模式写的是 CLIP 文本节点。 */
const positiveOutlet = computed(() => (customMode.value ? '%prompt%' : 'CLIP 正向文本'));
const negativeOutlet = computed(() =>
  customMode.value ? '%negative_prompt%' : 'CLIP 负向文本',
);
</script>

<template>
  <div class="bbi-send-preview" :class="{ 'is-compact': compact }">
    <div class="bsp-head">
      <span class="bsp-title">
        <Icon name="send" :size="14" />
        {{ title ?? '发送预览' }}
      </span>
      <span class="bsp-meta">
        {{ layeredOn ? `分层 ${layers.filter(l => !l.skipped).length}/3` : '未分层' }}
        <em>·</em>
        去重 {{ result.droppedDuplicates }}
        <em>·</em>
        砍 {{ result.droppedByBudget }}
      </span>
    </div>

    <!-- 出口一:正向 -->
    <div class="bsp-outlet">
      <div class="bsp-outlet-head">
        <span class="bsp-outlet-name">
          <code>{{ positiveOutlet }}</code>
          <em>正向 · {{ finalTags }} tag · {{ finalChars }} 字</em>
        </span>
        <button type="button" class="bsp-copy" :disabled="!finalText" @click="copyFinal">
          <Icon name="copy" :size="12" />
          {{ copied ? '已复制' : '复制' }}
        </button>
      </div>

      <ol class="bsp-layers">
        <li
          v-for="(layer, index) in layers"
          :key="layer.id"
          class="bsp-layer"
          :class="{ 'is-skipped': layer.skipped }"
        >
          <div class="bsp-layer-head">
            <span class="bsp-order">{{ layer.skipped ? '—' : index + 1 }}</span>
            <span class="bsp-layer-name" :title="hintOf(layer.id)">{{ layer.label }}</span>
            <span v-if="layer.skipped" class="bsp-tag-count bsp-muted">{{ layer.reason }}</span>
            <span v-else class="bsp-tag-count">{{ layer.tagCount }} tag</span>
          </div>
          <p v-if="!layer.skipped && layer.text" class="bsp-layer-text">{{ layer.text }}</p>
          <p v-else-if="!layer.skipped" class="bsp-empty">
            <template v-if="layer.id === 'character'">
              这一层没有内容 —— 本聊天角色档案里还没有能进角色层的词。
              <template v-if="!basePrompt.enabled">
                角色层参与拼接被关掉了,打开「渠道」页「提示词」区上面的开关即可。
              </template>
              <template v-else-if="chatProfiles.entries.length">
                「角色档案」里已有 {{ chatProfiles.entries.length }} 个角色,但档案里的外貌词是空的:
                去填固定外貌(或整串),这里就会立刻出现。
              </template>
              <template v-else>先去「角色档案」页建一条档案,填上正文里会出现的名字/称呼与外貌。</template>
            </template>
            <template v-else-if="layer.id === 'fixed'">这一层没有内容 —— 去「渠道」页的「提示词」里填固定正面。</template>
            <template v-else>这一层没有内容 —— 等本楼正文编译出画面后就有了。</template>
          </p>
          <p v-if="layer.note" class="bsp-layer-note">{{ layer.note }}</p>
        </li>
      </ol>

      <p v-if="result.droppedDuplicates > 0 || result.droppedByBudget > 0" class="bsp-notice">
        <template v-if="result.droppedDuplicates > 0">
          跨层去重删掉 {{ result.droppedDuplicates }} 个重复 tag(保先出现的层)
        </template>
        <template v-if="result.droppedByBudget > 0">
          <span v-if="result.droppedDuplicates > 0"> · </span>
          超出 tag 预算砍掉 {{ result.droppedByBudget }} 个(从末层末尾砍)
        </template>
      </p>
      <p v-if="result.duplicateCharacters.length" class="bsp-notice">
        同名角色只保留第一份:{{ result.duplicateCharacters.join('、') }}
      </p>

      <pre class="bsp-final-text">{{ finalText || '(空 —— 三层都没有内容,这一次只会发出一个空提示词)' }}</pre>
    </div>

    <!-- 出口二:负面 -->
    <div class="bsp-outlet is-negative">
      <div class="bsp-outlet-head">
        <span class="bsp-outlet-name">
          <code>{{ negativeOutlet }}</code>
          <em>
            负面 · {{ negativeTags }} tag · {{ negativeChars }} 字
            <span v-if="!negativeDelivered" class="bsp-warn">· 不会送达</span>
          </em>
        </span>
        <button type="button" class="bsp-copy" :disabled="!negativeText" @click="copyNegative">
          <Icon name="copy" :size="12" />
          {{ negativeCopied ? '已复制' : '复制' }}
        </button>
      </div>

      <p v-if="!negativeDelivered" class="bsp-notice bsp-notice-warn">
        当前工作流没有 <code>%negative_prompt%</code> 占位符,这一格填了也不会进了。
        想让负面生效:在工作流的负向 CLIPTextEncode 的 text 里写 <code>%negative_prompt%</code>。
      </p>
      <p v-else-if="!negativeLayered" class="bsp-notice">
        这次没拿到固定负面与动态负面两格,按已拼好的成品串原样显示。
      </p>

      <ol v-if="negativeLayered" class="bsp-layers bsp-layers-neg">
        <li
          v-for="(layer, index) in negativeLayers"
          :key="layer.id"
          class="bsp-layer"
          :class="{ 'is-skipped': layer.skipped }"
        >
          <div class="bsp-layer-head">
            <span class="bsp-order bsp-order-neg">{{ layer.skipped ? '—' : index + 1 }}</span>
            <span class="bsp-layer-name" :title="negHintOf(layer.id)">{{ layer.label }}</span>
            <span v-if="layer.skipped" class="bsp-tag-count bsp-muted">{{ layer.reason }}</span>
            <span v-else class="bsp-tag-count">{{ layer.tagCount }} tag</span>
          </div>
          <p v-if="!layer.skipped && layer.text" class="bsp-layer-text">{{ layer.text }}</p>
          <p v-else-if="!layer.skipped" class="bsp-empty">这一层没有内容</p>
          <p v-if="layer.note" class="bsp-layer-note">{{ layer.note }}</p>
        </li>
      </ol>

      <p v-if="negativeLayered && negativeResult.droppedDuplicates > 0" class="bsp-notice">
        动态词里有 {{ negativeResult.droppedDuplicates }} 个与固定负面的重复,已吸收(重复不改变采样结果,只白吃额度)
      </p>

      <pre class="bsp-final-text">{{ negativeText || '(空 —— 这一张没有任何负面词)' }}</pre>
    </div>
  </div>
</template>

<style scoped>
.bbi-send-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.bbi-send-preview.is-compact {
  padding: 8px 10px;
  gap: 8px;
}
.bsp-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.bsp-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--bbi-ink);
}
.bsp-meta {
  font-size: 11px;
  color: var(--bbi-ink-soft);
  white-space: nowrap;
}
.bsp-meta em {
  margin: 0 3px;
  font-style: normal;
  opacity: 0.5;
}
.bsp-outlet {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
}
.bsp-outlet.is-negative {
  background: color-mix(in srgb, var(--bbi-surface) 88%, var(--bbi-line-strong));
}
.bsp-outlet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.bsp-outlet-name {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.bsp-outlet-name code {
  padding: 0 4px;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--bbi-ink);
  background: var(--bbi-surface-2);
}
.bsp-outlet-name em {
  font-style: normal;
  font-size: 10.5px;
  color: var(--bbi-ink-soft);
}
.bsp-warn {
  color: var(--bbi-warn, #b8860b);
}
.bsp-layers {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.bsp-layer {
  padding: 6px 8px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.bsp-layer.is-skipped {
  opacity: 0.55;
  border-style: dashed;
}
.bsp-layer-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.bsp-order {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  background: var(--bbi-accent);
}
.bsp-layer.is-skipped .bsp-order {
  background: var(--bbi-ink-soft);
}
.bsp-layer-name {
  font-weight: 600;
  color: var(--bbi-ink);
  cursor: help;
}
.bsp-tag-count {
  margin-left: auto;
  color: var(--bbi-ink-soft);
}
.bsp-muted {
  font-size: 10px;
  font-weight: 400;
}
.bsp-layer-text {
  margin: 4px 0 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--bbi-ink);
  word-break: break-word;
  white-space: pre-wrap;
}
.bsp-empty {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--bbi-ink-soft);
  font-style: italic;
}
.bsp-layer-note {
  margin: 4px 0 0;
  font-size: 10.5px;
  color: var(--bbi-warn, #b8860b);
}
.bsp-notice {
  margin: 0;
  font-size: 10.5px;
  color: var(--bbi-ink-soft);
}
.bsp-notice code {
  padding: 0 3px;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  background: var(--bbi-surface-2);
}
.bsp-notice-warn {
  color: var(--bbi-warn, #b8860b);
}
.bsp-layers-neg .bsp-order-neg {
  background: var(--bbi-ink-soft);
}
.bsp-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: 4px;
  font-size: 10.5px;
  color: var(--bbi-ink-soft);
  background: transparent;
  cursor: pointer;
}
.bsp-copy:disabled {
  opacity: 0.4;
  cursor: default;
}
.bsp-copy:hover:not(:disabled) {
  color: var(--bbi-ink);
  border-color: var(--bbi-accent);
}
.bsp-final-text {
  margin: 0;
  max-height: 132px;
  overflow: auto;
  padding: 6px 8px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.55;
  color: var(--bbi-ink);
  background: var(--bbi-surface-2);
  word-break: break-word;
  white-space: pre-wrap;
  user-select: text;
}
</style>
