/**
 * 桌面状态订阅：把 `window.zccDesktop` 的快照与日志尾收进 React。
 *
 * 纪律：
 *  - **不在本文件做任何网络调用**（见 `data/desktopBridge.ts` 的第 1 条硬约束）。
 *  - 桥缺席时不订阅、不轮询、不报错：返回 `available: false` 与一个如实为
 *    `stopped` 的快照，界面照常渲染。
 *  - 订阅回调抛错绝不能把状态同步搞崩，所以整条回调体包在 try 里。
 *  - 快照与日志**各走一条独立的 `DesktopStream` 通道**：读取回包落地前先问
 *    「我还是最新的一代吗」，不是就直接拒掉，绝不覆盖更新的推送/状态。
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

/** 回包被拒的原因。被拒时 `value` 是**当前生效值**，调用方原样保留即可。 */
export type DesktopStaleReason = 'stale-read' | 'disposed';

export interface DesktopSettle<T> {
  /** 是否被接受。`false` 时调用方**不得**用 `value` 覆盖当前值。 */
  accepted: boolean;
  /** 被接受时是本次结果；被拒时是通道当前仍生效的值。 */
  value: T;
  /** 被拒原因；`accepted` 时恒为 `null`。 */
  reason: DesktopStaleReason | null;
}

/**
 * 一条「读取 / 推送」通道的裁决面。
 *
 * 快照与日志**各用一条**——两者的时序互不相同，绑在一起就会出现"日志被
 * 一条无关的快照推送判成过期"或"日志覆盖了更新的推送"。
 */
export interface DesktopStream<T> {
  /** 登记一次在途读取，返回本次读取的序号。 */
  beginRead(): number;
  /** 推流到达：这是一代更新，比它晚发出的读取才有资格落地。 */
  push(value: T): void;
  /** 读取回包落地。过期或已卸载时拒绝，原样保留当前值。 */
  settle(seq: number, value: T): DesktopSettle<T>;
  /** 组件挂载（含 StrictMode 的重挂）：重新武装本通道。 */
  mount(): void;
  /** 组件卸载：令所有在途结果失效。 */
  dispose(): void;
  /** 当前生效值。 */
  current(): T;
}

/**
 * 建一条通道。
 *
 * 两条计数互不外借：
 *  - `readSeq` 是**读取序号**：每发一次读取就 +1，序号只标识"这是哪一次读"。
 *  - `generation` 是**更新代次**：每来一次推送（或一次卸载）就 +1。
 *
 * 一次读取在 `beginRead` 时记住当时的代次；回包落地时只有「序号仍在册」且
 * 「代次没变」才被接受。**判断只看这两样，绝不比较业务字段**——快照里的
 * `lastChangedAt` 会回绕、也会因为主进程时钟回拨而失真，拿它比大小会放行
 * 真正过期的回包（卡上硬边界：不能仅靠 `lastChangedAt` 防覆盖）。
 *
 * 未 `mount` 之前一律判 `disposed`：没有活着的组件，就不该有回包落地。
 */
export function createDesktopStream<T>(initial: T): DesktopStream<T> {
  let value = initial;
  let readSeq = 0;
  let generation = 0;
  let disposed = true;
  /** 读取序号 → 发出时的更新代次。在途读取凭它判断自己是不是过期了。 */
  const inFlight = new Map<number, number>();

  return {
    beginRead() {
      readSeq += 1;
      inFlight.set(readSeq, generation);
      return readSeq;
    },
    push(next) {
      generation += 1;
      value = next;
    },
    settle(seq, next) {
      if (disposed) return { accepted: false, value, reason: 'disposed' };
      const issuedAt = inFlight.get(seq);
      // 序号不在册 = 重复结算或早已被作废；代次对不上 = 期间来了更新的推送。
      if (issuedAt === undefined || issuedAt !== generation) {
        inFlight.delete(seq);
        return { accepted: false, value, reason: 'stale-read' };
      }
      inFlight.delete(seq);
      value = next;
      return { accepted: true, value, reason: null };
    },
    mount() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      // 代次也推进一格：即便有读取侥幸留在册，它记下的旧代次也永远对不上。
      generation += 1;
      inFlight.clear();
    },
    current() {
      return value;
    }
  };
}

/**
 * 桌面设置读取结果的四态标签。
 *
 * 卡上硬边界：缺桥 / 读取中 / 失败 三种必须**可区分**——压成一个 `null` 的
 * 旧形态会把「读取失败」渲染成「桌面壳未接入」，并让保存按钮在从未读到过
 * 配置时依然可点，于是初始草稿（8790 / official-host / low）会把主进程里
 * 的真实值覆盖掉。`failed` 与 `loaded` 分开，就是为了让"读到过但读不到"
 * 不等于"读到过"。
 */
export type SettingsLoad = 'no-bridge' | 'loading' | 'loaded' | 'failed';

export interface DesktopState {
  available: boolean;
  snapshot: ProxySnapshot;
  logs: DesktopLogLine[];
  /** 最后一次**成功**读到的设置。失败时**保留**上一次的值（可能为 null），不置空。 */
  settings: SettingsBundle | null;
  /** 本次读取走到哪一步了。与 `settings` 的去留解耦：值负责"手上有什么"，标签负责"这值可不可信"。 */
  settingsLoad: SettingsLoad;
  /** 拉一次最新快照（进入页面、点刷新时用）。 */
  refresh: () => void;
  /** 拉一次日志尾。 */
  refreshLogs: () => void;
  /** 拉一次设置。 */
  refreshSettings: () => void;
}

