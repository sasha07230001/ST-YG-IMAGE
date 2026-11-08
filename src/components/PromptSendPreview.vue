<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import {
  LAYER_ORDER,
  LAYER_HINTS,
  buildPromptLayers,
  type PromptLayer,
  type PromptLayerId,
} from '@/backends/promptLayers';
import type { ComfySimpleConfig } from '@/backends/comfyTemplates';
import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { computed, ref } from 'vue';

/**
 * 发送预览:把「这次真正会送进 ComfyUI 正面提示词框的那一串」原样摊开给用户看。
 *
 * 为什么需要它:三层拼接发生在后端组装里,`composePositive` 一返回就是一个长串,
 * 用户在原界面只能改「固定正面」那一格,看不到角色层与剧情层最后落在哪、
 * 中间还有没有被去重/被预算砍掉的东西。改采样器参数时凭感觉调词,效率极低。
 *
 * 为什么这里复用 `buildPromptLayers` 而不是自己再拼一遍:预览与真实发送必须同一个口径。
 * 各写一份的话,面板上显示 40 个 tag、实际发出去 37 个,用户永远查不出为什么。
 *
 * 三处调用点(渠道页 / 提示词页 / 手动编辑弹窗)传的字段各有缺省:
 *   - 渠道页:只有固定正面 + 负面,剧情层用占位文案说明「出图时才有」;
 *   - 提示词页:可自由试衣,五格全手填;
 *   - 编辑弹窗:拿当楼草稿,是最接近真实的一次。
 */
const props = defineProps<{
  /** 拼接规则来源(分隔符 / 去重 / 预算)。给 null 用默认口径。 */
  config?: ComfySimpleConfig | null;
  /** custom 模式没有角色位与固定正面位,预览要如实降级。 */
  mode?: 'custom' | 'simple';
  fixed?: string;
  story?: string;
  storyNl?: string;
  characters?: ImageCharacterPrompt[];
  /** 已合成的角色档案串(常驻 + 临时),与 characters 一起构成角色层。 */
  characterTag?: string;
  negative?: string;
  title?: string;
  /** 嵌在窄栏里时收紧留白。 */
  compact?: boolean;
}>();

const customMode = computed(() => props.mode === 'custom');
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
      fixed: customMode.value ? '' : props.fixed,
      characters: customMode.value ? undefined : props.characters,
      characterTag: customMode.value ? undefined : props.characterTag,
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
 * 展示用的层列表。分两种降级:
 *   - custom 模式:只有剧情层真的会发送,其余层标注「不发送」并压暗;
 *   - 分层关闭:角色层不发送(与 0.5.0 旧口径一致),拼接退化为固定 + 剧情。
 */
const layers = computed<PreviewLayer[]>((): PreviewLayer[] => {
  if (customMode.value) {
    return LAYER_ORDER.map((id): PreviewLayer => {
      const found = result.value.layers.find(layer => layer.id === id);
      const base: PromptLayer =
        found ?? { id, label: id, text: '', tagCount: 0, chars: 0, truncated: false };
      if (id === 'story') {
        return {
          ...base,
          note: base.note ?? '工作流里由 %prompt% 占位符接收,本页显示的是原样正文',
          skipped: false,
        };
      }
      return {
        ...base,
        text: id === 'fixed' ? String(props.fixed ?? '') : (props.characterTag ?? ''),
        tagCount: 0,
        chars: 0,
        skipped: true,
        reason: 'custom 模式没有这一层的位置',
      };
    });
  }
  if (!layeredOn.value) {
    // 分层关:固定正面 + 剧情按旧口径拼,角色层整层不发送。
    // 这里只给 UI 看的「固定 + 剧情」两条,角色层单独补一条并标 skipped。
    const sent = buildPromptLayers(
      { fixed: props.fixed, story: props.story, storyNl: props.storyNl },
      { separator: ', ', dedupe: false, budget: 0 },
    ).layers.filter(layer => layer.id !== 'character');
    const [fixedLayer, storyLayer] = sent;
    return [
      { ...fixedLayer, skipped: false },
      {
        id: 'character' as PromptLayerId,
        label: '角色',
        text: '',
        tagCount: 0,
        chars: 0,
        truncated: false,
        skipped: true,
        reason: '分层已关闭,角色提示词不会发送',
      },
      { ...storyLayer, skipped: false },
    ];
  }
  return result.value.layers.map((layer): PreviewLayer => ({ ...layer, skipped: false }));
});

/** 实际成品串:custom 模式就是剧情原文,否则走分层拼接。 */
const finalText = computed(() => {
  if (customMode.value) return String(props.story ?? '').trim();
  if (!layeredOn.value) {
    return [props.fixed, (props.storyNl ?? '').trim() || props.story]
      .map(part => String(part ?? '').trim())
      .filter(Boolean)
      .join(', ');
  }
  return result.value.text;
});

const finalChars = computed(() => finalText.value.length);
const finalTags = computed(() => (customMode.value ? '—' : String(result.value.tagCount)));

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
    // 剪贴板被拒(非 https / 用户拒绝授权)时不静默:选中文本让用户自己复制
    copied.value = false;
  }
}

function hintOf(id: PromptLayerId): string {
  return LAYER_HINTS[id] ?? '';
}
</script>

<template>
  <div class="bbi-send-preview" :class="{ 'is-compact': compact }">
    <div class="bsp-head">
      <span class="bsp-title">
        <Icon name="send" :size="14" />
        {{ title ?? '发送预览' }}
      </span>
      <span class="bsp-meta">
        {{ customMode ? 'custom 模式 · 仅正文' : `分层 ${layers.filter(l => !l.skipped).length}/3` }}
        <em>·</em>
        {{ finalTags }} tag
        <em>·</em>
        {{ finalChars }} 字
      </span>
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
        <p v-else-if="!layer.skipped" class="bsp-empty">这一层没有内容</p>
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

    <div class="bsp-final">
      <div class="bsp-final-head">
        <span>最终正面提示词</span>
        <button type="button" class="bsp-copy" :disabled="!finalText" @click="copyFinal">
          <Icon name="copy" :size="12" />
          {{ copied ? '已复制' : '复制' }}
        </button>
      </div>
      <pre class="bsp-final-text">{{ finalText || '(空)' }}</pre>
    </div>

    <div v-if="negative" class="bsp-final is-negative">
      <div class="bsp-final-head">
        <span>负面提示词</span>
      </div>
      <pre class="bsp-final-text">{{ negative }}</pre>
    </div>
  </div>
</template>

<style scoped>
.bbi-send-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.bbi-send-preview.is-compact {
  padding: 8px 10px;
  gap: 6px;
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
  background: var(--bbi-surface);
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
.bsp-final {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px dashed var(--bbi-line);
}
.bsp-final.is-negative {
  padding-top: 4px;
}
.bsp-final-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 600;
  color: var(--bbi-ink-soft);
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
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.55;
  color: var(--bbi-ink);
  word-break: break-word;
  white-space: pre-wrap;
  user-select: text;
}
</style>
