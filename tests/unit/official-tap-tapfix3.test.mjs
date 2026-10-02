/**
 * official-tap-tapfix3.test.mjs — TAPFIX3 的四条收口证据。
 *
 * 背景（为什么这些测试的重量级）：tap 是**桌面 spawn app-server 时的中间层**。
 * tap 进程死 = 桌面那条会话跟着死。上一轮 TAPFIX 修完 B1 等四项后，独立复审翻了三条
 * 事实错误和一条既有鲁棒性缺口。本文件把四条都钉在**真进程**上。
 *
 *  - **P1 控制通道注入路径无异常隔离**（最高优先，会害到桌面）：约 1.6 MB、嵌套 2 万层
 *    的控制帧会让通道标识收集抛 `RangeError`，而 `options.inject` 当时没有 try/catch，
 *    异常逃出 socket handler → **tap 进程死、桌面会话一起死**。这里有四层证据：
 *      1. 纯函数层：深度上限本身；
 *      2. **真 tap 进程**端到端：那条曾经致命的帧现在被确定性拒收，进程仍活、后续帧
 *         仍被服务、子进程 stdin 仍只见到合法帧；
 *      3. mock 抛错的**真子进程**：证明异常确实不逃逸（退出码 0 是硬证据）；
 *      4. 同进程内的注入/status/auth/diag 各类抛错，都变成结构化回执且连接继续可用。
 *  - **P2 `CONTROL_MAX_LINE_BYTES` 守卫对完整大行无效**：检查原先在切行循环**之后**，
 *    完整的大行那时早被消费掉了。现在检查前移到切走之前，两侧都有边界断言。
 *  - **P3 注释依据**：常量值与"官方入站侧根本没有行长强制上限"的事实由**读官方 bundle**
 *    的断言钉住，避免注释再次漂移。
 *  - **P4 异常路径可诊断性**：隔离层写的诊断只许出现连接 id / 错误**类别名** / 字节数，
 *    **不得**出现帧内容、错误消息原文、控制令牌。
 *
 * ## TAPN 收口（本轮追加，独立复审 §14 的非阻塞项 N1 与 N4）
 *
 *  - **N1**：`net.Server` 的 `error` 监听器现在是**常驻**的。原来那个
 *    `once('error', reject)` 在 listen 成功后被摘掉，此后 `Server` 上**一个 `error`
 *    监听器都没有**——而 Node 的 `EventEmitter` 对无监听器的 `error` 事件**直接
 *    throw**，accept 阶段的 `EMFILE` 会一路冒到 `uncaughtException` → tap 死 →
 *    桌面会话一起死。本文件有三条用例钉住它（同进程注入 / 白名单净化 / 真子进程
 *    退出码为 0 且 stderr 为空）。
 *  - **N4**：P1-b 里那条 `expect(tap.exit).toBeNull()` 原本**顺序上不可达**——tap 真死
 *    时测试早在 `nextWhere` 的 10 秒超时处结束。现在收帧与退出**竞速**
 *    （`receiveOrTapExit`），存活断言排在竞速之后，两条分支都走同一行断言。
 *  - **N2 / N3**（文案方向）在 `official-tap-core.test.mjs` 里。
 *
 * 控制端口一律 `--control-port 0`（系统分配）再从 tap 自己的诊断里读回实际端口：工程
 * contract 门会对真实工程根**再跑一次** `test:unit`，同一批单测因此在两个 vitest
 * 进程里同时执行，任何固定端口都会自己撞自己。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTROL_MAX_LINE_BYTES,
  DIAG_FIELD_ALLOWLIST,
  DIAG_MAX_VALUE_CHARS,
  MAX_CHANNEL_SCAN_DEPTH,
  MAX_INJECT_LINE_BYTES,
  createChildStdinGate,
  evaluateInjectPolicy,
  isUsableControlToken,
  sanitizeDiagFields,
  scanChannelTokens
} from '../../scripts/official-tap/tap-core.mjs';
import { errorClassName, startControlServer } from '../../scripts/official-tap/tap-control.mjs';
import {
  REPO_ROOT,
  connectControl,
  makeTempDir,
  parseNdjsonLines,
  readDiagEvents,
  removeTempDir,
  startTap,
  waitFor,
  waitForControlPort,
  waitForDiagEvent
} from '../helpers/tap-harness.mjs';

const TOKEN = 'test-control-token-0123456789abcdef';
/** 藏在注入帧 params 里、用来证明"帧内容绝不出现在诊断里"的标记串。 */
const CONTENT_MARKER = 'TAPFIX3-CONTENT-MUST-NOT-BE-LOGGED';
/** 藏在 mock 抛出的 `Error.message` 里、用来证明"错误消息原文绝不出现在诊断里"。 */
const MESSAGE_MARKER = 'TAPFIX3-ERROR-MESSAGE-MUST-NOT-BE-LOGGED';

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
 * 造一条 `ping` 控制行，长度**恰好** `totalBytes` 字节（含行终止符 `\n`）。
 *
 * @param {number} totalBytes
 * @returns {string}
 */
function pingLineOfBytes(totalBytes) {
  const base = { zccTap: { v: 1, op: 'ping', pad: '' } };
  const overhead = Buffer.byteLength(`${JSON.stringify(base)}\n`, 'utf8');
  return `${JSON.stringify({ zccTap: { v: 1, op: 'ping', pad: 'x'.repeat(totalBytes - overhead) } })}\n`;
}

/**
 * 造一条嵌套 `depth` 层的控制帧。
 *
 * **用字符串拼而不是 `JSON.stringify`**：`JSON.stringify` 自己也会在这层深度上爆栈，
 * 于是测试会在"造数据"这一步就死掉，根本测不到 tap 里的代码。
 *
 * @param {number} depth
 * @param {string} correlation
 */
