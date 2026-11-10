import { describe, expect, it } from 'vitest';

import {
  appendCharacterPrompts,
  composeCharacterPrompts,
  isTransientStale,
  mergeTagText,
  parseTransientReply,
  pruneTransientPrompts,
  cleanPromptFragment,
  isUsableFragment,
  type ChatBasePrompt,
  type TransientPromptState,
} from '@/autoTag/characterPrompts';
import { pickPresentNames } from '@/autoTag/characterPrompts';
import { normalizeCharacterPromptSettings } from '@/state/settings';

/**
 * 常驻 / 临时提示词的纯函数测试。
 *
 * 这一层最贵的三处错误都在这里锁住:
 * 1. 临时状态被送给了**不在场**的角色(凭空多一个人的头号成因);
 * 2. 常驻与临时两串同时进 CLIP(衣服糊成一片);
 * 3. 同一段 tag 被追加两遍(权重翻倍,构图跑偏)。
 */

function base(overrides: Partial<ChatBasePrompt> = {}): ChatBasePrompt {
  return { enabled: true, general: '', byChar: {}, ...overrides };
}

function transient(overrides: Partial<TransientPromptState> = {}): TransientPromptState {
  return { enabled: true, entries: [], ...overrides };
}

describe('角色档案提示词:合成顺序', () => {
  it('通用常驻 → 角色常驻 → 角色临时(有临时的那位由临时接管其常驻)', () => {
    const result = composeCharacterPrompts({
      entries: [],
      base: base({ general: 'film grain', byChar: { 小雪: 'silver pendant', 阿强: 'red jacket' } }),
      transient: transient({
        entries: [{ name: '小雪', prompt: 'white dress', frozen: false, floor: 3, at: 0 }],
      }),
      present: ['阿强', '小雪'],
    });
    // 阿强没有临时状态 → 常驻照旧;小雪有 → 她的常驻被白裙接管
    expect(result.text).toBe('film grain, red jacket, white dress');
  });

  it('临时状态顶掉同角色的常驻段,不会两串都进 CLIP', () => {
    const result = composeCharacterPrompts({
      entries: [],
      base: base({ byChar: { 小雪: 'white dress' } }),
      transient: transient({
        entries: [{ name: '小雪', prompt: 'black lace bra', frozen: false, floor: 3, at: 0 }],
      }),
      present: ['小雪'],
    });
    expect(result.text).toBe('black lace bra');
    expect(result.text).not.toContain('white dress');
  });

  it('不在场的角色不出现在结果里', () => {
    const result = composeCharacterPrompts({
      entries: [],
      base: base({ general: 'g', byChar: { 小雪: 'white dress', 阿强: 'red jacket' } }),
      transient: transient({
        entries: [{ name: '阿强', prompt: 'black suit', frozen: false, floor: 1, at: 0 }],
      }),
      present: ['小雪'],
    });
    expect(result.text).toBe('g, white dress');
    expect(result.text).not.toContain('black suit');
  });

  it('在场者未知(空数组)时只取通用常驻,绝不带上任何角色穿着', () => {
    const result = composeCharacterPrompts({
      entries: [],
      base: base({ general: 'g', byChar: { 小雪: 'white dress' } }),
      transient: transient({
        entries: [{ name: '小雪', prompt: 'black lace bra', frozen: false, floor: 1, at: 0 }],
      }),
      present: [],
    });
    expect(result.text).toBe('g');
  });

  it('generalOnly 只出通用段(公开接口口径)', () => {
    const result = composeCharacterPrompts({
      entries: [],
      base: base({ general: 'g', byChar: { 小雪: 'white dress' } }),
      transient: transient({
        entries: [{ name: '小雪', prompt: 'black lace bra', frozen: false, floor: 1, at: 0 }],
      }),
      present: ['小雪'],
      generalOnly: true,
    });
    expect(result.text).toBe('g');
  });

  it('两个开关各自独立:关掉常驻不影响临时,关掉临时则只留常驻', () => {
    const transients = transient({
      entries: [{ name: '小雪', prompt: 'black lace bra', frozen: false, floor: 1, at: 0 }],
    });
    // 常驻关了:只剩临时那一串(常驻里的白裙不该跟进来)
    const baseOff = composeCharacterPrompts({
      entries: [],
      base: base({ enabled: false, byChar: { 小雪: 'white dress' } }),
      transient: transients,
      present: ['小雪'],
    });
    expect(baseOff.text).toBe('black lace bra');

    // 临时关了:只剩常驻
    const transientOff = composeCharacterPrompts({
      entries: [],
      base: base({ general: 'g', byChar: { 小雪: 'white dress' } }),
      transient: { enabled: false, entries: transients.entries },
      present: ['小雪'],
    });
    expect(transientOff.text).toBe('g, white dress');
  });

  it('同一段 tag 只出现一次(大小写无关)', () => {
    const result = composeCharacterPrompts({
      entries: [],
      base: base({ general: '1girl', byChar: { 小雪: '1Girl' } }),
      transient: transient(),
      present: ['小雪'],
    });
    expect(result.text).toBe('1girl');
  });

  it('含 bbi_image 子标签字面量的脏数据被丢弃', () => {
    const result = composeCharacterPrompts({
      entries: [],
      base: base({ general: '</bbi_image>', byChar: { 小雪: 'white dress' } }),
      transient: transient(),
      present: ['小雪'],
    });
    expect(result.text).toBe('white dress');
  });

  it('全空时返回空串', () => {
    expect(composeCharacterPrompts({ entries: [], base: base(), transient: transient() }).text).toBe('');
  });
});

