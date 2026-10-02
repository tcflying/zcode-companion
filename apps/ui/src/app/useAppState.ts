import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { makeLogEntry, type LogEntry, type LogLevel } from '../lib/logger';
import {
  DEFAULT_LOCAL_API_BASE_URL,
  LOOPBACK_API_BASE_URL,
  resolveCatalogUrl
} from '../data/localApiSource';

export interface AppState {
  logs: LogEntry[];
  log: (level: LogLevel, source: string, message: string) => void;
  clearLogs: () => void;
  bootedAt: number;
  now: number;
  clockBroken: boolean;
  setClockBroken: (broken: boolean) => void;
  /**
   * 「连接本机 API」开关。**默认 false**：UI04 起默认数据源仍是离线 fixture，
   * 动态刷新按 `transport_not_wired` 失败，不发起任何网络请求。
   * 只有用户在设置页显式打开，模型页的动态刷新才会走回环 fetch。
   */
  localApiEnabled: boolean;
  setLocalApiEnabled: (next: boolean) => void;
  /** 本机 API base URL（同源或回环 origin）。只存在本机内存，不落盘、不外发。 */
  localApiBaseUrl: string;
  setLocalApiBaseUrl: (next: string) => void;
}

const BOOT_SOURCE = 'ui.boot';

export function useAppState(): AppState {
  const bootedAt = useRef(Date.now());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [clockBroken, setClockBroken] = useState(false);
  const [localApiEnabled, setLocalApiEnabled] = useState(false);
  const [localApiBaseUrl, setLocalApiBaseUrl] = useState(DEFAULT_LOCAL_API_BASE_URL);

  const log = useCallback((level: LogLevel, source: string, message: string) => {
    setLogs((prev) => [makeLogEntry(level, source, message, Date.now()), ...prev].slice(0, 200));
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    log('INFO', BOOT_SOURCE, '界面壳已加载（UI01）。本轮不接入任何运行时。');
    log(
      'INFO',
      'ui.network',
      `网络边界（UI04）：默认零网络。开启「连接本机 API」后只允许回环自连（${LOOPBACK_API_BASE_URL} 或同源），` +
        '只读 GET /v1/zcc/catalog，不发任何模型请求。'
    );
    log('WARN', 'ui.runtime', 'app-server 运行时未接入：未启动、未连接、未做账号握手。');
    log('WARN', 'ui.catalog', '模型目录未接入：目录 revision 未获取，列表为空，计费类别统一 unknown。');
    log('INFO', 'ui.evidence', '证据等级 E0：无有效资格与计费证据，发送门保持关闭（零 dispatch）。');
  }, [log]);

  const effectiveNow = useMemo(() => (clockBroken ? Number.NaN : now), [clockBroken, now]);

  return {
    logs,
    log,
    clearLogs,
    bootedAt: bootedAt.current,
    now: effectiveNow,
    clockBroken,
    setClockBroken,
    localApiEnabled,
    setLocalApiEnabled: (next) => {
      setLocalApiEnabled(next);
      if (next) {
        const verdict = resolveCatalogUrl(localApiBaseUrl);
        log(
          'INFO',
          'ui.settings',
          `已开启「连接本机 API」：动态刷新将只读 ${verdict.ok ? verdict.url : '（base URL 被回环守卫拒绝）'}。` +
            '不发任何模型请求，条目仍恒为未验证、不可发送。'
        );
      } else {
        log('INFO', 'ui.settings', '已关闭「连接本机 API」：UI 回到完全零网络的离线 fixture 路径。');
      }
    },
    localApiBaseUrl,
    setLocalApiBaseUrl: (next) => {
      setLocalApiBaseUrl(next);
      const verdict = resolveCatalogUrl(next);
      log(
        verdict.ok ? 'INFO' : 'WARN',
        'ui.settings',
        verdict.ok
          ? `本机 API base URL 已设为 ${JSON.stringify(next)} → 目录请求 ${verdict.url}。`
          : `本机 API base URL 被回环守卫拒绝：${verdict.reason}`
      );
    }
  };
}