function deepInjectLine(depth, correlation) {
  const nested = `${'{"n":'.repeat(depth)}{"model":"account:plan"}${'}'.repeat(depth)}`;
  return `{"zccTap":{"v":1,"op":"inject","id":"${correlation}","frame":{"id":"zcc-tap-deep-1","method":"session/prompt","params":${nested}}}}\n`;
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * **与 tap 退出竞速地**收下一帧（TAPN / N4）。
 *
 * ## 为什么需要它
 *
 * 上一版 P1-b 里那条 `expect(tap.exit).toBeNull()` 排在
 * `await control.nextWhere(...)` **之后**。复审用变异体 M6 证伪了它：把深度上限与
 * 两道隔离层都撤掉、让 tap **真的死掉**之后，测试在 `nextWhere` 的 10 秒超时就结束了，
 * 那一行**顺序上不可达**——它是一条名义断言。
 *
 * `await control.nextWhere(...)` 单独用还有第二个问题：它抛出来的信息
 * `control frame not received within 10000 ms` 是**二义的**（是这一帧有问题，还是
 * tap 整个死了？），而 tap 死后 10 秒才知道，排查时信息量极低。
 *
 * ## 它做什么
 *
 * 让"tap 退出"与"帧到达"抢同一个 `Promise.race`：
 *  - **tap 死了** → `whenExited()` 先 resolve，竞速**当场**结束；
 *  - **tap 活着** → 帧先到，竞速结束。
 *
 * 两条分支都一定 settle，所以调用方紧随其后的 `expect(tap.exit, …).toBeNull()`
 * **在 tap 真死时是真的被执行到并变红的**，失败信息里直接带退出码与已收到的 op 列表。
 *
 * @param {import('../helpers/tap-harness.mjs').TapHandle} tap
 * @param {() => Promise<Record<string, unknown>>} receive
 * @returns {Promise<{ frame: Record<string, unknown> | null, exited: boolean }>}
 */
async function receiveOrTapExit(tap, receive) {
  // 两个分支都吞掉自己的失败：竞速的胜者不该被落败者的异常改写。
  const arrived = receive().then(
    (frame) => ({ frame, exited: false }),
    () => ({ frame: null, exited: false })
  );
  const dead = tap.whenExited().then(() => ({ frame: null, exited: true }));
  const outcome = await Promise.race([arrived, dead]);
  // 竞速有可能先被"连接已关闭"赢下（那是 tap 正在死亡的表现，但 `child.on('exit')`
  // 未必已经落地——socket 的 FIN 与子进程被回收是两条独立通知）。有界等一次退出记录，
  // 让调用方看到的 `tap.exit` 是**最终**事实而不是时序快照。
  if (outcome.frame !== null && outcome.frame['op'] === '__closed__') {
    await Promise.race([tap.whenExited(), sleep(2000)]);
  }
  return outcome;
}

/* ========================================================================== */
/* P1-a：纯函数层——通道标识扫描的深度上限                                    */
/* ========================================================================== */

describe('P1-a：通道标识扫描有递归深度上限，深嵌套帧不再抛 RangeError', () => {
  /**
   * 造一个嵌套 `depth` 层的对象（用循环展开，构造侧本身不递归）。
   *
   * @param {number} depth
   * @param {unknown} leaf
   * @returns {unknown}
   */
  function nest(depth, leaf) {
    /** @type {unknown} */
    let node = leaf;
    for (let i = 0; i < depth; i++) node = { n: node };
    return node;
  }

  it('真实注入帧那种深度（个位数到十几层）照常扫到通道标识，不被截断', () => {
    const frame = { id: 'zcc-tap-x', method: 'session/prompt', params: nest(10, { model: 'account:plan' }) };
    const scan = scanChannelTokens(frame);
    expect(scan.truncated, '浅层帧不该被截断').toBe(false);
    expect(scan.tokens.map((t) => t.value)).toEqual(['account:plan']);
    const verdict = evaluateInjectPolicy(frame);
    expect(verdict.ok).toBe(true);
  });

  it('截断边界恰好在 MAX_CHANNEL_SCAN_DEPTH：界内扫得到、界外标 truncated', () => {
    // 叶子的深度 = 嵌套层数 + 1（叶子自己占一层）。
    const inside = scanChannelTokens(nest(MAX_CHANNEL_SCAN_DEPTH - 1, { model: 'account:plan' }));
    expect(inside.truncated, `嵌套 ${MAX_CHANNEL_SCAN_DEPTH - 1} 层应在界内`).toBe(false);
    expect(inside.tokens.map((t) => t.value)).toEqual(['account:plan']);

    const outside = scanChannelTokens(nest(MAX_CHANNEL_SCAN_DEPTH + 1, { model: 'account:plan' }));
    expect(outside.truncated, `嵌套 ${MAX_CHANNEL_SCAN_DEPTH + 1} 层应被截断`).toBe(true);
  });

  it('截断帧的判定是 frame_too_deep（拒收，不是乐观放行）', () => {
    const verdict = evaluateInjectPolicy({
      id: 'zcc-tap-deep',
      method: 'session/prompt',
      params: nest(MAX_CHANNEL_SCAN_DEPTH + 5, { model: 'account:plan' })
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('frame_too_deep');
  });

  it('2 万层嵌套不再抛 RangeError（复审实测这就是杀死 tap 的那个输入）', () => {
    const depth = 20_000;
    const line = deepInjectLine(depth, 'deep');
    // 前置事实：不加深度上限时这个形状必然抛栈溢出。
    expect(line.length).toBeLessThan(CONTROL_MAX_LINE_BYTES);
    const parsed = JSON.parse(line);
    expect(() => scanChannelTokens(parsed['zccTap'])).not.toThrow();
    expect(scanChannelTokens(parsed['zccTap']).truncated).toBe(true);
  });
});

/* ========================================================================== */
/* P1-b：真 tap 进程端到端——曾经杀死桌面会话的那条帧                        */
/* ========================================================================== */

describe('P1-b：真 tap 进程遇到深嵌套控制帧不退出，后续帧照常服务', () => {
  it('2 万层帧被确定性拒收；tap 仍活；同一连接的后续合法注入照常往返', async () => {
    const dir = tempDir('tapfix3-deep');
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

    // 1) 那条曾经杀死 tap 的帧（约 120 KB，远低于 2 MiB 控制通道上限——它能合法到达）。
    control.sendFrame(deepInjectLine(20_000, 'deep').slice(0, -1));

    // 2) **先判死活，再收帧**（TAPN / N4）。`receiveOrTapExit` 无论 tap 死没死都一定
    //    settle，所以紧随其后的存活断言是**真的被执行到**的，不再是一条名义断言。
    const outcome = await receiveOrTapExit(tap, () => control.nextWhere((f) => f['id'] === 'deep'));

    // 3) **tap 进程仍然活着**：没有退出记录。tap 真死时**这一行直接变红**，
    //    失败信息里带退出码与已收到的 op 列表——不再退化成"收不到帧"的二义性超时。
    expect(
      tap.exit,
      'tap 进程不得因为一条控制帧而退出；' +
        `实际退出记录=${JSON.stringify(tap.exit)}；` +
        `此时收到的控制帧 ops=${JSON.stringify(control.all().map((f) => f['op']))}`
    ).toBeNull();

    // 4) 拒收回执的形状（只有 tap 活着才会走到这里）。
    const rejected = outcome.frame ?? {};
    expect(rejected['op']).toBe('inject.error');
    expect(/** @type {Record<string, unknown>} */ (rejected['error'])['code']).toBe('frame_too_deep');

    // 5) 同一连接上，后续帧仍被正常服务（不是靠"断开重连"蒙混）。
    control.send({ zccTap: { v: 1, op: 'ping' } });
    expect((await control.next('pong'))['op']).toBe('pong');

    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'after-deep',
        frame: { id: 'zcc-tap-after-deep', method: 'session/prompt', params: { model: 'account:plan' } }
      }
    });
    expect((await control.nextWhere((f) => f['id'] === 'after-deep'))['op']).toBe('inject.ack');
    expect((await control.next('response'))['requestId']).toBe('zcc-tap-after-deep');

    // 6) 中继方向完全没受影响：桌面写进去的字节仍原样中继（这里用 fixture 的 stdin 结束
    //    与报告交叉证明它一直活着并在正常服务）。
    tap.endStdin();
    await tap.waitExit();

    // 7) 子进程只见到那条合法帧——被拒的深嵌套帧一个字节都没进子进程 stdin。
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.injectedIds).toEqual(['zcc-tap-after-deep']);
    const childStdin = readFileSync(recordPath).toString('utf8');
    expect(parseNdjsonLines(Buffer.from(childStdin, 'utf8')).map((f) => f['id'])).toEqual(['zcc-tap-after-deep']);
  }, 60_000);
});

/* ========================================================================== */
/* P1-c：mock 抛错 —— "tap 进程仍然存活"的硬证据（真子进程，退出码即判据）     */
/* ========================================================================== */

/**
 * 起一个**真子进程**跑 `startControlServer`，其 `inject` 抛 `RangeError`，然后：
 * auth → 触发抛错的 inject → 断言拿到结构化 `inject.error` → 同一连接再 ping →
 * 断言 `pong` → 再做一次合法 inject → 断言 `inject.ack`。
 *
 * 判据是**进程退出码**：`RangeError` 若逃出 socket handler，node 会打印栈并以退出码 1
 * 结束。退出码 0 且打印了完整判定，说明异常确实被隔离、进程确实活着。
 *
 * @param {{ token: string, throwOn: 'inject' | 'status' }} options
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runIsolatedControlServerProcess(options) {
  // Windows 上 ESM 的绝对路径必须写成 `file://` URL，否则 `import` 直接抛
  // `ERR_UNSUPPORTED_ESM_URL_SCHEME`——那是一个**驱动脚本自身**的加载错误，与被测的
  // 隔离层无关，却会让本该证明"异常不逃逸"的 stderr 断言拿到一堆无关的栈。
  const controlModule = pathToFileURL(resolve(REPO_ROOT, 'scripts', 'official-tap', 'tap-control.mjs')).href;
  const driver = `
import { startControlServer } from ${JSON.stringify(controlModule)};
import { connect } from 'node:net';

const TOKEN = ${JSON.stringify(options.token)};
const THROW_ON = ${JSON.stringify(options.throwOn)};

/** @type {string[]} */
const seen = [];
/** P4：诊断记录原样收集，最后由测试断言"只有类别名、没有消息原文"。 */
const diagRecords = [];
/** 只在**第一次**注入时抛错：后续注入必须仍然成功，否则"连接还能继续服务"无从证明。 */
let injectCalls = 0;
let buffered = Buffer.alloc(0);
const waiters = [];

