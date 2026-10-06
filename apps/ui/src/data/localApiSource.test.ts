/**
 * UI04 单元测试：本机 API 通道的**回环守卫**与**失败注入**。
 *
 * 网络边界（UI04 裁定）：UI 从"零网络"进入"仅回环自连"——只允许请求
 * companion 自己的 API，禁止任何其他来源。因此本组用例与 UI02 第 8 组相反：
 *   1. 守卫：任何非回环 base URL 在**发起任何请求之前**就被拒，fetch 调用数为 0；
 *   2. 失败注入：API 未启动 / 非 2xx / 超时 / 畸形 body 各自映射到既有六种失败原因
 *      里的 transport 类或 malformed_payload，并且**全部保留刷新前的旧列表**；
 *   3. 成功：真实 fetch 拿到契约响应后渲染条目，条目仍恒为 unverified + sendEligible=false。
 *
 * 全部为纯本地测试：fetch 一律由测试注入的桩实现，**不发任何外网请求**。
 * 唯一的例外是第 5 段（ZC-49）按卡执行的复现用例：进程自建 `127.0.0.1` +
 * 端口 0（临时端口）的自有 HTTP 服务，用例内立即销毁，**不连任何外部主机**。
 * 不使用恒真断言、不 skip。
 *
 * **串行复用约定（§6 测试文件独占表）**：本文件由 O-H 单 owner 在 ZC-49 → ZC-50 → ZC-53
 * 三张卡上**严格串行**复用，三张卡不得并行。每张卡只**追加**自己的编号段
 * （第 5 段 = ZC-49），**不得**改写、删除或放宽前序卡片已落地的任何断言；
 * 每段的工具函数按卡片前缀命名，互不占用命名空间。
 */

import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_FIXTURE_V1,
  createInitialSourceState,
  describeRefreshFailure,
  offlineSourceLoader,
  resolveSourceLoader,
  runRefresh,
  SOURCE_ENDPOINT,
  type RefreshState,
  type SourceLoader
} from './modelSource';
import {
  CATALOG_REQUEST_TIMEOUT_MS,
  DEFAULT_LOCAL_API_BASE_URL,
  LOOPBACK_API_BASE_URL,
  LOOPBACK_HOSTNAMES,
  createLocalApiSourceLoader,
  isAllowedLocalApiBaseUrl,
  resolveCatalogUrl,
  resolveSourceLoaderForUi,
  type LocalApiFetchCall,
  type LocalApiFetchLike,
  type LocalApiResponseLike
} from './localApiSource';

/* ------------------------------------------------------------------ *
 * 测试替身
 * ------------------------------------------------------------------ */

interface StubResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** 让 response.text() 抛错（模拟读取响应体失败）。 */
  textThrows?: boolean;
}

function stubResponse(r: StubResponse): LocalApiResponseLike {
  const status = r.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        const found = Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === key);
        return found ? found[1] : null;
      }
    },
    text: () => (r.textThrows ? Promise.reject(new Error('响应体读取失败')) : Promise.resolve(r.body ?? ''))
  };
}

