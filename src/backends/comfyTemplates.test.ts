import { describe, expect, it } from 'vitest';

import {
  COMFY_TEMPLATES,
  layerOptionsOf,
  negativeOptionsOf,
  normalizeSimpleConfig,
  simpleDefaults,
  buildSimpleWorkflow,
  composeNegative,
  composeNegativeLayersOf,
  composePositive,
  composePositiveLayers,
  composeCustomPositive,
  customLayerOptions,
} from '@/backends/comfyTemplates';

/**
 * 简易模式正向提示词的分层口径回归。
 *
 * 关注点:同一个 `composePositive` 必须同时支撑两种口径——
 *   - `layered !== false`:三层拼接(固定正面 → 角色 → 剧情);
 *   - `layered === false`:0.5.0 的旧行为(固定正面 + 剧情,角色不进 CLIP)。
 * 这两种口径在开关切换时不能有第三态,否则用户关掉分层后会看到「角色还在里面」。
 */

const PINNED_TEMPLATE = 'checkpoint' as const;

/**
 * 分层口径的测试只关心 words,不关心尺寸/种子 —— 但 `SimpleGenValues` 把 seed/width/height
 * 定为必填(工作流没有它们跑不起来),所以统一从这里补上占位值。
 */
function V(values: Partial<Parameters<typeof composePositive>[1]> = {}): Parameters<typeof composePositive>[1] {
  return { prompt: '', seed: 1, width: 832, height: 1216, ...values };
}

function config(overrides: Partial<ReturnType<typeof simpleDefaults>> = {}) {
  return { ...simpleDefaults(PINNED_TEMPLATE), model: 'illustrious_xl.safetensors', ...overrides };
}

/** 旧口径的基准配置:显式关掉分层。 */
function legacy(overrides: Partial<ReturnType<typeof simpleDefaults>> = {}) {
  return config({ layered: false, positive: 'masterpiece, best quality', ...overrides });
}

describe('simpleDefaults / normalizeSimpleConfig 的分层字段', () => {
  it('默认开分层、默认逗号连接、默认去重、默认不限预算', () => {
    const simple = simpleDefaults(PINNED_TEMPLATE);
    expect(simple.layered).toBe(true);
    expect(simple.layerSeparator).toBe(', ');
    expect(simple.dedupeTags).toBe(true);
    expect(simple.tagBudget).toBe(0);
  });

  it('清洗时把显式 false 保留,把垃圾值回落到默认', () => {
    const normalized = normalizeSimpleConfig({
      layered: false,
      layerSeparator: '',
      dedupeTags: false,
      tagBudget: -12,
    });
    expect(normalized.layered).toBe(false);
    expect(normalized.layerSeparator).toBe(', ');
    expect(normalized.dedupeTags).toBe(false);
    expect(normalized.tagBudget).toBe(0);
  });

  it('tagBudget 取整且不为负', () => {
    expect(normalizeSimpleConfig({ tagBudget: 42.6 }).tagBudget).toBe(43);
    expect(normalizeSimpleConfig({ tagBudget: -3 }).tagBudget).toBe(0);
    expect(normalizeSimpleConfig({ tagBudget: 'abc' }).tagBudget).toBe(0);
  });
});

describe('layerOptionsOf', () => {
  it('把三条旋钮映射成拼接选项', () => {
    const options = layerOptionsOf(config({ layerSeparator: '、', dedupeTags: false, tagBudget: 30 }));
    expect(options.separator).toBe('、');
    expect(options.dedupe).toBe(false);
    expect(options.budget).toBe(30);
  });
});

