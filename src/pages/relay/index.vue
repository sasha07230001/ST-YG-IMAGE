<script setup lang="ts">
import { computed, ref } from 'vue';

import BbiTextarea from '@/components/BbiTextarea.vue';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { compilePrompt, fetchRelayModels, testRelayConnection } from '@/relay/client';
import { normalizeRelayUrl, renderTemplate, validatePrompt } from '@/relay/prompt';
import { planSegments } from '@/relay/split';
import {
  DEFAULT_PREFILL_TEXT,
  DEFAULT_PURGE_PROMPT,
  DEFAULT_RELAY_SPEC,
  DEFAULT_RELAY_SYSTEM,
  activeComfyPreset,
  settings,
  type TagPromptMode,
} from '@/state/settings';
import { prepareTargetText } from '@/autoTag/clean';
import { getContext, isAiStoryMessage } from '@/st/context';
import { parseImageTags, stripImageTags } from '@/st/imageTagRegex';

/**
 * 「中转站」页:正文先交给一个 OpenAI 兼容模型编译成 CLIP 提示词,再写进楼层 tag。
 *
 * 这一页只做三件事:
 * 1. 选提示词方式(内置 LLM 分析 / 中转站编译)——这是全插件唯一的口径开关;
 * 2. 配置中转站(地址/密钥/模型/温度/超时/拉模型/测试);
 * 3. 编辑编译提示词与恒定词,并给一个「自检」按钮:用当前楼梯正文跑一遍,
 *    把最终会写进 tag 的那串原样显示出来——不烧出图渠道就能验证编译结果。
 */

const MODE_OPTIONS: { value: TagPromptMode; label: string }[] = [
  { value: 'builtin', label: '内置 LLM 分析' },
  { value: 'relay', label: '中转站编译' },
];

const mode = computed<TagPromptMode>({
  get: () => settings.autoTag.prompts.mode,
  set: v => (settings.autoTag.prompts.mode = v),
});

const relay = settings.relay;

/* —— 占位符提示(写成常量而不是模板里的字面量:{{ 在 Vue 模板里是插值语法,写不进去) —— */
const PLACEHOLDER_HINTS = {
  story: '{{story}}',
  note: '{{note}}',
  index: '{{index}}',
  count: '{{count}}',
  orientation: '{{orientation}}',
  nlOpen: '{{#nl}}',
  nlClose: '{{/nl}}',
};

/* —— 渠道操作 —— */
const testing = ref(false);
const pulling = ref(false);
const models = ref<string[]>([]);
const status = ref<{ ok: boolean; text: string } | null>(null);

const normalizedUrl = computed(() => normalizeRelayUrl(relay.url));

async function testConnection(): Promise<void> {
  if (testing.value) return;
  testing.value = true;
  status.value = { ok: true, text: '正在测试…' };
  try {
    const result = await testRelayConnection({
      url: relay.url,
      key: relay.key,
      model: relay.model,
      temperature: relay.temperature,
      maxTokens: relay.maxTokens,
      timeoutSec: relay.timeoutSec,
    });
    status.value = { ok: result.ok, text: result.message };
  } finally {
    testing.value = false;
  }
}

async function pullModels(): Promise<void> {
  if (pulling.value) return;
  pulling.value = true;
  status.value = { ok: true, text: '正在拉取模型列表…' };
  try {
    models.value = await fetchRelayModels({ url: relay.url, key: relay.key, timeoutSec: relay.timeoutSec });
    status.value = {
      ok: models.value.length > 0,
      text: models.value.length ? `拉到 ${models.value.length} 个模型,点下面的名字即可选用` : '没有拉到模型',
    };
  } catch (error) {
    status.value = { ok: false, text: error instanceof Error ? error.message : String(error) };
  } finally {
    pulling.value = false;
  }
}

/** 规范化地址并回写(用户填了裸域名时自动补 /v1,与请求侧同口径)。 */
function normalizeUrlField(): void {
  relay.url = normalizedUrl.value;
}

/* —— 提示词编辑 —— */
const systemDraft = computed({
  get: () => settings.autoTag.prompts.relaySystem,
  set: v => (settings.autoTag.prompts.relaySystem = v),
});
const specDraft = computed({
  get: () => settings.autoTag.prompts.relaySpec,
  set: v => (settings.autoTag.prompts.relaySpec = v),
});
const effectiveSystem = computed(
  () => settings.autoTag.prompts.relaySystem.trim() || DEFAULT_RELAY_SYSTEM,
);
const effectiveSpec = computed(() => settings.autoTag.prompts.relaySpec.trim() || DEFAULT_RELAY_SPEC);

