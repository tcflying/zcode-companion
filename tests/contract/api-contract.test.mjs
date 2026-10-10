/**
 * API01 本机 OpenAI 兼容 API 契约测试。
 *
 * Provider-free：零网络外联、零官方进程、零数据库、零真实模型请求、零子进程。
 * 只监听 127.0.0.1 的临时端口（port 0），随测试结束立即优雅关闭。
 *
 * 位置必须在 `tests/contract/` 下，否则 vitest 的 include 选不中，
 * `test:contract` / `test` 两个门看不到本文件。
 *
 * 覆盖的硬事实：
 *  - 默认关闭、只绑 127.0.0.1、非回环配置构造即拒
 *  - Host 头校验（防 DNS rebinding）、Origin 白名单默认全拒、CORS 永不开启
 *  - Bearer 认证 401；key 不进日志、不回显、不落响应
 *  - 并发与速率双限流，超限 429，不排队
 *  - 幂等：同身份+同会话+同 body → 同一 operation 且标记 replayed；异 body → 409
 *  - 未知字段 400、已知但不支持的参数/角色 422、非法 JSON 400、超长 413
 *  - 上游缺席时 chat 503 且响应体不含任何模型内容、不含 usage
 *  - fixture 模式流式与非流式真实可用，内容确由 fixture 产生，SSE 以 [DONE] 结束
 *  - 优雅关闭：停止接受新连接、在途有界收束、timer/listener 全部回收
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import {
  createApiServer,
  HOST_LOOPBACK,
  DEFAULT_API_PORT,
  FIXTURE_TEST_TOKEN,
  API_SERVER_CONFIG_KEYS,
  IDEMPOTENCY_RESPONSE_VALUES,
  CATALOG_PATH
} from '../../packages/api/src/server.js';
import {
  generateApiKey,
  fingerprintApiKey,
  canonicalRequestHash,
  verifyApiKey,
  REQUEST_BODY_MAX_BYTES,
  METADATA_MAX_BYTES
} from '../../packages/api/src/auth.js';
import {
  createUnavailableDriver,
  createFixtureDriver,
  createFixtureCatalog,
  countFixtureTokens,
  truncateToFixtureTokens,
  deriveModelIsReal,
  catalogContractDefects,
  CATALOG_BILLING_CLASSES,
  CATALOG_MODEL_KEYS,
  EMPTY_CATALOG,
  FIXTURE_CATALOG_REVISION,
  SseBudget,
  SSE_FRAME_MAX_BYTES,
  STREAM_BUFFER_MAX_BYTES,
  FIXTURE_MODEL_ID,
  REASONING_EFFORT_LEVELS,
  TOP_LEVEL_ACCEPTED,
  TOP_LEVEL_REJECTED,
  SUPPORTED_ROLES,
  FOLDED_PROMPT_ROLES,
  ACCEPTED_TOOL_CHOICES,
  REQUIRED_TOOL_CHOICES,
  TOOLS_FORWARDED_NONE,
  foldMessagesToPrompt,
  collectFoldedPromptRoles,
  normalizedRequestHash,
  parseChatRequest
} from '../../packages/api/src/chat.js';
import { BILLING_CLASSES } from '../../packages/contracts/src/operation.js';
import { API_ERROR_SPECS, ApiError } from '../../packages/api/src/errors.js';
import { validateCompanionError } from '../../packages/contracts/src/errors.js';

const TEST_KEY = 'zcc_test_key_0123456789abcdefghijklmnop';

/** 工程根（静态钉要读生产源码本身，路径必须锚在本仓，不能靠 cwd）。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 剥掉块注释与行注释。静态钉只看**可执行代码**，注释里提到一个键名不算真的读了它。
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* -------------------------------------------------------------------------- */
/* HTTP 小工具                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {string} name
 * @returns {string}
 */
function header(headers, name) {
  const value = headers[name];
  if (value === undefined) return '';
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

/**
 * @typedef {object} Res
 * @property {number} status
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {string} text
 */

/**
 * @param {{port: number, method?: string, path?: string, headers?: Record<string, string>, body?: unknown, raw?: Buffer, chunked?: boolean}} opts
 * @returns {Promise<Res>}
 */
function request(opts) {
  const headers = { ...(opts.headers ?? {}) };
  let payload = opts.raw;
  if (payload === undefined && opts.body !== undefined) {
    payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
  }
  if (payload !== undefined && !opts.chunked && header(headers, 'content-length') === '') {
    headers['content-length'] = String(payload.length);
  }
  if (opts.chunked) headers['transfer-encoding'] = 'chunked';
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: opts.port, path: opts.path ?? '/v1/models', method: opts.method ?? 'GET', headers },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.on('error', reject);
    if (opts.chunked && payload !== undefined) {
      const stream = Readable.from([payload]);
      stream.pipe(req);
      return;
    }
    req.end(payload);
  });
}

/**
 * @param {string} text
 * @returns {any}
 */
function parseJson(text) {
  return JSON.parse(text);
}

/**
 * @param {{port: number, key?: string, headers?: Record<string, string>, body?: unknown, raw?: Buffer, method?: string, path?: string}} opts
 * @returns {Promise<Res>}
 */
function authed(opts) {
  const headers = { authorization: `Bearer ${opts.key ?? TEST_KEY}`, ...(opts.headers ?? {}) };
  return request({
    port: opts.port,
    method: opts.method ?? 'POST',
    path: opts.path ?? '/v1/chat/completions',
    headers,
    body: opts.body,
    raw: opts.raw
  });
}

/* -------------------------------------------------------------------------- */
/* 服务器小工具                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} Harness
 * @property {number} port
 * @property {string} key
 * @property {import('../../packages/api/src/server.js').ApiServer} server
 * @property {string[]} logs
 */

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {Promise<Harness>}
 */
async function startServer(overrides = {}) {
  /** @type {string[]} */
  const logs = [];
  const server = createApiServer({
    enabled: true,
    port: 0,
    apiKeys: [TEST_KEY],
    driver: createUnavailableDriver({ status: 'no_quota' }),
    // 仅测试：本助手允许用 overrides 换任何驱动器，所以**总是**带上测试令牌。
    // 生产路径拿不到这个 symbol（见下方「fixture 隔离」用例）。
    testOnlyFixtureToken: FIXTURE_TEST_TOKEN,
    logger: {
      info: (/** @type {string} */ line) => logs.push(line),
      warn: (/** @type {string} */ line) => logs.push(line),
      error: (/** @type {string} */ line) => logs.push(line)
    },
    ...overrides
  });
  const started = await server.start();
  if (!started.started || started.port === undefined) {
    throw new Error(`server did not start: ${JSON.stringify(started)}`);
  }
  return { port: started.port, key: TEST_KEY, server, logs };
}

/**
 * 供「model_is_real 推导」与目录用例使用的**真实驱动器桩**。
 *
 * 它不是产品里的真实上游驱动器：产出是本地生成的固定文本，不发任何请求、不接任何官方
 * 进程。存在的唯一目的是证明 `model_is_real` / 目录这两处**确实由驱动器能力推导**，
 * 而不是硬编码 `false`——一个 `ready` + 非 fixture + 列出了模型的驱动器必须拿到
 * `model_is_real: true`。
 *
 * @param {{modelId?: string}} [options]
 * @returns {import('../../packages/api/src/chat.js').ChatDriver}
 */
function createRealStubDriver(options = {}) {
  const modelId = options.modelId ?? 'real-stub-model-1';
  const inner = createFixtureDriver({ modelId });
  return {
    ...inner,
    name: 'real-stub',
    fixture: false,
    statusDetail: '测试桩：本地生成的确定性文本，不是任何真实模型输出',
    models: [{ id: modelId, object: 'model', created: 1_700_000_001, owned_by: 'zcc-real-stub (test only)' }],
    catalog: {
      revision: 'real-stub-rev-1',
      models: [
        {
          modelId,
          displayName: '目录条目（测试桩）',
          provider: 'zcc-real-stub',
          billingClass: 'unknown',
          contextLength: 8192,
          reasoning: [],
          capabilities: ['text']
        }
      ]
    },
    /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
    async *stream(req) {
      yield { type: 'delta', text: `[REAL-STUB] 本地生成的确定性文本（model=${req.model}），不是任何真实模型输出。` };
      yield { type: 'usage', promptTokens: 1, completionTokens: 1, usageMethod: 'real_stub_fixed_count' };
      yield { type: 'finish', reason: 'stop' };
    }
  };
}

/**
 * @param {any} res
 * @returns {string}
 */
function errorCode(res) {
  return String(res.error?.code ?? '');
}

/**
 * 跑一次会抛 `ApiError` 的纯函数，把它**抓成**结构化结果（不抛 = `null`）。
 *
 * 存在的理由：解析期判定（`parseChatRequest`）要能在**不经过 HTTP** 的前提下逐条钉死，
 * 而 `catch` 里的值在 `checkJs` 档是 `{}`——没有这层收口就没法读它的 `code` / `param`。
 *
 * @param {() => unknown} fn
 * @returns {{ code: string, param: string } | null}
 */
function caughtApiError(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    const api = /** @type {{ code?: string, param?: string | null }} */ (err);
    return { code: String(api.code ?? ''), param: String(api.param ?? '') };
  }
}

