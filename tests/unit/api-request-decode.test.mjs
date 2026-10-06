/**
 * ZC-12 / F01：非法百分号编码的请求路径**不得**终止 API 进程。
 *
 * Provider-free：零网络外联、零官方进程、零数据库、零模型请求、零子进程。
 * 只监听 127.0.0.1 的临时端口（`port: 0`），`afterAll` 里有界优雅关闭。
 *
 * ## 缺陷事实（源码位置以 disk 为准，不是报告行号）
 * `packages/api/src/server.ts` 的 `requestListener` 原来在 **try 块之外**、且在
 * `passNetworkGates()` **之前**执行 `decodeURIComponent(req.url 的 path 部分)`。
 * `/%` 与 `/%ZZ` 让 `decodeURIComponent` 抛 `URIError`；该异常既不进请求 try，
 * 也还没走到 Host/Origin/Bearer 任何一道门，于是**不需要任何 API key** 的直连
 * 就能让 API 进程退出（`exit.code=1`，栈落在该行，经 `parserOnIncoming` 抛出）。
 * 只有查询串里的 `%` 不触发（path 部分被 `split('?')[0]` 切掉了）。
 *
 * `apps/desktop/lib/app-protocol.cjs` 的 `app://` 分支有自己的
 * `PATH_UNDECODABLE` 防护且一直有效——被直连 HTTP 绕开的是**另一个入口**，
 * 所以本卡只改 `server.ts`，并把 `app://` 入口作为**对照**钉住它没被牵动。
 *
 * ## 为什么全套共用一个 server 实例
 * 验收要求的是「**同一进程**随后对正常无认证请求仍返回 401、Host/Origin 拒绝仍 403」。
 * 进程存活这件事只能在**同一个实例**上观察，所以这里用 `beforeAll`/`afterAll`
 * 启停一次（`afterAll` 的用法与 `tests/unit/desktop-app-protocol.test.mjs` 一致），
 * 而不是每个用例各起一个。若 F01 未修，第一条非法路径请求就会终结 worker，
 * 后面的 401/403 断言根本无从执行——这正是本卡要的「红」。
 *
 * ## 红态的判读口径（别把崩溃误当成别的）
 * 修复前跑本文件，vitest worker 会被 `URIError: URI malformed` 打死，
 * 栈指向 `packages/api/src/server.ts` 的解码行。那**就是 F01 本身**，
 * 不是 setup 错误、不是超时、不是缺 fixture：请求构造已被同文件的
 * 「合法编码路径仍正常解码」「查询串含 % 仍走 401」两组用例独立钉住。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiServer, FIXTURE_TEST_TOKEN } from '../../packages/api/src/server.js';
import { createUnavailableDriver } from '../../packages/api/src/chat.js';
import { API_ERROR_CODES, API_ERROR_SPECS } from '../../packages/api/src/errors.js';
import { validateCompanionError } from '../../packages/contracts/src/errors.js';
import { reasonOf } from '../helpers/desktop-harness.mjs';

const require = createRequire(import.meta.url);
const { routeAppRequest } = require('../../apps/desktop/lib/app-protocol.cjs');

/** 测试专用 key。**不是**任何真实凭据，只存在于本进程内；断言里搜它，输出里绝不允许出现。 */
const TEST_KEY = 'zcc_decode_test_key_0123456789abcdefghij';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * 单请求硬上限。
 *
 * 超时**不 reject**：未修复前服务端对非法路径不回任何响应，连接就那么挂着；
 * 若让夹具在这里抛 `HARNESS_TIMEOUT`，红就会变成一条超时失败而不是
 * `expect(res.status).toBe(400)` 失败——那正是 §8 禁止的「把超时记成抓到缺陷」。
 * 所以超时被记成**被观测到的结果**（`status:0` + `timedOut:true`），
 * 目标断言照常照打，红就落在真正要钉的那条线上。
 */
const REQUEST_TIMEOUT_MS = 5_000;

/* -------------------------------------------------------------------------- */
/* HTTP 小工具（沿用 tests/contract/api-contract.test.mjs 的装配形态）             */
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
 * @property {number} status 0 = 没拿到任何响应行（超时或传输层断开）。
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {string} text
 * @property {boolean} timedOut 夹具硬上限触发。
 * @property {string} transportError 传输层错误码（如 `ECONNRESET`），空串表示无。
 */

