<script setup lang="ts">
import { computed, ref } from 'vue';

import BbiTextarea from '@/components/BbiTextarea.vue';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { compilePrompt, fetchRelayModels, testRelayConnection } from '@/relay/client';
import { normalizeRelayUrl } from '@/relay/prompt';
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
import { buildAutoTagMessages, autoTagProfile } from '@/autoTag/prompt';
import { parseImagePlan } from '@/autoTag/protocol';
import { getContext, isAiStoryMessage } from '@/st/context';
import { parseImageTags, stripImageTags } from '@/st/imageTagRegex';

/**
 * 「中转站」页:给整条提示词链换一台模型(OpenAI 兼容端点)。
 *
 * 0.7 起这里不再是「另一条链」:协议(images/changes/transient 的 JSON)、上下文装配、
 * 角色固定外貌库、建档规则、验收、写回楼层 tag、出图全部与内置 LLM 同一份代码,
 * 唯一差别是这次请求发到哪台模型。所以这一页只做三件事:
 * 1. 选这台模型还是内置 —— 全插件唯一的模型出口开关;
 * 2. 配置中转站(地址/密钥/模型/温度/超时/拉模型/测试);
 * 3. 编辑这一轮的开场身份与书写规范,并给一个「自检」按钮:用当前楼梯正文真跑一遍,
 *    把最终会写进 tag 的那份 JSON 原样显示出来——不烧出图渠道就能验证协议。
 */

