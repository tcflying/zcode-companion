/**
 * 预加载脚本：只暴露只读的静态元数据。
 *
 * 不暴露 ipcRenderer、不暴露 require/fs、不暴露任何可写入的通道。
 * 界面当前不依赖该对象；保留它是为了后续 I10 接入时有一个最小、无凭据的契约面。
 */

'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('zcodeCompanionShell', Object.freeze({
  productName: 'ZCode Companion',
  disclaimer: '独立软件 · 非 ZCode 官方',
  shellKind: 'ui-shell',
  runtimeConnected: false,
  version: '0.1.0'
}));