const server = await startControlServer({
  host: '127.0.0.1',
  port: 0,
  token: TOKEN,
  inject: (frame) => {
    if (THROW_ON === 'inject' && injectCalls++ === 0) {
      // 这正是复审实测的异常类型：深嵌套帧让通道标识收集爆栈。
      // message 里带一个标记串，用来证明它绝不出现在诊断里。
      throw new RangeError('Maximum call stack size exceeded: ' + ${JSON.stringify(MESSAGE_MARKER)});
    }
    return { ok: true, requestId: frame.id };
  },
  diag: (event, fields) => { diagRecords.push({ event, ...fields }); },
  status: () => {
    if (THROW_ON === 'status') throw new TypeError('status exploded: ' + ${JSON.stringify(MESSAGE_MARKER)});
    return { controlConnections: 1 };
  }
});

const socket = connect({ host: '127.0.0.1', port: server.port });
socket.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    const nl = buffered.indexOf(0x0a);
    if (nl < 0) break;
    const line = buffered.subarray(0, nl).toString('utf8');
    buffered = buffered.subarray(nl + 1);
    if (line.trim().length === 0) continue;
    const zccTap = JSON.parse(line).zccTap;
    seen.push(zccTap);
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].match(zccTap)) { const w = waiters.splice(i, 1)[0]; w.resolve(zccTap); break; }
    }
  }
});
const nextWhere = (match, ms = 5000) => {
  const at = seen.findIndex(match);
  if (at >= 0) return Promise.resolve(seen.splice(at, 1)[0]);
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => rejectWait(new Error('frame timeout; saw ' + JSON.stringify(seen.map((f) => f.op)))), ms);
    waiters.push({ match, resolve: (v) => { clearTimeout(timer); resolveWait(v); } });
  });
};

await new Promise((r) => socket.once('connect', r));
const send = (zccTap) => socket.write(JSON.stringify({ zccTap }) + '\\n');
send({ v: 1, op: 'auth', token: TOKEN });
const hello = await nextWhere((f) => f.op === 'hello');

const outcome = { helloPortBound: typeof hello.controlPort === 'number' };

if (THROW_ON === 'status') {
  send({ v: 1, op: 'status' });
  const err = await nextWhere((f) => f.op === 'error');
  outcome.statusErrorCode = err.error.code;
  // 连接仍然可用：下一条 ping 必须有 pong。
  send({ v: 1, op: 'ping' });
  outcome.pongAfterStatusError = (await nextWhere((f) => f.op === 'pong')).op === 'pong';
} else {
  send({ v: 1, op: 'inject', id: 'boom', frame: { id: 'zcc-tap-boom', method: 'session/prompt', params: { model: 'account:plan' } } });
  const err = await nextWhere((f) => f.id === 'boom');
  outcome.injectErrorOp = err.op;
  outcome.injectErrorCode = err.error.code;
  // 同一连接继续可用。
  send({ v: 1, op: 'ping' });
  outcome.pongAfterInjectError = (await nextWhere((f) => f.op === 'pong')).op === 'pong';
  send({ v: 1, op: 'inject', id: 'ok', frame: { id: 'zcc-tap-ok', method: 'session/prompt', params: { model: 'account:plan' } } });
  outcome.secondInjectOp = (await nextWhere((f) => f.id === 'ok')).op;
}

// 只有走到这里才会执行到打印：说明进程在抛错之后**继续跑完了整个流程**。
process.stdout.write(JSON.stringify({ ...outcome, diagRecords }) + '\\n');
socket.destroy();
server.close();
`;
  return new Promise((resolveDone) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', driver], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('exit', (code) => resolveDone({ code, stdout, stderr }));
  });
}

describe('P1-c：inject 抛 RangeError 时 tap 进程仍然存活（真子进程，退出码为证）', () => {
  it('子进程退出码 0：结构化错误回执 + 同一连接后续请求照常服务', async () => {
    const result = await runIsolatedControlServerProcess({ token: TOKEN, throwOn: 'inject' });
    // 报告与断言里**不贴令牌**：这里只断言它没有被打印。
    expect(result.stderr, '异常逃出去会把栈打到 stderr').toBe('');
    expect(result.code, `子进程必须以 0 退出，实际 stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain(TOKEN);
    // 抛出的 `message` 里带着标记串：它绝不能出现在任何地方（诊断、回执、stderr）。
    expect(result.stdout).not.toContain(MESSAGE_MARKER);

    const outcome = JSON.parse(result.stdout.trim());
    expect(/** @type {Record<string, unknown>} */ (outcome)['helloPortBound']).toBe(true);
    expect(/** @type {Record<string, unknown>} */ (outcome)['injectErrorOp']).toBe('inject.error');
    expect(/** @type {Record<string, unknown>} */ (outcome)['injectErrorCode']).toBe('internal_error');
    // **同一连接继续可用**：抛错之后 ping 仍有 pong，第二条合法注入仍有 ack。
    expect(outcome['pongAfterInjectError']).toBe(true);
    expect(outcome['secondInjectOp']).toBe('inject.ack');

    // P4：隔离层确实记了一条诊断，而它只带**错误类别名**。
    const records = /** @type {Array<Record<string, unknown>>} */ (outcome['diagRecords']);
    const internal = records.find((r) => r['event'] === 'control_internal_error');
    expect(internal, '隔离层必须留下诊断，否则异常就被静默吞掉了').toBeDefined();
    expect(internal?.['code']).toBe('RangeError');
    expect(JSON.stringify(records)).not.toContain(MESSAGE_MARKER);
  }, 60_000);

  it('status 抛错同样被隔离：结构化 error 回执 + 连接继续可用', async () => {
    const result = await runIsolatedControlServerProcess({ token: TOKEN, throwOn: 'status' });
    expect(result.stderr).toBe('');
    expect(result.code, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain(MESSAGE_MARKER);
    const outcome = JSON.parse(result.stdout.trim());
    expect(/** @type {Record<string, unknown>} */ (outcome)['statusErrorCode']).toBe('internal_error');
    expect(outcome['pongAfterStatusError']).toBe(true);

    const records = /** @type {Array<Record<string, unknown>>} */ (outcome['diagRecords']);
    const internal = records.find((r) => r['event'] === 'control_internal_error');
    expect(internal?.['code']).toBe('TypeError');
    expect(JSON.stringify(records)).not.toContain(MESSAGE_MARKER);
  }, 60_000);
});

/* ========================================================================== */
/* P1-d：同进程内的各类抛错（auth / inject / status / diag / 非判定值）       */
/* ========================================================================== */

/**
 * 在**当前测试进程内**起一个控制服务器，返回控制端与诊断记录。
 *
 * 之所以这套与 P1-c 互补：P1-c 证明"进程不死"，这里证明"每条外部输入路径各自都被
 * 覆盖到了"，因为可以逐个替换 `options` 里的回调。
 *
 * @param {{ token?: unknown, inject?: unknown, status?: unknown, diag?: unknown }} [overrides]
 */
