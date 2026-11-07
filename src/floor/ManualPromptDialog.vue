<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { Orientation } from '@/backends/size';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { activeOrientationLock, settings } from '@/state/settings';

/**
 * 「手动提示词生图」弹窗。
 *
 * 与「编辑提示词」弹窗(PromptEditor.vue)是**两件事**:
 * - 那个改的是正文里**已有**那条 tag,本质是改写;
 * - 这个是**新增**一张图:用户当场敲提示词,写完往本楼末尾追加一条新 tag 再出图。
 * 所以这里没有「AI 重写」,也没有历史/回滚,只有一个干净的表单。
 *
 * 【为什么不做成命令式挂载】
 * 它只在按钮点击那一刻存在,生命周期与按钮同源(不像灯箱/编辑器活得比卡片长),
 * 用 <Transition> + 受控 open 即可,便于楼层按钮直接挂一个实例。
 */

const props = defineProps<{
  /** 打开态(受控)。 */
  open: boolean;
  /** 后端是否已配置好;未配置时只允许「只写提示词」。 */
  configured: boolean;
  /** 当前楼层序号(标题里显示,让人确认打的是哪一楼)。 */
  floor: number | null;
}>();

const emit = defineEmits<{
  /** 提交:generate=true 时写完直接出图。 */
  (e: 'submit', payload: { prompt: string; negative: string; nl: string; size: Orientation; generate: boolean }): void;
  (e: 'close'): void;
}>();

const prompt = ref('');
const negative = ref('');
const nl = ref('');
const size = ref<Orientation>('portrait');
const busy = ref(false);
/** 弹窗内部的即时校验错误(后端未就绪属于外部状态,不写这里)。 */
const error = ref('');

/**
 * 画幅锁(与 PromptEditor.vue 同一口径):渠道锁了方向时这里显示锁定值并禁用,
 * 因为 generate.ts 出图时一律按锁走,再让人选只是个不起作用的开关。
 */
const lockedSize = computed<Orientation | null>(() => {
  const lock = activeOrientationLock();
  return lock === 'auto' ? null : lock;
});
const effectiveSize = computed<Orientation>(() => lockedSize.value ?? size.value);

/** 打开时清空并给一个合理的默认方向(跟随当前设置里的第一条尺寸偏好)。 */
watch(
  () => props.open,
  open => {
    if (!open) return;
    error.value = '';
    busy.value = false;
    size.value = 'portrait';
    if (!prompt.value.trim()) {
      // 记住上次敲的内容:连画几张时不用重打。首次打开为空即可。
      prompt.value = '';
    }
  },
);

const canSubmit = computed(() => !!prompt.value.trim() && !busy.value);

/** 提交前的本地校验:空提示词与子标签字面量都在这里挡下,别等写进正文才发现。 */
function submit(generate: boolean): void {
  if (busy.value) return;
  const text = prompt.value.trim();
  if (!text) {
    error.value = '画面 tag 不能为空';
    return;
  }
  if (/<\/?(?:bbi_image|tag|nl|negative|size)\b/i.test(`${text}\n${negative.value}\n${nl.value}`)) {
    error.value = '提示词里不能包含 bbi_image / tag / nl / negative / size 这类标签字面量';
    return;
  }
  error.value = '';
  busy.value = true;
  emit('submit', {
    prompt: text,
    negative: negative.value.trim(),
    nl: nl.value.trim(),
    size: effectiveSize.value,
    generate,
  });
}

/** 调用方处理完(无论成败)都要解锁按钮,否则失败一次就再也点不动。 */
function release(): void {
  busy.value = false;
}
defineExpose({ release, setError: (message: string) => { error.value = message; busy.value = false; } });

function requestClose(): void {
  if (busy.value) return;
  emit('close');
}

