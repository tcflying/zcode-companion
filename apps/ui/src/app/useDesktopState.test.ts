/**
 * ZC-44 · F25「旧读取回包可覆盖新推送」的回归钉。
 *
 * 缺陷事实（见 1005.md §9.7 ZC-44）：`useDesktopState.ts` 初读 / 刷新两条
 * `readSnapshot` / `readLogTail` 是**异步**的，而 `main.cjs` 的推流是**同步**的。
 * 实测：读取拿到的是旧值（`starting` / 日志 0 行），但它的 `.then` 落地晚于一次
 * `changed` 推送（`running` / 日志 1 行）——结果是**状态与日志双双倒退**。正常顺序
 * 下不倒退，所以它是竞态不是恒 bug。
 *
 * 本组用例会：
 *  1. 复现"旧读取回包晚于新推送落地"导致的倒退。这里的"晚"由**调用顺序**表达
 *     ——`createDesktopStream` 是同步 API，先发读取、后收推送、再结算读取，就是
 *     该时序的忠实编码；异步的 IPC 形状由 hook 侧（`useDesktopState.ts`）承载，
 *     本套件不重建它，也不声称用手动 resolve 的 promise 制造过延迟；
 *  2. 钉住"过期回包被拒"，快照与日志**各走一条独立通道**（机制不同，各有断言）；
 *  3. 负例：正常顺序不回归 / 卸载令在途结果失效 / StrictMode 重挂可恢复；
 *  4. 钉住"过期裁决**不依赖** `lastChangedAt`"——否则一条 lastChangedAt 更新的
 *     回包会被误放行。`lastChangedAt` 只存在于 `ProxySnapshot`，`DesktopLogLine`
 *     没有这个字段，所以这条只能落在快照通道上。
 *
 * 全部为纯函数 / 纯通道测试：零网络、零磁盘、零 React 渲染（环境是 node，见
 * `apps/ui/vitest.config.ts`）。真实 DOM 保留性由收尾阶段主会话真 GUI 验收承担。
 * 不使用恒真断言、不 skip。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  createDesktopStream,
  createDesktopStreams,
  useDesktopState,
  type DesktopState,
  type DesktopStream,
  type SettingsLoad
} from './useDesktopState';
import {
  UNAVAILABLE_SNAPSHOT,
  type DesktopLogLine,
  type ProxySnapshot,
  type ProxyState,
  type SettingsBundle
} from '../data/desktopBridge';
import { SettingsPage } from '../pages/SettingsPage';
import type { AppState } from './useAppState';

/* ------------------------------------------------------------------ *
 * 测试夹具：完全照抄 F25 实测里的两组值
 * ------------------------------------------------------------------ */

/** 读取拿到的旧值：`starting`、日志 0 行、时间戳落在 at20 一带。 */
function staleSnapshot(): ProxySnapshot {
  return { ...UNAVAILABLE_SNAPSHOT, state: 'starting', lastChangedAt: 20, pid: null, port: null };
}

/** 推送带来的新值：`running`、日志 1 行、时间戳落在 at30 一带。 */
function pushedSnapshot(): ProxySnapshot {
  return {
    ...UNAVAILABLE_SNAPSHOT,
    state: 'running',
    lastChangedAt: 30,
    pid: 4242,
    port: 8791,
    configuredPort: 8791,
    owned: true,
    canControl: true
  };
}

function line(seq: number, at: number, text: string): DesktopLogLine {
  return { seq, at, stream: 'main', text };
}

function snapshotWith(state: ProxyState, lastChangedAt: number): ProxySnapshot {
  return { ...UNAVAILABLE_SNAPSHOT, state, lastChangedAt };
}

/** 把通道装到"已挂载"状态，等价于 hook 内部 effect 开头做的 mount。 */
function mountedStreams(): { snapshot: DesktopStream<ProxySnapshot>; logs: DesktopStream<DesktopLogLine[]> } {
  const streams = createDesktopStreams();
  streams.snapshot.mount();
  streams.logs.mount();
  return streams;
}

/* ------------------------------------------------------------------ *
 * 复现：旧读取回包晚于推送落地 → 状态与日志双双倒退
 * ------------------------------------------------------------------ */