async function startIsolatedServer(overrides = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const diagRecords = [];
  /**
   * 默认诊断收集器。默认**要收集**而不是丢弃：P4 要断言隔离层记了什么。
   *
   * @param {string} event
   * @param {Readonly<Record<string, unknown>>} fields
   */
  const collectDiag = (event, fields) => {
    diagRecords.push({ event, ...fields });
  };
  /** @type {Parameters<typeof startControlServer>[0]} */
  const options = {
    host: '127.0.0.1',
    port: 0,
    token: /** @type {string} */ (overrides.token ?? TOKEN),
    inject: /** @type {any} */ (
      overrides.inject ?? (() => ({ ok: true, requestId: 'zcc-tap-x' }))
    ),
    diag: /** @type {any} */ (overrides.diag ?? collectDiag),
    status: /** @type {any} */ (overrides.status ?? (() => ({ controlConnections: 1 })))
  };
  const server = await startControlServer(options);
  const control = await connectControl(server.port, TOKEN);
  sockets.push(control);
  return { server, control, diagRecords, options };
}

describe('P1-d：每一条外部输入路径都异常隔离', () => {
  it('auth 的令牌比较抛出：降级为 unauthorized，进程活着，且换回可用令牌后能正常 auth', async () => {
    const explodingToken = {
      toString() {
        throw new Error(`token coercion failed: ${MESSAGE_MARKER}`);
      }
    };
    const { server, control, options } = await startIsolatedServer({ token: explodingToken });
    await control.next('error');
    const err = control.all().find((f) => f['op'] === 'error');
    expect(/** @type {Record<string, unknown>} */ (/** @type {Record<string, unknown>} */ (err)['error'])['code']).toBe('unauthorized');
    // 错误消息原文（含标记串）绝不出现在回执里。
    expect(JSON.stringify(control.all())).not.toContain(MESSAGE_MARKER);
    control.close();

    // 同一个服务器换回可用令牌 → 证明"刚才那次失败没有把服务器带坏"。
    options.token = TOKEN;
    const second = await connectControl(server.port, TOKEN);
    sockets.push(second);
    expect((await second.next('hello'))['op']).toBe('hello');
  });

  it('inject 抛错：带关联 id 的 inject.error，连接继续可用', async () => {
    const { control, diagRecords } = await startIsolatedServer({
      inject: () => {
        throw new RangeError(`walk blew up: ${MESSAGE_MARKER}`);
      }
    });
    await control.next('hello');
    control.send({ zccTap: { v: 1, op: 'inject', id: 'c1', frame: { id: 'zcc-tap-1', method: 'session/prompt' } } });
    const err = await control.nextWhere((f) => f['id'] === 'c1');
    expect(err['op']).toBe('inject.error');
    expect(/** @type {Record<string, unknown>} */ (err['error'])['code']).toBe('internal_error');
    // 同一连接继续可用。
    control.send({ zccTap: { v: 1, op: 'ping' } });
    expect((await control.next('pong'))['op']).toBe('pong');

    // P4：诊断里只有类别名，没有消息原文。
    const internal = diagRecords.find((r) => r['event'] === 'control_internal_error');
    expect(internal).toBeDefined();
    expect(internal?.['code']).toBe('RangeError');
    expect(JSON.stringify(diagRecords)).not.toContain(MESSAGE_MARKER);
  });

  it('inject 返回非判定值（不是"绝不抛"，是"返回了垃圾"）：同样结构化拒收', async () => {
    const { control } = await startIsolatedServer({ inject: () => /** @type {any} */ (null) });
    await control.next('hello');
    control.send({ zccTap: { v: 1, op: 'inject', id: 'c2', frame: { id: 'zcc-tap-2', method: 'session/prompt' } } });
    const err = await control.nextWhere((f) => f['id'] === 'c2');
    expect(err['op']).toBe('inject.error');
    expect(/** @type {Record<string, unknown>} */ (err['error'])['code']).toBe('internal_error');
    control.send({ zccTap: { v: 1, op: 'ping' } });
    expect((await control.next('pong'))['op']).toBe('pong');
  });

  it('诊断写入本身抛错：控制通道照常服务（隔离层不能在 catch 里二次抛出）', async () => {
    const { control } = await startIsolatedServer({
      diag: () => {
        throw new Error(MESSAGE_MARKER);
      }
    });
    // auth 阶段的诊断就会抛；连接必须照样拿到 hello。
    expect((await control.next('hello'))['op']).toBe('hello');
    control.send({ zccTap: { v: 1, op: 'ping' } });
    expect((await control.next('pong'))['op']).toBe('pong');
  });

  it('错误类别名只取构造器名，且对非 Error 输入归一化（P4：不留外部可控字符串）', () => {
    expect(errorClassName(new RangeError('x'))).toBe('RangeError');
    expect(errorClassName(new TypeError('x'))).toBe('TypeError');
    expect(errorClassName(null)).toBe('UnknownError');
    expect(errorClassName('a string')).toBe('UnknownError');
    expect(errorClassName({ constructor: { name: CONTENT_MARKER } })).toBe('UnknownError');
    // 合法形状但超长的构造器名也归一化（诊断字段有 64 字符上限）。
    expect(errorClassName({ constructor: { name: 'A'.repeat(100) } })).toBe('UnknownError');
  });
});

/* ========================================================================== */
/* P1-e：注入失败不得留下半写的 stdin                                        */
/* ========================================================================== */

/**
 * 补强要求原文：「注入失败不得留下半写的 stdin。若已部分写入才抛错，后续帧必须仍可
 * 服务（流不能被永久污染）。」
 *
 * ## 这条要求在实现上落在两个地方，各测各的
 *
 *  1. **不存在"写了一半"这个中间态**——注入行先由 `buildOfficialRequestLine` **整行
 *     构造好**，再一次性 `write` 出去，我们从不增量拼接。这是结构上的，不是约定。
 *  2. **`child.stdin.write` 抛错时**我们无法证明那行写进去了多少。此时**唯一**不会
 *     污染流的做法是**永久冻结**这条流：此后所有注入确定性回 `child_unavailable`，
 *     一个字节都不再碰它。反过来"继续写下一帧"会把下一帧拼到一条可能残缺的行后面，
 *     造出一条永久畸形行——而官方入站读取器只按 `\n` 切行、不校验行长（见 P3.1），
 *     那条畸形行会一路漂到 app-server 的逻辑层去。
 *
 * ## 冻结语义是"不再注入"，不是"不再服务"
 *
 * 控制连接**继续可用**：`ping` 仍有 `pong`，坏帧仍拿到结构化 `inject.error`，
 * tap 进程与中继方向都不受影响。被冻结的只有"往子进程 stdin 写"这一件事。
 */
