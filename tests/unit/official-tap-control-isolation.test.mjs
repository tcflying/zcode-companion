/**
 * official-tap-control-isolation.test.mjs — 控制通道隔离、白名单与注入帧形状的
 * 端到端证据。
 *
 * 本文件把工单最关心的几件事放在**真进程**上验：
 *
 *  1. **凭据永远不进控制通道**：构造一对凭据请求/应答帧（应答里带一个合成的、
 *     明显不是真凭据的字符串 `FIXTURE-NOT-A-REAL-CREDENTIAL`），让它们穿过 tap，
 *     然后断言——控制端收到过的**每一帧**里都没有它；同时断言这一对帧确实被
 *     透明中继到了桌面侧（否则"没收到"可能只是因为它压根没穿过来）。还断言
 *     `--log-dir` 下**任何文件**都不含该合成串（"绝不记录帧内容"）。
 *  2. **付费通道白名单在注入前拦截**：工单点名的五个 id 逐个注入，断言各有明确
 *     错误回执，且**子进程 stdin 一个字节都没多**（用 fixture 记账的
 *     `injectedIds` 交叉证明）。再放一个 `account:` 正例，证明拒绝不是恒真。
 *  3. **B1：注入帧形状对齐官方 strict schema**：带 `jsonrpc`（官方 `.strict()` 会
 *     拒收的键）的帧被明确拒绝，并且**子进程自己落盘的 stdin 字节里根本没有
 *     `jsonrpc`**——断言落在实际字节上，不是中间变量。
 *  4. **F3：注入帧大小上限对齐官方 1 MiB**，边界两侧都有测试。
 *
 * 注入帧一律用**官方形状**（`{id, method, params}`，无 `jsonrpc`）——官方
 * `zcodeProtocolRequestSchema` 是 `.strict()` 且没有 `jsonrpc` 键。
 *
 * 控制端口一律用 `--control-port 0`（系统分配）再从 tap 自己的诊断里读回实际
 * 端口：工程的 contract 门会对真实工程根**再跑一次** `test:unit`，同一批单测
 * 因此在两个 vitest 进程里同时执行，任何固定端口都会自己撞自己。生产端口 8791
 * 由 `CONTROL_DEFAULT_PORT` 常量与纯函数单测钉死。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTROL_MAX_LINE_BYTES,
  DIAG_FIELD_ALLOWLIST,
  MAX_INJECT_LINE_BYTES,
  OFFICIAL_REQUEST_TOP_LEVEL_KEYS,
  buildOfficialRequestLine,
  validateOfficialRequestFrame
} from '../../scripts/official-tap/tap-core.mjs';
import {
  connectControl,
  makeTempDir,
  parseNdjsonLines,
  removeTempDir,
  startTap,
  waitFor,
  waitForControlPort
} from '../helpers/tap-harness.mjs';

const TOKEN = 'test-control-token-0123456789abcdef';
const CREDENTIAL_ID = 'zcode-cred-7';
/** 与 fixture 里的合成串一致（fixture 源码里写死了这个值）。 */
const SYNTHETIC_SECRET = 'FIXTURE-NOT-A-REAL-CREDENTIAL';

/** @type {Array<{ stop: () => Promise<void> }>} */
const running = [];
/** @type {string[]} */
const tempDirs = [];
/** @type {Array<{ close: () => void }>} */
const sockets = [];

afterEach(async () => {
  for (const socket of sockets.splice(0, sockets.length)) socket.close();
  for (const handle of running.splice(0, running.length)) await handle.stop();
  for (const dir of tempDirs.splice(0, tempDirs.length)) removeTempDir(dir);
});

/** @param {string} prefix @returns {string} */
function tempDir(prefix) {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

/**
 * 把 tap 的 stdout 读成一组帧。
 *
 * @param {{ stdout: () => Buffer }} tap
 * @returns {Array<Record<string, unknown>>}
 */
function desktopSideFrames(tap) {
  return parseNdjsonLines(tap.stdout());
}

/**
 * @param {string} dir
 * @returns {string[]} 该目录下所有文件的绝对路径
 */
function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}

