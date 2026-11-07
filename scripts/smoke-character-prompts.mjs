/**
 * 角色页「常驻 / 临时提示词」版面的宿主级冒烟。
 *
 * 做法:jsdom 里假装成 SillyTavern —— 给一个最小 getContext(含 chat/chatMetadata/
 * toastr),把**构建产物**当 ESM 加载,再点开导航里的「角色管理」页,
 * 断言那一段界面真的渲染出来了。跑的是 dist/index.js,所以能抓到「模板结构写坏」
 * 「组件没挂上」「点了没反应」这类只有真加载才暴露的问题。
 *
 * 注意:产物是 ESM(bundle 里有 import.meta),必须用动态 import 加载,
 * 不能用 new Function/eval —— 那会被当成脚本解析,当场 SyntaxError。
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const bundle = path.join(root, 'dist', 'index.js');

if (!fs.existsSync(bundle)) {
  console.error('先跑 npm run build');
  process.exit(1);
}

const dom = new JSDOM(
  '<!doctype html><html><body><div id="chat"></div><div id="extensionsMenu"></div><div id="top-settings-holder"></div></body></html>',
  { url: 'http://localhost/', pretendToBeVisual: true },
);
const { window } = dom;

/* —— 最小 SillyTavern 替身 —— */
const chat = [
  { name: 'User', is_user: true, is_system: false, mes: '你在做什么?', extra: {} },
  { name: '小雪', is_user: false, is_system: false, mes: '她转身,黑色蕾丝裙在灯下泛着光。', extra: {} },
];

const ctx = {
  chat,
  chatMetadata: {},
  characterId: 1,
  name1: 'User',
  name2: '小雪',
  characters: [],
  groups: [],
  eventTypes: {
    CHAT_CHANGED: 'chat_changed',
    CHARACTER_MESSAGE_RENDERED: 'cmr',
    USER_MESSAGE_RENDERED: 'umr',
    MESSAGE_UPDATED: 'mu',
    MESSAGE_SWIPED: 'ms',
    MESSAGE_DELETED: 'md',
    GENERATION_STARTED: 'gs',
    GENERATION_ENDED: 'ge',
    GENERATION_STOPPED: 'gst',
  },
  eventSource: { on() {}, removeListener() {}, emit() {} },
  extensionSettings: { regex: [] },
  power_user: {},
  getCurrentChatId: () => 'smoke-chat',
  getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  saveMetadata() {},
  saveMetadataDebounced() {},
  saveChat: async () => {},
  saveSettingsDebounced() {},
  generateRaw: async () => '',
  getTokenCountAsync: async () => 0,
};

window.SillyTavern = { getContext: () => ctx };
window.toastr = { success() {}, error() {}, warning() {}, info() {} };
window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
// 启动入口是 $(function(){ mount() })：桩必须真的执行回调，否则什么都不挂载。
// menu.ts / topbar.ts 还会用 $('<div …>') 造节点再 append 进去 —— 那种写法要真的产出
// DOM 元素,否则魔杖入口注入不进来,冒烟就永远打不开窗口。
const wrap = (el) => {
  const raw = el && el.__node !== undefined ? el.__node : el;
  el = raw;
  const set = raw ? [raw] : [];
  // jQuery 的 length 是「选中了几个元素」；menu.ts 正是靠 `$('#extensionsMenu').length === 0`
  // 判断菜单有没有出现，这里必须给出真值，否则入口永远不会注入。
  set.length = el ? 1 : 0;
  set.on = (type, handler) => {
    // 把 jQuery 的 .on('click', fn) 落到真节点上,冒烟里才能真的点开面板
    const node = el?.__node ?? el;
    if (node?.addEventListener && typeof type === 'string') {
      node.addEventListener(type, (event) => {
        // jQuery 回调拿到的是包装对象;这里优先给它原始事件,兼容两种写法
        if (typeof handler === 'function') handler(event);
      });
    }
    return set;
  };
  set.off = () => set;
  set.ready = (fn) => {
    if (typeof fn === 'function') fn();
    return set;
  };
  set.append = (child) => {
    const node = child?.__node ?? child;
    if (node && el?.appendChild) el.appendChild(node);
    return set;
  };
  set.hide = () => set;
  set.show = () => set;
  set.each = () => set;
  set.__node = el;
  return set;
};

