/**
 * 私有 vitest 环境适配层（审计用，不入正式树）。
 *
 * 技术缺口说明：
 * vitest 5 的 `--environment <path>` 要求该模块 default export 一个带
 * `setup` / `setupVM` 方法的对象。happy-dom 的主入口 `lib/index.js`
 * 导出的是 Window 类，不是这种形状，所以直接指过去会报
 *   "is not a valid environment ... should export default object with a setup"
 *
 * 这里不安装任何依赖，只在运行时用 createRequire 从 bbweb-2 的
 * node_modules 解析 happy-dom（只读引用），把它包成 vitest 认识的环境。
 */

import { createRequire } from 'node:module';

const require2 = createRequire('file:///G:/mmx-project/bbweb-2/frontend/package.json');
const happyDom = require2('happy-dom');

/*
 * 实测（node + createRequire 直接探测）：happy-dom 20.11.6 导出 200 个符号，
 * **不含 GlobalRegistrator**（那是 v14 及更早的 API）。所以只能自己 new 一个
 * Window 实例并把它的 DOM 全局搬到 globalThis。
 */
let win;

/** 这些键在 happy-dom Window 上是取值器，直接取会触发绑定；统一用 Reflect 取。 */
const DOM_GLOBALS = [
  'document',
  'navigator',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'Element',
  'Node',
  'Text',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'InputEvent',
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
  'Blob',
  'FormData'
];

export default {
  // name 只是给日志看的；loadEnvironment 的路径/包名判据看的是 CLI 传入的字符串首字符
  // （'.' 或 '/' 才当路径，见 init.IsjtLXKe.js:loadEnvironment）。
  name: 'happy-dom-private-adapter',
  setup(global) {
    win = new happyDom.Window({ url: 'http://127.0.0.1:8790/', width: 1440, height: 900 });
    const src = win;
    const g = globalThis;
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
    // window 自身必须指向这个 Window（含 location.href，ModelsPage:68 要用）
    g.window = win;
    g.self = win;
    // vitest 传的 global 参数在 node 环境下也是 globalThis，显式合并一次
    if (global && global !== globalThis) {
      for (const key of DOM_GLOBALS) {
        const v = Reflect.get(src, key);
        if (v !== undefined && !(key in global)) {
          try {
            global[key] = v;
          } catch {
            /* ignore */
          }
        }
      }
    }
  },
  teardown() {
    win?.close?.();
    win = undefined;
  }
};
