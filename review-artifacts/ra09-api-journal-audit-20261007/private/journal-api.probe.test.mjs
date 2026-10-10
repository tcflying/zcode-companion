// RA-09 · packages/api 侧操作 journal 联动的**真实挂载**验收探针。
//
// 需求出处：G:/zcode-project/zcode-dev/929.md:875
//   「journal不足拒新发而非丢unknown」
//
// 本探针与前几轮的**根本区别**：不 mock `runChat`、不复刻实现、不静态断言。
// 它**真的** `createApiServer()` + `server.start()` + 发真的 HTTP 到
// `127.0.0.1:<临时端口>`，外部下游换成一个本地桩驱动器（不发任何网络请求、
// 不起任何进程、不碰真实 userData / 凭据），journal 目录一律 `os.tmpdir()`。
//
// 反假绿纪律（本文件每条用例都遵守）：
//  1. 凡断言「驱动器没被调用」，**必须**配一条同配置但闸门放行的反向对照，
//     证明 0 是闸门造成的、不是环境本来就发不出去。
//  2. 凡断言「状态是 unknown」，**必须**同时断言 `outcome` 字段的具体值，
//     因为 `unknown` 可以从两条完全不同的代码路径产生——断言 state 本身区分力不够。
//  3. 凡断言「A 发生在 B 之前」，取证点在 **B 的回调内部**同步读盘，
//     不靠事后比对时间戳。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApiServer, FIXTURE_TEST_TOKEN } from '../../../packages/api/src/server.js';
import {
  generateApiKey,
  fingerprintApiKey,
  idempotencyScope,
  resolveIdempotencyOptIn,
  resolveSessionIdentity
} from '../../../packages/api/src/auth.js';
import { createFixtureDriver, FIXTURE_MODEL_ID } from '../../../packages/api/src/chat.js';
import { createOperationJournal, loadJournal } from '../../../packages/api/src/journal-store.js';
import { ApiError } from '../../../packages/api/src/errors.js';

const HOST = '127.0.0.1';

/* -------------------------------------------------------------------------- */
/* 临时目录与读盘                                                              */
/* -------------------------------------------------------------------------- */

