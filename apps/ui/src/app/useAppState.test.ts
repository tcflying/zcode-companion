import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverviewPage } from '../pages/OverviewPage';
import { ChatPage } from '../pages/ChatPage';
import { UNAVAILABLE_SNAPSHOT } from '../data/desktopBridge';
import { INITIAL_ACCOUNT_CATALOG } from '../data/accountCatalog';
import type { AccountCatalogHandle } from './useAccountCatalog';
import type { AppState } from './useAppState';

// Executes the actual hook callbacks/effects using the existing deterministic lifecycle pattern.
// No source-text assertions; this is not React DOM / GUI acceptance.
const fixture = () => ({
  schema: 'zcc-read-status', version: 1,
  driver: { kind: 'official-host', status: 'ready', catalogCount: 18, servableCount: 10 },
  catalog: { sourceKind: 'local-official-files', revision: 'mock', entryCount: 18, schemaVersion: 1, documentRevision: 1, readAt: 1000 },
  entitlement: { present: true, updatedAt: 1000, availableCount: 1, unavailableCount: 0, unknownCount: 0, itemCount: 1 },
  selection: { present: true, updatedAt: 1000, selectedCount: 1 },
  e1Blocking: ['account_unproven', 'entitlement_staleness_unproven', 'selection_unproven', 'billing_class_mapping_unproven'],
  usageWarnings: ['authoritative_bucket_unobserved', 'consumption_unobserved'], validityWindowKnown: false, gradedByServer: false
});
async function harness() {
  vi.resetModules();
  const slots: unknown[] = []; let cursor = 0; let mounted = true; let writesAfterUnmount = 0;
  const effects: Array<() => void | (() => void)> = [];
  const reads: Array<{ url: string; resolve: (value: string) => void; reject: (err: Error) => void }> = [];
  vi.doMock('react', async importOriginal => ({
    ...await importOriginal<typeof import('react')>(),
    useState: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (next: unknown) => { if (!mounted) writesAfterUnmount++; slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useRef: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(),
    useEffect: (fn: () => void | (() => void)) => { effects.push(fn); }
  }));
  vi.doMock('../data/localApiSource', async importOriginal => ({
    ...await importOriginal<typeof import('../data/localApiSource')>(),
    fetchReadStatus: (url: string) => new Promise<string>((resolve, reject) => reads.push({ url, resolve, reject }))
  }));
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => undefined });
  const module = await import('./useAppState');
  const render = () => { cursor = 0; effects.length = 0; return module.useAppState(); };
  render(); const cleanups = effects.map(fn => fn());
  return { render, reads, unmount: () => { mounted = false; cleanups.forEach(fn => fn?.()); }, writesAfterUnmount: () => writesAfterUnmount };
}
afterEach(() => { vi.doUnmock('react'); vi.doUnmock('../data/localApiSource'); vi.unstubAllGlobals(); vi.resetModules(); });

