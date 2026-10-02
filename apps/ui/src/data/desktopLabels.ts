/**
 * 桌面状态机的显示文案与色调，**单一来源**。
 *
 * 侧栏、总览卡、日志页都从这里取，避免同一个状态在三处显示成三种说法——
 * 那会让「现在到底起没起」变成一个只能靠猜的问题。
 */

import type { ChipTone } from '../components/Chips';
import type { ProxyState } from './desktopBridge';

export const STATE_LABEL: Record<ProxyState, string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  failed: '启动失败',
  external: '外部实例（只观察）'
};

export const STATE_TONE: Record<ProxyState, ChipTone> = {
  stopped: 'pending',
  starting: 'warn',
  running: 'ok',
  failed: 'danger',
  external: 'accent'
};

export const STREAM_LABEL: Record<'stdout' | 'stderr' | 'main', string> = {
  stdout: '子进程 stdout',
  stderr: '子进程 stderr',
  main: '桌面主进程'
};