describe('composePositive 分层口径', () => {
  it('三层按 固定正面 → 角色 → 剧情 顺序拼', () => {
    const simple = config({ positive: 'masterpiece, best quality' });
    const text = composePositive(
      simple,
      V({
        prompt: '1girl, standing',
        characters: [{ name: '绫濑', tag: 'silver hair, red eyes', nl: '' }],
      }),
    );
    expect(text).toBe('masterpiece, best quality, silver hair, red eyes, 1girl, standing');
  });

  it('角色档案串(characterTag)也进角色层', () => {
    const simple = config({ positive: 'masterpiece' });
    const text = composePositive(
      simple,
      V({
        prompt: '1girl',
        characterTag: 'silver hair',
      }),
    );
    expect(text).toBe('masterpiece, silver hair, 1girl');
  });

  it('跨层去重默认生效', () => {
    const simple = config({ positive: 'masterpiece, silver hair' });
    const text = composePositive(
      simple,
      V({
        prompt: '1girl, silver_hair',
        characterTag: 'silver hair, red eyes',
      }),
    );
    expect(text).toBe('masterpiece, silver hair, red eyes, 1girl');
  });

  it('关掉去重后重复项保留', () => {
    const simple = config({ positive: 'silver hair', dedupeTags: false });
    expect(composePositive(simple, V({ prompt: 'silver hair' }))).toBe('silver hair, silver hair');
  });

  it('分层关闭时退回旧口径,角色层完全不发送', () => {
    const simple = legacy({ positive: 'masterpiece, best quality' });
    const text = composePositive(
      simple,
      V({
        prompt: '1girl',
        characters: [{ name: '绫濑', tag: 'silver hair', nl: '' }],
        characterTag: 'red eyes',
      }),
    );
    expect(text).toBe('masterpiece, best quality, 1girl');
  });

  it('旧口径下 nl 仍优先于 tag(0.5.0 原行为)', () => {
    const simple = legacy();
    expect(composePositive(simple, V({ prompt: '1girl', nl: 'a girl standing' }))).toBe(
      'masterpiece, best quality, a girl standing',
    );
  });

  it('newline 连接符生效', () => {
    const simple = config({ layerSeparator: '\n' });
    expect(composePositive(simple, V({ prompt: 'a, b' }))).toContain('a\nb');
  });

  it('空固定正面不产生前导分隔符', () => {
    const simple = config({ positive: '' });
    expect(composePositive(simple, V({ prompt: '1girl' }))).toBe('1girl');
  });

  it('预算从末层末尾砍,固定正面保住', () => {
    const simple = config({ positive: 'a, b', tagBudget: 3 });
    const text = composePositive(simple, V({ prompt: 'c, d, e' }));
    expect(text).toBe('a, b, c');
  });
});

describe('composePositiveLayers 与 composePositive 同口径', () => {
  it('成品串一致', () => {
    const simple = config({ positive: 'masterpiece' });
    const values = V({
      prompt: '1girl',
      characters: [{ name: 'A', tag: 'silver hair', nl: '' }],
    });
    expect(composePositiveLayers(simple, values).text).toBe(composePositive(simple, values));
  });

  it('给出每层的 tag 数与去重计数', () => {
    const simple = config({ positive: 'masterpiece, silver hair' });
    const result = composePositiveLayers(
      simple,
      V({
        prompt: '1girl, silver_hair',
        characters: [{ name: 'A', tag: 'silver hair', nl: '' }],
      }),
    );
    expect(result.layers.map(layer => layer.id)).toEqual(['fixed', 'character', 'story']);
    expect(result.droppedDuplicates).toBe(2);
    // masterpiece / silver hair / 1girl —— silver_hair 与角色层的 silver hair 都被去重吸收
    expect(result.tagCount).toBe(3);
  });
});

describe('buildSimpleWorkflow 把分层结果写进正向 CLIPTextEncode', () => {
  it('checkpoint 模板的正向节点吃到三层拼接', () => {
    const simple = config({ positive: 'masterpiece', steps: 20, cfg: 7 });
    const workflow = buildSimpleWorkflow(
      simple,
      V({
        prompt: '1girl',
        characters: [{ name: 'A', tag: 'silver hair', nl: '' }],
      }),
    ) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    const positiveNode = Object.values(workflow).find(
      node => node.class_type === 'CLIPTextEncode' && String(node.inputs.text).includes('masterpiece'),
    );
    expect(positiveNode).toBeDefined();
    expect(positiveNode?.inputs.text).toBe('masterpiece, silver hair, 1girl');
  });

  it('三个模板都在模板表里', () => {
    expect(Object.keys(COMFY_TEMPLATES).sort()).toEqual(['anima', 'checkpoint', 'flux']);
  });
});

/**
 * 负面的链路级回归。
 *
 * 正向测的是「层序对不对」;负面要测的是「真实的那个字符串有没有按分层口径生成」,
 * 因为负面不进预览页也会进工作流 —— 预览骗人的代价是每张图的手指数量。
 */