describe('useAppState real callbacks: read lifecycle', () => {
  it('默认零网络，关闭刷新不发请求，开启本身也不发请求', async () => {
    const h = await harness(); expect(h.reads).toHaveLength(0);
    await h.render().refreshReadStatus(); expect(h.render().readStatus.phase).toBe('disabled');
    h.render().setLocalApiEnabled(true); expect(h.render().readStatus.phase).toBe('idle'); expect(h.reads).toHaveLength(0); h.unmount();
  });
  it.each(['source', 'same-source', 'enable', 'disable'])('loading期间 %s 清在途和旧snapshot，迟到不落地且可再刷新', async kind => {
    const h = await harness(); h.render().setLocalApiEnabled(true);
    const old = h.render().refreshReadStatus(); expect(h.render().readStatus.phase).toBe('loading');
    if (kind === 'source') h.render().setLocalApiBaseUrl('http://127.0.0.1:12345');
    if (kind === 'same-source') h.render().setLocalApiBaseUrl('');
    if (kind === 'enable') h.render().setLocalApiEnabled(true);
    if (kind === 'disable') h.render().setLocalApiEnabled(false);
    expect(h.render().readStatus.phase).toBe(kind === 'disable' ? 'disabled' : 'idle');
    h.reads[0]!.resolve(JSON.stringify(fixture())); await old;
    expect(h.render().readStatus.snapshot).toBeNull();
    if (kind === 'disable') h.render().setLocalApiEnabled(true);
    const next = h.render().refreshReadStatus(); h.reads[1]!.resolve(JSON.stringify(fixture())); await next;
    expect(h.render().readStatus.phase).toBe('loaded'); expect(h.reads[1]!.url).toBe(kind === 'source' ? 'http://127.0.0.1:12345' : ''); h.unmount();
  });
  it('重复刷新：后一代失败不可被前一代迟到成功覆盖，loading清旧snapshot', async () => {
    const h = await harness(); h.render().setLocalApiEnabled(true);
    const initial = h.render().refreshReadStatus(); h.reads[0]!.resolve(JSON.stringify(fixture())); await initial;
    const old = h.render().refreshReadStatus(); expect(h.render().readStatus.snapshot).toBeNull();
    const next = h.render().refreshReadStatus(); h.reads[2]!.reject(new Error('synthetic')); await next;
    h.reads[1]!.resolve(JSON.stringify(fixture())); await old;
    expect(h.render().readStatus.phase).toBe('failed'); expect(h.render().readStatus.snapshot).toBeNull(); h.unmount();
  });
  it('卸载后成功/失败不写状态或日志', async () => {
    const h = await harness(); h.render().setLocalApiEnabled(true);
    const pending = h.render().refreshReadStatus(); h.unmount(); h.reads[0]!.resolve(JSON.stringify(fixture())); await pending;
    expect(h.writesAfterUnmount()).toBe(0);
  });
});

describe('SSR overview/chat semantics, not GUI acceptance', () => {
  const state = (phase: AppState['readStatus']['phase']): AppState => ({
    logs: [], log: () => undefined, clearLogs: () => undefined, bootedAt: 1000, now: Date.now(), clockBroken: false, setClockBroken: () => undefined,
    localApiEnabled: true, setLocalApiEnabled: () => undefined, localApiBaseUrl: '', setLocalApiBaseUrl: () => undefined,
    readStatus: { phase, snapshot: phase === 'loaded' ? fixture() as NonNullable<AppState['readStatus']['snapshot']> : null, loadedAt: phase === 'loaded' ? Date.now() : null, failure: null }, refreshReadStatus: async () => undefined
  });
  it('真实渲染替换无证断言，ready只报历史且发送门仍关闭', () => {
    const desktop = { available: false, snapshot: UNAVAILABLE_SNAPSHOT, logs: [], settings: null, settingsLoad: 'no-bridge' as const, refresh: () => undefined, refreshLogs: () => undefined, refreshSettings: () => undefined };
    const account: AccountCatalogHandle = { ...INITIAL_ACCOUNT_CATALOG, refresh: async () => undefined };
    const html = renderToStaticMarkup(createElement(OverviewPage, { state: state('loaded'), desktop, account }));
    expect(html).toContain('历史驱动 official-host/ready'); expect(html).toContain('账号握手未证明');
    // 默认标签是「运行时」：证据说明与账号权益的内容改由各自标签承载，但页头徽章常驻。
    expect(html).toContain('未观测'); expect(html).toContain('E0'); expect(html).toContain('总览');
    expect(html).toContain('运行时'); expect(html).toContain('账号与权益'); expect(html).toContain('证据说明');
    for (const wrong of ['未检测到 app-server', 'API 未实现，无监听', '本次启动已发请求数', '已读到本轮事实']) expect(html).not.toContain(wrong);
  });
  it.each(['idle', 'loading', 'loaded', 'failed', 'disabled'] as const)('%s下发送/取消均disabled', phase => {
    const html = renderToStaticMarkup(createElement(ChatPage, { state: state(phase) }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>不可发送（E0）<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>取消<\/button>/);
    expect(html).toContain('发送门：关闭');
  });
});

// Real hook failure branch after unmount must also be ignored.
it('卸载后的迟到失败不写状态或日志', async () => {
  const h = await harness(); h.render().setLocalApiEnabled(true);
  const pending = h.render().refreshReadStatus(); h.unmount(); h.reads[0]!.reject(new Error('synthetic late')); await pending;
  expect(h.writesAfterUnmount()).toBe(0);
});
