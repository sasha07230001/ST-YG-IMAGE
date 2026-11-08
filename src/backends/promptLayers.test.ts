import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SEPARATOR,
  LAYER_ORDER,
  buildPromptLayers,
  composeLayeredPrompt,
  legacyJoin,
  normalizeLayerOrder,
  pinFixedFirst,
  splitTags,
  tagKey,
} from '@/backends/promptLayers';

/**
 * 分层拼接的回归网。
 *
 * 这一份测试的重点不在「拼字符串」本身,而在几条**用户看不见但会被坑到**的口径:
 * 1. 顺序恒为 固定正面 → 角色 → 剧情(用户原话:按重要值决定插入顺序);
 * 2. 空层不能在成品里留多余分隔符(否则 CLIP 会吃进 `, ,`);
 * 3. 去重必须保「先出现的层」——固定正面写过 `silver hair`,角色层的就别再发一遍;
 * 4. 预算从末层末尾砍,固定正面永远保得住。
 */

function layersOf(source: Parameters<typeof buildPromptLayers>[0], options?: Parameters<typeof buildPromptLayers>[1]) {
  const result = buildPromptLayers(source, options);
  return Object.fromEntries(result.layers.map(layer => [layer.id, layer.text]));
}

describe('tagKey', () => {
  it('去掉权重后缀与括号、统一下划线与空格', () => {
    expect(tagKey('(Silver_Hair):1.2')).toBe('silver hair');
    expect(tagKey('{red eyes}:0.8')).toBe('red eyes');
    expect(tagKey('  long   hair  ')).toBe('long hair');
  });

  it('砍权重必须在脱括号之前,否则会剩孤儿右括号', () => {
    expect(tagKey('(Silver_Hair):1.2')).not.toContain(')');
  });

  it('空串与非字符串都归一成空串', () => {
    expect(tagKey('')).toBe('');
    expect(tagKey(undefined as unknown as string)).toBe('');
  });
});

