import { describe, expect, it } from 'vitest';
import { renderWorkflowTemplate } from '@/backends/comfyui';

/**
 * 尺寸占位符曾经被替换成 0 的回归。
 *
 * 症状在 ComfyUI 那边,不在本插件:
 *   prompt_outputs_failed_validation → node_errors.12
 *   invalid_input_type: Failed to convert an input value to a INT value (height ... 'NoneType')
 * 成因是 custom 模式在 generate.ts 里没把像素传下来,%height% 变成 0,
 * EmptyLatentImage 拿不到数。这里同时锁两条:
 *   1. 调用方给了像素 → 逐字写进 JSON,且是数字类型不是字符串;
 *   2. 调用方没给 → 用渠道尺寸对兜底;连渠道也没填 → 报中间那句人话错误。
 */
const WORKFLOW = JSON.stringify({
  3: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
  12: { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%' } },
});

const CONN = { portraitSize: '832×1216', landscapeSize: '1216×832' };

describe('backends/comfyui:尺寸占位符', () => {
  it('显式传入像素时按数字写进工作流', () => {
    const flow = renderWorkflowTemplate(WORKFLOW, {
      prompt: '1girl, standing',
      width: 832,
      height: 1216,
      size: 'portrait',
      seed: 1,
    });
    const node = flow['12'] as { inputs: { width: unknown; height: unknown } };
    expect(node.inputs.width).toBe(832);
    expect(node.inputs.height).toBe(1216);
    expect(typeof node.inputs.width).toBe('number');
  });

  it('没传像素时按方向取渠道尺寸兜底,不写成 0', () => {
    const flow = renderWorkflowTemplate(
      WORKFLOW,
      { prompt: '1girl, standing', size: 'landscape', seed: 1 },
      CONN,
    );
    const node = flow['12'] as { inputs: { width: unknown; height: unknown } };
    expect(node.inputs.width).toBe(1216);
    expect(node.inputs.height).toBe(832);
  });

  it('渠道也没填尺寸时给出可读错误,而不是把 0 发出去', () => {
    expect(() =>
      renderWorkflowTemplate(WORKFLOW, { prompt: '1girl', size: 'portrait', seed: 1 }),
    ).toThrow(/竖屏与横屏尺寸/);
  });

  it('工作流没用尺寸占位符时不受影响', () => {
    const plain = JSON.stringify({
      3: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
    });
    const flow = renderWorkflowTemplate(plain, { prompt: '1girl', seed: 1 });
    expect((flow['3'] as { inputs: { text: unknown } }).inputs.text).toBe('1girl');
  });

  it('不认识的 %xxx% 原样保留,不报错也不吞掉', () => {
    const flow = JSON.stringify({
      3: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
      9: { class_type: 'SaveImage', inputs: { filename_prefix: 'YG_%date%' } },
    });
    const rendered = renderWorkflowTemplate(flow, { prompt: '1girl', seed: 1 });
    expect((rendered['9'] as { inputs: { filename_prefix: unknown } }).inputs.filename_prefix).toBe('YG_%date%');
  });

  it('只替换完全等于占位符的字符串,正文里的 % 字样不动', () => {
    const flow = JSON.stringify({
      3: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } },
      5: { class_type: 'Note', inputs: { text: '进度 %p% of 100%' } },
    });
    const rendered = renderWorkflowTemplate(flow, { prompt: '1girl', seed: 1 });
    expect((rendered['5'] as { inputs: { text: unknown } }).inputs.text).toBe('进度 %p% of 100%');
  });
});
