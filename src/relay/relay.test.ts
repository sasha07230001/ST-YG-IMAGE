import { describe, expect, it } from 'vitest';

import {
  composeNegative,
  composePositive,
  joinTags,
  normalizeRelayUrl,
  alternateRelayUrl,
  renderTemplate,
  splitPosNeg,
  unwrapPromptReply,
  validatePrompt,
  withSegmentNote,
  cleanStoryText,
} from '@/relay/prompt';
import { planSegments, splitEven, splitByMark, DEFAULT_SEGMENT_MARK } from '@/relay/split';
import { injectPurge, rewriteDegraded, stripPrefill, withPrefill, REWRITE_RULES } from '@/relay/purge';

/**
 * 中转站链路的纯函数测试。
 *
 * 这一层的两个易坏点都在这里锁住:地址写法五花八门、模型爱在 tag 外面裹解释。
 * 全部不碰宿主,故不需要打桩 ST。
 */

describe('relay/prompt:URL 规范化', () => {
  it('纯域名补 /v1,已带路径原样保留', () => {
    expect(normalizeRelayUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1');
    expect(normalizeRelayUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com/v1');
    expect(normalizeRelayUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1');
    expect(normalizeRelayUrl('https://x.com/v2/coding')).toBe('https://x.com/v2/coding');
  });

  it('填了完整 /chat/completions 时只去掉端点后缀', () => {
    expect(normalizeRelayUrl('https://x.com/v1/chat/completions')).toBe('https://x.com/v1');
  });

  it('备用地址在 /v1 两侧互转', () => {
    expect(alternateRelayUrl('https://x.com/v1')).toBe('https://x.com');
    expect(alternateRelayUrl('https://x.com')).toBe('https://x.com/v1');
  });
});

describe('relay/prompt:清洗与验收', () => {
  it('剥掉代码块与「提示词:」前缀', () => {
    expect(unwrapPromptReply('```\n1girl, white dress\n```')).toBe('1girl, white dress');
    expect(unwrapPromptReply('提示词: 1girl, rain')).toBe('1girl, rain');
  });

  it('整段中文判失败,英文 tag 判通过', () => {
    expect(validatePrompt('一个女孩站在雨里').ok).toBe(false);
    expect(validatePrompt('1girl, standing in rain, neon lights').ok).toBe(true);
    expect(validatePrompt('').ok).toBe(false);
  });

  it('过长判失败(CLIP 会被截断)', () => {
    expect(validatePrompt('a'.repeat(2500)).ok).toBe(false);
  });

  it('清洗正文时去掉 HTML 与 Markdown 装饰', () => {
    const out = cleanStoryText('<div>**她推开门**,雨声涌了进来。</div>');
    expect(out).toContain('她推开门');
    expect(out).not.toContain('<div>');
    expect(out).not.toContain('**');
  });
});

describe('relay/prompt:正负分段与恒定词', () => {
  it('有 POSITIVE/NEGATIVE 标记时按标记拆', () => {
    const r = splitPosNeg('POSITIVE: 1girl, rain\nNEGATIVE: lowres, blurry');
    expect(r.positive).toBe('1girl, rain');
    expect(r.negative).toBe('lowres, blurry');
  });

  it('没有标记时整段算正面', () => {
    expect(splitPosNeg('1girl, rain')).toEqual({ positive: '1girl, rain', negative: '' });
  });

  it('恒定画风词前置,并按小写去重', () => {
    expect(composePositive('masterpiece, 1girl', '1girl, rain')).toBe('masterpiece, 1girl, rain');
    expect(composeNegative('lowres', 'blurry')).toBe('lowres, blurry');
    expect(joinTags('a, b', 'B, c')).toBe('a, b, c');
  });
});

describe('relay/prompt:模板与分段提示', () => {
  it('渲染占位符,未知宏原样保留', () => {
    const out = renderTemplate('正文:{{story}}|提示:{{note}}|{{orientation}}|{{unknown}}', {
      story: '雨夜',
      note: '只画第 1 张',
      orientation: 'portrait',
    });
    expect(out).toContain('正文:雨夜');
    expect(out).toContain('只画第 1 张');
    expect(out).toContain('竖构图');
    expect(out).toContain('{{unknown}}');
  });

  it('多张时追加「只画这一段」的限定,单张时不加', () => {
    expect(withSegmentNote('', { index: 0, count: 1 })).toBe('');
    expect(withSegmentNote('', { index: 1, count: 3 })).toContain('第 2/3 张');
  });
});

describe('relay/split:正文分段', () => {
  it('有标记按标记切', () => {
    const parts = splitByMark(`她推开门。\n${DEFAULT_SEGMENT_MARK}\n她抬起头。`, DEFAULT_SEGMENT_MARK);
    expect(parts).toEqual(['她推开门。', '她抬起头。']);
  });

  it('没标记按张数均分,优先空行', () => {
    const parts = splitEven('第一段。\n\n第二段。\n\n第三段。', 2);
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain('第一段');
  });

  it('段落不够时按句末标点切,绝不返回少于张数', () => {
    expect(splitEven('他来了。她走了。雨停了。', 3).length).toBe(3);
    // 只剩一段可切时按字符硬切补齐张数:宁可切开一句话,也不少出一张\n    expect(splitEven('短句', 4).length).toBe(4);\n    expect(splitEven('', 4).length).toBe(0);
  });

  it('planSegments 有标记以标记数量为准', () => {
    const story = `A。\n${DEFAULT_SEGMENT_MARK}\nB。\n${DEFAULT_SEGMENT_MARK}\nC。`;
    const segs = planSegments(story, { count: 1 });
    expect(segs.map(s => s.text)).toEqual(['A。', 'B。', 'C。']);
    expect(segs.map(s => s.index)).toEqual([0, 1, 2]);
  });

  it('空正文返回空分段', () => {
    expect(planSegments('   ')).toEqual([]);
  });
});

describe('relay/purge:指令权威层', () => {
  it('声明压在 system 最前面', () => {
    expect(injectPurge('任务', '声明')).toBe('声明\n\n---\n\n任务');
    expect(injectPurge('任务', '')).toBe('任务');
  });

  it('prefill 追加 assistant 尾消息,stripPrefill 是幂等反向操作', () => {
    const msgs = withPrefill([{ role: 'user', content: 'hi' }], 'POSITIVE:');
    expect(msgs[msgs.length - 1]).toEqual({ role: 'assistant', content: 'POSITIVE:' });
    expect(stripPrefill('POSITIVE: 1girl', 'POSITIVE:')).toBe('1girl');
    expect(stripPrefill('1girl', 'POSITIVE:')).toBe('1girl');
  });

  it('反净化把正文里有、输出里没有的 tag 补回去', () => {
    const r = rewriteDegraded('她的手臂被贯穿,鲜血流了一地,血肉模糊。', '1girl, standing, rain');
    expect(r.added).toContain('gore');
    expect(r.added).toContain('blood');
    expect(r.prompt).toContain('1girl');
  });

  it('已覆盖的 tag 不重复补,且受 maxExtraTags 限制', () => {
    const r = rewriteDegraded('鲜血直流', 'blood', 5);
    expect(r.added).toEqual(['blood splatter']);
    const limited = rewriteDegraded('血肉 内脏 尸体 鲜血 伤口', '1girl', 2);
    expect(limited.added.length).toBe(2);
  });

  it('词表每条规则都能编译(无坏正则)', () => {
    for (const rule of REWRITE_RULES) {
      expect(rule.pattern instanceof RegExp).toBe(true);
      expect(rule.tags.length).toBeGreaterThan(0);
    }
  });
});
