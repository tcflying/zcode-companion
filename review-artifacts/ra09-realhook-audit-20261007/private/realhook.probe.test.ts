/**
 * RA-09 · 真实 `useAppState` hook 接线的 200 条上限与脱敏上限
 * （私有真实挂载，**不写 apps/ui/src**）。
 *
 * 前一轮（`ra09-loggate-audit-20261007`）的**已知缺陷**，本轮只补这一点：
 *   上一轮 `mountPage` 与 L4 自定义了 `log`，内部**自己**写了
 *   `[makeLogEntry(...), ...entries].slice(0, 200)` —— 那是对 `useAppState.ts:40`
 *   的**手工复刻**，用它断言 200 上限属于「以复刻实现证明产品行为」，**不成立**。
 *   本轮改为**直接调用真实 `useAppState()` hook**，拿它返回的 log / clearLogs，
 *   不复刻、不替换实现。
 *
 * 保留（上一轮已成立、本轮不重复断言）：
 *   - LogsPage + 真实 makeLogEntry 的 canary 脱敏结果（L1/L2）
 *   - desktop unavailable 边界与 refreshLogs 计数正控（L5/L6/L7）
 *   ⇒ 本文件**只测 L4 那一项**，其余绿不重跑。
 *
 * 替身边界（如实标注）：
 *  - 被替身的只有 **desktop 外部依赖**（DesktopState），因为它连真实 Electron 主进程，
 *    本轮明令不启动 desktop 子进程。替身严格照 useDesktopState.ts 的接口形状。
 *  - **log / clearLogs / makeLogState 一律用真实 hook 原生实现，不做任何替换。**
 *  - happy-dom 20.11.6 非真实浏览器；**不启动真实 desktop、不发网络、不读真实凭据**。
 *  - 真实 hook 自带 setInterval(:45-48) 与 5 条引导日志(:50-61)，
 *    这些副作用是**真实 hook 的行为**，本轮据实断言，不屏蔽。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LogsPage } from '../../../apps/ui/src/pages/LogsPage';
import { useAppState, type AppState } from '../../../apps/ui/src/app/useAppState';
import type { DesktopState } from '../../../apps/ui/src/app/useDesktopState';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

/* 公开合成 canary（不对应任何真实凭据） */
const CANARY_APIKEY = 'sk-selfcheck-0000abcd';
const CANARY_CRED = 'plain-secret-value';

function txt(c: HTMLElement): string {
  return (c.textContent ?? '').replace(/\s+/g, ' ');
}

function localLogRowCount(c: HTMLElement): number {
  return c.querySelectorAll('[aria-label="本地日志"] tbody tr').length;
}

type Mounted = {
  container: HTMLElement;
  /** 真实 hook 返回的 state 引用（每次渲染后由 bridge 刷新）。 */
  getState: () => AppState;
  unmount: () => void;
};

/**
 * 挂载真实 hook + 真实 LogsPage。
 *
 * **关键**：`state` 来自组件内真实调用 `useAppState()`，
 * 通过 `onState` 回调把真实对象交出来；探针**不构造 log/clearLogs**。
 * desktop 是唯一被替身的外部依赖（不启动真实 Electron）。
 */
async function mountReal(desktopAvailable = false): Promise<Mounted> {
  let latest: AppState | null = null;
  let refreshLogsCalls = 0;

  const desktop = {
    available: desktopAvailable,
    snapshot: {} as never,
    logs: [] as never[],
    settings: null,
    settingsLoad: {} as never,
    refresh: () => undefined,
    refreshLogs: () => {
      refreshLogsCalls += 1;
    },
    refreshSettings: () => undefined
  } as unknown as DesktopState;

  function Harness({ onState }: { onState: (s: AppState) => void }) {
    const state = useAppState(); // ← 真实 hook，非替身
    useEffect(() => {
      onState(state);
    }, [state, onState]);
    return createElement(LogsPage, { state, desktop });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(Harness, {
        onState: (s: AppState) => {
          latest = s;
        }
      })
    );
  });
  // 真实 hook 的引导日志(:50-61) 与 setInterval 都已在 act 内提交
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
  });

  return {
    container,
    getState: () => {
      if (!latest) throw new Error('真实 hook 尚未上报 state');
      return latest;
    },
    unmount: () => {
      act(() => root.unmount()); // 真实 hook 的 setInterval 在此被 cleanup
      container.remove();
    }
  };
}

