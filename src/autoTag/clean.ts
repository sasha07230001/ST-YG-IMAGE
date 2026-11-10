/**
 * 正文清洗工具(与柏宝书 timeTag.ts 的 stripCustomTags 完全同口径,改动需双端同步)。
 * 名单来自共享存储(settings.excludes.customStripTags),输入时已由 sanitizeTagName 消毒,
 * 这里只负责按标签名生成「整块删除」正则并执行。
 */

const RE_THINK_BLOCK = /<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi;
const RE_START = /<bbs_start\b[^>]*>([\s\S]*?)<\/bbs_start>/gi;
const RE_END = /<bbs_end\b[^>]*>([\s\S]*?)<\/bbs_end>/gi;

/**
 * 按标签名生成「整块删除」正则(含标签本身与内部内容)。tag 已由 sanitizeTagName 剔除正则元字符,
 * 拼进 RegExp 安全。边界用前瞻 (?=[\s/>]) 而非 \b —— \b 只认 ASCII 词字符,中文标签(如 <雪>)
 * 在 `雪` 与 `>` 之间无词边界会匹配失败;前瞻「标签名后须紧跟空白/斜杠/右括号」对中英文都成立,
 * 且同样防止 <snow> 误吃 <snowball> 前缀。同时删配对块与落单的自闭/单标签。
 */
