import type { Component } from 'vue';
import Backend from './backend/index.vue';
import Characters from './characters/index.vue';
import Gallery from './gallery/index.vue';
import History from './history/index.vue';
import Relay from './relay/index.vue';
import Settings from './settings/index.vue';

export interface PageDef {
  /** 唯一 id,存进 ui.activePage / localStorage;同时作为 Icon 的 name */
  id: string;
  /** 导航栏全称 */
  label: string;
  component: Component;
}

/**
 * 分页注册表 —— 新增一页:建一个 pages/<id>/index.vue,再往这里加一行,
 * 并在 Icon.vue 的 PATHS 里加一条同 id 的图标。顺序即导航顺序,设置放最末。
 *
 * 「提示词」页紧跟在「渠道」之后:它管的正是「提示词从哪来」(内置 LLM 分析 / 中转站编译),
 * 与渠道页并列才好找——原版把这段散在设置页,用户得翻两层才看见自己在用哪条链。
 */
export const PAGES: PageDef[] = [
  { id: 'backend', label: '渠道', component: Backend },
  { id: 'relay', label: '提示词', component: Relay },
  { id: 'characters', label: '角色管理', component: Characters },
  { id: 'gallery', label: '图库', component: Gallery },
  { id: 'history', label: '请求历史', component: History },
  { id: 'settings', label: '设置', component: Settings },
];

export function getPage(id: string): PageDef {
  return PAGES.find(p => p.id === id) ?? PAGES[0];
}