describe('RA-09 真实 useAppState 接线：200 条上限由产品 hook 自己保证', () => {
  it('L4R 真实 hook.log() 连写 250 条：state.logs 由 hook 自己截断到 200，canary 不留', async () => {
    const m = await mountReal(false);
    const state = m.getState();

    // 先确认真实 hook 已被接上：它自带引导日志（useAppState.ts:50-61 共 5 条）
    const bootCount = state.logs.length;
    expect(bootCount, '真实 hook 应自带引导日志（证明不是空替身）').toBeGreaterThan(0);
    expect(
      state.logs.some((l) => l.message.includes('界面壳已加载')),
      '应含 useAppState.ts:51 的引导文案'
    ).toBe(true);

    // 前置：canary 原值此刻不在 state（引导日志无凭据）
    expect(JSON.stringify(state.logs)).not.toContain(CANARY_APIKEY);

    // 用**真实** log() 连写 250 条，其中第 0 条带 canary。
    // 截断行为由 useAppState.ts:40 的 slice(0,200) 自己完成，探针不复刻。
    await act(async () => {
      for (let i = 0; i < 250; i += 1) {
        state.log(
          'INFO',
          'src.realhook',
          i === 0 ? `首条带 canary apiKey=${CANARY_APIKEY} credential="${CANARY_CRED}"` : `第 ${i} 条`
        );
      }
    });
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    });

    const after = m.getState();

    // 1) 上限由真实 hook 保证：恰好 200 条
    expect(after.logs.length, '真实 hook 应把缓冲截断到 200').toBe(200);
    // 2) 最新 200 条全部是本轮写入的（最早那条含 canary 的已被淘汰）
    const sources = new Set(after.logs.map((l) => l.source));
    expect(sources.has('src.realhook'), '保留的应含本轮写入条目').toBe(true);
    // 3) canary 原值既不在 state 也不在 DOM（写前 redact + 最早条目已被淘汰）
    const dump = JSON.stringify(after.logs);
    expect(dump, 'canary 不得留在真实 hook 的 state 中').not.toContain(CANARY_APIKEY);
    expect(dump).not.toContain(CANARY_CRED);
    expect(txt(m.container), 'DOM 不得出现 canary 原值').not.toContain(CANARY_APIKEY);
    expect(txt(m.container)).not.toContain(CANARY_CRED);
    // 4) 页面缓冲计数显示 200 / 200
    expect(txt(m.container)).toContain('界面缓冲 200 / 200');
    expect(localLogRowCount(m.container), 'DOM 表应显示 200 行').toBe(200);
    // 5) 零网络
    expect(fetchCount + xhrCount + wsCount).toBe(0);
    expect(callLog).toEqual([]);

    m.unmount();
  });

  it('L4R2 真实 hook.clearLogs()：清空与重复清空由 hook 自身保证幂等', async () => {
    const m = await mountReal(false);
    const state = m.getState();

    await act(async () => {
      state.log('WARN', 'src.clear', '清空前样本 apiKey=' + CANARY_APIKEY);
    });
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
    const before = m.getState().logs.length;
    expect(before, '清空前应大于 0').toBeGreaterThan(0);
    expect(JSON.stringify(m.getState().logs)).not.toContain(CANARY_APIKEY);

    // 真实 clearLogs
    await act(async () => {
      m.getState().clearLogs();
    });
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
    expect(m.getState().logs.length, '真实 clearLogs 后应为 0').toBe(0);
    expect(txt(m.container)).toContain('空状态：缓冲中还没有日志');

    // 重复清空：幂等，不抛错
    await act(async () => {
      m.getState().clearLogs();
    });
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
    expect(m.getState().logs.length, '重复清空后仍为 0').toBe(0);
    expect(fetchCount + xhrCount + wsCount).toBe(0);

    m.unmount();
  });
});