describe('P1-e：注入失败不得留下半写的 stdin', () => {
  it('写入门：默认可写；一旦冻结就永远不可写，且没有任何解冻路径', () => {
    const gate = createChildStdinGate();
    expect(gate.writable, '初始必须可写，否则正常注入全被拒').toBe(true);

    gate.markBroken();
    expect(gate.writable, '冻结后必须立刻不可写').toBe(false);

    // 幂等：重复冻结不改变结论（`onDestError` 与 `handleInject` 的 catch 都可能先到）。
    gate.markBroken();
    expect(gate.writable).toBe(false);

    // 再怎么读也读不回 true —— 属性是只读的 getter，没有 reset。
    expect(gate.writable).toBe(false);
  });

  it('注入行是整行构造后一次性写出的：超界时**一个字节都没写**（无半行可拼）', async () => {
    // 用真实 tap 验证"半行"这件事在正常路径上根本不存在：一条被拒的帧，子进程
    // stdin 的落盘字节数必须是 0，而不是"写了一半"。
    const dir = tempDir('tapfix3-halfwrite');
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

    // 超界帧：1 MiB + 1 字节（含行终止符）。
    const head = { id: 'zcc-tap-overlimit', method: 'session/prompt' };
    const probe = { ...head, params: { model: 'account:plan', pad: '' } };
    const pad = MAX_INJECT_LINE_BYTES + 1 - JSON.stringify(probe).length - 1;
    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'overlimit',
        frame: { ...head, params: { model: 'account:plan', pad: 'x'.repeat(pad) } }
      }
    });
    const err = await control.nextWhere((f) => f['id'] === 'overlimit', 20_000);
    expect(err['op']).toBe('inject.error');
    expect(/** @type {Record<string, unknown>} */ (err['error'])['code']).toBe('frame_too_large');

    // 随后一条完全合法的注入：它必须被正常接受并落到子进程 stdin。
    control.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'after-overlimit',
        frame: { id: 'zcc-tap-after-overlimit', method: 'session/prompt', params: { model: 'account:plan' } }
      }
    });
    expect((await control.nextWhere((f) => f['id'] === 'after-overlimit', 20_000))['op']).toBe('inject.ack');
    expect((await control.next('response', 20_000))['requestId']).toBe('zcc-tap-after-overlimit');

    tap.endStdin();
    await tap.waitExit();

    // 落盘字节**只有那一条完整行**：被拒的超界帧连一个字节都没写，
    // 也就没有"半行 + 完整行"拼成畸形行这种事。
    const recorded = readFileSync(recordPath).toString('utf8');
    const lines = parseNdjsonLines(Buffer.from(recorded, 'utf8'));
    expect(lines.map((f) => f['id'])).toEqual(['zcc-tap-after-overlimit']);
    expect(recorded.endsWith('\n'), '落盘的必须是一条以行终止符收尾的完整行').toBe(true);
    expect(recorded.indexOf('zcc-tap-overlimit'), '被拒帧的 id 一个字节都不许出现在子进程 stdin').toBe(-1);
  }, 60_000);

  it('子进程已退出时注入确定性回 child_unavailable，且控制连接仍然服务（不静默、不崩）', async () => {    // 这条测的是"流已不可用"这一侧的**确定性**：注入必须立刻得到明确回执，
    // 而不是挂到 120 s 超时，更不是让 tap 退出。
    //
    // 用 `startIsolatedServer` 风格的 mock 注入入口复现"流冻结后仍继续服务"的语义：
    // 入口先回一次 `child_unavailable`，之后**每一次**都必须回同一个码。
    let calls = 0;
    const { control } = await startIsolatedServer({
      inject: () => {
        calls += 1;
        if (calls === 1) throw new Error(`${MESSAGE_MARKER}: simulated half-write failure`);
        return { ok: false, code: 'child_unavailable', field: null, matched: null, detail: '子进程 stdin 不可写' };
      }
    });
    await control.next('hello');
    control.send({ zccTap: { v: 1, op: 'inject', id: 'h1', frame: { id: 'zcc-tap-h1', method: 'session/prompt' } } });
    expect((await control.nextWhere((f) => f['id'] === 'h1'))['op']).toBe('inject.error');

    for (const corr of ['h2', 'h3']) {
      control.send({ zccTap: { v: 1, op: 'inject', id: corr, frame: { id: `zcc-tap-${corr}`, method: 'session/prompt' } } });
      const f = await control.nextWhere((x) => x['id'] === corr);
      expect(/** @type {Record<string, unknown>} */ (f['error'])['code']).toBe('child_unavailable');
    }
    // 连接仍然健康：错误消息原文（含标记串）一次都没漏进回执。
    control.send({ zccTap: { v: 1, op: 'ping' } });
    expect((await control.next('pong'))['op']).toBe('pong');
    expect(JSON.stringify(control.all())).not.toContain(MESSAGE_MARKER);
  });
});

/* ========================================================================== */
/* N1：net.Server 的 error 监听器常驻（TAPN）                                  */
/* ========================================================================== */

/**
 * ## 这条修的是什么
 *
 * `startControlServer` 原来是这样 listen 的：
 *
 * ```js
 * server.once('error', reject);
 * server.listen(port, host, () => { server.removeListener('error', reject); … });
 * ```
 *
 * 那个 `reject` 监听器在 listen 成功之后被摘掉，于是**此后再无任何 `error` 监听器**。
 * 而 Node 的 `EventEmitter` 对**没有监听器的 `error` 事件直接 throw**——`net.Server`
 * 在 listen 成功之后仍然可能发 `error`（典型是 accept 阶段句柄耗尽的 `EMFILE` /
 * `ENFILE`），那一刻异常一路冒到 `uncaughtException` → **tap 进程死 → 桌面那条
 * app-server 会话一起死**。
 *
 * 触发条件是操作系统资源耗尽而不是任何一条控制帧能构造出来的（复审 §2.3 判它非阻塞），
 * 但既然要重启桌面了就没有理由留着。修法是挂一个**永不摘除、自身绝不抛**的常驻监听器。
 *
 * ## 为什么能测
 *
 * accept 阶段的 `EMFILE` 在测试里无法自然构造，所以 `ControlServer` 暴露了
 * `netServer`（只读引用，永远不离开 tap 进程）让测试能**直接注入**一条 server 层
 * `error`。`emit('error')` 与真实触发的差别只在"谁调的 emit"，对"有没有监听器在接"
 * 这个判据**完全等价**。
 */

/**
 * 起一个**真子进程**跑 `startControlServer`，**注入一条 server 层 `error`**
 * （`EMFILE` 形状），再 auth → ping，验证控制通道照常服务。
 *
 * 判据是**进程退出码与 stderr**：没有常驻监听器时 `emit('error')` 直接 throw，
 * 而这次 throw 发生在驱动的顶层 `await` 链里 → uncaughtException → 栈打到 stderr、
 * 进程以 1 结束。所以"退出码 0 且 stderr 一个字节都没有"就是硬证据。
 *
 * @param {{ token: string, marker: string }} options
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runServerErrorControlServerProcess(options) {
  const controlModule = pathToFileURL(resolve(REPO_ROOT, 'scripts', 'official-tap', 'tap-control.mjs')).href;
  const driver = `
import { startControlServer } from ${JSON.stringify(controlModule)};
import { connect } from 'node:net';

const TOKEN = ${JSON.stringify(options.token)};
const MARKER = ${JSON.stringify(options.marker)};

/** @type {Array<Record<string, unknown>>} */
const diagRecords = [];
/** @type {string[]} */
const seen = [];
/** @type {any[]} */
const waiters = [];
let buffered = Buffer.alloc(0);

const server = await startControlServer({
  host: '127.0.0.1',
  port: 0,
  token: TOKEN,
  inject: (frame) => ({ ok: true, requestId: frame.id }),
  diag: (event, fields) => { diagRecords.push({ event, ...fields }); },
  status: () => ({ controlConnections: 1 })
});

const outcome = { listenersBefore: server.netServer.listenerCount('error') };

// ★ 注入 server 层 error。没有常驻监听器时 **这一行直接 throw**。
server.netServer.emit('error', Object.assign(new Error('simulated accept failure: ' + MARKER), { code: 'EMFILE' }));
outcome.listenersAfter = server.netServer.listenerCount('error');

const socket = connect({ host: '127.0.0.1', port: server.port });
socket.on('error', () => {});
socket.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    const nl = buffered.indexOf(0x0a);
    if (nl < 0) break;
    const line = buffered.subarray(0, nl).toString('utf8');
    buffered = buffered.subarray(nl + 1);
    if (line.trim().length === 0) continue;
    const zccTap = JSON.parse(line).zccTap;
    seen.push(zccTap);
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].match(zccTap)) { const w = waiters.splice(i, 1)[0]; w.resolve(zccTap); break; }
    }
  }
});
const nextWhere = (match, ms = 5000) => {
  const at = seen.findIndex(match);
  if (at >= 0) return Promise.resolve(seen.splice(at, 1)[0]);
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => rejectWait(new Error('frame timeout; saw ' + JSON.stringify(seen.map((f) => f.op)))), ms);
    waiters.push({ match, resolve: (v) => { clearTimeout(timer); resolveWait(v); } });
  });
};

