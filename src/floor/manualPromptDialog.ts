import { h, render } from 'vue';

import ManualPromptDialog from '@/floor/ManualPromptDialog.vue';
import { generateFromManualPrompt } from '@/floor/manualPrompt';
import { backendStatus } from '@/generate';
import { getContext } from '@/st/context';

/**
 * 命令式打开「手动提示词生图」弹窗(供楼层按钮调用)。
 *
 * 挂载位置与 components/confirm.ts、floor/lightbox.ts、floor/promptEditor.ts 完全同款:
 * 插件 host 的 shadow root —— 那里才有 dist/index.css 与 --bbi-* 主题变量。
 * 挂 document.body 会裸奔无样式;挂卡片自己的 shadow root 又会被 .mes_text 的
 * 层叠上下文裁掉(弹窗是 fixed 全屏层)。
 *
 * 【为什么由调用方持有楼层号】
 * 弹窗只是表单,不读聊天上下文。楼层号在开窗那一刻快照下来,用户中途切聊天也不会
 * 把图写到别的楼去 —— 与楼层按钮、卡片编辑器同一条纪律。
 */

// 与 index.ts 的 HOST_ID 一致
const HOST_ID = 'bbi-app-host';

/** 同一时刻只允许一个弹窗,重复调用先关旧的。 */
let closeCurrent: (() => void) | null = null;

export interface ManualPromptOptions {
  /** 目标楼层(0-based)。 */
  floor: number;
  /** 提交成功后回调(调用方可用来刷新按钮状态/提示)。 */
  onDone?: (result: { ok: boolean; reason?: string; seq?: number }) => void;
}

export function openManualPromptDialog(options: ManualPromptOptions): void {
  const root = document.getElementById(HOST_ID)?.shadowRoot;
  if (!root) {
    toastr.warning('界面还没初始化完成,请稍后重试', 'YG 插图师');
    return;
  }
  closeCurrent?.();

  const container = document.createElement('div');
  root.appendChild(container);

  const close = () => {
    if (closeCurrent !== close) return; // 已被后来者替换,不重复清理
    closeCurrent = null;
    render(null, container);
    container.remove();
  };
  closeCurrent = close;

  // 弹窗实例上的 release / setError:提交失败后必须解锁按钮,否则一次失败就再也点不动
  let dialog: { release(): void; setError(message: string): void } | null = null;

  const submit = async (payload: {
    prompt: string;
    negative: string;
    nl: string;
    size: 'portrait' | 'landscape';
    generate: boolean;
  }): Promise<void> => {
    const result = await generateFromManualPrompt(options.floor, payload, {
      autoGenerate: payload.generate,
    });
    if (!result.ok) {
      toastr.warning(result.reason ?? '没有写入', 'YG 插图师');
      dialog?.setError(result.reason ?? '没有写入');
      return;
    }
    close();
    if (payload.generate) {
      toastr.success('提示词已写入,正在按它出图', 'YG 插图师');
    } else {
      toastr.success('提示词已写入本楼,可在卡片上点「生成图片」', 'YG 插图师');
    }
    options.onDone?.(result);
  };

  const vnode = h(ManualPromptDialog, {
    open: true,
    configured: backendStatus().configured,
    floor: options.floor,
    onSubmit: (payload: Parameters<typeof submit>[0]) => void submit(payload),
    onClose: close,
    ref: (instance: unknown) => {
      dialog = instance as { release(): void; setError(message: string): void } | null;
    },
  });
  render(vnode, container);

  // 开窗即校验:没配出图渠道时直接说清楚,免得用户敲完才被按钮禁用拦住
  const status = backendStatus();
  if (!status.configured) {
    toastr.info(status.reason || '出图渠道还没配置好,现在只能写提示词', 'YG 插图师');
  }
  // 楼号越界是调用方的问题,这里兜一层:直接关窗并报错,不让用户对着一个写不进去的表单敲字
  const context = getContext();
  if (!context?.chat?.[options.floor]) {
    close();
    toastr.warning('找不到这一楼,请刷新页面后重试', 'YG 插图师');
  }
}
