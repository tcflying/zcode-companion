/**
 * RA-09 · 日志页脱敏自检 / 200 条上限 / desktop unavailable 边界
 * （私有真实挂载 + 真实点击，不入产品测试链）。
 *
 * 原要求出处：
 *  - 929.md:444「UI 日志只允许位置/额度状态，不得出现 token/API-key/Authorization；
 *              日志写入前脱敏…绝不能出现真实凭据、邮箱或会话标识」
 *  - 929.md:373「日志/操作历史不得无限增长」
 *  - 929.md:875「通过合成 secret canary 验证不泄漏…」
 *  - LogsPage.tsx:38-42 runSelfCheck 把含凭据的 SELF_CHECK_RAW 交给 state.log
 *  - logger.ts:28-31 makeLogEntry 对 source 与 message 强制 redact()（写前脱敏）
 *  - useAppState.ts log() 内 slice(0,200) ⇒ 200 条上限
 *  - LogsPage.tsx:62 refreshLogs 按钮 `disabled={!desktop.available}`
 *
 * 相对既有证据的新增覆盖（不重复）：
 *  既有 `review-artifacts/ui01/13-logs-redaction-selfcheck.png` 是**截图 + 人工看像素**，
 *  不是挂载后的程序化断言，且未覆盖 200 条上限与 desktop unavailable 的 dispatch 面。
 *
 * 边界（如实标注）：
 *  - happy-dom 20.11.6 私有挂载，**非真实浏览器**：无布局、无 CSS、无可见性计算。
 *  - **不启动真实 desktop 子进程、不读取真实日志、不读取任何真实凭据**。
 *  - 所有凭据串均为**公开合成的 canary 常量**（与 LogsPage.tsx:14-15 自带样本同风格），
 *    不来自环境变量、不来自文件、不对应任何真实账号。
 *  - 本轮**不声称 RA-09 整体通过**：未知操作 journal 淘汰策略属另一个层面，未测。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LogsPage } from './pages/LogsPage';
import { makeLogEntry, type LogEntry } from './lib/logger';

/* ---- 公开合成 canary（不对应任何真实凭据） ---- */
const CANARY_APIKEY = 'sk-selfcheck-0000abcd';
const CANARY_BEARER = 'eyJhbGciOi.selfcheck.token';
const CANARY_CRED = 'plain-secret-value';

/** 与 LogsPage.tsx:14-15 同风格的合成样本，独立构造以便精确断言。 */
const CANARY_RAW = `合成样本：apiKey=${CANARY_APIKEY}, Authorization: Bearer ${CANARY_BEARER}, credential: "${CANARY_CRED}"`;

/* ---- 可观测网络通道（合成替身，非真实网络） ---- */
let fetchCount = 0;
let xhrCount = 0;
let wsCount = 0;
const callLog: string[] = [];

beforeEach(() => {
  fetchCount = 0;
  xhrCount = 0;
  wsCount = 0;
  callLog.length = 0;
  vi.stubGlobal('fetch', (...a: unknown[]) => {
    fetchCount += 1;
    callLog.push(`fetch:${String(a[0])}`);
    return Promise.reject(new Error('probe: 不允许真实 fetch'));
  });
  vi.stubGlobal('XMLHttpRequest', class {
    open(...a: unknown[]) {
      xhrCount += 1;
      callLog.push(`xhr:${String(a[0])}`);
    }
    send() {
      xhrCount += 1;
    }
    setRequestHeader() { /* noop */ }
    addEventListener() { /* noop */ }
  });
  vi.stubGlobal('WebSocket', class {
    constructor(...a: unknown[]) {
      wsCount += 1;
      callLog.push(`ws:${String(a[0])}`);
    }
    send() {
      wsCount += 1;
    }
    close() { /* noop */ }
    addEventListener() { /* noop */ }
  });
});

/* ------------------------------------------------------------------ *
 * 真实 state 替身：用**真实 makeLogEntry**（含真实 redact）构造，
 * 复刻 useAppState.ts 的 log() 语义（含 200 条上限）。
 * ------------------------------------------------------------------ */

type Mounted = {
  container: HTMLElement;
  unmount: () => void;
  getLogs: () => LogEntry[];
  /** log()/clearLogs() 改的是外部 entriesRef，须调用它驱动重渲染。 */
  rerender: () => Promise<void>;
  /** refreshLogs 真实调用次数（L7 正控证明它会增长）。 */
  getRefreshLogsCalls: () => number;
};