describe('ZC-44 · F25 复现：旧读取回包晚于新推送落地', () => {
  it('F25-REP-1 读取取得旧值但交付晚于 changed 时，快照与日志都不得从 running/at30/1行 倒退为 starting/at20/0行', () => {
    const streams = mountedStreams();
    // t0：初读发出——它读到的是旧值，回包尚未结算。
    const snapshotSeq = streams.snapshot.beginRead();
    const logsSeq = streams.logs.beginRead();

    // t1：主进程推来 changed——这是**更新的一代**，必须原地生效。
    streams.snapshot.push(pushedSnapshot());
    streams.logs.push([line(1, 30, 'changed: running')]);
    expect(streams.snapshot.current()).toMatchObject({ state: 'running', lastChangedAt: 30 });
    expect(streams.logs.current()).toHaveLength(1);

    // t2：旧读取的回包这才结算（它取到的确实是 starting / 0 行）。
    const settledSnapshot = streams.snapshot.settle(snapshotSeq, staleSnapshot());
    const settledLogs = streams.logs.settle(logsSeq, []);

    // 两条都必须在落地前被识破为过期。
    expect(settledSnapshot.accepted).toBe(false);
    expect(settledLogs.accepted).toBe(false);
    // 并且界面看到的内容真的没有倒退。
    expect(streams.snapshot.current()).toMatchObject({ state: 'running', lastChangedAt: 30, port: 8791 });
    expect(streams.snapshot.current().state).not.toBe('starting');
    expect(streams.logs.current()).toHaveLength(1);
    expect(streams.logs.current()[0]?.at).toBe(30);
  });
});

/* ------------------------------------------------------------------ *
 * 绿：过期结果被拒
 * ------------------------------------------------------------------ */