describe('凭据帧永远不进控制通道', () => {
  it('凭据请求/应答被透明中继给桌面，但控制端从未收到', async () => {
    const dir = tempDir('isolation');
    const reportPath = join(dir, 'report.json');
    const silentId = 'zcc-tap-silent-1';

    const tap = startTap({
      logDir: dir,
      port: 0,
      env: { ZCC_TAP_TOKEN: TOKEN },
      fixtureArgs: [
        '--report',
        reportPath,
        '--credential-request',
        CREDENTIAL_ID,
        '--credential-answer',
        CREDENTIAL_ID,
        '--inject-respond',
        '--inject-silent-id',
        silentId
      ]
    });
    running.push(tap);

    const controlPort = await waitForControlPort(dir);
    const control = await connectControl(controlPort, TOKEN);
    sockets.push(control);
    const hello = await control.next('hello');
    expect(hello['protocol']).toBe(1);
    expect(hello['controlPort']).toBe(controlPort);

    // 1) 等凭据请求帧抵达桌面侧（证明这一对帧真的会穿过 tap）。
    await waitFor(
      () => desktopSideFrames(tap).find((frame) => frame['id'] === CREDENTIAL_ID && typeof frame['method'] === 'string'),
      { what: 'credential request relayed to desktop', timeoutMs: 10_000 }
    );

    // 2) 桌面（测试扮演）作答：这一帧里带合成凭据。
    const answer = `${JSON.stringify({
      id: CREDENTIAL_ID,
      result: { headers: { authorization: `Bearer ${SYNTHETIC_SECRET}` } }
    })}\n`;
    tap.write(answer);

    // 3) fixture 回凭据结果帧，其中再次含合成凭据；它必须原样抵达桌面侧。
    await waitFor(
      () => tap.stdout().toString('utf8').includes(SYNTHETIC_SECRET),
      { what: 'credential result relayed to desktop', timeoutMs: 10_000 }
    );

    // 4) 核心断言：控制端收到过的每一帧都不含该合成串，也不含凭据帧的形状。
    const controlSaw = JSON.stringify(control.all());
    expect(controlSaw).not.toContain(SYNTHETIC_SECRET);
    expect(controlSaw).not.toContain('authorization');
    expect(controlSaw).not.toContain('Bearer');
    expect(control.all().map((frame) => frame['op'])).toEqual(['hello']);
    expect(control.all().some((frame) => frame['requestId'] === CREDENTIAL_ID)).toBe(false);
    expect(control.all().some((frame) => frame['id'] === CREDENTIAL_ID)).toBe(false);

    // 5) 桌面侧确实看到了这一对帧（双向透明中继，不是被丢弃）。
    const desktop = desktopSideFrames(tap);
    expect(desktop.filter((frame) => frame['id'] === CREDENTIAL_ID).length).toBe(2);

    // 6) 注入一个合法订阅通道请求：控制端拿到应答，且应答里同样没有凭据。
    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'corr-1',
        frame: {
          id: 'zcc-tap-probe-1',
          method: 'session/prompt',
          params: { model: 'account:bigmodel-individual-coding-plan' }
        }
      }
    });
    const ack = await control.next('inject.ack');
    expect(ack['requestId']).toBe('zcc-tap-probe-1');
    const response = await control.next('response');
    expect(response['requestId']).toBe('zcc-tap-probe-1');
    expect(/** @type {Record<string, unknown>} */ (response['frame'])['id']).toBe('zcc-tap-probe-1');
    expect(JSON.stringify(control.all())).not.toContain(SYNTHETIC_SECRET);

    // 7) 重复 id：确定行为是 duplicate_id，不重发。
    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'corr-dup-1',
        frame: { id: silentId, method: 'session/prompt', params: { model: 'account:plan' } }
      }
    });
    const firstAck = await control.next('inject.ack');
    expect(firstAck['requestId']).toBe(silentId);
    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'corr-dup-2',
        frame: { id: silentId, method: 'session/prompt', params: { model: 'account:plan' } }
      }
    });
    const dup = await control.next('inject.error');
    expect(/** @type {Record<string, unknown>} */ (dup['error'])['code']).toBe('duplicate_id');

    // 8) 收尾：等 fixture 落报告（它的 stdin 结束时会写）。
    tap.endStdin();
    await tap.waitExit();
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.credentialExchanged, 'fixture 没收到凭据应答 → 隔离断言会失去意义').toBe(true);
    expect(report.credentialAnswerSha256.length).toBe(64);

    // 交叉证明：子进程只见到被放行的 id。重复 id 那一次**没有**进子进程 stdin
    //    （silentId 只出现一次）——这正是"不重发"的证据。
    expect(report.injectedIds).toEqual(['zcc-tap-probe-1', silentId]);
  });

  it('诊断文件里没有任何内容：键全在白名单内，且不含合成凭据', async () => {
    const dir = tempDir('no-content-log');
    const reportPath = join(dir, 'report.json');
    const tap = startTap({
      logDir: dir,
      port: 0,
      env: { ZCC_TAP_TOKEN: TOKEN },
      fixtureArgs: ['--report', reportPath, '--credential-request', CREDENTIAL_ID, '--credential-answer', CREDENTIAL_ID]
    });
    running.push(tap);
    const port = Number(
      await waitFor(
        () => {
          const text = readFileSync(join(dir, 'zcode-stdio-tap.diag.jsonl'), 'utf8');
          const hit = text.split('\n').find((line) => line.includes('"control_listen"'));
          return hit === undefined ? null : JSON.parse(hit).controlPort;
        },
        { what: 'control_listen' }
      )
    );
    const control = await connectControl(port, TOKEN);
    sockets.push(control);
    await control.next('hello');

    await waitFor(() => desktopSideFrames(tap).find((f) => f['id'] === CREDENTIAL_ID), { what: 'credential request' });
    tap.write(`${JSON.stringify({ id: CREDENTIAL_ID, result: { headers: { authorization: `Bearer ${SYNTHETIC_SECRET}` } } })}\n`);
    await waitFor(() => tap.stdout().toString('utf8').includes(SYNTHETIC_SECRET), { what: 'credential result' });

    tap.endStdin();
    await tap.waitExit();

    // 断言一：tap 写出的**任何文件**都不含合成凭据。
    for (const file of listFiles(dir)) {
      if (file === reportPath) continue; // 那是 fixture 写的，且它也不含明文
      expect(readFileSync(file, 'utf8'), file).not.toContain(SYNTHETIC_SECRET);
    }

    // 断言二：诊断 JSONL 的每一个键都在白名单内（结构上不可能有内容字段）。
    const diagLines = readFileSync(join(dir, 'zcode-stdio-tap.diag.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(diagLines.length).toBeGreaterThan(0);
    for (const line of diagLines) {
      const record = JSON.parse(line);
      for (const key of Object.keys(record)) {
        expect(DIAG_FIELD_ALLOWLIST.includes(key), `诊断里出现了白名单外的键 ${key}`).toBe(true);
      }
    }
  });
});