describe('角色档案提示词:拼到 CLIP 末尾', () => {
  it('追加在画面 tag 之后,不破坏原有逗号', () => {
    expect(appendCharacterPrompts('1girl, rain', 'white dress')).toBe('1girl, rain, white dress');
    expect(appendCharacterPrompts('1girl, rain,', 'white dress')).toBe('1girl, rain, white dress');
  });

  it('任一侧为空时原样返回(含只有空白)', () => {
    expect(appendCharacterPrompts('1girl', '')).toBe('1girl');
    expect(appendCharacterPrompts('1girl', '   ')).toBe('1girl');
    expect(appendCharacterPrompts('', 'white dress')).toBe('white dress');
  });
});

describe('临时状态:过期判定', () => {
  it('往后(楼层前进)永远保留', () => {
    expect(isTransientStale(3, 4)).toBe(false);
    expect(isTransientStale(3, 30)).toBe(false);
    expect(isTransientStale(3, 3)).toBe(false);
  });

  it('往回 ≤2 楼保留(重跑上一层是常规操作)', () => {
    expect(isTransientStale(5, 4)).toBe(false);
    expect(isTransientStale(5, 3)).toBe(false);
  });

  it('往回 3 楼以上作废(当前 2 楼:5 楼太远,1 楼是过去、仍保留)', () => {
    expect(isTransientStale(5, 2)).toBe(true);
    expect(isTransientStale(1, 2)).toBe(false);
    expect(pruneTransientPrompts([
      { name: 'a', prompt: 'x', frozen: false, floor: 5, at: 0 },
      { name: 'b', prompt: 'y', frozen: false, floor: 1, at: 0 },
    ], 2).map(e => e.name)).toEqual(['b']);
  });
});

describe('临时状态:解析模型输出', () => {
  const known = ['小雪', '阿强'];

  it('解析扁平 JSON 对象', () => {
    expect(parseTransientReply('{"小雪":"white dress, wet hair"}', known)).toEqual([
      { name: '小雪', prompt: 'white dress, wet hair', cleared: false },
    ]);
  });

  it('解析数组形态与代码块', () => {
    const raw = '```json\n[{"name":"阿强","prompt":"red jacket"}]\n```';
    expect(parseTransientReply(raw, known)).toEqual([
      { name: '阿强', prompt: 'red jacket', cleared: false },
    ]);
  });

  it('空串表示「这一刻不需要覆盖」(即清空)', () => {
    expect(parseTransientReply('{"小雪":""}', known)).toEqual([
      { name: '小雪', prompt: '', cleared: true },
    ]);
  });

  it('不在已知列表里的名字被丢弃(不给路人建档)', () => {
    expect(parseTransientReply('{"路人甲":"grey cloak"}', known)).toEqual([]);
  });

  it('JSON 解析不了时退回「名字: 串」逐行', () => {
    const raw = '小雪: white dress\n阿强: 红夹克';
    expect(parseTransientReply(raw, known).map(i => i.name)).toEqual(['小雪', '阿强']);
  });

  it('剥掉 think 块后再解析', () => {
    const raw = '<thinking>先想想</thinking>{"小雪":"blue skirt"}';
    expect(parseTransientReply(raw, known)[0].prompt).toBe('blue skirt');
  });

  it('乱七八糟的输出返回空数组,不抛错', () => {
    expect(parseTransientReply('我不知道', known)).toEqual([]);
    expect(parseTransientReply('', known)).toEqual([]);
  });

  it('已知列表为空时不做名字白名单过滤(允许按正文自行判断)', () => {
    expect(parseTransientReply('{"任何人":"x"}', [])).toEqual([
      { name: '任何人', prompt: 'x', cleared: false },
    ]);
  });
});

