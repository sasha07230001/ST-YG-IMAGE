import { requestFloorTags } from '@/autoTag/runner';
import { confirmDialog } from '@/components/confirm';
import { ensureChatObserver, onChatMutation } from '@/floor/chatObserver';
import { openManualPromptDialog } from '@/floor/manualPromptDialog';
import { isCurrentChatExcluded, settings } from '@/state/settings';
import { getContext, isAiStoryMessage } from '@/st/context';
import { hasImageTagTrace } from '@/st/imageTagRegex';

/**
 * 楼层「生成生图 tag」按钮 + 「手动提示词生图」按钮注入。
 *
 * 每个剧情楼的 .extraMesButtons(ST 扩展按钮区,"⋯" 展开)追加两枚调色板系按钮:
 * - 调色板(bbi-tag-action):无 tag 的楼直接分析并写入 tag;已有 tag 的楼先弹插件自绘
 *   确认窗,确认后剔除旧 tag、重新分析写入(旧图片保留在卡片历史里);
 * - 手写板(bbi-manual-action):打开「手动提示词生图」弹窗 —— 自己敲提示词,
 *   写完往本楼末尾追加一条新 tag 并直接出图。**不经过模型**,也不改已有 tag
 *   (分工见 floor/manualPrompt.ts 文件头的三方对照表)。
 *
 * 给谁不给谁**只由 st/context.ts 的 isAiStoryMessage 说话**,与自动流程、与 runner
 * 的兜底闸门是同一个谓词:AI 楼给、用户楼与 ST 真系统楼不给,而被 /hide 隐藏的普通楼
 * 照给——它仍是剧情楼,runner 也放行。旧版这里直接读 DOM 的 is_system 属性,隐藏楼
 * 一律没有按钮(用户报的正是这个),而属性变更又不在 observer 的监听范围里,
 * 于是「隐藏前渲染过的楼留着按钮、隐藏后重渲染的楼没有按钮」同一条聊天两种样子。
 *
 * 按钮是纯 DOM(fa 图标与 ST 原生扩展按钮同款观感),不进 Vue 树。
 * ST 重渲染会重建楼层 DOM,共用的 #chat 观察器(floor/chatObserver.ts)负责幂等对账
 * (该有的补、该撤的撤)。
 */

const BUTTON_CLASS = 'bbi-tag-action';
const MANUAL_CLASS = 'bbi-manual-action';
// 与扩展菜单入口同款调色板图标
const ICON_CLASS = 'fa-palette';
// 手写板:钢笔尖图标,与「生成 tag」的调色板区分开(两者的产出完全不同)
const MANUAL_ICON_CLASS = 'fa-pen-nib';

let bound = false;

function setRunning(button: HTMLElement, running: boolean): void {
  button.dataset.running = running ? '1' : '';
  button.classList.toggle(ICON_CLASS, !running);
  button.classList.toggle('fa-spinner', running);
  button.classList.toggle('fa-spin', running);
}

async function onActivate(button: HTMLElement): Promise<void> {
  if (button.dataset.running === '1') return;
  const floor = Number(button.closest('.mes')?.getAttribute('mesid'));
  const context = getContext();
  const message = Number.isInteger(floor) ? context?.chat?.[floor] : undefined;
  // 点了必须有下文:静默 return 在用户那里就是「按钮点了没反应」,连日志都没有
  if (!context || !message) {
    console.warn('[YG] 楼层按钮找不到对应消息', { mesid: button.closest('.mes')?.getAttribute('mesid') });
    toastr.warning('找不到这一楼的消息，请刷新页面后重试', 'YG 插图师');
    return;
  }
  if (!settings.enabled) {
    toastr.warning('YG已停用，请先在插件设置里开启', 'YG 插图师');
    return;
  }

  const hasTags = hasImageTagTrace(message.mes ?? '');
  if (hasTags) {
    const ok = await confirmDialog({
      title: '重新生成 tag',
      text: '本楼已有生图 tag。重新生成会先删除原 tag 再写入新的；已生成的图片保留在卡片历史里，不会丢失。',
      confirmText: '重新生成',
    });
    if (!ok) return;
  }

  setRunning(button, true);
  try {
    await requestFloorTags(floor, { replace: hasTags });
  } finally {
    // 运行期间 ST 可能已重渲染移除本按钮;对脱离 DOM 的元素改 class 是安全无操作
    setRunning(button, false);
  }
}