describe('ZC-44 · 过期读取回包被拒，正常顺序仍更新', () => {
  it('F25-1 快照通道：推送后落地的旧回包被拒，通道仍停在推送那一代', () => {
    const stream = mountedStreams().snapshot;
    const seq = stream.beginRead();
    stream.push(pushedSnapshot());
    const settled = stream.settle(seq, staleSnapshot());
    expect(settled.accepted).toBe(false);
    expect(settled.reason).toBe('stale-read');
    // 被拒时交回的是**当前生效值**，调用方原样保留即可。
    expect(settled.value).toBe(stream.current());
    expect(settled.value.state).toBe('running');
  });

  it('F25-2 日志通道：推送后落地的旧日志尾被拒，通道仍停在推送那一代', () => {
    const stream = mountedStreams().logs;
    const seq = stream.beginRead();
    const pushed = [line(1, 30, 'changed: running')];
    stream.push(pushed);
    const settled = stream.settle(seq, []);
    expect(settled.accepted).toBe(false);
    expect(settled.reason).toBe('stale-read');
    expect(settled.value).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 负例 (a)：正常顺序不回归
 * ------------------------------------------------------------------ */

describe('ZC-44 · 负例(a) 正常顺序不得回归', () => {
  it('F25-NEG-A1 读取先落地、推送后到时，快照与日志都照常更新（拒绝逻辑不得变成"一律不更新"）', () => {
    const streams = mountedStreams();
    const seq = streams.snapshot.beginRead();
    const settled = streams.snapshot.settle(seq, staleSnapshot());
    expect(settled.accepted).toBe(true);
    expect(settled.reason).toBeNull();
    expect(streams.snapshot.current().state).toBe('starting');

    const logsSeq = streams.logs.beginRead();
    const settledLogs = streams.logs.settle(logsSeq, [line(1, 20, 'starting')]);
    expect(settledLogs.accepted).toBe(true);
    expect(streams.logs.current()).toHaveLength(1);

    // 推送随后到达，照常覆盖。
    streams.snapshot.push(pushedSnapshot());
    streams.logs.push([line(1, 30, 'changed: running')]);
    expect(streams.snapshot.current().state).toBe('running');
    expect(streams.logs.current()[0]?.at).toBe(30);
  });

  it('F25-NEG-A2 推送之后才发起的读取仍然被接受——用户主动点刷新不能被误拒', () => {
    const streams = mountedStreams();
    streams.snapshot.push(pushedSnapshot());
    streams.logs.push([line(1, 30, 'changed: running')]);
    // 刷新发生在推送**之后**，它是新发起的一代读。
    const seq = streams.snapshot.beginRead();
    const settled = streams.snapshot.settle(seq, pushedSnapshot());
    expect(settled.accepted).toBe(true);
    expect(settled.reason).toBeNull();
    const logsSeq = streams.logs.beginRead();
    expect(streams.logs.settle(logsSeq, [line(1, 30, 'changed: running'), line(2, 31, 'ready')]).accepted).toBe(true);
    expect(streams.logs.current()).toHaveLength(2);
  });

  it('F25-NEG-A3 没有任何推送时的连续两次读取：两次都被接受，后到者落地', () => {
    const stream = mountedStreams().snapshot;
    const first = stream.beginRead();
    const second = stream.beginRead();
    expect(stream.settle(first, snapshotWith('starting', 10)).accepted).toBe(true);
    expect(stream.settle(second, snapshotWith('running', 20)).accepted).toBe(true);
    expect(stream.current().state).toBe('running');
  });
});

/* ------------------------------------------------------------------ *
 * 负例 (b)：组件卸载令在途结果失效
 * ------------------------------------------------------------------ */

describe('ZC-44 · 负例(b) 组件卸载令在途结果失效', () => {
  it('F25-NEG-B1 卸载后晚到的快照回包不落地（独立断言）', () => {
    const streams = mountedStreams();
    const seq = streams.snapshot.beginRead();
    streams.snapshot.push(pushedSnapshot());
    streams.snapshot.dispose();
    const settled = streams.snapshot.settle(seq, staleSnapshot());
    expect(settled.accepted).toBe(false);
    expect(settled.reason).toBe('disposed');
    expect(streams.snapshot.current().state).toBe('running');
  });

  it('F25-NEG-B2 卸载后晚到的日志回包不落地（独立断言，与快照各自成立）', () => {
    const streams = mountedStreams();
    const seq = streams.logs.beginRead();
    streams.logs.push([line(1, 30, 'changed: running')]);
    streams.logs.dispose();
    const settled = streams.logs.settle(seq, []);
    expect(settled.accepted).toBe(false);
    expect(settled.reason).toBe('disposed');
    expect(streams.logs.current()).toHaveLength(1);
  });

  it('F25-NEG-B3 卸载即丢弃在途读取：dispose 之后再 settle 一个推送前发出的读取仍是 disposed 而不是被误判成 stale-read', () => {
    const stream = mountedStreams().snapshot;
    const seq = stream.beginRead();
    stream.dispose();
    const settled = stream.settle(seq, staleSnapshot());
    expect(settled.reason).toBe('disposed');
  });

  it('F25-NEG-B4 StrictMode 的挂载→卸载→重挂后通道重新武装，读取照常落地（不能因一次卸载永久失效）', () => {
    const streams = mountedStreams();
    const stale = streams.snapshot.beginRead();
    streams.snapshot.dispose();
    streams.logs.dispose();
    expect(streams.snapshot.settle(stale, staleSnapshot()).accepted).toBe(false);
    // 重挂（effect 在 StrictMode 下会再跑一遍）
    streams.snapshot.mount();
    streams.logs.mount();
    const fresh = streams.snapshot.beginRead();
    const settled = streams.snapshot.settle(fresh, pushedSnapshot());
    expect(settled.accepted).toBe(true);
    expect(streams.snapshot.current().state).toBe('running');
  });
});

/* ------------------------------------------------------------------ *
 * 负例 (c)：快照与日志分别被拒，机制互不相同
 * ------------------------------------------------------------------ */

describe('ZC-44 · 负例(c) 快照与日志的过期机制互相独立', () => {
  it('F25-NEG-C1 同一次推送把两条通道各自判为过期——两条各有自己的代次', () => {
    const streams = mountedStreams();
    const snapshotSeq = streams.snapshot.beginRead();
    const logsSeq = streams.logs.beginRead();
    streams.snapshot.push(pushedSnapshot());
    streams.logs.push([line(1, 30, 'changed: running')]);
    expect(streams.snapshot.settle(snapshotSeq, staleSnapshot()).accepted).toBe(false);
    expect(streams.logs.settle(logsSeq, []).accepted).toBe(false);
  });

  it('F25-NEG-C2 推送后新发起的日志读取不被"快照过期"连坐——两条通道的代次不共享', () => {
    const streams = mountedStreams();
    const staleSnapshotSeq = streams.snapshot.beginRead();
    streams.snapshot.push(pushedSnapshot());
    streams.logs.push([line(1, 30, 'changed: running')]);
    // 旧快照读取被拒…
    expect(streams.snapshot.settle(staleSnapshotSeq, staleSnapshot()).accepted).toBe(false);
    // …但推送之后才发起的日志读取必须照常被接受。
    const freshLogsSeq = streams.logs.beginRead();
    const settled = streams.logs.settle(freshLogsSeq, [line(1, 30, 'changed: running'), line(2, 31, 'ready')]);
    expect(settled.accepted).toBe(true);
    expect(streams.logs.current()).toHaveLength(2);
  });

  it('F25-NEG-C3 快照的过期裁决不依赖 lastChangedAt：lastChangedAt 更新的回包同样被拒', () => {
    // 通道只剩 ProxySnapshot 带 lastChangedAt（DesktopLogLine 无此字段），所以这条落在快照上。
    // 若实现退化成"拿 lastChangedAt 比大小"，这条 lastChangedAt=200 的回包会被误放行。
    const streams = mountedStreams();
    const seq = streams.snapshot.beginRead();
    streams.snapshot.push(pushedSnapshot()); // lastChangedAt = 30
    const settled = streams.snapshot.settle(seq, { ...staleSnapshot(), lastChangedAt: 200 });
    expect(settled.accepted).toBe(false);
    expect(streams.snapshot.current().lastChangedAt).toBe(30);
  });

  it('F25-NEG-C4 快照的过期裁决同样不依赖日志是否推送过——两条通道互不读取对方', () => {
    const streams = mountedStreams();
    const seq = streams.snapshot.beginRead();
    // 只推日志、不推快照
    streams.logs.push([line(1, 30, 'changed: running')]);
    expect(streams.logs.settle(streams.logs.beginRead(), []).accepted).toBe(true);
    // 快照从未收到推送：它是在"没有更新代次"下发出的读取，本就该被接受。
    expect(streams.snapshot.settle(seq, staleSnapshot()).accepted).toBe(true);
  });

  it('F25-NEG-C5 两条通道的读取序号各自记账：在快照通道上重复结算同一个序号，不会连带吃掉日志通道的在途读取', () => {
    const streams = mountedStreams();
    const snapshotSeq = streams.snapshot.beginRead();
    const logsSeq = streams.logs.beginRead();
    // 同一个读取被结算两次：第二次是重复落地，必须被拒。
    expect(streams.snapshot.settle(snapshotSeq, snapshotWith('running', 25)).accepted).toBe(true);
    expect(streams.snapshot.settle(snapshotSeq, snapshotWith('starting', 26)).accepted).toBe(false);
    // 日志通道那条在途读取完全不受影响，仍然能落地。
    expect(streams.logs.settle(logsSeq, [line(7, 27, 'still mine')]).accepted).toBe(true);
    expect(streams.logs.current()[0]?.seq).toBe(7);
    expect(streams.snapshot.current().state).toBe('running');
  });
});

/* ------------------------------------------------------------------ *
 * 接线：hook 用的确实是这两条通道（静态扫描，沿用 modelSource.test.ts 的既有手法）
 * ------------------------------------------------------------------ */

const SOURCE_FILES = import.meta.glob!(['./useDesktopState.ts'], {
  eager: true,
  query: '?raw',
  import: 'default'
}) as Record<string, string>;

function useDesktopStateSource(): string {
  const entry = Object.entries(SOURCE_FILES).find(([path]) => path.endsWith('useDesktopState.ts'));
  expect(entry).toBeDefined();
  return entry![1];
}

describe('ZC-44 · 接线：hook 走的是这两条通道', () => {
  it('F25-WIRE-1 模块导出 hook 与通道工厂（前提不是恒真）', () => {
    expect(typeof useDesktopState).toBe('function');
    expect(typeof createDesktopStream).toBe('function');
    const stream = createDesktopStream<string>('init');
    expect(stream.current()).toBe('init');
  });

  it('F25-WIRE-2 读取回包不得直达 setSnapshot/setLogs：不得存在 => setSnapshot(next) 这种透传写法', () => {
    const source = useDesktopStateSource();
    // F25 的原始形态正是这两行；一旦回归成"回包直接进 setState"，此处立刻红。
    expect(source).not.toMatch(/=>\s*setSnapshot\s*\(/);
    expect(source).not.toMatch(/=>\s*setLogs\s*\(/);
    expect(source).not.toMatch(/then\(\s*\(next\)\s*=>\s*set(?:Snapshot|Logs|State)\s*\(/);
  });

  it('F25-WIRE-3 落地前必须先过通道裁决：两条通道各有一个 accepted 守卫', () => {
    const source = useDesktopStateSource();
    expect(source).toContain('if (settled.accepted) setSnapshot(settled.value);');
    expect(source).toContain('if (settled.accepted) setLogs(settled.value);');
  });

  it('F25-WIRE-4 effect 清理必须对两条通道都调 dispose（卸载令在途结果失效）', () => {
    const source = useDesktopStateSource();
    expect(source).toContain('streams.snapshot.dispose();');
    expect(source).toContain('streams.logs.dispose();');
  });

  it('F25-WIRE-5 推送回调先推进两条通道的代次再 setState', () => {
    const source = useDesktopStateSource();
    expect(source).toContain('streams.snapshot.push(payload.snapshot);');
    expect(source).toContain('streams.logs.push(payload.logs);');
  });
});

/* ------------------------------------------------------------------ *
 * ZC-45 · F26「读取失败混为缺桥，并可用默认草稿覆盖未知配置」
 *
 * 缺陷事实（见 1005.md §9 ZC-45）：`SettingsPage.tsx:110` 用
 * `!desktop.available || desktop.settings === null` 一个条件同时表示
 * 「桌面壳未接入」与「读取失败」，两者界面文案完全一样；而
 * `SettingsPage.tsx:103` 的保存按钮只看 `available`，于是**读取失败时
 * 保存仍可用**——此时四项草稿还是初始化默认值（8790 / official-host /
 * low），一次保存就把主进程里的 `12345 / none / max` 覆盖成默认。
 * `keyPreserved=true`（apiKey 不在提交面上），所以这条坑只在另外三项上可见。
 *
 * 卡上硬边界：**保存按钮与函数都要求"已成功加载"**；缺桥 / 读取中 / 失败
 * 三态必须可区分；失败时保留最后有效值并标陈旧。**先阻断默认覆盖即可，
 * 不新造状态机**——所以这里只加一个 `settingsLoad` 四态标签，值的去留
 * 仍由 `settings` 本身承担。
 *
 * 本组用 SSR（`react-dom/server`）真实渲染 `SettingsPage`，断言面上拿到的
 * 就是用户看到的东西：`{label, saveDisabled, effectiveValues}`。
 * SSR 在 node 环境零 DOM、零网络、零磁盘；真实 DOM/视觉验收由主会话的
 * GUI 终审承担，这里不冒充。
 * ------------------------------------------------------------------ */

/** 主进程里那组**未被读取**的真实配置：绝不能被默认草稿顶掉。 */
function realSettingsBundle(): SettingsBundle {
  return {
    settings: {
      apiKeySet: true,
      apiKeyMasked: 'zcc-fp-****3456',
      apiKeyFingerprint: 'sha256:abc123',
      apiPort: 12345,
      driver: 'none',
      reasoning: 'max',
      driverClosedSet: ['official-host', 'none'],
      reasoningClosedSet: ['low', 'high', 'max']
    },
    settingsFile: 'C:/synthetic/userData/settings.json',
    seededFrom: 'C:/synthetic/seed/settings.json',
    seedProblem: null,
    loadProblems: [],
    runtime: { kind: 'dev', runtimeRoot: 'C:/synthetic/repo', apiEntry: 'packages/api' }
  };
}

function desktopState(over: {
  available: boolean;
  settingsLoad: SettingsLoad;
  settings: SettingsBundle | null;
}): DesktopState {
  return {
    available: over.available,
    snapshot: { ...UNAVAILABLE_SNAPSHOT },
    logs: [],
    settings: over.settings,
    settingsLoad: over.settingsLoad,
    refresh: () => undefined,
    refreshLogs: () => undefined,
    refreshSettings: () => undefined
  };
}

function renderSettingsPage(desktop: DesktopState): string {
  const state: AppState = {
    logs: [],
    log: () => undefined,
    clearLogs: () => undefined,
    bootedAt: 0,
    now: Date.UTC(2026, 0, 1, 4, 0, 0),
    clockBroken: false,
    setClockBroken: () => undefined,
    localApiEnabled: false,
    setLocalApiEnabled: () => undefined,
    localApiBaseUrl: '',
    setLocalApiBaseUrl: () => undefined
  };
  const theme = {
    pref: 'light' as const,
    resolved: 'light' as const,
    systemDark: false,
    source: 'default' as const,
    setPref: () => undefined
  };
  return renderToStaticMarkup(createElement(SettingsPage, { state, theme, desktop }));
}

/** 界面上给用户看的那句状态标签（StatePanel 标题，或无面板时的空串）。 */
function statusLabel(html: string): string {
  const match = /<span class="state-panel__title">([^<]*)<\/span>/.exec(html);
  return match === null ? '' : (match[1] ?? '');
}

/** 保存按钮是否被禁用：SSR 下 `disabled` 为真时渲染出 `disabled=""`。 */
function saveDisabled(html: string): boolean {
  const tag = /<button[^>]*data-action="save-desktop-settings"[^>]*>/.exec(html);
  if (tag === null) throw new Error('保存按钮不存在：三态断言失去了前提');
  return /\sdisabled(=(""|''))?[\s>]/.test(tag[0]);
}

/** 界面上真正生效的四项取值（端口输入框 + 两个下拉的选中项）。 */
function effectiveValues(html: string): { port: string | null; driver: string | null; reasoning: string | null } {
  const port = /data-field="api-port"[^>]*value="([^"]*)"/.exec(html);
  const driver = /data-field="driver"[\s\S]*?<option value="([^"]*)" selected=""/.exec(html);
  const reasoning = /data-field="reasoning"[\s\S]*?<option value="([^"]*)" selected=""/.exec(html);
  return {
    port: port === null ? null : (port[1] ?? null),
    driver: driver === null ? null : (driver[1] ?? null),
    reasoning: reasoning === null ? null : (reasoning[1] ?? null)
  };
}

const NO_BRIDGE = desktopState({ available: false, settingsLoad: 'no-bridge', settings: null });
const READING = desktopState({ available: true, settingsLoad: 'loading', settings: null });
const FAILED_NO_DATA = desktopState({ available: true, settingsLoad: 'failed', settings: null });
const FAILED_STALE = desktopState({ available: true, settingsLoad: 'failed', settings: realSettingsBundle() });
const LOADED = desktopState({ available: true, settingsLoad: 'loaded', settings: realSettingsBundle() });

describe('ZC-45 · F26 复现：读取失败被写成「桌面壳未接入」，且保存仍可用', () => {
  it('F26-REP-1 读取失败不得与「桌面壳未接入」共用同一句标签（实测未修复前两者相同）', () => {
    const noBridgeLabel = statusLabel(renderSettingsPage(NO_BRIDGE));
    const failedLabel = statusLabel(renderSettingsPage(FAILED_NO_DATA));
    expect(noBridgeLabel).toBe('桌面壳未接入');
    // 未修复时这里是 `桌面壳未接入`（两态塌成同一句）；修复后必须是另一句。
    expect(failedLabel).not.toBe(noBridgeLabel);
  });

  it('F26-REP-2 读取失败时保存必须不可用（实测未修复前仍为 false，默认草稿能覆盖未知配置）', () => {
    // 未修复时 `disabled` 只看 available，这里是 false；修复后必须是 true。
    expect(saveDisabled(renderSettingsPage(FAILED_NO_DATA))).toBe(true);
  });
});

describe('ZC-45 · F26 绿：缺桥 / 读取中 / 失败三态可区分', () => {
  it('F26-1 三态的标签互不相同（缺桥、读取中、读取失败各说各话）', () => {
    const noBridge = statusLabel(renderSettingsPage(NO_BRIDGE));
    const reading = statusLabel(renderSettingsPage(READING));
    const failed = statusLabel(renderSettingsPage(FAILED_NO_DATA));
    expect(noBridge).toBe('桌面壳未接入');
    expect(reading).toBe('正在读取桌面设置');
    expect(failed).toBe('读取桌面设置失败');
    // 三者两两不等——任一塌回另一句即红。
    expect(new Set([noBridge, reading, failed]).size).toBe(3);
  });

  it('F26-2 三态下保存一律不可用（保存要求已成功加载）', () => {
    expect(saveDisabled(renderSettingsPage(NO_BRIDGE))).toBe(true);
    expect(saveDisabled(renderSettingsPage(READING))).toBe(true);
    expect(saveDisabled(renderSettingsPage(FAILED_NO_DATA))).toBe(true);
    // 有陈旧数据也不行：那是上一次成功读到的，不是"当前已加载"。
    expect(saveDisabled(renderSettingsPage(FAILED_STALE))).toBe(true);
  });

  it('F26-3 未成功加载时四项草稿绝不呈现为默认值（默认草稿不得覆盖未知配置）', () => {
    for (const desktop of [NO_BRIDGE, READING, FAILED_NO_DATA, FAILED_STALE]) {
      const values = effectiveValues(renderSettingsPage(desktop));
      // 三项默认值是 8790 / official-host / low；任何一项出现即说明草稿漏出来了。
      expect(values).not.toEqual({ port: '8790', driver: 'official-host', reasoning: 'low' });
    }
  });
});

describe('ZC-45 · F26 负例：阻断默认覆盖不得放宽既有规则', () => {
  it('F26-NEG-A1 key 保护仍有效：masked key 只出现在占位符，永不成为输入值或提交值', () => {
    for (const desktop of [FAILED_STALE, LOADED]) {
      const html = renderSettingsPage(desktop);
      const input = /<input[^>]*data-field="api-key"[^>]*\/?>/.exec(html);
      expect(input).not.toBeNull();
      expect(input![0]).toContain('type="password"');
      // 掩码在 placeholder 里；输入框的 value 恒为空（留空 = 不改 key）。
      expect(input![0]).toMatch(/data-field="api-key"/);
      const value = /data-field="api-key"[^>]*\svalue="([^"]*)"/.exec(html);
      expect(value === null ? '' : value[1]).toBe('');
      // 掩码本身绝不作为 value 出现在标记里。
      expect(html).not.toMatch(/value="zcc-fp-\*\*\*\*3456"/);
    }
  });

  it('F26-NEG-A2 加载失败不影响 key 保护语义的实现：省略 apiKey 的分支仍在', () => {
    const source = settingsPageSource();
    // 提交面里 apiKey 仍然是"留空即不改"，失败态没有把这个分支改写成总是提交。
    expect(source).toContain("apiKeyDraft.trim() === '' ? {} :");
    expect(source).toContain('apiKey: apiKeyDraft.trim()');
  });

  it('F26-NEG-B snapshot 刷新失败的既有错误提示不回退（这是两条独立通道的失败面）', () => {
    const source = useDesktopStateSource();
    // ZC-44/ZC-45 都不许把显式刷新失败的错误提示抹掉。
    expect(source).toContain("lastError: '读取桌面状态失败'");
    expect(source).toContain('applySnapshot(');
    expect(source).toContain('applyLogs(');
  });

  it('F26-NEG-C 成功加载后保存恢复正常，且四项生效值就是主进程里的真实值', () => {
    const html = renderSettingsPage(LOADED);
    expect(saveDisabled(html)).toBe(false);
    expect(effectiveValues(html)).toEqual({ port: '12345', driver: 'none', reasoning: 'max' });
    // 生效值不得是默认值——这条守住"负例(c) 加载后保存恢复正常"的正面。
    expect(html).toContain('12345');
  });

  it('F26-NEG-D 失败时保留最后有效数据并标陈旧（不清空、不伪装成首次加载）', () => {
    const staleHtml = renderSettingsPage(FAILED_STALE);
    // 最后有效值仍在界面上。
    expect(staleHtml).toContain('12345');
    expect(effectiveValues(staleHtml)).toEqual({ port: '12345', driver: 'none', reasoning: 'max' });
    // 并且被明确标成陈旧——"读到了"不等于"现在读到了"。
    expect(staleHtml).toContain('陈旧');
  });

  it('F26-NEG-E 未知 save reason 透传不崩溃（上游会新增拒绝码）', () => {
    const source = settingsPageSource();
    // reason 是原样透传的字符串，不是穷举映射；未知码走 `?? '未知原因'`。
    expect(source).toContain("${result.reason ?? '未知原因'}");
    // 没有把 reason 塞进任何需要穷举的分支（switch / Record 查表）。
    expect(source).not.toMatch(/switch\s*\(\s*result\.reason/);
    expect(source).not.toMatch(/Record<[^>]*reason[^>]*>/);
  });
});

describe('ZC-45 · F26 接线：四态由真实读取结果驱动，不是硬编码', () => {
  it('F26-WIRE-1 hook 导出 settingsLoad 四态，且三态标签在页面里真实存在', () => {
    const source = useDesktopStateSource();
    expect(source).toContain("'no-bridge'");
    expect(source).toContain("'loading'");
    expect(source).toContain("'failed'");
    expect(source).toContain("'loaded'");
    const page = settingsPageSource();
    expect(page).toContain('桌面壳未接入');
    expect(page).toContain('正在读取桌面设置');
    expect(page).toContain('读取桌面设置失败');
    expect(page).toContain('陈旧');
  });

  it('F26-WIRE-2 refreshSettings 的失败分支不再把 settings 置空（失败≠缺桥）', () => {
    const source = useDesktopStateSource();
    // 旧的失败分支是 `() => setSettings(null)`：失败与"从未读到"被压成同一个 null。
    expect(source).not.toMatch(/\(\)\s*=>\s*setSettings\(null\)/);
    expect(source).not.toMatch(/setSettings\(null\)/);
    // 失败只改标签，不动值。
    expect(source).toContain("setSettingsLoad('failed')");
  });

  it('F26-WIRE-3 页面按 settingsLoad 分派面板，不再拿 settings === null 当缺桥', () => {
    const page = settingsPageSource();
    // 旧写法：`!desktop.available || desktop.settings === null` 混为一谈。
    expect(page).not.toMatch(/!desktop\.available\s*\|\|\s*desktop\.settings\s*===\s*null/);
    expect(page).toContain('desktop.settingsLoad');
  });

  it('F26-WIRE-4 保存的硬前置是"已成功加载"，且函数体自身也设防（不只按钮）', () => {
    const page = settingsPageSource();
    expect(page).toContain("desktop.settingsLoad !== 'loaded'");
    // 函数体内的早退：不只靠 disabled 属性挡（disabled 可被绕过）。
    expect(page).toMatch(/settingsLoad\s*!==\s*'loaded'[\s\S]{0,400}?return/);
  });
});

const PAGE_SOURCE_FILES = import.meta.glob!(['../pages/SettingsPage.tsx'], {
  eager: true,
  query: '?raw',
  import: 'default'
}) as Record<string, string>;

function settingsPageSource(): string {
  const entry = Object.entries(PAGE_SOURCE_FILES).find(([path]) => path.endsWith('SettingsPage.tsx'));
  expect(entry).toBeDefined();
  return entry![1];
}


// Exercise the real hook callbacks with deterministic hook storage/effect replay.
// This is a lifecycle harness, not a React DOM / GUI acceptance test.
import { vi } from 'vitest';

async function zc45HookHarness() {
  const slots: unknown[] = [];
  let cursor = 0;
  let effect: (() => void | (() => void)) | undefined;
  const reads: Array<{ resolve: (v: SettingsBundle) => void; reject: (e: Error) => void }> = [];
  vi.resetModules();
  vi.doMock('react', async (importOriginal) => ({
    ...(await importOriginal<typeof import('react')>()),
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => void | (() => void)) => { effect = fn; }
  }));
  vi.stubGlobal('window', { zccDesktop: {
    desktop: true,
    getSnapshot: async () => ({ ...UNAVAILABLE_SNAPSHOT }),
    getLogTail: async () => [],
    subscribe: () => () => undefined,
    getSettings: () => new Promise<SettingsBundle>((resolve, reject) => reads.push({ resolve, reject }))
  }});
  const module = await import('./useDesktopState');
  const render = () => { cursor = 0; return module.useDesktopState(); };
  render();
  const setup = () => effect?.();
  const cleanup = setup();
  return { reads, render, setup, cleanup, restore: () => {
    vi.doUnmock('react'); vi.unstubAllGlobals(); vi.resetModules();
  }};
}