/* Esc 关闭:弹窗挂在插件 shadow root 里,ST 的全局快捷键收不到,Esc 得自己拦。 */
function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return;
  if (event.key === 'Escape') {
    event.stopPropagation();
    requestClose();
  }
}
onMounted(() => document.addEventListener('keydown', onKeydown, true));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <ModalMask :open="open" top-layer @close="requestClose">
    <div class="bbi-modal bbi-modal-wide bbi-manual-modal" role="dialog" aria-modal="true" aria-label="手动提示词生图">
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">
          手动提示词生图
          <span v-if="floor !== null" class="bbi-manual-floor">第 {{ floor }} 楼</span>
        </span>
        <button class="bbi-icon-mini" type="button" title="关闭" @click="requestClose">
          <Icon name="close" />
        </button>
      </header>

      <p class="bbi-editor-note">
        不打提示词分析、也不改正文里已有的 tag:这里敲的内容会作为<strong>新的一张图</strong>
        追加到本楼末尾,然后直接出图。想改某张图自己的提示词,请用那张图上的铅笔。
      </p>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">画面 tag(danbooru 短 tag,逗号分隔)</span>
        <BbiTextarea
          v-model="prompt"
          class="bbi-prompt-area"
          :rows="5"
          :max-rows="16"
          mono
          placeholder="1girl, long black hair, white dress, standing in rain, neon lights, night, wide shot"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">负面提示词(可留空;与渠道级负面词叠加)</span>
        <BbiTextarea
          v-model="negative"
          class="bbi-prompt-area"
          :rows="2"
          :max-rows="8"
          mono
          placeholder="extra people, duplicate"
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">自然语言(可留空;ComfyUI 开了「生成自然语言」或 NAI 时才用得上)</span>
        <BbiTextarea
          v-model="nl"
          class="bbi-prompt-area"
          :rows="2"
          :max-rows="8"
          placeholder="A girl in a white dress stands under the rain, neon lights in the puddles."
        />
      </div>

      <div class="bbi-modal-field">
        <span class="bbi-modal-label">画幅方向(具体像素在「渠道」页配置)</span>
        <div class="bbi-segmented" role="tablist" aria-label="画幅方向">
          <button
            class="bbi-seg"
            :class="{ 'is-on': effectiveSize === 'portrait' }"
            type="button"
            role="tab"
            :aria-selected="effectiveSize === 'portrait'"
            :disabled="!!lockedSize"
            @click="size = 'portrait'"
          >
            竖屏
          </button>
          <button
            class="bbi-seg"
            :class="{ 'is-on': effectiveSize === 'landscape' }"
            type="button"
            role="tab"
            :aria-selected="effectiveSize === 'landscape'"
            :disabled="!!lockedSize"
            @click="size = 'landscape'"
          >
            横屏
          </button>
        </div>
        <span v-if="lockedSize" class="bbi-field-hint">
          当前渠道已锁定{{ lockedSize === 'portrait' ? '竖屏' : '横屏' }},出图一律按此方向;
          想按每张图各自的方向出,到「渠道」页尺寸旁改回「自动」。
        </span>
      </div>

      <p v-if="!configured" class="bbi-manual-warn">
        出图渠道还没配好,现在只能「只写提示词」;配好之后在卡片上点「生成图片」即可。
      </p>
      <p v-if="error" class="bbi-editor-error">{{ error }}</p>
      <p v-else-if="settings.defaultBackend === 'comfyui'" class="bbi-field-hint">
        追加到 CLIP 的最终顺序:画风词 → 上面这段 tag → 角色档案(常驻/临时)。
      </p>

      <footer class="bbi-modal-foot">
        <span class="bbi-modal-foot-spacer"></span>
        <button class="bbi-btn" type="button" :disabled="busy" @click="requestClose">取消</button>
        <button class="bbi-btn" type="button" :disabled="!canSubmit" @click="submit(false)">
          只写提示词
        </button>
        <button
          class="bbi-btn bbi-btn-primary"
          type="button"
          :disabled="!canSubmit || !configured"
          :title="configured ? '写入并立即出图' : '请先在YG「渠道」页完成配置'"
          @click="submit(true)"
        >
          <Icon name="palette" /> 生成图片
        </button>
      </footer>
    </div>
  </ModalMask>
</template>

<style scoped>
.bbi-modal-wide {
  max-width: 680px;
}

.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}

.bbi-prompt-area {
  line-height: 1.6;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* 楼层标:跟在标题后面的一枚小药丸,避免用户看错打的是哪一楼 */
.bbi-manual-floor {
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: var(--bbi-radius-pill);
  border: 1px solid var(--bbi-line-strong);
  background: var(--bbi-surface-2);
  font-size: 11px;
  font-weight: 600;
  color: var(--bbi-ink-muted);
  vertical-align: middle;
}

.bbi-editor-note {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  font-size: 12px;
  line-height: 1.7;
  color: var(--bbi-ink-soft);
}

.bbi-manual-warn {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-warning-soft);
  font-size: 12px;
  line-height: 1.7;
  color: var(--bbi-warning);
}

.bbi-editor-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--bbi-danger);
}

/* 窄屏:标题与楼层标换行,按钮按主次竖排(主按钮在最下,拇指好够) */
@media (max-width: 560px) {
  .bbi-modal-foot {
    flex-wrap: wrap;
  }
  .bbi-modal-foot .bbi-btn {
    flex: 1 1 calc(50% - 6px);
  }
  .bbi-modal-foot .bbi-btn-primary {
    flex: 1 1 100%;
  }
}
</style>