/* -------------------------------------------------------------------------- */
/* 1. 启用与绑定                                                              */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · 启用与绑定', () => {
  it('默认关闭：enabled 缺省时 start() 不监听任何端口', async () => {
    const server = createApiServer({ apiKeys: [TEST_KEY], driver: createUnavailableDriver({ status: 'no_quota' }) });
    const started = await server.start();
    expect(started.started).toBe(false);
    expect(started.reason).toBe('disabled_by_default');
    expect(server.address()).toBeNull();
    expect(started.port).toBeUndefined();
    await server.stop();
  });

  it('显式开启后只绑 127.0.0.1（不是 0.0.0.0 / ::）', async () => {
    const h = await startServer();
    try {
      const addr = h.server.address();
      expect(addr).not.toBeNull();
      expect(addr?.address).toBe(HOST_LOOPBACK);
      expect(addr?.address).toBe('127.0.0.1');
    } finally {
      await h.server.stop();
    }
  });

  it('非回环绑定地址在构造期即被拒绝（fail-closed）', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      // @ts-expect-error 故意传非回环地址：类型层与运行期都必须拒绝。
      expect(() => createApiServer({ host, apiKeys: [TEST_KEY], driver: createUnavailableDriver({ status: 'no_quota' }) })).toThrow(
        /LOOPBACK_ONLY/
      );
    }
  });

  it('默认端口是固定可照抄的 8790（旧默认 8765 在本机被无关进程常驻占用）', () => {
    expect(DEFAULT_API_PORT).toBe(8790);
    // 8765 不能再是默认值，否则 IDE 照抄配置会撞上那个无关进程。
    expect(DEFAULT_API_PORT).not.toBe(8765);
    expect(createApiServer({ apiKeys: [TEST_KEY], driver: createUnavailableDriver({ status: 'no_quota' }) }).address()).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Host / Origin / CORS                                                     */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · Host / Origin / CORS', () => {
  it('Host 头不是 127.0.0.1:<port> 时 403 host_not_allowed（防 DNS rebinding）', async () => {
    const h = await startServer();
    try {
      const res = await request({ port: h.port, headers: { host: 'evil.example.com', authorization: `Bearer ${h.key}` } });
      expect(res.status).toBe(403);
      expect(errorCode(parseJson(res.text))).toBe('host_not_allowed');
    } finally {
      await h.server.stop();
    }
  });

  it('Host 头端口与实际监听端口不匹配时同样 403', async () => {
    const h = await startServer();
    try {
      const res = await request({ port: h.port, headers: { host: `127.0.0.1:${h.port + 1}`, authorization: `Bearer ${h.key}` } });
      expect(res.status).toBe(403);
      expect(errorCode(parseJson(res.text))).toBe('host_not_allowed');
    } finally {
      await h.server.stop();
    }
  });

  it('没有 Origin 头的普通本机客户端（IDE 扩展）放行', async () => {
    const h = await startServer();
    try {
      const res = await authed({ port: h.port, body: { model: 'any', messages: [{ role: 'user', content: 'hi' }] } });
      expect(res.status).toBe(503);
    } finally {
      await h.server.stop();
    }
  });

  it('Origin 头默认白名单为空：任何 Origin 一律 403 origin_not_allowed', async () => {
    const h = await startServer();
    try {
      const res = await request({
        port: h.port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { authorization: `Bearer ${h.key}`, origin: 'https://evil.example.com' },
        body: { model: 'any', messages: [{ role: 'user', content: 'hi' }] }
      });
      expect(res.status).toBe(403);
      expect(errorCode(parseJson(res.text))).toBe('origin_not_allowed');
    } finally {
      await h.server.stop();
    }
  });

  it('显式把某个 Origin 放进白名单后该 Origin 放行，其他仍 403', async () => {
    const h = await startServer({ allowedOrigins: ['http://localhost:5173'] });
    try {
      const ok = await request({
        port: h.port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { authorization: `Bearer ${h.key}`, origin: 'http://localhost:5173' },
        body: { model: 'any', messages: [{ role: 'user', content: 'hi' }] }
      });
      expect(ok.status).toBe(503);
      const bad = await request({
        port: h.port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { authorization: `Bearer ${h.key}`, origin: 'http://localhost:5174' },
        body: { model: 'any', messages: [{ role: 'user', content: 'hi' }] }
      });
      expect(bad.status).toBe(403);
    } finally {
      await h.server.stop();
    }
  });

  it('CORS 关闭：任何响应都不带 access-control-* 头，OPTIONS 预检 405', async () => {
    const h = await startServer({ allowedOrigins: ['http://localhost:5173'] });
    try {
      const res = await request({
        port: h.port,
        method: 'OPTIONS',
        path: '/v1/chat/completions',
        headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' }
      });
      expect(res.status).toBe(405);
      expect(errorCode(parseJson(res.text))).toBe('method_not_allowed');
      expect(header(res.headers, 'access-control-allow-origin')).toBe('');
      expect(header(res.headers, 'access-control-allow-headers')).toBe('');
      expect(header(res.headers, 'access-control-allow-methods')).toBe('');

      const get = await request({ port: h.port, headers: { authorization: `Bearer ${h.key}`, origin: 'http://localhost:5173' } });
      expect(header(get.headers, 'access-control-allow-origin')).toBe('');
    } finally {
      await h.server.stop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3. 认证                                                                    */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · 认证', () => {
  it('缺少 Authorization 头 401 并给 WWW-Authenticate', async () => {
    const h = await startServer();
    try {
      const res = await request({ port: h.port, method: 'POST', path: '/v1/chat/completions', body: { model: 'a', messages: [] } });
      expect(res.status).toBe(401);
      expect(header(res.headers, 'www-authenticate')).toBe('Bearer');
      expect(errorCode(parseJson(res.text))).toBe('unauthorized');
    } finally {
      await h.server.stop();
    }
  });

  it('非 Bearer 方案与错误 key 都 401', async () => {
    const h = await startServer();
    try {
      const basic = await request({ port: h.port, headers: { authorization: `Basic ${TEST_KEY}` } });
      expect(basic.status).toBe(401);
      const wrong = await authed({ port: h.port, key: 'zcc_not_the_configured_key_at_all_zzzz', body: { model: 'a', messages: [] } });
      expect(wrong.status).toBe(401);
      expect(errorCode(parseJson(wrong.text))).toBe('unauthorized');
    } finally {
      await h.server.stop();
    }
  });

  it('key 不回显：401 响应体、响应头与日志都不含 key 明文；成功请求只留指纹', async () => {
    const wrongKey = 'zcc_attacker_supplied_key_aaaaaaaaaaaaaa';
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await authed({ port: h.port, key: wrongKey, body: { model: FIXTURE_MODEL_ID, messages: [] } });
      expect(res.status).toBe(401);
      expect(res.text).not.toContain(wrongKey);
      expect(JSON.stringify(res.headers)).not.toContain(wrongKey);
      expect(h.logs.join('\n')).not.toContain(wrongKey);
      // 配置的 key 也不得出现在任何日志行里：只允许不可逆指纹。
      const ok = await authed({
        port: h.port,
        headers: { 'x-zcc-session-id': 'echo' },
        body: { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] }
      });
      expect(ok.status).toBe(200);
      expect(h.logs.join('\n')).not.toContain(TEST_KEY);
      expect(h.logs.some((l) => l.includes(fingerprintApiKey(TEST_KEY)))).toBe(true);
    } finally {
      await h.server.stop();
    }
  });

  it('正确 key 放行（无上游时进入 503 分支）', async () => {
    const h = await startServer();
    try {
      const res = await authed({ port: h.port, body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] } });
      expect(res.status).toBe(503);
      expect(header(res.headers, 'x-zcc-status')).toBe('no_quota');
    } finally {
      await h.server.stop();
    }
  });

  it('generateApiKey 产生 zcc_ 前缀的高熵 key，fingerprint 不泄露 key', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.startsWith('zcc_')).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).not.toBe(b);
    const fp = fingerprintApiKey(a);
    expect(fp.startsWith('zcc-fp:')).toBe(true);
    expect(fp).not.toContain(a);
    expect(fingerprintApiKey(a)).toBe(fp);
    expect(verifyApiKey(`Bearer ${a}`, [a]).ok).toBe(true);
    expect(verifyApiKey(`Bearer ${b}`, [a]).ok).toBe(false);
    expect(verifyApiKey('', [a]).ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. 限流                                                                    */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · 限流', () => {
  it('并发超限返回 429，且不排队等待', async () => {
    const h = await startServer({
      rateLimit: { maxConcurrent: 1, requests: 100, windowMs: 60_000 },
      driver: createFixtureDriver({ chunkDelayMs: 60 })
    });
    try {
      const body = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'hi' }] };
      const first = authed({ port: h.port, headers: { 'x-zcc-session-id': 's-conc' }, body });
      await new Promise((r) => setTimeout(r, 15));
      const second = await authed({ port: h.port, headers: { 'x-zcc-session-id': 's-conc2' }, body });
      expect(second.status).toBe(429);
      expect(errorCode(parseJson(second.text))).toBe('rate_limited');
      expect(Number(header(second.headers, 'retry-after'))).toBeGreaterThan(0);
      expect(Number(header(second.headers, 'x-zcc-ratelimit-remaining'))).toBe(0);
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
    } finally {
      await h.server.stop();
    }
  });

  it('速率超限返回 429 并带 Retry-After', async () => {
    const h = await startServer({ rateLimit: { maxConcurrent: 8, requests: 2, windowMs: 60_000 } });
    try {
      const codes = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await request({ port: h.port, headers: { authorization: `Bearer ${h.key}` } });
        codes.push(res.status);
      }
      expect(codes).toEqual([200, 200, 429, 429]);
    } finally {
      await h.server.stop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5. 请求体与 schema                                                         */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · 请求体 schema', () => {
  /**
   * @param {Harness} h
   * @param {any} body
   * @returns {Promise<Res>}
   */
  const post = (h, body) => authed({ port: h.port, headers: { 'x-zcc-session-id': 'schema' }, body });

  /**
   * 每次换一个 `x-zcc-session-id` 的 post。
   *
   * 存在的理由：上面那个 `post` 把所有调用都钉在**同一个**幂等作用域
   * （`'schema'`），所以它适合测"同作用域的行为"，不适合测"每个请求独立"。
   * COMPAT1 那几条要逐条独立，所以这里换一个单调递增的会话号。
   *
   * @param {Harness} h
   * @param {unknown} body
   * @param {Record<string, string>} [extra]
   * @returns {Promise<Res>}
   */
  let schemaSessionSeq = 0;
  const postUnique = (/** @type {Harness} */ h, /** @type {unknown} */ body, /** @type {Record<string, string>} */ extra = {}) =>
    authed({ port: h.port, headers: { 'x-zcc-session-id': `schema-${String((schemaSessionSeq += 1))}`, ...extra }, body });

  it('非法 JSON 返回 400 invalid_json，不是 500', async () => {
    const h = await startServer();
    try {
      const res = await authed({ port: h.port, body: undefined, raw: Buffer.from('{"model": ', 'utf8') });
      expect(res.status).toBe(400);
      expect(errorCode(parseJson(res.text))).toBe('invalid_json');
    } finally {
      await h.server.stop();
    }
  });

  it('未知字段返回 400 unknown_field 并指名，不静默丢弃', async () => {
    const h = await startServer();
    try {
      const res = await post(h, { model: 'm', messages: [{ role: 'user', content: 'hi' }], totally_unknown: 1 });
      expect(res.status).toBe(400);
      const parsed = parseJson(res.text);
      expect(errorCode(parsed)).toBe('unknown_field');
      expect(parsed.error.param).toBe('totally_unknown');
      expect(parsed.error.message).toContain('totally_unknown');
    } finally {
      await h.server.stop();
    }
  });

  it('不支持的 role 返回 422 且不得被压成 user 字符串（COMPAT3：`system`/`developer` 已移出本用例；COMPAT5：`tool` 也已移出）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      // **COMPAT3 的裁定变更**：`system` / `developer` 不再 422（协调者 2026-10-02 裁定：
      // 接受并折叠进 prompt 上下文 + 如实披露 `zcc.roles_folded`）。真客户端 mcode
      // **必然**发 `developer`（`ke()` off 10416 + 缺省 `supportsDeveloperRole:true`），
      // 继续硬拒等于端到端不可用。这条断言因此**只**覆盖仍然被拒的那几个 role。
      // **COMPAT5 的裁定变更**：`tool`（工具结果轮）也不再 422——改走"接受 + 转写成
      // 带前缀的 user 轮"，钉在 tests/unit/api-chat-message-tool-trace.test.mjs。
      // **旧式 `functions` / `function_call` 参数面仍逐条拒**：消息侧放行 `function`
      // 就与 {@link TOP_LEVEL_REJECTED} 里那批同族键自相矛盾，所以本用例仍钉它。
      for (const role of ['function']) {
        const res = await post(h, { model: FIXTURE_MODEL_ID, messages: [{ role, content: 'x' }] });
        expect(res.status, `role=${role}`).toBe(422);
        const parsed = parseJson(res.text);
        expect(errorCode(parsed)).toBe('unsupported_role');
        expect(parsed.error.param).toBe('messages[0].role');
        expect(parsed.error.message).toContain(role);
      }
      // 压成 user 会得到 200 —— 断言它没有发生。
      const ok = await post(h, { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] });
      expect(ok.status).toBe(200);
      // 保持"不接受的一律逐条指名"：大小写变体、空串、未知 role 仍然 422。
      // `Tool`（首字母大写）**不在** COMPAT5 的放开范围内——闭集逐字匹配，不是前缀匹配。
      for (const role of ['Tool', 'TOOL', 'System', 'Developer', '', 'user ', 'assistant ', 'model']) {
        const res = await postUnique(h, { model: FIXTURE_MODEL_ID, messages: [{ role, content: 'x' }] });
        expect(res.status, `role=${JSON.stringify(role)}`).toBe(422);
        expect(errorCode(parseJson(res.text)), role).toBe('unsupported_role');
        expect(parseJson(res.text).error.param, role).toBe('messages[0].role');
      }
    } finally {
      await h.server.stop();
    }
  });

  it('C 类：已知但本端点不支撑的参数返回 422 unsupported_parameter 并指名（COMPAT2 覆盖面**更宽**，COMPAT3 再收两条，COMPAT4 收紧 `tool_choice`）', async () => {
    const h = await startServer();
    try {
      // **2026-10-02（COMPAT2）**：本断言**只**覆盖"仍然被拒"的那一批，且覆盖面
      // 从 COMPAT1 时的 8 个键**扩到 16 个**（新增 prompt_cache_options /
      // moderation / web_search_options，并补回 function_call / functions /
      // tool_choice / parallel_tool_calls / modalities / prediction / audio /
      // top_logprobs / logit_bias 这几条本就在表里但旧断言没覆盖的）。
      // 每一条仍然指名 422，**没有**被放宽。
      // **2026-10-02（COMPAT3）**：`tools` / `tool_choice` 移出本表（空形状被接受），
      // 但 `tools: 1`（非数组）**仍然**422 并指名 `tools` —— 移出的是"整键硬拒"，
      // 不是"不校验"。
      // **2026-10-02（COMPAT4）**：`tools` 的**非空**合法形状也被接受（浅校验 +
      // `zcc.tools_received` / `tools_forwarded` 明示未转发），所以本表里 `tools`
      // **只**钉住"非数组"这一条；`tool_choice` 的 `auto` **由 422 变 200**（它要的
      // 是"模型自己决定调不调"，而我们永不发 `tool_calls` = 那条路线的**下界**，如实
      // 成立），因此下面对象形状那张表里的 `tool_choice` 值从 `'auto'` 换成
      // **`'required'`** —— 要求**必须**调工具，本端点做不到，如实拒。
      for (const key of [
        'tools',
        'response_format',
        'stop',
        'logprobs',
        'logit_bias',
        'top_logprobs',
        'modalities',
        'prediction',
        'audio',
        'web_search_options',
        'prompt_cache_options',
        'moderation'
      ]) {
        /** @type {Record<string, unknown>} */
        const body = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
        body[key] = 1;
        const res = await post(h, body);
        expect(res.status, key).toBe(422);
        const parsed = parseJson(res.text);
        expect(errorCode(parsed)).toBe('unsupported_parameter');
        expect(parsed.error.param).toBe(key);
        expect(parsed.error.message).toContain(key);
      }
      // 对象形状的 C 类字段同样逐条指名（`body[key]=1` 对对象字段不成立）。
      for (const [key, value] of /** @type {Array<[string, unknown]>} */ ([
        ['tool_choice', 'required'],
        ['parallel_tool_calls', true],
        ['function_call', 'auto'],
        ['functions', []],
        ['response_format', { type: 'json_object' }],
        ['stop', ['\n']],
        ['web_search_options', { search_context_size: 'low' }],
        ['prompt_cache_options', { mode: 'explicit' }]
      ])) {
        /** @type {Record<string, unknown>} */
        const body = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }], [key]: value };
        const res = await post(h, body);
        expect(res.status, key).toBe(422);
        expect(errorCode(parseJson(res.text))).toBe('unsupported_parameter');
        expect(parseJson(res.text).error.param, key).toBe(key);
      }
      // `stop` 收下就等于静默丢掉截断语义 —— 拒绝理由必须**说清这一点**。
      const stopMsg = parseJson(
        (await post(h, { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }], stop: ['END'] })).text
      ).error.message;
      expect(stopMsg).toContain('截断');
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT2：`n` 只接受 1 —— 缺席 / null / 1 放行，n>1 与非整数逐条 422 并指名', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // `n:1` 是**如实的 no-op**（客户端要的正是我们唯一给的那个候选）→ 接受。
      const one = await postUnique(h, { ...base, n: 1 });
      expect(one.status).toBe(200);
      expect(parseJson(one.text).choices).toHaveLength(1);
      // 缺席 / null 同样放行。
      expect((await postUnique(h, { ...base, n: null })).status).toBe(200);
      // n>1 = "要多个候选"，收下再只回 1 个就是静默丢数据 → 422。
      for (const bad of [2, 3, 0, -1, 1.5, '1', true, [], {}]) {
        const res = await postUnique(h, { ...base, n: bad });
        expect(res.status, `n=${JSON.stringify(bad)}`).toBe(422);
        const parsed = parseJson(res.text);
        expect(errorCode(parsed)).toBe('unsupported_parameter');
        expect(parsed.error.param).toBe('n');
        expect(parsed.error.message).toContain('1 个候选');
      }
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT2：`store` 接受并**如实披露未转发**（mcode 恒发 `store:false`），非布尔仍 422', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // mcode 对自定义 provider 的缺省 `supportsStore` 恒为 true → 恒发 `store:false`。
      const res = await postUnique(h, { ...base, store: false });
      expect(res.status).toBe(200);
      expect(parseJson(res.text).zcc.parameters_not_forwarded).toContain('store');
      // `store:true` 同样接受（并同样披露）—— 我们从不持久化，必须说出来而不是硬拒。
      const yes = await postUnique(h, { ...base, store: true });
      expect(yes.status).toBe(200);
      expect(parseJson(yes.text).zcc.parameters_not_forwarded).toContain('store');
      // 非布尔仍然 422（接受不等于什么形状都收）。`null` 不在其中——见下一条。
      for (const bad of ['false', 0, 1, {}]) {
        const r = await postUnique(h, { ...base, store: bad });
        expect(r.status, `store=${JSON.stringify(bad)}`).toBe(422);
        expect(parseJson(r.text).error.param).toBe('store');
      }
      // `null` 与缺席同义（OpenAI 把 `store` 声明成 `boolean|null`）：不披露（披露它是噪声）。
      const nul = await postUnique(h, { ...base, store: null });
      expect(nul.status).toBe(200);
      expect(parseJson(nul.text).zcc.parameters_not_forwarded).toEqual([]);
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT2：A 类全表逐字段接受 + 披露，非法值逐条 422 并指名（逐字段红绿）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      /** @type {Array<[string, unknown]>} */
      const accepted = [
        ['seed', 12345],
        ['presence_penalty', -2],
        ['frequency_penalty', 2],
        ['service_tier', 'priority'],
        ['verbosity', 'high'],
        ['prompt_cache_key', 'sess-abc'],
        ['prompt_cache_retention', '24h'],
        ['safety_identifier', 'user-1']
      ];
      for (const [key, value] of accepted) {
        const res = await postUnique(h, { ...base, [key]: value });
        expect(res.status, `${key}=${JSON.stringify(value)}`).toBe(200);
        expect(parseJson(res.text).zcc.parameters_not_forwarded, key).toContain(key);
      }
      // 闭集边界值逐条接受（闭区间 / 完整闭集）。
      for (const [key, value] of /** @type {Array<[string, unknown]>} */ ([
        ['presence_penalty', 0],
        ['frequency_penalty', 0],
        ['service_tier', 'auto'],
        ['service_tier', 'fast'],
        ['verbosity', 'low'],
        ['verbosity', 'medium'],
        ['prompt_cache_retention', 'in_memory'],
        ['seed', 0]
      ])) {
        const res = await postUnique(h, { ...base, [key]: value });
        expect(res.status, `${key}=${JSON.stringify(value)} 边界`).toBe(200);
      }
      // 非法值逐条 422 + 指名 +（闭集类）**列出合法值**。
      /** @type {Array<[string, unknown, string[]]>} */
      const rejected = [
        ['seed', 1.5, []],
        ['seed', -1, []],
        ['seed', 2_147_483_648, []],
        ['seed', '7', []],
        ['presence_penalty', -2.1, []],
        ['presence_penalty', 2.1, []],
        ['frequency_penalty', -2.1, []],
        ['frequency_penalty', 2.1, []],
        ['service_tier', 'gold', ['auto', 'default', 'flex', 'scale', 'priority', 'fast']],
        ['service_tier', 1, ['auto']],
        ['verbosity', 'ultra', ['low', 'medium', 'high']],
        ['prompt_cache_retention', '7d', ['in_memory', '24h']],
        ['prompt_cache_key', '', []],
        ['prompt_cache_key', 'x'.repeat(65), []],
        ['safety_identifier', 1, []]
      ];
      for (const [key, value, legal] of rejected) {
        const res = await postUnique(h, { ...base, [key]: value });
        expect(res.status, `${key}=${JSON.stringify(value)}`).toBe(422);
        const parsed = parseJson(res.text);
        expect(errorCode(parsed), key).toBe('unsupported_parameter');
        expect(parsed.error.param, key).toBe(key);
        for (const l of legal) expect(parsed.error.message, `${key} 必须列出 ${l}`).toContain(l);
      }
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT2：`max_completion_tokens` 与 `max_tokens` 同一个槽位，且真的**生效**（驱动侧可观测）', async () => {
    /** @type {Array<number | null>} */
    const seen = [];
    const inner = createFixtureDriver();
    const driver = {
      ...inner,
      /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
      stream(req) {
        seen.push(req.maxTokens);
        return inner.stream(req);
      }
    };
    const h = await startServer({ driver });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // **这是真客户端必发的键**：mcode 对自定义 provider 缺省发 `max_completion_tokens`。
      expect((await postUnique(h, { ...base, max_completion_tokens: 8 })).status).toBe(200);
      expect((await postUnique(h, { ...base, max_tokens: 8 })).status).toBe(200);
      // 同一个槽位：两个键生效的值必须**逐字相等**。
      expect(seen).toEqual([8, 8]);
      // 都不发 → null（不猜一档）。
      expect((await postUnique(h, base)).status).toBe(200);
      expect(seen).toEqual([8, 8, null]);
      // 缺席时 `parameters_not_forwarded` 恒为空数组。
      expect(parseJson((await postUnique(h, base)).text).zcc.parameters_not_forwarded).toEqual([]);      // 两个键同时给且**相同** → 接受（不挑、不折中）。
      expect((await postUnique(h, { ...base, max_tokens: 4, max_completion_tokens: 4 })).status).toBe(200);
      // 同时给且**不同** → 422 并指名两个键（替用户挑一个就是替他做决定）。
      const conflict = await postUnique(h, { ...base, max_tokens: 4, max_completion_tokens: 9 });
      expect(conflict.status).toBe(422);
      const parsed = parseJson(conflict.text);
      expect(errorCode(parsed)).toBe('unsupported_parameter');
      expect(parsed.error.message).toContain('max_tokens');
      expect(parsed.error.message).toContain('max_completion_tokens');
      // 越界与非整数**逐条**按各自分支报错：形状非法是 400 `invalid_request`
      // （与既有 `max_tokens` 行为逐字一致，不为新键换一套错误码）。
      // 2026-10-10 起超额（>32768）不再 400 而是钳制+披露（见下一条用例），本循环只留真畸形。
      for (const [key, value] of /** @type {Array<[string, unknown]>} */ ([
        ['max_completion_tokens', 1.5],
        ['max_completion_tokens', -1],
        ['max_completion_tokens', '8'],
      ])) {
        const res = await postUnique(h, { ...base, [key]: value });
        expect(res.status, `${key}=${JSON.stringify(value)}`).toBe(400);
        expect(errorCode(parseJson(res.text)), key).toBe('invalid_request');
        expect(parseJson(res.text).error.param, key).toBe(key);
      }
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT2：上限超额**钳制到 32768** 并经 `zcc.max_tokens_clamped_*` 披露（mcode 不尊重 limit.output 的真客户端兼容）', async () => {
    /** @type {Array<number | null>} */
    const seen = [];
    const inner = createFixtureDriver();
    const driver = {
      ...inner,
      /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
      stream(req) {
        seen.push(req.maxTokens);
        return inner.stream(req);
      }
    };
    const h = await startServer({ driver });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // 真客户端实测（2026-10-10 抓包）：mcode 对 BYOK 条目忽略 `limit.output`，
      // 按 128000 发 `max_completion_tokens` → 钳到 32768 放行，驱动收到的就是 32768。
      const res = await postUnique(h, { ...base, max_completion_tokens: 128_000 });
      expect(res.status).toBe(200);
      expect(seen).toEqual([32_768]);
      const zcc = parseJson(res.text).zcc;
      expect(zcc.max_tokens_clamped_from).toBe(128_000);
      expect(zcc.max_tokens_clamped_to).toBe(32_768);
      // 未钳制 → 两个键**缺席**（不是 null）。
      const plain = parseJson((await postUnique(h, { ...base, max_completion_tokens: 8 })).text).zcc;
      expect('max_tokens_clamped_from' in plain).toBe(false);
      expect('max_tokens_clamped_to' in plain).toBe(false);
      // 旧键同样享受钳制（同一槽位）；中间的 8 证明未超额不动。
      expect((await postUnique(h, { ...base, max_tokens: 65_536 })).status).toBe(200);
      expect(seen).toEqual([32_768, 8, 32_768]);
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT2：`metadata` / `user` 补上披露（此前被**静默丢弃**），`stream_options.include_obfuscation` 接受 + 披露', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // **`DriverRequest` 上没有这两个字段** —— 它们从来就只是"收下"。既然收下，就必须说出来。
      expect(parseJson((await postUnique(h, { ...base, metadata: { a: 'b' } })).text).zcc.parameters_not_forwarded).toContain('metadata');
      expect(parseJson((await postUnique(h, { ...base, user: 'u-1' })).text).zcc.parameters_not_forwarded).toContain('user');
      // 顺序固定：A 类表键序 → 内置键序（metadata → user）→ stream_options.include_obfuscation。
      const all = parseJson(
        (
          await postUnique(h, {
            ...base,
            metadata: { a: 'b' },
            user: 'u-1',
            stream_options: { include_usage: true, include_obfuscation: true }
          })
        ).text
      );
      expect(all.zcc.parameters_not_forwarded).toEqual(['metadata', 'user', 'stream_options.include_obfuscation']);
      // `include_obfuscation:false` 同样披露（键在就在，不猜它的意图）。
      expect(
        parseJson((await postUnique(h, { ...base, stream_options: { include_obfuscation: false } })).text).zcc.parameters_not_forwarded
      ).toEqual(['stream_options.include_obfuscation']);
      // `include_obfuscation` 非布尔仍拒（400 `invalid_request`，与 `include_usage` 逐字一致）。
      const bad = await postUnique(h, { ...base, stream_options: { include_obfuscation: 'yes' } });
      expect(bad.status).toBe(400);
      expect(errorCode(parseJson(bad.text))).toBe('invalid_request');
      expect(parseJson(bad.text).error.param).toBe('stream_options.include_obfuscation');
      // `stream_options` 里**未知**的子键仍然 422（未知子键不因为这次推广就放行）。
      const unknown = await postUnique(h, { ...base, stream_options: { include_zzz: true } });
      expect(unknown.status).toBe(422);
      expect(parseJson(unknown.text).error.param).toBe('stream_options.include_zzz');
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT2：`stream_options.include_usage` 真的按 OpenAI 惯例多发一帧 usage（choices 为空数组）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }], stream: true };
      /**
       * @param {string} text
       * @returns {Array<{ choices: unknown, usage?: { prompt_tokens: number, completion_tokens: number, total_tokens: number } }>}
       */
      const frames = (text) =>
        text
          .split('\n\n')
          .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
          .map((line) => JSON.parse(line.slice('data: '.length)));
      const withUsage = frames((await postUnique(h, { ...base, stream_options: { include_usage: true } })).text);
      const last = withUsage[withUsage.length - 1];
      // OpenAI 惯例：usage 单独一帧，`choices` 为空数组。
      expect(last).toBeDefined();
      expect(last?.choices).toEqual([]);
      expect(last?.usage?.prompt_tokens).toBeGreaterThan(0);
      expect(last?.usage?.completion_tokens).toBeGreaterThan(0);
      expect(last?.usage?.total_tokens).toBe((last?.usage?.prompt_tokens ?? 0) + (last?.usage?.completion_tokens ?? 0));
      // 不发 stream_options → **没有** usage 帧（不能无条件发）。
      const without = frames((await postUnique(h, base)).text);
      expect(without[without.length - 1]?.usage).toBeUndefined();
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT2：`max_completion_tokens` / `max_tokens` 同一个槽位；**能不能生效由驱动器自报**并如实披露', async () => {
    /** @type {Array<number | null>} */
    const seen = [];
    /** @type {(name: string, fixture: boolean) => import('../../packages/api/src/chat.js').ChatDriver} */
    const wrap = (name, fixture) => {
      const inner = createFixtureDriver();
      return {
        ...inner,
        name,
        fixture,
        ...(fixture ? {} : { enforcesMaxTokens: false }),
        /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
        stream(req) {
          seen.push(req.maxTokens);
          return inner.stream(req);
        }
      };
    };
    // 声明"会强制执行"的驱动器：上限**生效**，不披露（披露一个生效了的参数是噪声）。
    const enforcing = await startServer({ driver: wrap('enforcing-stub', true) });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      const res = await postUnique(enforcing, { ...base, max_completion_tokens: 8 });
      expect(res.status).toBe(200);
      const zcc = parseJson(res.text).zcc;
      expect(seen).toEqual([8]);
      expect(zcc.max_tokens_enforced).toBe(true);
      expect(zcc.parameters_not_forwarded).not.toContain('max_completion_tokens');
      expect(zcc.parameters_not_forwarded).not.toContain('max_tokens');
      // 两个键都没发 → 不披露、也不谎报"已强制执行"。
      const none = await postUnique(enforcing, base);
      expect(none.status).toBe(200);
      expect(parseJson(none.text).zcc.max_tokens_enforced).toBe(false);
      expect(parseJson(none.text).zcc.parameters_not_forwarded).toEqual([]);
    } finally {
      await enforcing.server.stop();
    }
    // 声明"不强制执行"的驱动器：按客户端**实际发来的键名**披露。
    const notEnforcing = await startServer({ driver: wrap('plain-stub', false) });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      const modern = parseJson((await postUnique(notEnforcing, { ...base, max_completion_tokens: 8 })).text).zcc;
      expect(modern.max_tokens_enforced).toBe(false);
      expect(modern.parameters_not_forwarded).toEqual(['max_completion_tokens']);
      const legacy = parseJson((await postUnique(notEnforcing, { ...base, max_tokens: 8 })).text).zcc;
      expect(legacy.max_tokens_enforced).toBe(false);
      expect(legacy.parameters_not_forwarded).toEqual(['max_tokens']);
      // 两个键都给且相同：数值仍然生效（驱动侧可见），披露取先出现的那个键名。
      const both = parseJson((await postUnique(notEnforcing, { ...base, max_tokens: 8, max_completion_tokens: 8 })).text).zcc;
      expect(both.parameters_not_forwarded).toEqual(['max_tokens']);
      expect(seen).toEqual([8, null, 8, 8, 8]);
    } finally {
      await notEnforcing.server.stop();
    }
  });

  it('COMPAT2：上限进幂等 bodyHash（`max_completion_tokens` 与 `max_tokens` 同值 = 同一操作）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    /** @param {Record<string, unknown>} body @param {string} session */
    const postAs = (body, session) =>
      authed({ port: h.port, headers: { 'x-zcc-session-id': session }, body });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      const first = await postAs({ ...base, max_completion_tokens: 8 }, 'mt');
      expect(first.status).toBe(200);
      // 同一个上限、换个键名 → 语义相同 → **重放**而不是 409。
      const replay = await postAs({ ...base, max_tokens: 8 }, 'mt');
      expect(replay.status).toBe(200);
      expect(header(replay.headers, 'x-zcc-idempotency')).toBe('replayed');
      // 换上限 → 不同操作 → 409（不能把两次不同的操作当同一次重放）。
      const conflict = await postAs({ ...base, max_completion_tokens: 9 }, 'mt');
      expect(conflict.status).toBe(409);
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT2：未知顶层字段仍然 400 `unknown_field`（A 类推广**没有**把兜底门拆掉）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      for (const key of ['tool_stream', 'providerOptions', 'provider', 'prompt_cache', 'verbositys', 'stoer', 'max_completion_token']) {
        const res = await postUnique(h, { ...base, [key]: 1 });
        expect(res.status, key).toBe(400);
        expect(errorCode(parseJson(res.text)), key).toBe('unknown_field');
        expect(parseJson(res.text).error.param, key).toBe(key);
      }
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT1/C2：`reasoning_effort` 闭集内三档**放行**，闭集外（含 OpenAI 的 medium/minimal）422 并列合法值', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      for (const level of REASONING_EFFORT_LEVELS) {
        const res = await postUnique(h, { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }], reasoning_effort: level });
        expect(res.status, level).toBe(200);
        expect(parseJson(res.text).zcc.reasoning_effort_applied).toBe(level);
      }
      // **闭集外一律 422**，且**必须列出合法值**——让客户端能自己纠正，
      // 而不是让它对着 "invalid" 去猜。OpenAI 的两个档位逐条钉死。
      for (const bad of ['medium', 'minimal', 'LOW', 'none', 'yolo', '']) {
        const res = await postUnique(h, { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }], reasoning_effort: bad });
        expect(res.status, `reasoning_effort=${JSON.stringify(bad)}`).toBe(422);
        const parsed = parseJson(res.text);
        expect(errorCode(parsed)).toBe('unsupported_parameter');
        expect(parsed.error.param).toBe('reasoning_effort');
        for (const level of REASONING_EFFORT_LEVELS) {
          expect(parsed.error.message, `message 必须列出 ${level}`).toContain(level);
        }
      }
      // 非字符串同样 422（不猜、不折中）
      for (const bad of [1, 0, true, {}, []]) {
        const res = await postUnique(h, { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }], reasoning_effort: bad });
        expect(res.status, JSON.stringify(bad)).toBe(422);
        expect(parseJson(res.text).error.param).toBe('reasoning_effort');
      }
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT1/C2：客户端没发 `reasoning_effort` 时如实报 `null`（= 用驱动器缺省，不猜一档）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await postUnique(h, { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] });
      expect(res.status).toBe(200);
      expect(parseJson(res.text).zcc.reasoning_effort_applied).toBeNull();
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT1/C2：请求级档位逐字进 `DriverRequest.reasoning`，缺席时**键都不出现**', async () => {
    /** @type {Array<Record<string, unknown> | string>} */
    const seen = [];
    const inner = createFixtureDriver();
    const driver = {
      ...inner,
      /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
      stream(req) {
        seen.push(Object.prototype.hasOwnProperty.call(req, 'reasoning') ? { reasoning: req.reasoning } : 'no-reasoning-key');
        return inner.stream(req);
      }
    };
    const h = await startServer({ driver });
    try {
      const body = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      expect((await postUnique(h, { ...body, reasoning_effort: 'low' })).status).toBe(200);
      expect((await postUnique(h, { ...body, reasoning_effort: 'max' })).status).toBe(200);
      expect((await postUnique(h, body)).status).toBe(200);
      expect(seen).toEqual([{ reasoning: 'low' }, { reasoning: 'max' }, 'no-reasoning-key']);
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT1/C3：`temperature` / `top_p` 接受但**如实标注未转发**，非法值仍 422', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // 不发 → 恒为空数组（**恒在场**，客户端不读文档也知道去哪儿看）
      expect(parseJson((await postUnique(h, base)).text).zcc.parameters_not_forwarded).toEqual([]);
      // 合法值 → 放行 + 逐名标注
      const both = parseJson((await postUnique(h, { ...base, temperature: 0.7, top_p: 0.9 })).text);
      expect(both.zcc.parameters_not_forwarded).toEqual(['temperature', 'top_p']);
      // 边界值仍然接受（闭区间）
      for (const value of [0, 2]) {
        const res = await postUnique(h, { ...base, temperature: value });
        expect(res.status, `temperature=${value}`).toBe(200);
        expect(parseJson(res.text).zcc.parameters_not_forwarded).toEqual(['temperature']);
      }
      for (const value of [0, 1]) {
        const res = await postUnique(h, { ...base, top_p: value });
        expect(res.status, `top_p=${value}`).toBe(200);
        expect(parseJson(res.text).zcc.parameters_not_forwarded).toEqual(['top_p']);
      }
      // 非法值仍 422，并指名
      /** @type {Array<[string, unknown]>} */
      const bads = [
        ['temperature', -0.1],
        ['temperature', 2.1],
        ['temperature', 'high'],
        ['top_p', -0.1],
        ['top_p', 1.1]
      ];
      for (const [key, bad] of bads) {
        const res = await postUnique(h, { ...base, [key]: bad });
        expect(res.status, `${key}=${String(bad)}`).toBe(422);
        const parsed = parseJson(res.text);
        expect(errorCode(parsed)).toBe('unsupported_parameter');
        expect(parsed.error.param).toBe(key);
      }
      // **COMPAT2 语义修正**：`null` 不再是"畸形值"。
      // OpenAI 把 `temperature` / `top_p` / `seed` / `store` … 逐条声明成 `T | null`，
      // 所以 `null` = "客户端没有这个偏好"，与缺席同义：接受，且**不**进披露表。
      // （`Number.NaN` / `Infinity` 也**到不了**这条分支：`JSON.stringify` 把它们
      //  序列化成 `null`，所以线上永远只会看到 `null`。非有限数那条防线改由下面
      //  直接调 `parseChatRequest` 的进程内断言守住——见下一条用例。）
      for (const key of /** @type {const} */ (['temperature', 'top_p'])) {
        const res = await postUnique(h, { ...base, [key]: null });
        expect(res.status, `${key}=null`).toBe(200);
        expect(parseJson(res.text).zcc.parameters_not_forwarded, key).toEqual([]);
      }
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT2：非有限数值仍被拒（进程内直调 `parseChatRequest`，守住线上表达不了的那一段）', () => {
    // 为什么要进程内直调：`JSON.stringify({temperature: NaN})` 逐字等于
    // `{"temperature":null}`，所以 `NaN` / `Infinity` **永远到不了** HTTP 那条路。
    // `assertNotForwarded` 里的 `!Number.isFinite` 是给"未来有人不经 JSON 直接调
    // 解析器"留的防线；不钉它，它就会变成一段没人验证过的死代码。
    const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const key of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty']) {
        expect(() => parseChatRequest({ ...base, [key]: bad }), `${key}=${String(bad)}`).toThrow();
      }
    }
    // 合法有限值逐条通过（钉住"不是无条件抛"这一半）。
    for (const [key, value] of /** @type {Array<[string, number]>} */ ([
      ['temperature', 0],
      ['temperature', 2],
      ['top_p', 1],
      ['presence_penalty', -2],
      ['frequency_penalty', 2]
    ])) {
      expect(parseChatRequest({ ...base, [key]: value }).parametersNotForwarded, key).toEqual([key]);
    }
  });

  it('COMPAT1/C2：档位进了幂等 bodyHash（换档 = 409），而未转发的 `temperature` 不进（同体重放）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // 显式 opt-in 幂等（同一会话 = 同一作用域），下面三条必须落在**同一个**作用域里。
      const fixed = (/** @type {Record<string, unknown>} */ body) =>
        authed({ port: h.port, headers: { 'x-zcc-session-id': 'reasoning-hash' }, body });
      // 先用一个合法 body 占住这个幂等作用域…
      const ok = await fixed({ ...base, reasoning_effort: 'low', temperature: 0.5 });
      expect(ok.status).toBe(200);
      expect(parseJson(ok.text).zcc.reasoning_effort_applied).toBe('low');
      // …再用一个**同作用域、只换档位**的 body：必须 409 而不是被重放。
      // 漏掉这一条就等于 `reasoning_effort` 是一条"改了也不算数"的静默参数。
      const conflict = await fixed({ ...base, reasoning_effort: 'high', temperature: 0.5 });
      expect(conflict.status).toBe(409);
      expect(errorCode(parseJson(conflict.text))).toBe('idempotency_conflict');
      // 而 `temperature` **不在** bodyHash 里：同作用域、只改 temperature → 重放
      // （它"未转发"、不改变产出，重放同一份是诚实的）。
      const replay = await fixed({ ...base, reasoning_effort: 'low', temperature: 0.9 });
      expect(replay.status).toBe(200);
      expect(header(replay.headers, 'x-zcc-idempotency')).toBe('replayed');
    } finally {
      await h.server.stop();
    }
  });

  it('message 上的未知字段 422；多模态 part 改占位放行（2026-10-10，附件会话不再死锁）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const named = await postUnique(h, { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x', name: 'bob' }] });
      expect(named.status).toBe(422);
      expect(errorCode(parseJson(named.text))).toBe('unsupported_parameter');
      expect(parseJson(named.text).error.param).toBe('messages[0].name');

      // image_url / input_image 分段 → 占位文本进 prompt，请求放行（200）。
      // 原值（data URL 等）绝不进占位——只留类型名，且文本里可见"图没进上下文"。
      const image = await postUnique(h, {
        model: FIXTURE_MODEL_ID,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]
      });
      expect(image.status).toBe(200);
      const seen = parseJson(image.text).choices?.[0]?.message?.content;
      expect(typeof seen === 'string' ? seen : '').toContain('image_url 未纳入上下文');

      // 混合分段：text 保留、占位插在原位。
      const mixed = await postUnique(h, {
        model: FIXTURE_MODEL_ID,
        messages: [{ role: 'user', content: [{ type: 'text', text: '看图：' }, { type: 'input_image', image_url: 'x' }] }]
      });
      expect(mixed.status).toBe(200);
      expect(parseJson(mixed.text).choices[0].message.content).toContain('看图：[input_image 未纳入上下文：本端点为纯文本，该分段已省略]');

      // type 非字符串（畸形）仍 422——占位只救合法形态。
      const broken = await postUnique(h, {
        model: FIXTURE_MODEL_ID,
        messages: [{ role: 'user', content: [{ type: 7 }] }]
      });
      expect(broken.status).toBe(422);
      expect(errorCode(parseJson(broken.text))).toBe('unsupported_content_type');
    } finally {
      await h.server.stop();
    }
  });

  it('结构性错误（缺 model / messages 非数组 / stream 非布尔）返回 400 invalid_request', async () => {
    const h = await startServer();
    try {
      const noModel = await postUnique(h, { messages: [{ role: 'user', content: 'x' }] });
      expect(noModel.status).toBe(400);
      expect(errorCode(parseJson(noModel.text))).toBe('invalid_request');

      const badMessages = await postUnique(h, { model: 'm', messages: 'hi' });
      expect(badMessages.status).toBe(400);

      const badStream = await postUnique(h, { model: 'm', messages: [{ role: 'user', content: 'x' }], stream: 'yes' });
      expect(badStream.status).toBe(400);
      expect(parseJson(badStream.text).error.param).toBe('stream');

      const bodyArray = await post(h, [1, 2, 3]);
      expect(bodyArray.status).toBe(400);
    } finally {
      await h.server.stop();
    }
  });

  it('声明 content-length 超限返回 413 payload_too_large', async () => {
    const h = await startServer();
    try {
      const res = await request({
        port: h.port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { authorization: `Bearer ${h.key}`, 'content-type': 'application/json' },
        raw: Buffer.from('x'.repeat(REQUEST_BODY_MAX_BYTES + 1), 'utf8')
      });
      expect(res.status).toBe(413);
      expect(errorCode(parseJson(res.text))).toBe('payload_too_large');
    } finally {
      await h.server.stop();
    }
  });

  it('chunked 无 content-length 的超限请求同样 413', async () => {
    const h = await startServer();
    try {
      const res = await request({
        port: h.port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { authorization: `Bearer ${h.key}`, 'content-type': 'application/json' },
        raw: Buffer.from('y'.repeat(REQUEST_BODY_MAX_BYTES + 1), 'utf8'),
        chunked: true
      });
      expect(res.status).toBe(413);
      expect(errorCode(parseJson(res.text))).toBe('payload_too_large');
    } finally {
      await h.server.stop();
    }
  });

  it('metadata 超过 64KiB 返回 413', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const ok = await post(h, { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }], metadata: { note: 'a' } });
      expect(ok.status).toBe(200);
      const big = await post(h, {
        model: FIXTURE_MODEL_ID,
        messages: [{ role: 'user', content: 'y' }],
        metadata: { note: 'a'.repeat(METADATA_MAX_BYTES + 1) }
      });
      expect(big.status).toBe(413);
      expect(parseJson(big.text).error.param).toBe('metadata');
    } finally {
      await h.server.stop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5b. COMPAT3：`system`/`developer` 折叠 + `tools:[]` / `tool_choice:"none"`   */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · COMPAT3 指令 role 折叠 / 空工具形状', () => {
  /**
   * 每次换一个 `x-zcc-session-id` 的 post（同 describe 内既有 helper 的理由：
   * 幂等作用域不能复用，否则"同作用域不同 body"会变成 409 而不是本用例要测的判定）。
   *
   * @param {Harness} h
   * @param {unknown} body
   * @param {Record<string, string>} [extra]
   * @returns {Promise<Res>}
   */
  let seq = 0;
  const postUnique = (/** @type {Harness} */ h, /** @type {unknown} */ body, /** @type {Record<string, string>} */ extra = {}) =>
    authed({ port: h.port, headers: { 'x-zcc-session-id': `c3-${String((seq += 1))}`, ...extra }, body });

  it('COMPAT3：`system` / `developer` 被接受，且逐名进 `zcc.roles_folded`（恒在场）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const user = { role: 'user', content: 'x' };
      // 无折叠 → 恒在场、**空数组**（口径与 `parameters_not_forwarded` 一致）。
      expect(parseJson((await postUnique(h, { model: FIXTURE_MODEL_ID, messages: [user] })).text).zcc.roles_folded).toEqual([]);
      // 逐个 role 逐条接受 + 逐条披露（mcode 恒发的是 `developer`）。
      const dev = parseJson(
        (await postUnique(h, { model: FIXTURE_MODEL_ID, messages: [{ role: 'developer', content: 'sys' }, user] })).text
      );
      expect(dev.choices[0].message.content).toContain('[FIXTURE');
      expect(dev.zcc.roles_folded).toEqual(['developer']);
      const sys = parseJson(
        (await postUnique(h, { model: FIXTURE_MODEL_ID, messages: [{ role: 'system', content: 'sys' }, user] })).text
      );
      expect(sys.zcc.roles_folded).toEqual(['system']);
      // 两个都在：**按首次出现序**、不因为接受表顺序而重排。
      const both = parseJson(
        (
          await postUnique(h, {
            model: FIXTURE_MODEL_ID,
            messages: [{ role: 'system', content: 'a' }, { role: 'developer', content: 'b' }, user]
          })
        ).text
      );
      expect(both.zcc.roles_folded).toEqual(['system', 'developer']);
      const reversed = parseJson(
        (
          await postUnique(h, {
            model: FIXTURE_MODEL_ID,
            messages: [{ role: 'developer', content: 'b' }, { role: 'system', content: 'a' }, user]
          })
        ).text
      );
      expect(reversed.zcc.roles_folded).toEqual(['developer', 'system']);
      // **去重**：同一个 role 出现多次只报一次（披露的是"折叠了哪些 role"，不是几条消息）。
      const dup = parseJson(
        (
          await postUnique(h, {
            model: FIXTURE_MODEL_ID,
            messages: [{ role: 'developer', content: 'a' }, user, { role: 'developer', content: 'b' }]
          })
        ).text
      );
      expect(dup.zcc.roles_folded).toEqual(['developer']);
      // `roles_folded` 与 `parameters_not_forwarded` **互不相干**：折叠不是"没转发参数"。
      expect(dup.zcc.parameters_not_forwarded).toEqual([]);
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT3：折叠在**驱动侧**真的发生，且行格式与多轮折叠逐字相同、原顺序保留', async () => {
    /** @type {string[]} */
    const prompts = [];
    const inner = createFixtureDriver();
    const driver = {
      ...inner,
      /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
      stream(req) {
        // 驱动器**收到**的仍然是带 role 的消息（没有被改名成 user）。
        prompts.push(foldMessagesToPrompt(req.messages));
        return inner.stream(req);
      }
    };
    const h = await startServer({ driver });
    try {
      const messages = [
        { role: 'developer', content: '你是助手' },
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'system', content: '补充约束' },
        { role: 'user', content: '第二问' }
      ];
      const res = await postUnique(h, { model: FIXTURE_MODEL_ID, messages });
      expect(res.status).toBe(200);
      // 折叠后的 prompt 与**多轮折叠逐字同一机制**：每条消息一行 `role: content`。
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toBe(
        'developer: 你是助手\nuser: 第一问\nassistant: 第一答\nsystem: 补充约束\nuser: 第二问'
      );
      // 开头的指令轮落在 prompt **第一行**（客户端按 OpenAI 惯例把它放前面）。
      expect(prompts[0]?.split('\n')[0]).toBe('developer: 你是助手');
      // 顺序**原样保留**：中间那条 system 没有被偷偷提到前面（提序也是一种静默改写）。
      expect(prompts[0]?.indexOf('system: 补充约束')).toBeGreaterThan(prompts[0]?.indexOf('assistant: 第一答') ?? -1);
      // 折叠函数本身逐字钉死（两个驱动器共用它，不允许各自实现）。
      expect(foldMessagesToPrompt([{ role: 'user', content: 'a' }])).toBe('user: a');
      expect(foldMessagesToPrompt([])).toBe('');
      expect(
        foldMessagesToPrompt([
          { role: 'system', content: 'S' },
          { role: 'user', content: 'U' }
        ])
      ).toBe('system: S\nuser: U');
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT3：驱动侧 `DriverRequest.messages` 保留原 role（**不**被改名成 user）', async () => {
    /** @type {Array<Array<{ role: string; content: string }>>} */
    const seen = [];
    const inner = createFixtureDriver();
    const driver = {
      ...inner,
      /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
      stream(req) {
        seen.push(req.messages.map((m) => ({ role: m.role, content: m.content })));
        return inner.stream(req);
      }
    };
    const h = await startServer({ driver });
    try {
      const res = await postUnique(h, {
        model: FIXTURE_MODEL_ID,
        messages: [
          { role: 'developer', content: 'sys' },
          { role: 'user', content: 'hi' }
        ]
      });
      expect(res.status).toBe(200);
      expect(seen).toEqual([
        [
          { role: 'developer', content: 'sys' },
          { role: 'user', content: 'hi' }
        ]
      ]);
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT3：折叠 role 进幂等 bodyHash（改了 system 内容 = 另一条操作）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    const as = (/** @type {unknown} */ body, /** @type {string} */ session) =>
      authed({ port: h.port, headers: { 'x-zcc-session-id': session }, body });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // 逐字相同的重放 → 同一次操作。
      const first = await as({ ...base, messages: [{ role: 'system', content: 'A' }, { role: 'user', content: 'x' }] }, 'c3idem');
      expect(first.status).toBe(200);
      const replay = await as({ ...base, messages: [{ role: 'system', content: 'A' }, { role: 'user', content: 'x' }] }, 'c3idem');
      expect(replay.status).toBe(200);
      expect(header(replay.headers, 'x-zcc-idempotency')).toBe('replayed');
      // 折叠出来的 prompt 内容变了 = 换了操作 → 409（不能当重放）。
      const changed = await as({ ...base, messages: [{ role: 'system', content: 'B' }, { role: 'user', content: 'x' }] }, 'c3idem');
      expect(changed.status).toBe(409);
      // role 变了（system → developer）同样不是同一次操作：折叠出的行标签逐字不同。
      const roleChanged = await as({ ...base, messages: [{ role: 'developer', content: 'A' }, { role: 'user', content: 'x' }] }, 'c3idem');
      expect(roleChanged.status).toBe(409);
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT3 建立 / COMPAT4 放宽后：`tools` 的数组壳与浅校验形状逐条判定', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // **真客户端形状**：mcode 恢复过工具调用的旧会话时逐字发 `tools:[]`。
      const empty = await postUnique(h, { ...base, tools: [] });
      expect(empty.status).toBe(200);
      // 空数组**不进** `parameters_not_forwarded`：转发空数组与不转发语义相同，披露它是噪声。
      expect(parseJson(empty.text).zcc.parameters_not_forwarded).toEqual([]);
      // 缺席 = 没有工具（与 `[]` 同义，不披露）。
      expect((await postUnique(h, base)).status).toBe(200);

      // **COMPAT4 裁定变更**：`tools` 非空**不再**是"语义改变"，所以合法形状由 422
      // 变 200，并逐条按实际条数披露（明细见下一 describe「COMPAT4 工具声明未转发」）。
      // 本用例**只**钉仍然成立的那一半：**浅校验之后**的形状逐条指名。
      for (const [tools, param] of /** @type {Array<[unknown, string]>} */ ([
        [[{}], 'tools[0]'],
        [[null], 'tools[0]'],
        [['x'], 'tools[0]'],
        [[1], 'tools[0]'],
        [[{ name: 'f' }], 'tools[0]'],
        [[{ type: 'function', function: { name: 'f' } }, {}], 'tools[1]']
      ])) {
        const res = await postUnique(h, { ...base, tools });
        expect(res.status, `tools=${JSON.stringify(tools)}`).toBe(422);
        const parsed = parseJson(res.text);
        expect(errorCode(parsed), `tools=${JSON.stringify(tools)}`).toBe('unsupported_parameter');
        expect(parsed.error.param, `tools=${JSON.stringify(tools)}`).toBe(param);
      }
      // 非数组（含 `null`）逐条 422 指名 `tools`：`null` **不**等于空数组
      // （OpenAI 没有把 `tools` 声明成可空；它是结构字段，与 `messages` / `stream` 同族）。
      for (const tools of [null, {}, 1, 'none', true, false]) {
        const res = await postUnique(h, { ...base, tools });
        expect(res.status, `tools=${JSON.stringify(tools)}`).toBe(422);
        const parsed = parseJson(res.text);
        expect(errorCode(parsed), `tools=${JSON.stringify(tools)}`).toBe('unsupported_parameter');
        expect(parsed.error.param, `tools=${JSON.stringify(tools)}`).toBe('tools');
        expect(parsed.error.message, `tools=${JSON.stringify(tools)}`).toContain('tools');
      }
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT3 建立 / COMPAT4 放宽后：`tool_choice` 只接受 `"none"` / `"auto"` / 缺省，其余逐条 422 并指名', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // `"none"` = 不调用工具，与本端点实际行为逐字相符 → 接受（两种搭配都接受）。
      expect((await postUnique(h, { ...base, tool_choice: 'none' })).status).toBe(200);
      expect((await postUnique(h, { ...base, tools: [], tool_choice: 'none' })).status).toBe(200);
      // **COMPAT4 裁定变更**：`"auto"` 从 422 变 **200**。它要的是"模型自己决定调不调"，
      // 而本端点**永不发** `tool_calls` —— 那正是这条路线实际落到的下界，如实成立，
      // 并由 `zcc.tool_choice_received` 披露"收到了但没有生效"。
      expect((await postUnique(h, { ...base, tool_choice: 'auto' })).status).toBe(200);
      expect((await postUnique(h, { ...base, tools: [{ type: 'function' }], tool_choice: 'auto' })).status).toBe(200);
      // `null` 与缺席同义（没有偏好）。
      expect((await postUnique(h, { ...base, tool_choice: null })).status).toBe(200);
      // 仍拒的那一批：`required`（及旧名 `any`）= **要求必须调用工具**，本端点做不到；
      // 具名对象形式 = **要求必须调用某一个具名工具**，同样做不到。披露救不回来。
      for (const bad of [
        'required',
        'any',
        'Any',
        'Required',
        'None',
        'NONE',
        'AUTO',
        '',
        1,
        true,
        {},
        { type: 'function' },
        { type: 'function', function: { name: 'f' } },
        { function: { name: 'f' } },
        [],
        ['none']
      ]) {
        const res = await postUnique(h, { ...base, tool_choice: bad });
        expect(res.status, `tool_choice=${JSON.stringify(bad)}`).toBe(422);
        const parsed = parseJson(res.text);
        expect(errorCode(parsed), `tool_choice=${JSON.stringify(bad)}`).toBe('unsupported_parameter');
        expect(parsed.error.param, `tool_choice=${JSON.stringify(bad)}`).toBe('tool_choice');
        expect(parsed.error.message, `tool_choice=${JSON.stringify(bad)}`).toContain('required');
        expect(parsed.error.message, `tool_choice=${JSON.stringify(bad)}`).toContain('none');
        expect(parsed.error.message, `tool_choice=${JSON.stringify(bad)}`).toContain('auto');
      }
      // **报错优先级**：`tools` 形状不合法时报 `tools`（真正的那个键），
      // 不先抱怨它的伴随开关——即使 `tool_choice` 同样非法。
      const bothBad = await postUnique(h, { ...base, tools: [{}], tool_choice: 'required' });
      expect(bothBad.status).toBe(422);
      expect(parseJson(bothBad.text).error.param).toBe('tools[0]');
      // `tools` 合法但 `tool_choice` 要求必须调工具 → 报 `tool_choice`。
      const choiceBad = await postUnique(h, {
        ...base,
        tools: [{ type: 'function', function: { name: 'f' } }],
        tool_choice: 'required'
      });
      expect(choiceBad.status).toBe(422);
      expect(parseJson(choiceBad.text).error.param).toBe('tool_choice');
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT3：空数组的让步**没有**外溢到同族字段（`functions` / `parallel_tool_calls` 仍 422）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      for (const [key, value] of /** @type {Array<[string, unknown]>} */ ([
        ['functions', []],
        ['function_call', 'none'],
        ['parallel_tool_calls', false],
        ['response_format', { type: 'text' }],
        ['logprobs', false]
      ])) {
        const res = await postUnique(h, { ...base, [key]: value });
        expect(res.status, `${key}=${JSON.stringify(value)}`).toBe(422);
        const parsed = parseJson(res.text);
        expect(errorCode(parsed), key).toBe('unsupported_parameter');
        expect(parsed.error.param, key).toBe(key);
      }
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT3 建立 / COMPAT4 更新：解析期纯函数逐条钉死（不经过 HTTP 也一样判定，且 role 闭集是精确的）', async () => {
    // 闭集逐字钉死：多了或少了一个 role，这条立刻红。
    expect([...SUPPORTED_ROLES]).toEqual(['system', 'developer', 'user', 'assistant']);
    expect([...FOLDED_PROMPT_ROLES]).toEqual(['system', 'developer']);
    // **COMPAT4**：`tool_choice` 的接受闭集从 `none` 一个值扩到 `none | auto`；
    // `required`（旧名 `any`）**仍然拒**，因为它要求必须调用工具。
    expect([...ACCEPTED_TOOL_CHOICES]).toEqual(['none', 'auto']);
    expect([...REQUIRED_TOOL_CHOICES]).toEqual(['required', 'any']);
    // 折叠集合是接受集合的真子集（对话轮**不是**被折叠的指令轮）。
    for (const role of FOLDED_PROMPT_ROLES) expect(SUPPORTED_ROLES).toContain(role);
    for (const role of ['user', 'assistant']) expect(FOLDED_PROMPT_ROLES).not.toContain(role);
    const base = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
    // `collectFoldedPromptRoles` 逐字：首次出现序、去重、对话轮不报。
    expect(collectFoldedPromptRoles([{ role: 'user', content: 'a' }])).toEqual([]);
    expect(
      collectFoldedPromptRoles([
        { role: 'system', content: 'a' },
        { role: 'developer', content: 'b' },
        { role: 'system', content: 'c' }
      ])
    ).toEqual(['system', 'developer']);
    expect(
      collectFoldedPromptRoles([
        { role: 'developer', content: 'b' },
        { role: 'system', content: 'a' }
      ])
    ).toEqual(['developer', 'system']);
    // 解析期形状（`parseChatRequest` 直调，钉住 422/200 之外的那条解析路径）。
    expect(parseChatRequest({ ...base, messages: [{ role: 'developer', content: 'a' }, ...base.messages] }).rolesFolded).toEqual([
      'developer'
    ]);
    expect(parseChatRequest({ ...base, tools: [] }).rolesFolded).toEqual([]);
    // `tools:[]` 解析期**不报错**；`tools` 非空合法形状同样不报错（COMPAT4）。
    expect(() => parseChatRequest({ ...base, tools: [] })).not.toThrow();
    for (const ok of ACCEPTED_TOOL_CHOICES) {
      expect(() => parseChatRequest({ ...base, tool_choice: ok })).not.toThrow();
    }
    // 浅校验只到"是对象 + 有 `function` 或 `type` 字段"：畸形项逐条指名下标，
    // 非数组（含 `null`）逐条指名 `tools`。
    for (const [bad, param] of /** @type {Array<[unknown, string]>} */ ([
      [[{}], 'tools[0]'],
      [[{ type: 'function' }, { function: { name: 'f' } }, 'x'], 'tools[2]']
    ])) {
      const caught = caughtApiError(() => parseChatRequest({ ...base, tools: bad }));
      expect(String(caught?.code ?? ''), `tools=${JSON.stringify(bad)}`).toBe('unsupported_parameter');
      expect(String(caught?.param ?? ''), `tools=${JSON.stringify(bad)}`).toBe(param);
    }
    for (const bad of [null, 1, {}]) {
      const caught = caughtApiError(() => parseChatRequest({ ...base, tools: bad }));
      expect(String(caught?.code ?? ''), `tools=${JSON.stringify(bad)}`).toBe('unsupported_parameter');
      expect(String(caught?.param ?? ''), `tools=${JSON.stringify(bad)}`).toBe('tools');
    }
    for (const bad of ['required', 'any', { type: 'function' }]) {
      const caught = caughtApiError(() => parseChatRequest({ ...base, tool_choice: bad }));
      expect(String(caught?.code ?? ''), `tool_choice=${JSON.stringify(bad)}`).toBe('unsupported_parameter');
      expect(String(caught?.param ?? ''), `tool_choice=${JSON.stringify(bad)}`).toBe('tool_choice');
    }
  });

  it('COMPAT3：真客户端的完整形状（`developer` + `tools:[]` + 空数组工具开关）一次通过', async () => {
    // 这是 mcode 恢复旧会话 + 配了系统提示词时**逐字**会发出的组合形状
    // （`ke()` off 10416 发 `developer`；`ce()` off 7186 发 `tools:[]`）。
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await postUnique(h, {
        model: FIXTURE_MODEL_ID,
        messages: [
          { role: 'developer', content: '系统提示词' },
          { role: 'user', content: '第一轮' },
          { role: 'assistant', content: '上一轮回答' },
          { role: 'user', content: '接着说' }
        ],
        tools: [],
        tool_choice: 'none',
        stream: true,
        stream_options: { include_usage: true },
        store: false,
        max_completion_tokens: 64,
        reasoning_effort: 'low'
      });
      expect(res.status).toBe(200);
      const zcc = JSON.parse(res.text.split('\n\n')[0]?.replace('data: ', '') ?? '{}').zcc;
      expect(zcc.roles_folded).toEqual(['developer']);
      expect(zcc.parameters_not_forwarded).toEqual(['store']);
      // **COMPAT4**：这三个键**恒在场**，所以"客户端查了就知道"不需要先读文档。
      expect(zcc.tools_received).toBe(0);
      expect(zcc.tools_forwarded).toBe(0);
      expect(zcc.tool_choice_received).toBe('none');
    } finally {
      await h.server.stop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5c. COMPAT4：非空 `tools` 接受 + 明示"工具声明未转发、本端点纯对话形态"      */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · COMPAT4 工具声明接受与未转发披露', () => {
  /**
   * 与 5b 同 describe 的理由：幂等作用域不能复用，否则同作用域不同 body 会变成 409。
   *
   * @param {Harness} h
   * @param {unknown} body
   * @param {Record<string, string>} [extra]
   * @returns {Promise<Res>}
   */
  let seq = 0;
  const postUnique = (/** @type {Harness} */ h, /** @type {unknown} */ body, /** @type {Record<string, string>} */ extra = {}) =>
    authed({ port: h.port, headers: { 'x-zcc-session-id': `c4-${String((seq += 1))}`, ...extra }, body });

  /**
   * SSE 帧（不含 `[DONE]`）。
   *
   * @param {string} text
   * @returns {Array<Record<string, unknown>>}
   */
  const frames = (text) =>
    text
      .split('\n\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice('data: '.length)));

  it('COMPAT4：非空 `tools` 接受（200），且 `zcc.tools_received` / `tools_forwarded` **逐条如实披露**', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // 缺席 / 空数组 / `null` 都是"收到 0 条声明"（恒在场，不靠"没这个键"表达）。
      for (const body of [base, { ...base, tools: [] }]) {
        const res = await postUnique(h, body);
        expect(res.status).toBe(200);
        const zcc = parseJson(res.text).zcc;
        expect(zcc.tools_received).toBe(0);
        expect(zcc.tools_forwarded).toBe(TOOLS_FORWARDED_NONE);
        expect(zcc.tool_choice_received).toBeNull();
      }
      // 真实客户端卡住端到端的那一档：**26 项非空数组**。
      const many = Array.from({ length: 26 }, (_, i) => ({
        type: 'function',
        function: { name: `f${String(i)}`, description: 'x', parameters: { type: 'object', properties: {} } }
      }));
      const real = await postUnique(h, { ...base, tools: many });
      expect(real.status).toBe(200);
      const zcc = parseJson(real.text).zcc;
      // **核心披露**：收到了 N 条声明，**一条也没有转发**，本端点是纯对话形态。
      expect(zcc.tools_received).toBe(26);
      expect(zcc.tools_forwarded).toBe(0);
      // 计数**逐条**对得上（1 / 2 / 3 …），不是只测 26 这一个数。
      for (const n of [1, 2, 3, 7]) {
        const res = await postUnique(h, { ...base, tools: Array.from({ length: n }, () => ({ type: 'function' })) });
        expect(parseJson(res.text).zcc.tools_received, `n=${String(n)}`).toBe(n);
      }
      // 接受 ≠ 生效：产出里**绝不能**出现 `tool_calls`（本端点不实现工具调用）。
      const body = parseJson(real.text);
      expect(body.choices[0].message.tool_calls).toBeUndefined();
      expect(body.choices[0].finish_reason).toBe('stop');
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT4：披露**恒在场**且与既有披露表**互不串味**（`parameters_not_forwarded` 不被污染）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      const res = await postUnique(h, { ...base, tools: [{ type: 'function' }], temperature: 0.5, store: false });
      expect(res.status).toBe(200);
      const zcc = parseJson(res.text).zcc;
      // 工具声明走**自己那两个键**，不混进"参数没转发"那张表（那是 A 类参数的表）。
      expect(zcc.parameters_not_forwarded).toEqual(['temperature', 'store']);
      expect(zcc.parameters_not_forwarded).not.toContain('tools');
      expect(zcc.parameters_not_forwarded).not.toContain('tool_choice');
      // 三个键逐条在位（`Object.hasOwn`，不是 `in`，原型上的键不算）。
      for (const key of ['tools_received', 'tools_forwarded', 'tool_choice_received']) {
        expect(Object.prototype.hasOwnProperty.call(zcc, key), `${key} 必须恒在场`).toBe(true);
      }
      // 恒为 0 的那个键必须是**数字 0**，不是 `false` / `undefined` / 字符串。
      expect(zcc.tools_forwarded).toBe(0);
      expect(typeof zcc.tools_forwarded).toBe('number');
      expect(zcc.tools_received).toBe(1);
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT4：`tool_choice` 的 `none` / `auto` / 缺省逐条接受并**逐名**披露实际收到的值', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // 披露的是**客户端实际发的那个值**（不是我们替它挑的一档）。
      for (const choice of ACCEPTED_TOOL_CHOICES) {
        const res = await postUnique(h, { ...base, tool_choice: choice });
        expect(res.status, `tool_choice=${choice}`).toBe(200);
        expect(parseJson(res.text).zcc.tool_choice_received, `tool_choice=${choice}`).toBe(choice);
      }
      // 缺省 / `null` = 没有偏好 → `null`（口径与 `reasoning_effort_applied` 一致）。
      for (const body of [base, { ...base, tool_choice: null }]) {
        expect(parseJson((await postUnique(h, body)).text).zcc.tool_choice_received).toBeNull();
      }
      // `auto` + 非空 `tools` 同时出现（真实客户端的组合形状）也逐条披露两个值。
      const both = await postUnique(h, {
        ...base,
        tools: [{ type: 'function', function: { name: 'f' } }],
        tool_choice: 'auto'
      });
      expect(both.status).toBe(200);
      const zcc = parseJson(both.text).zcc;
      expect(zcc.tools_received).toBe(1);
      expect(zcc.tools_forwarded).toBe(0);
      expect(zcc.tool_choice_received).toBe('auto');
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT4：流式与非流式**两条响应路径都披露**同一个块（不是只有非流式有）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = {
        model: FIXTURE_MODEL_ID,
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ type: 'function', function: { name: 'f' } }, { type: 'function', function: { name: 'g' } }],
        tool_choice: 'auto'
      };
      // 非流式：`chat.completion` 顶层。
      const json = await postUnique(h, base);
      expect(json.status).toBe(200);
      const jsonZcc = parseJson(json.text).zcc;
      expect(jsonZcc.tools_received).toBe(2);
      expect(jsonZcc.tools_forwarded).toBe(0);
      expect(jsonZcc.tool_choice_received).toBe('auto');
      // 流式：**每一帧**都带同一个块（首帧、中间帧、末帧），且不只在首帧出现。
      const sse = await postUnique(h, { ...base, stream: true, stream_options: { include_usage: true } });
      expect(sse.status).toBe(200);
      expect(sse.text).toContain('data: [DONE]');
      const all = frames(sse.text);
      expect(all.length).toBeGreaterThan(1);
      for (const frame of all) {
        const zcc = /** @type {Record<string, unknown>} */ (frame.zcc);
        expect(Object.prototype.hasOwnProperty.call(zcc, 'tools_received'), '流式每帧都要有').toBe(true);
        expect(zcc.tools_received).toBe(2);
        expect(zcc.tools_forwarded).toBe(0);
        expect(zcc.tool_choice_received).toBe('auto');
      }
      // 两条路径**键集完全相同**（同一个块，不允许流式少报一个键）。
      expect(Object.keys(all[0]?.zcc ?? {}).sort()).toEqual(Object.keys(jsonZcc).sort());
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT4：浅校验只到"对象 + 有 `function` 或 `type`"——**不深验**（不查 `type` 取值、不查 `function.name`、不查 `parameters` schema）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      // 逐个"按 OpenAI 官方形状算**畸形**、按本端点浅校验**放行**"的形状。
      // 这是裁定的**直接后果**：浅校验就是浅校验，不因为畸形就偷偷升级成深验。
      for (const item of [
        { type: 'function', function: { name: 'ok' } },
        { type: 'function', function: 'not-an-object' },
        { type: 'function', function: {} },
        { type: 12345, function: null },
        { type: 'unknown_tool_kind' },
        { type: 'web_search' },
        { function: { name: 'no-type-field' } },
        { type: 'function', extra_unknown_key: { nested: [1, 2, 3] } }
      ]) {
        const res = await postUnique(h, { ...base, tools: [item] });
        expect(res.status, `tools=[${JSON.stringify(item)}]`).toBe(200);
        const zcc = parseJson(res.text).zcc;
        // 放行的是**声明**，不是"生效"：`tools_forwarded` 仍然是 0。
        expect(zcc.tools_received).toBe(1);
        expect(zcc.tools_forwarded).toBe(0);
      }
      // 反面：**过不了**浅校验的形状逐条 422 并**指名下标**（不是笼统的 `tools`）。
      for (const [item, param] of /** @type {Array<[unknown, string]>} */ ([
        [{}, 'tools[0]'],
        [{ name: 'f' }, 'tools[0]'],
        [{ description: 'x' }, 'tools[0]'],
        [{ parameters: {} }, 'tools[0]'],
        [null, 'tools[0]'],
        ['function', 'tools[0]'],
        [1, 'tools[0]'],
        [[{ type: 'function' }], 'tools[0]']
      ])) {
        const res = await postUnique(h, { ...base, tools: [item] });
        expect(res.status, `tools=[[${JSON.stringify(item)}]]`).toBe(422);
        const parsed = parseJson(res.text);
        expect(errorCode(parsed)).toBe('unsupported_parameter');
        expect(parsed.error.param, `tools=[[${JSON.stringify(item)}]]`).toBe(param);
      }
      // 错误**指名具体下标**：畸形项在第 2 位时报 `tools[2]`，不是笼统的 `tools`。
      const at2 = await postUnique(h, {
        ...base,
        tools: [{ type: 'function' }, { function: { name: 'f' } }, []]
      });
      expect(at2.status).toBe(422);
      expect(parseJson(at2.text).error.param).toBe('tools[2]');
      // 继承字段**不算**：`Object.create` 出来的 `function` 不可见 → 仍然拒
      // （"有 `function` 或 `type` 字段"指的是**自有**字段，否则 `{}` 能骗过浅校验）。
      const inherited = await postUnique(h, {
        ...base,
        tools: [Object.assign(Object.create({ function: { name: 'inherited' } }), { description: 'x' })]
      });
      expect(inherited.status).toBe(422);
      expect(parseJson(inherited.text).error.param).toBe('tools[0]');
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT4：`tools_forwarded: 0` 是**结构可证**的事实（驱动器契约上没有工具槽位，驱动源码不读它）', async () => {
    // 披露说"一条都没转发"必须能被独立复核，不能只是一句自报。两条静态证据：
    //  1. `DriverRequest` 上**没有** `tools` / `tool_choice` 字段 → 驱动器收不到，
    //     也就无处转发（`normalizedRequestHash` 同样不含它们，见下面第 3 条）。
    //  2. 两个驱动器**都不**从请求里读这两个键。
    const chatSrc = stripComments(readFileSync(join(ROOT, 'packages', 'api', 'src', 'chat.ts'), 'utf8'));
    const driverSrc = stripComments(readFileSync(join(ROOT, 'packages', 'official-host', 'src', 'host-driver.ts'), 'utf8'));
    // `DriverRequest` 的接口体（`export interface DriverRequest` 到下一个顶层声明 `DriverEvent`）。
    const from = chatSrc.indexOf('export interface DriverRequest');
    expect(from, 'chat.ts 仍必须有 DriverRequest 接口').toBeGreaterThan(-1);
    const driverRequestBlock = chatSrc.slice(from, chatSrc.indexOf('export type DriverEvent', from));
    expect(driverRequestBlock, 'DriverRequest 不得有 tools 槽位').not.toMatch(/\btools\b/);
    expect(driverRequestBlock, 'DriverRequest 不得有 tool_choice 槽位').not.toMatch(/\btool_choice\b/);
    // 驱动器源码**不读**这两个键（`request.tools` / `request.tool_choice` 一律不许出现）。
    for (const src of [chatSrc, driverSrc]) {
      expect(src, '不得从请求上读 tools').not.toMatch(/request\s*\.\s*tools\b/);
      expect(src, '不得从请求上读 tool_choice').not.toMatch(/request\s*\.\s*tool_choice\b/);
    }
    // 幂等指纹**不含**工具声明：它们既不转发、也不改变上游收到的内容，
    // 因此不是"操作身份"的一部分（与其它 A 类未转发参数同口径）。
    const hashOf = (/** @type {unknown} */ body) => normalizedRequestHash(parseChatRequest(body));
    const hashBase = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
    expect(hashOf({ ...hashBase, tools: [{ type: 'function' }] })).toBe(hashOf(hashBase));
    expect(hashOf({ ...hashBase, tool_choice: 'auto' })).toBe(hashOf(hashBase));
    // 但 role / 内容变了仍然进指纹（COMPAT3 已定，本轮不得回退）。
    expect(hashOf({ ...hashBase, messages: [{ role: 'system', content: 'a' }, ...hashBase.messages] })).not.toBe(
      hashOf(hashBase)
    );
  });

  it('COMPAT4：让位**不外溢**——`functions` / `function_call` / `parallel_tool_calls` 等同族键仍逐条 422', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const base = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'x' }] };
      for (const [key, value] of /** @type {Array<[string, unknown]>} */ ([
        ['functions', []],
        ['functions', [{ name: 'f' }]],
        ['function_call', 'none'],
        ['function_call', 'auto'],
        ['parallel_tool_calls', false],
        ['parallel_tool_calls', true],
        ['response_format', { type: 'text' }],
        ['logprobs', false]
      ])) {
        const res = await postUnique(h, { ...base, [key]: value });
        expect(res.status, `${key}=${JSON.stringify(value)}`).toBe(422);
        const parsed = parseJson(res.text);
        expect(errorCode(parsed), key).toBe('unsupported_parameter');
        expect(parsed.error.param, key).toBe(key);
      }
    } finally {
      await h.server.stop();
    }
  });

  it('COMPAT4：真客户端的完整形状（26 项工具声明 + `auto` + `developer` + 流式）**一次**通过并如实披露', async () => {
    // 协调者实弹卡住端到端的那一档逐字复原：非空 `tools` 数组（26 项）+ 配了
    // 系统提示词（恒发 `developer`）+ 恒发的 `store` / `max_completion_tokens`。
    const tools = Array.from({ length: 26 }, (_, i) => ({
      type: 'function',
      function: { name: `tool_${String(i)}`, description: `d${String(i)}`, parameters: { type: 'object', properties: { a: { type: 'string' } } } }
    }));
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await postUnique(h, {
        model: FIXTURE_MODEL_ID,
        messages: [
          { role: 'developer', content: '系统提示词' },
          { role: 'user', content: '第一轮' },
          { role: 'assistant', content: '上一轮回答' },
          { role: 'user', content: '接着说' }
        ],
        tools,
        tool_choice: 'auto',
        stream: true,
        stream_options: { include_usage: true },
        store: false,
        max_completion_tokens: 64,
        reasoning_effort: 'low'
      });
      expect(res.status).toBe(200);
      const zcc = parseJson(res.text.split('\n\n')[0]?.replace('data: ', '') ?? '{}').zcc;
      expect(zcc.roles_folded).toEqual(['developer']);
      expect(zcc.parameters_not_forwarded).toEqual(['store']);
      expect(zcc.tools_received).toBe(26);
      expect(zcc.tools_forwarded).toBe(0);
      expect(zcc.tool_choice_received).toBe('auto');
      // 接受工具声明**没有**顺带让 `tools_forwarded` 变成非 0：产出里依然一个
      // 工具调用都没有。COMPAT5 起，**消息级**工具痕迹（`tool_calls` / `role:"tool"`）
      // 改走"接受 + 剥离/转写"（钉在 tests/unit/api-chat-message-tool-trace.test.mjs），
      // 但那两条**不改变**任何顶层拒绝语义：`tools` 畸形仍逐条指名 422，
      // `tools_received` / `tools_forwarded` 的口径一个字没动。
      const badTools = await postUnique(h, {
        model: FIXTURE_MODEL_ID,
        messages: [{ role: 'user', content: 'x' }],
        tools: 1
      });
      expect(badTools.status).toBe(422);
      expect(errorCode(parseJson(badTools.text))).toBe('unsupported_parameter');
      expect(parseJson(badTools.text).error.param).toBe('tools');
      const requiredChoice = await postUnique(h, {
        model: FIXTURE_MODEL_ID,
        messages: [{ role: 'user', content: 'x' }],
        tool_choice: 'required'
      });
      expect(requiredChoice.status).toBe(422);
      expect(parseJson(requiredChoice.text).error.param).toBe('tool_choice');
      // `tools` 声明的计数口径未被消息级剥离牵动。
      const counted = await postUnique(h, {
        model: FIXTURE_MODEL_ID,
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f' } }] },
          { role: 'tool', content: 'r', tool_call_id: 'c' }
        ],
        tools
      });
      expect(counted.status).toBe(200);
      expect(parseJson(counted.text).zcc.tools_received).toBe(26);
      expect(parseJson(counted.text).zcc.tools_forwarded).toBe(TOOLS_FORWARDED_NONE);
    } finally {
      await h.server.stop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 6. 幂等                                                                    */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · 幂等', () => {
  /**
   * @param {Harness} h
   * @param {string} session
   * @param {unknown} body
   * @param {Record<string, string>} [extra]
   * @returns {Promise<Res>}
   */
  const post = (h, session, body, extra = {}) => authed({ port: h.port, headers: { 'x-zcc-session-id': session, ...extra }, body });

  it('同 key + 同会话 + 同 body 返回同一 operation 并标记 replayed，驱动只被调一次', async () => {
    const calls = { n: 0 };
    const inner = createFixtureDriver();
    const driver = {
      ...inner,
      /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
      stream(req) {
        calls.n += 1;
        return inner.stream(req);
      }
    };
    const h = await startServer({ driver, rateLimit: { maxConcurrent: 8, requests: 200, windowMs: 60_000 } });
    try {
      const body = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'idem' }] };
      const a = await post(h, 's1', body);
      const b = await post(h, 's1', { messages: body.messages, model: body.model });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(header(b.headers, 'x-zcc-operation-id')).toBe(header(a.headers, 'x-zcc-operation-id'));
      expect(header(b.headers, 'x-zcc-idempotency')).toBe('replayed');
      expect(parseJson(a.text).id).toBe(parseJson(b.text).id);
      expect(calls.n).toBe(1);
    } finally {
      await h.server.stop();
    }
  });

  it('同 key + 同会话 + 异 body 返回 409 idempotency_conflict', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const first = await post(h, 's2', { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'a' }] });
      expect(first.status).toBe(200);
      const second = await post(h, 's2', { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'b' }] });
      expect(second.status).toBe(409);
      expect(errorCode(parseJson(second.text))).toBe('idempotency_conflict');
    } finally {
      await h.server.stop();
    }
  });

  it('不同会话的同 body 是不同 operation（作用域按 身份+会话+key 隔离）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const body = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'same' }] };
      const a = await post(h, 's3', body);
      const b = await post(h, 's4', body);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(header(b.headers, 'x-zcc-operation-id')).not.toBe(header(a.headers, 'x-zcc-operation-id'));
      expect(header(b.headers, 'x-zcc-idempotency')).toBe('original');
    } finally {
      await h.server.stop();
    }
  });

  it('失败的 503 不写入幂等表：不会把一次无额度固化成永久重放', async () => {
    const h = await startServer();
    try {
      const body = { model: 'm', messages: [{ role: 'user', content: 'x' }] };
      const a = await post(h, 's5', body);
      const b = await post(h, 's5', body);
      expect(a.status).toBe(503);
      expect(b.status).toBe(503);
      expect(header(b.headers, 'x-zcc-idempotency')).toBe('original');
    } finally {
      await h.server.stop();
    }
  });

  it('流式请求的重复调用重放同一 operation 的 SSE 帧', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const body = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'stream-idem' }], stream: true };
      const a = await post(h, 's6', body);
      const b = await post(h, 's6', body);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(header(b.headers, 'x-zcc-idempotency')).toBe('replayed');
      expect(a.text).toBe(b.text);
      expect(a.text).toContain('data: [DONE]');
    } finally {
      await h.server.stop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* COMPAT1/C1：幂等改为**显式 opt-in**（CRITICAL 硬阻断的修复）                  */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · COMPAT1/C1 幂等显式 opt-in', () => {
  /**
   * 协调者实弹（2026-10-02，0.003 s 拿到 409）：**不带** `x-zcc-client-id` 的请求
   * 全部落进 `default-client`/`default-session` 这**同一个**作用域，于是首个成功请求
   * 之后，任何不同请求体直接 409 `idempotency_conflict`，直到进程重启。
   * 标准 OpenAI 兼容客户端（mcode / 其它 IDE）**不发**这两个头 → 第一条之后全线堵死。
   *
   * 修复方向：**无幂等头 = 每次都是新 operation**。
   */
  it('无任何幂等头：N 连发**不同**请求体全 200、各自独立 operation、且不写幂等表', async () => {
    const calls = { n: 0 };
    const inner = createFixtureDriver();
    const driver = {
      ...inner,
      /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
      stream(req) {
        calls.n += 1;
        return inner.stream(req);
      }
    };
    const h = await startServer({ driver, rateLimit: { maxConcurrent: 8, requests: 200, windowMs: 60_000 } });
    try {
      /** @type {string[]} */
      const operationIds = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await authed({
          port: h.port,
          body: { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: `bare-${i}` }] }
        });
        // **这一条就是回归点**：旧实现在 i>=1 时全部 409。
        expect(res.status, `第 ${i} 发必须 200`).toBe(200);
        // 响应头如实标注"这次不在任何幂等作用域里"
        expect(header(res.headers, 'x-zcc-idempotency')).toBe('none');
        operationIds.push(header(res.headers, 'x-zcc-operation-id'));
      }
      // 六次**真的是六次**驱动调用：没有一次被重放吞掉。
      expect(calls.n).toBe(6);
      expect(new Set(operationIds).size).toBe(6);
      // 幂等表**一条都没进**（诊断口径：`idempotencyEntries`）。
      expect(h.server.diagnostics.idempotencyEntries).toBe(0);
    } finally {
      await h.server.stop();
    }
  });

  it('无头 + **同体**重发：如实**不**重放（每次都是新 operation，重新真算一遍）', async () => {
    const calls = { n: 0 };
    const inner = createFixtureDriver();
    const driver = {
      ...inner,
      /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
      stream(req) {
        calls.n += 1;
        return inner.stream(req);
      }
    };
    const h = await startServer({ driver, rateLimit: { maxConcurrent: 8, requests: 200, windowMs: 60_000 } });
    try {
      const body = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'same-twice' }] };
      const a = await authed({ port: h.port, body });
      const b = await authed({ port: h.port, body: { messages: body.messages, model: body.model } });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      // **语义裁定**：无头 = 不重放。理由写在这里而不是只在报告里：
      //  1. 客户端**没有**表达"这两次是同一次操作"的意图；我们替它猜就是"静默改写请求"。
      //  2. 重放会**跳过模型调用**，而客户端此刻并不知道这件事发生了（它没发幂等键）。
      //  3. 想要重放语义，客户端发 `Idempotency-Key` 即可——那正是 OpenAI 惯例。
      expect(header(b.headers, 'x-zcc-idempotency')).toBe('none');
      expect(header(b.headers, 'x-zcc-operation-id')).not.toBe(header(a.headers, 'x-zcc-operation-id'));
      expect(calls.n).toBe(2);
    } finally {
      await h.server.stop();
    }
  });

  it('`Idempotency-Key`（OpenAI 惯例）：同键同体 replay、同键异体 409、异键各 200', async () => {
    const calls = { n: 0 };
    const inner = createFixtureDriver();
    const driver = {
      ...inner,
      /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
      stream(req) {
        calls.n += 1;
        return inner.stream(req);
      }
    };
    const h = await startServer({ driver, rateLimit: { maxConcurrent: 8, requests: 200, windowMs: 60_000 } });
    try {
      const send = (/** @type {string} */ key, /** @type {string} */ content) =>
        authed({
          port: h.port,
          headers: { 'idempotency-key': key },
          body: { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content }] }
        });
      const a = await send('k-1', 'alpha');
      const b = await send('k-1', 'alpha');
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(header(b.headers, 'x-zcc-idempotency')).toBe('replayed');
      expect(header(b.headers, 'x-zcc-operation-id')).toBe(header(a.headers, 'x-zcc-operation-id'));
      expect(calls.n).toBe(1);

      // 同键异体 → 409（显式声明了"这是同一次操作"，那就不能改写它）
      const conflict = await send('k-1', 'beta');
      expect(conflict.status).toBe(409);
      expect(errorCode(parseJson(conflict.text))).toBe('idempotency_conflict');

      // 异键同体 → 两次独立 operation
      const other = await send('k-2', 'alpha');
      expect(other.status).toBe(200);
      expect(header(other.headers, 'x-zcc-idempotency')).toBe('original');
      expect(calls.n).toBe(2);
    } finally {
      await h.server.stop();
    }
  });

  it('`Idempotency-Key` 与 `x-zcc-session-id` 同场：按 `Idempotency-Key` 判（更具体的那一维）', async () => {
    const calls = { n: 0 };
    const inner = createFixtureDriver();
    const driver = {
      ...inner,
      /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
      stream(req) {
        calls.n += 1;
        return inner.stream(req);
      }
    };
    const h = await startServer({ driver, rateLimit: { maxConcurrent: 8, requests: 200, windowMs: 60_000 } });
    try {
      const body = { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'dual' }] };
      const headers = { 'idempotency-key': 'dual-key', 'x-zcc-session-id': 'dual-session' };
      const a = await authed({ port: h.port, headers, body });
      const b = await authed({ port: h.port, headers, body: { messages: body.messages, model: body.model } });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(header(b.headers, 'x-zcc-idempotency')).toBe('replayed');
      expect(calls.n).toBe(1);
      // 反过来：只改 sessionId、不改 key → **仍然是重放**。`Idempotency-Key` 一旦在场，
      // `x-zcc-client-id` / `x-zcc-session-id` 就**完全不参与**判作用域
      //（OpenAI 惯例里那个键是逐次请求的令牌，身份头是逐会话的；同场时按更具体的那一维）。
      const c = await authed({ port: h.port, headers: { ...headers, 'x-zcc-session-id': 'other-session' }, body });
      expect(c.status).toBe(200);
      expect(header(c.headers, 'x-zcc-idempotency')).toBe('replayed');
      expect(calls.n).toBe(1);
      // 换 key → 新作用域（这才是"更具体的那一维"在起作用的可观测点）
      const d = await authed({ port: h.port, headers: { ...headers, 'idempotency-key': 'dual-key-2' }, body });
      expect(d.status).toBe(200);
      expect(header(d.headers, 'x-zcc-idempotency')).toBe('original');
      expect(calls.n).toBe(2);
    } finally {
      await h.server.stop();
    }
  });

  it('不合法形状的幂等头值 = **没有** opt-in（退化成每次新 operation，而不是落进一个脏作用域）', async () => {
    const h = await startServer({ driver: createFixtureDriver(), rateLimit: { maxConcurrent: 8, requests: 200, windowMs: 60_000 } });
    try {
      // 超长 / 含空白 / 非 ASCII —— 全部判成"没发"。
      // （带换行的头值 Node 的 http 客户端在**发出之前**就拒了，根本到不了服务端；
      //  所以"含控制字符"那一类不是"被判成 none"，而是"在 HTTP 这一层就不可能被发出来"——
      //  两件事都成立，区别在于防线在哪一层。）
      // 形状闸门是 `^[A-Za-z0-9._:-]{1,128}$`：`.` `_` `:` `-` **在**类里（是合法 token），
      // 下面这五个**不**在类里。逐个钉住"不合形状 = 没有 opt-in"这条。
      for (const bad of ['', '   ', 'a'.repeat(129), 'has space', 'slash/key', 'at@key', 'hash#key', 'plus+key']) {
        const res = await authed({
          port: h.port,
          headers: { 'idempotency-key': bad },
          body: { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: `bad-${bad.length}` }] }
        });
        expect(res.status, JSON.stringify(bad)).toBe(200);
        expect(header(res.headers, 'x-zcc-idempotency')).toBe('none');
      }
      expect(h.server.diagnostics.idempotencyEntries).toBe(0);
    } finally {
      await h.server.stop();
    }
  });

  it('形状闸门**不**误伤合法 token（`.` `_` `:` `-` 逐个放行）', async () => {
    const h = await startServer({ driver: createFixtureDriver(), rateLimit: { maxConcurrent: 8, requests: 200, windowMs: 60_000 } });
    try {
      for (const [i, good] of ['a.b', 'a_b', 'a:b', 'a-b', 'a'.repeat(128)].entries()) {
        const res = await authed({
          port: h.port,
          headers: { 'idempotency-key': good },
          body: { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: `good-${i}` }] }
        });
        expect(res.status, good).toBe(200);
        // 合形状 = 显式 opt-in = 真的进了幂等作用域
        expect(header(res.headers, 'x-zcc-idempotency')).toBe('original');
        expect(h.server.diagnostics.idempotencyEntries).toBe(i + 1);
      }
    } finally {
      await h.server.stop();
    }
  });

  it('响应头值域精确闭合在 `original | replayed | none`（不构造第四种）', () => {
    expect([...IDEMPOTENCY_RESPONSE_VALUES].sort()).toEqual(['none', 'original', 'replayed']);
  });

  it('无头时 503（无上游）也如实标 `none`，不谎称 `original`', async () => {
    const h = await startServer();
    try {
      const res = await authed({ port: h.port, body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } });
      expect(res.status).toBe(503);
      expect(header(res.headers, 'x-zcc-idempotency')).toBe('none');
    } finally {
      await h.server.stop();
    }
  });

  it('无头并发 N 路：互不影响（共享作用域坍缩的原始形态在这里被钉死）', async () => {
    const h = await startServer({
      driver: createFixtureDriver({ chunkDelayMs: 2 }),
      rateLimit: { maxConcurrent: 8, requests: 200, windowMs: 60_000 }
    });
    try {
      const responses = await Promise.all(
        [0, 1, 2, 3, 4, 5].map((i) =>
          authed({ port: h.port, body: { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: `conc-${i}` }] } })
        )
      );
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(header(res.headers, 'x-zcc-idempotency')).toBe('none');
      }
      expect(new Set(responses.map((r) => header(r.headers, 'x-zcc-operation-id'))).size).toBe(6);
    } finally {
      await h.server.stop();
    }
  });
});
/* -------------------------------------------------------------------------- */
/* 7. 上游缺席：fail-closed                                                    */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · 上游缺席时 fail-closed', () => {
  it('chat 503，且响应体不含任何模型内容 / choices / usage', async () => {
    const h = await startServer();
    try {
      const res = await authed({
        port: h.port,
        body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'SECRET_PROMPT_MARKER_9f3a' }] }
      });
      expect(res.status).toBe(503);
      const parsed = parseJson(res.text);
      expect(errorCode(parsed)).toBe('upstream_unavailable');
      expect(parsed.choices).toBeUndefined();
      expect(parsed.usage).toBeUndefined();
      expect(res.text).not.toContain('SECRET_PROMPT_MARKER_9f3a');
      expect(res.text).not.toContain('content');
      expect(header(res.headers, 'x-zcc-status')).toBe('no_quota');
      expect(header(res.headers, 'x-zcc-fixture')).toBe('');
    } finally {
      await h.server.stop();
    }
  });

  it('503 响应体里嵌的 zcc_error 通过 I04 合同校验且 delivery=not_submitted', async () => {
    const h = await startServer();
    try {
      const res = await authed({ port: h.port, body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } });
      const parsed = parseJson(res.text);
      const result = validateCompanionError(parsed.zcc_error);
      expect(result.ok, JSON.stringify(result.ok ? {} : result.issues)).toBe(true);
      expect(parsed.zcc_error.code).toBe('upstream_unavailable');
      expect(parsed.zcc_error.delivery).toBe('not_submitted');
      expect(parsed.zcc_error.retry.autoResendAllowed).toBe(false);
      expect(parsed.zcc_error.retry.requiresExplicitHumanDecision).toBe(true);
    } finally {
      await h.server.stop();
    }
  });

  it('stream:true 在无上游时同样是 503 JSON，不是半个空流', async () => {
    const h = await startServer();
    try {
      const res = await authed({
        port: h.port,
        body: { model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true }
      });
      expect(res.status).toBe(503);
      expect(header(res.headers, 'content-type')).toContain('application/json');
      expect(res.text).not.toContain('data:');
    } finally {
      await h.server.stop();
    }
  });

  it('未接入（not_attached）与无额度（no_quota）两种状态都如实报在 x-zcc-status 上', async () => {
    const h1 = await startServer({ driver: createUnavailableDriver({ status: 'not_attached' }) });
    try {
      const res = await request({ port: h1.port, headers: { authorization: `Bearer ${h1.key}` } });
      expect(header(res.headers, 'x-zcc-status')).toBe('not_attached');
      expect(parseJson(res.text).object).toBe('list');
      expect(parseJson(res.text).data).toEqual([]);
    } finally {
      await h1.server.stop();
    }
    const h2 = await startServer({ driver: createUnavailableDriver({ status: 'no_quota' }) });
    try {
      const res = await request({ port: h2.port, headers: { authorization: `Bearer ${h2.key}` } });
      expect(header(res.headers, 'x-zcc-status')).toBe('no_quota');
    } finally {
      await h2.server.stop();
    }
  });

  it('/v1/models 在无上游时返回 200 空列表 + 状态头，绝不返回占位假模型', async () => {
    const h = await startServer();
    try {
      const res = await request({ port: h.port, headers: { authorization: `Bearer ${h.key}` } });
      expect(res.status).toBe(200);
      expect(header(res.headers, 'content-type')).toContain('application/json');
      const parsed = parseJson(res.text);
      expect(parsed.object).toBe('list');
      expect(Array.isArray(parsed.data)).toBe(true);
      expect(parsed.data.length).toBe(0);
      expect(header(res.headers, 'x-zcc-status')).toBe('no_quota');
      expect(res.text).not.toMatch(/gpt|claude|qwen|deepseek/i);
    } finally {
      await h.server.stop();
    }
  });

  it('未知路径 404，未知方法 405', async () => {
    const h = await startServer();
    try {
      const nf = await request({ port: h.port, path: '/v1/nope', headers: { authorization: `Bearer ${h.key}` } });
      expect(nf.status).toBe(404);
      expect(errorCode(parseJson(nf.text))).toBe('not_found');
      const bad = await request({ port: h.port, path: '/v1/models', method: 'DELETE', headers: { authorization: `Bearer ${h.key}` } });
      expect(bad.status).toBe(405);
    } finally {
      await h.server.stop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 8. fixture 模式：真实可用的流式与非流式                                      */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · fixture 驱动器', () => {
  const body = (/** @type {Record<string, unknown>} */ extra = {}) => ({
    model: FIXTURE_MODEL_ID,
    messages: [
      { role: 'user', content: 'hello fixture' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'FIXTURE_MARKER_7b21' }
    ],
    ...extra
  });

  it('/v1/models 在 fixture 模式只列 fixture 模型，且 owned_by 标明是 fixture', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await request({ port: h.port, headers: { authorization: `Bearer ${h.key}` } });
      expect(res.status).toBe(200);
      const parsed = parseJson(res.text);
      expect(parsed.object).toBe('list');
      expect(parsed.data.length).toBe(1);
      expect(parsed.data[0].id).toBe(FIXTURE_MODEL_ID);
      expect(parsed.data[0].object).toBe('model');
      expect(typeof parsed.data[0].created).toBe('number');
      expect(parsed.data[0].owned_by).toContain('fixture');
      expect(header(res.headers, 'x-zcc-status')).toBe('ready');
      expect(header(res.headers, 'x-zcc-fixture')).toBe('true');
    } finally {
      await h.server.stop();
    }
  });

  it('非流式返回标准 chat.completion，内容确由 fixture 产生并在响应里标明 fixture', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await authed({ port: h.port, body: body() });
      expect(res.status).toBe(200);
      expect(header(res.headers, 'content-type')).toContain('application/json');
      expect(header(res.headers, 'x-zcc-fixture')).toBe('true');
      const parsed = parseJson(res.text);
      expect(parsed.object).toBe('chat.completion');
      expect(parsed.model).toBe(FIXTURE_MODEL_ID);
      expect(typeof parsed.created).toBe('number');
      expect(parsed.choices.length).toBe(1);
      expect(parsed.choices[0].index).toBe(0);
      expect(parsed.choices[0].message.role).toBe('assistant');
      expect(parsed.choices[0].finish_reason).toBe('stop');
      // 内容真的是 fixture 产生的：回显了 prompt 的最后一条 user 消息。
      expect(parsed.choices[0].message.content).toContain('FIXTURE_MARKER_7b21');
      expect(parsed.choices[0].message.content).toContain('FIXTURE');
      // 在 body 里标明 fixture。
      expect(parsed.zcc.fixture).toBe(true);
      expect(parsed.zcc.driver).toBe('fixture');
      expect(parsed.zcc.model_is_real).toBe(false);
    } finally {
      await h.server.stop();
    }
  });

  it('usage 是对实际产出做的真实计数（披露计数方法），不是编造的 token 数', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await authed({ port: h.port, body: body() });
      const parsed = parseJson(res.text);
      const content = parsed.choices[0].message.content;
      expect(parsed.usage.completion_tokens).toBe(countFixtureTokens(content));
      expect(parsed.usage.total_tokens).toBe(parsed.usage.prompt_tokens + parsed.usage.completion_tokens);
      expect(parsed.usage.prompt_tokens).toBeGreaterThan(0);
      expect(parsed.zcc.usage_method).toBe('fixture_whitespace_token_count');
    } finally {
      await h.server.stop();
    }
  });

  it('max_tokens 生效：截断后 finish_reason=length 且 completion_tokens 等于上限', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await authed({ port: h.port, body: body({ max_tokens: 4 }) });
      const parsed = parseJson(res.text);
      expect(parsed.choices[0].finish_reason).toBe('length');
      expect(parsed.usage.completion_tokens).toBe(4);
      expect(countFixtureTokens(parsed.choices[0].message.content)).toBe(4);
    } finally {
      await h.server.stop();
    }
  });

  it('流式返回标准 SSE chat.completion.chunk 序列并以 data: [DONE] 结束', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await authed({ port: h.port, headers: { 'x-zcc-session-id': 'sse-a' }, body: body({ stream: true }) });
      expect(res.status).toBe(200);
      expect(header(res.headers, 'content-type')).toContain('text/event-stream');
      expect(header(res.headers, 'x-zcc-fixture')).toBe('true');
      const lines = res.text.split('\n').filter((l) => l.startsWith('data: '));
      expect(lines.length).toBeGreaterThan(2);
      expect(lines[lines.length - 1]).toBe('data: [DONE]');
      expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
      const frames = lines.slice(0, -1).map((l) => JSON.parse(l.slice('data: '.length)));
      const id = header(res.headers, 'x-zcc-operation-id');
      for (const frame of frames) {
        expect(frame.object).toBe('chat.completion.chunk');
        expect(frame.id).toBe(id);
        expect(frame.model).toBe(FIXTURE_MODEL_ID);
      }
      expect(frames[0].choices[0].delta.role).toBe('assistant');
      const last = frames[frames.length - 1];
      expect(last.choices[0].finish_reason).toBe('stop');
      const streamed = frames.map((f) => f.choices[0]?.delta?.content ?? '').join('');
      expect(streamed.length).toBeGreaterThan(0);
      expect(streamed).toContain('FIXTURE_MARKER_7b21');
      // 流式拼接内容必须与非流式一致（同一驱动器、同一正文）。
      const nonStream = parseJson(
        (await authed({ port: h.port, headers: { 'x-zcc-session-id': 'sse-b' }, body: body() })).text
      );
      expect(streamed).toBe(nonStream.choices[0].message.content);
    } finally {
      await h.server.stop();
    }
  });

  it('stream_options.include_usage 才发 usage 帧，且该 usage 与非流式一致', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const without = await authed({ port: h.port, headers: { 'x-zcc-session-id': 'u-a' }, body: body({ stream: true }) });
      expect(without.text).not.toContain('"usage"');
      const withUsage = await authed({
        port: h.port,
        headers: { 'x-zcc-session-id': 'u-b' },
        body: body({ stream: true, stream_options: { include_usage: true } })
      });
      const frames = withUsage.text
        .split('\n')
        .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
        .map((l) => JSON.parse(l.slice('data: '.length)));
      const usageFrame = frames[frames.length - 1];
      expect(usageFrame.choices).toEqual([]);
      expect(usageFrame.usage.completion_tokens).toBeGreaterThan(0);
    } finally {
      await h.server.stop();
    }
  });

  it('是真正的流：分帧增量到达，首帧到达时驱动器尚未产出完毕', async () => {
    const done = { finished: false };
    const inner = createFixtureDriver({ chunkDelayMs: 40 });
    const driver = {
      ...inner,
      /** @param {import('../../packages/api/src/chat.js').DriverRequest} req */
      async *stream(req) {
        yield* inner.stream(req);
        done.finished = true;
      }
    };
    const h = await startServer({ driver });
    try {
      /** @type {{bytes: number, driverFinished: boolean}[]} */
      const arrivals = [];
      await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: h.port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: { authorization: `Bearer ${h.key}`, 'content-type': 'application/json' }
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            res.on('data', (c) => arrivals.push({ bytes: c.length, driverFinished: done.finished }));
            res.on('end', () => resolve(undefined));
            res.on('error', reject);
          }
        );
        req.on('error', reject);
        req.end(JSON.stringify(body({ stream: true })));
      });
      expect(arrivals.length).toBeGreaterThan(2);
      // 多次独立网络事件才拼出一个响应体 = 真流，不是"一次性倒出一整段"。
      const first = arrivals[0];
      const last = arrivals[arrivals.length - 1];
      expect(first?.driverFinished).toBe(false);
      expect(last?.driverFinished).toBe(true);
    } finally {
      await h.server.stop();
    }
  });

  it('客户端中途断开时取消驱动，不产生悬挂句柄', async () => {
    const h = await startServer({ driver: createFixtureDriver({ chunkDelayMs: 25 }) });
    try {
      await new Promise((resolve) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: h.port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: { authorization: `Bearer ${h.key}`, 'content-type': 'application/json' }
          },
          (res) => {
            res.on('data', () => res.destroy());
            res.on('close', () => resolve(undefined));
          }
        );
        req.on('error', () => resolve(undefined));
        req.end(JSON.stringify(body({ stream: true })));
      });
      await new Promise((r) => setTimeout(r, 80));
      expect(h.server.diagnostics.inFlight).toBe(0);
      expect(h.server.diagnostics.trackedSockets).toBe(0);
    } finally {
      await h.server.stop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 9. 优雅关闭                                                                */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · 优雅关闭', () => {
  /**
   * 基线必须在**本测试内、startServer 之前**取：start() 自己装 2 个信号监听器，
   * 验收标准是"回到基线"。不能在 describe 体里取——vitest 自己的 SIGINT 处理器
   * 在收集期和运行期数量不同，跨阶段取基线会把 runner 自己的监听器算进我们的账。
   */
  const baseline = () => ({ sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM') });

  it('stop() 后停止接受新连接，并回收 timer / listener / socket', async () => {
    const before = baseline();
    const h = await startServer({ driver: createFixtureDriver({ chunkDelayMs: 10 }) });
    await request({ port: h.port, headers: { authorization: `Bearer ${h.key}` } });
    expect(h.server.diagnostics.activeTimers).toBeGreaterThan(0);
    expect(h.server.diagnostics.signalListeners).toBe(2);
    // start() 装 1 个 SIGINT + 1 个 SIGTERM：每个信号各 +1，不是 +2。
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);

    await h.server.stop();

    expect(h.server.address()).toBeNull();
    expect(h.server.diagnostics.activeTimers).toBe(0);
    expect(h.server.diagnostics.trackedSockets).toBe(0);
    expect(h.server.diagnostics.signalListeners).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    await expect(request({ port: h.port, headers: { authorization: `Bearer ${h.key}` } })).rejects.toThrow();
  });

  it('关闭时在途请求有界收束：已开始写出的响应完整写完，stop 不掐断它', async () => {
    const h = await startServer({ driver: createFixtureDriver({ chunkDelayMs: 40 }) });
    try {
      const inflight = authed({ port: h.port, body: bodyOfFixture() });
      await new Promise((r) => setTimeout(r, 25));
      expect(h.server.diagnostics.inFlight).toBe(1);
      // 在请求仍在途时开始关闭：stop 必须等它收束，而不是掐断。
      const stopStartedAt = Date.now();
      const stopping = h.server.stop();
      const res = await inflight;
      const stopResult = await stopping;
      const stopMs = Date.now() - stopStartedAt;
      expect(stopResult.closed).toBe(true);
      expect(stopResult.timedOut).toBe(false);
      // 收束必须**有界且及时**：空闲长连接若不在收束后重收一次，close() 会一直等到
      // 客户端 keepAliveTimeout（实测 ~4.2s）。这条断言就是那个回归的守门。
      expect(stopMs, `stop() took ${stopMs}ms`).toBeLessThan(1500);
      expect(res.status).toBe(200);
      const parsed = parseJson(res.text);
      expect(parsed.object).toBe('chat.completion');
      expect(parsed.choices[0].message.content.length).toBeGreaterThan(0);
      expect(h.server.diagnostics.inFlight).toBe(0);
      expect(h.server.diagnostics.activeTimers).toBe(0);
    } finally {
      await h.server.stop();
    }
  });

  it('stop() 可重复调用且不抛异常', async () => {
    const before = baseline();
    const h = await startServer();
    await h.server.stop();
    await h.server.stop();
    expect(h.server.address()).toBeNull();
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
  });
});

