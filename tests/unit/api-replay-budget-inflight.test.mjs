/**
 * ZC-13 / F02：重放预算淘汰**不得删除仍在执行的幂等登记**。
 *
 * Provider-free：零网络外联、零官方进程、零数据库、零模型请求、零子进程。
 * 只监听 127.0.0.1 的临时端口（`port: 0`），`afterAll` 有界优雅关闭。
 *
 * ## 缺陷事实（源码位置以 disk 为准，不是卡上的报告行号）
 * `packages/api/src/server.ts` 的 `commitReplay` 里，预算淘汰原来只按
 * `operations.keys()` 的**插入顺序**取最旧条目逐出，**从不看 `state`**：
 *
 *     while (replayBytes > REPLAY_STORE_MAX_BYTES || operations.size > MAX_IDEMPOTENCY_ENTRIES) {
 *       const oldest = operations.keys().next();
 *       …
 *       operations.delete(oldest.value);
 *     }
 *
 * `Map` 的迭代序 = 登记序 = **请求到达序**。于是预算一旦被顶破，最旧的那条
 * 若是一条 `in_flight`（驱动器还在跑）登记，它就被删掉了：
 *  - `commitReplay` 里的 `current === entry` 只保护**提交**（防止把 A 的产出
 *    写进 B 的槽），**不保护在途登记**——登记没了，下一个同作用域请求照样查不到；
 *  - 查不到 → 走「新 operation」分支 → **第二次进入驱动器** → 同一键两次 200、
 *    `x-zcc-operation-id` 不同 → 上游额度被重复消耗。
 *
 * ## 卡上实测口径的复现条件（本文件逐条**校验**而不是假定）
 * `REPLAY_STORE_MAX_BYTES = 32MiB = 33554432`。第 1 号用例把实际响应体字节数
 * 测出来，再断言 `8 × b ≤ 33554432 < 9 × b`——这正是卡上「8 条 4000000 字符
 * 响应后 replayBytes=32004896（仍 < 预算）、第 9 条顶到 36005508 才触发淘汰」
 * 的那条边界。任一侧不成立就是夹具口径错了，红不得记成抓到缺陷。
 *
 * ## 为什么「负例(c) 结算早于淘汰」只能静态钉（这是口径，不是回避）
 * 卡上要求「淘汰顺序被破坏时（`commitReplay` 早于 `state=done`）必须红，
 * 补一条针对该顺序的断言」。在当前两个常量下**没有可行的实弹见证**：
 *  - 字节面：单条响应被 `STREAM_BUFFER_MAX_BYTES`（4MiB）钉死 < 预算 32MiB，
 *    所以「刚提交的这条是唯一有字节的条目」不可能出现 → 结算早晚不改变淘汰对象；
 *  - 条目面：`MAX_IDEMPOTENCY_ENTRIES = 512`，要构造「其余全不可释放」需 512 条
 *    在途登记 = 512 条并发阻塞请求；本机实测并发连接约 232 条即饱和（10s 未接满）。
 * 因此这里用**源码顺序断言**钉这条不变量：结算（`state = 'done'`）必须写在
 * `evictReplayOverflow()` 之前。变异「把淘汰提到结算之前」→ 本断言变红。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiServer, FIXTURE_TEST_TOKEN } from '../../packages/api/src/server.js';
import { createFixtureCatalog } from '../../packages/api/src/chat.js';

/** 测试专用 key。**不是**任何真实凭据，只存在于本进程内；断言里搜它，输出里绝不允许出现。 */
const TEST_KEY = 'zcc_replay_budget_inflight_test_key_0123456789abcdef';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SERVER_TS = join(ROOT, 'packages', 'api', 'src', 'server.ts');