async function zc45Flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('ZC-45 async read ordering', () => {
  it('a current refresh failure preserves the last successful settings as stale', async () => {
    const h = await zc45HookHarness();
    try {
      h.reads[0]!.resolve(realSettingsBundle()); await zc45Flush();
      h.render().refreshSettings();
      expect(h.render().settingsLoad).toBe('loading');
      expect(h.render().settings?.settings.apiPort).toBe(12345);
      h.reads[1]!.reject(new Error('current failed')); await zc45Flush();
      expect(h.render().settingsLoad).toBe('failed');
      expect(h.render().settings?.settings.apiPort).toBe(12345);
    } finally { h.cleanup?.(); h.restore(); }
  });

  it('older success cannot reopen save after the latest refresh fails', async () => {
    const h = await zc45HookHarness();
    try {
      h.render().refreshSettings();
      h.reads[1]!.reject(new Error('latest failed')); await zc45Flush();
      expect(h.render().settingsLoad).toBe('failed');
      h.reads[0]!.resolve(realSettingsBundle()); await zc45Flush();
      expect(h.render().settingsLoad).toBe('failed');
      expect(h.render().settings).toBeNull();
    } finally { h.cleanup?.(); h.restore(); }
  });
  it('older failure cannot overwrite the latest successful settings', async () => {
    const h = await zc45HookHarness();
    try {
      h.render().refreshSettings();
      h.reads[1]!.resolve(realSettingsBundle()); await zc45Flush();
      h.reads[0]!.reject(new Error('old failed')); await zc45Flush();
      expect(h.render().settingsLoad).toBe('loaded');
      expect(h.render().settings?.settings.apiPort).toBe(12345);
    } finally { h.cleanup?.(); h.restore(); }
  });
  it('effect cleanup invalidates pending settings callbacks', async () => {
    const h = await zc45HookHarness();
    try {
      h.cleanup?.();
      h.reads[0]!.resolve(realSettingsBundle()); await zc45Flush();
      expect(h.render().settings).toBeNull();
      expect(h.render().settingsLoad).toBe('loading');
    } finally { h.restore(); }
  });
  it('StrictMode setup-cleanup-setup preserves the latest failure and permits a later retry', async () => {
    const h = await zc45HookHarness();
    let cleanup: void | (() => void) = undefined;
    try {
      h.cleanup?.(); cleanup = h.setup();
      h.reads[1]!.reject(new Error('new setup failed')); await zc45Flush();
      h.reads[0]!.resolve(realSettingsBundle()); await zc45Flush();
      expect(h.render().settingsLoad).toBe('failed');
      h.render().refreshSettings();
      h.reads[2]!.resolve(realSettingsBundle()); await zc45Flush();
      expect(h.render().settingsLoad).toBe('loaded');
      expect(h.render().settings?.settings.apiPort).toBe(12345);
    } finally { cleanup?.(); h.restore(); }
  });
});
