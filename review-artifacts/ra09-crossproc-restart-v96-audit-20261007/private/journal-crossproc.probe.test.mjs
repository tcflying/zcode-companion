// RA-09 · 跨进程重启承接 —— **真实独立 OS 子进程**闭环。
//
// 需求出处：G:/zcode-project/zcode-dev/929.md:853
//   「终止本应用子进程后重开零重发」
// 以及 :875「journal不足拒新发而非丢unknown」。
//
// 与前几轮的根本区别：v94 的 T13 是**同一测试进程内**重建实例 + 持久化故障现场模拟。
// 本轮是**真的 spawn 一个 node 子进程**当「上一代」，由本父进程亲手 kill 它，
// 再 spawn 另一个**不同 PID** 的子进程读同一份临时 data。所以：
//   - 「进程真的死过」是可核查的（PID + exit 事件），不是模拟出来的；
//   - 「盘上的 in_flight 是死前写的」可由 kill 前/后两次读盘比对证明。
//
// 场景（严格照本轮授权边界）：
//   A（hang 驱动器）：真实 HTTP 请求进入驱动器后永不返回 ⇒ operation 停在 in_flight。
//   父进程 kill A ⇒ A 真的死。
//   B（normal 驱动器，**同 key、同 data 目录、不同 PID**）：
//     1) 同 session + **新 Idempotency-Key** + **新输入** ⇒ 必须拒绝，驱动器调用数**不得增加**；
//     2) 独立会话 + 新 key ⇒ 必须 200，驱动器调用数 +1（证明上一步的「拒绝 + 0 调用」
//        是闸门造成的，而不是这个环境本来就发不出去）。
//   C（**换 API key**，独立子进程）：同一 session 再发 —— 只**实测并记录**，不预设结论。
//
// 反假绿纪律：
//  - 断言「驱动器没被调用」时，同时打印驱动器调用台账（driver-calls.jsonl 的行数与内容）；
//    行数是子进程自己写的，不是本测试的口头声明。
//  - kill 前后各读一次盘并比对 hash，证明 in_flight 是**持久**状态。
//  - A、B 的 PID 必须不同，且都来自 os 的真实 spawn。
//  - 端口传 0 由 OS 分配，绝不碰 8790/8791；驱动器是本地 fixture，不发任何网络请求。

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { generateApiKey } from '../../../packages/api/src/auth.js';

const HOST = '127.0.0.1';
const MODEL = 'zcc-fixture-1';
const BUNDLE = process.env.ZCC_CP_BUNDLE;
// 证据落盘路径。**不能只靠 console.log**：vitest 默认 reporter 在**全绿**时不打印
// 用例的 console 输出（实测：全绿那轮 stdout 里一条 XPROC_* 都没有），
// 那样 PID / 退出码 / 持久化字节 hash 根本不会进被封存的证据。
// 所以证据同时追加到这个文件，由 gate 的 --artifact 封存。
const EVIDENCE_FILE = process.env.ZCC_CP_EVIDENCE_FILE ?? '';

/** 证据出口：console 只是给人看的，**文件才是被 gate 封存的那一份**。 */
function emit(tag, payload) {
  const line = `${tag} ${JSON.stringify(payload)}`;
  console.log(line);
  if (EVIDENCE_FILE !== '') {
    try {
      fs.appendFileSync(EVIDENCE_FILE, `${line}\n`, 'utf8');
    } catch {
      // 落盘失败不得让断言结论失真：断言本身不依赖这个文件。
    }
  }
}

// 每次探针运行**先清空**证据文件：否则上一次运行残留的行会与本次混在一起，
// 让「本轮到底测了几次」变得不可核查。实测踩过：artifact 里 8 行、正例只有 3 行。
if (EVIDENCE_FILE !== '') {
  fs.writeFileSync(EVIDENCE_FILE, '', 'utf8');
}
const SAME_SESSION = { clientId: 'xproc-client-1', sessionId: 'xproc-session-1' };
const OTHER_SESSION = { clientId: 'xproc-client-2', sessionId: 'xproc-session-2' };