/** 预算面常量，逐字取自 `server.ts`（卡上实测即按这组数复现）。 */
const REPLAY_STORE_MAX_BYTES = 32 * 1024 * 1024;
/** 压力响应条数：8 条压不满预算，第 9 条压满。 */
const PRESSURE_COUNT = 8;
/**
 * 卡上实测的单条响应体字节数是 4000612（4000000 字符 + JSON 开销 612）。
 * **本文件不钉这个数**，因为它取决于夹具驱动器的 `usage`/`finish` 事件形状，
 * 换夹具就会漂——那属于夹具漂移，不是缺陷。真正必须成立的是**复现条件**本身，
 * 它在用例里逐条实测断言：`8 × b ≤ 33554432 < 9 × b`。
 * 本夹具（`usageMethod:'test_fixed_count'`）实测 `b = 4000679`，
 * 两侧条件同样成立（8b=32005432、9b=36006111）。
 */
const BIG_BODY_BYTES_UPPER_BOUND = 4_000_612;

/** 探针作用域的幂等键（形状须过 `IDEMPOTENCY_TOKEN_SHAPE`）。 */
const INFLIGHT_KEY = 'replay-budget-inflight-probe';
const BLOCKED_MODEL = 'probe-blocked';
const BIG_MODEL = 'probe-big';

/** 单请求硬上限。超时**不 reject**：超时是被观测结果，失败由目标断言表达。 */
const REQUEST_TIMEOUT_MS = 8_000;

/* -------------------------------------------------------------------------- */
/* HTTP 小工具                                                                  */
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
 * 发一条请求并等响应行。**永不 reject**：每一次结果（含超时与断连）都是一次
 * 被观测到的响应事实，失败由调用方的目标断言表达，而不是由夹具抛错代劳。
 *
 * @param {{port: number, method?: string, path?: string, headers?: Record<string, string>, body?: unknown, timeoutMs?: number}} opts
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
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path ?? '/v1/chat/completions',
        method: opts.method ?? 'POST',
        headers
      },
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
    timer = setTimeout(
      () => {
        req.destroy();
        finish({ status: 0, headers: {}, text: '', timedOut: true, transportError: '' });
      },
      opts.timeoutMs ?? REQUEST_TIMEOUT_MS
    );
    // 只做类型标注：@types/node 把监听器参数标成 `Error`，而传输层错误码
    // （如 `ECONNRESET`）只挂在 `NodeJS.ErrnoException.code` 上。
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
 * 幂等作用域请求的公共头。`Idempotency-Key` 是 OpenAI 惯例（`auth.ts` 里优先于
 * `x-zcc-session-id`），作用域 = key + key 指纹，所以同键即同作用域。
 *
 * @param {string} key
 * @returns {Record<string, string>}
 */
function idemHeaders(key) {
  return { authorization: `Bearer ${TEST_KEY}`, 'idempotency-key': key };
}

/**
 * 同一体：`normalizedRequestHash` 必须逐字相同，否则重试会先撞
 * `idempotency_conflict` 而不是 `idempotency_in_progress`，测的就不是同一件事。
 *
 * @param {string} model
 * @returns {{model: string, messages: {role: string, content: string}[], stream: boolean}}
 */
function chatBody(model) {
  return { model, messages: [{ role: 'user', content: 'replay-budget-probe' }], stream: false };
}

/* -------------------------------------------------------------------------- */
/* 驱动器夹具：一个可控假模型（fixture）                                           */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} Control
 * @property {() => number} blockedCalls 进入驱动器的 BLOCKED_MODEL 次数。
 * @property {() => number} totalCalls 进入驱动器的总次数。
 * @property {() => string[]} blockedOperationIds 每次 BLOCKED_MODEL 进入时的 operationId。
 * @property {() => void} reachedDriver
 * @property {() => Promise<void>} untilDriverReached
 * @property {() => void} release
 * @property {() => Promise<void>} released
 */

/**
 * 建一个**完全本地**的 fixture 驱动器：
 *  - `BLOCKED_MODEL`：**只有第一次**进入会停住等放行，之后的进入立刻放行。
 *    只让一条登记停在 `in_flight`——这正是 F02 要保护的那条；而「重试不再阻塞」
 *    是让**红**落在 `expect(status).toBe(409)` 而不是一条挂死的超时上（§8 禁止
 *    把超时记成抓到缺陷）。
 *  - `BIG_MODEL`：一条 4,000,000 字符的 delta，把重放预算顶到 32MiB 边界上。
 *
 * `fixture: true` + `testOnlyFixtureToken` 是硬前提：生产配置拿不到那个 symbol，
 * 结构上开不了假模型。
 *
 * @param {Control & {pushOp: (model: string, operationId: string) => void}} control
 * @returns {import('../../packages/api/src/chat.js').ChatDriver}
 */