/** 记录每一次调用的 fetch 桩。绝不真正发请求。 */
function recordingFetch(
  handler: (url: string, init: Parameters<LocalApiFetchLike>[1]) => Promise<LocalApiResponseLike>
): { calls: LocalApiFetchCall[]; fetchImpl: LocalApiFetchLike } {
  const calls: LocalApiFetchCall[] = [];
  const fetchImpl: LocalApiFetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

/** 永远不会自己 settle 的 fetch：只有被 abort 才以 AbortError 结束。 */
const neverSettlesUntilAbort: LocalApiFetchLike = (_url, init) =>
  new Promise<LocalApiResponseLike>((_resolve, reject) => {
    const signal = init.signal;
    if (signal.aborted) {
      reject(makeAbortError());
      return;
    }
    signal.addEventListener('abort', () => reject(makeAbortError()));
  });

function makeAbortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

async function runLoader(loader: SourceLoader, base?: RefreshState): Promise<RefreshState> {
  return runRefresh(base ?? createInitialSourceState().refresh, loader, () => 1000);
}

/** 一条"之前成功读到过 2 条"的刷新状态，用于验证失败后旧列表被保留。 */
async function stateWithEntries(): Promise<RefreshState> {
  return runLoader(() => Promise.resolve(CATALOG_FIXTURE_V1));
}

/* ================================================================== *
 * 1. 回环守卫：只允许 companion 自己的回环 API，其他来源一律拒
 * ================================================================== */

describe('回环守卫：base URL 只能是空（同源）或本机回环 origin', () => {
  it('默认 base URL 是同源（相对路径），不是硬编码的外网 origin', () => {
    expect(DEFAULT_LOCAL_API_BASE_URL).toBe('');
    const v = resolveCatalogUrl(DEFAULT_LOCAL_API_BASE_URL);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.url).toBe(SOURCE_ENDPOINT);
  });

  it('本机 API 的裁定端口回环 origin 被接受（URL 由固定契约路径拼成）', () => {
    const v = resolveCatalogUrl(LOOPBACK_API_BASE_URL);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.origin).toBe('http://127.0.0.1:8790');
      expect(v.url).toBe(`http://127.0.0.1:8790${SOURCE_ENDPOINT}`);
    }
  });

  it('回环白名单恰好是字面回环主机，不含 0.0.0.0 / 通配 / 空串', () => {
    expect([...LOOPBACK_HOSTNAMES]).toEqual(['127.0.0.1', 'localhost', '[::1]']);
  });

  const allowed: string[] = [
    '',
    '/',
    'http://127.0.0.1:8790',
    'http://127.0.0.1:8790/',
    'https://127.0.0.1:8790',
    'http://localhost:8790',
    'http://[::1]:8790'
  ];
  for (const base of allowed) {
    it(`接受回环 base「${base || '（空 = 同源）'}」`, () => {
      expect(isAllowedLocalApiBaseUrl(base)).toBe(true);
      expect(resolveCatalogUrl(base).ok).toBe(true);
    });
  }

  const rejected: string[] = [
    'https://api.openai.com',
    'http://api.anthropic.com/v1',
    'http://example.com:8790',
    'http://127.0.0.1.evil.com:8790',
    'http://127.0.0.1:8790.evil.com',
    'http://0.0.0.0:8790',
    'http://10.0.0.5:8790',
    'http://[::]:8790',
    'ftp://127.0.0.1:8790',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '//127.0.0.1:8790',
    '127.0.0.1:8790',
    'http://user:pass@127.0.0.1:8790',
    'http://127.0.0.1:8790/v1/zcc/catalog',
    'http://127.0.0.1:8790?a=1',
    'http://127.0.0.1:8790#x',
    'https://zcc-companion.example/v1'
  ];
  for (const base of rejected) {
    it(`拒绝非回环 / 非法 base「${base}」`, () => {
      expect(isAllowedLocalApiBaseUrl(base)).toBe(false);
      const v = resolveCatalogUrl(base);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason.trim().length).toBeGreaterThan(0);
    });
  }

  it('守卫拒绝时：一次 fetch 都不发起，失败原因是 transport 类且旧列表原样保留', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => stubResponse({ body: '{}' }));
    const loader = createLocalApiSourceLoader({ baseUrl: 'https://api.openai.com', fetchImpl });
    const before = await stateWithEntries();
    const next = await runLoader(loader, before);
    expect(calls).toEqual([]);
    expect(next.status).toBe('failed');
    expect(next.failure?.reason).toBe('transport_not_wired');
    expect(describeRefreshFailure(next.failure!.reason).known).toBe(true);
    expect(next.entries.map((e) => e.modelId)).toEqual(before.entries.map((e) => e.modelId));
  });
});

/* ================================================================== *
 * 2. 请求本身的形状：只读 GET、契约路径、禁重定向、禁缓存
 * ================================================================== */

