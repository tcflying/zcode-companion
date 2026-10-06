/**
 * 预加载脚本：桌面能力的唯一桥（I10）。
 *
 * 硬边界：
 *  1. **不暴露 `ipcRenderer` 本体、不暴露 `require`/`fs`/任何可写通道。** 界面能做的
 *     每一件事都是下面这九个具名方法，主进程侧另有闭集校验。
 *  2. **凭据不过桥。** `getSettings` 返回的是掩码 + `zcc-fp:*` 指纹，明文 key 永远
 *     不出现在任何跨进程的返回值里（契约见 `apps/desktop/lib/settings.cjs`）。
 *  3. **订阅只回快照与日志尾**，两者都不含凭据。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 主进程推送状态变化用的通道名。渲染进程只读，不通过它发任何东西。 */
const PUSH_CHANNEL = 'zcc:desktop:changed';

const bridge = {
  productName: 'ZCode Companion',
  disclaimer: '独立软件 · 非 ZCode 官方',
  /** true 表示运行在桌面壳里；false 表示在 vite dev / 浏览器里打开，界面据此降级。 */
  desktop: true,
  version: '0.1.0',
  /** 取一次完整快照：状态机状态、PID、端口、external 标志、最近错误。 */
  getSnapshot: () => ipcRenderer.invoke('zcc:desktop:state'),
  /** 订阅状态与日志尾推流；返回退订函数。 */
  subscribe: (/** @type {(payload: unknown) => void} */ handler) => {
    if (typeof handler !== 'function') throw new TypeError('subscribe 需要一个回调函数');
    const listener = (/** @type {unknown} */ _event, /** @type {unknown} */ payload) => {
      try {
        handler(payload);
      } catch {
        /* 界面回调抛错绝不允许把主进程侧的推送通道带崩。 */
      }
    };
    ipcRenderer.on(PUSH_CHANNEL, listener);
    return () => ipcRenderer.removeListener(PUSH_CHANNEL, listener);
  },
  start: () => ipcRenderer.invoke('zcc:desktop:start'),
  stop: () => ipcRenderer.invoke('zcc:desktop:stop'),
  restart: () => ipcRenderer.invoke('zcc:desktop:restart'),
  /** 取子进程输出尾部（环形缓冲，已脱敏）。 */
  getLogTail: (/** @type {number | undefined} */ limit) =>
    ipcRenderer.invoke('zcc:desktop:log', typeof limit === 'number' ? limit : 200),
  getSettings: () => ipcRenderer.invoke('zcc:desktop:settings:get'),
  /**
   * 保存设置。`apiKey` 留空或等于掩码表示「不改」，换 key 才提交新值。
   * 返回体同样只含掩码与指纹。
   */
  saveSettings: (/** @type {unknown} */ next) => ipcRenderer.invoke('zcc:desktop:settings:save', next)
};

contextBridge.exposeInMainWorld('zccDesktop', Object.freeze(bridge));
contextBridge.exposeInMainWorld(
  'zcodeCompanionShell',
  Object.freeze({
    productName: bridge.productName,
    disclaimer: bridge.disclaimer,
    shellKind: 'desktop',
    runtimeConnected: false,
    version: bridge.version
  })
);