const MODE_OPTIONS: { value: TagPromptMode; label: string }[] = [
  { value: 'builtin', label: '内置 LLM' },
  { value: 'relay', label: '中转站模型' },
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
const checkSummary = ref('');

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
 * 自检:同一段正文 → 与正式链路同一份消息装配 → 真跑一次 → 用同一份协议解析。
 *
 * 刻意不写正文、不出图:这一步只是让用户看见「模型会给我什么」。
 * 0.7 起它不再是「纯文本编译」的小路:它调用 buildAutoTagMessages(与 runner 同一函数,
 * 带 jailbreak/角色卡/世界书/规范/建档规则/示例 JSON)并用 parseImagePlan 验收,
 * 所以自检通过 ≈ 正式链路能解析;自检报的错就是出图时会真报的那个错。
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
    const ctx = getContext();
    if (!ctx) {
      checkError.value = '拿不到当前聊天上下文';
      return;
    }
    const profile = autoTagProfile();
    const messages = await buildAutoTagMessages(
      ctx,
      picked.floor,
      settings.autoTag,
      null,
      prepared,
      null,
      '',
      profile,
    );
    const raw = await compilePrompt(
      {
        url: relay.url,
        key: relay.key,
        model: relay.model,
        temperature: relay.temperature,
        maxTokens: relay.maxTokens,
        timeoutSec: relay.timeoutSec,
        purge: relay.purge,
      },
      messages,
      { allowUrlFallback: true },
    );
    checkOutput.value = raw.trim();
    // 与 runner 完全同一个解析器 + 同样的上下限:少一张、位置算歪、建档缺字段都会在这里报。
    const plan = parseImagePlan(
      raw,
      prepared.segments,
      Math.max(0, settings.autoTag.minImages),
      Math.max(1, settings.autoTag.maxImages),
    );
    const shots = plan.images.map(img => `${img.position} ${img.size ?? '-'}`).join(' / ');
    console.info(
      `${DIAGNOSTIC_PREFIX} floor=${picked.floor} segments=${prepared.segments.length} ` +
        `images=${plan.images.length} changes=${plan.changes.length} transient=${plan.transient.length} len=${raw.length}`,
    );
    if (!plan.images.length) checkError.value = '协议解析通过,但这楼没有选中任何画面(images 为空)';
    else if (plan.images.length < Math.max(0, settings.autoTag.minImages))
      checkError.value = `只给出 ${plan.images.length} 张,少于设置的最少 ${settings.autoTag.minImages} 张`;
    else checkError.value = '';
    checkSummary.value = `解析通过:${plan.images.length} 张( ${shots} ),建档/永久变化 ${plan.changes.length} 条,穿戴 ${plan.transient.length} 条`;
  } catch (error) {
    checkError.value = error instanceof Error ? error.message : String(error);
    checkSummary.value = '';
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
        正文交给一个 OpenAI 兼容模型完成同一件事:选画面、写 tag、维护角色固定外貌库、编译成英文提示词。
        协议与内置 LLM 完全同一份 —— 楼层卡片、出图、图库与队列也共用,差的只是这次请求发给哪台模型。
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
          这条开关只决定 <strong>这一次请求发给哪台模型</strong>。两条口径下协议完全相同:
          都是「选画面 + 写 tag + 维护角色固定外貌库 + 记录这一刻的穿戴」的一次调用,
          返回同一份带 <code>images</code> / <code>changes</code> / <code>transient</code> 的 JSON,
          写回正文的方式、验收标准与出图路径也一字不差。<br />
          <strong>内置 LLM</strong>:走设置页「生成 tag 使用」那个渠道(主 API 或副 API)。<br />
          <strong>中转站模型</strong>:改由下面填的 OpenAI 兼容端点承担同一次调用 ——
          模型更便宜/更准时换这里,协议不会变,角色库与建档规则照样生效。
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
      <Collapsible title="开场身份与书写规范" :open="false">
        <div class="bbi-field-head">
          <span class="bbi-field-label">system 提示词</span>
          <button class="bbi-btn bbi-btn-sm" type="button" @click="resetSystem">恢复默认</button>
        </div>
        <p class="bbi-field-hint">
          这里是这次调用的<strong>开场身份</strong>,排在破限词之后、角色卡与世界书之前;
          内置那条结构化契约(选画面 / 建档 / 示例 JSON)照旧跟在后面,两者是叠加关系。
          占位符:<code>{{ PLACEHOLDER_HINTS.story }}</code> 剧情正文、<code>{{ PLACEHOLDER_HINTS.note }}</code> 任务提示、
          <code>{{ PLACEHOLDER_HINTS.index }}</code>/<code>{{ PLACEHOLDER_HINTS.count }}</code> 第几张、
          <code>{{ PLACEHOLDER_HINTS.orientation }}</code> 画幅。留空 = 不追加开场身份(与内置链一字不差)。
          另支持 <code>{{ PLACEHOLDER_HINTS.nlOpen }}…{{ PLACEHOLDER_HINTS.nlClose }}</code> 条件段,按「生成自然语言」开关取舍。
        </p>
        <BbiTextarea v-model="systemDraft" :rows="12" placeholder="留空 = 不追加,只用内置契约" />
        <p class="bbi-field-state">
          {{ settings.autoTag.prompts.relaySystem.trim() ? '已自定义' : '默认(空)' }} ·
          {{ effectiveSystem.length }} 字
        </p>

        <hr class="bbi-rule" />

        <div class="bbi-field-head">
          <span class="bbi-field-label">编译规范</span>
          <button class="bbi-btn bbi-btn-sm" type="button" @click="resetSpec">恢复默认</button>
        </div>
        <p class="bbi-field-hint">
          追加在 system 之后的<strong>书写规范</strong>:标准 danbooru 词、数量约束、多人绑定、禁止字面量。
          与后端规范(ComfyUI / NAI)同时生效,不互相替代。
        </p>
        <BbiTextarea v-model="specDraft" :rows="8" placeholder="留空 = 不追加" />
        <p class="bbi-field-state">
          {{ settings.autoTag.prompts.relaySpec.trim() ? '已自定义' : '默认(空)' }} · {{ effectiveSpec.length }} 字
        </p>
      </Collapsible>

      <!-- 恒定画风 / 负面词 -->
      <Collapsible title="恒定词与画幅" :open="false">
        <p class="bbi-field-hint">
          <strong>恒定画风词与恒定负面词已不再由这一页管。</strong>
          正向提示词现在统一按「固定正面 → 角色 → 剧情」三层合成后写进
          <code>%prompt%</code>:固定正面取「渠道」页当前工作流的「提示词」那一格,
          角色层来自角色固定外貌库(常驻 + 这一刻的穿戴),剧情层就是 AI 编译出的画面词。
          想让某些词永远排在最前,填那一格即可,两条链都会照办。
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
            ? '写入了 %prompt% 占位符,三层合成的那一串按占位符逐字替换。'
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