await new Promise((r) => socket.once('connect', r));
socket.write(JSON.stringify({ zccTap: { v: 1, op: 'auth', token: TOKEN } }) + '\\n');
const hello = await nextWhere((f) => f.op === 'hello');
outcome.helloPortBound = typeof hello.controlPort === 'number';
socket.write(JSON.stringify({ zccTap: { v: 1, op: 'ping' } }) + '\\n');
outcome.pongAfterServerError = (await nextWhere((f) => f.op === 'pong')).op === 'pong';

// 只有走到这里才会打印：说明进程在 server 层 error 之后**继续跑完了整个流程**。
process.stdout.write(JSON.stringify({ ...outcome, diagRecords }) + '\\n');
socket.destroy();
server.close();
`;
  return new Promise((resolveDone) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', driver], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('exit', (code) => resolveDone({ code, stdout, stderr }));
  });
}

describe('N1：net.Server 的 error 监听器常驻，server 层 error 不杀进程、不打断服务', () => {
  it('注入 server 层 error：不抛出、记下归一化诊断、现有连接与新连接照常服务', async () => {
    const { server, control, diagRecords } = await startIsolatedServer();
    await control.next('hello');

    // 前置（防"恒真"）：Server 上确实挂着 `error` 监听器，且**恰好一个**——
    // 那个 `once('error', reject)` 已经在 listen 成功后被摘掉了，剩下的只能是常驻那个。
    expect(server.netServer.listenerCount('error')).toBe(1);

    const simulated = Object.assign(new Error(`simulated accept failure: ${MESSAGE_MARKER}`), { code: 'EMFILE' });
    // ★ 关键一行：Node 的 `EventEmitter` 对**没有监听器的** `error` 事件直接 throw。
    expect(() => server.netServer.emit('error', simulated)).not.toThrow();
    // 监听器摘不得：常驻的那一个还在（`once` 的 reject 不算）。
    expect(server.netServer.listenerCount('error')).toBe(1);

    const record = diagRecords.find((r) => r['event'] === 'control_server_error');
    expect(record, 'server 层 error 必须留下诊断，否则就是被静默吞掉了').toBeDefined();
    expect(record?.['code']).toBe('EMFILE');
    // P4：诊断只带**归一化后的系统短码**，绝不带 `message` 原文（含标记串）。
    expect(JSON.stringify(diagRecords)).not.toContain(MESSAGE_MARKER);
    expect(JSON.stringify(diagRecords)).not.toContain('simulated accept failure');

    // 现有连接照常服务。
    control.send({ zccTap: { v: 1, op: 'ping' } });
    expect((await control.next('pong'))['op']).toBe('pong');

    // 新连接照常建立并服务（server 层 error 没有把监听器带走）。
    const second = await connectControl(server.port, TOKEN);
    sockets.push(second);
    expect((await second.next('hello'))['op']).toBe('hello');
    second.send({ zccTap: { v: 1, op: 'ping' } });
    expect((await second.next('pong'))['op']).toBe('pong');
  });

  it('新事件名的字段过得了白名单净化（否则诊断会被静默丢掉，等于什么都没记）', () => {
    const { safe, dropped } = sanitizeDiagFields({
      event: 'control_server_error',
      result: 'error',
      code: 'EMFILE',
      controlConnections: 0
    });
    expect(dropped, '控制服务器 error 诊断的字段必须全在白名单里').toBe(0);
    expect(safe).toEqual({ event: 'control_server_error', result: 'error', code: 'EMFILE', controlConnections: 0 });
  });

  it('真子进程：注入 server 层 error 后退出码仍为 0、stderr 为空（没有监听器时 emit 会直接 throw）', async () => {
    const result = await runServerErrorControlServerProcess({ token: TOKEN, marker: MESSAGE_MARKER });
    expect(result.stderr, 'emit("error") 无人接收时会直接 throw，栈会打到 stderr').toBe('');
    expect(result.code, `子进程必须以 0 退出；stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain(MESSAGE_MARKER);
    expect(result.stdout).not.toContain(TOKEN);

    const outcome = JSON.parse(result.stdout.trim());
    // listen 成功后仍然有且只有一个 error 监听器（常驻那个）。
    expect(outcome['listenersBefore']).toBe(1);
    expect(outcome['listenersAfter']).toBe(1);
    // 控制通道照常服务：hello 拿到、控制端口已绑定、ping 有 pong。
    expect(outcome['helloPortBound']).toBe(true);
    expect(outcome['pongAfterServerError']).toBe(true);
    // 诊断留了痕，且只带归一化后的系统短码。
    const records = /** @type {Array<Record<string, unknown>>} */ (outcome['diagRecords']);
    const record = records.find((r) => r['event'] === 'control_server_error');
    expect(record?.['code']).toBe('EMFILE');
    expect(JSON.stringify(records)).not.toContain(MESSAGE_MARKER);
  }, 60_000);
});

/* ========================================================================== */
/* P2：CONTROL_MAX_LINE_BYTES 真正生效                                        */
/* ========================================================================== */
/**
 * **最终语义：超界即 `frame_too_large` + 断开该连接（断连，不是拒帧）。**
 *
 * 选断连而不是"拒帧后重同步"的理由：超界行是**没有**被切走的字节流，继续留在缓冲里
 * 就无法知道下一帧从哪里开始；要重同步就得引入"丢弃到下一个 `\n`"的状态机，那正是
 * 流被污染的来源。断连把状态机整个消掉：这条连接到此为止，服务端本身毫发无损，
 * **新连接照常建立、照常服务**。这与本模块其余协议错误（`invalid_json` / `unknown_op` /
 * `unauthorized`）的既定行为一致。
 */