describe('付费通道白名单在注入前拦截', () => {
  it('五个点名 id 全部拒绝且不入子进程 stdin，account: 正例放行', async () => {
    const dir = tempDir('whitelist');
    const reportPath = join(dir, 'report.json');
    const tap = startTap({
      logDir: dir,
      port: 0,
      env: { ZCC_TAP_TOKEN: TOKEN },
      fixtureArgs: ['--report', reportPath, '--inject-respond']
    });
    running.push(tap);

    const controlPort = await waitForControlPort(dir);
    const control = await connectControl(controlPort, TOKEN);
    sockets.push(control);
    await control.next('hello');

    const blocked = ['bigmodel-api', 'zai-api', 'zai-standard-api', 'builtin:bigmodel', 'builtin:zai'];
    let n = 0;
    for (const model of blocked) {
      n += 1;
      control.send({
        zccTap: {
          v: 1,
          op: 'inject',
          id: `blocked-${n}`,
          frame: { id: `zcc-tap-blocked-${n}`, method: 'session/prompt', params: { model } }
        }
      });
      const err = await control.nextWhere((frame) => frame['id'] === `blocked-${n}`);
      expect(err['op'], model).toBe('inject.error');
      expect(/** @type {Record<string, unknown>} */ (err['error'])['code'], model).toBe('blocked_channel');
    }

    // 非白名单前缀（非黑名单那五个）也拒绝。
    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'not-allowlisted',
        frame: { id: 'zcc-tap-allow-1', method: 'session/prompt', params: { model: 'openai-api' } }
      }
    });
    const notAllowed = await control.nextWhere((frame) => frame['id'] === 'not-allowlisted');
    expect(/** @type {Record<string, unknown>} */ (notAllowed['error'])['code']).toBe('channel_not_allowlisted');

    // 拿不到通道标识 → 拒绝。
    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'no-model',
        frame: { id: 'zcc-tap-nomodel-1', method: 'session/list' }
      }
    });
    const noModel = await control.nextWhere((frame) => frame['id'] === 'no-model');
    expect(/** @type {Record<string, unknown>} */ (noModel['error'])['code']).toBe('model_field_missing');

    // id 不在命名空间 → 拒绝（连白名单判定都不进入）。
    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'bad-ns',
        frame: { id: 'not-ours-1', method: 'session/prompt', params: { model: 'account:plan' } }
      }
    });
    const badNs = await control.nextWhere((frame) => frame['id'] === 'bad-ns');
    expect(/** @type {Record<string, unknown>} */ (badNs['error'])['code']).toBe('bad_id_namespace');

    // 正例：account: 前缀放行并真的到达子进程（证明上面那些拒绝不是恒真）。
    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'allowed',
        frame: {
          id: 'zcc-tap-allowed-1',
          method: 'session/prompt',
          params: { model: 'account:bigmodel-individual-coding-plan' }
        }
      }
    });
    const okAck = await control.nextWhere((frame) => frame['id'] === 'allowed');
    expect(okAck['op']).toBe('inject.ack');
    const okResponse = await control.next('response');
    expect(okResponse['requestId']).toBe('zcc-tap-allowed-1');

    tap.endStdin();
    await tap.waitExit();

    // 交叉证明：子进程只见到**被放行**的那个 id，被拒的八次一个字节都没进去。
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.injectedIds).toEqual(['zcc-tap-allowed-1']);
  });
});