describe('composeNegative 的分层口径', () => {
  it('固定负面在前、本图排除在后', () => {
    const simple = config({ negative: 'worst quality, bad anatomy' });
    expect(composeNegative(simple, V({ negative: 'extra people' }))).toBe(
      'worst quality, bad anatomy, extra people',
    );
  });

  it('两段都空时返回空串,不给 ComfyUI 送去一个逗号', () => {
    expect(composeNegative(config({ negative: '' }), V())).toBe('');
  });

  it('动态词重复固定负面时只发一次', () => {
    const simple = config({ negative: 'lowres, worst quality' });
    const result = composeNegativeLayersOf(simple, V({ negative: 'lowres' }));
    expect(result.text).toBe('lowres, worst quality');
    expect(result.droppedDuplicates).toBe(1);
  });

  it('分隔符与正向共用', () => {
    const simple = config({ negative: 'lowres', layerSeparator: '\n' });
    expect(composeNegative(simple, V({ negative: 'blurry' }))).toBe('lowres\nblurry');
  });

  it('去重开关与正向共用', () => {
    const simple = config({ negative: 'lowres', dedupeTags: false });
    expect(composeNegative(simple, V({ negative: 'lowres' }))).toBe('lowres, lowres');
  });

  it('正向预算不会顺手砍负面', () => {
    // 用户为了 CLIP 的 75 token 把正向预算调成 60,负面的 anatomy 词不能被一起砍
    const simple = config({ negative: 'a, b, c, d, e', tagBudget: 2 });
    expect(composeNegative(simple, V({ negative: 'f, g' }))).toBe('a, b, c, d, e, f, g');
    expect(negativeOptionsOf(simple).budget).toBe(0);
  });

  it('composeNegativeLayersOf 与 composeNegative 同口径', () => {
    const simple = config({ negative: 'worst quality' });
    const values = V({ negative: 'extra people, extra people' });
    expect(composeNegativeLayersOf(simple, values).text).toBe(composeNegative(simple, values));
  });

  it('buildSimpleWorkflow 把负面写进负向 CLIPTextEncode', () => {
    const simple = config({ negative: 'worst quality, bad anatomy', steps: 20, cfg: 7 });
    const workflow = buildSimpleWorkflow(simple, V({ negative: 'extra people' })) as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    const negativeNode = Object.values(workflow).find(
      node => node.class_type === 'CLIPTextEncode' && String(node.inputs.text).includes('bad anatomy'),
    );
    expect(negativeNode).toBeDefined();
    expect(negativeNode?.inputs.text).toBe('worst quality, bad anatomy, extra people');
  });
});

/**
 * 自定义工作流(custom 模式)只有 `%prompt%` 一个入口,三层必须在这里先合成一串。
 *
 * 这是 0.7 修掉的那个真 bug:此前 custom 模式下固定正面与角色提示词被整段丢掉,
 * 用户以为「角色库失效」,其实是 generate.ts 走了 `comfyLayered = false` 那条老路。
 */
describe('custom 模式:%prompt% 三层合成', () => {
  it('按 固定正面 → 角色 → 剧情 的顺序拼成一串', () => {
    const text = composeCustomPositive(
      V({
        fixed: 'masterpiece, best quality',
        characterTag: 'silver hair, red eyes',
        prompt: '1girl, standing in the rain',
      }),
      true,
    );
    expect(text).toBe('masterpiece, best quality, silver hair, red eyes, 1girl, standing in the rain');
  });

  it('关掉分层退化成 固定正面 + 角色 + 剧情(角色仍在,不再整段消失)', () => {
    const text = composeCustomPositive(
      V({ fixed: 'masterpiece', characterTag: 'silver hair', prompt: '1girl' }),
      false,
    );
    expect(text).toBe('masterpiece, silver hair, 1girl');
  });

  it('固定正面留空时不产出前导分隔符', () => {
    const text = composeCustomPositive(V({ fixed: '   ', characterTag: 'silver hair', prompt: '1girl' }), true);
    expect(text).toBe('silver hair, 1girl');
  });

  it('自然语言模式:层选项声明 preferNaturalLanguage 时剧情层取 nl,否则仍发 tag 串', () => {
    const values = V({
      fixed: 'masterpiece',
      characterTag: 'silver hair',
      prompt: '1girl, rain',
      nl: 'a girl stands in the rain',
      layerOptions: { ...customLayerOptions(true), preferNaturalLanguage: true },
    });
    const nlText = composeCustomPositive(values, true);
    expect(nlText).toContain('a girl stands in the rain');
    expect(nlText).not.toContain('1girl, rain');
    // 默认口径(customLayerOptions)不偏自然语言:custom 模式沿用 simple.positive 的书写风格
    expect(
      composeCustomPositive(
        V({ fixed: 'masterpiece', characterTag: 'silver hair', prompt: '1girl, rain', nl: 'a girl stands in the rain' }),
        true,
      ),
    ).toBe('masterpiece, silver hair, 1girl, rain');
  });

  it('跨层去重:固定正面写过的词不会在角色层再发一遍', () => {
    const text = composeCustomPositive(
      V({ fixed: 'silver hair, masterpiece', characterTag: 'silver hair, red eyes', prompt: '1girl' }),
      true,
    );
    expect(text).toBe('silver hair, masterpiece, red eyes, 1girl');
  });

  it('custom 模式不吃 simple.tagBudget:没有那份配置就不该有预算上限', () => {
    expect(customLayerOptions(true).budget).toBe(0);
    expect(customLayerOptions(true).order).toEqual(['fixed', 'character', 'story']);
    expect(customLayerOptions(false).dedupe).toBe(true);
  });
});