const jqStub = (arg) => {
  if (typeof arg === 'function') {
    arg();
    return wrap(null);
  }
  if (typeof arg === 'string') {
    const html = arg.trim();
    if (html.startsWith('<')) {
      const tpl = window.document.createElement('template');
      tpl.innerHTML = html;
      return wrap(tpl.content.firstElementChild);
    }
    return wrap(window.document.querySelector(arg));
  }
  return wrap(arg ?? null);
};
window.$ = window.jQuery = Object.assign(jqStub, { fn: {} });

for (const key of [
  'SillyTavern',
  'toastr',
  'fetch',
  'document',
  'window',
  'localStorage',
  'HTMLElement',
  'SVGElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'Element',
  'Node',
  'ShadowRoot',
  'CSSStyleSheet',
  'MutationObserver',
  'ResizeObserver',
  'matchMedia',
  'CustomEvent',
  'Event',
  'MouseEvent',
  'PointerEvent',
  'KeyboardEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  '$',
  'jQuery',
]) {
  if (window[key] === undefined) continue;
  try {
    globalThis[key] = window[key];
  } catch {
    // navigator 之类的只读全局:Node 自带一份,跳过即可
  }
}
globalThis.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => window.clearTimeout(id);
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const results = [];
function log(name, ok, extra = '') {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
}

try {
  process.on('uncaughtException', (e) => console.error('[uncaught]', e?.message ?? e));
  process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message ?? e));

  // 产物是 ESM:动态 import 才会按模块解析(import.meta 才成立)
  await import(pathToFileURL(bundle).href);
  // hydrateWhenReady 轮询 getContext(最多 ~20s)
  await wait(3500);

  const host = window.document.getElementById('bbi-app-host');
  if (!host) throw new Error('没挂载 #bbi-app-host');
  const shadow = host.shadowRoot;
  if (!shadow) throw new Error('host 没有 shadowRoot');
  log('挂载成功', true);

  // 浮层窗口默认关着,而公开接口刻意不开放「打开面板」(那是 UI 动作,不是第三方契约)。
  // 这里走真实入口:等 menu.ts 的轮询把魔杖项注入 #extensionsMenu,再点它 ——
  // 这条路径同时验证了「入口注入」这层,比直接改 ui.open 更有意义。
  await wait(1200);
  const menuItem = document.getElementById('bbi-menu-item');
  log('魔杖入口已注入', !!menuItem);
  menuItem?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(600);

  let navButtons = [...shadow.querySelectorAll('nav button')];
  if (!navButtons.length) {
    log('导航渲染', false, '没找到 nav(窗口没打开)');
  } else {
    log('导航渲染', navButtons.length >= 5, `${navButtons.length} 个按钮`);
  }

  const charsNav = navButtons.find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').includes('角色管理'));
  if (!charsNav) throw new Error('导航里没有「角色管理」');
  charsNav.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(600);

  const pageText = (shadow.textContent ?? '').replace(/\s+/g, ' ');
  log('角色页标题', pageText.includes('角色管理'));
  log('常驻/临时区块', pageText.includes('常驻提示词 / 临时提示词'));
  log('CLIP 追加说明', pageText.includes('追加到 ComfyUI 的 CLIP 文本末尾'));
  log('临时开关', pageText.includes('每楼让模型读取当前装扮'));
  log('预览行', pageText.includes('追加到 CLIP 的内容'));

  const failed = results.filter((ok) => !ok).length;
  if (failed) {
    console.log('\n✗ 有断言失败');
    process.exit(1);
  }
  console.log('\n✓ 全部通过');
} catch (error) {
  console.error('✗ 冒烟失败:', error?.message ?? error);
  process.exit(1);
}
