/**
 * 手动提示词生图 —— 「不用等自动流程,我自己写提示词画一张」。
 *
 * ## 它和相邻功能的区别(三者容易混,这里一次说清)
 *
 * | 入口 | 提示词从哪来 | 落在哪 |
 * |---|---|---|
 * | 自动流程 / 楼层「生成 tag」按钮 | 模型读正文写 | 写进正文的 `<bbi_image>`,卡片原地渲染 |
 * | 卡片的「AI 重写提示词」 | 模型**重写这一条 tag 的内容** | 原位替换正文那条 tag |
 * | **本功能** | **用户当场敲** | 追加一条新的 `<bbi_image>` 到该楼末尾 |
 *
 * 为什么复用手写 tag 的通道而不是另开一条出图路径:
 * 卡片、灯箱、图库、重绘、删除、并发闸门、NAI 限流退避全都绑在「正文里有一条 tag」上。
 * 绕过它自己发一次 generateImage,就得把这些全部重写一遍,而且必然与自动流程抢后端。
 * 所以这里做的是:**把用户敲的提示词序列化成一条 tag 写进正文**,再走既有链路。
 *
 * ## 与自动 tag 的三点分工
 *
 * 1. **不碰角色档案**:手动提示词是用户的原话,系统不该偷偷往里加「常驻/临时」——
 *    想加的人自己写,或去角色页改。故 saveImageResult 记 `origin: 'manual'`,
 *    卡片与图库据此标明来源。
 * 2. **不参与 stale 判定**:它每次都插一条**新** tag(新 promptHash),不会把正文里
 *    已有的 tag 挤成旧提示词。
 * 3. **默认直接出图**:用户的意图就是「立刻看到图」,所以写完 tag 直接挂
 *    `force` 标记让卡片开跑(autoGenerate 关着也照跑,同手动点「应用并重新生成」)。
 */

import { backendStatus } from '@/generate';
import { markForAutoGenerate } from '@/floor/autoGenerate';
import { hydrateMessage } from '@/floor/hydrate';
import { getContext, isAiStoryMessage } from '@/st/context';
import { applyMessageText } from '@/st/messageEdit';
import { type ImageTagContent, parseImageTags, serializeImageTag } from '@/st/imageTagRegex';
import type { Orientation } from '@/backends/size';

/**
 * 把用户敲的提示词整理成一条可写入的 tag 内容。
 *
 * 纪律:
 * - tag 部分**必填**(空串进 ComfyUI 会被后端直接拒),空就返回 null 让调用方报错;
 * - 换行压成空格:tag 里换行没有意义,还会把注入格式撑断;
 * - 子标签字面量剔除(serializeImageTag 的壳会被提前闭合)。
 */
export function buildManualTagContent(draft: {
  prompt: string;
  negative?: string;
  nl?: string;
  size?: Orientation;
}): ImageTagContent | null {
  const oneLine = (text: string | undefined) =>
    String(text ?? '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const clean = (text: string) => text.replace(/<\/?(?:bbi_image|tag|nl|negative|characters|size)\b[^>]*>/gi, '').trim();

  const prompt = clean(oneLine(draft.prompt));
  if (!prompt) return null;
  return {
    tag: prompt,
    nl: clean(oneLine(draft.nl)),
    negative: clean(oneLine(draft.negative)),
    characters: [],
    size: draft.size ?? 'portrait',
  };
}

export interface ManualGenerateResult {
  ok: boolean;
  /** 失败时给用户看的一句话。 */
  reason?: string;
  /** 成功时新 tag 在正文里的序号(0-based)。 */
  seq?: number;
}

/**
 * 主入口:往某楼追加一条手写提示词的 tag,并立即出图。
 *
 * 步骤与纪律:
 * 1. 只对 AI 剧情楼生效(与楼层按钮同一判据);
 * 2. 正文写回走 `applyMessageText` 的 CAS:分析期间别的插件改了正文也照常合并
 *    (它在落盘那一刻基于真实正文现算,只在末尾追加);
 * 3. 写完立刻重水合,卡片才挂得出来;不重水合的话用户会以为「点了什么都没发生」。
 */
export async function generateFromManualPrompt(
  floor: number,
  draft: { prompt: string; negative?: string; nl?: string; size?: Orientation },
  options: { autoGenerate?: boolean } = {},
): Promise<ManualGenerateResult> {
  const context = getContext();
  if (!context?.chat) return { ok: false, reason: 'SillyTavern 还没就绪' };
  const message = context.chat[floor];
  if (!isAiStoryMessage(message)) {
    return { ok: false, reason: '这一楼不是可插图的剧情楼层(用户楼 / ST 系统楼)' };
  }
  const content = buildManualTagContent(draft);
  if (!content) return { ok: false, reason: '提示词不能为空' };

  const status = backendStatus();
  if (!status.configured) {
    return { ok: false, reason: status.reason || '出图渠道还没配置好' };
  }

  const chatId = context.getCurrentChatId?.() ?? '';
  if (!chatId) return { ok: false, reason: '当前没有打开的聊天' };
  const swipeId = message.swipe_id ?? 0;
  const tagText = serializeImageTag(content);

  let newSeq = -1;
  const written = await applyMessageText(
    floor,
    currentText => {
      // 落盘那一刻现算:当前正文里已有多少条 tag,新的就排在它们后面
      const lines = currentText.replace(/\r\n?/g, '\n');
      newSeq = parseImageTags(lines).length;
      const separator = lines.endsWith('\n') ? '' : '\n';
      return `${lines}${separator}${tagText}`;
    },
    chatId,
    swipeId,
    message,
  );
  if (written !== 'saved' || newSeq < 0) {
    return { ok: false, reason: manualWriteFailure(written) };
  }

  // 重水合:新 tag 的锚点由 ST 重渲染产生,这里先把卡片挂上去(即使不出图也要能看见)
  const fresh = getContext();
  if (fresh) hydrateMessage(floor, fresh);
  if (options.autoGenerate === false) return { ok: true, seq: newSeq };

  // 再挂自动出图标记:卡片 onMounted 会消费它并立刻开跑。
  // 用 force 而不是 auto —— 这是用户的显式意图,不该被「该桶已有历史」拦住。
  markForAutoGenerate(chatId, floor, swipeId, newSeq, 'force');
  // 楼层已渲染但卡片尚未挂载时,标记会在挂载那一刻被消费;这里再尝试催一次
  const again = getContext();
  if (again) hydrateMessage(floor, again);
  return { ok: true, seq: newSeq };
}

/** 写回失败的说法(exhaustive:新增分支时这里会编译报错)。 */
function manualWriteFailure(result: string): string {
  switch (result) {
    case 'chat-changed':
      return '聊天已切换,提示词没有写入';
    case 'floor-changed':
      return '这一楼已被删除或替换,提示词没有写入';
    case 'swipe-changed':
      return '已切换到别的 swipe,提示词没有写入';
    case 'build-failed':
      return '正文在这一刻被改动,提示词没有写入,请重试';
    case 'unavailable':
      return '当前聊天不可写入';
    default:
      return '提示词没有写入(未知原因)';
  }
}