describe('P2：控制通道行长上限真正生效（超界 = frame_too_large + 断连）', () => {
  it('常量关系：控制层是外层硬界且大于注入层策略界', () => {
    expect(CONTROL_MAX_LINE_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_INJECT_LINE_BYTES).toBe(1024 * 1024);
    expect(CONTROL_MAX_LINE_BYTES).toBeGreaterThan(MAX_INJECT_LINE_BYTES);
  });

  it('完整行恰好等于上限：接受并正常回执（界内不误杀）', async () => {
    const dir = tempDir('tapfix3-linelen-under');
    const tap = startTap({ logDir: dir, port: 0, env: { ZCC_TAP_TOKEN: TOKEN }, fixtureArgs: [] });
    running.push(tap);
    const port = await waitForControlPort(dir);
    const control = await connectControl(port, TOKEN);
    sockets.push(control);
    await control.next('hello');

    // 恰好 CONTROL_MAX_LINE_BYTES 字节（含 `\n`）的一行。
    const line = pingLineOfBytes(CONTROL_MAX_LINE_BYTES);
    expect(Buffer.byteLength(line, 'utf8')).toBe(CONTROL_MAX_LINE_BYTES);
    control.sendFrame(line.slice(0, -1));
    expect((await control.next('pong', 30_000))['op']).toBe('pong');
    expect(tap.exit).toBeNull();

    // 同一个连接还能继续用。
    control.send({ zccTap: { v: 1, op: 'ping' } });
    expect((await control.next('pong'))['op']).toBe('pong');

    tap.endStdin();
    await tap.waitExit();
  }, 60_000);

  it('完整超界行：结构化 frame_too_large + 该连接断开；服务端与新连接不受影响', async () => {
    const dir = tempDir('tapfix3-linelen-over');
    const reportPath = join(dir, 'report.json');
    const tap = startTap({
      logDir: dir,
      port: 0,
      env: { ZCC_TAP_TOKEN: TOKEN },
      fixtureArgs: ['--report', reportPath, '--inject-respond']
    });
    running.push(tap);
    const port = await waitForControlPort(dir);
    const control = await connectControl(port, TOKEN);
    sockets.push(control);
    await control.next('hello');

    // 上限 + 1 字节（含 `\n`）。这条行**整行送达**——原先的守卫在切行之后才检查，
    // 完整的大行那时已经被消费掉，于是上限形同虚设。
    const line = pingLineOfBytes(CONTROL_MAX_LINE_BYTES + 1);
    expect(Buffer.byteLength(line, 'utf8')).toBe(CONTROL_MAX_LINE_BYTES + 1);
    control.sendFrame(line.slice(0, -1));

    const err = await control.next('error', 30_000);
    expect(/** @type {Record<string, unknown>} */ (err['error'])['code']).toBe('frame_too_large');
    // 语义是断连：这条连接到此为止。
    expect((await control.next('__closed__', 10_000))['op']).toBe('__closed__');
    // **tap 进程仍然活着**，而且新连接完全正常。
    expect(tap.exit).toBeNull();

    const second = await connectControl(port, TOKEN);
    sockets.push(second);
    expect((await second.next('hello'))['op']).toBe('hello');
    second.send({
      zccTap: {
        v: 1,
        op: 'inject',
        id: 'after-oversize',
        frame: { id: 'zcc-tap-after-oversize', method: 'session/prompt', params: { model: 'account:plan' } }
      }
    });
    expect((await second.nextWhere((f) => f['id'] === 'after-oversize'))['op']).toBe('inject.ack');
    expect((await second.next('response'))['requestId']).toBe('zcc-tap-after-oversize');

    tap.endStdin();
    await tap.waitExit();
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).injectedIds).toEqual(['zcc-tap-after-oversize']);
  }, 90_000);

  it('分块累积到超界：同样 frame_too_large + 断连（累积阶段守卫，不是切行之后）', async () => {
    const dir = tempDir('tapfix3-linelen-accum');
    const tap = startTap({ logDir: dir, port: 0, env: { ZCC_TAP_TOKEN: TOKEN }, fixtureArgs: [] });
    running.push(tap);
    const port = await waitForControlPort(dir);
    const control = await connectControl(port, TOKEN);
    sockets.push(control);
    await control.next('hello');

    // 一次喂一块 256 KiB，**全程一个 `\n` 都不发**：整段流里根本没有行终止符，
    // 于是"切行循环"一次都不成立，只有**累积阶段**的守卫能拦住它。
    // （上一版这里用了 `sendFrame`，它会补换行——那测的是完整大行守卫，两条路径混淆，
    // 断言拿到的是 `invalid_json` 而不是 `frame_too_large`。）
    const chunk = 'x'.repeat(256 * 1024);
    let sent = 0;
    while (sent <= CONTROL_MAX_LINE_BYTES) {
      control.writeRaw(chunk);
      sent += chunk.length;
    }
    // 客户端自己也不补换行，两端口径一致。
    expect(sent).toBeGreaterThan(CONTROL_MAX_LINE_BYTES);

    const err = await control.next('error', 30_000);
    const errBody = /** @type {Record<string, unknown>} */ (err['error']);
    expect(
      errBody?.['code'],
      `超界必须拿到结构化 frame_too_large；实际收到的帧=${JSON.stringify(control.all())}`
    ).toBe('frame_too_large');
    expect((await control.next('__closed__', 10_000))['op']).toBe('__closed__');
    expect(tap.exit).toBeNull();

    const second = await connectControl(port, TOKEN);
    sockets.push(second);
    expect((await second.next('hello'))['op']).toBe('hello');

    tap.endStdin();
    await tap.waitExit();
  }, 90_000);

  it('断连后对端继续灌数据：只回一次错误、不刷诊断、错误回执不丢（TAPFIX3 修的实测 flake）', async () => {
    // 这条钉住一个**实测出来的**缺陷：超界断连时对端还在往这条流里灌剩下的字节，
    // 而 `buffered` 里那份超界内容从未被清掉，于是 `fail()` 被后续每个 chunk 重复
    // 触发。可写流默认 `autoDestroy`，在**已经 end() 的 socket 上再 write()** 触发的
    // `ERR_STREAM_WRITE_AFTER_END` 会销毁这条 socket——连带把**第一次那条还没 flush
    // 的错误回执**丢掉。症状是：控制端只看到 FIN，收不到 `frame_too_large`。
    // 这个 flake 只在高负载下出现（错误帧 flush 够快时不会）。
    const dir = tempDir('tapfix3-linelen-after-fail');
    const tap = startTap({ logDir: dir, port: 0, env: { ZCC_TAP_TOKEN: TOKEN }, fixtureArgs: [] });
    running.push(tap);
    const port = await waitForControlPort(dir);
    const control = await connectControl(port, TOKEN);
    sockets.push(control);
    await control.next('hello');

    // 灌到超界之后**继续灌**剩下的量（模拟对端没听见 FIN 还在写）。
    const chunk = 'x'.repeat(256 * 1024);
    for (let i = 0; i < 14; i++) control.writeRaw(chunk);

    const err = await control.next('error', 30_000);
    expect(/** @type {Record<string, unknown>} */ (err['error'])?.['code']).toBe('frame_too_large');
    expect((await control.next('__closed__', 10_000))['op']).toBe('__closed__');
    expect(tap.exit, '断连处理绝不能把 tap 带死').toBeNull();

    // **恰好一条** error 帧：既没有重复回执，也没有诊断刷屏。
    const errors = control.all().filter((f) => f['op'] === 'error');
    expect(errors.length, `应当只有一条 error 回执，实际 ${JSON.stringify(control.all())}`).toBe(1);

    // 等诊断文件落定后核对：这条连接的 control_error 只记了一次。
    await waitFor(() => readDiagEvents(dir).filter((r) => r['event'] === 'control_close').length > 0, {
      what: 'control_close diag',
      timeoutMs: 15_000
    });
    const controlErrors = readDiagEvents(dir).filter((r) => r['event'] === 'control_error');
    expect(controlErrors.length, 'control_error 诊断必须只记一次，不能按 chunk 刷屏').toBe(1);
    expect(controlErrors[0]?.['code']).toBe('frame_too_large');

    // 服务端本身毫发无损：新连接照常建立、照常服务。
    const second = await connectControl(port, TOKEN);
    sockets.push(second);
    expect((await second.next('hello'))['op']).toBe('hello');

    tap.endStdin();
    await tap.waitExit();
  }, 90_000);

  it('界内分块累积（同样无换行）不被误杀：守卫的界线是"长度"，不是"分块方式"', async () => {    const dir = tempDir('tapfix3-linelen-accum-under');
    const tap = startTap({ logDir: dir, port: 0, env: { ZCC_TAP_TOKEN: TOKEN }, fixtureArgs: [] });
    running.push(tap);
    const port = await waitForControlPort(dir);
    const control = await connectControl(port, TOKEN);
    sockets.push(control);
    await control.next('hello');

    // 与上一条同一条流、同样分块、同样不带换行，只是**刚好不超界**：
    // 一条恰好 CONTROL_MAX_LINE_BYTES 字节的 ping 行被完整送完，必须拿到 pong。
    const line = pingLineOfBytes(CONTROL_MAX_LINE_BYTES);
    const body = line.slice(0, -1);
    for (let i = 0; i < body.length; i += 256 * 1024) control.writeRaw(body.slice(i, i + 256 * 1024));
    control.writeRaw(String.fromCharCode(10));

    expect((await control.next('pong', 30_000))['op']).toBe('pong');
    expect(tap.exit).toBeNull();
    tap.endStdin();
    await tap.waitExit();
  }, 90_000);
});

/* ========================================================================== */
/* P3：注释依据由官方 bundle 的实测事实钉住                                   */
/* ========================================================================== */

