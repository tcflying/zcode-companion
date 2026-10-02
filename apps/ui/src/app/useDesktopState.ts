/**
 * 桌面状态订阅：把 `window.zccDesktop` 的快照与日志尾收进 React。
 *
 * 纪律：
 *  - **不在本文件做任何网络调用**（见 `data/desktopBridge.ts` 的第 1 条硬约束）。
 *  - 桥缺席时不订阅、不轮询、不报错：返回 `available: false` 与一个如实为
 *    `stopped` 的快照，界面照常渲染。
 *  - 订阅回调抛错绝不能把状态同步搞崩，所以整条回调体包在 try 里。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  UNAVAILABLE_SNAPSHOT,
  desktopAvailable,
  readLogTail,
  readSnapshot,
  subscribeDesktop,
  type DesktopLogLine,
  type ProxySnapshot,
  type SettingsBundle
} from '../data/desktopBridge';
import { readSettings } from '../data/desktopBridge';

export interface DesktopState {
  available: boolean;
  snapshot: ProxySnapshot;
  logs: DesktopLogLine[];
  settings: SettingsBundle | null;
  /** 拉一次最新快照（进入页面、点刷新时用）。 */
  refresh: () => void;
  /** 拉一次日志尾。 */
  refreshLogs: () => void;
  /** 拉一次设置。 */
  refreshSettings: () => void;
}

export function useDesktopState(): DesktopState {
  const available = desktopAvailable();
  const [snapshot, setSnapshot] = useState<ProxySnapshot>({ ...UNAVAILABLE_SNAPSHOT });
  const [logs, setLogs] = useState<DesktopLogLine[]>([]);
  const [settings, setSettings] = useState<SettingsBundle | null>(null);
  /** available 只由桥的有无决定，组件生命周期内不变；存 ref 避免闭包过期。 */
  const availableRef = useRef(available);
  availableRef.current = available;

  const refresh = useCallback(() => {
    if (!availableRef.current) return;
    void readSnapshot().then(
      (next) => setSnapshot(next),
      () => setSnapshot({ ...UNAVAILABLE_SNAPSHOT, lastError: '读取桌面状态失败' })
    );
  }, []);

  const refreshLogs = useCallback(() => {
    if (!availableRef.current) return;
    void readLogTail(200).then(
      (next) => setLogs(next),
      () => setLogs([])
    );
  }, []);

  const refreshSettings = useCallback(() => {
    if (!availableRef.current) return;
    void readSettings().then(
      (next) => setSettings(next),
      () => setSettings(null)
    );
  }, []);

  useEffect(() => {
    if (!availableRef.current) return;
    void readSnapshot().then(
      (next) => setSnapshot(next),
      () => undefined
    );
    void readLogTail(200).then(
      (next) => setLogs(next),
      () => undefined
    );
    void readSettings().then(
      (next) => setSettings(next),
      () => undefined
    );
    const unsubscribe = subscribeDesktop((payload) => {
      setSnapshot(payload.snapshot);
      setLogs(payload.logs);
    });
    return unsubscribe;
  }, []);

  return { available, snapshot, logs, settings, refresh, refreshLogs, refreshSettings };
}
