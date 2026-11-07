import { describe, expect, it } from 'vitest';

import { buildManualTagContent } from '@/floor/manualPrompt';
import { parseImageTagContent, parseImageTags, serializeImageTag } from '@/st/imageTagRegex';

/**
 * 手动提示词生图的纯逻辑测试。
 *
 * 这一层最容易错的三处:
 * 1. 空提示词写进正文(ComfyUI 当场报「正向提示词不能为空」,而用户只看到「点了没反应」);
 * 2. 带换行/子标签字面量的提示词把注入格式撑断(后半截漏进 DOM 与提示词);
 * 3. 数格子算错序号,导致新图挂到别的 tag 上。
 */
describe('buildManualTagContent', () => {
  it('必需 tag:空白返回 null', () => {
    expect(buildManualTagContent({ prompt: '' })).toBeNull();
    expect(buildManualTagContent({ prompt: '   \n  ' })).toBeNull();
  });

  it('换行压成空格(否则注入格式被撑断)', () => {
    const content = buildManualTagContent({ prompt: '1girl,\nwhite dress\n' });
    expect(content?.tag).toBe('1girl, white dress');
  });

  it('剥掉子标签字面量', () => {
    const content = buildManualTagContent({ prompt: '1girl </bbi_image> <nl>x</nl>' });
    expect(content?.tag).not.toContain('bbi_image');
    expect(content?.tag).not.toContain('<nl>');
  });

  it('负面与 nl 可空,且同样做单行化', () => {
    const content = buildManualTagContent({
      prompt: '1girl',
      negative: 'extra people,\nduplicate',
      nl: 'A girl\nstands.',
    });
    expect(content).toMatchObject({
      tag: '1girl',
      negative: 'extra people, duplicate',
      nl: 'A girl stands.',
    });
  });

  it('画幅缺省竖屏,可显式指定', () => {
    expect(buildManualTagContent({ prompt: 'x' })?.size).toBe('portrait');
    expect(buildManualTagContent({ prompt: 'x', size: 'landscape' })?.size).toBe('landscape');
  });

  it('不产角色提示词(手动图不带 characters)', () => {
    expect(buildManualTagContent({ prompt: '1girl' })?.characters).toEqual([]);
  });
});

describe('手动 tag 与正文章法的往返', () => {
  it('序列化后能被原样解析回来(卡片水合靠这一条)', () => {
    const content = buildManualTagContent({
      prompt: '1girl, rain',
      negative: 'blurry',
      nl: 'A girl in the rain.',
      size: 'landscape',
    });
    expect(content).not.toBeNull();
    const text = serializeImageTag(content!);
    const parsed = parseImageTagContent(text);
    expect(parsed.tag).toBe('1girl, rain');
    expect(parsed.negative).toBe('blurry');
    expect(parsed.nl).toBe('A girl in the rain.');
    expect(parsed.size).toBe('landscape');
  });

  it('追加到已有 tag 之后,序号 = 原数量(不清空任何旧 tag)', () => {
    const body = '她转身。\n<bbi_image>1girl, old<size>portrait</size></bbi_image>';
    const existing = parseImageTags(body);
    expect(existing).toHaveLength(1);

    const content = buildManualTagContent({ prompt: '1girl, new' })!;
    const next = `${body}\n${serializeImageTag(content)}`;
    const tags = parseImageTags(next);
    expect(tags).toHaveLength(2);
    // 新的排在末尾,旧的原文一字未动
    expect(tags[0]).toBe(existing[0]);
    expect(parseImageTagContent(tags[1]).tag).toBe('1girl, new');
  });
});