function createProbeDriver(control) {
  const bigText = 'B'.repeat(4_000_000);
  let blockingIssued = false;
  return {
    name: 'replay-budget-probe',
    status: 'ready',
    statusDetail: 'ZC-13 定向夹具：本地生成，不是真实模型产出',
    models: [{ id: BIG_MODEL, object: 'model', created: 1_700_000_000, owned_by: 'zcc-test-probe' }],
    fixture: true,
    enforcesMaxTokens: false,
    catalog: createFixtureCatalog(BIG_MODEL),
    /**
     * @param {import('../../packages/api/src/chat.js').DriverRequest} request
     * @returns {AsyncGenerator<import('../../packages/api/src/chat.js').DriverEvent>}
     */
    async *stream(request) {
      control.pushOp(request.model, request.operationId);
      if (request.model === BLOCKED_MODEL && !blockingIssued) {
        blockingIssued = true;
        control.reachedDriver();
        // 注意这里是 `control.released()`：**带括号**。`await control.released`
        // 等的是那个函数对象（非 thenable，立即返回），在途登记会当场结束，
        // 整条复现作废——这个坑本卡实打实踩过一次。
        await control.released();
        if (request.signal.aborted) return;
      }
      if (request.model === BIG_MODEL) {
        yield { type: 'delta', text: bigText };
      }
      yield { type: 'usage', promptTokens: 1, completionTokens: 1, usageMethod: 'test_fixed_count' };
      yield { type: 'finish', reason: 'stop' };
    }
  };
}

/* -------------------------------------------------------------------------- */
/* 服务器夹具                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} Harness
 * @property {number} port
 * @property {import('../../packages/api/src/server.js').ApiServer} server
 * @property {string[]} logs
 * @property {Control & {pushOp: (model: string, operationId: string) => void}} control
 */

/** @type {Harness} */
let harness;