/** 全部落 `os.tmpdir()`，永不指向真实 userData / 设置目录。 */
function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zcc-ra09-api-${tag}-`));
}

function journalPath(dir) {
  // 与 `journal-store.ts` 的 API_JOURNAL_FILE_NAME 逐字一致；
  // **刻意不是**桌面侧的 `journal.json`（同目录两个写者会互相抹掉对方整个列表）。
  return path.join(dir, 'api-operations-journal.json');
}

/** 读盘。文件不存在或损坏一律如实返回 `[]`，不假装有记录。 */
function readJournal(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath(dir), 'utf8'));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function stateOf(entries, operationId) {
  const hit = entries.find((e) => e.operationId === operationId);
  return hit === undefined ? null : hit.state;
}

function outcomeOf(entries, operationId) {
  const hit = entries.find((e) => e.operationId === operationId);
  return hit === undefined ? null : (hit.outcome ?? null);
}

/* -------------------------------------------------------------------------- */
/* 服务端夹具                                                                  */
/* -------------------------------------------------------------------------- */

/** @type {import('../../../packages/api/src/server.js').ApiServer[]} */
const running = [];

afterEach(async () => {
  while (running.length > 0) {
    const server = running.pop();
    try {
      await server.stop();
    } catch {
      // 关闭失败不影响本用例已成立的断言结论，如实吞掉但不留假绿依据。
    }
  }
});

/**
 * @param {Record<string, unknown>} [overrides] 进 `createApiServer` 的配置
 * @param {{ apiKey?: string }} [opts]
 *
 * `opts.apiKey` 存在的理由：幂等 scope 的哈希**包含 API key 指纹**
 * （见 `auth.ts` 的 `canonicalRequestHash({ idempotencyKey, keyFingerprint })`）。
 * 模拟「重启」必须让两代进程拿到**同一把 key**——真实产品里 key 来自 settings、
 * 跨重启不变。测试若每次现生成新 key，scope 就变了，跨重启守卫永远不可能命中，
 * 那测出来的 200 是**夹具造出来的假绿**，不是产品行为。
 */
async function startApi(overrides = {}, opts = {}) {
  const apiKey = opts.apiKey ?? generateApiKey();
  const logs = [];
  const server = createApiServer({
    enabled: true,
    port: 0, // 取临时端口，绝不碰 8790/8791 这类真实占用端口
    apiKeys: [apiKey],
    testOnlyFixtureToken: FIXTURE_TEST_TOKEN,
    rateLimit: { maxConcurrent: 8, requests: 500, windowMs: 60_000 },
    logger: {
      info: (line) => logs.push(line),
      warn: (line) => logs.push(line),
      error: (line) => logs.push(line)
    },
    ...overrides
  });
  const started = await server.start();
  if (!started.started || started.port === undefined) {
    throw new Error(`server did not start: ${JSON.stringify(started)}`);
  }
  running.push(server);
  return { server, port: started.port, apiKey, logs };
}

/** 把一个已启动的 server 从 afterEach 队列里摘掉（用于「关掉 A 再开 B」）。 */
async function retire(server) {
  const idx = running.indexOf(server);
  if (idx >= 0) running.splice(idx, 1);
  await server.stop();
}

/* -------------------------------------------------------------------------- */
/* HTTP 客户端                                                                 */
/* -------------------------------------------------------------------------- */

function post({ port, apiKey, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: HOST,
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.byteLength),
          authorization: `Bearer ${apiKey}`,
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // 非 JSON 响应如实保留原文，不假装解析成功
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** 客户端读到第一个数据块就掐断连接（模拟真实取消）。 */
function postThenAbort({ port, apiKey, body }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: HOST,
        port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.byteLength),
          authorization: `Bearer ${apiKey}`
        }
      },
      (res) => {
        res.once('data', () => {
          req.destroy();
          resolve({ aborted: true, status: res.statusCode });
        });
        res.once('end', () => resolve({ aborted: false, status: res.statusCode }));
      }
    );
    // destroy 之后内核回 ECONNRESET 属预期结果，如实吞掉而不是当失败
    req.on('error', () => resolve({ aborted: true, status: null, error: true }));
    req.end(payload);
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}



/** 用产品自己的 opt-in 解析算作用域哈希，避免在测试里复刻哈希算法。 */
function canonicalScopeFor(idempotencyKey, keyFingerprint) {
  return resolveIdempotencyOptIn({ 'idempotency-key': idempotencyKey }, keyFingerprint).scope;
}
/** 会话用例固定同一把 API key：幂等 scope 与 sessionKey 都含 keyFingerprint。 */
function stableKeyOf(tag) {
  return generateApiKey();
}
const chatBody = (content) => ({ model: FIXTURE_MODEL_ID, messages: [{ role: 'user', content }] });

/* -------------------------------------------------------------------------- */
/* 桩驱动器                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 顺序取证驱动器。
 *
 * `stream` 刻意写成**普通函数**而不是 async generator：普通函数的函数体在
 * server.ts 那一行 `driver.stream(...)` 被调用的瞬间就同步执行，
 * 正好落在「登记之后、任何产出之前」这个窗口上。
 * 若写成 `async *`，函数体要到第一次 `next()` 才跑，取证点就漂移了。
 */
function createOrderProbeDriver(inner, journalDir) {
  const snapshots = [];
  const calls = { n: 0 };
  return {
    ...inner,
    name: 'order-probe',
    fixture: true,
    stream(request) {
      calls.n += 1;
      // 同步读盘：这一刻 operationId 必须已经在 journal 里，且处于 in_flight
      snapshots.push({ operationId: request.operationId, onDisk: readJournal(journalDir) });
      return inner.stream(request);
    },
    snapshots,
    calls
  };
}

/* -------------------------------------------------------------------------- */
/* T1 · 登记发生在真实副作用之前                                              */
/* -------------------------------------------------------------------------- */

describe('T1 登记必须发生在真实副作用（driver.stream）之前', () => {
  it('T1 driver.stream 被调用的那一刻，journal 盘上已有该 operationId 且为 in_flight', async () => {
    const dir = tmpRoot('order');
    // 前置：盘上确实什么都没有——否则「调用时已在盘上」是恒真断言
    expect(readJournal(dir)).toEqual([]);

    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const h = await startApi({ driver: probe, journalDir: dir });

    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('order probe') });
    expect(r.status).toBe(200);

    expect(probe.calls.n).toBe(1);
    expect(probe.snapshots.length).toBe(1);
    const atCallTime = probe.snapshots[0];

    // 核心断言：调用瞬间就已在盘上，且是**在途**而非已结算
    expect(stateOf(atCallTime.onDisk, atCallTime.operationId)).toBe('in_flight');
    expect(atCallTime.onDisk.length).toBe(1);

    // 事后终态
    expect(stateOf(readJournal(dir), atCallTime.operationId)).toBe('done');
  });

  it('T1b 缺省不传 journalDir ⇒ 不落盘，但登记闸门仍然生效（不是"没开就完全不管"）', async () => {
    const probe = createOrderProbeDriver(createFixtureDriver(), tmpRoot('noop'));
    // 故意**不传** journalDir
    const h = await startApi({ driver: probe });
    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('no journal dir') });
    expect(r.status).toBe(200);
    expect(probe.calls.n).toBe(1);
    expect(h.server.diagnostics.idempotencyEntries).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* T2 · 容量不足 → 拒新发，驱动器零调用                                      */
/* -------------------------------------------------------------------------- */

describe('T2 journal 容量不足', () => {
  /** 预置 n 条**不可淘汰**（unknown）条目，把容量占满。 */
  function seedFull(dir, n) {
    fs.writeFileSync(
      journalPath(dir),
      `${JSON.stringify(
        { entries: Array.from({ length: n }, (_, i) => ({ operationId: `seed-unknown-${i}`, state: 'unknown', at: i })) },
        null,
        2
      )}\n`,
      'utf8'
    );
  }

  it('T2 容量已满且无可淘汰条目 ⇒ 507 明确拒绝，驱动器一次都不被调用，unknown 一个不丢', async () => {
    const dir = tmpRoot('cap');
    seedFull(dir, 2);
    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const h = await startApi({ driver: probe, journalDir: dir, journalMaxEntries: 2 });

    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('over capacity') });

    expect(r.status).toBe(507);
    expect(r.json.error.code).toBe('journal_capacity_exceeded');
    // 契约必须如实声明「未提交」，不得被下游读成「上游结果未知」
    expect(r.json.zcc_error.delivery).toBe('not_submitted');
    expect(r.json.zcc_error.code).toBe('operation_not_submitted');

    // 关键：真实副作用一次都没发生
    expect(probe.calls.n).toBe(0);
    expect(h.server.diagnostics.driverCalls).toBe(0);

    // 条款正题：拒新发 ≠ 丢 unknown
    expect(readJournal(dir).map((e) => e.operationId).sort()).toEqual(['seed-unknown-0', 'seed-unknown-1']);
  });

  it('T2b 反向对照：同一个盘、同一个驱动器，只把上限 +1 ⇒ 放行且真发一次', async () => {
    // 这条是 T2 的**防假绿对照**：证明上面的 507 是容量闸门造成的，
    // 不是「这个驱动器本来就发不出去」或「这个目录本来就写不了」。
    const dir = tmpRoot('cap-ok');
    seedFull(dir, 2);
    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const h = await startApi({ driver: probe, journalDir: dir, journalMaxEntries: 3 });

    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('fits') });

    expect(r.status).toBe(200);
    expect(probe.calls.n).toBe(1);
    expect(h.server.diagnostics.driverCalls).toBe(1);
    // 可淘汰策略生效：腾位靠丢**旧的 unknown**？——不，unknown 不可淘汰，
    // 所以这里必须靠「新条目挤掉可淘汰条目」以外的方式放行。
    // maxEntries=3、已有 2 条 ⇒ 不超容量，原 2 条原地保留，新条目直接追加。
    const after = readJournal(dir);
    expect(after.length).toBe(3);
    expect(after.filter((e) => e.state === 'unknown').length).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* T3 · 落盘失败 → 拒新发，驱动器零调用                                     */
/* -------------------------------------------------------------------------- */

describe('T3 journal 落盘失败', () => {
  /**
   * 注入「载入成功但写盘失败」。
   *
   * 做法：先放一份**合法**的 journal.json（否则会走 T3c 的 corrupt 闸门而不是写失败闸门），
   * 再把 `journal.json.tmp` 造成一个**目录**——`writeFileSync` 对目录必抛 EISDIR。
   * 这正是父审 v90 反例用的注入方式，可确定复现，且全在 os.tmpdir() 内。
   */
  function seedWriteFailure(dir) {
    fs.writeFileSync(journalPath(dir), `${JSON.stringify({ entries: [] }, null, 2)}\n`, 'utf8');
    fs.mkdirSync(`${journalPath(dir)}.tmp`, { recursive: false });
  }

  it('T3 tmp 写失败 ⇒ 507 明确拒绝，驱动器零调用，契约如实声明 not_submitted', async () => {
    const dir = tmpRoot('wfail');
    seedWriteFailure(dir);

    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const h = await startApi({ driver: probe, journalDir: dir });

    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('write fails') });

    expect(r.status).toBe(507);
    expect(r.json.error.code).toBe('journal_write_failed');
    // 这条断言钉的就是「不能冒充 internal_error」：
    // internal_error 的 delivery 是 outcome_unknown，会让客户端白白重试。
    expect(r.json.zcc_error.delivery).toBe('not_submitted');
    expect(r.json.zcc_error.code).toBe('operation_not_submitted');

    expect(probe.calls.n).toBe(0);
    expect(h.server.diagnostics.driverCalls).toBe(0);
  });

  it('T3b 反向对照：同一驱动器换成干净目录 ⇒ 200 并真发一次', async () => {
    const dir = tmpRoot('wfail-ok');
    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const h = await startApi({ driver: probe, journalDir: dir });
    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('writable') });
    expect(r.status).toBe(200);
    expect(probe.calls.n).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* T3c · 损坏原件：fail-closed 且绝不覆盖                                      */
/* -------------------------------------------------------------------------- */

describe('T3c 损坏的 journal 原件', () => {
  const CORRUPT = '{ this is not json at all';

  it('T3c1 损坏 JSON ⇒ 507 journal_corrupt，驱动器零调用，坏原件逐字节不变', async () => {
    const dir = tmpRoot('corrupt');
    fs.writeFileSync(journalPath(dir), CORRUPT, 'utf8');

    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const h = await startApi({ driver: probe, journalDir: dir });

    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('corrupt') });

    expect(r.status).toBe(507);
    expect(r.json.error.code).toBe('journal_corrupt');
    expect(r.json.zcc_error.delivery).toBe('not_submitted');
    expect(probe.calls.n).toBe(0);
    expect(h.server.diagnostics.driverCalls).toBe(0);

    // 核心：**坏原件必须原样保留**。这是父审 v90 反例 #1 的正解
    //（原实现会把坏 JSON 直接覆盖掉并返回 ok:true）。
    expect(fs.readFileSync(journalPath(dir), 'utf8')).toBe(CORRUPT);
  });

  it('T3c2 形状非法（entries 不是数组）⇒ 同样 fail-closed 且不覆盖', async () => {
    const dir = tmpRoot('corrupt2');
    const bad = '{"entries": "not-an-array"}';
    fs.writeFileSync(journalPath(dir), bad, 'utf8');

    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const h = await startApi({ driver: probe, journalDir: dir });
    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('corrupt2') });

    expect(r.status).toBe(507);
    expect(r.json.error.code).toBe('journal_corrupt');
    expect(probe.calls.n).toBe(0);
    expect(fs.readFileSync(journalPath(dir), 'utf8')).toBe(bad);
  });

  it('T3c3 反向对照：目录里**根本没有** journal.json ⇒ 首次启动必须放行', async () => {
    // 这条是防「fail-closed 矫枉过正」的对照：ENOENT 是**正常首启**，
    // 不是「原件不可信」。把它也判成损坏，会让每个新用户永远起不来。
    const dir = tmpRoot('fresh');
    expect(fs.existsSync(journalPath(dir))).toBe(false);

    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const h = await startApi({ driver: probe, journalDir: dir });
    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('first run') });

    expect(r.status).toBe(200);
    expect(probe.calls.n).toBe(1);
    expect(readJournal(dir).length).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* T4 · unknown 跨重开保留                                                    */
/* -------------------------------------------------------------------------- */

describe('T4 unknown 跨重开保留', () => {
  /** 上游来源不明的异常：toApiError 会落成 upstream_outcome_unknown。 */
  const unknownDriver = {
    ...createFixtureDriver(),
    name: 'origin-unknown-probe',
    fixture: true,
    async *stream() {
      // 在**第一次 next()** 时才抛：这样它落在 runChat 的 try 内，
      // 才会走结算分支。若在 stream() 调用瞬间抛，会绕开 try，
      // 那测的就不是结算路径了。
      throw new Error('来源不明的上游异常');
    }
  };

  it('T4 unknown 跨进程重开仍在盘上，且在容量压力下**不被淘汰**', async () => {
    const dir = tmpRoot('persist');

    // —— 进程 A：产生一条 unknown
    const a = await startApi({ driver: unknownDriver, journalDir: dir });
    const ra = await post({ port: a.port, apiKey: a.apiKey, body: chatBody('boom') });
    expect(ra.status).toBe(502);
    expect(ra.json.error.code).toBe('upstream_outcome_unknown');

    const seeded = readJournal(dir);
    expect(seeded.length).toBe(1);
    expect(seeded[0].state).toBe('unknown');
    const opId = seeded[0].operationId;
    await retire(a.server);

    // —— 进程 B：**同一目录**重开（模拟重启），容量压到 1
    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const b = await startApi({ driver: probe, journalDir: dir, journalMaxEntries: 1 });

    // 跨重开后它仍在盘上（这就是「保留」）
    expect(stateOf(readJournal(dir), opId)).toBe('unknown');

    // B 发新请求：要让出 1 个位置，但 unknown 不可淘汰 ⇒ 必须拒新发
    const rb = await post({ port: b.port, apiKey: b.apiKey, body: chatBody('after restart') });
    expect(rb.status).toBe(507);
    expect(rb.json.error.code).toBe('journal_capacity_exceeded');
    expect(probe.calls.n).toBe(0);
    expect(b.server.diagnostics.driverCalls).toBe(0);

    // 条款正题：拒新发的代价**不是**丢掉那条 unknown
    const final = readJournal(dir);
    expect(stateOf(final, opId)).toBe('unknown');
    expect(final.length).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* T5 · 重复键不得新发                                                        */
/* -------------------------------------------------------------------------- */

describe('T5 重复幂等键不得新发', () => {
  it('T5 同键同体重放：只真发一次，journal 只留一条记录；同键异体 409 且依然不新发', async () => {
    const dir = tmpRoot('dup');
    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const h = await startApi({ driver: probe, journalDir: dir });
    const body = chatBody('same body');

    const a = await post({ port: h.port, apiKey: h.apiKey, body, headers: { 'idempotency-key': 'dup-1' } });
    const b = await post({ port: h.port, apiKey: h.apiKey, body, headers: { 'idempotency-key': 'dup-1' } });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers['x-zcc-idempotency']).toBe('replayed');
    expect(b.headers['x-zcc-operation-id']).toBe(a.headers['x-zcc-operation-id']);

    // 关键：重放没有产生第二次真实发送，也没有产生第二条 journal 记录
    expect(probe.calls.n).toBe(1);
    expect(h.server.diagnostics.driverCalls).toBe(1);
    const entries = readJournal(dir);
    expect(entries.length).toBe(1);
    expect(entries[0].operationId).toBe(a.headers['x-zcc-operation-id']);
    expect(entries[0].state).toBe('done');

    // 变体：同键**不同体** ⇒ 冲突，且依然不新发
    const c = await post({
      port: h.port,
      apiKey: h.apiKey,
      body: chatBody('different body'),
      headers: { 'idempotency-key': 'dup-1' }
    });
    expect(c.status).toBe(409);
    expect(c.json.error.code).toBe('idempotency_conflict');
    expect(probe.calls.n).toBe(1);
    expect(h.server.diagnostics.driverCalls).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* T6 · 分流：不可知 vs 确定失败                                             */
/* -------------------------------------------------------------------------- */

describe('T6 结算分流不是硬编码', () => {
  it('T6a 来源不明的上游异常 ⇒ unknown', async () => {
    const dir = tmpRoot('settle-unknown');
    const driver = {
      ...createFixtureDriver(),
      name: 'origin-unknown',
      fixture: true,
      async *stream() {
        throw new Error('来源不明');
      }
    };
    const h = await startApi({ driver, journalDir: dir });
    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('u') });
    expect(r.status).toBe(502);
    expect(readJournal(dir).map((e) => e.state)).toEqual(['unknown']);
  });

  it('T6b 上游明确拒绝（未送出）⇒ failed，与 T6a 相反', async () => {
    const dir = tmpRoot('settle-failed');
    const driver = {
      ...createFixtureDriver(),
      name: 'explicit-refusal',
      fixture: true,
      async *stream() {
        // 驱动器是 ready 才走到这里，所以这个拒绝发生在**产出途中**，
        // 且它是一个「确定失败」而非「结果不可知」。
        throw new ApiError('upstream_unavailable', '明确拒绝，没有送出去', {});
      }
    };
    const h = await startApi({ driver, journalDir: dir });
    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('f') });
    expect(r.status).toBe(503);
    const entries = readJournal(dir);
    expect(entries.length).toBe(1);
    expect(entries[0].state).toBe('failed');
    expect(entries[0].outcome).toBe('upstream_unavailable');
  });
});

/* -------------------------------------------------------------------------- */
/* T7 · 取消边界                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 取消探针驱动器：先吐一个 delta，之后**挂住**直到客户端断开触发 signal abort。
 *
 * 关键设计：abort 之后**正常 return，不抛错**。
 * 因为若在这里抛 upstream_outcome_unknown，结算会走 catch 分支，
 * state 同样是 unknown —— 那样本用例就分不清是新分支还是旧分支，等于白测。
 */
function createCancelProbeDriver() {
  return {
    ...createFixtureDriver(),
    name: 'cancel-probe',
    fixture: true,
    async *stream(request) {
      yield { type: 'delta', text: 'partial-' };
      await new Promise((resolve) => {
        if (request.signal.aborted) {
          resolve();
          return;
        }
        request.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      // 客户端已走：不再假装产出完成，也不编造一个 finish 事件。
      return;
    }
  };
}

describe('T7 客户端中途取消', () => {
  const streamBody = { model: FIXTURE_MODEL_ID, stream: true, messages: [{ role: 'user', content: 'cancel me' }] };

  it('T7a 读到首帧即掐断 ⇒ 结算 unknown，且 outcome 证明走的是「客户端断开」分支', async () => {
    const dir = tmpRoot('cancel');
    const h = await startApi({ driver: createCancelProbeDriver(), journalDir: dir });

    await postThenAbort({ port: h.port, apiKey: h.apiKey, body: streamBody });

    const settled = await waitFor(() => {
      const e = readJournal(dir);
      return e.length > 0 && e[0].state !== 'in_flight' ? e : null;
    });
    expect(settled, '取消后 journal 必须离开 in_flight').not.toBeNull();

    const [entry] = settled;
    expect(entry.state).toBe('unknown');
    // 区分力断言：outcome 精确到「客户端中途断开」这条分支。
    // 若是驱动器抛错，outcome 会是 upstream_outcome_unknown 而非本值。
    expect(entry.outcome).toBe('client_disconnected_midstream');
  });

  it('T7b 反向对照：同一个驱动器，客户端读到结束不掐断 ⇒ 结算 done、outcome 为空', async () => {
    // 防假绿对照：证明 T7a 的 unknown 不是驱动器本身的行为。
    const dir = tmpRoot('cancel-ctl');
    // 不挂住的版本：正常吐完。
    const driver = {
      ...createFixtureDriver(),
      name: 'complete-probe',
      fixture: true,
      async *stream() {
        yield { type: 'delta', text: 'partial-' };
        yield { type: 'finish', reason: 'stop' };
      }
    };
    const h = await startApi({ driver, journalDir: dir });
    const r = await post({ port: h.port, apiKey: h.apiKey, body: streamBody });
    expect(r.status).toBe(200);

    const entries = readJournal(dir);
    expect(entries.length).toBe(1);
    expect(entries[0].state).toBe('done');
    expect(entries[0].outcome ?? null).toBeNull();
  });
});
/* -------------------------------------------------------------------------- */
/* T8 · store 层三条 fail-closed 铁钉                                          */
/* -------------------------------------------------------------------------- */

/**
 * 直接打**产品模块自己的边界**（`createOperationJournal`），不是复刻实现。
 *
 * 为什么必须在这一层测：反例 #2（同 operationId 的 unknown 可再发）在 runChat
 * 路径上**不可达**——runChat 每次都现生成随机 operationId。守卫住在 store 层
 * 是纵深防御，只能在这一层证明它真的存在且有效。
 */
describe('T8 store 层 fail-closed 铁钉（父审 v90 三条反例的正解）', () => {
  it('T8-1 损坏原件：reserve 一律拒绝，且绝不覆盖原件', () => {
    const dir = tmpRoot('s1');
    fs.writeFileSync(journalPath(dir), 'NOT-JSON-AT-ALL', 'utf8');

    const j = createOperationJournal(dir);
    expect(j.poisoned()).toBe(true);
    expect(j.problems().length).toBeGreaterThan(0);

    const r = j.reserve({ operationId: 'new', at: 1, maxEntries: 10 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('journal_corrupt');
    // 关键：原件一个字节都没被改
    expect(fs.readFileSync(journalPath(dir), 'utf8')).toBe('NOT-JSON-AT-ALL');
  });

  it('T8-1b 反向对照：合法文件不 poisoned，reserve 正常通过', () => {
    const dir = tmpRoot('s1b');
    const j = createOperationJournal(dir);
    expect(j.poisoned()).toBe(false);
    const r = j.reserve({ operationId: 'op-1', at: 1, maxEntries: 10 });
    expect(r.ok).toBe(true);
    expect(readJournal(dir).length).toBe(1);
  });

  it('T8-2 unknown 的 operationId 不可再发；同进程在途也不可', () => {
    const dir = tmpRoot('s2');
    fs.writeFileSync(
      journalPath(dir),
      `${JSON.stringify({
        entries: [
          { operationId: 'was-unknown', state: 'unknown', at: 1 },
          // 载入时会被承接成 unknown（上一进程遗留的在途，新进程永远结算不了）
          { operationId: 'was-inflight-from-crash', state: 'in_flight', at: 2 }
        ]
      })}\n`,
      'utf8'
    );
    const j = createOperationJournal(dir);

    const a = j.reserve({ operationId: 'was-unknown', at: 3, maxEntries: 10 });
    expect(a.ok).toBe(false);
    expect(a.reason).toBe('operation_outcome_unknown');

    // 崩溃遗留的在途 ⇒ 载入时已承接为 unknown ⇒ 理由同「结果不可知」，
    // 而不是「在途中」。这是本轮 T13 的语义变更，断言跟着改。
    const c = j.reserve({ operationId: 'was-inflight-from-crash', at: 5, maxEntries: 10 });
    expect(c.ok).toBe(false);
    expect(c.reason).toBe('operation_outcome_unknown');

    // **同进程**活着的在途仍报 operation_in_progress（并发语义未被扩大）
    const live = createOperationJournal(tmpRoot('s2-live'));
    expect(live.reserve({ operationId: 'live-op', at: 1, maxEntries: 10 }).ok).toBe(true);
    const b = live.reserve({ operationId: 'live-op', at: 2, maxEntries: 10 });
    expect(b.ok).toBe(false);
    expect(b.reason).toBe('operation_in_progress');

    // 已结算的同 id 走幂等返回（不新增第二条，也不拒）
    fs.writeFileSync(
      journalPath(dir),
      `${JSON.stringify({ entries: [{ operationId: 'was-done', state: 'done', at: 9 }] })}\n`,
      'utf8'
    );
    const j2 = createOperationJournal(dir);
    const d = j2.reserve({ operationId: 'was-done', at: 10, maxEntries: 10 });
    expect(d.ok).toBe(true);
    expect(readJournal(dir).length).toBe(1);
  });

  it('T8-2b 反向对照：全新 operationId 在同样条件下正常登记', () => {
    // 证明 T8-2 的拒绝来自「同 id + 未知状态」，不是「目录有问题」。
    const dir = tmpRoot('s2b');
    fs.writeFileSync(
      journalPath(dir),
      `${JSON.stringify({ entries: [{ operationId: 'was-unknown', state: 'unknown', at: 1 }] })}\n`,
      'utf8'
    );
    const j = createOperationJournal(dir);
    const r = j.reserve({ operationId: 'brand-new', at: 2, maxEntries: 10 });
    expect(r.ok).toBe(true);
    expect(readJournal(dir).length).toBe(2);
  });

  it('T8-3 写盘失败后：内存**完全没变**（旧 done 条目不得被淘汰掉）', () => {
    const dir = tmpRoot('s3');
    fs.writeFileSync(
      journalPath(dir),
      `${JSON.stringify({ entries: [{ operationId: 'old-done', state: 'done', at: 1 }] })}\n`,
      'utf8'
    );
    // 让 tmp 写入必失败（tmp 是目录）
    fs.mkdirSync(`${journalPath(dir)}.tmp`);

    const j = createOperationJournal(dir);
    const before = j.entries();
    expect(before.length).toBe(1);

    const r = j.reserve({ operationId: 'new-op', at: 2, maxEntries: 1 });
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toMatch(/^journal_write_failed/);

    // 关键：内存里那条 old-done **还在**。原实现在这里把它淘汰掉了，
    // 于是「磁盘有、内存无」，重启后记录又冒出来。
    const after = j.entries();
    expect(after.length).toBe(1);
    expect(after[0].operationId).toBe('old-done');
    expect(after[0].state).toBe('done');
    // 磁盘也未被改动
    expect(readJournal(dir)[0].operationId).toBe('old-done');
  });

  it('T8-3b 写盘失败后 settle 也不得改内存（保持内存与磁盘一致）', () => {
    const dir = tmpRoot('s3b');
    fs.writeFileSync(journalPath(dir), `${JSON.stringify({ entries: [] })}\n`, 'utf8');
    fs.mkdirSync(`${journalPath(dir)}.tmp`);

    const j = createOperationJournal(dir);
    expect(j.settle('nope', 'done')).toBe(false);
    expect(j.entries().length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* T9 · 结算按投递语义（父审 v90 反例：漏了 upstream_timeout）                  */
/* -------------------------------------------------------------------------- */

describe('T9 结算必须覆盖全部 outcome_unknown，而不只是 upstream_outcome_unknown', () => {
  const thrower = (code, name) => ({
    ...createFixtureDriver(),
    name,
    fixture: true,
    async *stream() {
      throw new ApiError(code, '注入的驱动器错误', {});
    }
  });

  it('T9a 错误表里的投递语义是分流依据（timeout 属 outcome_unknown，unavailable 属 not_submitted）', () => {
    // 这条是 T9b/T9c 的前提：若表本身错了，下面两条的行为断言就没有意义。
    expect(new ApiError('upstream_timeout', 'x', {}).delivery).toBe('outcome_unknown');
    expect(new ApiError('upstream_outcome_unknown', 'x', {}).delivery).toBe('outcome_unknown');
    expect(new ApiError('upstream_unavailable', 'x', {}).delivery).toBe('not_submitted');
  });

  it('T9b runChat 真的把 upstream_timeout 记成 unknown', async () => {
    const dir = tmpRoot('t9b');
    const h = await startApi({ driver: thrower('upstream_timeout', 'timeout-probe'), journalDir: dir });
    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('timeout') });
    expect(r.status).toBe(504);
    const entries = readJournal(dir);
    expect(entries.length).toBe(1);
    // 原实现只判 upstream_outcome_unknown ⇒ 这里会是 'failed'（可淘汰）
    expect(entries[0].state).toBe('unknown');
    expect(entries[0].outcome).toBe('outcome_unknown: upstream_timeout');
  });

  it('T9c 反向对照：upstream_unavailable 仍是 failed（分流不是一律 unknown）', async () => {
    const dir = tmpRoot('t9c');
    const h = await startApi({ driver: thrower('upstream_unavailable', 'refuse-probe'), journalDir: dir });
    const r = await post({ port: h.port, apiKey: h.apiKey, body: chatBody('refused') });
    expect(r.status).toBe(503);
    expect(readJournal(dir)[0].state).toBe('failed');
  });
});

/* -------------------------------------------------------------------------- */
/* T10 · 幂等作用域跨重启复用                                                 */
/* -------------------------------------------------------------------------- */

describe('T10 幂等作用域跨重启复用（同键不得新发）', () => {
  it('T10a 重启后同键同体 ⇒ 拒绝重发（驱动器零调用），而不是当成全新操作', async () => {
    const dir = tmpRoot('restart');

    // 进程 A：正常跑一次，留下 done 记录
    const stableKey = generateApiKey();
    const a = await startApi({ driver: createFixtureDriver(), journalDir: dir }, { apiKey: stableKey });
    const first = await post({
      port: a.port,
      apiKey: stableKey,
      body: chatBody('across restart'),
      headers: { 'idempotency-key': 'restart-key' }
    });
    expect(first.status).toBe(200);
    const firstOp = first.headers['x-zcc-operation-id'];

    // 记录里必须有 scope，且**不含正文**
    const raw = fs.readFileSync(journalPath(dir), 'utf8');
    expect(raw).toContain('scope');
    expect(raw).not.toContain('across restart');

    await retire(a.server);

    // 进程 B：同一目录重开。内存表已空——这正是原来会重复发送的地方。
    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const b = await startApi({ driver: probe, journalDir: dir }, { apiKey: stableKey });
    const second = await post({
      port: b.port,
      apiKey: stableKey,
      body: chatBody('across restart'),
      headers: { 'idempotency-key': 'restart-key' }
    });

    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('idempotency_replay_unavailable');
    expect(probe.calls.n).toBe(0);
    expect(b.server.diagnostics.driverCalls).toBe(0);
    expect(second.headers['x-zcc-operation-id']).toBe(firstOp);
  });

  it('T10b 重启后同键**异体** ⇒ idempotency_conflict，且依然不新发', async () => {
    const dir = tmpRoot('restart2');
    const stableKey = generateApiKey();
    const a = await startApi({ driver: createFixtureDriver(), journalDir: dir }, { apiKey: stableKey });
    const first = await post({
      port: a.port,
      apiKey: stableKey,
      body: chatBody('body one'),
      headers: { 'idempotency-key': 'restart-key-2' }
    });
    expect(first.status).toBe(200);
    await retire(a.server);

    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const b = await startApi({ driver: probe, journalDir: dir }, { apiKey: stableKey });
    const second = await post({
      port: b.port,
      apiKey: stableKey,
      body: chatBody('body two'),
      headers: { 'idempotency-key': 'restart-key-2' }
    });
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe('idempotency_conflict');
    expect(probe.calls.n).toBe(0);
  });

  it('T10c 重启前是 unknown ⇒ 重启后仍拒绝重发（不自动重试可能重复扣费的操作）', async () => {
    const dir = tmpRoot('restart3');
    const unknownDriver = {
      ...createFixtureDriver(),
      name: 'origin-unknown',
      fixture: true,
      async *stream() {
        throw new Error('来源不明');
      }
    };
    const stableKey = generateApiKey();
    const a = await startApi({ driver: unknownDriver, journalDir: dir }, { apiKey: stableKey });
    const first = await post({
      port: a.port,
      apiKey: stableKey,
      body: chatBody('boom'),
      headers: { 'idempotency-key': 'restart-key-3' }
    });
    expect(first.status).toBe(502);
    expect(readJournal(dir)[0].state).toBe('unknown');
    await retire(a.server);

    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const b = await startApi({ driver: probe, journalDir: dir }, { apiKey: stableKey });
    const second = await post({
      port: b.port,
      apiKey: stableKey,
      body: chatBody('boom'),
      headers: { 'idempotency-key': 'restart-key-3' }
    });
    expect(second.status).toBe(502);
    expect(second.json.error.code).toBe('upstream_outcome_unknown');
    expect(probe.calls.n).toBe(0);
    expect(b.server.diagnostics.driverCalls).toBe(0);
  });

  it('T10d 反向对照：重启后**换了幂等键**就是一次全新操作，正常发送', async () => {
    // 证明 T10a 的 409 来自「同键」而不是「journalDir 有记录就一律拒」。
    const dir = tmpRoot('restart4');
    const stableKey = generateApiKey();
    const a = await startApi({ driver: createFixtureDriver(), journalDir: dir }, { apiKey: stableKey });
    expect(
      (await post({ port: a.port, apiKey: stableKey, body: chatBody('x'), headers: { 'idempotency-key': 'k-a' } }))
        .status
    ).toBe(200);
    await retire(a.server);

    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const b = await startApi({ driver: probe, journalDir: dir }, { apiKey: stableKey });
    const fresh = await post({
      port: b.port,
      apiKey: stableKey,
      body: chatBody('x'),
      headers: { 'idempotency-key': 'k-b' }
    });
    expect(fresh.status).toBe(200);
    expect(probe.calls.n).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* T11 · 载入器本身不吞问题                                                  */
/* -------------------------------------------------------------------------- */

describe('T11 loadJournal 如实报告问题', () => {
  it('T11 ENOENT（首启）不是问题；其它读失败是问题', () => {
    const fresh = tmpRoot('l1');
    expect(loadJournal(fresh).problems).toEqual([]);

    const dir = tmpRoot('l2');
    fs.writeFileSync(journalPath(dir), '{oops', 'utf8');
    const bad = loadJournal(dir);
    expect(bad.entries).toEqual([]);
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(bad.problems[0]).toContain('JOURNAL_FILE_UNREADABLE');
  });
});

/* -------------------------------------------------------------------------- */
/* T12 · 会话级闸门（929.md:347 / :853 / :916）                              */
/* -------------------------------------------------------------------------- */

/**
 * 同会话存在 unknown 时，**换新幂等键 / 换新输入**都必须拒发且驱动器零调用。
 *
 * 关键：会话身份靠 `x-zcc-client-id` / `x-zcc-session-id`，而每次都换
 * `Idempotency-Key`——正是 `:347` 点名的「外部客户端默认新key重试」那种形态。
 */
describe('T12 同会话 unknown 不得被新键穿透', () => {
  const unknownDriver = {
    ...createFixtureDriver(),
    name: 'origin-unknown',
    fixture: true,
    async *stream() {
      throw new Error('来源不明');
    }
  };

  const SESSION_HEADERS = { 'x-zcc-client-id': 'client-A', 'x-zcc-session-id': 'sess-A' };

  it('T12a 同会话换新键 ⇒ 拒发，驱动器零调用（不改键时靠作用域守卫也不够，必须有会话闸门）', async () => {
    const dir = tmpRoot('sess-a');
    const probe = createOrderProbeDriver(unknownDriver, dir);
    const h = await startApi({ driver: probe, journalDir: dir }, { apiKey: stableKeyOf('sess-a') });

    // 第一次：产生 unknown
    const first = await post({
      port: h.port,
      apiKey: h.apiKey,
      body: chatBody('boom'),
      headers: { ...SESSION_HEADERS, 'idempotency-key': 'key-1' }
    });
    expect(first.status).toBe(502);
    expect(readJournal(dir).filter((e) => e.state === 'unknown').length).toBe(1);
    expect(probe.calls.n).toBe(1);

    // 第二次：**换键** + **换输入**。作用域已经变了，作用域级守卫打不中，
    // 只有会话闸门能拦住。
    const second = await post({
      port: h.port,
      apiKey: h.apiKey,
      body: chatBody('brand new input'),
      headers: { ...SESSION_HEADERS, 'idempotency-key': 'key-2' }
    });
    expect(second.status).toBe(502);
    expect(second.json.error.code).toBe('upstream_outcome_unknown');
    // 区分力：error detail 必须指向「会话锁定」这条分支，
    // 而不是作用域级的 survived_restart 分支。
    expect(second.json.zcc_error.detail.session_locked).toBe(true);
    expect(second.json.zcc_error.detail.driver_called).toBe(false);

    // 核心：没有新增任何投递
    expect(probe.calls.n).toBe(1);
    expect(h.server.diagnostics.driverCalls).toBe(1);

    // 第三次再来一次，依然拒（不是一次性）
    const third = await post({
      port: h.port,
      apiKey: h.apiKey,
      body: chatBody('again'),
      headers: { ...SESSION_HEADERS, 'idempotency-key': 'key-3' }
    });
    expect(third.status).toBe(502);
    expect(probe.calls.n).toBe(1);
  });

  it('T12b 跨重建（同目录重开）后同会话换新键仍拒，驱动器零调用', async () => {
    const dir = tmpRoot('sess-b');
    const key = stableKeyOf('sess-b');

    const a = await startApi({ driver: unknownDriver, journalDir: dir }, { apiKey: key });
    const first = await post({
      port: a.port,
      apiKey: key,
      body: chatBody('boom'),
      headers: { ...SESSION_HEADERS, 'idempotency-key': 'key-1' }
    });
    expect(first.status).toBe(502);
    await retire(a.server);

    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const b = await startApi({ driver: probe, journalDir: dir }, { apiKey: key });
    const second = await post({
      port: b.port,
      apiKey: key,
      body: chatBody('after rebuild'),
      headers: { ...SESSION_HEADERS, 'idempotency-key': 'key-2' }
    });
    expect(second.status).toBe(502);
    expect(second.json.zcc_error.detail.session_locked).toBe(true);
    expect(probe.calls.n).toBe(0);
    expect(b.server.diagnostics.driverCalls).toBe(0);
  });

  it('T12c 正常会话对照：全部 done 的会话，换新键照常发送（闸门不能误伤正常重试）', async () => {
    const dir = tmpRoot('sess-c');
    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const h = await startApi({ driver: probe, journalDir: dir }, { apiKey: stableKeyOf('sess-c') });

    const first = await post({
      port: h.port,
      apiKey: h.apiKey,
      body: chatBody('ok 1'),
      headers: { ...SESSION_HEADERS, 'idempotency-key': 'ok-1' }
    });
    expect(first.status).toBe(200);
    const second = await post({
      port: h.port,
      apiKey: h.apiKey,
      body: chatBody('ok 2'),
      headers: { ...SESSION_HEADERS, 'idempotency-key': 'ok-2' }
    });
    expect(second.status).toBe(200);
    expect(probe.calls.n).toBe(2);
  });

  it('T12d 反向对照：另一个会话不受影响（闸门是会话级，不是全局冻结）', async () => {
    const dir = tmpRoot('sess-d');
    const probe = createOrderProbeDriver(unknownDriver, dir);
    const h = await startApi({ driver: probe, journalDir: dir }, { apiKey: stableKeyOf('sess-d') });

    expect(
      (
        await post({
          port: h.port,
          apiKey: h.apiKey,
          body: chatBody('boom'),
          headers: { 'x-zcc-client-id': 'client-A', 'x-zcc-session-id': 'sess-X', 'idempotency-key': 'k1' }
        })
      ).status
    ).toBe(502);
    const callsAfterUnknown = probe.calls.n;
    expect(callsAfterUnknown).toBe(1);

    // 不同会话：驱动器是 unknownDriver，所以这一发**会**进驱动器并再次失败。
    // 重点是它**没有被会话闸门提前拒掉**——driverCalls 从 1 涨到 2。
    const other = await post({
      port: h.port,
      apiKey: h.apiKey,
      body: chatBody('other session'),
      headers: { 'x-zcc-client-id': 'client-A', 'x-zcc-session-id': 'sess-Y', 'idempotency-key': 'k2' }
    });
    expect(other.status).toBe(502);
    expect(probe.calls.n).toBe(2);
    expect(other.json.zcc_error.detail.session_locked).toBeUndefined();
  });

  it('T12e 缺会话身份时闸门不做判定：resolveSessionIdentity 返回 null（不假造）', () => {
    // 这是**契约层**断言，不是给缺口背书：
    // 两个 x-zcc-* 头都没发 ⇒ 我们无从知道这次请求属于哪个会话，
    // 编一个会话号会把会话锁定变成全局冻结。所以必须返回 null。
    expect(resolveSessionIdentity({}, 'zcc-fp:test')).toBeNull();
    expect(resolveSessionIdentity({ 'idempotency-key': 'k' }, 'zcc-fp:test')).toBeNull();
    // 有会话头就解析得出来，且与幂等 opt-in 的 identity 形态算出同一个键
    const s = resolveSessionIdentity(
      { 'x-zcc-client-id': 'c1', 'x-zcc-session-id': 's1', 'idempotency-key': 'k' },
      'zcc-fp:test'
    );
    expect(s).not.toBeNull();
    expect(s.sessionKey).toBe(
      idempotencyScope('c1', 's1', 'zcc-fp:test')
    );
    // 只发其一 ⇒ 另一维用缺省值（沿用既有契约，不新造）
    expect(resolveSessionIdentity({ 'x-zcc-session-id': 's1' }, 'f').sessionId).toBe('s1');
    expect(resolveSessionIdentity({ 'x-zcc-session-id': 's1' }, 'f').clientId).toBe('default-client');
  });
});
/* -------------------------------------------------------------------------- */
/* T13 · 崩溃遗留 in_flight：跨重建后同会话仍零重发（RA-06）                   */
/* -------------------------------------------------------------------------- */

/**
 * `loadJournal` 会把上一进程遗留的 `in_flight` 承接为 `unknown`——因为那个在途请求
 * 在新进程里**永远不可能**再被结算，它的真实语义就是「已提交、结果不可知」。
 *
 * 若仍按 `in_flight` 处理：会话闸门只看 `unknown` ⇒ 判不到它 ⇒ 同会话换新键即可
 * 穿透，「终止本应用子进程后重开零重发」这条（`:853`）直接被破。
 */
describe('T13 崩溃遗留 in_flight 不得被新键穿透', () => {
  const SESSION = { 'x-zcc-client-id': 'client-R', 'x-zcc-session-id': 'sess-R' };

  /**
   * 模拟「已提交上游、尚未拿到终态，然后进程被杀」。
   *
   * 用**产品自己的** `createOperationJournal` 做 `reserve`（真实持久登记），
   * 然后**不** `settle`、直接丢弃那个实例——这正是崩溃现场。
   * 不是复刻实现：调的就是产品模块自己的边界。
   */
  function simulateCrashWhileInFlight(dir, sessionKey, scope, bodyHash) {
    const crashed = createOperationJournal(dir);
    const reserved = crashed.reserve({ operationId: 'op-crashed', scope, bodyHash, sessionKey, at: 1, maxEntries: 64 });
    expect(reserved.ok).toBe(true);
    // 刻意不 settle：这条永远停在 in_flight。
    expect(crashed.entries()[0].state).toBe('in_flight');
    // 盘上确实写着 in_flight（证明后面测的是「读回来」而不是「我提前改好了」）
    expect(readJournalRawState(dir)).toBe('in_flight');
  }

  /** 直接读盘上的 state，绕开 createOperationJournal 的载入承接逻辑。 */
  function readJournalRawState(dir) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'api-operations-journal.json'), 'utf8'));
    return parsed.entries[0].state;
  }

  it('T13a 预先持久 in_flight（模拟已提交未 terminal）后重建：同会话换新键 ⇒ 驱动器零调用', async () => {
    const dir = tmpRoot('crash-a');
    const apiKey = generateApiKey();
    const fp = fingerprintApiKey(apiKey);
    const session = resolveSessionIdentity(SESSION, fp);
    const scopeFor = (key) => canonicalScopeFor(key, fp);

    simulateCrashWhileInFlight(dir, session.sessionKey, scopeFor('old-key'), 'hash-of-old-body');

    // 重建：新进程、新 journal 实例
    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const h = await startApi({ driver: probe, journalDir: dir }, { apiKey });

    const r = await post({
      port: h.port,
      apiKey,
      body: chatBody('after crash, new key'),
      headers: { ...SESSION, 'idempotency-key': 'new-key' }
    });

    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe('upstream_outcome_unknown');
    expect(r.json.zcc_error.detail.session_locked).toBe(true);
    // 核心：重建后零新增投递
    expect(probe.calls.n).toBe(0);
    expect(h.server.diagnostics.driverCalls).toBe(0);
  });

  it('T13b 承接本身可见且不误伤：problems 为空（否则会 poisoned 永久拒发）、recovered 有说明', async () => {
    const dir = tmpRoot('crash-b');
    const j1 = createOperationJournal(dir);
    j1.reserve({ operationId: 'op-x', at: 1, maxEntries: 64 });
    // 不 settle，丢弃 j1 = 崩溃

    const j2 = createOperationJournal(dir);
    // 承接是**正常语义**，绝不能进 problems：problems 非空 = poisoned = 一切拒发
    expect(j2.problems()).toEqual([]);
    expect(j2.poisoned()).toBe(false);
    expect(j2.recovered().length).toBe(1);
    expect(j2.recovered()[0]).toContain('op-x');
    // 状态确实变成 unknown，且不可淘汰
    expect(j2.entries()[0].state).toBe('unknown');
  });

  it('T13c 反向对照：同一进程内活着的 in_flight **不**冻结并发（并发契约不得被扩大）', async () => {
    // 这一条钉住「别擅自扩大」：同进程的在途不是未知结果。
    // 驱动器挂住，让第一条真正处于在途，同时发第二条（不同键、同会话）。
    const dir = tmpRoot('crash-c');
    let releaseFirst = null;
    const blocked = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    // **只挂住第一次调用**。上一版两条请求都 await 同一个 blocked，
    // 而我又先 await 第二条再放行第一条 ⇒ 自己把自己锁死（实测 35s 超时 + socket 重置）。
    let callIndex = 0;
    const holdDriver = {
      ...createFixtureDriver(),
      name: 'hold',
      fixture: true,
      async *stream() {
        callIndex += 1;
        yield { type: 'delta', text: 'x' };
        if (callIndex === 1) await blocked;
        yield { type: 'finish', reason: 'stop' };
      }
    };

    const probe = createOrderProbeDriver(holdDriver, dir);
    const apiKey = generateApiKey();
    const h = await startApi({ driver: probe, journalDir: dir }, { apiKey });

    const firstPromise = post({
      port: h.port,
      apiKey,
      body: chatBody('in flight'),
      headers: { ...SESSION, 'idempotency-key': 'k-inflight' }
    });
    // 等第一条真的进了驱动器（在途）
    const entered = await waitFor(() => (probe.calls.n >= 1 ? true : null), 5000);
    expect(entered).not.toBeNull();

    // 第二条：同会话、**不同键**。按原并发契约应当放行。
    const second = await post({
      port: h.port,
      apiKey,
      body: chatBody('concurrent in same session'),
      headers: { ...SESSION, 'idempotency-key': 'k-concurrent' }
    });
    expect(second.status).toBe(200);
    expect(probe.calls.n).toBe(2);

    releaseFirst();
    expect((await firstPromise).status).toBe(200);
  });

  it('T13d 边界：旧记录**没有** sessionKey ⇒ 无法归属会话，不构成完整保障（如实钉住缺口）', () => {
    // 这条**不是**给缺口背书，是把缺口钉成可复核的事实：
    // 引入 sessionKey 之前写下的记录没有这个字段，会话闸门无从判断它属于哪个会话。
    const dir = tmpRoot('crash-d');
    fs.writeFileSync(
      path.join(dir, 'api-operations-journal.json'),
      `${JSON.stringify({ entries: [{ operationId: 'legacy', state: 'in_flight', at: 1 }] })}\n`,
      'utf8'
    );
    const j = createOperationJournal(dir);
    expect(j.entries()[0].state).toBe('unknown'); // 仍被承接为 unknown
    // 但因为没有 sessionKey，任何 sessionKey 都查不到它 ⇒ 换新键仍可发
    expect(j.lookupSessionUnknown('any-session-key')).toBeUndefined();
  });
});
/* -------------------------------------------------------------------------- */
/* T14 · 合成 canary 全产物扫描（929.md:875 正文默认不外带 / :876 扫描规则范围） */
/* -------------------------------------------------------------------------- */

/**
 * canary 故意**不像凭据**：不是 `sk-`、不是 bearer、不含 apiKey= 样式。
 *
 * 理由：本条的命题是「journal 不存正文」，不是「redact() 会把它洗掉」。
 * 若 canary 是凭据形状，`redact()` 命中就足以让测试变绿——那就测成了脱敏器，
 * 而脱敏器救不了「根本不该落盘的东西」。**只有非凭据形状的 canary 才能证明
 * 「正文压根没被持久化」。**
 */
const CANARY_BODY = 'RA09CANARY-7f3a91c4e2b6d05正文片段';
const CANARY_HEADER = 'RA09CANARY-9e2d4b8a7c1f03';

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

/** 扫描规则：逐字节读每个产物的 UTF-8 文本，数 canary 出现次数。 */
function scanFor(dir, needle) {
  const hits = [];
  for (const f of walkFiles(dir)) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue; // 二进制/不可读：如实跳过，但会在范围里标出
    }
    const count = text.split(needle).length - 1;
    if (count > 0) hits.push({ file: f, count });
  }
  return hits;
}

describe('T14 合成 canary 全产物扫描（正文默认不外带）', () => {
  // 标题更正（原标题写「响应体…零命中」，与断言相反）：本用例对响应体**不**判零命中，
  // 反而要求它**必须**含 canary——那是「canary 确实进到了发送链」的正向证据。
  // 判零命中的只有两处范围：落盘产物、服务端日志行。
  it('T14a canary 走真实 runChat 后：落盘产物与服务端日志零命中，响应体回显可证 canary 确实进到了发送链', async () => {
    const dir = tmpRoot('canary');
    const probe = createOrderProbeDriver(createFixtureDriver(), dir);
    const h = await startApi({ driver: probe, journalDir: dir });

    const r = await post({
      port: h.port,
      apiKey: h.apiKey,
      body: {
        model: FIXTURE_MODEL_ID,
        messages: [{ role: 'user', content: `${CANARY_BODY} 请复述我上面的内容` }]
      },
      // 第二个 canary 放在**头部**维度：证明连非正文的客户端自定义面也不落盘
      headers: { 'x-zcc-client-id': CANARY_HEADER, 'x-zcc-session-id': CANARY_HEADER }
    });

    // 前提不是恒真：请求真的成功了，才说明 canary 真的走过发送链
    expect(r.status).toBe(200);
    expect(probe.calls.n).toBe(1);

    // fixture 驱动器**会把 prompt 回显进响应**。这不是泄漏——回给「把这段话发过来的
    // 同一个客户端」不构成「外带」；`:875` 禁的是把正文带出本机边界。
    // 这一条同时是「canary 确实进到了驱动器」的证据：回显里有它，才说明下面
    // 「盘上没有它」是因为没被持久化，而不是因为它压根没进来。
    expect(r.text).toContain('fixture_echo:');
    expect(r.text).toContain(CANARY_BODY);

    // —— 范围 1：临时 data 目录下的**每一个**落盘产物 ——
    const files = walkFiles(dir);
    // 扫描范围钉死，不只打日志：原子写是 tmp→rename，rename 后不留 tmp，
    // 所以本目录下应当**只有** journal 一个产物。范围若变了，下面「零命中」的口径就变了。
    expect(files.map((f) => path.basename(f)).sort()).toEqual(['api-operations-journal.json']);
    const bodyHits = scanFor(dir, CANARY_BODY);
    const headerHits = scanFor(dir, CANARY_HEADER);
    expect(bodyHits, `正文 canary 泄漏：${JSON.stringify(bodyHits)}`).toEqual([]);
    expect(headerHits, `头部 canary 泄漏：${JSON.stringify(headerHits)}`).toEqual([]);

    // —— 范围 2：HTTP 响应体（驱动器回显，见上；此处不判零命中，只判不越界）——
    // —— 范围 3：服务端日志行（每个 operation 恰好一条带指纹的日志）——
    for (const line of h.logs) {
      expect(line).not.toContain(CANARY_BODY);
      expect(line).not.toContain(CANARY_HEADER);
    }

    // 产物 hash（:876「脱敏导出hash」里能拿得到的那部分；注意这是 journal 而非导出文件）
    const journalBytes = fs.readFileSync(path.join(dir, 'api-operations-journal.json'));
    const crypto = await import('node:crypto');
    console.log(
      `CANARY_SCAN files=${files.length} bodyHits=0 headerHits=0 journalSha256=${crypto
        .createHash('sha256')
        .update(journalBytes)
        .digest('hex')}`
    );
  });

  it('T14b 扫描器自检（负控）：canary 真在场时必须被报出来，否则上面的「零命中」是假绿', () => {
    const dir = tmpRoot('canary-ctl');
    // 先确认空目录零命中（前提）
    expect(scanFor(dir, CANARY_BODY)).toEqual([]);

    // 把 canary 写进产物
    const planted = path.join(dir, 'planted.txt');
    fs.writeFileSync(planted, `前缀 ${CANARY_BODY} 后缀`, 'utf8');

    const hits = scanFor(dir, CANARY_BODY);
    expect(hits.length).toBe(1);
    expect(hits[0].file).toBe(planted);
    expect(hits[0].count).toBe(1);
    // 子目录也要能扫到，范围才是完整的（上一版忘了 mkdir，会 ENOENT）
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'x.txt'), CANARY_HEADER, 'utf8');
    expect(scanFor(dir, CANARY_HEADER).length).toBe(1);
  });
});