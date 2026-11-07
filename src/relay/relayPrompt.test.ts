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

  it('发的是编译协议:自带位置 ID 清单与画幅提示,不带 changes 建档规则', async () => {
    settings.autoTag.prompts.mode = 'relay';
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
    expect(text).toContain('CLIPTextEncode');
    // 内置链的那套建档口径不该出现在中转站请求里
    expect(text).not.toContain('角色固定外貌库');
    expect(text).not.toContain('field:"new"');
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