describe('请求形状：只读目录、不带凭据、不跟随重定向', () => {
  it('发出的是 GET + 固定契约路径 + no-store + error 重定向，且不带任何鉴权头', async () => {
    const { calls, fetchImpl } = recordingFetch(async () =>
      stubResponse({ body: JSON.stringify(CATALOG_FIXTURE_V1) })
    );
    const loader = createLocalApiSourceLoader({ baseUrl: LOOPBACK_API_BASE_URL, fetchImpl });
    const next = await runLoader(loader);
    expect(next.status).toBe('ok');
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe(`http://127.0.0.1:8790${SOURCE_ENDPOINT}`);
    expect(call.init.method).toBe('GET');
    expect(call.init.cache).toBe('no-store');
    expect(call.init.redirect).toBe('error');
    expect(call.init.signal).toBeDefined();
    const headerKeys = Object.keys(call.init.headers).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain('authorization');
    expect(headerKeys).not.toContain('cookie');
    expect(headerKeys).toEqual(['accept']);
  });

  it('base URL 末尾的斜杠不会产生双斜杠路径', async () => {
    const { calls, fetchImpl } = recordingFetch(async () =>
      stubResponse({ body: JSON.stringify(CATALOG_FIXTURE_V1) })
    );
    const loader = createLocalApiSourceLoader({ baseUrl: 'http://127.0.0.1:8790/', fetchImpl });
    await runLoader(loader);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:8790${SOURCE_ENDPOINT}`);
  });

  it('成功读回时渲染条目，且条目恒为 unverified / sendEligible=false / 测试态标注', async () => {
    const { fetchImpl } = recordingFetch(async () =>
      stubResponse({
        body: JSON.stringify(CATALOG_FIXTURE_V1),
        headers: { 'x-zcc-fixture': 'true', 'x-zcc-status': 'ready' }
      })
    );
    const next = await runLoader(createLocalApiSourceLoader({ baseUrl: '', fetchImpl }));
    expect(next.status).toBe('ok');
    expect(next.revision).toBe('fixture-rev-1');
    expect(next.entries.length).toBe(2);
    for (const e of next.entries) {
      expect(e.origin).toBe('source');
      expect(e.availability).toBe('unverified');
      expect(e.sendEligible).toBe(false);
      expect(e.note).toContain('未验证');
    }
    expect(next.failure).toBeNull();
  });

  it('默认执行器走平台 fetch（不是某个 undefined 的桩），可被全局探针观测', async () => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const prev = scope['fetch'];
    const seen: string[] = [];
    scope['fetch'] = (url: string) => {
      seen.push(String(url));
      return Promise.resolve(stubResponse({ body: JSON.stringify(CATALOG_FIXTURE_V1) }));
    };
    try {
      const next = await runLoader(createLocalApiSourceLoader({ baseUrl: LOOPBACK_API_BASE_URL }));
      expect(seen).toEqual([`http://127.0.0.1:8790${SOURCE_ENDPOINT}`]);
      expect(next.status).toBe('ok');
    } finally {
      scope['fetch'] = prev;
    }
  });
});

/* ================================================================== *
 * 3. 失败注入：五种失败路径各自映射到既有失败原因，旧列表一律保留
 * ================================================================== */