function resetSystem(): void {
  settings.autoTag.prompts.relaySystem = '';
}
function resetSpec(): void {
  settings.autoTag.prompts.relaySpec = '';
}
function resetPurge(): void {
  relay.purge.systemPrompt = DEFAULT_PURGE_PROMPT;
  relay.purge.prefillText = DEFAULT_PREFILL_TEXT;
}

/* —— 自检:用当前楼梯正文真跑一次编译 —— */
const DIAGNOSTIC_PREFIX = '[YG][RelaySelfCheck]';
const checking = ref(false);
const checkOutput = ref('');
const checkError = ref('');

interface SelfCheckFloor {
  floor: number;
  text: string;
}

/** 最近一条 AI 剧情楼(取尾部 1~2 楼都能用,这里固定取最后一条)。 */
function latestAiFloor(): SelfCheckFloor | null {
  const ctx = getContext();
  if (!ctx?.chat?.length) return null;
  for (let floor = ctx.chat.length - 1; floor >= 0; floor -= 1) {
    const message = ctx.chat[floor];
    if (isAiStoryMessage(message)) {
      return { floor, text: stripImageTags(message.mes ?? '') };
    }
  }
  return null;
}

/**
 * 自检:同一段正文 → 分段 → 编译(走与正式链路同一份 prompt 组装 + 同一份清洗/验收)。
 *
 * 刻意不写正文、不出图:这一步只是让用户看见「模型会给我什么」。
 * 请求体与正式链路完全同源(relay/client.ts),所以自检通过就基本等于正式可用。
 */
async function runSelfCheck(): Promise<void> {
  if (checking.value) return;
  checkOutput.value = '';
  checkError.value = '';
  const picked = latestAiFloor();
  if (!picked) {
    checkError.value = '当前聊天里没有找到可用的 AI 剧情楼';
    return;
  }
  if (!relay.url.trim() || !relay.model.trim()) {
    checkError.value = '先把中转站的 API 地址与模型名填上';
    return;
  }
  checking.value = true;
  try {
    const prepared = prepareTargetText(picked.text, settings.excludes.customStripTags);
    if (!prepared.segments.length) {
      checkError.value = '这一楼清洗后没有剩下正文';
      return;
    }
    const story = prepared.segments.map(s => s.text).join('\n\n');
    const segments = planSegments(story, {
      count: Math.max(1, settings.autoTag.minImages || 1),
      mark: relay.segmentMark,
    });
    const first = segments[0]?.text ?? story;
    const values = {
      story: first,
      note: segments.length > 1 ? `本次只画第 1/${segments.length} 张。` : '',
      mark: relay.segmentMark,
      index: 0,
      count: segments.length,
      orientation: null,
    };
    const system = `${renderTemplate(settings.autoTag.prompts.relaySystem.trim() || DEFAULT_RELAY_SYSTEM, values)}\n\n${
      settings.autoTag.prompts.relaySpec.trim() || DEFAULT_RELAY_SPEC
    }`;
    const compiled = await compilePrompt(
      {
        url: relay.url,
        key: relay.key,
        model: relay.model,
        temperature: relay.temperature,
        maxTokens: relay.maxTokens,
        timeoutSec: relay.timeoutSec,
        purge: relay.purge,
      },
      [
        { role: 'system', content: system },
        { role: 'user', content: `请把上面的剧情编译成提示词。可选位置 ID:${prepared.segments.map(s => s.id).join('、')}` },
      ],
      { allowUrlFallback: true },
    );
    const verdict = validatePrompt(compiled);
    checkOutput.value = compiled;
    if (!verdict.ok) checkError.value = verdict.reason;
    console.info(`${DIAGNOSTIC_PREFIX} floor=${picked.floor} segments=${segments.length} len=${compiled.length}`);
  } catch (error) {
    checkError.value = error instanceof Error ? error.message : String(error);
  } finally {
    checking.value = false;
  }
}

/** 自检结果里顺带证明「写进 tag 后会被读成什么」。 */
const parsedTagPreview = computed(() => {
  const text = checkOutput.value.trim();
  if (!text) return '';
  return parseImageTags(`<bbi_image>${text}</bbi_image>`).length ? text : '';
});