/* -------------------------------------------------------------------------- */
/* 落盘读盘                                                                    */
/* -------------------------------------------------------------------------- */

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zcc-ra09-api-${tag}-`));
}

function journalPath(dir) {
  // 与 journal-store.ts 的 API_JOURNAL_FILE_NAME 逐字一致（刻意不是桌面侧 journal.json）。
  return path.join(dir, 'api-operations-journal.json');
}

function callsPath(dir) {
  return path.join(dir, 'driver-calls.jsonl');
}

/** 驱动器调用台账：子进程每被调用一次追加一行。行数就是「调用了几次」的唯一凭据。 */
function readCalls(dir) {
  try {
    return fs
      .readFileSync(callsPath(dir), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function readJournal(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath(dir), 'utf8'));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/** 盘上状态的指纹：字节数 + sha256。用来证明「kill 前后是同一份持久内容」。 */
function journalFingerprint(dir) {
  try {
    const bytes = fs.readFileSync(journalPath(dir));
    return { bytes: bytes.byteLength, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return { bytes: 0, sha256: null };
  }
}

function readFileOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 日志摘要：**只给结论与哈希，绝不回吐原始身份**。
 * 子进程日志里含 client/session 值（canary 或真实标识），
 * 而本轮的 stdout 会被 gate 原样封存成证据——把原始身份写进证据链
 * 等于把要证明的那件事本身复制一份出去。
 * 所以只保留：行数、字节数、整体 sha256、是否出现 session_locked 事件、canary 命中计数。
 */
function summarizeLog(text) {
  return {
    lines: text === '' ? 0 : text.split('\n').filter((line) => line !== '').length,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: text === '' ? null : crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    hasSessionLockedEvent: text.includes('event=session_locked'),
    hasRawSessionField: /(^|\s)client=/.test(text) || /(^|\s)session=/.test(text),
    hasSessionKeyField: /(^|\s)session_key=/.test(text)
  };
}

/* -------------------------------------------------------------------------- */
/* 等待与 HTTP                                                                */
/* -------------------------------------------------------------------------- */

async function waitFor(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

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
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/* -------------------------------------------------------------------------- */
/* 子进程                                                                     */
/* -------------------------------------------------------------------------- */

const spawned = [];

function spawnChild({ dataDir, readyFile, apiKey, mode, logFile }) {
  const child = spawn(process.execPath, [BUNDLE], {
    env: {
      ...process.env,
      ZCC_CP_DATA_DIR: dataDir,
      ZCC_CP_READY_FILE: readyFile,
      ZCC_CP_API_KEY: apiKey,
      ZCC_CP_MODE: mode,
      ZCC_CP_LOG_FILE: logFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const record = {
    child,
    mode,
    stdout: '',
    stderr: '',
    exited: false,
    exitCode: null,
    exitSignal: null
  };
  child.stdout.on('data', (chunk) => {
    record.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    record.stderr += chunk.toString();
  });
  record.exit = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      record.exited = true;
      record.exitCode = code;
      record.exitSignal = signal;
      resolve({ code, signal });
    });
  });
  spawned.push(record);
  return record;
}

async function waitReady(record, readyFile, label) {
  const ready = await waitFor(
    () => {
      const text = readFileOrEmpty(readyFile).trim();
      if (text === '') return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    `${label} ready file`
  );
  return ready;
}

/** 兜底：任何用例失败时也必须把子进程收干净，绝不留孤儿进程。 */
afterAll(async () => {
  for (const record of spawned) {
    if (record.exited) continue;
    try {
      record.child.kill();
      await record.exit;
    } catch {
      // 已经没了就算了；这里不做断言，只保证不留活着的子进程。
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 用例                                                                       */
/* -------------------------------------------------------------------------- */

describe('RA-09 跨进程重启承接（真实独立子进程）', () => {
  it(
    'T15 子进程A崩溃留in_flight → B读取同data：同session新幂等键/新输入被拒且零dispatch；独立会话正向可发',
    async () => {
      expect(BUNDLE, 'ZCC_CP_BUNDLE 未设置：必须由 runner 先打包子进程再跑本用例').toBeTruthy();
      expect(fs.existsSync(BUNDLE), `子进程产物不存在：${BUNDLE}`).toBe(true);

      const dataDir = tmpRoot('xproc');
      // 真实产品里 key 来自 settings、跨重启不变，所以 A 与 B **必须**拿同一把 key。
      const key = generateApiKey();
      const readyA = path.join(dataDir, 'ready-A.json');
      const readyB = path.join(dataDir, 'ready-B.json');
      const logA = path.join(dataDir, 'child-A.log');
      const logB = path.join(dataDir, 'child-B.log');

      /* ---- A：让请求进入驱动器后停在 in_flight ---- */
      const a = spawnChild({ dataDir, readyFile: readyA, apiKey: key, mode: 'hang', logFile: logA });
      const infoA = await waitReady(a, readyA, 'A');
      expect(infoA.pid, 'A 的 ready 文件必须带真实 PID').toBeGreaterThan(0);

      // 打到 A 的请求会**永远不返回**（驱动器挂住）。这里明确吞掉后续的 ECONNRESET：
      // 那个 reset 正是「A 被杀」的预期后果，不是失败。
      const inflightRequest = post({
        port: infoA.port,
        apiKey: key,
        body: { model: MODEL, messages: [{ role: 'user', content: 'A 代：这段会停在 in_flight' }] },
        headers: {
          'Idempotency-Key': 'idem-A-0001',
          'x-zcc-client-id': SAME_SESSION.clientId,
          'x-zcc-session-id': SAME_SESSION.sessionId
        }
      }).catch((error) => ({ status: 0, text: `aborted:${error.code ?? error.message}`, json: null }));

      // 等两个**同时**成立的条件：驱动器确实被调过，且盘上确实是 in_flight。
      await waitFor(() => readCalls(dataDir).length >= 1, 'A 的驱动器被调用');
      await waitFor(() => readJournal(dataDir).some((entry) => entry.state === 'in_flight'), 'A 的 journal 落 in_flight');

      const beforeKill = journalFingerprint(dataDir);
      const journalBeforeKill = readJournal(dataDir);
      const inFlightBeforeKill = journalBeforeKill.find((entry) => entry.state === 'in_flight');
      expect(inFlightBeforeKill, 'kill 前必须确有 in_flight 记录').toBeTruthy();
      expect(beforeKill.sha256, 'kill 前 journal 必须真的在盘上').toBeTruthy();

      /* ---- 父进程亲手终止它自己拥有的 A ---- */
      a.child.kill();
      const exitA = await a.exit;
      expect(a.exited, 'A 必须真的退出').toBe(true);

      const afterKill = journalFingerprint(dataDir);
      const journalAfterKill = readJournal(dataDir);
      expect(
        journalAfterKill.some((entry) => entry.state === 'in_flight'),
        'A 死后盘上必须仍是 in_flight（证明这是持久状态，不是内存里凑的）'
      ).toBe(true);
      expect(afterKill.sha256, 'kill 不得改写 journal 字节').toBe(beforeKill.sha256);

      await inflightRequest;

      /* ---- B：另一个真进程，读同一份 data ---- */
      const b = spawnChild({ dataDir, readyFile: readyB, apiKey: key, mode: 'normal', logFile: logB });
      const infoB = await waitReady(b, readyB, 'B');
      expect(infoB.pid, 'B 的 ready 文件必须带真实 PID').toBeGreaterThan(0);
      expect(infoB.pid, 'B 必须是与 A 不同的进程').not.toBe(infoA.pid);
      expect(infoB.pid).not.toBe(a.child.pid);

      const callsAfterBStart = readCalls(dataDir).length;

      /* ---- B-1：同 session + 新 Idempotency-Key + 新输入 ⇒ 必须拒绝且零 dispatch ---- */
      const refused = await post({
        port: infoB.port,
        apiKey: key,
        body: { model: MODEL, messages: [{ role: 'user', content: 'B 代：全新输入，全新幂等键' }] },
        headers: {
          'Idempotency-Key': 'idem-B-0002',
          'x-zcc-client-id': SAME_SESSION.clientId,
          'x-zcc-session-id': SAME_SESSION.sessionId
        }
      });

      // 响应体有两层：`error` 是**内部码**（upstream_outcome_unknown），
      // `zcc_error` 才是**契约码**（operation_outcome_unknown）+ detail。
      // 断言钉的是线上真实字面量，不是从被测代码里取常量再与它自己比。
      expect(refused.status, `同会话重发必须被拒，实际 status=${refused.status} body=${refused.text}`).toBe(502);
      expect(refused.json?.error?.code).toBe('upstream_outcome_unknown');
      expect(refused.json?.zcc_error?.code).toBe('operation_outcome_unknown');
      // 真正的判别力在 detail：必须是「会话未决」这条具体理由，而不是别的原因被拒。
      const refusedDetail = refused.json?.zcc_error?.detail;
      expect(refusedDetail?.session_locked, `拒绝理由必须是会话未决，实际 body=${refused.text}`).toBe(true);
      expect(refusedDetail?.auto_resend_allowed).toBe(false);
      expect(refusedDetail?.driver_called).toBe(false);

      const callsAfterRefusal = readCalls(dataDir).length;
      expect(
        callsAfterRefusal,
        `拒绝路径不得 dispatch：驱动器调用台账从 ${callsAfterBStart} 涨到了 ${callsAfterRefusal}`
      ).toBe(callsAfterBStart);

      /* ---- B-2：独立会话正向 ⇒ 证明上面的「拒绝 + 零调用」是闸门造成的 ---- */
      const accepted = await post({
        port: infoB.port,
        apiKey: key,
        body: { model: MODEL, messages: [{ role: 'user', content: '另一个会话：应当正常放行' }] },
        headers: {
          'Idempotency-Key': 'idem-B-0003',
          'x-zcc-client-id': OTHER_SESSION.clientId,
          'x-zcc-session-id': OTHER_SESSION.sessionId
        }
      });

      expect(accepted.status, `独立会话必须能正常发，实际 body=${accepted.text}`).toBe(200);
      const callsAfterAccept = readCalls(dataDir).length;
      expect(callsAfterAccept, '正向必须真的 dispatch 一次').toBe(callsAfterBStart + 1);

      /* ---- B 也要收掉，绝不留常驻子进程 ---- */
      b.child.kill();
      await b.exit;

      /* ---- 证据台账 ---- */
      const evidence = {
        pidA: infoA.pid,
        pidB: infoB.pid,
        exitA: { code: exitA.code, signal: exitA.signal },
        exitB: { code: b.exitCode, signal: b.exitSignal },
        journalBeforeKill,
        journalAfterKill,
        journalBytes: afterKill.bytes,
        journalSha256: afterKill.sha256,
        driverCalls: readCalls(dataDir),
        callsAfterBStart,
        callsAfterRefusal,
        callsAfterAccept,
        refusedStatus: refused.status,
        refusedCode: refused.json?.zcc_error?.code ?? null,
        acceptedStatus: accepted.status,
        childALog: summarizeLog(readFileOrEmpty(logA)),
        childBLog: summarizeLog(readFileOrEmpty(logB))
      };
      emit('XPROC_EVIDENCE', evidence);
      expect(evidence.pidA).not.toBe(evidence.pidB);
    },
    90000
  );

  it(
    'T16 换 API key 的同会话重发：只实测记录，不预设结论',
    async () => {
      expect(BUNDLE).toBeTruthy();

      const dataDir = tmpRoot('xprockey');
      const keyA = generateApiKey();
      const keyC = generateApiKey();
      const readyA = path.join(dataDir, 'ready-A.json');
      const readyC = path.join(dataDir, 'ready-C.json');
      const logC = path.join(dataDir, 'child-C.log');

      const a = spawnChild({ dataDir, readyFile: readyA, apiKey: keyA, mode: 'hang', logFile: path.join(dataDir, 'child-A.log') });
      const infoA = await waitReady(a, readyA, 'A(keyA)');

      const inflight = post({
        port: infoA.port,
        apiKey: keyA,
        body: { model: MODEL, messages: [{ role: 'user', content: 'A 代：停在 in_flight' }] },
        headers: {
          'Idempotency-Key': 'idem-K-0001',
          'x-zcc-client-id': SAME_SESSION.clientId,
          'x-zcc-session-id': SAME_SESSION.sessionId
        }
      }).catch(() => ({ status: 0, text: 'aborted', json: null }));

      await waitFor(() => readCalls(dataDir).length >= 1, 'A 的驱动器被调用');
      await waitFor(() => readJournal(dataDir).some((entry) => entry.state === 'in_flight'), 'A 落 in_flight');
      a.child.kill();
      await a.exit;
      await inflight;

      // C 拿**另一把 API key**，会话头与 A 相同。
      // `sessionKey = idempotencyScope(client, session, keyFingerprint)` 含 key 指纹，
      // 所以换 key 会换出会话键——这正是要实测的点，不在这里替父审下结论。
      const c = spawnChild({ dataDir, readyFile: readyC, apiKey: keyC, mode: 'normal', logFile: logC });
      const infoC = await waitReady(c, readyC, 'C(keyC)');
      expect(infoC.pid).not.toBe(infoA.pid);

      const callsBefore = readCalls(dataDir).length;
      const observed = await post({
        port: infoC.port,
        apiKey: keyC,
        body: { model: MODEL, messages: [{ role: 'user', content: 'C 代：换了一把 API key' }] },
        headers: {
          'Idempotency-Key': 'idem-K-0002',
          'x-zcc-client-id': SAME_SESSION.clientId,
          'x-zcc-session-id': SAME_SESSION.sessionId
        }
      });
      const callsAfter = readCalls(dataDir).length;

      c.child.kill();
      await c.exit;

      const observation = {
        pidA: infoA.pid,
        pidC: infoC.pid,
        sameSessionHeaders: true,
        apiKeyRotated: true,
        observedStatus: observed.status,
        observedCode: observed.json?.error?.code ?? observed.json?.code ?? null,
        sessionLockedDetail: observed.json?.error?.detail?.session_locked ?? null,
        driverCallsBefore: callsBefore,
        driverCallsAfter: callsAfter,
        dispatched: callsAfter > callsBefore,
        childCLog: summarizeLog(readFileOrEmpty(logC))
      };
      emit('XPROC_KEYROTATION_OBSERVATION', observation);

      // 只断言「确实测到了东西」：状态码是有限整数、台账可读。不替父审裁定语义。
      expect(Number.isInteger(observation.observedStatus)).toBe(true);
      expect(observation.driverCallsAfter).toBeGreaterThanOrEqual(observation.driverCallsBefore);
    },
    90000
  );

  it(
    'T17 session_locked 日志不得写出 client/session 原值：只留会话指纹（合成 canary 回归守卫）',
    async () => {
      expect(BUNDLE).toBeTruthy();

      const dataDir = tmpRoot('xproc-log');
      const key = generateApiKey();
      const readyA = path.join(dataDir, 'ready-A.json');
      const readyB = path.join(dataDir, 'ready-B.json');
      const logA = path.join(dataDir, 'child-A.log');
      const logB = path.join(dataDir, 'child-B.log');
      // 会话头里带**非凭据形状** canary：沿用 v95 的理由——本条命题是「日志会不会写出标识原值」，
      // 不是「脱敏器会不会洗掉它」。凭据形状的 canary 会被 redact() 命中而假绿。
      const canarySession = 'RA09LOG-3b7d51e9a2c404';

      const a = spawnChild({ dataDir, readyFile: readyA, apiKey: key, mode: 'hang', logFile: logA });
      const infoA = await waitReady(a, readyA, 'A');
      const inflight = post({
        port: infoA.port,
        apiKey: key,
        body: { model: MODEL, messages: [{ role: 'user', content: 'A 代：停在 in_flight' }] },
        headers: {
          'Idempotency-Key': 'idem-L-0001',
          'x-zcc-client-id': `client-${canarySession}`,
          'x-zcc-session-id': `session-${canarySession}`
        }
      }).catch(() => ({ status: 0, text: 'aborted', json: null }));
      await waitFor(() => readCalls(dataDir).length >= 1, 'A 的驱动器被调用');
      await waitFor(() => readJournal(dataDir).some((entry) => entry.state === 'in_flight'), 'A 落 in_flight');
      a.child.kill();
      await a.exit;
      await inflight;

      const b = spawnChild({ dataDir, readyFile: readyB, apiKey: key, mode: 'normal', logFile: logB });
      const infoB = await waitReady(b, readyB, 'B');
      // 正常完成路径（A 代里没有正常完成的请求，B 代这次是被闸门拒的）——
      // 这里要的是**被拒路径**上的日志行。
      const refused = await post({
        port: infoB.port,
        apiKey: key,
        body: { model: MODEL, messages: [{ role: 'user', content: 'B 代：应当被会话闸门拒' }] },
        headers: {
          'Idempotency-Key': 'idem-L-0002',
          'x-zcc-client-id': `client-${canarySession}`,
          'x-zcc-session-id': `session-${canarySession}`
        }
      });
      expect(refused.status, `前置：本条只在确实被会话闸门拒时成立，实际 ${refused.text}`).toBe(502);
      b.child.kill();
      await b.exit;

      const logBText = readFileOrEmpty(logB);
      const lockedLine = logBText.split('\n').find((line) => line.includes('event=session_locked'));
      const rawHits = logBText.split(canarySession).length - 1;

      // 只回吐**脱敏后的行 + 哈希**：stdout 会被 gate 原样封存，
      // 原始身份/原始 canary 不进证据链。
      const redactedLine =
        lockedLine === undefined
          ? null
          : lockedLine.split(canarySession).join('<SYNTHETIC-CANARY-REDACTED>');

      emit('XPROC_LOG_OBSERVATION', {
          lockedLineRedacted: redactedLine,
          lockedLineSha256:
            lockedLine === undefined ? null : crypto.createHash('sha256').update(lockedLine, 'utf8').digest('hex'),
          rawCanaryOccurrences: rawHits,
          childBLog: summarizeLog(logBText)
        });

      // 守卫目标：`event=session_locked` 这一行**不得**写出 client/session 原值，
      // 只能写会话指纹（session_key）。
      // 变异 M3 会把这行改回原值形态，本条必须随之转红——否则它是恒真断言。
      expect(lockedLine, '必须真的产生 event=session_locked 日志行，否则本条是空断言').toBeTruthy();
      expect(rawHits, '合成 canary 原值不得出现在日志里').toBe(0);
      expect(lockedLine).not.toMatch(/(^|\s)client=/);
      expect(lockedLine).not.toMatch(/(^|\s)session=/);
      expect(lockedLine, '改用会话指纹后必须仍保留可定位的键').toMatch(/(^|\s)session_key=/);
    },
    90000
  );
});