describe('失败注入：API 未启动 / 非 2xx / 超时 / 畸形 body', () => {
  it('① API 未启动：fetch 抛连接类错误 → api_not_running，保留旧列表', async () => {
    const { fetchImpl } = recordingFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const before = await stateWithEntries();
    const next = await runLoader(
      createLocalApiSourceLoader({ baseUrl: LOOPBACK_API_BASE_URL, fetchImpl }),
      before
    );
    expect(next.status).toBe('failed');
    expect(next.failure?.reason).toBe('api_not_running');
    expect(next.failure?.detail).toContain('fetch failed');
    expect(next.failure?.detail).toContain('127.0.0.1:8790');
    expect(next.entries).toEqual(before.entries);
    expect(next.lastSuccessAt).toBe(before.lastSuccessAt);
  });

  it('② 非 2xx：503 + x-zcc-detail → connection_failed，detail 带状态码与服务端说明', async () => {
    const { fetchImpl } = recordingFetch(async () =>
      stubResponse({
        status: 503,
        body: '{"error":"upstream_unavailable"}',
        headers: { 'x-zcc-detail': '上游缺席，无额度', 'x-zcc-status': 'no_quota' }
      })
    );
    const before = await stateWithEntries();
    const next = await runLoader(
      createLocalApiSourceLoader({ baseUrl: LOOPBACK_API_BASE_URL, fetchImpl }),
      before
    );
    expect(next.status).toBe('failed');
    expect(next.failure?.reason).toBe('connection_failed');
    expect(next.failure?.detail).toContain('503');
    expect(next.failure?.detail).toContain('上游缺席，无额度');
    expect(next.failure?.detail).toContain('x-zcc-status: no_quota');
    expect(next.entries).toEqual(before.entries);
  });

  it('②b 非 2xx：401 鉴权失败也归 connection_failed，并如实带上 www-authenticate', async () => {
    const { fetchImpl } = recordingFetch(async () =>
      stubResponse({
        status: 401,
        body: '{"error":"unauthorized"}',
        headers: { 'www-authenticate': 'Bearer' }
      })
    );
    const next = await runLoader(createLocalApiSourceLoader({ baseUrl: '', fetchImpl }));
    expect(next.failure?.reason).toBe('connection_failed');
    expect(next.failure?.detail).toContain('401');
    expect(next.failure?.detail).toContain('www-authenticate: Bearer');
  });

  it('③ 超时：请求被超时控制器中止 → timeout，保留旧列表', async () => {
    const { calls, fetchImpl } = recordingFetch(neverSettlesUntilAbort);
    const before = await stateWithEntries();
    const next = await runLoader(
      createLocalApiSourceLoader({ baseUrl: LOOPBACK_API_BASE_URL, fetchImpl, timeoutMs: 20 }),
      before
    );
    expect(calls.length).toBe(1);
    expect(next.status).toBe('failed');
    expect(next.failure?.reason).toBe('timeout');
    expect(next.failure?.detail).toContain('20ms');
    expect(next.entries).toEqual(before.entries);
  });

  it('③b 超时上限是常量且不超过 10s（不写一个无界等待）', () => {
    expect(Number.isInteger(CATALOG_REQUEST_TIMEOUT_MS)).toBe(true);
    expect(CATALOG_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CATALOG_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(10000);
  });

  it('④ 畸形 body：非 JSON 文本 → malformed_payload，保留旧列表', async () => {
    const { fetchImpl } = recordingFetch(async () =>
      stubResponse({ body: 'not-json <<<catalog truncated' })
    );
    const before = await stateWithEntries();
    const next = await runLoader(
      createLocalApiSourceLoader({ baseUrl: LOOPBACK_API_BASE_URL, fetchImpl }),
      before
    );
    expect(next.status).toBe('failed');
    expect(next.failure?.reason).toBe('malformed_payload');
    expect(next.entries).toEqual(before.entries);
  });

  it('④b 畸形 body：JSON 但形状不合契约（标准 /v1/models 形状）→ 整体拒绝 + 逐条缺陷', async () => {
    const { fetchImpl } = recordingFetch(async () =>
      stubResponse({ body: JSON.stringify({ object: 'list', data: [{ id: 'x', owned_by: 'y' }] }) })
    );
    const before = await stateWithEntries();
    const next = await runLoader(
      createLocalApiSourceLoader({ baseUrl: '', fetchImpl }),
      before
    );
    expect(next.status).toBe('failed');
    expect(next.failure?.reason).toBe('malformed_payload');
    expect(next.failure?.defects?.map((d) => d.code)).toContain('payload_foreign_shape');
    expect(next.entries).toEqual(before.entries);
  });

  it('④c 畸形 body：响应体为空 → malformed_payload（不是"成功且目录为空"）', async () => {
    const { fetchImpl } = recordingFetch(async () => stubResponse({ body: '' }));
    const next = await runLoader(createLocalApiSourceLoader({ baseUrl: '', fetchImpl }));
    expect(next.failure?.reason).toBe('malformed_payload');
    expect(next.entries).toEqual([]);
  });

  it('④d 响应体读取中断：2xx 但正文读不出来 → connection_failed（不是"空来源"）', async () => {
    const { fetchImpl } = recordingFetch(async () => stubResponse({ textThrows: true }));
    const before = await stateWithEntries();
    const next = await runLoader(createLocalApiSourceLoader({ baseUrl: '', fetchImpl }), before);
    expect(next.failure?.reason).toBe('connection_failed');
    expect(next.entries).toEqual(before.entries);
  });

  it('⑤ 空来源：200 + models:[] → empty_source（旧列表保留，不回退成假数据）', async () => {
    const { fetchImpl } = recordingFetch(async () =>
      stubResponse({ body: JSON.stringify({ revision: 'none', models: [] }) })
    );
    const before = await stateWithEntries();
    const next = await runLoader(createLocalApiSourceLoader({ baseUrl: '', fetchImpl }), before);
    expect(next.failure?.reason).toBe('empty_source');
    expect(next.entries).toEqual(before.entries);
  });

  it('五种失败全部落在已登记的六种失败原因内，且 keepsPreviousList 恒为 true', async () => {
    const loaders: SourceLoader[] = [
      createLocalApiSourceLoader({
        baseUrl: '',
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        }
      }),
      createLocalApiSourceLoader({ baseUrl: '', fetchImpl: async () => stubResponse({ status: 500 }) }),
      createLocalApiSourceLoader({
        baseUrl: '',
        fetchImpl: neverSettlesUntilAbort,
        timeoutMs: 20
      }),
      createLocalApiSourceLoader({ baseUrl: '', fetchImpl: async () => stubResponse({ body: 'nope' }) }),
      createLocalApiSourceLoader({ baseUrl: 'https://evil.example', fetchImpl: async () => stubResponse({}) })
    ];
    for (const loader of loaders) {
      const before = await stateWithEntries();
      const next = await runLoader(loader, before);
      expect(next.status).toBe('failed');
      const view = describeRefreshFailure(next.failure!.reason);
      expect(view.known).toBe(true);
      expect(view.info.keepsPreviousList).toBe(true);
      expect(next.entries).toEqual(before.entries);
    }
  });
});