function createButton(): HTMLDivElement {
  const button = document.createElement('div');
  // mes_button 与 .extraMesButtons 里的 ST 原生扩展按钮同类(menu_button 是通用菜单按钮,样式不同)
  button.className = `mes_button fa-solid ${ICON_CLASS} ${BUTTON_CLASS}`;
  button.title = '生成生图 tag（已有 tag 时重新生成）';
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');

  const activate = () => void onActivate(button);
  button.addEventListener('click', activate);
  button.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
  return button;
}

/**
 * 手动提示词生图的按钮。与「生成 tag」并列放在 .extraMesButtons 里,
 * 排序紧随其后(append 在同一处,天然相邻)。
 *
 * 与 onActivate 同一条纪律:**点了必须有下文**——找不到楼层、插件停用都要 toast,
 * 静默 return 在用户那里就是「点了没反应」。
 */
function onManualActivate(button: HTMLElement): void {
  const floor = Number(button.closest('.mes')?.getAttribute('mesid'));
  const context = getContext();
  if (!context || !Number.isInteger(floor) || !context.chat?.[floor]) {
    console.warn('[YG] 手动提示词按钮找不到对应消息', {
      mesid: button.closest('.mes')?.getAttribute('mesid'),
    });
    toastr.warning('找不到这一楼的消息，请刷新页面后重试', 'YG 插图师');
    return;
  }
  if (!settings.enabled) {
    toastr.warning('YG已停用，请先在插件设置里开启', 'YG 插图师');
    return;
  }
  openManualPromptDialog({ floor });
}

function createManualButton(): HTMLDivElement {
  const button = document.createElement('div');
  button.className = `mes_button fa-solid ${MANUAL_ICON_CLASS} ${MANUAL_CLASS}`;
  button.title = '手动提示词生图（自己写提示词，新增一张图）';
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');

  const activate = () => onManualActivate(button);
  button.addEventListener('click', activate);
  button.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
  return button;
}

/**
 * 按钮与「谁该有按钮」对账(幂等、双向):该有的补,该撤的撤。
 *
 * 双向是必需的——只补不撤时,判据变了(排除名单里加了这个角色、/role 把楼改成系统楼)
 * 也只有等整段重渲染才生效,期间留着的按钮点了只会撞上 runner 的兜底闸门。
 * 正在跑的那颗不撤:它的 spinner 与 running 标记要留到本次请求收尾。
 */
function syncButtons(): void {
  const chat = getContext()?.chat;
  // 上下文还没就绪:什么都别做——此时「谁该有」无从判断,照着空 chat 对账会把按钮全撤掉
  if (!chat) return;
  // 排除角色:该聊天整条自动 tag 链路停用(与柏宝书同名单),手动按钮一并撤掉
  const excluded = isCurrentChatExcluded();
  for (const mesEl of document.querySelectorAll<HTMLElement>('#chat .mes')) {
    const extra = mesEl.querySelector('.extraMesButtons');
    if (!extra) continue;
    const floor = Number(mesEl.getAttribute('mesid'));
    // 判据吃 chat 里的消息对象,不吃 DOM 的 is_system 属性(见文件头注释)。
    // 顺带的好处:/hide 只翻属性、不动 DOM 树,本来就触发不了 observer,现在也无需触发。
    const wanted = !excluded && Number.isInteger(floor) && isAiStoryMessage(chat[floor]);
    const existing = extra.querySelector<HTMLElement>(`.${BUTTON_CLASS}`);
    const existingManual = extra.querySelector<HTMLElement>(`.${MANUAL_CLASS}`);
    if (wanted && !existing) extra.appendChild(createButton());
    else if (!wanted && existing && existing.dataset.running !== '1') existing.remove();
    // 手动按钮没有在途态(提交后立刻关窗、图由卡片显示),判据与主按钮同源
    if (wanted && !existingManual) extra.appendChild(createManualButton());
    else if (!wanted && existingManual) existingManual.remove();
  }
}

/** 绑定楼层按钮注入(幂等)。#chat 在 ST 静态模板里,绑定时不存在则说明环境异常,直接放弃。 */
export function bindTagActionButtons(): boolean {
  if (bound) return true;
  // 观察器与卡片自愈共用一个(floor/chatObserver.ts):同一棵树别观察两遍,
  // 开销在浏览器收集 MutationRecord 那一侧,不在回调侧。
  if (!ensureChatObserver()) return false;
  bound = true;
  onChatMutation(syncButtons);
  syncButtons();
  return true;
}