/**
 * @returns {Record<string, unknown>}
 */
function bodyOfFixture() {
  return { model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content: 'inflight' }] };
}

/* -------------------------------------------------------------------------- */
/* 10b. model_is_real 从驱动器能力推导（禁硬编码）                                */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · model_is_real 由驱动器能力推导', () => {
  it('无驱动器（not_attached / no_quota）→ false，且一个模型都不列', () => {
    /** @type {('not_attached' | 'no_quota')[]} */
    const statuses = ['not_attached', 'no_quota'];
    for (const status of statuses) {
      const driver = createUnavailableDriver({ status });
      expect(deriveModelIsReal(driver), status).toBe(false);
      expect(driver.models, status).toEqual([]);
      expect(driver.catalog, status).toEqual(EMPTY_CATALOG);
      expect(deriveModelIsReal(driver), status).toBe(false);
    }
    // unavailable 驱动器的 fixture 也是 false：只按 fixture 判会把"无上游"误报成真实模型。
    expect(createUnavailableDriver({ status: 'no_quota' }).fixture).toBe(false);
  });

  it('fixture 驱动器 → false（内容是本地生成的假产出）', () => {
    const driver = createFixtureDriver();
    expect(driver.fixture).toBe(true);
    expect(deriveModelIsReal(driver)).toBe(false);
  });

  it('ready + 非 fixture + 确实列出了模型 → true（真实驱动器的接入位）', async () => {
    const driver = createRealStubDriver();
    expect(driver.status).toBe('ready');
    expect(driver.fixture).toBe(false);
    expect(driver.models.length).toBeGreaterThan(0);
    expect(deriveModelIsReal(driver)).toBe(true);
    // 走真实 HTTP：响应体里的 zcc.model_is_real 必须随之变成 true，而不是恒 false。
    const h = await startServer({ driver });
    try {
      const res = await authed({ port: h.port, body: bodyOfFixture() });
      expect(res.status).toBe(200);
      const parsed = parseJson(res.text);
      expect(parsed.zcc.fixture).toBe(false);
      expect(parsed.zcc.driver).toBe('real-stub');
      expect(parsed.zcc.model_is_real).toBe(true);
      // 同一判定也进了 SSE 帧的 zcc 块，两条路径同源。
      const streamed = await authed({
        port: h.port,
        headers: { 'x-zcc-session-id': 'real-stub-sse' },
        body: { ...bodyOfFixture(), stream: true }
      });
      const dataLines = streamed.text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
      expect(dataLines.length).toBeGreaterThan(0);
      const frame = JSON.parse(/** @type {string} */ (dataLines[0]).slice('data: '.length));
      expect(frame.zcc.model_is_real).toBe(true);
      // 模型也确实被列出（不是"声称真实却不给模型"）。
      const models = parseJson((await request({ port: h.port, headers: { authorization: `Bearer ${h.key}` } })).text);
      expect(models.data.length).toBe(1);
      expect(models.data[0].id).toBe('real-stub-model-1');
    } finally {
      await h.server.stop();
    }
  });

  it('判定向保守方向偏：ready + 非 fixture 但没有任何模型 → false', () => {
    expect(deriveModelIsReal({ status: 'ready', fixture: false, models: [] })).toBe(false);
    expect(deriveModelIsReal({ status: 'no_quota', fixture: false, models: [{ id: 'm' }] })).toBe(false);
    expect(deriveModelIsReal({ status: 'ready', fixture: true, models: [{ id: 'm' }] })).toBe(false);
  });

  it('fixture 模式的 chat 响应里 model_is_real 明确为 false（不得被推导成 true）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const parsed = parseJson((await authed({ port: h.port, body: bodyOfFixture() })).text);
      expect(parsed.zcc.fixture).toBe(true);
      expect(parsed.zcc.model_is_real).toBe(false);
    } finally {
      await h.server.stop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 10c. fixture 隔离回归钉                                                       */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · fixture 隔离（生产配置开不了假模型）', () => {
  it('生产配置挂 fixture 驱动器：构造期即拒，不等到请求进来才发现', () => {
    expect(() =>
      createApiServer({ enabled: true, apiKeys: [TEST_KEY], driver: createFixtureDriver() })
    ).toThrow(/FIXTURE_DRIVER_TEST_ONLY/);
    // 拒绝发生在 start() 之前：连端口都不曾被占用。
    expect(() =>
      createApiServer({ enabled: true, port: 0, apiKeys: [TEST_KEY], driver: createFixtureDriver() })
    ).toThrow(/FIXTURE_DRIVER_TEST_ONLY/);
  });

  it('显式给出测试令牌后 fixture 可用（测试路径本身没有被堵死）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await authed({ port: h.port, body: bodyOfFixture() });
      expect(res.status).toBe(200);
      expect(header(res.headers, 'x-zcc-fixture')).toBe('true');
    } finally {
      await h.server.stop();
    }
  });

  it('令牌是 symbol：配置文件 / JSON 在结构上表达不了它', () => {
    expect(typeof FIXTURE_TEST_TOKEN).toBe('symbol');
    const roundTripped = JSON.parse(JSON.stringify({ testOnlyFixtureToken: FIXTURE_TEST_TOKEN }));
    expect(roundTripped.testOnlyFixtureToken).toBeUndefined();
    // 就算有人从别处"抄"一个字符串或数字过来，也对不上 symbol。
    /** @type {unknown[]} */
    const forgeries = [String(FIXTURE_TEST_TOKEN), 1, true, null, 'zcc-fixture-test-token', {}, []];
    for (const fake of forgeries) {
      expect(() =>
        createApiServer(
          /** @type {any} */ ({ apiKeys: [TEST_KEY], driver: createFixtureDriver(), testOnlyFixtureToken: fake })
        )
      ).toThrow(/FIXTURE_DRIVER_TEST_ONLY/);
    }
  });

  it('配置键是闭集：任何未登记的键构造期即拒，fixture 类后门名全部进不来', () => {
    const backdoorKeys = [
      'fixture',
      'useFixture',
      'fixtureDriver',
      'allowFixture',
      'enableFixture',
      'fixtureMode',
      'testMode',
      'mock',
      'fake',
      'sandbox',
      'allowFakeModels',
      'testOnlyDriver'
    ];
    for (const key of backdoorKeys) {
      expect(
        () => createApiServer({ apiKeys: [TEST_KEY], driver: createUnavailableDriver({ status: 'no_quota' }), [key]: true }),
        `配置项 ${key} 必须被闭集校验拒绝`
      ).toThrow(/UNKNOWN_API_CONFIG_KEY/);
    }
    // 合法配置不受影响。
    expect(() => createApiServer({ apiKeys: [TEST_KEY], driver: createUnavailableDriver({ status: 'no_quota' }) })).not.toThrow();
  });

  it('API_SERVER_CONFIG_KEYS 精确等于钉死的键表（新增配置项必须显式改表并让本钉变红）', () => {
    expect([...API_SERVER_CONFIG_KEYS]).toEqual([
      'enabled',
      'host',
      'port',
      'apiKeys',
      'allowedOrigins',
      'rateLimit',
      'shutdownGraceMs',
      'driver',
      'testOnlyFixtureToken',
      'logger',
      'now',
      'journalDir',
      'journalMaxEntries',
      // ZCC-GUI-EVIDENCE-20261008-A：新增只读证据状态出口，**显式登记**。
      // 缺省即「无证据可报」，端点返回 evidence_not_captured 而不是伪造一份。
      'readStatus'
    ]);
    // 表里唯一与 fixture 有关的键必须是需要 symbol 的那一把。
    const fixtureish = API_SERVER_CONFIG_KEYS.filter((k) => k.toLowerCase().includes('fixture'));
    expect([...fixtureish]).toEqual(['testOnlyFixtureToken']);
  });
});