function blockStripRegexes(tag: string): RegExp[] {
  return [
    new RegExp(`<${tag}(?=[\\s/>])[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), // 配对块
    new RegExp(`<\\/?${tag}(?=[\\s/>])[^>]*\\/?>`, 'gi'), // 落单的开/闭/自闭标签
  ];
}

/** 删掉用户在设置里配置的自定义标签(整块:标签 + 内部内容)。空名单则原样返回。 */
function replaceCustomTags(s: string, tags: string[], replacement: string): string {
  let out = s;
  for (const tag of tags) {
    if (!tag) continue;
    for (const re of blockStripRegexes(tag)) out = out.replace(re, replacement);
  }
  return out;
}

export function stripCustomTags(s: string, tags: string[]): string {
  return replaceCustomTags(s, tags, '');
}

/** 删柏宝书托管的尾部旁注块(bbs_items/bbs_vars,开/闭标签独占行配对)。 */
function stripManagedBlock(s: string, tag: string): string {
  const openRe = new RegExp(`^[ \\t]*<${tag}\\b[^>]*>[ \\t]*$`, 'm');
  const closeRe = new RegExp(`^[ \\t]*</${tag}>[ \\t]*$`, 'm');
  let out = s;
  let open: RegExpMatchArray | null;
  while ((open = out.match(openRe))) {
    const start = open.index ?? 0;
    const rest = out.slice(start + open[0].length);
    const close = rest.match(closeRe);
    if (!close) {
      out = out.slice(0, start) + out.slice(start + open[0].length);
      continue;
    }
    const end = start + open[0].length + (close.index ?? 0) + close[0].length;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

function stripManagedTags(s: string): string {
  return stripManagedBlock(stripManagedBlock(s, 'bbs_items'), 'bbs_vars');
}

function clampToStoryBody(
  mes: string,
  tags: string[],
  preserveImageTags: boolean,
  noiseReplacement = '',
): string {
  const customTags = preserveImageTags
    ? tags.filter(tag => tag.toLowerCase() !== 'bbi_image')
    : tags;
  let s = String(mes ?? '')
    .replace(RE_THINK_BLOCK, noiseReplacement)
    .replace(/<!--[\s\S]+?-->/g, noiseReplacement)
    .replace(/<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi, noiseReplacement);
  s = replaceCustomTags(s, customTags, noiseReplacement);
  s = stripManagedTags(s);

  const startRe = /<bbs_start\b/gi;
  let lastStart = -1;
  for (let match = startRe.exec(s); match; match = startRe.exec(s)) lastStart = match.index;
  if (lastStart >= 0) s = s.slice(lastStart);
  const endMatch = s.match(/<\/bbs_end>/i);
  if (endMatch?.index !== undefined) s = s.slice(0, endMatch.index + endMatch[0].length);

  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 历史楼层与柏宝书 cleanBody 同口径；本插件的 bbi_image 必须保留供角色外貌续接。 */
export function cleanHistoryText(mes: string, tags: string[]): string {
  return clampToStoryBody(mes, tags, true)
    .replace(RE_START, (_, value) => `(起始时间:${String(value).trim()})`)
    .replace(RE_END, (_, value) => `(结束时间:${String(value).trim()})`);
}

interface RemovalRange {
  start: number;
  end: number;
}

interface SourceLineRange {
  index: number;
  start: number;
  end: number;
}

/** 正文选取/排除标签:只影响「这一轮选画面的范围」,不改历史楼层文本。 */
export interface TargetRangeOptions {
  /** 只在这些标签包住的段落里选画面。空/未给 = 整楼都算候选。 */
  keepTags?: string[];
  /** 这些标签包住的段落整块剔掉(在选取之前生效)。 */
  stripTags?: string[];
}

export interface TargetSegment {
  /** 发给模型的短位置 ID。 */
  id: string;
  /** 对应原始正文的物理行号(0-based，仅插件内部使用)。 */
  sourceLine: number;
  /** 删除噪声后的该行叙事文本。 */
  text: string;
}

export interface PreparedTargetText {
  /** 带段尾位置 ID 的目标正文。 */
  promptText: string;
  /** 位置 ID 到原始物理行的稳定映射。 */
  segments: TargetSegment[];
}

function rangesForRegex(source: string, pattern: RegExp): RemovalRange[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  return [...source.matchAll(regex)]
    .filter(match => match.index !== undefined && match[0].length > 0)
    .map(match => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
}

function mergeRanges(ranges: RemovalRange[]): RemovalRange[] {
  const sorted = ranges
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: RemovalRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function maskedSource(source: string, ranges: RemovalRange[]): string {
  if (!ranges.length) return source;
  const chars = source.split('');
  for (const range of mergeRanges(ranges)) {
    for (let index = range.start; index < range.end; index += 1) {
      if (chars[index] !== '\r' && chars[index] !== '\n') chars[index] = ' ';
    }
  }
  return chars.join('');
}

function sourceLineRanges(source: string): SourceLineRange[] {
  const lines: SourceLineRange[] = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  let index = 0;
  for (let match = newline.exec(source); match; match = newline.exec(source)) {
    lines.push({ index, start, end: match.index });
    start = match.index + match[0].length;
    index += 1;
  }
  lines.push({ index, start, end: source.length });
  return lines;
}

function retainedLineText(source: string, line: SourceLineRange, ranges: RemovalRange[]): string {
  const pieces: string[] = [];
  let cursor = line.start;
  for (const range of ranges) {
    if (range.end <= line.start) continue;
    if (range.start >= line.end) break;
    if (range.start > cursor) pieces.push(source.slice(cursor, Math.min(range.start, line.end)));
    cursor = Math.max(cursor, range.end);
    if (cursor >= line.end) break;
  }
  if (cursor < line.end) pieces.push(source.slice(cursor, line.end));
  return pieces.join(' ').replace(/[ \t]+/g, ' ').trim();
}

/**
 * 选取标签:只在 <tag>…</tag> 里选画面。空名单返回 null(= 不限,调用方按整楼处理)。
 *
 * 与 blockStripRegexes 的区别:那里连标签一起删,这里只取**内部内容**的位置 ——
 * 标签名本身不进正文,不然模型会以为「snow」这个词也该进 tag。
 */
/** 开标签:`<tag` 后须紧跟空白/斜杠/右尖括号(中文标签名也能正常匹配)。 */
const ATTR_TAIL = "\\s*/?\\s*\\u003e";
function openTagPattern(tag: string): string {
  return "\\u003c" + tag + "(?=[\\s/\\u003e])[^\\u003e]*" + ATTR_TAIL;
}
function closeTagPattern(tag: string): string {
  return "\\u003c/" + tag + "\\s*\\u003e";
}

function innerRangeRegexes(tag: string): RegExp[] {
  return [
    new RegExp(`<${tag}(?=[\\s/>])[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'),
    new RegExp(`<${tag}(?=[\\s/>])[^>]*/>`, 'gi'), // 自闭标签:空内容也算一段,免得整楼被裁空
  ];
}

function targetSelectionRanges(source: string, tags: string[]): RemovalRange[] | null {
  const clean = tags.filter(Boolean);
  if (!clean.length) return null;
  const ranges: RemovalRange[] = [];
  for (const tag of clean) {
    for (const regex of innerRangeRegexes(tag)) {
      for (const match of source.matchAll(regex)) {
        if (match.index === undefined) continue;
        if (match[1] === undefined) {
          // 自闭标签 <x />:把整个标签位置当作一段(空内容会在后面被丢掉)
          ranges.push({ start: match.index, end: match.index + match[0].length });
          continue;
        }
        const innerStart = match.index + match[0].indexOf(match[1]);
        ranges.push({ start: innerStart, end: innerStart + match[1].length });
      }
    }
  }
  if (!ranges.length) return [];
  return mergeRanges(ranges);
}

/** 排除标签:这些段整块不进候选(先于选取生效,免得选取段里的排除段又被捞回来)。 */
function targetExcludeRanges(source: string, tags: string[]): RemovalRange[] {
  const ranges: RemovalRange[] = [];
  for (const tag of tags.filter(Boolean)) {
    for (const regex of blockStripRegexes(tag)) ranges.push(...rangesForRegex(source, regex));
  }
  return ranges;
}

/**
 * 限定了选取范围时,把范围外的非空物理行整行标记为删除。
 * 逐行判断而不是按行号裁剪:一段正文可能跨行,行内也可能只有半个范围。
 */
function outsideSelectionRanges(source: string, keep: RemovalRange[]): RemovalRange[] {
  const keepSorted = mergeRanges(keep);
  const out: RemovalRange[] = [];
  for (const line of sourceLineRanges(source)) {
    if (line.end <= line.start) continue;
    if (!source.slice(line.start, line.end).trim()) continue;
    // 同一行里既有范围外文字又有范围内文字(中文正文经常一段一行):
    // 只要这一行与任一选取范围有交集就保留 —— 反过来按「整行被包住」判会把
    // <场面>她笑了。</场面>外头的雨没停。 这种写法整行丢掉。
    const covered = keepSorted.some(range => range.start < line.end && range.end > line.start);
    if (covered) continue;
    out.push({ start: line.start, end: line.end });
  }
  return out;
}

function targetRemovalRanges(
  source: string,
  tags: string[],
  options: TargetRangeOptions = {},
): RemovalRange[] {
  const noise: RemovalRange[] = [
    ...rangesForRegex(source, RE_THINK_BLOCK),
    ...rangesForRegex(source, /<!--[\s\S]+?-->/g),
    ...rangesForRegex(source, /<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi),
  ];
  for (const tag of [...tags, 'bbs_items', 'bbs_vars']) {
    if (!tag) continue;
    for (const regex of blockStripRegexes(tag)) noise.push(...rangesForRegex(source, regex));
  }

  // 排除标签:与噪声同一处理(整块删),但**先于**选取范围计算,
  // 否则「排除段落在选取段里」时会被选取范围又捞回来。
  noise.push(...targetExcludeRanges(source, options.stripTags ?? []));

  const keep = targetSelectionRanges(source, options.keepTags ?? []);

  // 选取标签的标签壳不该留在正文里(模型会把 <正文> 当成叙事的一部分)。
  // 只删壳、保留内容:用内部区间把整块匹配切成「左壳 + 内文 + 右壳」。
  for (const tag of (options.keepTags ?? []).filter(Boolean)) {
    const pairRe = new RegExp(openTagPattern(tag) + "([\\s\\S]*?)" + closeTagPattern(tag), "gi");
    for (const match of source.matchAll(pairRe)) {
      const shellStart = match.index ?? 0;
      const shellEnd = shellStart + match[0].length;
      const inner = match[1] ?? "";
      const innerStart = shellStart + match[0].indexOf(inner);
      noise.push({ start: shellStart, end: innerStart });
      noise.push({ start: innerStart + inner.length, end: shellEnd });
    }
    const selfRe = new RegExp(openTagPattern(tag).replace(ATTR_TAIL, "\\/>"), "gi");
    for (const match of source.matchAll(selfRe)) {
      const at = match.index ?? 0;
      noise.push({ start: at, end: at + match[0].length });
    }
  }

  const masked = maskedSource(source, noise);
  const crop: RemovalRange[] = [];
  const startRe = /<bbs_start\b/gi;
  let lastStart = -1;
  for (let match = startRe.exec(masked); match; match = startRe.exec(masked)) lastStart = match.index;
  if (lastStart >= 0) crop.push({ start: 0, end: lastStart });

  const bodyStart = Math.max(0, lastStart);
  const endMatch = masked.slice(bodyStart).match(/<\/bbs_end>/i);
  const bodyEnd = endMatch?.index === undefined
    ? source.length
    : bodyStart + endMatch.index + endMatch[0].length;
  if (bodyEnd < source.length) crop.push({ start: bodyEnd, end: source.length });

  // Match BaiBai Book's order: crop to the story time range before removing time tags.
  // A format example before the story must not pair with the real closing tag and swallow the prose.
  const timeTags: RemovalRange[] = [];
  const body = masked.slice(bodyStart, bodyEnd);
  for (const tag of ['bbs_start', 'bbs_end']) {
    for (const regex of blockStripRegexes(tag)) {
      timeTags.push(...rangesForRegex(body, regex).map(range => ({
        start: bodyStart + range.start,
        end: bodyStart + range.end,
      })));
    }
  }
  const merged = mergeRanges([...noise, ...crop, ...timeTags]);
  if (!keep) return merged;
  // 有选取名单:范围外的整行也当噪声删掉(keep 与 noise 不会重叠 ——
  // 噪声段本来就被整块删,不会被选中)。
  return mergeRanges([...merged, ...outsideSelectionRanges(source, keep)]);
}

/**
 * 目标正文删除同款噪声和时间标签，并只给保留下来的非空物理行追加段尾位置 ID。
 * 每个 ID 直接保存原始 sourceLine，不再要求模型复制原文，也不依赖清洗后文本反查。
 */
export function prepareTargetText(
  mes: string,
  tags: string[],
  options: TargetRangeOptions = {},
): PreparedTargetText {
  const source = String(mes ?? '');
  const ranges = targetRemovalRanges(source, tags, options);
  const segments = sourceLineRanges(source)
    .map(line => ({ sourceLine: line.index, text: retainedLineText(source, line, ranges) }))
    .filter(segment => !!segment.text)
    .map((segment, index) => ({ id: `P${index + 1}`, ...segment }));
  return {
    promptText: segments.map(segment => `${segment.text} ⟦${segment.id}⟧`).join('\n\n'),
    segments,
  };
}

/** 不带位置标记的目标清洗结果，供调试/测试查看。 */
export function cleanTargetText(mes: string, tags: string[]): string {
  return prepareTargetText(mes, tags).segments.map(segment => segment.text).join('\n\n');
}
