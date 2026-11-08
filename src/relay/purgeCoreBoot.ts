/**
 * dsh-purge 内核的**开机自启**。
 *
 * ## 为什么需要单独一个模块
 *
 * 内核正文的拼接在 `autoTag/prompt.ts`(`activePurgeCore`),那里每次请求现读设置,
 * 所以「开关打开 = 下一张图就带内核」是天然成立的。真正要处理的只有一件事:
 *
 * **用户上次是打开着的。ST 重启(或插件被重新加载)后,内核必须自己接回去,
 * 而不是等用户想起来先进一次设置页。**
 *
 * ## 为什么不是「加载时无条件写 true」
 *
 * 那是假自启。用户昨天明确关掉了,今天开机又被翻回来,连续关三次都翻回来 —— 这比没有
 * 自启功能更烦人。所以这里只做「把用户上次的状态重新落实一次」:
 *
 * - `purgeCoreAutoStart === false` → 什么都不做,状态原样(这是「我不想要自启」);
 * - `purgeCoreAutoStart === true && purgeCoreOn === true` → 幂等确认(本来就是 true,写回值不变);
 * - `purgeCoreAutoStart === true && purgeCoreOn === false` → **尊重关闭**。
 *
 * 第三条是关键分歧点。用户的取舍是「内核要自启」,但 ST 里的开关是**持久化**的:
 * `purgeCoreOn` 存的就是他上次离开时的状态。既然它已经持久化,「自启」的正确实现
 * 就是**读回它并保证它是函数从启动第一刻起就在用的那个值** —— 而不是每天重写一次。
 * 想让内核彻底不出现,把自启关掉或把预设选到「关闭」即可,这两种都不会被翻回来。
 *
 * ## 装了插件 = 第一次开机
 *
 * 老配置(还没有这几个键)由 `normalize()` 落成 preset='cn' / on=true / autostart=true,
 * 即「装上就立刻生效、下次开机还在」。所以第一次运行不需要这个模块做任何事,
 * 它只在**有人手改过设置之后**起作用:把状态对齐到用户最后的选择。
 */

import { onSettingsReady, settings } from '@/state/settings';
import { purgeCoreText } from '@/relay/purgeCore';

let bound = false;

/**
 * 计算本次启动内核该是开还是关。
 *
 * 抽成纯函数是为了能在测试里直接打表:这块逻辑全是布尔组合,靠手点 UI 验六种组合
 * 太慢,而且最容易在「关掉又被打开」这类回归上翻车。
 *
 * @param autoStart 用户是否允许自启
 * @param lastOn    上次离开时的开关状态
 * @param preset    选中的预设
 * @returns 期望落地的开关值
 */
export function resolveAutoStart(
  autoStart: boolean,
  lastOn: boolean,
  preset: string,
): boolean {
  // 用户明确不要自启 → 一律不动
  if (!autoStart) return lastOn;
  // 预设选了「关闭」是个更强的意图声明,压过开关残留的 true
  if (preset === 'off') return false;
  // 其余情况:上次开着就继续开着,关着就继续关着
  return lastOn;
}

/**
 * 挂上自启。幂等 —— 重复调用只在第一次真正执行(插件被热重载时 ST 会再跑一遍入口)。
 *
 * 时机必须是 `onSettingsReady`:hydrate 之前 `settings` 里是默认值,这时候读写开关
 * 等于拿默认值覆盖服务器上存着的用户选择(settings.ts 里 `ready` 那个守门标志就是干这个的)。
 */
export function bindPurgeCoreAutoStart(): void {
  if (bound) return;
  bound = true;

  onSettingsReady(() => {
    const p = settings.autoTag.prompts;
    const want = resolveAutoStart(p.purgeCoreAutoStart, p.purgeCoreOn, p.purgeCorePreset);

    if (want !== p.purgeCoreOn) {
      p.purgeCoreOn = want;
      console.info(`[YG·插图师] 破甲内核自启:开关已恢复为 ${want}`);
    }

    // 自启开着却拿不到正文(预设写坏、自定义被清空)→ 说出来。
    // 静默失效是最难查的一类问题:用户以为开了,图还是被降级,却没有任何线索。
    if (p.purgeCoreOn && !purgeCoreText(p.purgeCorePreset) && !p.purgeCoreCustom.trim()) {
      console.warn(
        `[YG·插图师] 破甲内核已开启但正文为空(preset=${p.purgeCorePreset}),本次不会注入。` +
          '请到「AI 提示词」里重选一套预设,或填自定义正文。',
      );
    }
  });
}
