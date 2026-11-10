import type { Component } from 'vue';
import Backend from './backend/index.vue';
import Profiles from './profiles/index.vue';
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
 *
 * 「发送预览」再往后:它不产生配置,只负责回答「这一串最后长什么样」,
 * 所以位置在管来源的「提示词」之后、管角色的「角色档案」之前——顺着读就是
 * 提示词从哪来 → 拼成什么样 → 谁在里面。
 *
 * 「角色档案」取代了旧的「角色管理」:档案库(用户手写模板 + 触发关键词) 与
 * 本聊天角色档案(AI 按剧情更新)分两层,角色层的词实时从后者取。
 */
export const PAGES: PageDef[] = [
  { id: 'backend', label: '渠道', component: Backend },
  { id: 'relay', label: '提示词', component: Relay },
  { id: 'profiles', label: '角色档案', component: Profiles },
  { id: 'gallery', label: '图库', component: Gallery },
  { id: 'history', label: '请求历史', component: History },
  { id: 'settings', label: '设置', component: Settings },
];

export function getPage(id: string): PageDef {
  return PAGES.find(p => p.id === id) ?? PAGES[0];
}