/* ================================================================== *
 * 4. 执行器选择：默认关闭 = 零网络；开启 = 回环 fetch；fixture 优先
 * ================================================================== */

describe('执行器选择：默认仍是零网络，连接本机 API 必须是显式开启', () => {
  it('未开启连接本机 API 时，选中的执行器就是 offlineSourceLoader 本身（对象同一性）', () => {
    expect(resolveSourceLoaderForUi({ fixtureScenario: null, localApiEnabled: false })).toBe(
      offlineSourceLoader
    );
    expect(
      resolveSourceLoaderForUi({ fixtureScenario: undefined, localApiEnabled: false, baseUrl: '' })
    ).toBe(offlineSourceLoader);
  });

  it('未开启时即使填了 base URL 也不发起任何请求（开关才是唯一钥匙）', async () => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const prev = scope['fetch'];
    const seen: string[] = [];
    scope['fetch'] = (url: string) => {
      seen.push(String(url));
      return Promise.resolve(stubResponse({ body: '{}' }));
    };
    try {
      const next = await runLoader(
        resolveSourceLoaderForUi({
          fixtureScenario: null,
          localApiEnabled: false,
          baseUrl: LOOPBACK_API_BASE_URL
        })
      );
      expect(seen).toEqual([]);
      expect(next.failure?.reason).toBe('transport_not_wired');
    } finally {
      scope['fetch'] = prev;
    }
  });

  it('开启后选中的是回环 fetch 执行器（既不是 offlineSourceLoader 也不是 fixture 执行器）', () => {
    const loader = resolveSourceLoaderForUi({
      fixtureScenario: null,
      localApiEnabled: true,
      baseUrl: LOOPBACK_API_BASE_URL
    });
    expect(loader).not.toBe(offlineSourceLoader);
    expect(loader).not.toBe(resolveSourceLoader('catalog2_then_conn_fail'));
  });

  it('URL 参数切到的 fixture 场景优先于开关（测试态仍然零网络）', async () => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const prev = scope['fetch'];
    const seen: string[] = [];
    scope['fetch'] = (url: string) => {
      seen.push(String(url));
      return Promise.resolve(stubResponse({ body: '{}' }));
    };
    try {
      const next = await runLoader(
        resolveSourceLoaderForUi({
          fixtureScenario: 'catalog2_then_conn_fail',
          localApiEnabled: true,
          baseUrl: LOOPBACK_API_BASE_URL
        })
      );
      expect(seen).toEqual([]);
      expect(next.status).toBe('ok');
      expect(next.entries.every((e) => e.modelId.startsWith('fixture-'))).toBe(true);
    } finally {
      scope['fetch'] = prev;
    }
  });
});

/* ================================================================== *
 * 5. ZC-49 / F28：同一超时预算必须覆盖「fetch + 完整正文」
 *
 * 缺陷事实：`localApiSource.ts` 原来把唯一的 setTimeout 放在 `await doFetch`
 * 的 finally 里清除，于是 2xx 头一旦返回预算即被撤销，`res.text()` 进入
 * **没有任何应用上限**的等待，刷新永远停在 busy。
 *
 * 本段工具一律 zc49 前缀，不改既有测试替身，避免影响 ZC-50 / ZC-53 复用。
 * ================================================================== */

/** 测试自己的等待/观察上限；不经产品计时器计数，也不被产品清理逻辑影响。 */
const zc49NativeSetTimeout: typeof globalThis.setTimeout = globalThis.setTimeout.bind(globalThis);

function zc49Now(): number {
  return Date.now();
}

/**
 * 计数"**产品代码**在观测窗口内创建、到终态仍未被清除"的计时器
 * （卡上的 `productTimers` 口径）。`created` 是产品计时器创建总数，`live` 是终态残留数。
 *
 * 为什么要按调用栈归属：原生 fetch 通路下，undici 自己会为连接建立
 * `FastTimer`（栈帧在 `node:internal/deps/undici/undici` 的 `refreshTimeout`），
 * 它不是产品代码，也从不计入 `productTimers`。这里只把栈帧落在产品模块
 * `localApiSource.ts` 上的计时器算作产品计时器，平台自己的计时器单列。
 */