/**
 * 发一条**未认证**的请求（除非显式给出 authorization）。
 * `path` 逐字进请求行，不做任何客户端侧归一化——否则测的就不是服务端解码了。
 *
 * 本函数**永不 reject**：每一次结果（包括超时与断连）都是一次被观测到的响应事实，
 * 失败由调用方的目标断言表达，而不是由夹具抛错代劳。
 *
 * @param {{port: number, method?: string, path?: string, headers?: Record<string, string>, body?: unknown}} opts
 * @returns {Promise<Res>}
 */
function request(opts) {
  const headers = { ...(opts.headers ?? {}) };
  /** @type {Buffer | undefined} */
  let payload;
  if (opts.body !== undefined) {
    payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
    if (header(headers, 'content-length') === '') headers['content-length'] = String(payload.length);
  }
  return new Promise((resolve) => {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    let settled = false;
    /** @param {Res} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    const req = http.request(
      { host: '127.0.0.1', port: opts.port, path: opts.path ?? '/v1/models', method: opts.method ?? 'GET', headers },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          finish({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            timedOut: false,
            transportError: ''
          });
        });
      }
    );
    timer = setTimeout(() => {
      req.destroy();
      finish({ status: 0, headers: {}, text: '', timedOut: true, transportError: '' });
    }, REQUEST_TIMEOUT_MS);
    // 只做类型标注：@types/node 把 `ClientRequest` 的 error 监听器参数标成 `Error`，
    // 而传输层错误码（如 `ECONNRESET`）只挂在 `NodeJS.ErrnoException.code` 上。
    // 下面的表达式一字未改——`code` 仍是可选 `string`，`typeof` 判定与取值语义完全一致，
    // 不涉及任何断言、阈值或测试语义。
    req.on('error', (/** @type {NodeJS.ErrnoException} */ e) => {
      finish({
        status: 0,
        headers: {},
        text: '',
        timedOut: false,
        transportError: typeof e.code === 'string' ? e.code : e.message
      });
    });
    req.end(payload);
  });
}

/**
 * @param {Res} res
 * @returns {any}
 */
function parseJson(res) {
  return JSON.parse(res.text);
}

/**
 * @param {Res} res
 * @returns {string}
 */
function errorCode(res) {
  return String(parseJson(res).error?.code ?? '');
}

/**
 * 按仓内既有口径校验 `zcc_error`（见 `api-contract.test.mjs` 的同名校验）：
 * `validateCompanionError` 返回 `ValidationResult`——`{ok,value}` / `{ok:false,issues}`，
 * **不是** boolean。返回校验通过后的 `zcc_error` 本身，供调用方继续逐字段钉。
 *
 * @param {any} body
 * @returns {any}
 */
function expectValidCompanionError(body) {
  const result = validateCompanionError(body.zcc_error);
  expect(result.ok, JSON.stringify(result.ok ? {} : result.issues)).toBe(true);
  return body.zcc_error;
}

/* -------------------------------------------------------------------------- */
/* 服务器夹具：沿用 api-contract 的 startServer，端口 0、收集日志、优雅关闭          */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} Harness
 * @property {number} port
 * @property {import('../../packages/api/src/server.js').ApiServer} server
 * @property {string[]} logs
 */

/** @type {Harness} */
let harness;

/** 坏的 Host 头：名字不在 `ALLOWED_HOST_NAMES` 内，DNS rebinding 形态。 */
const BAD_HOST = 'evil.example:8790';
/** 默认 `allowedOrigins` 为空，任何 Origin 头都必须被拒。 */
const BAD_ORIGIN = 'http://evil.example';
/** 出现在原始路径里的唯一标记；响应体与日志都**不允许**回显它（§4.10）。 */
const ECHO_CANARY = 'CANARY_9f3a_do_not_echo';

beforeAll(async () => {
  /** @type {string[]} */
  const logs = [];
  const server = createApiServer({
    enabled: true,
    port: 0,
    apiKeys: [TEST_KEY],
    driver: createUnavailableDriver({ status: 'no_quota' }),
    // 仅测试：本助手允许换任何驱动器，所以总是带上测试令牌（生产配置拿不到这个 symbol）。
    testOnlyFixtureToken: FIXTURE_TEST_TOKEN,
    logger: {
      info: (/** @type {string} */ line) => logs.push(line),
      warn: (/** @type {string} */ line) => logs.push(line),
      error: (/** @type {string} */ line) => logs.push(line)
    }
  });
  const started = await server.start();
  if (!started.started || started.port === undefined) {
    throw new Error(`server did not start: ${JSON.stringify(started)}`);
  }
  harness = { port: started.port, server, logs };
});

afterAll(async () => {
  await harness.server.stop();
});