/**
 * TAPFIX(B1)：注入帧的形状必须对齐官方 `zcodeProtocolRequestSchema`。
 *
 * 官方那条 schema 是 `m.object({id, method, params, trace}).strict()`——**没有
 * `jsonrpc` 键**（`C:\ZCode\resources\glm\zcode.cjs:72` col 137537，导出名
 * `zcodeProtocolRequestSchema` 见同文件 :96 col 55444），而 app-server 的
 * `decodeLine` 用 `qHt.safeParse`（同文件 :15265 col 2157）。`.strict()` 意味着多一个
 * 键就整帧作废，而失败回的那一帧 id 是字面量 `"invalid-message"`，tap 判成
 * `forward_only` 转发给桌面、桌面静默丢弃 ⇒ **整条失败链全链路静默**，控制端只能干等
 * 120 s 超时。TAPIMPL 的每一个注入帧都带 `jsonrpc: "2.0"`，所以按那时的帧形状，
 * 注入在真 app-server 上永远不成立。
 *
 * tap 现在的选择是**拒绝**（回 `invalid_frame_shape`），不是静默剥离：静默改写会让
 * "注入的到底是什么"不可追，而 tap 其余判定全是默认拒绝 + 明确错误码。
 *
 * 关键：断言落在 fixture **自己 stdin 收到的字节**上（`--record` 由子进程写，
 * 按自己的行解析记账），不是断言 tap 里的中间变量。
 */