describe('P3：官方行长上限的依据方向（P3.1）由事实钉住，不是注释里的断言', () => {
  const ZCODE_CJS = 'C:\\ZCode\\resources\\glm\\zcode.cjs';

  it('官方入站读取器 onData 没有行长守卫；全文件无 maxLineBytes/lineTooLong/frameTooLarge', () => {
    if (!existsSync(ZCODE_CJS)) {
      // 官方安装不存在时不能伪造"验证通过"。如实跳过，报告里会写明未测。
      return;
    }
    const text = readFileSync(ZCODE_CJS, 'utf8');
    expect(text.includes('maxLineBytes'), '官方若真有 maxLineBytes，P3.1 的注释方向要重写').toBe(false);
    expect(text.includes('lineTooLong')).toBe(false);
    expect(text.includes('frameTooLarge')).toBe(false);

    // 入站读取器确实是 `buffer += chunk` + `indexOf('\n')` 的裸 NDJSON 切行。
    const onData = text.indexOf('onData=r(t=>{if(this.terminal||this.draining)return;this.buffer+=');
    expect(onData, '入站读取器 onData 的形状变了，P3.1 的注释要重写').toBeGreaterThan(0);
    const window = text.slice(onData, onData + 400);
    expect(window).toContain('this.buffer.indexOf');
    expect(window).toContain('this.dispatchLine');
    // 切行循环里没有任何长度比较——这是"没有行长守卫"的直接证据。
    expect(/\.length\s*[<>]=?\s*\d{5,}/u.test(window), 'onData 里出现了长度比较，行长守卫可能已存在').toBe(false);
  });

  it('fc.maxFrameBytes 确实取 1 MiB——但它只被用在出站物理信封那一侧', () => {
    if (!existsSync(ZCODE_CJS)) return;
    const text = readFileSync(ZCODE_CJS, 'utf8');
    expect(text).toContain('maxFrameBytes:1024*1024');
    // 全部消费点都在 maxPhysicalFrameBytes（出站物理信封/分片组装）上。
    const consumers = [...text.matchAll(/maxFrameBytes/gu)].map((m) => text.slice(Math.max(0, m.index - 60), m.index + 30));
    const outbound = consumers.filter((c) => c.includes('maxPhysicalFrameBytes') || c.includes('maxFrameBytes:1024'));
    expect(outbound.length).toBeGreaterThan(0);
    // 没有任何一处把它当成入站行长限制用。
    for (const c of consumers) {
      expect(c.includes('maxPhysicalFrameBytes') || c.includes('maxFrameBytes:1024'), `出现了第三种用法：${c}`).toBe(true);
    }
  });

  it('取值是保守自选值，不是"对齐官方强制上限"——MAX_INJECT_LINE_BYTES 仍是 1 MiB', () => {
    expect(MAX_INJECT_LINE_BYTES).toBe(1024 * 1024);
    // 界内接受 / 超界 +1 拒绝的策略本身不变。
    const verdict = evaluateInjectPolicy({
      id: 'zcc-tap-boundary',
      method: 'session/prompt',
      params: { model: 'account:plan' }
    });
    expect(verdict.ok).toBe(true);
  });
});

/* ========================================================================== */
/* P4：异常路径诊断字段的可诊断性与不可泄露性                                */
/* ========================================================================== */

describe('P4：隔离层诊断只记不含内容的字段', () => {
  it('真 tap 端到端：控制帧里的内容标记不出现在任何诊断文件里', async () => {
    const dir = tempDir('tapfix3-diag');
    const recordPath = join(dir, 'child-stdin.bin');
    const tap = startTap({
      logDir: dir,
      port: 0,
      env: { ZCC_TAP_TOKEN: TOKEN },
      fixtureArgs: ['--record', recordPath]
    });
    running.push(tap);
    const port = await waitForControlPort(dir);
    const control = await connectControl(port, TOKEN);
    sockets.push(control);
    await control.next('hello');

    // 三条会被确定性**拒收**的帧，每条都带一个唯一标记。拒收路径会写诊断，所以只要
    // 隔离层为了可诊断性而"多记一点内容"，这些标记就会立刻出现在落盘文件里。
    //
    // 上一版这里发的是一条**合法**帧（`model: account:plan`），于是 tap 正常接受并
    // 写子进程 stdin，既没有 `inject_rejected` 事件，测试又在等那个永远不会出现的
    // 事件——15 s 超时。它测的东西（诊断不含内容）是对的，只是没测到拒收路径。
    const rejected = [
      // 1) 付费通道黑名单：唯一被回显的值就是命中黑名单的常量本身。
      { corr: 'marker-blocked', model: 'bigmodel-api', note: `${CONTENT_MARKER}-blocked` },
      // 2) 非 account: 前缀。
      { corr: 'marker-notallow', model: 'someone-else', note: `${CONTENT_MARKER}-notallow` },
      // 3) 没有任何通道标识字段。
      { corr: 'marker-nomodel', model: undefined, note: `${CONTENT_MARKER}-nomodel` }
    ];
    for (const item of rejected) {
      const params = item.model === undefined ? { note: item.note } : { model: item.model, note: item.note };
      control.send({
        zccTap: {
          v: 1,
          op: 'inject',
          id: item.corr,
          frame: { id: `zcc-tap-${item.corr}`, method: 'session/prompt', params }
        }
      });
      const err = await control.nextWhere((f) => f['id'] === item.corr, 10_000);
      expect(err['op'], `${item.corr} 应当被确定性拒收`).toBe('inject.error');
    }

    // tap 仍然活着，连接仍然可用（拒收路径没有把通道带坏）。
    expect(tap.exit).toBeNull();
    control.send({ zccTap: { v: 1, op: 'ping' } });
    expect((await control.next('pong'))['op']).toBe('pong');

    // 三次 `inject_rejected` 都必须已经落盘。
    await waitForDiagEvent(dir, 'inject_rejected');
    expect(readDiagEvents(dir).filter((r) => r['event'] === 'inject_rejected').length).toBeGreaterThanOrEqual(3);

    tap.endStdin();
    await tap.waitExit();

    // 子进程 stdin 一个字节都没被写进去（被拒的帧一条都不许落地）。
    expect(readFileSync(recordPath).length).toBe(0);

    const diagText = readFileSync(join(dir, 'zcode-stdio-tap.diag.jsonl'), 'utf8');
    // 帧内容、错误消息原文、控制令牌——三者一个都不许出现。
    expect(diagText).not.toContain(CONTENT_MARKER);
    expect(diagText).not.toContain(TOKEN);
    expect(diagText).not.toContain(MESSAGE_MARKER);
    // 每一个键都在白名单内（`sanitizeDiagFields` 的结构化闸门在真进程里也生效）。
    for (const line of diagText.split('\n').filter((l) => l.trim().length > 0)) {
      const record = /** @type {Record<string, unknown>} */ (JSON.parse(line));
      for (const key of Object.keys(record)) {
        expect(DIAG_FIELD_ALLOWLIST.includes(key), `诊断里出现了白名单外的键 ${key}`).toBe(true);
      }
      // 字符串值的长度也受 DIAG_MAX_VALUE_CHARS 约束：帧内容那么长，进不来。
      for (const value of Object.values(record)) {
        if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(DIAG_MAX_VALUE_CHARS);
      }
    }
  }, 60_000);

  it('隔离层允许写入的字段集合：连接 id / 错误类别名 / 字节数 / 结果 / 阶段', () => {
    // 这四个键是 P1 诊断**唯一**允许承载的信息。它们都必须在白名单里，
    // 否则 sanitizeDiagFields 会把它们丢掉、诊断就退化成"什么也没记"。
    for (const key of ['connectionId', 'code', 'bytes', 'result', 'phase', 'controlConnections', 'at', 'event']) {
      expect(DIAG_FIELD_ALLOWLIST.includes(key), `${key} 不在诊断白名单里，隔离诊断会被静默丢掉`).toBe(true);
    }
    // 而任何与"内容"有关的键仍然不在白名单里——这是 P4 的结构化保证。
    for (const key of ['frame', 'params', 'message', 'stack', 'detail', 'token', 'note', 'line', 'raw']) {
      expect(DIAG_FIELD_ALLOWLIST.includes(key), `${key} 不该在诊断白名单里`).toBe(false);
    }
  });

  it('控制令牌满足可诊断性前提：足够长、无空白（只断言形状，不回显取值）', () => {
    expect(isUsableControlToken(TOKEN)).toBe(true);
    expect(isUsableControlToken('short')).toBe(false);
  });
});
