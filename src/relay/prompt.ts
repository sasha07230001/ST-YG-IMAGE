/**
 * 中转站纯文本工具:URL 规范化、提示词清洗、验收、恒定词合成。
 *
 * 这里全部是纯函数,不碰宿主。理由很简单——中转站最容易坏的两个地方
 * (地址填法五花八门、模型爱在 tag 外面裹解释)都只靠这一层挡住,
 * 能单独跑测试才敢改。
 */

import type { Orientation } from '@/backends/size';

/**
 * 规范化 OpenAI 兼容 base url:
 * - 用户填完整 /chat/completions 时只去掉端点后缀;
 * - 纯域名自动补 /v1;
 * - 已带路径的地址原样保留(别破坏 /v2/coding 这类自定义路由)。
 */
export function normalizeRelayUrl(url: string): string {
  const u = String(url ?? '').trim().replace(/\/+$/, '');
  if (!u) return u;
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/[^/?#]+$/i.test(u)) return `${u}/v1`;
  return u;
}

/** 首地址返回 404/405 时试的备用形式:加/去 /v1。 */
export function alternateRelayUrl(url: string): string {
  return /\/v1$/i.test(url) ? url.replace(/\/v1$/i, '') : `${url}/v1`;
}

/**
 * 送进中转站的正文最大长度(字符)。
 * 剧情楼偶尔几千字,截头比截尾更糟——高潮通常在后半段,故保留尾部。
 *
 * 与YG原始链路的分歧点:那条链吃的是**整楼结构化正文**(带 P 位置 ID、
 * 历史上下文、角色库),必须原样喂;这条链吃的是「这一张图要画的那段」,
 * 超长只会让模型把整楼压成一句,故在这里兜一下。
 */
export const MAX_STORY_CHARS = 6000;

/** 中转站编译结果的最大长度——超过这个长度 CLIP 已经吃不下,多半是模型跑偏了。 */
export const MAX_PROMPT_CHARS = 2000;

/**
 * 清洗要送进中转站的正文:
 * - 去掉 HTML 标签、Markdown 装饰(别让 <div> 之类挤占 token);
 * - 去掉已存在的生图 tag(别把上一轮的提示词当正文再喂回去);
 * - 折叠空白;超长保留尾部。
 *
 * 生图 tag 的剥离交给调用方(st/imageTagRegex 的 stripImageTags,那是唯一口径)。
 */
export function cleanStoryText(raw: string): string {
  return String(raw ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`~]{1,3}/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(-MAX_STORY_CHARS);
}

/**
 * 抽出模型回复里的提示词正文。模型很爱裹一层代码块或加个「提示词:」前缀,
 * 全都剥掉;剥完空串就是真空(调用方据此重试)。
 */
export function unwrapPromptReply(raw: string): string {
  let text = String(raw ?? '').trim();
  if (!text) return '';
  // 优先取 ```...``` 代码块里的内容
  const fenced = text.match(/```[a-zA-Z]*\n?([\s\S]*?)```/);
  if (fenced && fenced[1].trim()) text = fenced[1];
  text = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^(prompt|提示词|positive|正向)\s*[:：]?$/i.test(line))
    .join(' ')
    .replace(/^(prompt|提示词|positive prompt|正向提示词)\s*[:：]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/**
 * 校验一条中转站输出是否像样:不能空、不能是整段中文(CLIP 吃英文)、不能长到离谱。
 * 失败时 reason 是给用户看的中文原因(runner 会把它当重试理由的原样记进请求历史)。
 */
export function validatePrompt(text: string): { ok: boolean; reason: string } {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, reason: '中转站返回了空提示词' };
  const latin = (t.match(/[a-zA-Z]/g) ?? []).length;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (latin < 3) return { ok: false, reason: '提示词里几乎没有英文,ComfyUI 的 CLIP 读不懂' };
  if (cjk > latin) return { ok: false, reason: '提示词以中文为主,需要让中转站输出英文 tag' };
  if (t.length > MAX_PROMPT_CHARS) {
    return { ok: false, reason: `提示词过长(${t.length} 字符),CLIP 会被截断` };
  }
  return { ok: true, reason: '' };
}

/**
 * 拆分模型输出里的正负两段。要求给负面时会带 POSITIVE:/NEGATIVE: 标记;
 * 没标记就整段当正面(兼容不爱守规矩的模型)。
 */
export function splitPosNeg(reply: string): { positive: string; negative: string } {
  const text = String(reply ?? '');
  const posMatch = text.match(/POSITIVE\s*[:：]\s*([\s\S]*?)(?=NEGATIVE\s*[:：]|$)/i);
  const negMatch = text.match(/NEGATIVE\s*[:：]\s*([\s\S]*)$/i);
  if (posMatch || negMatch) {
    return {
      positive: (posMatch?.[1] ?? '').trim().replace(/\s+/g, ' '),
      negative: (negMatch?.[1] ?? '').trim().replace(/\s+/g, ' '),
    };
  }
  return { positive: text.trim(), negative: '' };
}

/** 把两串逗号分隔的 tag 合并、按小写去重并保持顺序。 */
export function joinTags(...parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts.join(',').split(',')) {
    const tag = part.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.join(', ');
}

/**
 * 正向合成:恒定画风词**前置**。
 *
 * CLIP 的注意力对越靠前的 token 越敏感,而且不少采样器/工作流只吃前 75 个 token。
 * 画风基线丢在末尾等于把最能定调的那几个词放到最容易被截断的位置——
 * 所以恒定词必须在最前面,模型编译出来的具体画面描述跟在后面。
 */
export function composePositive(style: string, core: string): string {
  return joinTags(style ?? '', core ?? '');
}

/** 负面合成:恒定负面词同样前置。 */
export function composeNegative(fixed: string, core: string): string {
  return joinTags(fixed ?? '', core ?? '');
}

/**
 * 模板占位符替换:{{story}} {{note}} {{mark}} {{index}} {{count}} {{orientation}}。
 * 其余 `{{xxx}}` 原样保留(可能是用户想留给 ST 的宏,误替换比留着更糟)。
 */
export function renderTemplate(
  template: string,
  values: {
    story: string;
    note?: string;
    mark?: string;
    index?: number;
    count?: number;
    orientation?: Orientation | null;
  },
): string {
  const orientationText = values.orientation === 'landscape' ? '横构图' : values.orientation === 'portrait' ? '竖构图' : '';
  return String(template ?? '')
    .replace(/\{\{story\}\}/gi, values.story)
    .replace(/\{\{note\}\}/gi, values.note || '(无)')
    .replace(/\{\{mark\}\}/gi, values.mark || '')
    .replace(/\{\{index\}\}/gi, values.index === undefined ? '1' : String(values.index + 1))
    .replace(/\{\{count\}\}/gi, values.count === undefined ? '1' : String(values.count))
    .replace(/\{\{orientation\}\}/gi, orientationText || '(不限)');
}

/** 给"这一次要画的那一段"追加一句限定,不这么说模型会把整楼压进一张图。 */
export function withSegmentNote(
  note: string,
  options: { index: number; count: number; mark?: string },
): string {
  const base = String(note ?? '').trim();
  if (options.count <= 1) return base;
  const piece = `本次只画第 ${options.index + 1}/${options.count} 张:只画这一段里正在发生的事,不要画其它段落,也不要复述整楼剧情。`;
  return base ? `${base}\n${piece}` : piece;
}
