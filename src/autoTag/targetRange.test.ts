import { describe, expect, it } from 'vitest';
import { prepareTargetText, hasSelectionTag } from '@/autoTag/clean';

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

  it('名单非空但这一楼没有容器时,按整楼正文选(不静默罢工)', () => {
    const mes = '她把伞收起来。\n\n雨还在下。';
    const strict = prepareTargetText(mes, [], { keepTags: ['content_fox'], stripTags: [] });
    expect(strict.segments).toHaveLength(0);
    const fallback = prepareTargetText(mes, [], {
      keepTags: ['content_fox'],
      stripTags: [],
      fallbackToWholeSource: true,
    });
    expect(fallback.segments.length).toBe(2);
    expect(fallback.promptText).toContain('她把伞收起来。');
  });

  it('有容器时回退开关不改变结果', () => {
    const mes = '<content_fox>她站在雨里。</content_fox>\n雨声盖住了脚步。';
    const strict = prepareTargetText(mes, [], { keepTags: ['content_fox'], stripTags: [] });
    const fallback = prepareTargetText(mes, [], {
      keepTags: ['content_fox'],
      stripTags: [],
      fallbackToWholeSource: true,
    });
    expect(fallback.promptText).toBe(strict.promptText);
  });

  it('hasSelectionTag 认得开标签与闭标签', () => {
    expect(hasSelectionTag('<content_fox~>甲</content_fox~>', ['content_fox~'])).toBe(true);
    expect(hasSelectionTag('只剩 </content_fox~> 了', ['content_fox~'])).toBe(true);
    expect(hasSelectionTag('完全没有容器的正文', ['content_fox~'])).toBe(false);
    expect(hasSelectionTag('任意正文', [])).toBe(false);
  });
});