/* -------------------------------------------------------------------------- */
/* 1. 缺陷靶点：非法百分号编码必须变成 400，而不是一次进程退出                       */
/* -------------------------------------------------------------------------- */

describe('ZC-12 · F01 非法百分号编码路径不得终止 API 进程', () => {
  it('靶点 1：GET /% 返回 400（解码失败不得抛出 URIError）', async () => {
    const res = await request({ port: harness.port, path: '/%' });
    expect(res.status).toBe(400);
    // 次级加固：拿到 400 本身就证明连接被正常收束，不是靠超时或断连蒙混过关。
    expect(res.timedOut).toBe(false);
    expect(res.transportError).toBe('');
    const body = parseJson(res);
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.param).toBeNull();
    // 走的是既有合同映射：contract_violation / not_submitted / 不自动重发，
    // 不是为这条 400 另造的一具错误体。
    const companion = expectValidCompanionError(body);
    expect(companion.code).toBe('contract_violation');
    expect(companion.delivery).toBe('not_submitted');
    expect(companion.retry.autoResendAllowed).toBe(false);
    expect(companion.retry.requiresExplicitHumanDecision).toBe(true);
  });

  it('靶点 2：GET /%ZZ 返回 400（解码失败不得抛出 URIError）', async () => {
    const res = await request({ port: harness.port, path: '/%ZZ' });
    expect(res.status).toBe(400);
    expect(res.timedOut).toBe(false);
    expect(res.transportError).toBe('');
    const body = parseJson(res);
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.param).toBeNull();
    const companion = expectValidCompanionError(body);
    expect(companion.code).toBe('contract_violation');
    expect(companion.delivery).toBe('not_submitted');
    expect(companion.retry.autoResendAllowed).toBe(false);
    expect(companion.retry.requiresExplicitHumanDecision).toBe(true);
  });

  it('接口约束：400 复用既有 invalid_request，不新增 errors.ts 的 code', async () => {
    // 逐条相等，而不是「至少包含」：卡上写死「不新增 errors.ts 的 code」，
    // 有人往 API_ERROR_CODES 里塞新码必须让本钉变红。
    expect([...API_ERROR_CODES]).toEqual([
      'host_not_allowed',
      'origin_not_allowed',
      'unauthorized',
      'not_found',
      'method_not_allowed',
      'invalid_json',
      'invalid_request',
      'unknown_field',
      'unsupported_role',
      'unsupported_content_type',
      'unsupported_parameter',
      'model_not_found',
      'payload_too_large',
      'rate_limited',
      'idempotency_conflict',
      'idempotency_in_progress',
      'idempotency_replay_unavailable',
      'server_not_enabled',
      'upstream_unavailable',
      'upstream_timeout',
      'upstream_outcome_unknown',
      'internal_error'
    ]);
    expect(API_ERROR_SPECS.invalid_request.status).toBe(400);
    expect(API_ERROR_SPECS.invalid_request.contractCode).toBe('contract_violation');
    expect(API_ERROR_SPECS.invalid_request.delivery).toBe('not_submitted');
    expect(API_ERROR_SPECS.invalid_request.type).toBe('invalid_request_error');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 进程存活：受控 400 之后，同一实例仍按原有 401/403 语义应答                      */
/* -------------------------------------------------------------------------- */

describe('ZC-12 · F01 受控 400 之后同一进程仍存活', () => {
  it('存活：受控 400 之后无认证请求仍 401，且驱动器零调用', async () => {
    const res = await request({ port: harness.port, path: '/v1/models' });
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe('unauthorized');
    expect(header(res.headers, 'www-authenticate')).toBe('Bearer');
    // 驱动器一次都没被碰到：401 是认证门给出的，不是业务处理的副产品。
    expect(harness.server.diagnostics.driverCalls).toBe(0);
  });

  it('存活：受控 400 之后 Host 拒绝仍 403 host_not_allowed', async () => {
    const res = await request({ port: harness.port, path: '/v1/models', headers: { host: BAD_HOST } });
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('host_not_allowed');
  });

  it('存活：受控 400 之后 Origin 拒绝仍 403 origin_not_allowed', async () => {
    const res = await request({ port: harness.port, path: '/v1/models', headers: { origin: BAD_ORIGIN } });
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('origin_not_allowed');
  });

  it('fresh-eyes 口径：未认证连接器连打 5 次都稳定拿到 400，不是断连', async () => {
    // 卡上的 fresh-eyes gate 要求「未认证连接器重放，稳定拿到 400 而不是断连」。
    // 本卡明令不派子代理，所以把它的实质直接编码成断言：同一个未认证连接器
    // （从不带 Authorization）连打 5 次，每次都必须是**收到响应行的 400**，
    // 而不是超时或传输层错误；打完之后进程还得继续服务。
    /** @type {number[]} */
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await request({ port: harness.port, path: '/%' });
      seen.push(res.status);
      expect(res.timedOut).toBe(false);
      expect(res.transportError).toBe('');
    }
    expect(seen).toEqual([400, 400, 400, 400, 400]);
    const after = await request({ port: harness.port, path: '/v1/models' });
    expect(after.status).toBe(401);
    expect(harness.server.diagnostics.driverCalls).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. 负例：解码边界、认证门顺序、app:// 入口都不得被牵动                          */
/* -------------------------------------------------------------------------- */

describe('ZC-12 · F01 负例与对照', () => {
  it('负例（查询串含 % 不受影响）：?q=% 仍按认证门走 401，不是 400', async () => {
    const res = await request({ port: harness.port, path: '/v1/models?q=%' });
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe('unauthorized');
  });

  it('负例（合法编码不误伤）：%2F 照常解码，路由与未解码前一致', async () => {
    // 解码后是 /v1/models → 命中路由 → 认证门给 401。
    // 如果解码被误伤成 400，这里会拿到 400；如果根本没解码，会拿到 404。
    const res = await request({ port: harness.port, path: '/v1%2Fmodels' });
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe('unauthorized');
  });

  it('负例（解码值仍用于路由匹配）：编码后的未知路径仍是 404 且带解码后 path', async () => {
    const res = await request({ port: harness.port, path: '/v1%2Fdefinitely-unknown' });
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe('not_found');
    expect(parseJson(res).error.message).toContain('/v1/definitely-unknown');
  });

  it('负例（认证门顺序不变）：Host 门先于认证门——坏 Host 持不持 key 都是 403', async () => {
    const anon = await request({ port: harness.port, path: '/v1/models', headers: { host: BAD_HOST } });
    expect(anon.status).toBe(403);
    expect(errorCode(anon)).toBe('host_not_allowed');

    const withKey = await request({
      port: harness.port,
      path: '/v1/models',
      headers: { host: BAD_HOST, authorization: `Bearer ${TEST_KEY}` }
    });
    expect(withKey.status).toBe(403);
    expect(errorCode(withKey)).toBe('host_not_allowed');
    // 认证门根本没走到：合法 key 也没被拿去比对或登记。
    expect(harness.server.diagnostics.driverCalls).toBe(0);
  });

  it('负例（认证门先于业务处理）：无认证 chat 是 401 而不是驱动器缺席的 503', async () => {
    const res = await request({
      port: harness.port,
      method: 'POST',
      path: '/v1/chat/completions',
      body: { model: 'any-model', messages: [{ role: 'user', content: 'hi' }] }
    });
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe('unauthorized');
    expect(harness.server.diagnostics.driverCalls).toBe(0);
  });

  it('对照（app:// 入口行为不变）：app-protocol 仍回 PATH_UNDECODABLE', async () => {
    // 另一个入口的防护一直有效，本卡不得牵动它，也不得把它当成 F01 的修复。
    const decision = routeAppRequest(`app://local/${ECHO_CANARY}%ZZ`, { distRoot: join(ROOT, 'apps', 'ui', 'dist') });
    expect(decision.kind).toBe('reject');
    expect(reasonOf(decision)).toBe('PATH_UNDECODABLE');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. §4.10 边界：修 F01 不得顺手把不受信任的原始路径写进响应体或日志              */
/* -------------------------------------------------------------------------- */

describe('ZC-12 · F01 错误信息面不得扩大', () => {
  it('§4.10：400 的响应体与日志都不回显不受信任的原始路径', async () => {
    const res = await request({ port: harness.port, path: `/%ZZ${ECHO_CANARY}` });
    expect(res.status).toBe(400);
    expect(res.timedOut).toBe(false);
    expect(errorCode(res)).toBe('invalid_request');
    // 响应体里只有固定说明，没有任何原始路径字节。
    expect(res.text).not.toContain(ECHO_CANARY);
    expect(parseJson(res).error.param).toBeNull();
    // 日志同理：这条 400 的日志不得为了「好排查」把原始路径原样写出。
    expect(harness.logs.join('\n')).not.toContain(ECHO_CANARY);
    // 并且这条请求确实被记账了（不是静默丢连接）。
    expect(harness.logs.join('\n')).toContain('code=invalid_request');
  });

  it('凭据形态不进日志：全程日志不含本测试的 key', () => {
    expect(harness.logs.join('\n')).not.toContain(TEST_KEY);
  });
});
