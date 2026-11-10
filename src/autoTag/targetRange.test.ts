import { describe, expect, it } from 'vitest';
import { prepareTargetText } from '@/autoTag/clean';

const STORY = [
  '<正文>',
  '她推开门,雨声涌了进来。',
  '</正文>',
  '<设定>',
  '这条街的雨永远下不完。',
  '</设定>',
  '她把伞靠在墙边。',
].join('\n');

describe('clean:正文选取标签', () => {
  it('没有选取名单时整楼都是候选', () => {
    const prepared = prepareTargetText(STORY, []);
    const text = prepared.segments.map(segment => segment.text).join('\n');
    expect(text).toContain('她推开门');
    expect(text).toContain('这条街的雨永远下不完');
    expect(text).toContain('她把伞靠在墙边');
  });

  it('给了选取名单就只剩被包住的段落,标签名本身不进正文', () => {
    const prepared = prepareTargetText(STORY, [], { keepTags: ['正文'] });
    const text = prepared.segments.map(segment => segment.text).join('\n');
    expect(text).toContain('她推开门,雨声涌了进来。');
    expect(text).not.toContain('这条街的雨永远下不完');
    expect(text).not.toContain('她把伞靠在墙边');
    expect(text).not.toContain('<正文>');
    expect(text).not.toContain('正文');
  });

  it('给了选取名单但正文里没有这个标签,候选为空', () => {
    const prepared = prepareTargetText(STORY, [], { keepTags: ['不存在的标签'] });
    expect(prepared.segments).toHaveLength(0);
  });

  it('排除标签整块剔掉,且优先于选取', () => {
    const nested = [
      '<正文>',
      '她推开门。',
      '<划掉>这段不该被画。</划掉>',
      '她把伞靠在墙边。',
      '</正文>',
    ].join('\n');
    const prepared = prepareTargetText(nested, [], { keepTags: ['正文'], stripTags: ['划掉'] });
    const text = prepared.segments.map(segment => segment.text).join('\n');
    expect(text).toContain('她推开门');
    expect(text).toContain('她把伞靠在墙边');
    expect(text).not.toContain('这段不该被画');
  });

  it('同一段跨多行时按行保留', () => {
    const multi = ['<正文>', '第一行。', '第二行。', '</正文>', '范围外。'].join('\n');
    const prepared = prepareTargetText(multi, [], { keepTags: ['正文'] });
    const texts = prepared.segments.map(segment => segment.text);
    expect(texts).toEqual(['第一行。', '第二行。']);
    expect(prepared.segments.map(segment => segment.id)).toEqual(['P1', 'P2']);
  });

  it('中文标签名同样生效', () => {
    const prepared = prepareTargetText('<场面>她笑了。</场面>外头的雨没停。', [], { keepTags: ['场面'] });
    const text = prepared.segments.map(segment => segment.text).join('\n');
    // 同一行里既有范围内也有范围外:整行留下,但标签壳已被剔除。
    expect(text).toContain('她笑了。');
    expect(text).not.toContain('<场面>');
    expect(text).not.toContain('</场面>');
  });
});