describe('B1：写进子进程 stdin 的注入帧对齐官方 strict schema', () => {
  it('带 jsonrpc 的帧被拒（invalid_frame_shape），且一个字节都没进子进程 stdin', async () => {
    const dir = tempDir('b1-jsonrpc');
    const recordPath = join(dir, 'child-stdin.bin');
    const reportPath = join(dir, 'report.json');
    const tap = startTap({
      logDir: dir,
      port: 0,
      env: { ZCC_TAP_TOKEN: TOKEN },
      fixtureArgs: ['--record', recordPath, '--report', reportPath, '--inject-respond']
    });
    running.push(tap);
    const port = await waitForControlPort(dir);
    const control = await connectControl(port, TOKEN);
    sockets.push(control);
    await control.next('hello');

    // 1) 带 `jsonrpc` 的帧 —— 这正是 TAPIMPL 过去发出的每一种帧。
    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'with-jsonrpc',
        frame: {
          jsonrpc: '2.0',
          id: 'zcc-tap-with-jsonrpc',
          method: 'session/prompt',
          params: { model: 'account:bigmodel-individual-coding-plan' }
        }
      }
    });
    const rejected = await control.nextWhere((f) => f['id'] === 'with-jsonrpc');
    expect(rejected['op']).toBe('inject.error');
    expect(/** @type {Record<string, unknown>} */ (rejected['error'])['code']).toBe('invalid_frame_shape');
    // 错误回执指名了 offending 键，但**不回显**帧内容。
    expect(/** @type {Record<string, unknown>} */ (rejected['error'])['field']).toBe('frame.jsonrpc');
    expect(JSON.stringify(rejected)).not.toContain('session/prompt');

    // 2) 其它任何官方键集合之外的顶层键同样被拒。
    for (const extraKey of ['result', 'error', 'meta']) {
      const corr = `extra-${extraKey}`;
      control.send({
        zccTap: {
          v: 1,
          op: 'inject',
          id: corr,
          frame: /** @type {Record<string, unknown>} */ ({
            id: `zcc-tap-extra-${extraKey}`,
            method: 'session/prompt',
            params: { model: 'account:plan' },
            [extraKey]: 'x'
          })
        }
      });
      const err = await control.nextWhere((f) => f['id'] === corr);
      expect(err['op'], extraKey).toBe('inject.error');
      expect(/** @type {Record<string, unknown>} */ (err['error'])['code'], extraKey).toBe('invalid_frame_shape');
    }

    // 3) 官方形状的正例放行。
    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'official',
        frame: {
          id: 'zcc-tap-official-1',
          method: 'session/prompt',
          params: { model: 'account:bigmodel-individual-coding-plan' }
        }
      }
    });
    expect((await control.nextWhere((f) => f['id'] === 'official'))['op']).toBe('inject.ack');
    await control.next('response');

    tap.endStdin();
    await tap.waitExit();

    // 4) 核心断言：读**子进程自己落盘的 stdin 字节**。
    const childStdin = readFileSync(recordPath);
    const raw = childStdin.toString('utf8');
    // 落进子进程的字节里根本没有 `jsonrpc` 这个键。
    expect(raw).not.toContain('jsonrpc');
    // 每一行的顶层键都是官方键集合的子集。
    const frames = parseNdjsonLines(childStdin);
    expect(frames.length).toBe(1);
    for (const frame of frames) {
      for (const key of Object.keys(frame)) {
        expect(OFFICIAL_REQUEST_TOP_LEVEL_KEYS.includes(key), `子进程 stdin 里出现了官方 schema 之外的键 ${key}`).toBe(true);
      }
    }
    // 正例确实到了（证明上面那些拒绝不是恒真），且 id 就是我们注入的那个。
    expect(frames[0]?.['id']).toBe('zcc-tap-official-1');
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).injectedIds).toEqual(['zcc-tap-official-1']);
  });

  it('顶层键不在官方集合内的帧连序列化都到不了，写出去的是重建后的投影', async () => {
    // 纯函数层：投影是"重建"而不是"转发"——即使校验被绕过，输出的顶层键也只可能是
    // 官方那四个。这一条钉住"投影"这个性质本身（拒绝发生在它之前）。
    const verdict = validateOfficialRequestFrame({
      jsonrpc: '2.0',
      id: 'zcc-tap-proj-1',
      method: 'session/prompt',
      params: { model: 'account:plan' }
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('invalid_frame_shape');
    expect(verdict.field).toBe('frame.jsonrpc');
    expect(verdict.detail).not.toContain('session/prompt');
  });
});

/**
 * TAPFIX(F3)：注入帧单行上限定为 1 MiB。
 *
 * **TAPFIX3 / P3.1 更正了这条注释原先的方向。** 原文写的是"对齐官方
 * `maxFrameBytes`"，并把原先的 4 MiB 说成"放心地写出官方必然拒收的帧"——**两处都不
 * 成立**，依据是反的：
 *  - `fc.maxFrameBytes:1024*1024`（`C:\ZCode\resources\glm\zcode.cjs:72` col 49239）
 *    只在**出站**物理信封/分片组装那一侧被消费（`QI = { maxPhysicalFrameBytes: … }`）。
 *    官方**入站**读取器 `ZCodeProtocolNdjsonConnection.onData` 是
 *    `buffer += chunk; indexOf("\n")`，**没有任何行长守卫**；整个 bundle 里
 *    `maxLineBytes` / `lineTooLong` / `frameTooLarge` 均 0 命中。
 *  - 因此"超过 1 MiB 官方必然拒收"是**假的**。超界帧的官方结局是别的形式（schema
 *    解析失败、逻辑帧组装上限、更外层的资源限制），不是"1 MiB 拒收"这条规则。
 *
 * 准确表述是：**1 MiB 是我们自选的、比官方更保守的策略界**，作用是让控制端立刻拿到
 * 明确回执，而不是挂到 120 s 超时。字面值相同是事实，方向相反的引证不是。
 *
 * 断言落在子进程自己落盘的 stdin 字节上：超界的那一帧**不能**出现。
 */