describe('提示词片段清洗', () => {
  it('换行压成空格并去首尾空白', () => {
    expect(cleanPromptFragment('  a,\nb  ')).toBe('a, b');
  });

  it('标签字面量判定', () => {
    expect(isUsableFragment('white dress')).toBe(true);
    expect(isUsableFragment('<size>portrait</size>')).toBe(false);
    expect(isUsableFragment('')).toBe(false);
  });
});

describe('设置层:常驻/临时存储清洗', () => {
  it('老数据(无该键)回落默认且不抛错', () => {
    const out = normalizeCharacterPromptSettings(undefined);
    expect(out.base.enabled).toBe(true);
    expect(out.base.byChar).toEqual({});
    expect(out.transient.entries).toEqual([]);
  });

  it('去掉空名、空文本与重复名', () => {
    const out = normalizeCharacterPromptSettings({
      base: { enabled: false, general: 'g', byChar: { '': 'x', ' 小雪 ': 'white dress', 阿强: '' } },
      transient: {
        enabled: true,
        entries: [
          { name: '小雪', prompt: 'a', frozen: true, floor: 3, at: 1 },
          { name: '小雪', prompt: 'b' },
          { name: '', prompt: 'c' },
        ],
      },
    });
    expect(out.base.enabled).toBe(false);
    expect(out.base.byChar).toEqual({ 小雪: 'white dress' });
    expect(out.transient.entries).toEqual([
      { name: '小雪', prompt: 'a', frozen: true, floor: 3, at: 1 },
    ]);
  });

  it('脏 floor/at 归零而不是变成 NaN', () => {
    const out = normalizeCharacterPromptSettings({
      transient: { enabled: true, entries: [{ name: 'a', prompt: 'x', floor: 'bad', at: null }] },
    });
    expect(out.transient.entries[0].floor).toBe(0);
    expect(out.transient.entries[0].at).toBe(0);
  });
});

describe('mergeTagText', () => {
  it('去空、按小写去重、保持首次出现的顺序', () => {
    expect(mergeTagText('a, b', undefined, ' B , c ', 'a')).toBe('a, b, c');
  });
});

describe('pickPresentNames:角色层取词的白名单', () => {
  it('提示词里点到的名字才算在场', () => {
    expect(pickPresentNames(['小雪', '阿岚'], '1girl, silver hair, 小雪站在雨里')).toEqual(['小雪']);
  });

  it('结构化角色名一律算在场', () => {
    expect(pickPresentNames(['小雪'], '1girl, standing')).toEqual([]);
    expect(pickPresentNames(['小雪'], '1girl, standing, 小雪')).toEqual(['小雪']);
  });

  it('英文 tag 名按词边界匹配,不被子串命中', () => {
    expect(pickPresentNames(['rin'], '1girl, grinning, outdoors')).toEqual([]);
    expect(pickPresentNames(['rin'], '2girls, rin, standing')).toEqual(['rin']);
  });

  it('长名优先,短名不吃掉长名的档案', () => {
    expect(pickPresentNames(['小雪', '小雪乃'], '小雪乃在窗边')).toEqual(['小雪乃']);
    expect(pickPresentNames(['小雪', '小雪乃'], '小雪乃和小雪')).toEqual(['小雪', '小雪乃']);
  });

  it('一个都没认出或提示词为空时返回空数组', () => {
    expect(pickPresentNames(['小雪'], '1girl, standing')).toEqual([]);
    expect(pickPresentNames(['小雪'], '')).toEqual([]);
    expect(pickPresentNames([], '小雪')).toEqual([]);
    expect(pickPresentNames([null, '  '], '小雪')).toEqual([]);
  });

  it('结果保持候选原顺序,不随长度排序漂移', () => {
    expect(pickPresentNames(['阿岚', '小雪乃'], '小雪乃与阿岚')).toEqual(['阿岚', '小雪乃']);
  });
});
