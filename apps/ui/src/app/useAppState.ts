import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { makeLogEntry, type LogEntry, type LogLevel } from '../lib/logger';
import {
  DEFAULT_LOCAL_API_BASE_URL,
  LOOPBACK_API_BASE_URL,
  resolveCatalogUrl,
  fetchReadStatus
} from '../data/localApiSource';
import {
  INITIAL_READ_STATUS_STATE,
  parseReadStatus,
  type ReadStatusState
} from '../data/readStatus';

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
  /**
   * 证据读取状态（ZCC-GUI-EVIDENCE-20261008-A）。
   * **默认 idle = 零网络**；只有用户在总览页手动点刷新才会真的发一次只读 GET。
   */
  readStatus: ReadStatusState;
  /** 手动只读刷新。失败即 `failed`，**不保留旧事实**。 */
  refreshReadStatus: () => Promise<void>;
}

const BOOT_SOURCE = 'ui.boot';

export function useAppState(): AppState {
  const bootedAt = useRef(Date.now());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [clockBroken, setClockBroken] = useState(false);
  const [localApiEnabled, setLocalApiEnabled] = useState(false);
  const [localApiBaseUrl, setLocalApiBaseUrl] = useState(DEFAULT_LOCAL_API_BASE_URL);
  const [readStatus, setReadStatus] = useState<ReadStatusState>(INITIAL_READ_STATUS_STATE);

  const log = useCallback((level: LogLevel, source: string, message: string) => {
    setLogs((prev) => [makeLogEntry(level, source, message, Date.now()), ...prev].slice(0, 200));
  }, []);

  /**
   * 迟到失效守卫：每次刷新、切源、关开关、卸载都会让当前 token 失效。
   * 在途响应回来时 token 已不匹配 → **直接丢弃**，旧事实不得冒充当前。
   */
  const readStatusToken = useRef(0);
  useEffect(() => () => { readStatusToken.current += 1; }, []);

  const refreshReadStatus = useCallback(async () => {
    if (!localApiEnabled) {
      setReadStatus({ phase: 'disabled', snapshot: null, failure: null, loadedAt: null });
      log('INFO', 'ui.readstatus', '未开启「连接本机 API」：证据状态保持未接入，不发起任何请求。');
      return;
    }
    const token = ++readStatusToken.current;
    setReadStatus({ phase: 'loading', snapshot: null, failure: null, loadedAt: null });
    try {
      const raw = await fetchReadStatus(localApiBaseUrl, undefined);
      if (token !== readStatusToken.current) return; // 迟到：丢弃
      const parsed = parseReadStatus(JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)));
      if (parsed === null) {
        setReadStatus({
          phase: 'failed',
          snapshot: null,
          failure: { code: 'malformed_payload', message: '证据状态响应不符合契约形状，已整体拒绝（不做部分采纳）。', at: Date.now() },
          loadedAt: null
        });
        log('WARN', 'ui.readstatus', '证据状态响应形状不合契约，已整体拒绝。');
        return;
      }
      setReadStatus({ phase: 'loaded', snapshot: parsed, failure: null, loadedAt: Date.now() });
      log(
        'INFO',
        'ui.readstatus',
        `已读到证据状态：驱动 ${parsed.driver.kind}/${parsed.driver.status}，来源 ${parsed.catalog.sourceKind}，` +
          `E1 阻断 ${parsed.e1Blocking.length} 项、使用观测提示 ${parsed.usageWarnings.length} 项。仍不定级。`
      );
    } catch (err) {
      if (token !== readStatusToken.current) return; // 迟到：丢弃
      const e = err as { reason?: string; message?: string };
      setReadStatus({
        phase: 'failed',
        snapshot: null,
        // 失败**不保留**旧 snapshot：旧事实不能冒充当前
        failure: { code: e.reason ?? 'unknown', message: e.message ?? '未知失败', at: Date.now() },
        loadedAt: null
      });
      log('WARN', 'ui.readstatus', `证据状态读取失败（${e.reason ?? 'unknown'}）：${e.message ?? ''}`);
    }
  }, [localApiEnabled, localApiBaseUrl, log]);
  const clearLogs = useCallback(() => setLogs([]), []);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    log('INFO', BOOT_SOURCE, '界面已加载；默认零网络，历史证据需显式开启本机 API 后手动读取。');
    log(
      'INFO',
      'ui.network',
      `网络边界（UI04）：默认零网络。开启「连接本机 API」后只允许回环自连（${LOOPBACK_API_BASE_URL} 或同源），` +
        '只读 GET /v1/zcc/catalog 与 /v1/zcc/readstatus，不发任何模型请求。'
    );
    log('WARN', 'ui.runtime', '当前官方进程、心跳与账号握手未观测；历史 driver.ready 不证明当前握手。');
    log('WARN', 'ui.catalog', '目录尚未读取；读取目录与历史资格状态仍不证明当前发送资格。');
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
      // 关开关 = 立即失效在途读取，并把状态打回 disabled（不得保留旧事实）
      readStatusToken.current += 1;
      setReadStatus({ phase: next ? 'idle' : 'disabled', snapshot: null, failure: null, loadedAt: null });
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
      // 切源 = 立即失效在途读取；旧源的响应不得落到新源上
      readStatusToken.current += 1;
      setReadStatus({ phase: localApiEnabled ? 'idle' : 'disabled', snapshot: null, failure: null, loadedAt: null });
      const verdict = resolveCatalogUrl(next);
      log(
        verdict.ok ? 'INFO' : 'WARN',
        'ui.settings',
        verdict.ok
          ? `本机 API base URL 已设为 ${JSON.stringify(next)} → 目录请求 ${verdict.url}。`
          : `本机 API base URL 被回环守卫拒绝：${verdict.reason}`
      );
    },
    readStatus,
    refreshReadStatus
  };
}