describe('F3：注入帧单行上限 = 1 MiB（保守自选值，非对齐官方强制上限）', () => {
  /** 造一个序列化后（含行终止符）恰好 N 字节的官方形状注入帧。
   * @param {number} totalBytes
   * @param {string} id
   */
  function frameOfBytes(totalBytes, id) {
    const head = { id, method: 'session/prompt' };
    const probe = { ...head, params: { model: 'account:plan', pad: '' } };
    // JSON.stringify(probe) 末尾是 "}}"，pad 补 0 长度时已是基线；再补 N - len - 1
    // 个字符就让整行（加 `\n`）恰好等于 totalBytes。
    const pad = totalBytes - JSON.stringify(probe).length - 1;
    return { ...head, params: { model: 'account:plan', pad: 'x'.repeat(pad) } };
  }

  it('常量值是 1 MiB 的策略界（原 4 MiB），不再是 4 MiB', () => {
    expect(MAX_INJECT_LINE_BYTES).toBe(1024 * 1024);
    // 控制通道上限必须**大于**注入上限：控制帧是 `{zccTap:{v,op,id,frame}}`，外层包装
    // 本身有几十字节开销，控制层比策略界小的话，"刚好界内的注入帧"会被外层先顶出去。
    //
    // TAPFIX3 / P3.2 更正：原文在这里写的是"否则 MAX_INJECT_LINE_BYTES 就成了永远
    // 够不到的死数字"。**这个理由是假的**——对照实验把 2 MiB 改回 1 MiB，F3 端到端
    // 行为逐字节相同。真正成立的理由是上面那句**包装开销**：留的是防御性余量，
    // 不是"内层失效"这么严重的说法。
    expect(CONTROL_MAX_LINE_BYTES).toBeGreaterThan(MAX_INJECT_LINE_BYTES);
  });

  it('界内接受、超界拒绝，且超界的那一帧不写进子进程 stdin', async () => {
    const atLimit = buildOfficialRequestLine(frameOfBytes(MAX_INJECT_LINE_BYTES, 'zcc-tap-atlimit'));
    expect(atLimit.ok, '恰好 1 MiB 应当被接受').toBe(true);
    if (atLimit.ok) expect(atLimit.bytes).toBe(MAX_INJECT_LINE_BYTES);

    const overLimit = buildOfficialRequestLine(frameOfBytes(MAX_INJECT_LINE_BYTES + 1, 'zcc-tap-overlimit'));
    expect(overLimit.ok, '1 MiB + 1 字节应当被拒绝').toBe(false);
    if (overLimit.ok) return;
    expect(overLimit.code).toBe('frame_too_large');

    // 端到端：两帧都真的经控制通道发一次，子进程只应见到界内那一帧。
    const dir = tempDir('f3-size');
    const recordPath = join(dir, 'child-stdin.bin');
    const tap = startTap({
      logDir: dir,
      port: 0,
      env: { ZCC_TAP_TOKEN: TOKEN },
      fixtureArgs: ['--record', recordPath, '--inject-respond']
    });
    running.push(tap);
    const port = await waitForControlPort(dir);
    const control = await connectControl(port, TOKEN);
    sockets.push(control);
    await control.next('hello');

    control.send({ zccTap: { v: 1, op: 'inject', id: 'over', frame: frameOfBytes(MAX_INJECT_LINE_BYTES + 1, 'zcc-tap-overlimit') } });
    const overErr = await control.nextWhere((f) => f['id'] === 'over');
    expect(overErr['op']).toBe('inject.error');
    expect(/** @type {Record<string, unknown>} */ (overErr['error'])['code']).toBe('frame_too_large');

    control.send({ zccTap: { v: 1, op: 'inject', id: 'at', frame: frameOfBytes(MAX_INJECT_LINE_BYTES, 'zcc-tap-atlimit') } });
    expect((await control.nextWhere((f) => f['id'] === 'at'))['op']).toBe('inject.ack');
    await control.next('response', 30_000);

    tap.endStdin();
    await tap.waitExit();

    const childStdin = readFileSync(recordPath);
    const frames = parseNdjsonLines(childStdin);
    expect(frames.map((f) => f['id'])).toEqual(['zcc-tap-atlimit']);
    // 超界那一帧一个字节都没进子进程。
    expect(childStdin.toString('utf8')).not.toContain('zcc-tap-overlimit');
  }, 60000);
});