const ZC49_PRODUCT_TIMER_STACK = /localApiSource\.ts[:)]/;

function zc49InstallTimerProbe(): {
  live: () => number;
  created: () => number;
  foreignLive: () => number;
  restore: () => void;
} {
  const scope = globalThis as unknown as Record<string, unknown>;
  const prevSet = scope['setTimeout'];
  const prevClear = scope['clearTimeout'];
  const live = new Set<unknown>();
  const foreign = new Set<unknown>();
  let created = 0;
  scope['setTimeout'] = (fn: unknown, ms?: unknown, ...rest: unknown[]) => {
    const handle = (prevSet as (...a: unknown[]) => unknown)(fn, ms, ...rest);
    const stack = new Error('timer-origin').stack ?? '';
    if (ZC49_PRODUCT_TIMER_STACK.test(stack)) {
      created += 1;
      live.add(handle);
    } else {
      foreign.add(handle);
    }
    return handle;
  };
  scope['clearTimeout'] = (handle: unknown) => {
    live.delete(handle);
    foreign.delete(handle);
    return (prevClear as (h: unknown) => unknown)(handle);
  };
  return {
    live: () => live.size,
    created: () => created,
    foreignLive: () => foreign.size,
    restore: () => {
      scope['setTimeout'] = prevSet;
      scope['clearTimeout'] = prevClear;
    }
  };
}

/**
 * 给未结算的 promise 加一个**测试自己的**观察上限。
 * 没有它，红例会退化成 vitest 用例超时（记成 setup 问题），而不是命中目标断言。
 */
function zc49WithSettleDeadline<T>(pending: Promise<T>, deadlineMs: number): Promise<T | null> {
  return Promise.race<T | null>([
    pending,
    new Promise<null>((resolve) => {
      zc49NativeSetTimeout(() => resolve(null), deadlineMs);
    })
  ]);
}

/** 2xx 头立即返回，但 `text()` 永远不结算——复现 F28 的"头已到、正文不结束"。 */
function zc49HeadersWithoutEndingBody(): LocalApiResponseLike {
  return {
    ok: true,
    status: 200,
    statusText: 'status 200',
    headers: { get: () => null },
    text: () => new Promise<string>(() => {})
  };
}