/* —— 工作流提示:客户端写入口径说明 —— */
const comfyPresetName = computed(() => activeComfyPreset().name);
const comfyWorkflowHasPlaceholder = computed(() => {
  const preset = activeComfyPreset();
  if (preset.mode === 'simple') return true;
  return preset.workflow.includes('%prompt%');
});
</script>

<template>
  <section class="bbi-page">
    <header class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">中转站</h2>
      <p class="bbi-page-intro">
        正文先交给一个 OpenAI 兼容模型编译成 CLIP 提示词,再写进楼层 tag、交给出图渠道。
        与「内置 LLM 分析」共用楼层卡片、出图、图库与队列,只是提示词从另一条链来。
      </p>
    </header>

    <div class="bbi-sections">
      <!-- 提示词方式:全插件唯一的口径开关 -->
      <Collapsible title="提示词方式" :open="true">
        <div class="bbi-segmented-wrap">
          <div class="bbi-segmented" role="tablist" aria-label="提示词方式">
            <button
              v-for="opt in MODE_OPTIONS"
              :key="opt.value"
              class="bbi-seg"
              :class="{ 'is-on': mode === opt.value }"
              type="button"
              role="tab"
              :aria-selected="mode === opt.value"
              @click="mode = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <p class="bbi-field-hint">
          <strong>内置 LLM 分析</strong>:沿用插件原本那条链——独立一次 LLM 请求,模型按结构化协议
          选画面、写 tag、维护角色固定外貌库,再写进正文。<br />
          <strong>中转站编译</strong>:正文直接交给中转站模型,让它编译成一行英文 CLIP 提示词;
          这条链不产出角色建档,画面完全由编译结果与下面的恒定词决定。
        </p>
      </Collapsible>

      <!-- 中转站渠道 -->
      <Collapsible title="中转站渠道" :open="mode === 'relay'">
        <label class="bbi-switch-row">
          <span class="bbi-field-label">启用中转站</span>
          <input v-model="relay.enabled" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          关掉后中转站模式会直接报错(不会悄悄回退到内置链),适合「今天不想用」时临时停机。
        </p>

        <div class="bbi-field">
          <div class="bbi-field-head"><span class="bbi-field-label">API 地址</span></div>
          <input
            v-model="relay.url"
            class="bbi-input"
            type="text"
            placeholder="https://api.deepseek.com"
            spellcheck="false"
            @blur="normalizeUrlField"
          />
          <p class="bbi-field-hint">
            填到域名即可(自动补 <code>/v1</code>),也可填完整 <code>…/v1</code>。
            实际请求地址:<code>{{ normalizedUrl || '(未填)' }}</code>
          </p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head"><span class="bbi-field-label">API Key</span></div>
          <input v-model="relay.key" class="bbi-input" type="password" placeholder="sk-…" spellcheck="false" />
          <p class="bbi-field-hint">经 SillyTavern 服务端转发,不直连浏览器,也不会出现在公开接口里。</p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">模型</span>
            <button class="bbi-btn bbi-btn-sm" type="button" :disabled="pulling" @click="pullModels">
              <Icon name="refresh" /> {{ pulling ? '拉取中…' : '拉模型列表' }}
            </button>
          </div>
          <input v-model="relay.model" class="bbi-input" type="text" placeholder="deepseek-chat" spellcheck="false" />
          <ul v-if="models.length" class="yg-model-list">
            <li v-for="m in models.slice(0, 60)" :key="m">
              <button
                class="bbi-btn bbi-btn-sm"
                :class="{ 'bbi-btn-primary': m === relay.model }"
                type="button"
                @click="relay.model = m"
              >
                {{ m }}
              </button>
            </li>
          </ul>
        </div>

        <div class="bbi-num-row">
          <span class="bbi-field-label">温度</span>
          <input v-model.number="relay.temperature" class="bbi-input bbi-num" type="number" min="0" max="2" step="0.1" />
        </div>
        <p class="bbi-field-hint">提词任务建议 0.7~0.9;太低会反复写同一串 tag,太高会加戏。</p>

        <div class="bbi-num-row">
          <span class="bbi-field-label">最大 token</span>
          <input v-model.number="relay.maxTokens" class="bbi-input bbi-num" type="number" min="64" max="8192" step="64" />
        </div>

        <div class="bbi-num-row">
          <span class="bbi-field-label">超时(秒)</span>
          <input v-model.number="relay.timeoutSec" class="bbi-input bbi-num" type="number" min="10" max="600" step="10" />
        </div>

        <div class="bbi-channel-bar">
          <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" :disabled="testing" @click="testConnection">
            <Icon name="plug" /> {{ testing ? '测试中…' : '测试中转站' }}
          </button>
          <button class="bbi-btn bbi-btn-sm" type="button" :disabled="checking" @click="runSelfCheck">
            <Icon name="bolt" /> {{ checking ? '自检中…' : '用当前楼梯自检' }}
          </button>
        </div>
        <p v-if="status" class="bbi-field-hint" :class="{ 'yg-warn': !status.ok }">{{ status.text }}</p>

        <template v-if="checkError || checkOutput">
          <hr class="bbi-rule" />
          <p v-if="checkError" class="bbi-field-hint yg-warn">自检未通过:{{ checkError }}</p>
          <div v-if="checkOutput" class="yg-check">
            <div class="bbi-field-label">编译结果(会写进 tag 的正向提示词)</div>
            <pre class="yg-check__text">{{ checkOutput }}</pre>
            <p v-if="parsedTagPreview" class="bbi-field-hint">
              字符数 {{ checkOutput.length }}。确认没问题后,回到楼层点「生成 tag」或等自动流程写入。
            </p>
          </div>
        </template>
      </Collapsible>

      <!-- 编译提示词 -->
      <Collapsible title="编译提示词" :open="mode === 'relay' && false">
        <div class="bbi-field-head">
          <span class="bbi-field-label">system 提示词</span>
          <button class="bbi-btn bbi-btn-sm" type="button" @click="resetSystem">恢复默认</button>
        </div>
        <p class="bbi-field-hint">
          占位符:<code>{{ PLACEHOLDER_HINTS.story }}</code> 剧情正文、<code>{{ PLACEHOLDER_HINTS.note }}</code> 任务提示、
          <code>{{ PLACEHOLDER_HINTS.index }}</code>/<code>{{ PLACEHOLDER_HINTS.count }}</code> 第几张、
          <code>{{ PLACEHOLDER_HINTS.orientation }}</code> 画幅。留空用内置默认。
          另支持 <code>{{ PLACEHOLDER_HINTS.nlOpen }}…{{ PLACEHOLDER_HINTS.nlClose }}</code> 条件段,按「生成自然语言」开关取舍。
        </p>
        <BbiTextarea v-model="systemDraft" :rows="12" placeholder="留空 = 内置默认" />
        <p class="bbi-field-state">
          {{ settings.autoTag.prompts.relaySystem.trim() ? '已自定义' : '默认' }} ·
          {{ effectiveSystem.length }} 字
        </p>

        <hr class="bbi-rule" />

        <div class="bbi-field-head">
          <span class="bbi-field-label">编译规范</span>
          <button class="bbi-btn bbi-btn-sm" type="button" @click="resetSpec">恢复默认</button>
        </div>
        <p class="bbi-field-hint">
          追加在 system 之后的书写规范:标准 danbooru 词、数量约束、多人绑定、禁止字面量。
          留空用内置默认;清成空串仍然保留默认(想彻底不要规范就填一个空格)。
        </p>
        <BbiTextarea v-model="specDraft" :rows="8" placeholder="留空 = 内置默认" />
        <p class="bbi-field-state">
          {{ settings.autoTag.prompts.relaySpec.trim() ? '已自定义' : '默认' }} · {{ effectiveSpec.length }} 字
        </p>
      </Collapsible>

      <!-- 恒定画风 / 负面词 -->
      <Collapsible title="恒定词与画幅" :open="false">
        <div class="bbi-field">
          <div class="bbi-field-head"><span class="bbi-field-label">恒定画风词</span></div>
          <input v-model="relay.styleSuffix" class="bbi-input" type="text" placeholder="masterpiece, best quality, anime style" />
          <p class="bbi-field-hint">
            <strong>前置</strong>在正向提示词最前面:CLIP 对越靠前的 token 越敏感,不少工作流只吃前 75 个 token。
            留空 = 不追加。内置链的恒定词在「渠道」页各后端里,这里只作用于中转站这条链。
          </p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head"><span class="bbi-field-label">恒定负面词</span></div>
          <input v-model="relay.negative" class="bbi-input" type="text" placeholder="lowres, bad anatomy, …" />
          <p class="bbi-field-hint">同样前置在负面提示词最前面;合成本身按小写去重,不会出现两遍。</p>
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">让模型额外输出负面词</span>
          <input v-model="relay.wantNegative" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          开启后要求模型用 <code>POSITIVE:</code> / <code>NEGATIVE:</code> 分段;负面与恒定负面词合成后写入负面通道。
        </p>

        <hr class="bbi-rule" />

        <div class="bbi-num-row">
          <span class="bbi-field-label">失败重试次数</span>
          <input v-model.number="relay.retryCount" class="bbi-input bbi-num" type="number" min="0" max="5" step="1" />
        </div>
        <p class="bbi-field-hint">请求异常、返回解析不过都算失败;0 = 不重试。</p>

        <div class="bbi-field">
          <div class="bbi-field-head"><span class="bbi-field-label">分段标记</span></div>
          <input v-model="relay.segmentMark" class="bbi-input" type="text" placeholder="[[图]]" />
          <p class="bbi-field-hint">
            正文里写它就在那里切一张图,张数以标记数量为准;没有标记时按「单楼最多图片数」均分。
          </p>
        </div>

        <div class="bbi-num-row">
          <span class="bbi-field-label">正文最大字符数</span>
          <input v-model.number="relay.maxStoryChars" class="bbi-input bbi-num" type="number" min="0" step="500" />
        </div>
        <p class="bbi-field-hint">超长时保留尾部(高潮通常在后面);0 = 不截断。</p>

        <hr class="bbi-rule" />

        <div class="bbi-field-head"><span class="bbi-field-label">当前工作流</span></div>
        <p class="bbi-field-hint">
          {{ comfyPresetName }} ·
          {{ comfyWorkflowHasPlaceholder
            ? '写入了 %prompt% 占位符,按占位符逐字替换。'
            : '没有 %prompt% 占位符,客户端会自动找到 CLIPTextEncode 节点写入(正向写第一个,负面写带负面词的那个)。' }}
        </p>
      </Collapsible>

      <!-- purge 层 -->
      <Collapsible title="指令权威层(purge)" :open="false">
        <label class="bbi-switch-row">
          <span class="bbi-field-label">启用 purge 层</span>
          <input v-model="relay.purge.enabled" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          中转站多半是没打过补丁的官网端点,同样的正文容易被"文雅化"成温和 tag。这一层补上那段差距;
          关掉 = 完全按原样发送。
        </p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">system 前压入权威声明</span>
          <input v-model="relay.purge.injectSystem" type="checkbox" class="bbi-checkbox" :disabled="!relay.purge.enabled" />
        </label>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">assistant prefill 起头</span>
          <input v-model="relay.purge.prefill" type="checkbox" class="bbi-checkbox" :disabled="!relay.purge.enabled" />
        </label>
        <p class="bbi-field-hint">
          端点不接受 assistant 尾消息时会自动去掉 prefill 重发一次(部分第三方中转站会 400)。
        </p>
        <input v-model="relay.purge.prefillText" class="bbi-input" type="text" placeholder="POSITIVE:" :disabled="!relay.purge.enabled" />

        <label class="bbi-switch-row">
          <span class="bbi-field-label">反净化重写</span>
          <input v-model="relay.purge.rewrite" type="checkbox" class="bbi-checkbox" :disabled="!relay.purge.enabled" />
        </label>
        <p class="bbi-field-hint">正文有血腥/成人词、输出里却没有对应 tag 时按词表补回正面(只补正面,不污染负面)。</p>

        <div class="bbi-num-row">
          <span class="bbi-field-label">最多补几条 tag</span>
          <input
            v-model.number="relay.purge.maxExtraTags"
            class="bbi-input bbi-num"
            type="number"
            min="0"
            max="40"
            step="1"
            :disabled="!relay.purge.enabled"
          />
        </div>

        <div class="bbi-field-head">
          <span class="bbi-field-label">权威声明正文</span>
          <button class="bbi-btn bbi-btn-sm" type="button" @click="resetPurge">恢复默认</button>
        </div>
        <BbiTextarea v-model="relay.purge.systemPrompt" :rows="10" placeholder="留空 = 不压声明" />
      </Collapsible>
    </div>
  </section>
</template>

<style scoped>
.yg-model-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 160px;
  overflow: auto;
}

.yg-warn {
  color: var(--bbi-danger);
}

.yg-check {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}

.yg-check__text {
  margin: 6px 0 0;
  font-family: var(--bbi-font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--bbi-ink);
}

.bbi-field-state {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
</style>
