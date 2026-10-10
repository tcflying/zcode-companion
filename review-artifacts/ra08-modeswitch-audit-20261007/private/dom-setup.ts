/**
 * 私有 setup 文件（审计用，**不入正式树**）。
 *
 * 为什么不用 vitest 的自定义 environment：
 *   实测 vitest 5 的 --environment 走 Vite 6 environments API
 *   （index.C-uw7tH9.js:10438 `project.vite.environments[name]`），
 *   传绝对路径会被当包名、传具名又要求在 Vite config 里注册，
 *   两条路都撞 "not defined in the Vite config"。这是vitest 5 的真实约束。
 *
 * 绕过办法（本文件采用）：**不换环境**，就在官方既有的 `node` 环境里，
 * 用 setupFile 把 happy-dom 的 DOM 全局装到 globalThis 上。
 * 这样零 config 改动、零依赖安装，vitest 的环境解析完全不参与。
 *
 * 兼容性事实（实测）：
 *   happy-dom 20.11.6 导出 200 个符号，**不含 GlobalRegistrator**
 *   （那是 v14 及更早的 API），所以只能 new Window 再手动搬全局。
 */

import { createRequire } from 'node:module';

const require2 = createRequire('file:///G:/mmx-project/bbweb-2/frontend/package.json');
const happyDom = require2('happy-dom');

const win = new happyDom.Window({
  url: 'http://127.0.0.1:8790/',
  width: 1440,
  height: 900
});

const DOM_GLOBALS = [
  'document',
  'navigator',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLAnchorElement',
  'HTMLDivElement',
  'HTMLSpanElement',
  'HTMLParagraphElement',
  'HTMLTableElement',
  'HTMLTableRowElement',
  'HTMLTableCellElement',
  'HTMLSectionElement',
  'Element',
  'Node',
  'Text',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'InputEvent',
  'FocusEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'CSSStyleDeclaration',
  'MutationObserver',
  'DOMParser',
  'XMLHttpRequest',
  'URL',
  'URLSearchParams',
  'Blob',
  'FormData',
  'Headers',
  'Response',
  'Request',
  'AbortController',
  'CSS'
];

const g = globalThis;
const src = win;
for (const key of DOM_GLOBALS) {
  const v = Reflect.get(src, key);
  if (v !== undefined) {
    try {
      g[key] = v;
    } catch {
      /* 只读全局，忽略 */
    }
  }
}
g.window = win;
g.self = win;

// React 19 的 act 需要这个开关，否则 act 不生效（会警告且不 flush）
g.IS_REACT_ACT_ENVIRONMENT = true;

export {};