describe('ZC-49 · 同一超时预算覆盖 fetch 与完整正文', () => {
  it('ZC-49-1 头已返回但正文不结束：必须在同一预算内结算为 timeout（旧实现会无限 pending）', async () => {
    const before = await stateWithEntries();
    const { calls, fetchImpl } = recordingFetch(async () => zc49HeadersWithoutEndingBody());
    const probe = zc49InstallTimerProbe();
    let settled: RefreshState | null = null;
    try {
      settled = await zc49WithSettleDeadline(
        runLoader(
          createLocalApiSourceLoader({ baseUrl: LOOPBACK_API_BASE_URL, fetchImpl, timeoutMs: 80 }),
          before
        ),
        3000
      );
    } finally {
      probe.restore();
    }
    expect(settled, '响应正文不结束时执行器必须在预算内结算，不能无限 pending').not.toBeNull();
    expect(calls.length).toBe(1);
    expect(settled!.status).toBe('failed');
    expect(settled!.failure?.reason).toBe('timeout');
    expect(settled!.failure?.detail).toContain('80ms');
    expect(settled!.entries).toEqual(before.entries);
    expect(settled!.lastSuccessAt).toBe(before.lastSuccessAt);
  });

  it('ZC-49-2 负例(a) 头部就不返回的对照路径：仍映射 timeout 并保留旧列表', async () => {
    const before = await stateWithEntries();
    const { calls, fetchImpl } = recordingFetch(neverSettlesUntilAbort);
    const probe = zc49InstallTimerProbe();
    let settled: RefreshState | null = null;
    try {
      settled = await zc49WithSettleDeadline(
        runLoader(
          createLocalApiSourceLoader({ baseUrl: LOOPBACK_API_BASE_URL, fetchImpl, timeoutMs: 80 }),
          before
        ),
        3000
      );
    } finally {
      probe.restore();
    }
    expect(settled, '头部超时路径必须在预算内结算').not.toBeNull();
    expect(calls.length).toBe(1);
    expect(settled!.status).toBe('failed');
    expect(settled!.failure?.reason).toBe('timeout');
    expect(settled!.failure?.detail).toContain('80ms');
    expect(settled!.entries).toEqual(before.entries);
    expect(settled!.lastSuccessAt).toBe(before.lastSuccessAt);
  });

  it('ZC-49-3 负例(b) 正常一次 end：2xx + 合法 JSON 正文照常结算为 ok，不被新超时路径误伤', async () => {
    const before = await stateWithEntries();
    const { calls, fetchImpl } = recordingFetch(async () =>
      stubResponse({ body: JSON.stringify(CATALOG_FIXTURE_V1) })
    );
    const probe = zc49InstallTimerProbe();
    let settled: RefreshState | null = null;
    try {
      settled = await zc49WithSettleDeadline(
        runLoader(
          createLocalApiSourceLoader({ baseUrl: LOOPBACK_API_BASE_URL, fetchImpl, timeoutMs: 2000 }),
          before
        ),
        3000
      );
    } finally {
      probe.restore();
    }
    expect(settled, '正常一次 end 必须结算').not.toBeNull();
    expect(calls.length).toBe(1);
    expect(settled!.status).toBe('ok');
    expect(settled!.failure).toBeNull();
    expect(settled!.revision).toBe('fixture-rev-1');
    expect(settled!.entries.map((e) => e.modelId)).toEqual(before.entries.map((e) => e.modelId));
  });

  it('ZC-49-4 负例(c) 预算耗尽后终态无残留计时器（头超时 / 正文超时 / 正常一次 end 三条路径）', async () => {
    const before = await stateWithEntries();
    const cases: Array<{ name: string; fetchImpl: LocalApiFetchLike; timeoutMs: number; reason: string | null }> = [
      { name: '头部超时', fetchImpl: neverSettlesUntilAbort, timeoutMs: 60, reason: 'timeout' },
      {
        name: '正文超时',
        fetchImpl: async () => zc49HeadersWithoutEndingBody(),
        timeoutMs: 60,
        reason: 'timeout'
      },
      {
        name: '正常一次 end',
        fetchImpl: async () => stubResponse({ body: JSON.stringify(CATALOG_FIXTURE_V1) }),
        timeoutMs: 2000,
        reason: null
      }
    ];
    for (const c of cases) {
      const probe = zc49InstallTimerProbe();
      let settled: RefreshState | null = null;
      let live = -1;
      let created = -1;
      try {
        settled = await zc49WithSettleDeadline(
          runLoader(
            createLocalApiSourceLoader({ baseUrl: LOOPBACK_API_BASE_URL, fetchImpl: c.fetchImpl, timeoutMs: c.timeoutMs }),
            before
          ),
          3000
        );
        live = probe.live();
        created = probe.created();
      } finally {
        probe.restore();
      }
      expect(settled, `${c.name}：未在观察上限内结算`).not.toBeNull();
      expect(settled!.failure?.reason ?? null, `${c.name}：失败原因不符`).toBe(c.reason);
      expect(created, `${c.name}：同一预算应创建恰好 1 个产品计时器`).toBe(1);
      expect(live, `${c.name}：终态仍残留 ${live} 个产品计时器（finally 未清理）`).toBe(0);
    }
  });

  it('ZC-49-5 原生 fetch + 自有回环 HTTP：头及时返回、正文不结束 → 同一预算结算为 timeout 且终态无残留计时器', async () => {
    const budgetMs = 300;
    let headerAt = 0;
    let bodyFinished = false;
    let requestCount = 0;
    const sockets = new Set<import('node:net').Socket>();
    const server: Server = createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
      res.flushHeaders();
      headerAt = zc49Now();
      // 只写半个 JSON 就停住，且**永不 end()**：正文永远不结束。
      res.write('{"revision":"never","models":[');
      res.on('finish', () => {
        bodyFinished = true;
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    let settled: RefreshState | null = null;
    let live = -1;
    let created = -1;
    let foreign = -1;
    let elapsed = -1;
    const startedAt = zc49Now();
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      expect(port, '自有 HTTP 服务未取得临时端口').toBeGreaterThan(0);
      const probe = zc49InstallTimerProbe();
      try {
        // 不注入 fetchImpl → 执行器走平台原生 fetch（与报告复现同一条真实通路）。
        settled = await zc49WithSettleDeadline(
          runLoader(
            createLocalApiSourceLoader({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: budgetMs })
          ),
          8000
        );
        live = probe.live();
        created = probe.created();
        foreign = probe.foreignLive();
      } finally {
        probe.restore();
      }
      elapsed = zc49Now() - startedAt;
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(requestCount, '自有 HTTP 服务只应收到 1 次请求').toBe(1);
    expect(headerAt - startedAt, '响应头应在预算内及时返回').toBeLessThan(budgetMs);
    expect(bodyFinished, '本用例要求服务端正文确实没有结束').toBe(false);
    expect(settled, `正文不结束时执行器必须在 ${budgetMs}ms 预算内结算，不能无限 pending`).not.toBeNull();
    expect(settled!.status).toBe('failed');
    expect(settled!.failure?.reason).toBe('timeout');
    expect(settled!.failure?.detail).toContain(`${budgetMs}ms`);
    expect(settled!.entries).toEqual([]);
    expect(elapsed, `正文超时应由 ${budgetMs}ms 预算结算，实际耗时 ${elapsed}ms`).toBeLessThan(3000);
    expect(created, '同一预算只应创建 1 个产品计时器').toBe(1);
    expect(live, `终态仍残留 ${live} 个产品计时器（foreign=${foreign} 属 undici 连接定时器，不计）`).toBe(0);
  });
});


/* ZC-50: source selection must be enforced before the HTTP boundary. */
describe('ZC-50 transport selection', () => {
  it('file transport rejects before fetch and preserves the previous catalog', async () => {
    const before = { ...(await stateWithEntries()), transport: 'local_config_file' as const };
    const { calls, fetchImpl } = recordingFetch(async () => stubResponse({ body: JSON.stringify(CATALOG_FIXTURE_V1) }));
    const result = await runLoader(createLocalApiSourceLoader({ fetchImpl }), before);
    expect(calls).toHaveLength(0);
    expect(result.status).toBe('failed');
    expect(result.failure?.reason).toBe('transport_not_wired');
    expect(result.entries).toEqual(before.entries);
    expect(result.lastSuccessAt).toBe(before.lastSuccessAt);
  });

  it('API disabled retains offline rejection and previous rows for file transport', async () => {
    const before = { ...(await stateWithEntries()), transport: 'local_config_file' as const };
    const loader = resolveSourceLoaderForUi({ localApiEnabled: false });
    expect(loader).toBe(offlineSourceLoader);
    const result = await runLoader(loader, before);
    expect(result.status).toBe('failed');
    expect(result.failure?.reason).toBe('transport_not_wired');
    expect(result.entries).toEqual(before.entries);
  });

  it('explicit API transport still fetches and returns catalog rows', async () => {
    const { calls, fetchImpl } = recordingFetch(async () => stubResponse({ body: JSON.stringify(CATALOG_FIXTURE_V1) }));
    const result = await runLoader(createLocalApiSourceLoader({ fetchImpl }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SOURCE_ENDPOINT);
    expect(result.status).toBe('ok');
    expect(result.entries.length).toBeGreaterThan(0);
  });
});


describe('ZC-50 UI selection boundary', () => {
  it('API enabled rejects file selection before HTTP through the UI resolver', async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('unexpected HTTP'); };
    try {
      const before = { ...(await stateWithEntries()), transport: 'local_config_file' as const };
      const result = await runLoader(resolveSourceLoaderForUi({ localApiEnabled: true }), before);
      expect(calls).toBe(0);
      expect(result.status).toBe('failed');
      expect(result.failure?.reason).toBe('transport_not_wired');
      expect(result.entries).toEqual(before.entries);
    } finally { globalThis.fetch = previousFetch; }
  });
  it('fixture priority and API disabled remain zero-network for file selection', async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('unexpected HTTP'); };
    try {
      const before = { ...(await stateWithEntries()), transport: 'local_config_file' as const };
      const fixture = await runLoader(resolveSourceLoaderForUi({ localApiEnabled: true, fixtureScenario: 'catalog2_then_conn_fail' }), before);
      expect(fixture.status).toBe('ok');
      expect(fixture.entries.length).toBeGreaterThan(0);
      const offline = await runLoader(resolveSourceLoaderForUi({ localApiEnabled: false }), before);
      expect(offline.status).toBe('failed');
      expect(offline.failure?.reason).toBe('transport_not_wired');
      expect(offline.entries).toEqual(before.entries);
      expect(calls).toBe(0);
    } finally { globalThis.fetch = previousFetch; }
  });
});