/* -------------------------------------------------------------------------- */
/* 10d. GET /v1/zcc/catalog                                                     */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · GET /v1/zcc/catalog', () => {
  it('端点路径就是协调者裁定的那个（UI02 客户端按此实现）', () => {
    expect(CATALOG_PATH).toBe('/v1/zcc/catalog');
  });

  it('无驱动器：200 + {revision:"none", models:[]}，状态头如实标注', async () => {
    /** @type {('not_attached' | 'no_quota')[]} */
    const statuses = ['not_attached', 'no_quota'];
    for (const status of statuses) {
      const h = await startServer({ driver: createUnavailableDriver({ status }) });
      try {
        const res = await request({ port: h.port, path: CATALOG_PATH, headers: { authorization: `Bearer ${h.key}` } });
        expect(res.status, status).toBe(200);
        expect(header(res.headers, 'content-type'), status).toContain('application/json');
        const parsed = parseJson(res.text);
        // 响应体严格只有两个键，不夹带任何其他字段。
        expect(Object.keys(parsed).sort(), status).toEqual(['models', 'revision']);
        expect(parsed.revision, status).toBe('none');
        expect(parsed.models, status).toEqual([]);
        expect(header(res.headers, 'x-zcc-status'), status).toBe(status);
        expect(header(res.headers, 'x-zcc-catalog-count'), status).toBe('0');
        expect(header(res.headers, 'x-zcc-fixture'), status).toBe('');
        // 绝不列占位假模型。
        expect(res.text, status).not.toMatch(/gpt|claude|qwen|deepseek/i);
      } finally {
        await h.server.stop();
      }
    }
  });

  it('fixture 驱动器：返回 fixture 条目，7 个契约字段齐全且类型正确', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await request({ port: h.port, path: CATALOG_PATH, headers: { authorization: `Bearer ${h.key}` } });
      expect(res.status).toBe(200);
      expect(header(res.headers, 'x-zcc-fixture')).toBe('true');
      expect(header(res.headers, 'x-zcc-catalog-count')).toBe('1');
      const parsed = parseJson(res.text);
      expect(Object.keys(parsed).sort()).toEqual(['models', 'revision']);
      expect(parsed.revision).toBe(FIXTURE_CATALOG_REVISION);
      expect(Array.isArray(parsed.models)).toBe(true);
      expect(parsed.models.length).toBe(1);
      const entry = parsed.models[0];
      // 字段集：不多不少，正好是契约的七个。
      expect(Object.keys(entry).sort()).toEqual([...CATALOG_MODEL_KEYS].sort());
      expect(typeof entry.modelId).toBe('string');
      expect(entry.modelId).toBe(FIXTURE_MODEL_ID);
      expect(typeof entry.displayName).toBe('string');
      expect(entry.displayName.trim().length).toBeGreaterThan(0);
      expect(typeof entry.provider).toBe('string');
      expect(CATALOG_BILLING_CLASSES).toContain(entry.billingClass);
      expect(entry.billingClass).toBe('unknown');
      expect(entry.contextLength).toBeNull();
      expect(Array.isArray(entry.reasoning)).toBe(true);
      expect(Array.isArray(entry.capabilities)).toBe(true);
      for (const tag of [...entry.reasoning, ...entry.capabilities]) expect(typeof tag).toBe('string');
      // fixture 条目一眼可辨，不会被误读成真实模型。
      expect(`${entry.displayName}${entry.provider}`.toLowerCase()).toContain('fixture');
    } finally {
      await h.server.stop();
    }
  });

  it('真实驱动器接入位：只换驱动器，目录端点形状不变、条目变成真实的', async () => {
    const h = await startServer({ driver: createRealStubDriver() });
    try {
      const res = await request({ port: h.port, path: CATALOG_PATH, headers: { authorization: `Bearer ${h.key}` } });
      expect(res.status).toBe(200);
      const parsed = parseJson(res.text);
      expect(Object.keys(parsed).sort()).toEqual(['models', 'revision']);
      expect(parsed.revision).toBe('real-stub-rev-1');
      expect(parsed.models.length).toBe(1);
      expect(Object.keys(parsed.models[0]).sort()).toEqual([...CATALOG_MODEL_KEYS].sort());
      expect(parsed.models[0].contextLength).toBe(8192);
    } finally {
      await h.server.stop();
    }
  });

  it('标准 /v1/models 仍是纯 OpenAI 形状：目录字段绝不混进去', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await request({ port: h.port, path: '/v1/models', headers: { authorization: `Bearer ${h.key}` } });
      expect(res.status).toBe(200);
      const parsed = parseJson(res.text);
      expect(Object.keys(parsed).sort()).toEqual(['data', 'object']);
      expect(parsed.object).toBe('list');
      expect(Object.keys(parsed.data[0]).sort()).toEqual(['created', 'id', 'object', 'owned_by']);
      for (const key of CATALOG_MODEL_KEYS) {
        expect(Object.keys(parsed.data[0]), `/v1/models 不含目录字段 ${key}`).not.toContain(key);
      }
    } finally {
      await h.server.stop();
    }
  });

  it('违反契约的目录（缺字段 / 类型错 / 非法枚举 / 重复 modelId）整体拒绝，不部分采纳', async () => {
    const goodEntry = {
      modelId: 'stub-a',
      displayName: '条目甲',
      provider: 'zcc-stub',
      billingClass: 'unknown',
      contextLength: null,
      reasoning: [],
      capabilities: []
    };
    /** @type {{label: string, catalog: unknown, expectDefect: string}[]} */
    const cases = [
      { label: '缺 capabilities', catalog: { revision: 'r', models: [{ ...goodEntry, capabilities: undefined }].map(stripUndefined) }, expectDefect: 'capabilities' },
      { label: 'billingClass 类型错', catalog: { revision: 'r', models: [{ ...goodEntry, billingClass: 42 }] }, expectDefect: 'billingClass' },
      { label: 'billingClass 非法枚举', catalog: { revision: 'r', models: [{ ...goodEntry, billingClass: 'freemium' }] }, expectDefect: 'billingClass' },
      { label: 'contextLength 类型错', catalog: { revision: 'r', models: [{ ...goodEntry, contextLength: '8192' }] }, expectDefect: 'contextLength' },
      { label: 'displayName 空串', catalog: { revision: 'r', models: [{ ...goodEntry, displayName: '   ' }] }, expectDefect: 'displayName' },
      { label: 'reasoning 非字符串数组', catalog: { revision: 'r', models: [{ ...goodEntry, reasoning: [1] }] }, expectDefect: 'reasoning' },
      { label: '重复 modelId', catalog: { revision: 'r', models: [goodEntry, { ...goodEntry, displayName: '条目乙' }] }, expectDefect: 'modelId' },
      { label: '多出未登记字段', catalog: { revision: 'r', models: [{ ...goodEntry, secretQuota: 3 }] }, expectDefect: 'secretQuota' },
      { label: 'revision 空串', catalog: { revision: '  ', models: [goodEntry] }, expectDefect: 'revision' },
      { label: 'models 不是数组', catalog: { revision: 'r', models: {} }, expectDefect: 'models' }
    ];
    for (const c of cases) {
      const defects = catalogContractDefects(c.catalog);
      expect(defects.length, `${c.label} 必须被判违规`).toBeGreaterThan(0);
      expect(defects.join(','), c.label).toContain(c.expectDefect);
    }
    // 端到端：违规目录 → 503，且响应体里一个条目都不带（不部分采纳）。
    for (const c of cases) {
      const driver = { ...createFixtureDriver(), catalog: c.catalog };
      const h = await startServer({ driver });
      try {
        const res = await request({ port: h.port, path: CATALOG_PATH, headers: { authorization: `Bearer ${h.key}` } });
        expect(res.status, c.label).toBe(503);
        expect(errorCode(parseJson(res.text)), c.label).toBe('upstream_unavailable');
        const parsed = parseJson(res.text);
        expect(parsed.models, `${c.label} 不得泄露任何目录条目`).toBeUndefined();
        expect(parsed.error.detail, c.label).toBeUndefined();
        expect(parsed.zcc_error.detail.catalog_contract_violation, c.label).toBe(true);
        expect(parsed.zcc_error.delivery, c.label).toBe('not_submitted');
        expect(h.logs.some((l) => l.includes('event=catalog_contract_violation')), c.label).toBe(true);
      } finally {
        await h.server.stop();
      }
    }
  });

  it('合法目录通过自检：catalogContractDefects 对自身产出的 fixture 目录为空', () => {
    expect(catalogContractDefects(createFixtureCatalog())).toEqual([]);
    expect(catalogContractDefects(EMPTY_CATALOG)).toEqual([]);
    expect(catalogContractDefects(createRealStubDriver().catalog)).toEqual([]);
  });

  it('目录契约与 I04 的计费类别取值集合一致（两边不许分叉）', () => {
    expect([...CATALOG_BILLING_CLASSES].sort()).toEqual([...BILLING_CLASSES].sort());
  });

  it('方法、认证与限流与另外两条路径同一套门：POST 405 / 无 key 401', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const noKey = await request({ port: h.port, path: CATALOG_PATH });
      expect(noKey.status).toBe(401);
      expect(errorCode(parseJson(noKey.text))).toBe('unauthorized');
      expect(header(noKey.headers, 'www-authenticate')).toBe('Bearer');

      const post = await authed({ port: h.port, path: CATALOG_PATH, method: 'POST', body: {} });
      expect(post.status).toBe(405);
      expect(errorCode(parseJson(post.text))).toBe('method_not_allowed');

      const limited = await startServer({ driver: createFixtureDriver(), rateLimit: { maxConcurrent: 4, requests: 1, windowMs: 60_000 } });
      try {
        const first = await request({ port: limited.port, path: CATALOG_PATH, headers: { authorization: `Bearer ${limited.key}` } });
        expect(first.status).toBe(200);
        const second = await request({ port: limited.port, path: CATALOG_PATH, headers: { authorization: `Bearer ${limited.key}` } });
        expect(second.status).toBe(429);
        expect(errorCode(parseJson(second.text))).toBe('rate_limited');
      } finally {
        await limited.server.stop();
      }
    } finally {
      await h.server.stop();
    }
  });

  it('未知路径 404 的提示里带上三条真实路径（不藏着 catalog）', async () => {
    const h = await startServer({ driver: createFixtureDriver() });
    try {
      const res = await request({ port: h.port, path: '/v1/nope', headers: { authorization: `Bearer ${h.key}` } });
      expect(res.status).toBe(404);
      const message = parseJson(res.text).error.message;
      expect(message).toContain('/v1/models');
      expect(message).toContain(CATALOG_PATH);
      expect(message).toContain('/v1/chat/completions');
    } finally {
      await h.server.stop();
    }
  });
});