describe('splitTags', () => {
  it('按逗号/顿号/换行切,不吃括号内的逗号', () => {
    expect(splitTags('a, b，c、d\ne')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(splitTags('(a, b):1.1, c')).toEqual(['(a, b):1.1', 'c']);
  });

  it('空片段不产出空 tag', () => {
    expect(splitTags('a,,  ,b')).toEqual(['a', 'b']);
    expect(splitTags('   ')).toEqual([]);
  });
});

describe('buildPromptLayers 顺序', () => {
  it('三层按 固定正面 → 角色 → 剧情 拼接', () => {
    const result = buildPromptLayers({
      fixed: 'masterpiece, best quality',
      characterTag: 'silver hair, red eyes',
      story: '1girl, standing in the rain',
    });
    expect(result.text).toBe(
      'masterpiece, best quality, silver hair, red eyes, 1girl, standing in the rain',
    );
    expect(result.layers.map(layer => layer.id)).toEqual([...LAYER_ORDER]);
  });

  it('空层不在成品里留下多余分隔符', () => {
    expect(layersOf({ fixed: 'masterpiece', story: '1girl' }).character).toBe('');
    expect(buildPromptLayers({ story: '1girl' }).text).toBe('1girl');
    expect(buildPromptLayers({}).text).toBe('');
  });

  it('分隔符可换(顿号 / 换行)', () => {
    const source = { fixed: 'a, b', story: 'c' };
    expect(buildPromptLayers(source, { separator: '、' }).text).toBe('a、b、c');
    expect(buildPromptLayers(source, { separator: '\n' }).text).toBe('a\nb\nc');
  });
});

describe('buildPromptLayers 去重', () => {
  it('跨层去重保先出现的层', () => {
    const result = buildPromptLayers({
      fixed: 'masterpiece, best quality, silver hair',
      characters: [{ name: '绫濑', tag: 'silver hair, red eyes', nl: '' }],
      story: '1girl, silver_hair, standing',
    });
    expect(result.text).toBe('masterpiece, best quality, silver hair, red eyes, 1girl, standing');
    // 角色层的 silver hair + 剧情层的 silver_hair 各算一次
    expect(result.droppedDuplicates).toBe(2);
  });

  it('去重可关', () => {
    const result = buildPromptLayers(
      { fixed: 'silver hair', story: 'silver hair' },
      { dedupe: false },
    );
    expect(result.text).toBe('silver hair, silver hair');
    expect(result.droppedDuplicates).toBe(0);
  });

  it('权重写法与下划线写法归一到同一个词', () => {
    const result = buildPromptLayers({ fixed: '(Silver_Hair):1.2', story: 'silver hair' });
    expect(result.text).toBe('(Silver_Hair):1.2');
    expect(result.droppedDuplicates).toBe(1);
  });

  it('整层被前层吸收时,该层给出说明', () => {
    const result = buildPromptLayers({ fixed: 'red eyes', story: 'red eyes' });
    const story = result.layers.find(layer => layer.id === 'story');
    expect(story?.text).toBe('');
    expect(story?.note).toContain('重复项吸收');
  });
});

describe('buildPromptLayers 预算', () => {
  it('超预算从末层末尾往前砍,固定正面保住', () => {
    const result = buildPromptLayers(
      { fixed: 'a, b', characterTag: 'c, d', story: 'e, f' },
      { budget: 4 },
    );
    const texts = layersOf({ fixed: 'a, b', characterTag: 'c, d', story: 'e, f' }, { budget: 4 });
    expect(texts.fixed).toBe('a, b');
    expect(texts.character).toBe('c, d');
    expect(texts.story).toBe('');
    expect(result.droppedByBudget).toBe(2);
    expect(result.tagCount).toBe(4);
  });

  it('预算为 0 时不限', () => {
    const result = buildPromptLayers({ fixed: 'a, b, c, d, e' }, { budget: 0 });
    expect(result.tagCount).toBe(5);
    expect(result.droppedByBudget).toBe(0);
  });

  it('被砍的层带 truncated 标记', () => {
    const result = buildPromptLayers({ fixed: 'a, b', story: 'c, d, e' }, { budget: 3 });
    const story = result.layers.find(layer => layer.id === 'story');
    expect(story?.truncated).toBe(true);
    expect(story?.note).toContain('超出 tag 预算');
  });
});

describe('buildPromptLayers 角色层', () => {
  it('同名角色只保留第一份,名字进 duplicateCharacters', () => {
    const result = buildPromptLayers({
      characters: [
        { name: '绫濑', tag: 'silver hair', nl: '' },
        { name: '绫濑', tag: 'black hair', nl: '' },
      ],
    });
    expect(result.text).toBe('silver hair');
    expect(result.duplicateCharacters).toEqual(['绫濑']);
  });

  it('无 tag 时退回自然语言,两者都空则不占位', () => {
    const result = buildPromptLayers({
      characters: [
        { name: 'A', tag: '', nl: 'a girl with silver hair' },
        { name: 'B', tag: '', nl: '' },
      ],
    });
    expect(result.text).toBe('a girl with silver hair');
  });

  it('结构化角色与已合成档案串同时生效,角色在前', () => {
    const result = buildPromptLayers({
      characters: [{ name: 'A', tag: 'silver hair', nl: '' }],
      characterTag: 'red eyes',
    });
    expect(result.text).toBe('silver hair, red eyes');
  });
});

describe('buildPromptLayers 剧情层的自然语言', () => {
  it('preferNaturalLanguage 为真时用 nl 替掉 tag', () => {
    const result = buildPromptLayers(
      { story: '1girl, rain', storyNl: 'a girl standing in the rain' },
      { preferNaturalLanguage: true },
    );
    expect(result.text).toBe('a girl standing in the rain');
  });

  it('默认不吃 nl(ComfyUI 的 CLIP 走 tag)', () => {
    const result = buildPromptLayers({ story: '1girl, rain', storyNl: 'a girl in the rain' });
    expect(result.text).toBe('1girl, rain');
  });

  it('nl 为空时即便 preferNaturalLanguage 也退回 tag', () => {
    const result = buildPromptLayers(
      { story: '1girl', storyNl: '   ' },
      { preferNaturalLanguage: true },
    );
    expect(result.text).toBe('1girl');
  });
});

describe('composeLayeredPrompt 与 buildPromptLayers 同口径', () => {
  it('成品串一致', () => {
    const source = {
      fixed: 'masterpiece',
      characters: [{ name: 'A', tag: 'silver hair', nl: '' }],
      story: '1girl',
    };
    expect(composeLayeredPrompt(source)).toBe(buildPromptLayers(source).text);
  });
});

describe('legacyJoin', () => {
  it('旧口径:去空后按默认分隔符连接', () => {
    expect(legacyJoin('masterpiece', '', '1girl')).toBe(`masterpiece${DEFAULT_SEPARATOR}1girl`);
    expect(legacyJoin()).toBe('');
  });
});

describe('normalizeLayerOrder', () => {
  it('默认顺序原样返回', () => {
    expect(normalizeLayerOrder(LAYER_ORDER)).toEqual(['fixed', 'character', 'story']);
  });

  it('剔除非法 id,并把缺失的层补在末尾', () => {
    expect(normalizeLayerOrder(['story', 'bogus', 'fixed'])).toEqual([
      'story',
      'fixed',
      'character',
    ]);
  });

  it('重复 id 只留第一次出现的位置', () => {
    expect(normalizeLayerOrder(['story', 'story', 'fixed'])).toEqual([
      'story',
      'fixed',
      'character',
    ]);
  });

  it('非数组输入回落默认顺序', () => {
    expect(normalizeLayerOrder(undefined)).toEqual([...LAYER_ORDER]);
    expect(normalizeLayerOrder('fixed')).toEqual([...LAYER_ORDER]);
    expect(normalizeLayerOrder(42)).toEqual([...LAYER_ORDER]);
  });
});

describe('pinFixedFirst', () => {
  it('固定正面已在前时不动', () => {
    const result = pinFixedFirst(['fixed', 'story', 'character']);
    expect(result.corrected).toBe(false);
    expect(result.order).toEqual(['fixed', 'story', 'character']);
  });

  it('固定正面被挤到后面时挪回最前,其余相对顺序不变', () => {
    const result = pinFixedFirst(['story', 'character', 'fixed']);
    expect(result.corrected).toBe(true);
    expect(result.order).toEqual(['fixed', 'story', 'character']);
  });
});

describe('buildPromptLayers 的层顺序', () => {
  const source = {
    fixed: 'styleA',
    characterTag: 'charB',
    story: 'storyC',
  };

  it('默认顺序是 固定正面 → 角色 → 剧情', () => {
    expect(buildPromptLayers(source).text).toBe('styleA, charB, storyC');
  });

  it('传入 order 后成品串按它排', () => {
    expect(buildPromptLayers(source, { order: ['story', 'character', 'fixed'] }).text).toBe(
      'storyC, charB, styleA',
    );
  });

  it('脏 order 被清洗后再用,不会丢层', () => {
    const result = buildPromptLayers(source, { order: ['story', 'nope' as never] });
    expect(result.order).toEqual(['story', 'fixed', 'character']);
    expect(result.text).toBe('storyC, styleA, charB');
  });

  it('结果里回传本次实际使用的顺序', () => {
    const result = buildPromptLayers(source, { order: ['character', 'fixed', 'story'] });
    expect(result.order).toEqual(['character', 'fixed', 'story']);
    expect(result.layers.map(layer => layer.id)).toEqual(['character', 'fixed', 'story']);
  });

  it('顺序会改变去重的赢家:把剧情拖到最前,剧情词就不再被固定正面吸收', () => {
    const dup = { fixed: 'silver hair, styleA', characterTag: 'silver hair', story: 'storyC' };
    // 默认顺序:fixed 先占 silver hair,角色的那份被吸收
    expect(buildPromptLayers(dup).text).toBe('silver hair, styleA, storyC');
    // 角色拖到最前:角色那份先占,固定正面里的 silver hair 被吸收
    const reordered = buildPromptLayers(dup, { order: ['character', 'fixed', 'story'] });
    expect(reordered.text).toBe('silver hair, styleA, storyC');
    expect(reordered.droppedDuplicates).toBe(1);
  });

  it('预算从「末层末尾」砍,所以改顺序会改被砍的层', () => {
    const long = {
      fixed: 'f1, f2',
      characterTag: 'c1, c2',
      story: 's1, s2',
    };
    // 默认:末层是剧情 → 砍剧情
    const defaultCut = buildPromptLayers(long, { budget: 4 });
    expect(defaultCut.text).toBe('f1, f2, c1, c2');
    // 剧情拖到最前:末层变角色 → 砍角色
    const flippedCut = buildPromptLayers(long, { budget: 4, order: ['story', 'fixed', 'character'] });
    expect(flippedCut.text).toBe('s1, s2, f1, f2');
  });
});
