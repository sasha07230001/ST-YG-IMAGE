import { afterEach, describe, expect, it } from 'vitest';

import { buildAutoTagMessages, autoTagProfile } from '@/autoTag/prompt';
import { applyPromptToClipNodes, parseWorkflowTemplate, renderWorkflowTemplate } from '@/backends/comfyui';
import { settings, type AutoTagSettings } from '@/state/settings';
import type { STContext } from '@/st/context';

/**
 * 中转站模式的协议形态与 ComfyUI 定位式写入的回归锁。
 *
 * 两条都属于「粘进来就要能用」的改动:
 * 1. 中转站模式必须**不发**结构化协议(位置 ID 之外的 images/changes 术语会把模型带偏),
 *    但必须仍然给出位置 ID 清单与画幅提示;
 * 2. 工作流里没有 %prompt% 时不再报错,改为定位 CLIPTextEncode 写入。
 */

function context(): STContext {
  return {
    chat: [
      { name: 'User', is_user: true, is_system: false, mes: '上一层' },
      { name: 'Char', is_user: false, is_system: false, mes: '她推开门,雨声涌了进来。\n\n远处霓虹在水里化开。' },
    ],
    chatMetadata: {},
    name1: 'User',
    name2: 'Char',
    getCurrentChatId: () => 'chat-relay',
  } as unknown as STContext;
}

function options(overrides: Partial<AutoTagSettings> = {}): AutoTagSettings {
  return {
    ...settings.autoTag,
    minImages: 1,
    maxImages: 2,
    ...overrides,
  };
}

const originalMode = settings.autoTag.prompts.mode;
afterEach(() => {
  settings.autoTag.prompts.mode = originalMode;
  settings.autoTag.prompts.relaySystem = '';
  settings.autoTag.prompts.relaySpec = '';
});

describe('autoTag/prompt:中转站模式', () => {
  it('autoTagProfile 读到 mode=relay', () => {
    settings.autoTag.prompts.mode = 'relay';
    expect(autoTagProfile().mode).toBe('relay');
  });

  // 0.7: 提示词方式只决定「发给哪台模型」,协议只有一份 —— 中转站模式下同样要维护
  // 角色固定外貌库、同样输出 images/changes/transient,只是额外多一段编译身份说明。
  it('同一份结构化协议:带 P 位置、带角色库与建档规则,只是不用内置那段开场身份', async () => {
    settings.autoTag.prompts.mode = 'relay';
    settings.autoTag.prompts.relaySystem = '【中转站编译员】';
    const messages = await buildAutoTagMessages(
      context(),
      1,
      options(),
      null,
      undefined,
      null,
      '',
      { naiCharPrompts: false, nl: false, lockedSize: null, mode: 'relay' },
    );
    const text = messages.map(m => m.content).join('\n');
    expect(text).toContain('P1');
    expect(text).toContain('P2');
    // 协议与内置链逐字相同:角色库、建档、位置规则都在
    expect(text).toContain('角色固定外貌库');
    expect(text).toContain('field:"new"');
    expect(text).toContain('3. position 必须是');
    // 编译身份说明压在破限词之后、角色卡之前
    expect(text.indexOf('【中转站编译员】')).toBeLessThan(text.indexOf('角色固定外貌库'));
    // 画幅提示追加在目标正文末尾
    expect(text).toContain('画幅:');
  });

  it('没填编译身份时,custom 提示词方式与原内置链一字不差', async () => {
    settings.autoTag.prompts.mode = 'relay';
    settings.autoTag.prompts.relaySystem = '';
    const relayMessages = await buildAutoTagMessages(context(), 1, options(), null, undefined, null, '', {
      naiCharPrompts: false,
      nl: false,
      lockedSize: null,
      mode: 'relay',
    });
    const builtinMessages = await buildAutoTagMessages(context(), 1, options(), null, undefined, null, '', {
      naiCharPrompts: false,
      nl: false,
      lockedSize: null,
      mode: 'builtin',
    });
    const relayText = relayMessages.map(m => m.content).join('\n');
    const builtinText = builtinMessages.map(m => m.content).join('\n');
    // relay 只多一行画幅提示;除它以外完全一致(证明协议真的没有分叉)
    expect(relayText.replace(/\n\n画幅:[^\n]*$/, '')).toBe(builtinText);
  });

  it('用户自定义 system 覆盖内置,占位符被替换', async () => {
    settings.autoTag.prompts.mode = 'relay';
    settings.autoTag.prompts.relaySystem = '【自定义】{{story}}｜{{note}}';
    settings.autoTag.prompts.relaySpec = '';
    const messages = await buildAutoTagMessages(context(), 1, options(), null, undefined, null, '第 2 张任务', {
      naiCharPrompts: false,
      nl: false,
      lockedSize: null,
      mode: 'relay',
    });
    const text = messages.map(m => m.content).join('\n');
    expect(text).toContain('【自定义】');
    expect(text).toContain('她推开门');
    expect(text).toContain('第 2 张任务');
  });
});

describe('backends/comfyui:没有 %prompt% 时定位写入', () => {
  /** 读某个节点写进去的提示词文本(工作流是 Record<string, unknown>,测试里只关心 inputs.text)。 */
  function textOfNode(workflow: Record<string, any>, id: string): string {
    return String(workflow[id]?.inputs?.text ?? '');
  }

  const rawWorkflow = JSON.stringify({
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'a photo of', clip: ['1', 0] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality, lowres', clip: ['1', 0] } },
    '6': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } },
  });

  it('正面写进第一个非负面节点,负面写进像负面词的那个', () => {
    const workflow = parseWorkflowTemplate(rawWorkflow);
    const out = applyPromptToClipNodes(workflow, '1girl, rain', 'blurry');
    expect(textOfNode(out, '3')).toBe('1girl, rain');
    expect(textOfNode(out, '4')).toBe('blurry');
    expect(Number((out['6'] as any).inputs.seed)).toBe(0);
  });

  it('renderWorkflowTemplate 无 %prompt% 不再抛错(踩中「粘贴 API 工作流」的主路径)', () => {
    const out = renderWorkflowTemplate(rawWorkflow, { prompt: '1girl, rain', negative_prompt: 'blurry' });
    expect(textOfNode(out, '3')).toBe('1girl, rain');
  });

  it('有 %prompt% 时完全按占位符走,不碰其它文本节点', () => {
    const template = JSON.stringify({
      '3': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: '固定负面' } },
    });
    const out = renderWorkflowTemplate(template, { prompt: '1girl', negative_prompt: 'x' });
    expect(textOfNode(out, '3')).toBe('1girl');
    expect(textOfNode(out, '4')).toBe('固定负面');
  });

  it('既没占位符也没文本节点时给出可执行的提示', () => {
    const template = JSON.stringify({ '1': { class_type: 'KSampler', inputs: { seed: 0 } } });
    expect(() => renderWorkflowTemplate(template, { prompt: 'x' })).toThrow(/CLIPTextEncode/);
  });
});