/**
 * 去掉值为 `undefined` 的键（用于构造"缺字段"的目录条目）。
 * @param {Record<string, unknown>} entry
 * @returns {Record<string, unknown>}
 */
function stripUndefined(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
}

/* -------------------------------------------------------------------------- */
/* 10. 纯函数与常量                                                            */
/* -------------------------------------------------------------------------- */

describe('API01 本机 API · 纯函数与错误表', () => {
  it('canonicalRequestHash 对键序不敏感、对内容敏感', () => {
    const a = canonicalRequestHash({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: false });
    const b = canonicalRequestHash({ stream: false, messages: [{ role: 'user', content: 'x' }], model: 'm' });
    const c = canonicalRequestHash({ model: 'm', messages: [{ role: 'user', content: 'y' }], stream: false });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('SseBudget 对单帧 2MiB 与累计 4MiB 上限都拒', () => {
    const budget = new SseBudget();
    budget.write('a'.repeat(10));
    expect(budget.frames).toBe(1);
    expect(() => budget.write('b'.repeat(SSE_FRAME_MAX_BYTES + 1))).toThrow(/SSE_FRAME_TOO_LARGE/);
    const big = new SseBudget();
    expect(() => {
      for (let i = 0; i < 20; i += 1) big.write('c'.repeat(SSE_FRAME_MAX_BYTES - 16));
    }).toThrow(/SSE_BUFFER_TOO_LARGE/);
    expect(STREAM_BUFFER_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(SSE_FRAME_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it('错误表：每个 ApiErrorCode 都有唯一 4xx/5xx 语义与合同映射', () => {
    const seen = new Map();
    for (const [code, spec] of Object.entries(API_ERROR_SPECS)) {
      expect(typeof spec.status, code).toBe('number');
      expect(spec.status >= 400 && spec.status < 600, `${code}=${spec.status}`).toBe(true);
      expect(['not_submitted', 'submitted_rejected', 'outcome_unknown'], code).toContain(spec.delivery);
      expect(typeof spec.contractCode, code).toBe('string');
      const key = `${spec.status}|${code}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.set(key, code);
    }
    expect(API_ERROR_SPECS.unauthorized.status).toBe(401);
    expect(API_ERROR_SPECS.rate_limited.status).toBe(429);
    expect(API_ERROR_SPECS.idempotency_conflict.status).toBe(409);
    expect(API_ERROR_SPECS.payload_too_large.status).toBe(413);
    expect(API_ERROR_SPECS.unsupported_role.status).toBe(422);
    expect(API_ERROR_SPECS.unknown_field.status).toBe(400);
    expect(API_ERROR_SPECS.upstream_unavailable.status).toBe(503);
  });

  it('ApiError 的 detail 会剔除凭据字段与凭据样式值，key 不会进错误体', () => {
    const err = new ApiError('unauthorized', '需要本机 API key', {
      apiKey: 'sk-should-never-appear-1234567890',
      note: 'plain'
    });
    const companion = err.toCompanionError(new Date().toISOString());
    expect(companion.detail.apiKey).toBeUndefined();
    expect(companion.detail.note).toBe('plain');
    const body = JSON.stringify(err.toBody(new Date().toISOString()));
    expect(body).not.toContain('sk-should-never-appear');
    const result = validateCompanionError(err.toBody(new Date().toISOString()).zcc_error);
    expect(result.ok, JSON.stringify(result.ok ? {} : result.issues)).toBe(true);
  });

  it('未知错误码构造时立即抛错（fail-closed，不静默降级成 500）', () => {
    // @ts-expect-error 故意传合同外的错误码：必须构造期就抛，不能静默降级。
    expect(() => new ApiError('not_a_real_code', 'x')).toThrow(/UNKNOWN_API_ERROR_CODE/);
  });

  it('truncateToFixtureTokens 截断后 token 数正好等于上限', () => {
    const text = 'a b c d e f g h';
    expect(truncateToFixtureTokens(text, 3)).toEqual({ text: 'a b c', truncated: true });
    expect(countFixtureTokens(truncateToFixtureTokens(text, 3).text)).toBe(3);
    expect(truncateToFixtureTokens(text, 99)).toEqual({ text, truncated: false });
    expect(countFixtureTokens('')).toBe(0);
  });
});
