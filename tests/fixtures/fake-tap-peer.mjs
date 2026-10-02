#!/usr/bin/env node
/**
 * fake-tap-peer.mjs — TAPIMPL 测试用的 fixture 对端（**不是**官方 app-server）。
 *
 * 边界声明（与 `tests/fixtures/fake-runtime.mjs` 同一纪律）：本文件是一个
 * fixture-only 的 NDJSON 对端，**不实现、不声称实现官方 ZCode 协议**。
 *
 * 帧形状：自 TAPFIX（B1）起，本 fixture 发出的**每一帧都对齐官方
 * `zcodeProtocolMessageSchema` 的四条分支之一**（`C:\ZCode\resources\glm\zcode.cjs`
 * 第 72 行 col 137377–137887）：请求帧 `{id, method, params}`、应答帧 `{id, result}`。
 * **没有 `jsonrpc` 键**——官方 `zcodeProtocolRequestSchema` 是 `.strict()` 且键集合
 * 只有 `{id, method, params, trace}`，多一个 `jsonrpc` 整帧即被拒。之前这里每帧都带
 * `jsonrpc: "2.0"`，等于把一个官方必然拒收的错误形状固化进整个测试套件。
 *
 * 它是测量工具：把 stdin 收到的**每一个字节**原样落到 `--record` 文件里，把
 * stdout 写成 `--stdout-file` 文件里的原字节，再把不含内容的统计写进 `--report`。
 * 于是"下游收到的字节与输入逐字节相同"可以被外部独立复核，而不是靠 tap 自证。
 *
 * 用法（全部参数都是可选的，未给就什么都不做）：
 *   --record <path>            把 stdin 收到的原始字节写到该文件
 *   --report <path>            把不含内容的统计 JSON 写到该文件
 *   --stdout-file <path>       启动时把该文件的原字节写到 stdout
 *   --credential-request <id>  启动时发一帧**凭据请求**（带 method）
 *   --credential-answer <id>   收到该 id 的 stdin 帧后发一帧**凭据应答**（含合成密钥）
 *   --inject-respond           对每个 zcc-tap- 前缀的请求回一帧 result
 *   --inject-silent-id <id>    该 id 只记账、不回帧（用来确定性地测"等待中"状态）
 *   --hang-after-stdin-end     stdin 结束时**不退出**（保持事件循环存活），
 *                              用来确定性地逼 tap 走 shutdown_escalate 分支
 *   --exit-after-stdin-end     stdin 结束时退出（默认行为）
 */
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** 合成凭据串。**不是**任何真实凭据，只是让测试能断言"它没出现在任何地方"。 */
const SYNTHETIC_SECRET = 'FIXTURE-NOT-A-REAL-CREDENTIAL';

/**
 * @param {readonly string[]} argv
 * @returns {Record<string, string | true>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) {
        out[arg.slice(2)] = value;
        i += 1;
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/** @type {number[]} */
const received = [];
const hash = createHash('sha256');
let receivedLines = 0;
let pendingText = '';
/** @type {string[]} */
const injectedIds = [];
let credentialExchanged = false;
let credentialAnswerSha256 = '';

/** @param {Record<string, unknown>} frame */
function send(frame) {
  try {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  } catch {
    // 父端已关掉 stdout：结束。
  }
}

const stdoutFile = args['stdout-file'];
if (typeof stdoutFile === 'string') {
  process.stdout.write(readFileSync(stdoutFile));
}

const credentialRequestId = args['credential-request'];
if (typeof credentialRequestId === 'string') {
  // 官方请求形状：{id, method, params}，没有 jsonrpc 键。
  send({
    id: credentialRequestId,
    method: 'zcode/credentialHeaders/request',
    params: { reason: 'before_model_request' }
  });
}

/** @param {Buffer} buffer */
function onChunk(buffer) {
  // 原始字节先记账：一个字节都不能因为"我要解析它"而改变。
  received.push(...buffer);
  hash.update(buffer);
  // 行累积缓冲：一帧可能跨 chunk，解析必须按完整行来。
  pendingText += buffer.toString('utf8');
  for (;;) {
    const nl = pendingText.indexOf('\n');
    if (nl < 0) break;
    const line = pendingText.slice(0, nl);
    pendingText = pendingText.slice(nl + 1);
    onLine(line);
  }
}

/** @param {string} line */
function onLine(line) {
  if (line.trim().length === 0) return;
  receivedLines += 1;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const record = /** @type {Record<string, unknown>} */ (parsed);
  const id = record['id'];
  if (typeof id !== 'string') return;

  if (id === credentialRequestId) {
    // 收到的是**凭据应答**（无 method、带 result）：立刻回一帧凭据结果，
    // 其中的合成密钥就是"绝不能经过控制通道"的那个内容。
    // 官方应答形状是 `{id, result}`，同样没有 jsonrpc 键。
    const answer = { id, result: { headers: { authorization: `Bearer ${SYNTHETIC_SECRET}` } } };
    credentialAnswerSha256 = createHash('sha256').update(JSON.stringify(answer), 'utf8').digest('hex');
    credentialExchanged = true;
    send(answer);
    return;
  }
  if (id.startsWith('zcc-tap-')) {
    injectedIds.push(id);
    if (id === args['inject-silent-id']) return;
    if (args['inject-respond'] === true) {
      send({ id, result: { ok: true, seenMethod: record['method'] ?? null } });
    }
  }
}

function finalize() {
  const recordPath = args['record'];
  if (typeof recordPath === 'string') {
    const fd = openSync(recordPath, 'w');
    try {
      writeSync(fd, Buffer.from(received));
    } finally {
      closeSync(fd);
    }
  }
  const reportPath = args['report'];
  if (typeof reportPath === 'string') {
    // 只写不含内容的统计：字节数、sha256、我们自己命名空间里的 id、合成密钥应答的
    // sha256。**不写任何帧内容。**
    writeFileSyncSafe(
      reportPath,
      `${JSON.stringify({
        receivedBytes: received.length,
        receivedSha256: hash.copy().digest('hex'),
        receivedLines,
        injectedIds,
        credentialExchanged,
        credentialAnswerSha256,
        electronRunAsNode: process.env['ELECTRON_RUN_AS_NODE'] ?? null,
        pid: process.pid
      })}\n`
    );
  }
}

/**
 * @param {string} path
 * @param {string} content
 */
function writeFileSyncSafe(path, content) {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

process.stdin.on('data', (chunk) => {
  receivedLines += 1;
  onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
});
process.stdin.on('end', () => {
  finalize();
  if (args['hang-after-stdin-end'] === true) {
    // 收尾慢的子进程：stdin 收完也不退出，事件循环保持存活。
    // 用来确定性地让 tap 走到 shutdown_escalate（子进程在宽限期内不退出）分支。
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = 0;
});
process.stdin.on('error', () => {
  finalize();
});
process.stdin.resume();