/** 快照与日志两条通道的容器。每组件实例一份，**不引入任何新的全局可变状态**。 */
export interface DesktopStreams {
  snapshot: DesktopStream<ProxySnapshot>;
  logs: DesktopStream<DesktopLogLine[]>;
}

export function createDesktopStreams(): DesktopStreams {
  return {
    snapshot: createDesktopStream<ProxySnapshot>({ ...UNAVAILABLE_SNAPSHOT }),
    logs: createDesktopStream<DesktopLogLine[]>([])
  };
}

export function useDesktopState(): DesktopState {
  const available = desktopAvailable();
  const [snapshot, setSnapshot] = useState<ProxySnapshot>({ ...UNAVAILABLE_SNAPSHOT });
  const [logs, setLogs] = useState<DesktopLogLine[]>([]);
  const [settings, setSettings] = useState<SettingsBundle | null>(null);
  /** 读取四态。初值按桥的有无给：缺桥就是 no-bridge，否则正在读。 */
  const [settingsLoad, setSettingsLoad] = useState<SettingsLoad>(available ? 'loading' : 'no-bridge');
  /** available 只由桥的有无决定，组件生命周期内不变；存 ref 避免闭包过期。 */
  const availableRef = useRef(available);
  availableRef.current = available;
  /** 两条裁决通道按实例惰性创建；identity 在组件生命周期内稳定。 */
  const streamsRef = useRef<DesktopStreams | null>(null);
  if (streamsRef.current === null) streamsRef.current = createDesktopStreams();
  const streams = streamsRef.current;

  const refresh = useCallback(() => {
    if (!availableRef.current) return;
    const seq = streams.snapshot.beginRead();
    void readSnapshot().then(
      (next) => applySnapshot(streams.snapshot, seq, next, setSnapshot),
      () => applySnapshot(
        streams.snapshot,
        seq,
        { ...UNAVAILABLE_SNAPSHOT, lastError: '读取桌面状态失败' },
        setSnapshot
      )
    );
  }, [streams]);

  const refreshLogs = useCallback(() => {
    if (!availableRef.current) return;
    const seq = streams.logs.beginRead();
    void readLogTail(200).then(
      (next) => applyLogs(streams.logs, seq, next, setLogs),
      () => applyLogs(streams.logs, seq, [], setLogs)
    );
  }, [streams]);

  const settingsReadSeq = useRef(0);

  const refreshSettings = useCallback(() => {
    const seq = ++settingsReadSeq.current;
    if (!availableRef.current) {
      setSettingsLoad('no-bridge');
      return;
    }
    setSettingsLoad('loading');
    void readSettings().then(
      (next) => {
        if (seq !== settingsReadSeq.current) return;
        // 读到 null 只可能是桥在读取途中消失，如实标回缺桥。
        if (next === null) {
          setSettingsLoad('no-bridge');
          return;
        }
        setSettings(next);
        setSettingsLoad('loaded');
      },
      // 失败**只改标签、不动值**：保留最后一次成功的设置，界面据此标"陈旧"。
      () => {
        if (seq === settingsReadSeq.current) setSettingsLoad('failed');
      }
    );
  }, []);

  useEffect(() => {
    if (!availableRef.current) return;
    streams.snapshot.mount();
    streams.logs.mount();
    const snapshotSeq = streams.snapshot.beginRead();
    void readSnapshot().then(
      (next) => applySnapshot(streams.snapshot, snapshotSeq, next, setSnapshot),
      () => undefined
    );
    const logsSeq = streams.logs.beginRead();
    void readLogTail(200).then(
      (next) => applyLogs(streams.logs, logsSeq, next, setLogs),
      () => undefined
    );
    refreshSettings();
    const unsubscribe = subscribeDesktop((payload) => {
      streams.snapshot.push(payload.snapshot);
      setSnapshot(payload.snapshot);
      streams.logs.push(payload.logs);
      setLogs(payload.logs);
    });
    return () => {
      settingsReadSeq.current += 1;
      streams.snapshot.dispose();
      streams.logs.dispose();
      unsubscribe();
    };
  }, [streams, refreshSettings]);

  return { available, snapshot, logs, settings, settingsLoad, refresh, refreshLogs, refreshSettings };
}

type SetSnapshot = (next: ProxySnapshot) => void;
type SetLogs = (next: DesktopLogLine[]) => void;

function applySnapshot(
  stream: DesktopStream<ProxySnapshot>,
  seq: number,
  next: ProxySnapshot,
  setSnapshot: SetSnapshot
): void {
  const settled = stream.settle(seq, next);
  if (settled.accepted) setSnapshot(settled.value);
}

function applyLogs(
  stream: DesktopStream<DesktopLogLine[]>,
  seq: number,
  next: DesktopLogLine[],
  setLogs: SetLogs
): void {
  const settled = stream.settle(seq, next);
  if (settled.accepted) setLogs(settled.value);
}