beforeAll(async () => {
  /** @type {string[]} */
  const logs = [];
  /** @type {string[]} */
  const allOps = [];
  /** @type {string[]} */
  const blockedOps = [];
  /** @type {() => void} */
  let markEntered = () => undefined;
  /** @type {() => void} */
  let openGate = () => undefined;
  /** @type {Promise<void>} */
  const entered = new Promise((resolve) => {
    markEntered = () => resolve();
  });
  /** @type {Promise<void>} */
  const gate = new Promise((resolve) => {
    openGate = () => resolve();
  });
  /** @type {Control & {pushOp: (model: string, operationId: string) => void}} */
  const control = {
    pushOp: (model, operationId) => {
      allOps.push(operationId);
      if (model === BLOCKED_MODEL) blockedOps.push(operationId);
    },
    blockedCalls: () => blockedOps.length,
    totalCalls: () => allOps.length,
    blockedOperationIds: () => [...blockedOps],
    reachedDriver: () => markEntered(),
    untilDriverReached: () => entered,
    release: () => openGate(),
    released: () => gate
  };
  const server = createApiServer({
    enabled: true,
    port: 0,
    apiKeys: [TEST_KEY],
    driver: createProbeDriver(control),
    testOnlyFixtureToken: FIXTURE_TEST_TOKEN,
    // 阻塞那条会一直占一个并发槽，所以必须显式放宽；条数也放宽到能覆盖 10+ 次请求。
    rateLimit: { maxConcurrent: 16, requests: 500, windowMs: 60_000 },
    shutdownGraceMs: 2_000,
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
  harness = { port: started.port, server, logs, control };
});

afterAll(async () => {
  // 先放行阻塞那条，否则 `stop()` 只能靠超时收束（那会把「有界收束」变成
  // 「每次收尾都超时」，掩盖真实行为）。
  harness.control.release();
  await harness.server.stop();
});

/* -------------------------------------------------------------------------- */
/* 1. 靶点 + 负例(a)(b)：预算顶破时在途同键仍 409、只进入驱动器一次                 */
/* -------------------------------------------------------------------------- */

describe('ZC-13 · F02 重放预算淘汰不得删除仍在执行的幂等登记', () => {
  it('靶点：第 9 条顶破预算后在途同键仍 409，全程只进入驱动器一次', async () => {
    // ── 前置：让 K-A 停在 in_flight（驱动器里阻塞着）────────────────────────
    // 这条**不会**自己结束，所以只发起、不 await；它的响应在放行之后再取。
    const inflightPending = request({
      port: harness.port,
      headers: idemHeaders(INFLIGHT_KEY),
      body: chatBody(BLOCKED_MODEL),
      timeoutMs: 15_000
    });
    await harness.control.untilDriverReached();
    expect(harness.server.diagnostics.idempotencyEntries, '在途登记已在表里').toBe(1);
    expect(harness.control.blockedCalls()).toBe(1);

    // ── 8 条 4000000 字符响应：把 replayBytes 顶到预算之下 ───────────────────
    /** @type {Res} */
    let firstPressure = { status: 0, headers: {}, text: '', timedOut: false, transportError: '' };
    /** @type {Res} */
    let newestPressure = firstPressure;
    /** @type {number[]} */
    const pressureSizes = [];
    for (let i = 0; i < PRESSURE_COUNT; i += 1) {
      const res = await request({
        port: harness.port,
        headers: idemHeaders(`replay-budget-pressure-${i}`),
        body: chatBody(BIG_MODEL)
      });
      expect(res.status, `第 ${i + 1} 条压力响应`).toBe(200);
      expect(res.timedOut, `第 ${i + 1} 条压力响应不是超时`).toBe(false);
      pressureSizes.push(Buffer.byteLength(res.text, 'utf8'));
      if (i === 0) firstPressure = res;
      newestPressure = res;
    }

    // 复现条件逐条**校验**（卡上实测口径），而不是假定夹具一定对。
    const bigBodyBytes = Buffer.byteLength(firstPressure.text, 'utf8');
    // 8 条必须是同一尺寸，否则 `PRESSURE_COUNT * bigBodyBytes` 不是 replayBytes
    // 的真值，后面每一条字节断言都会跟着失真。
    expect(new Set(pressureSizes), '8 条压力响应体必须同尺寸').toEqual(new Set([bigBodyBytes]));
    // 产出规模必须与卡上同一档（4000000 字符），否则下面两条边界条件就不是卡上那条。
    expect(bigBodyBytes).toBeGreaterThan(BIG_BODY_BYTES_UPPER_BOUND - 4096);
    expect(bigBodyBytes).toBeLessThan(BIG_BODY_BYTES_UPPER_BOUND + 4096);
    expect(
      PRESSURE_COUNT * bigBodyBytes,
      '复现条件：8 条压不满 32MiB 预算'
    ).toBeLessThanOrEqual(REPLAY_STORE_MAX_BYTES);
    expect(
      (PRESSURE_COUNT + 1) * bigBodyBytes,
      '复现条件：第 9 条压满 32MiB 预算'
    ).toBeGreaterThan(REPLAY_STORE_MAX_BYTES);

    const underPressure = harness.server.diagnostics;
    expect(underPressure.replayBytes).toBe(PRESSURE_COUNT * bigBodyBytes);
    expect(underPressure.idempotencyEntries).toBe(PRESSURE_COUNT + 1);

    // 负例(a)：8 条边界行为不回退——同键仍 409 idempotency_in_progress。
    const atBoundary = await request({
      port: harness.port,
      headers: idemHeaders(INFLIGHT_KEY),
      body: chatBody(BLOCKED_MODEL)
    });
    expect(atBoundary.status, '负例(a)：8 条预算边界下同键仍 409').toBe(409);
    expect(errorCode(atBoundary)).toBe('idempotency_in_progress');
    expect(header(atBoundary.headers, 'retry-after')).toBe('1');
    expect(atBoundary.timedOut).toBe(false);
    expect(harness.control.blockedCalls(), '负例(a)：重试不得再进驱动器').toBe(1);

    // ── 第 9 条：把 replayBytes 顶过 32MiB，淘汰触发 ────────────────────────
    const overflow = await request({
      port: harness.port,
      headers: idemHeaders('replay-budget-pressure-overflow'),
      body: chatBody(BIG_MODEL)
    });
    expect(overflow.status).toBe(200);
    expect(overflow.timedOut).toBe(false);
    expect(Buffer.byteLength(overflow.text, 'utf8')).toBe(bigBodyBytes);

    // 修前：淘汰先删在途的 K-A（0 字节，replayBytes 不变）→ 再删 K-1 → entries=8。
    // 修后：K-A 被跳过，只删最旧的**已结算**条目 → entries=9，replayBytes 回到预算下。
    const afterPressure = harness.server.diagnostics;
    expect(
      afterPressure.idempotencyEntries,
      '淘汰只移除已结算可释放项：在途登记必须仍在表里'
    ).toBe(PRESSURE_COUNT + 1);
    // 预算上限语义不得回退：淘汰把字节数压回预算之内就停。
    expect(afterPressure.replayBytes).toBe(PRESSURE_COUNT * bigBodyBytes);
    expect(afterPressure.replayBytes).toBeLessThanOrEqual(REPLAY_STORE_MAX_BYTES);

    // 靶点断言：预算压力下**在途同键仍 409**。
    const stillInFlight = await request({
      port: harness.port,
      headers: idemHeaders(INFLIGHT_KEY),
      body: chatBody(BLOCKED_MODEL)
    });
    expect(stillInFlight.status, '靶点：预算压力下在途同键仍 409').toBe(409);
    expect(stillInFlight.timedOut, '靶点：拿到的是响应行，不是超时').toBe(false);
    expect(errorCode(stillInFlight)).toBe('idempotency_in_progress');
    // 修前这里是 200（登记已被删 → 第二次进驱动器），且 operationId 与首次不同。
    expect(header(stillInFlight.headers, 'x-zcc-operation-id')).toBe(
      header(atBoundary.headers, 'x-zcc-operation-id')
    );
    expect(harness.control.blockedCalls(), '靶点：同键只进入驱动器一次').toBe(1);
    expect(harness.control.blockedOperationIds().length).toBe(1);

    // 负例(b) 前半：仍留在表里的**已结算**条目照旧可重放命中同 operation。
    const newestOpId = header(newestPressure.headers, 'x-zcc-operation-id');
    expect(header(newestPressure.headers, 'x-zcc-idempotency')).toBe('original');
    const retainedReplay = await request({
      port: harness.port,
      headers: idemHeaders(`replay-budget-pressure-${PRESSURE_COUNT - 1}`),
      body: chatBody(BIG_MODEL)
    });
    expect(retainedReplay.status).toBe(200);
    expect(retainedReplay.timedOut).toBe(false);
    expect(header(retainedReplay.headers, 'x-zcc-idempotency')).toBe('replayed');
    expect(header(retainedReplay.headers, 'x-zcc-operation-id')).toBe(newestOpId);
    expect(retainedReplay.text).toBe(newestPressure.text);

    // ── 放行在途那条：它必须能提交重放（`current === entry` 仍成立）────────────
    harness.control.release();
    const inflight = await inflightPending;
    expect(inflight.status, '在途那条放行后拿到 200').toBe(200);
    expect(inflight.timedOut).toBe(false);
    expect(header(inflight.headers, 'x-zcc-idempotency')).toBe('original');
    const inflightOpId = header(inflight.headers, 'x-zcc-operation-id');
    expect(inflightOpId).not.toBe('');

    // 负例(b) 后半：正常键完成后仍可重放命中**同一个 operation**（sameOperation=true）。
    const afterSettle = await request({
      port: harness.port,
      headers: idemHeaders(INFLIGHT_KEY),
      body: chatBody(BLOCKED_MODEL)
    });
    expect(afterSettle.status).toBe(200);
    expect(header(afterSettle.headers, 'x-zcc-idempotency')).toBe('replayed');
    expect(header(afterSettle.headers, 'x-zcc-operation-id')).toBe(inflightOpId);
    expect(afterSettle.text).toBe(inflight.text);
    expect(harness.control.blockedCalls(), '负例(b)：重放不进驱动器').toBe(1);

    // 证据口径：整轮下来 BLOCKED_MODEL 只被执行过一次（不是卡上那两次 200）。
    expect(harness.control.totalCalls()).toBe(PRESSURE_COUNT + 1 + 1);

    // 预算上限语义不得回退的另一半：**淘汰确实还在发生**，不是被过滤条件改成
    // 「永不淘汰」。最旧那条压力条目（`pressure-0`）已被逐出，同键是一次新
    // operation（`original` + 新 operationId），而不是重放。
    const evictedRetry = await request({
      port: harness.port,
      headers: idemHeaders('replay-budget-pressure-0'),
      body: chatBody(BIG_MODEL)
    });
    expect(evictedRetry.status).toBe(200);
    expect(header(evictedRetry.headers, 'x-zcc-idempotency')).toBe('original');
    expect(header(evictedRetry.headers, 'x-zcc-operation-id')).not.toBe(
      header(firstPressure.headers, 'x-zcc-operation-id')
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 负例(c)：结算必须先于淘汰（源码顺序不变量）                                   */
/* -------------------------------------------------------------------------- */

describe('ZC-13 · F02 负例(c)：commitReplay 的结算早于淘汰', () => {
  it('结算（state=done）必须写在 evictReplayOverflow() 之前，且淘汰候选要求两条', () => {
    const source = readFileSync(SERVER_TS, 'utf8');
    // 「幂等表」整段：淘汰谓词与淘汰循环住在 `commitReplay` **之前**（它们是它调的
    // 辅助函数），所以谓词断言必须看整段，只看 `commitReplay` 会漏判。
    const sectionStart = source.indexOf('/* 幂等表');
    const sectionEnd = source.indexOf('const releaseOperation = (', sectionStart);
    expect(sectionStart, 'server.ts 必须仍有「幂等表」区段').toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    const section = source.slice(sectionStart, sectionEnd);

    const fnStart = source.indexOf('const commitReplay = (', sectionStart);
    expect(fnStart, 'server.ts 必须仍有 commitReplay').toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, sectionEnd);

    // 淘汰候选必须同时要求「已结算」与「可释放」，缺一条都还会漏：
    //  - 缺 state：in_flight 登记会被删（F02 本体）；
    //  - 缺 replay：SSE 产出超预算时没登记上的 done 条目会被删 → 同键重试从
    //    `idempotency_replay_unavailable` 退化成第二次进驱动器。
    expect(section, "淘汰候选必须要求 state === 'done'").toMatch(/state\s*===\s*'done'/);
    expect(section, '淘汰候选必须要求 replay !== null').toMatch(/replay\s*!==\s*null/);

    // 顺序不变量：结算在前、淘汰在后。变异「把淘汰提到结算之前」让本断言变红。
    const settleAt = fnBody.indexOf("entry.state = 'done'");
    const evictAt = fnBody.indexOf('evictReplayOverflow()');
    expect(settleAt, 'commitReplay 内必须有结算语句').toBeGreaterThan(-1);
    expect(evictAt, 'commitReplay 内必须有淘汰调用').toBeGreaterThan(-1);
    expect(settleAt, '结算必须早于淘汰：commitReplay 不得早于 state=done 淘汰').toBeLessThan(evictAt);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. §4.10：凭据形态不进日志                                                      */
/* -------------------------------------------------------------------------- */

describe('ZC-13 · F02 凭据形态不进日志', () => {
  it('全程日志不含本测试的 key', () => {
    expect(harness.logs.join('\n')).not.toContain(TEST_KEY);
  });
});
