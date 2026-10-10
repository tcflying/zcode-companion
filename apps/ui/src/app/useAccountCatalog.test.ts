/**
 * ZCC-ACCOUNT-EVIDENCE-20261009 · `useAccountCatalog` 的启用口径回归钉。
 *
 * 这条用例钉的是**纠偏后的契约**：总览页「账号与权益」的只读目录读取
 * **默认启用**，不受设置页「连接本机 API」开关（模型页动态刷新的外联守卫）控制。
 * 上一版误把两者绑在一起，导致默认态永远停在「未接入 / E0」，本轮功能等于没上线。
 *
 * 装配沿用 `useAppState.test.ts` 的确定性生命周期 mock（自建 hooks 槽位），
 * 不触网、不用 jsdom。执行器由 `localApiSource.createLocalApiSourceLoader` 注入替身。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceLoader } from '../data/modelSource';

/** 记录 loader 被调用的次数与它每次返回什么。 */
interface Harness {
  render: () => ReturnType<typeof import('./useAccountCatalog').useAccountCatalog>;
  calls: () => number;
  settle: (payload: unknown) => Promise<void>;
  fail: (err: Error) => Promise<void>;
}

async function harness(): Promise<Harness> {
  vi.resetModules();
  const slots: unknown[] = [];
  let cursor = 0;
  const effects: Array<() => void | (() => void)> = [];
  const pending: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  let loaderCalls = 0;

  vi.doMock('react', async importOriginal => ({
    ...await importOriginal<typeof import('react')>(),
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useEffect: (fn: () => void | (() => void)) => { effects.push(fn); }
  }));
  vi.doMock('../data/localApiSource', async importOriginal => ({
    ...await importOriginal<typeof import('../data/localApiSource')>(),
    createLocalApiSourceLoader: (): SourceLoader => () => {
      loaderCalls += 1;
      return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
    }
  }));

  const module = await import('./useAccountCatalog');
  const render = () => { cursor = 0; effects.length = 0; return module.useAccountCatalog(); };
  // 首次挂载：跑一遍全部 effect
  render();
  effects.splice(0).forEach(fn => fn());
  return {
    render,
    calls: () => loaderCalls,
    settle: async payload => { const p = pending[pending.length - 1]; if (p) p.resolve(payload); await Promise.resolve(); await Promise.resolve(); },
    fail: async err => { const p = pending[pending.length - 1]; if (p) p.reject(err); await Promise.resolve(); await Promise.resolve(); }
  };
}

afterEach(() => {
  vi.doUnmock('react');
  vi.doUnmock('../data/localApiSource');
  vi.resetModules();
});

const CATALOG = {
  revision: 'rev-1',
  models: [
    {
      modelId: 'bigmodel::A',
      displayName: 'A',
      provider: 'bigmodel',
      billingClass: 'subscription',
      contextLength: 200000,
      reasoning: [],
      capabilities: []
    }
  ]
};

describe('useAccountCatalog：默认启用，不受模型页外联开关控制', () => {
  it('不传任何参数 → 挂载即发起一次只读目录读取', async () => {
    const h = await harness();
    expect(h.calls()).toBe(1);
    expect(h.render().phase).toBe('loading');
    await h.settle(CATALOG);
    expect(h.render().phase).toBe('loaded');
    expect(h.render().summary?.entitled).toBe(1);
  });

  it('读取失败 → failed 并带原因码，不保留旧 summary（不伪造）', async () => {
    const h = await harness();
    await h.fail(Object.assign(new Error('连接被拒'), { reason: 'api_not_running' }));
    const handle = h.render();
    expect(handle.phase).toBe('failed');
    expect(handle.summary).toBeNull();
    expect(handle.failure?.code).toBe('api_not_running');
  });

  it('显式 enabled:false → 一次请求都不发，停在未读回', async () => {
    vi.resetModules();
    const slots: unknown[] = [];
    let cursor = 0;
    const effects: Array<() => void | (() => void)> = [];
    let loaderCalls = 0;
    vi.doMock('react', async importOriginal => ({
      ...await importOriginal<typeof import('react')>(),
      useState: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (n: unknown) => { slots[i] = typeof n === 'function' ? n(slots[i]) : n; }]; },
      useRef: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useCallback: (fn: unknown) => fn,
      useMemo: (fn: () => unknown) => fn(),
      useEffect: (fn: () => void | (() => void)) => { effects.push(fn); }
    }));
    vi.doMock('../data/localApiSource', async importOriginal => ({
      ...await importOriginal<typeof import('../data/localApiSource')>(),
      createLocalApiSourceLoader: (): SourceLoader => () => { loaderCalls += 1; return Promise.resolve(CATALOG); }
    }));
    const module = await import('./useAccountCatalog');
    const handle = module.useAccountCatalog({ enabled: false });
    effects.splice(0).forEach(fn => fn());
    expect(loaderCalls).toBe(0);
    expect(handle.phase).toBe('idle');
    expect(handle.summary).toBeNull();
  });
});