describe('控制通道协议本身（错误路径有确定行为）', () => {
  it('ping / status / 未知 op 都是确定回执；协议错误后连接即终止', async () => {
    const dir = tempDir('protocol');
    const tap = startTap({
      logDir: dir,
      port: 0,
      env: { ZCC_TAP_TOKEN: TOKEN },
      fixtureArgs: ['--inject-respond']
    });
    running.push(tap);
    const port = await waitForControlPort(dir);

    const control = await connectControl(port, TOKEN);
    sockets.push(control);
    await control.next('hello');

    control.send({ zccTap: { v: 1, op: 'ping' } });
    expect((await control.next('pong'))['op']).toBe('pong');

    control.send({ zccTap: { v: 1, op: 'status' } });
    const status = await control.next('status');
    const fields = /** @type {Record<string, unknown>} */ (status['status']);
    // status 只回不含内容的运行字段。
    for (const key of Object.keys(fields)) {
      expect(DIAG_FIELD_ALLOWLIST.includes(key) || key === 'state', `status 出现了不该有的字段 ${key}`).toBe(true);
    }
    expect(typeof fields['pid']).toBe('number');
    expect(JSON.stringify(fields)).not.toContain(SYNTHETIC_SECRET);

    control.send({ zccTap: { v: 1, op: 'does-not-exist' } });
    expect(/** @type {Record<string, unknown>} */ ((await control.next('error'))['error'])['code']).toBe('unknown_op');
    // 协议错误 = 确定性终止：连接被关掉，后续帧不再有回执。
    expect((await control.next('__closed__', 5000))['op']).toBe('__closed__');
    control.close();

    tap.endStdin();
    await tap.waitExit();
  });

  it('版本不符、非法 JSON 各自是独立的确定错误（各自一条连接）', async () => {
    const dir = tempDir('protocol-bad');
    const tap = startTap({ logDir: dir, port: 0, env: { ZCC_TAP_TOKEN: TOKEN }, fixtureArgs: [] });
    running.push(tap);
    const port = await waitForControlPort(dir);

    const first = await connectControl(port, TOKEN);
    sockets.push(first);
    await first.next('hello');
    first.send({ zccTap: { v: 99, op: 'ping' } });
    expect(/** @type {Record<string, unknown>} */ ((await first.next('error'))['error'])['code']).toBe(
      'protocol_version_mismatch'
    );
    first.close();

    const second = await connectControl(port, TOKEN);
    sockets.push(second);
    await second.next('hello');
    second.sendFrame('this is not json at all');
    expect(/** @type {Record<string, unknown>} */ ((await second.next('error'))['error'])['code']).toBe('invalid_json');
    second.close();

    tap.endStdin();
    await tap.waitExit();
  });

  it('未 auth 就发操作 → unauthorized；令牌错误的连接拿不到任何能力', async () => {
    const dir = tempDir('no-auth');
    const tap = startTap({ logDir: dir, port: 0, env: { ZCC_TAP_TOKEN: TOKEN }, fixtureArgs: [] });
    running.push(tap);
    const port = await waitForControlPort(dir);
    const control = await connectControl(port, 'wrong-token-0123456789abcdef');
    sockets.push(control);
    expect(/** @type {Record<string, unknown>} */ ((await control.next('error'))['error'])['code']).toBe('unauthorized');
    tap.endStdin();
    await tap.waitExit();
  });
});