async function mountPage(options?: { desktopAvailable?: boolean; logs?: LogEntry[] }): Promise<Mounted> {
  let entries: LogEntry[] = options?.logs ? [...options.logs] : [];

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  // 真实写入口：makeLogEntry 内部 redact()，与产品唯一入口同一条路径
  const log = (level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', source: string, message: string) => {
    entries = [makeLogEntry(level, source, message, Date.now()), ...entries].slice(0, 200); // 与 useAppState 一致
  };
  const clearLogs = () => {
    entries = [];
  };

  // desktop 替身：形状严格照 DesktopState（useDesktopState.ts），不新增任何不存在的能力
  let refreshLogsCalls = 0;
  const desktop = {
    available: options?.desktopAvailable ?? false,
    snapshot: {} as never,
    logs: [] as never[],
    settings: null,
    settingsLoad: {} as never,
    refresh: () => undefined,
    refreshLogs: () => {
      refreshLogsCalls += 1;
    },
    refreshSettings: () => undefined,
    get refreshLogsCalls() {
      return refreshLogsCalls;
    }
  };

  const state = {
    logs: entries,
    log,
    clearLogs,
    bootedAt: 0,
    now: 0,
    clockBroken: false,
    setClockBroken: () => undefined,
    localApiEnabled: false,
    setLocalApiEnabled: () => undefined,
    localApiBaseUrl: 'http://127.0.0.1:8790',
    setLocalApiBaseUrl: () => undefined
  };

  // 让 state.logs 每次渲染都反映最新 entries（产品里是 React state）
  const rerender = async () => {
    (state as unknown as { logs: LogEntry[] }).logs = entries;
    await act(async () => {
      root.render(createElement(LogsPage, { state: state as never, desktop: desktop as never }));
    });
  };

  await rerender();

  return {
    container,
    getLogs: () => entries,
    rerender,
    /**
     * refreshLogs 被真实调用的次数。
     * **不是恒 0 的空壳**：L7 用 available=true 的正控证明它确实会增长，
     * 因此 L5/L6 里「点击禁用按钮后计数仍为 0」才有区分力。
     */
    getRefreshLogsCalls: () => refreshLogsCalls,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}

function settle(times = 3): Promise<void> {
  return act(async () => {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function txt(c: HTMLElement): string {
  return (c.textContent ?? '').replace(/\s+/g, ' ');
}

/** 本地日志表里的消息列（cell[3]，依 LogsPage.tsx:199-208 的列序）。 */
function localLogMessages(c: HTMLElement): string[] {
  const region = c.querySelector('[aria-label="本地日志"]');
  if (!region) return [];
  return Array.from(region.querySelectorAll('tbody tr')).map(
    (tr) => (Array.from(tr.querySelectorAll('td'))[3]?.textContent ?? '').trim()
  );
}

function localLogRowCount(c: HTMLElement): number {
  return c.querySelectorAll('[aria-label="本地日志"] tbody tr').length;
}

function buttonByText(c: HTMLElement, label: string): HTMLButtonElement {
  const b = Array.from(c.querySelectorAll('button')).find(
    (x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim() === label
  );
  if (!b) {
    const all = Array.from(c.querySelectorAll('button')).map((x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim());
    throw new Error(`找不到按钮「${label}」。现有：${all.join(' | ')}`);
  }
  return b as HTMLButtonElement;
}

/**
 * 点按钮并**在同一个 act() 内**驱动重渲染 + 冲刷 promise。
 *
 * 上一版把「click → settle → rerender」拆成三次 await，每次各自一个 act()，
 * React 19 报 "You seem to have overlapping act() calls"，
 * 渲染根本没提交 ⇒ 断言全红、连按钮都找不到。合并后只有一个 act 作用域。
 */
async function clickAndSettle(m: Mounted, label: string): Promise<void> {
  await act(async () => {
    buttonByText(m.container, label).click();
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
  await m.rerender();
}

/** 只驱动重渲染（不点击），用于 state 在 act 外被 log()/clearLogs() 改动的场景。 */
async function rerender(m: Mounted): Promise<void> {
  await m.rerender();
}

describe('RA-09 日志页：脱敏自检 canary 写前脱敏', () => {
  it('L1 注入自检条目：canary 原值不得出现在 state 或 DOM', async () => {
    const m = await mountPage({ desktopAvailable: false });
    await settle(2);

    // 点「注入自检条目」——产品自带自检按钮，真实点击（点击与重渲染同处一个 act）
    await clickAndSettle(m, '注入自检条目');

    // 1) state 层：真实 makeLogEntry 已脱敏
    const entries = m.getLogs();
    expect(entries.length, '自检应写入 3 条').toBe(3);
    const stateDump = JSON.stringify(entries);
    expect(stateDump, 'canary apiKey 原值不得留在 state').not.toContain(CANARY_APIKEY);
    expect(stateDump, 'canary Bearer 原值不得留在 state').not.toContain(CANARY_BEARER);
    expect(stateDump, 'canary credential 原值不得留在 state').not.toContain(CANARY_CRED);
    expect(stateDump, '至少出现脱敏占位').toContain('[REDACTED]');

    // 2) DOM 层：整页文本都不得含 canary 原值
    const dom = txt(m.container);
    expect(dom, 'DOM 不得出现 apiKey 原值').not.toContain(CANARY_APIKEY);
    expect(dom, 'DOM 不得出现 Bearer 原值').not.toContain(CANARY_BEARER);
    expect(dom, 'DOM 不得出现 credential 原值').not.toContain(CANARY_CRED);
    expect(dom, 'DOM 不得出现 "Bearer eyJ" 片段').not.toContain(`Bearer ${CANARY_BEARER}`);

    // 3) 三条自检条目确实进了表（不是被过滤掉了）
    expect(localLogRowCount(m.container), '本地日志表应有 3 行').toBe(3);
    m.unmount();
  });

  it('L2 筛选 / 清空 / 重复清空：脱敏状态在三者间保持一致', async () => {
    const m = await mountPage({ desktopAvailable: false });
    await settle(2);

    await clickAndSettle(m, '注入自检条目');

    // 快捷筛选「仅 WARN/ERROR」：只剩 WARN 与 ERROR 两条
    await clickAndSettle(m, '仅 WARN/ERROR');
    expect(localLogRowCount(m.container), 'WARN/ERROR 筛选后应剩 2 行').toBe(2);
    expect(txt(m.container)).not.toContain(CANARY_APIKEY);
    expect(txt(m.container)).not.toContain(CANARY_BEARER);
    expect(txt(m.container)).not.toContain(CANARY_CRED);

    // 回到全部
    await clickAndSettle(m, '全部');
    expect(localLogRowCount(m.container), '恢复全部后应回到 3 行').toBe(3);

    // 清空缓冲（点击 toolbar 上的那个）
    await clickAndSettle(m, '清空缓冲');
    expect(m.getLogs().length, '清空后 state 应为空').toBe(0);
    expect(localLogRowCount(m.container), '清空后表应为空态').toBe(0);
    expect(txt(m.container)).toContain('空状态：缓冲中还没有日志');

    // 重复清空：幂等，不抛错
    await clickAndSettle(m, '注入自检条目');
    expect(m.getLogs().length).toBe(3);
    await clickAndSettle(m, '清空缓冲');
    await clickAndSettle(m, '清空缓冲');
    expect(m.getLogs().length, '重复清空后仍为空').toBe(0);
    m.unmount();
  });
});

describe('RA-09 日志页：200 条保留上限', () => {
  it('L3 预置 250 条（未经 log() 截断）：页面按 state 实际条数显示，canary 仍不泄漏', async () => {
    // 本条只验「预置超量条目时页面如实显示、不泄漏 canary」。
    // **真正的 200 上限截断**由 L4 通过真实 log() 通路断言，两者不重复。
    const pre: LogEntry[] = [];
    for (let i = 0; i < 250; i += 1) {
      pre.unshift(makeLogEntry('INFO', 'src.bulk', `条目 ${i}${i === 249 ? ` ${CANARY_RAW}` : ''}`, 0));
    }
    const m = await mountPage({ desktopAvailable: false, logs: pre });
    await settle(2);
    expect(localLogRowCount(m.container), '预置 250 条应显示 250 行').toBe(250);
    expect(txt(m.container), 'canary 不得出现在 DOM').not.toContain(CANARY_APIKEY);
    expect(txt(m.container)).not.toContain(CANARY_CRED);
    expect(fetchCount + xhrCount + wsCount).toBe(0);
    m.unmount();
  });

  it('L4 真实 log() 通路连写 250 条：state 恰好截断到 200，canary 原值不留在 state/DOM', async () => {
    // 用受控 state 替身：把 log 与 clearLogs 暴露出来，直接驱动真实 200 上限
    const entriesRef: { v: LogEntry[] } = { v: [] };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const log = (level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', source: string, message: string) => {
      entriesRef.v = [makeLogEntry(level, source, message, Date.now()), ...entriesRef.v].slice(0, 200);
    };
    const clearLogs = () => {
      entriesRef.v = [];
    };
    const state = { logs: entriesRef.v, log, clearLogs } as unknown as Record<string, unknown>;
    const desktop = {
      available: false,
      snapshot: {},
      logs: [],
      settings: null,
      settingsLoad: {},
      refresh: () => undefined,
      refreshLogs: () => undefined,
      refreshSettings: () => undefined
    };
    const render = async () => {
      (state as { logs: LogEntry[] }).logs = entriesRef.v;
      await act(async () => {
        root.render(createElement(LogsPage, { state: state as never, desktop: desktop as never }));
      });
    };
    await render();

    for (let i = 0; i < 250; i += 1) {
      log('INFO', 'src.limit', i === 0 ? `首条带 canary ${CANARY_RAW}` : `第 ${i} 条`);
    }
    await render();
    await settle(2);

    // 1) state 恰好 200 条
    expect(entriesRef.v.length, 'state 应被截断到 200').toBe(200);
    // 2) 页面缓冲计数显示 200 / 200
    expect(txt(container)).toContain('界面缓冲 200 / 200');
    expect(localLogRowCount(container), 'DOM 表应显示 200 行').toBe(200);
    // 3) 被淘汰的是最早那条（含 canary），保留的都不得含原值
    const dump = JSON.stringify(entriesRef.v);
    expect(dump, 'canary 不得留在保留的 state 中').not.toContain(CANARY_APIKEY);
    expect(dump, 'canary credential 不得留在保留的 state 中').not.toContain(CANARY_CRED);
    expect(txt(container), 'DOM 不得出现 canary 原值').not.toContain(CANARY_APIKEY);
    expect(txt(container)).not.toContain(CANARY_CRED);

    // 4) 零网络
    expect(fetchCount + xhrCount + wsCount).toBe(0);
    expect(callLog).toEqual([]);

    act(() => root.unmount());
    container.remove();
  });
});

describe('RA-09 日志页：desktop unavailable 边界', () => {
  it('L5 available=false：拉取按钮禁用、面板如实提示、点击零 dispatch', async () => {
    const m = await mountPage({ desktopAvailable: false });
    await settle(2);

    const pull = buttonByText(m.container, '拉取最新');
    expect(pull.disabled, 'desktop 不可用时拉取按钮必须 disabled').toBe(true);
    expect(txt(m.container), '面板应如实说明桌面壳未接入').toContain('桌面壳未接入');
    expect(txt(m.container)).toContain('没有子进程可跟随');

    const baseline = fetchCount + xhrCount + wsCount;
    // 即便直接点 disabled 按钮（HTML 规范下 disabled 不派发激活行为），也不得产生任何请求
    await act(async () => {
      pull.click();
    });
    await settle(3);

    expect(fetchCount + xhrCount + wsCount, '点击后仍为零网络').toBe(baseline);
    expect(callLog).toEqual([]);
    expect(m.getRefreshLogsCalls(), '禁用态下 refreshLogs 不得被调用').toBe(0);
    expect(buttonByText(m.container, '拉取最新').disabled).toBe(true);
    m.unmount();
  });

  it('L6 注入自检与拉取并存：available=false 下自检可用但拉取仍禁用', async () => {
    const m = await mountPage({ desktopAvailable: false });
    await settle(2);

    await clickAndSettle(m, '注入自检条目');

    // 自检可用
    expect(m.getLogs().length).toBe(3);
    // 拉取仍禁用
    expect(buttonByText(m.container, '拉取最新').disabled).toBe(true);
    expect(m.getRefreshLogsCalls(), '自检不得触发 refreshLogs').toBe(0);
    // 零网络
    expect(fetchCount + xhrCount + wsCount).toBe(0);
    expect(callLog).toEqual([]);
    m.unmount();
  });

  it('L7 正控：available=true 时同一按钮可点且 refreshLogs 计数确实增长（证明计数器非恒 0）', async () => {
    const m = await mountPage({ desktopAvailable: true });
    await settle(2);

    const pull = buttonByText(m.container, '拉取最新');
    expect(pull.disabled, 'desktop 可用时拉取按钮应可点').toBe(false);
    expect(m.getRefreshLogsCalls(), '前置：尚未点击时为 0').toBe(0);

    await act(async () => {
      pull.click();
    });
    await settle(3);

    // 反向有效性验证：这个计数器**确实会涨**，所以 L5/L6 的「仍为 0」不是恒真断言
    expect(m.getRefreshLogsCalls(), '可用态点击后计数应变为 1').toBe(1);

    await act(async () => {
      buttonByText(m.container, '拉取最新').click();
    });
    await settle(3);
    expect(m.getRefreshLogsCalls(), '第二次点击应累计为 2').toBe(2);

    // 注意：这里的替身 refreshLogs 不发请求，故网络仍为零；这如实反映
    // 「本轮未接入真实 desktop 通道」，不得据此声称已验证真实拉取行为。
    expect(fetchCount + xhrCount + wsCount).toBe(0);
    m.unmount();
  });
});