/**
 * I02 contract test — zero-send runtime probe. Vitest, wired into `npm test`.
 *
 * WHY THIS FILE IS NEW RATHER THAN THE FROZEN ONE
 *   The frozen half-product's test used `node:test` and sat in
 *   `packages/runtime/test/`, which the root `vitest.config.ts` does not include.
 *   `node --test` collected it; `npm test` never did. It also carried a
 *   tautology — `assert.ok(counters.nonceSeen === true || true)` — which is
 *   exactly the always-true assertion the contract forbids. Both are fixed here.
 *
 * WHAT IS AND IS NOT OFFICIAL
 *   The scenario children below are written by this test into an OS temp
 *   directory and deleted afterwards. They are a FIXTURE-ONLY transport
 *   harness. They implement no official ZCode RPC semantics, and nothing they
 *   return may be reported as official runtime behaviour. A fixture that
 *   "passes" proves the transport, the limits and the refusal path work; it
 *   proves nothing about the real runtime and never upgrades a capability.
 *
 * THE CENTRAL ASSERTION, AND THE REV4 CORRECTION TO IT
 *   Before the REV4 review this file claimed the model-dispatch counter was
 *   "measured TWICE and independently". It was not: the child's counter had a
 *   real increment point, the client's had none anywhere in the package, so
 *   `assertNoModelDispatch()` could not throw. The client now increments
 *   `modelDispatchAttempts` on the refusal path, and these tests assert the
 *   exact non-zero number a deliberate refusal run produces — which is what
 *   makes the assertion capable of failing at all.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..', '..');
const I01_FAKE_RUNTIME = join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-runtime.mjs');
const RUNTIME_MODULE = join(PROJECT_ROOT, 'packages', 'runtime', 'src', 'capability-probe.ts');
const DISCOVERY_MODULE = join(PROJECT_ROOT, 'packages', 'runtime', 'src', 'discovery.ts');
const VERIFY_CLI = join(PROJECT_ROOT, 'scripts', 'verify-runtime.mjs');

/** @type {any} */
let runtime;
/** @type {any} */
let discovery;
let tmpRoot = '';

/**
 * FIXTURE-ONLY scenario child. Not an official runtime, not MCP, not JSON-RPC
 * compatible with anything. It exists so the client can be driven through ten
 * hostile shapes and so it can independently count what it was asked to do.
 */
const CHILD_SOURCE = String.raw`
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const at = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
const scenario = at('--scenario', 'ok');
const countersPath = at('--counters', '');

// REV4 I-5. This mirrors the product's write allowlist, which is ONE method as
// of I02-F4. It used to be sixteen, which is what let this fixture "prove" the
// transport worked on methods the product is no longer allowed to send, and two
// until I02-F4 removed the startup/storagePathReady reply — which belongs to
// app-server --prepare-storage, not to the surface under test.
const CONTROL_ALLOW = new Set(['runtime/capabilities']);

const counters = {
  scenario,
  pid: process.pid,
  nonceSeen: process.env.ZCODE_COMPANION_PROBE_NONCE ?? null,
  inboundFrames: 0,
  // I02-F2-3. Every inbound line, verbatim and in arrival order, so a test can
  // assert the EXACT bytes the client wrote — including whether a startup
  // handshake reply was sent at all, and what shape it had.
  inboundLines: [],
  // Every inbound frame that was NOT on the control-plane allowlist would be a
  // frame the client had no business sending. This must stay 0.
  modelDispatchAttempts: 0,
  outboundReverseRequests: 0,
  reverseResponses: [],
  lastState: null
};

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function record() { if (countersPath) writeFileSync(countersPath, JSON.stringify(counters, null, 2), 'utf8'); }

// I02-F3-2/F3-3. The two timer-driven scenarios below answer without going
// through handle(), so they read the last request off these two variables.
let lastRequestId = null;
let lastRequestLine = null;
// I02-F3-3. Scenarios whose inbound handling is deliberately NOT the generic
// one, because the behaviour under test IS the arrival order of frames.
const TIMER_OWNED_SCENARIOS = new Set(['reject_then_answer', 'official_shape_gate', 'notification_only']);

// Written before the first request, so a run in which the client sends nothing
// at all still leaves a recorded zero on disk. A counter that only appears once
// something goes wrong proves nothing about the runs where nothing did.
record();

function capabilitiesResult() {
  if (scenario === 'not_logged_in') return { error: { code: -32001, message: 'not authenticated' } };
  const version = scenario === 'version_change' ? '99.99.99' : '0.16.9';
  return { result: { independentPlanState: true, serverInfo: { version } } };
}

function handle(msg) {
  counters.inboundFrames += 1;
  // Record on EVERY inbound frame, not only on the interesting ones, so the
  // counters file is always current. The frozen half-product only recorded on
  // refusal, so the counters file did not exist at all for a clean scenario.
  record();
  const method = typeof msg.method === 'string' ? msg.method : '';
  if (!CONTROL_ALLOW.has(method)) {
    counters.modelDispatchAttempts += 1;
    record();
    send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'Method not found: ' + method } });
    return;
  }
  counters.lastState = method;
  // PRE-EXISTING DEFECT, found and fixed in I02-F2 (this file is inside this
  // round's boundary). This line used to inline its own response with
  // "serverInfo: { version }", and that version was a FREE VARIABLE: the only
  // version binding in the file is the "const version" INSIDE
  // capabilitiesResult() a few lines above. So every runtime/capabilities frame
  // made the fixture child throw "ReferenceError: version is not defined", the
  // child died inside its stdin handler, and the parent saw a closed stdout.
  // capabilitiesResult() was dead code as a result, which is also why the
  // not_logged_in scenario -- the only thing that needs it -- could never
  // produce its -32001. The observable symptom before the fix was six contract
  // tests failing, including "the one writable method is read back with a
  // correlated id".
  if (method === 'runtime/capabilities') { send({ jsonrpc: '2.0', id: msg.id, ...capabilitiesResult() }); return; }
  send({ jsonrpc: '2.0', id: msg.id, result: { echo: method } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() === '') continue;
    counters.inboundLines.push(line);
    record();
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    if (msg.id !== undefined && typeof msg.method !== 'string') {
      // This is the client's answer to one of our reverse requests.
      counters.reverseResponses.push({ id: msg.id, isError: Boolean(msg.error), errorCode: msg.error?.code ?? null });
      record();
      continue;
    }
    // I02-F3-2/F3-3: the scenarios in TIMER_OWNED_SCENARIOS answer on their own
    // schedule and MUST NOT also go through handle(), or the generic handler
    // would answer instantly and the ordering under test would not exist.
    // notification_only never answers at all.
    lastRequestId = msg.id ?? null;
    lastRequestLine = line;
    if (TIMER_OWNED_SCENARIOS.has(scenario)) { record(); continue; }
    handle(msg);
  }
});

process.stdin.on('end', () => { record(); process.exitCode = 0; });

if (scenario === 'eof_bad_frame') {
  process.stdout.write('{ this is not json\n');
  setTimeout(() => { process.stdout.end(); process.stdin.pause(); }, 10);
} else if (scenario === 'oversize') {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'c1', result: { blob: 'x'.repeat(70000) } }) + '\n');
  }, 10);
} else if (scenario === 'buffer_bomb') {
  // A runaway stream of unterminated data. Which guard fires first depends on
  // the client's limits, so the same fixture covers both bound tests below.
  setTimeout(() => {
    const big = 'x'.repeat(300 * 1024);
    for (let i = 0; i < 20; i++) process.stdout.write(big);
  }, 10);
} else if (scenario === 'tool_reverse_request') {
  setTimeout(() => {
    counters.outboundReverseRequests += 1;
    record();
    send({ jsonrpc: '2.0', id: 9001, method: 'interaction/requestOfficialMcpAuthHeaders', params: { mcpKey: 'FIXTURE-NOT-REAL' } });
    setTimeout(() => { send({ jsonrpc: '2.0', id: 9002, method: 'tools/call', params: { name: 'Read' } }); }, 30);
  }, 20);
} else if (scenario === 'cjk_split') {
  setTimeout(() => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 'c1', result: { note: '中文跨块流式UTF-8：零发送探针' } }) + '\n';
    const buf = Buffer.from(line, 'utf8');
    for (let i = 0; i < buf.length; i += 7) process.stdout.write(buf.subarray(i, i + 7));
  }, 20);
} else if (scenario === 'batched_frames') {
  // REGRESSION FIXTURE for the framing defect found on review: the pre-review
  // client consumed only the FIRST newline per chunk and stranded the rest, so
  // several frames written in one write() were silently lost. All six frames
  // below land in a single stdout write and every one of them must arrive.
  setTimeout(() => {
    const frames = [1, 2, 3, 4, 5, 6].map((n) => JSON.stringify({ jsonrpc: '2.0', id: 'b' + n, result: { n } }));
    process.stdout.write(frames.join('\n') + '\n');
  }, 20);
  } else if (scenario === 'startup_state') {
    // REV4 I-2 fixture. A frame shaped like the official startup/storageState
    // announcement (E-BUNDLE-016), carrying values chosen so that a leak would be
    // obvious: a real-looking path, a UUID attemptId and a databaseId. The shape
    // summary must describe every one of them without printing any of them.
    //
    // NOTE there is no "id" field, and that is faithful: E-BUNDLE-014 declares the
    // preparation frame as m.object({method, params}).strict() -- a strict object
    // with no id slot. A frame that DOES carry both a method and an id is a
    // server->client REQUEST, and this client refuses those on sight; that is the
    // tool_reverse_request scenario, not this one.
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        method: 'startup/storageState',
        params: {
          schemaVersion: 1,
          attemptId: '7f3c9a10-LEAK-ATTEMPT-ID-must-not-appear',
          sequence: 3,
          databaseId: 'b21d4e88-LEAK-DATABASE-ID-must-not-appear',
          databaseKind: 'tasks-index',
          phase: 'committing',
          elapsedMs: 412
        }
      });
    }, 20);
  } else if (scenario === 'reject_then_answer') {
    // I02-F3-3 fixture. Reproduces the SHAPE of the real round-2 failure and
    // then does the thing the real server never got the chance to do: it
    // answers properly 60 ms later.
    //
    //   frame 1: {"error":{code:-32600,data:{issues:[…]},"message":"Invalid ZCode Protocol message"},"id":"invalid-message"}
    //   frame 2: {"id":<our id>,"result":{"independentPlanState":true}}
    //
    // The id "invalid-message" is the official REASON LITERAL from
    // E-BUNDLE-022 — a fixed token, deliberately NOT our request id, so a
    // client that treats the first error frame as the answer is wrong twice
    // over. A client that waits for its own id finds frame 2.
    setTimeout(() => {
      send({
        error: {
          code: -32600,
          data: { issues: [{ code: 'unrecognized_keys', keys: ['jsonrpc'], path: [], message: 'Unrecognized key: "jsonrpc"' }] },
          message: 'Invalid ZCode Protocol message'
        },
        id: 'invalid-message'
      });
    }, 20);
    // Echo back whatever id we were actually given, exactly as the official
    // server does through ok(t,n){return{id:t,result:n}} (E-BUNDLE-024).
    setTimeout(() => {
      if (typeof lastRequestId === 'string' || typeof lastRequestId === 'number') {
        send({ id: lastRequestId, result: { independentPlanState: true } });
      }
    }, 80);
  } else if (scenario === 'notification_only') {
    // I02-F3-3 fixture. Emits ONE official-shaped startup NOTIFICATION (method,
    // no id — E-BUNDLE-021 Wir) and then never answers anything. A client that
    // takes the first frame of any shape as its answer would "succeed" here
    // with a notification; a correct one times out, and the log says why.
    setTimeout(() => {
      send({
        method: 'startup/storageState',
        params: {
          schemaVersion: 1,
          attemptId: 'FIXTURE-ATTEMPT-ID',
          sequence: 1,
          databaseId: 'FIXTURE-DATABASE-ID',
          databaseKind: 'session',
          phase: 'checking',
          elapsedMs: 1
        }
      });
    }, 30);
  } else if (scenario === 'official_shape_gate') {
    // I02-F3-2 fixture. Records the inbound line, applies the OFFICIAL message
    // union of E-BUNDLE-021 by hand, and — when the union fails — answers with
    // the official reason literal of E-BUNDLE-022 instead of the request's own
    // id. A frame carrying a jsonrpc member fails the union exactly as it
    // fails the real server's, so the outbound-frame test is a real test of the
    // wire contract rather than a restatement of the implementation.
    setTimeout(() => {
      const members = lastRequestLine === null ? [] : Object.keys(JSON.parse(lastRequestLine));
      const rejected = members.some((k) => k !== 'id' && k !== 'method' && k !== 'params' && k !== 'trace');
      if (rejected) {
        send({
          error: {
            code: -32600,
            data: { issues: [{ code: 'unrecognized_keys', keys: members.filter((k) => k !== 'id' && k !== 'method' && k !== 'params' && k !== 'trace'), path: [], message: 'Unrecognized key: "' + members.filter((k) => k !== 'id' && k !== 'method' && k !== 'params' && k !== 'trace')[0] + '"' }] },
            message: 'Invalid ZCode Protocol message'
          },
          id: 'invalid-message'
        });
        return;
      }
      send({ id: lastRequestId, result: { independentPlanState: true } });
    }, 40);
  } else if (scenario === 'startup_sequence') {
    // I02-F2-3 fixture. Reproduces the phase sequence captured from the REAL
    // official runtime in review-artifacts/929/probe-r1-full-frames.json, frame
    // for frame: checking, checking, checking(+migration), committing, ready.
    // All five are written in ONE write() so the client sees them in a single
    // chunk, which is also how the real capture arrived.
    //
    // It also answers runtime/capabilities, and it records every inbound line
    // verbatim to a trace file so a test can assert the exact bytes the client
    // wrote, in order.
    setTimeout(() => {
      const ph = [
        { sequence: 1, phase: 'checking' },
        { sequence: 2, phase: 'checking' },
        { sequence: 3, phase: 'checking' },
        { sequence: 4, phase: 'committing' },
        { sequence: 5, phase: 'ready' }
      ];
      const frames = ph.map((s) => JSON.stringify({
        method: 'startup/storageState',
        params: {
          schemaVersion: 1,
          attemptId: 'FIXTURE-ATTEMPT-ID-MUST-NOT-LEAK',
          sequence: s.sequence,
          databaseId: 'FIXTURE-DATABASE-ID-MUST-NOT-LEAK',
          databaseKind: 'session',
          phase: s.phase,
          elapsedMs: s.sequence
        }
      }));
      process.stdout.write(frames.join('\n') + '\n');
    }, 20);
  }

// The identity proof that the peer is the child this test created is the
// nonce/pid the child records in its OWN counters file, which the parent reads
// back. The frozen half-product used a "boot" line on stdout instead, which
// occupied the first nextFrame() slot and made five of its own scenarios
// assert against the boot frame rather than the frame under test.
`;

/**
 * FIXTURE-ONLY child for the discovery capture path (REV4 m-4). It emits a CJK
 * string in 3-byte slices with a gap between writes, which is how a real
 * process's output reaches a reader in practice: a multi-byte character is very
 * often split across two reads. The reader must reassemble before decoding.
 */
const CJK_CAPTURE_SOURCE = String.raw`
const text = '帮助与用法：--surface 桌面或终端 --mode 构建 编辑 计划 放行 · αβγ δεζ';
const buf = Buffer.from(text, 'utf8');
let i = 0;
const tick = () => {
  if (i >= buf.length) { process.stdout.end(); return; }
  process.stdout.write(buf.subarray(i, i + 3));
  i += 3;
  setTimeout(tick, 6);
};
tick();
`;

/** @param {string} name @returns {string} */
function childPath(name) {
  const p = join(tmpRoot, `${name}.mjs`);
  writeFileSync(p, CHILD_SOURCE, 'utf8');
  return p;
}

/** @param {string} name @returns {string} */
function countersPath(name) {
  return join(tmpRoot, `${name}.counters.json`);
}

/** @param {string} name @returns {any} */
function readCounters(name) {
  const p = countersPath(name);
  expect(existsSync(p), `the child must write its own counters to ${p} — an uncounted run proves nothing`).toBe(true);
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * Drives one scenario end to end and reclaims only the handle it created.
 *
 * `zeroSend` selects WHICH zero-send invariant applies on teardown, and the
 * choice is not cosmetic. The default (`'strict'`) asserts the full contract:
 * no dispatching method was even attempted, so a P2/P3/P4-style run passes. A
 * scenario that deliberately asks for dispatching methods sets `'refused'`,
 * which asserts the weaker but still load-bearing invariant — the gate stopped
 * every one of them and nothing was written. Before the REV4 I-3 fix there was
 * no way to express this, because the single assertion could not distinguish
 * "never asked" from "asked and refused".
 *
 * @param {string} name
 * @param {(c: any) => Promise<void>} body
 * @param {{ zeroSend?: 'strict' | 'refused' }} [options]
 */
async function withScenario(name, body, options = {}) {
  const mode = options.zeroSend ?? 'strict';
  const client = new runtime.NoSendStdioClient({
    command: process.execPath,
    args: [childPath(name), '--scenario', name, '--counters', countersPath(name)],
    cwd: tmpRoot,
    nonce: runtime.makeNonce(),
    requestTimeoutMs: 4000
  });
  client.start();
  /** @type {any} */
  let outcome = null;
  try {
    outcome = await body(client);
  } finally {
    const closed = await client.close();
    expect(closed.pendingWaiters, 'no waiter may survive teardown').toBe(0);
    if (mode === 'strict') {
      expect(() => client.assertNoModelDispatch()).not.toThrow();
    } else {
      expect(() => client.assertNoDispatchRefusedCleanly()).not.toThrow();
    }
    expect(closed.stage, `the ${name} child had to be SIGKILLed; teardown must be reached by stdin EOF`).not.toBe('sigkill');
  }
  return outcome;
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'zcode-companion-i02-'));
  runtime = await import(RUNTIME_MODULE);
  discovery = await import(DISCOVERY_MODULE);
});

/**
 * TAPFIX(F4) — bounded CONDITION wait, replacing a fixed sleep.
 *
 * WHY THE FIXED SLEEP WAS THE BUG
 *   `scenario: reverse tool requests` used `await new Promise(r => setTimeout(r, 400))`
 *   and then asserted `ledger.refusedReverse >= 2`. Those 400 ms are measured from
 *   `client.start()` — i.e. from the parent's spawn() call — but the fixture child's
 *   `setTimeout(..., 20)` / `+30 ms` do not start until **node has booted**. The
 *   fixture child's timers therefore had not even been scheduled yet at t=400 ms, and
 *   the assertion failed with `expected 0 to be greater than or equal to 2`. It was a
 *   race against node boot wearing a timeout's clothes.
 *
 *   IMPORTANT — the corrected measurement (TAPFIX3 / P3.3).
 *   The previous revision of this comment claimed a spawn->first-output
 *   "p50 1.2–1.8 s, max ~3.1 s". **That number does not reproduce** and the claim has
 *   been withdrawn. Re-measured on this machine (20 cores, `node -e 'print one byte'`,
 *   40 spawns per condition, TAPFIX3):
 *     idle      p50  38 ms   p90 136 ms   max 219 ms   >400 ms: 0/40
 *     6 hogs    p50 149 ms   p90 335 ms   max 511 ms   >400 ms: 2/40 (5%)
 *     12 hogs   p50 221 ms   p90 340 ms   max 409 ms   >400 ms: 2/40 (5%)
 *   The independent TAPFIX3 review measured the same order of magnitude (idle p50
 *   59 ms, 6 hogs p50 66 ms, 12 hogs p50 142 ms, 8% of samples over 400 ms) and
 *   likewise could not reproduce 1.2–1.8 s.
 *
 *   So the **median** boot is tens to hundreds of milliseconds, not seconds. What
 *   actually breaks the test is the **tail**: a few percent of spawns land past the
 *   400 ms mark, and those runs are the flakes. Describing it as a median problem was
 *   both numerically wrong and operationally misleading — it would suggest "raise the
 *   constant", which is precisely the wrong fix (see below). The tail is exactly what a
 *   condition-wait eliminates.
 *
 * WHY NOT "RAISE 400 ms" OR "ADD TOLERANCE"
 *   Both are the same move: make the assertion weaker. A fixed sleep cannot ever
 *   distinguish "the condition became true" from "I hoped it had by now". The
 *   engineering rule for this file is that assertions may only be appended to or
 *   strengthened, never deleted or relaxed — and waiting for the condition is
 *   strictly STRONGER than sleeping: the assertions below are unchanged and still
 *   fire, but they now run against a state that has actually been reached, and a
 *   condition that never becomes true fails loudly instead of intermittently.
 *
 * A silent timeout would be a fake green, so this throws.
 *
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {{ what?: string, timeoutMs?: number, intervalMs?: number }} [options]
 */
async function waitUntil(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await predicate();
    } catch {
      ok = false; // "not ready yet" is not a failure; only the deadline is
    }
    if (ok) return;
    if (Date.now() > deadline) {
      throw new Error(`condition never became true within ${timeoutMs} ms${options.what ? ` (${options.what})` : ''}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

afterAll(() => {
  if (tmpRoot !== '') rmSync(tmpRoot, { recursive: true, force: true });
});

/* ================================================================== *
 * Scenario 1 — normal zero-send handshake
 * ================================================================== */

describe('scenario: normal no-send handshake', () => {
  test('the one writable method is read back with a correlated id, and nothing else is attempted', async () => {
    await withScenario('ok', async (client) => {
      const nonce = client.identity.nonce;
      expect(nonce, 'the parent must generate a nonce before spawning').toMatch(/^[0-9a-f]{32}$/);

      // I-1: `nextRequestId()` is what lets a caller prove the frame it read
      // back answers the frame it sent. Guessing "c1" would be wrong after any
      // passively observed frame, because those advance the same ordinal.
      const firstId = client.nextRequestId();
      const caps = await client.request('runtime/capabilities', {}, 4000);
      expect(caps.kind).toBe('ok');
      expect(caps.kind === 'ok' && caps.frame.result.independentPlanState).toBe(true);
      expect(caps.kind === 'ok' && caps.frame.id, 'the response must carry the id the request was assigned').toBe(firstId);

      const secondId = client.nextRequestId();
      expect(secondId, 'the id must advance so two outstanding reads cannot be confused').not.toBe(firstId);
      const again = await client.request('runtime/capabilities', {}, 4000);
      expect(again.kind === 'ok' && again.frame.id).toBe(secondId);

      const counters = readCounters('ok');
      // The nonce check the frozen test faked with `x === true || true`.
      expect(counters.nonceSeen, 'the child must have received the nonce the parent generated').toBe(nonce);
      expect(counters.pid).toBe(client.identity.pid);
      expect(counters.modelDispatchAttempts, 'the child must have received zero non-control-plane frames').toBe(0);
      expect(counters.inboundFrames, 'exactly the two capabilities frames and nothing else').toBe(2);

      const ledger = client.ledger;
      expect(ledger.controlFrames).toBe(2);
      expect(ledger.modelDispatch).toBe(0);
      // I-3: this counter has a real increment on the refusal path, and nothing
      // in this run touched that path, so zero here is an observation.
      expect(ledger.modelDispatchAttempts, 'this run never even asked for a dispatching method').toBe(0);
      expect(ledger.refusalFrames, 'the fixture asked for nothing, so nothing had to be refused').toBe(0);
    });
  });

  test('the shipped matrix still reports runtimeReady=false after a clean fixture run', () => {
    const report = runtime.buildProbeReport({ modelDispatch: 0, modelDispatchAttempts: 0, controlFrames: 3, refusalFrames: 0, refusedPotentiallyDispatching: 0, refusedReverse: 0, servedReverse: 0 });
    expect(report.runtimeReady, 'a fixture must never make the runtime ready').toBe(false);
    // I02-F4: the allowance is no longer zero, and the number is asserted
    // rather than waved at, because an UNBOUNDED behaviour_verified count is
    // exactly the regression this row's evidence is meant to prevent.
    expect(report.counts.behaviourVerified, 'exactly one behaviour claim, resting on E-PROBE-R3-P4').toBe(1);
  });
});

/* ================================================================== *
 * Framing — the defect found on review
 * ================================================================== */

describe('framing: several frames inside one chunk', () => {
  test('every frame in a single write() is delivered, not just the first', async () => {
    await withScenario('batched_frames', async (client) => {
      const seen = [];
      for (let i = 0; i < 6; i++) {
        const frame = await client.nextFrame(4000);
        expect(frame.kind, `frame ${i} must arrive`).toBe('ok');
        if (frame.kind === 'ok') seen.push(frame.frame.result.n);
      }
      expect(seen, 'the pre-review client stranded every frame after the first').toEqual([1, 2, 3, 4, 5, 6]);
      expect(client.framesSeen).toBe(6);
      expect(readCounters('batched_frames').modelDispatchAttempts).toBe(0);
    });
  });
});

/* ================================================================== *
 * Scenario 2 — not signed in
 * ================================================================== */

describe('scenario: not signed in', () => {
  test('an in-band auth error is data, not a failure, and readiness stays false', async () => {
    await withScenario('not_logged_in', async (client) => {
      // REV4 I-5: this used to be `session/usage`, which the product may no
      // longer write. The transport property under test — an in-band JSON-RPC
      // error is data, not a framing fault — does not depend on which method
      // carries it, so it is exercised on the one method that is writable.
      const caps = await client.request('runtime/capabilities', {}, 4000);
      expect(caps.kind, 'the frame arrived; it is the ACCOUNT that is not ready').toBe('ok');
      expect(caps.kind === 'ok' && caps.frame.error.code).toBe(-32001);
      expect(client.fatal, 'an in-band error is not a framing fault').toBe(null);

      const account = runtime.getCapability('account_ready');
      expect(account.state, 'a spawned process and a received state are not account readiness').toBe('unknown');
      expect(account.blocking).toBe(true);
      expect(readCounters('not_logged_in').modelDispatchAttempts).toBe(0);
    });
  });
});

/* ================================================================== *
 * Scenario 3 + 9 — no catalogue, and account "received" with no models
 *
 * REV4 I-5 rewrote these. They used to fetch a synthetic catalogue through
 * `session/list` and then assert the matrix stayed blocked. That transport is
 * gone: the product may not write `session/list` at all, so the stronger claim
 * is available — the catalogue was never read, therefore it cannot have been
 * observed, therefore the capability is `unknown` and sending stays refused.
 * Asserting on a fixture response that the product is no longer allowed to ask
 * for would have been asserting on a fiction.
 * ================================================================== */

describe('capabilities that depend on a read the product may not perform', () => {
  test('no zero-send readback of the catalogue exists, so the catalogue capability stays unknown', () => {
    expect(
      runtime.CONTROL_PLANE_METHODS.has('session/list'),
      'if this ever becomes true, the catalogue readback must be re-tested against a real observation'
    ).toBe(false);
    expect(runtime.PENDING_READ_ONLY_METHODS.has('session/list')).toBe(true);
    expect(runtime.getCapability('catalog_model_readback').state).toBe('unknown');
    expect(runtime.getCapability('catalog_model_readback').blocking).toBe(true);
  });

  test('an account that reports "received" cannot have reached the matrix, because nothing may read it', () => {
    expect(runtime.getCapability('account_ready').state).toBe('unknown');
    expect(runtime.CONTROL_PLANE_METHODS.has('provider/updateAccountConfig')).toBe(false);
    expect(runtime.FORBIDDEN_METHODS.has('provider/updateAccountConfig')).toBe(true);

    const map = runtime.buildBillingEvidenceMap();
    expect(map.resolvedClass, 'a missing link keeps the whole billing chain unknown').toBe('unknown');
    expect(map.sendAllowed, 'unknown is never sendable').toBe(false);
    expect(map.links.every((/** @type {any} */ l) => l.status === 'unknown')).toBe(true);
    expect(runtime.getCapability('billing_class_evidence').state).toBe('blocked');
  });
});

/* ================================================================== *
 * Scenario 4 — unknown RPC
 * ================================================================== */

describe('scenario: unknown RPC', () => {
  test('I-3: the client refuses every dispatching method AND the refusal is counted, not silently dropped', async () => {
    // This is the test the REV4 review asked for. Before the fix, the client's
    // `modelDispatch` had no increment point anywhere in the package and
    // `assertNoModelDispatch()` could not throw, so the claim "measured twice
    // and independently" was one real observation plus one decoration. Now the
    // refusal path increments a counter, and the EXACT number is asserted — a
    // counter that could only read 0 could not be asserted to read 5.
    const attempts = [
      'session/send',
      'workspace/generateText',
      'offPeak/create',
      'provider/updateAccountConfig',
      'provider/testModelConnectivity'
    ];
    let observedAttempts = null;

    await withScenario('unknown_rpc', async (client) => {
      // Real official model-dispatch and state-changing methods, all refused
      // before a byte reaches the pipe.
      for (const method of attempts) {
        await expect(client.request(method, { input: 'hello' }, 1000)).rejects.toThrow(runtime.ModelDispatchAttemptError);
      }

      const ok = await client.request('runtime/capabilities', {}, 4000);
      expect(ok.kind, 'the transport still works after refusals').toBe('ok');

      const ledger = client.ledger;
      // I-3, the load-bearing assertion. Remove the increment from the refusal
      // path and this goes red — which is exactly the mutation proof.
      expect(ledger.modelDispatchAttempts, 'a refused dispatching method must still be counted').toBe(attempts.length);
      expect(ledger.refusedPotentiallyDispatching).toBe(attempts.length);
      expect(ledger.modelDispatch, 'and not one of them produced a frame').toBe(0);
      expect(ledger.controlFrames).toBe(1);
      expect(ledger.refusalFrames, 'a refused REQUEST is not a refusal frame').toBe(0);

      // The strict assertion is now capable of failing, and does fail here,
      // because this run deliberately attempted five dispatches.
      expect(() => client.assertNoModelDispatch()).toThrow(/5 model-dispatch attempt\(s\), 0 frame\(s\) actually written/);
      // The honest invariant for this run: every attempt was stopped, nothing
      // was written. This is what a refusal-path scenario is allowed to assert.
      expect(() => client.assertNoDispatchRefusedCleanly()).not.toThrow();

      observedAttempts = ledger.modelDispatchAttempts;
    }, { zeroSend: 'refused' });

    expect(observedAttempts, 'the count must survive to the end of the run, not reset on teardown').toBe(attempts.length);

    const counters = readCounters('unknown_rpc');
    expect(counters.inboundFrames, 'only the one control-plane frame reached the child').toBe(1);
    expect(counters.modelDispatchAttempts, 'the child independently confirms it was never asked to dispatch').toBe(0);
  });

  test('I-5: every demoted method is now classified as dispatching and cannot be written', () => {
    // I-5. `session/messages`, `session/usage`, `mcp/list` and ten others were
    // on the write allowlist until this round, on the strength of a truncated
    // method-name table. Their removal is a real narrowing and it must hold for
    // every one of them, not just the ones a test happens to name.
    const pending = [...runtime.PENDING_READ_ONLY_METHODS.keys()];
    expect(pending.length, 'fourteen methods were demoted; a silent drop would be a regression').toBe(14);
    for (const method of pending) {
      expect(runtime.CONTROL_PLANE_METHODS.has(method), `${method} is still writable`).toBe(false);
      expect(runtime.classifyMethod(method), `${method} must now be refused by the write gate`).toBe('potentially_model_dispatching');
      expect(
        runtime.PENDING_READ_ONLY_METHODS.get(method),
        `${method} must say why its read-only status is unproven`
      ).toBeTruthy();
    }
  });

  test('exactly one capability is behaviour-verified, and it rests on a reviewed real run', () => {
    // I02-F4: this used to assert that NO row is behavior_verified, which was
    // true while the matrix rested only on sources. It is now pinned the other
    // way, and pinned HARDER than "not zero": a state that upgrades on
    // observation must be able to say WHICH observation, and a fixture must
    // never be able to produce it.
    const report = runtime.buildProbeReport(null);
    expect(report.billing.sendAllowed, 'a behaviour-verified startup handshake is not a send permit').toBe(false);
    expect(report.blockingSummary.length, 'the blocking list must be non-empty while the product is E0').toBeGreaterThan(0);
    const verified = report.capabilities.filter((/** @type {any} */ c) => c.state === 'behavior_verified');
    expect(verified.map((/** @type {any} */ c) => c.id)).toEqual(['zero_send_startup_handshake']);
    expect(runtime.behaviourVerifiedCount()).toBe(1);
    const rec = runtime.getCapability('zero_send_startup_handshake');
    const capture = rec.evidence.filter((/** @type {any} */ e) => e.layer === 'official_process_capture');
    expect(
      capture.map((/** @type {any} */ e) => e.id),
      'a behaviour claim must cite a real-process capture; own_fixture can never support it'
    ).toEqual(['E-PROBE-R3-P4']);
    expect(
      rec.evidence.some((/** @type {any} */ e) => e.layer === 'own_fixture'),
      'no fixture evidence may appear on a behavior_verified row'
    ).toBe(false);
  });
});

/* ================================================================== *
 * Scenario 5 — version change
 * ================================================================== */

describe('scenario: version change', () => {
  test('a server that reports a different version invalidates the pinned evidence', async () => {
    await withScenario('version_change', async (client) => {
      const caps = await client.request('runtime/capabilities', {}, 4000);
      expect(caps.kind === 'ok' && caps.frame.result.serverInfo.version).toBe('99.99.99');
      const pinned = runtime.OFFICIAL_RUNTIME_EVIDENCE_PIN.cliVersion;
      const observed = caps.kind === 'ok' ? caps.frame.result.serverInfo.version : null;
      expect(observed, 'the fixture deliberately reports drift').not.toBe(pinned);
      // The product rule: any drift invalidates every help-derived claim.
      expect(pinned).toBe('0.16.9');
      expect(runtime.OFFICIAL_EVIDENCE.every((/** @type {any} */ e) => e.pinnedToOfficialVersion === pinned || e.pinnedToOfficialVersion === null)).toBe(true);
      expect(readCounters('version_change').modelDispatchAttempts).toBe(0);
    });
  });

  test('F4: the protocol version list belongs to the vendored MCP SDK, NOT to this surface', () => {
    // I02-F4 RE-DERIVED this row. The old assertion below was the bug, not the
    // guard: it demanded that the row cite the five MCP version strings, which
    // forced a verdict about the app-server built on another surface's
    // constants. The row is now `unknown`, and this test pins WHY in a way that
    // fails if anyone re-attaches the MCP reading to the app-server.
    //
    //   rec.state === 'mechanism_verified'  =>  wrong: names a mechanism that
    //                                            does not exist on this surface
    //   evidence contains E-BUNDLE-017      =>  wrong: that is the MCP SDK
    //   the row's own text mentions a version the app-server never sends
    const rec = runtime.getCapability('protocol_version_negotiation');
    expect(rec.state).toBe('unknown');
    expect(rec.evidence.map((/** @type {any} */ e) => e.id)).not.toContain('E-BUNDLE-017');
    for (const id of ['E-BUNDLE-027', 'E-BUNDLE-021', 'E-BUNDLE-023']) {
      expect(rec.evidence.map((/** @type {any} */ e) => e.id), `the row must cite ${id} — the real surface`).toContain(id);
    }
    expect(rec.reason).not.toContain('is an MCP server');
    expect(rec.reason).not.toContain('UnsupportedProtocolVersion');
    expect(rec.title, 'the title must not keep calling this surface MCP').not.toContain('（MCP）');
    // The id is deliberately unchanged, so the UI01 target and the row count hold.
    expect(rec.uiTarget).toBe('连接状态 / 协议版本');
    expect(
      runtime.CAPABILITY_MATRIX.length,
      'the row was corrected, not renamed away — the matrix keeps 23 rows'
    ).toBe(23);
  });

  test('F4: E-BUNDLE-017 is corrected in place, not deleted, and nothing cites it', () => {
    // The wrong inference must stay visible in the record — an entry that
    // vanished would let the same claim be re-derived from a re-scan. What must
    // not happen is the entry being cited as this surface's evidence again.
    const ref = runtime.OFFICIAL_EVIDENCE.find((/** @type {any} */ e) => e.id === 'E-BUNDLE-017');
    expect(ref, 'E-BUNDLE-017 is a record of a real literal and is kept').toBeTruthy();
    expect(ref.excerpt).toContain('2025-11-25');
    const citing = runtime.CAPABILITY_MATRIX.filter(
      (/** @type {any} */ c) => c.evidence.some((/** @type {any} */ e) => e.id === 'E-BUNDLE-017')
    );
    expect(citing.map((/** @type {any} */ c) => c.id), 'no capability row may cite the MCP SDK as its own surface').toEqual([]);
  });

  test('F4: the startup handshake row rests on the observed run, and NOT on the client reply', () => {
    // The second half of the I02-F4 correction. E-BUNDLE-015 (`storagePathReady`)
    // is STRUCK from this row: the schema is real, but it belongs to the
    // separate `app-server --prepare-storage` mode, so citing it here is what
    // made a round of prose assert a client half that does not exist. Each line
    // below goes red if the row is put back the way it was.
    const rec = runtime.getCapability('zero_send_startup_handshake');
    const ids = rec.evidence.map((/** @type {any} */ e) => e.id);
    expect(rec.state, 'only a reviewed capture of the real process reaches behavior_verified').toBe('behavior_verified');
    expect(ids, 'E-BUNDLE-015 must no longer justify a client half on this surface').not.toContain('E-BUNDLE-015');
    // E-BUNDLE-014/016 still hold — the union and the phase enum were never the
    // problem — and the observation is what the state now rests on.
    expect(ids).toEqual(expect.arrayContaining(['E-BUNDLE-014', 'E-BUNDLE-016', 'E-PROBE-R3-P4']));
    expect(rec.reason).not.toContain('the client answers startup/storagePathReady with an optional `reuse` boolean');
    // The grade is the UI01 SEND-GATE ladder, not a behaviour ladder: confirming
    // the runtime announces its own storage state establishes no entitlement.
    expect(rec.grade, 'a confirmed runtime behaviour is still E0 — it establishes no entitlement').toBe('E0');
  });

  test('F4: E-PROBE-R3-P4 is an official_process_capture, pinned, and reproducible from the report', () => {
    // The capture is the only thing that can support behaviour_verified, so its
    // own metadata is asserted: which layer it claims to be, that it is pinned to
    // the CLI version the matrix is pinned to, and that it says where the file
    // is. A behaviour row citing an unpinned or self-described source would be
    // unfalsifiable.
    const ref = runtime.OFFICIAL_EVIDENCE.find((/** @type {any} */ e) => e.id === 'E-PROBE-R3-P4');
    expect(ref, 'the capture must exist as a first-class evidence entry').toBeTruthy();
    expect(ref.layer).toBe('official_process_capture');
    expect(ref.pinnedToOfficialVersion).toBe(runtime.OFFICIAL_RUNTIME_EVIDENCE_PIN.cliVersion);
    expect(ref.source).toContain('probe-r3-p4.json');
    expect(ref.license).toBe('unknown_proprietary');
    // The five phases are quoted from the file, in order, and each is a member of
    // the official enum — so the row's claim is checkable line by line.
    for (const phase of ['checking', 'committing', 'ready']) {
      expect(ref.excerpt).toContain(phase);
    }
    expect(ref.excerpt).toContain('kind:"notification"');
    expect(ref.excerpt).toContain('correlatedToRequest:true');
  });
});

/* ================================================================== *
 * Scenario 6 — EOF and malformed frames
 * ================================================================== */

describe('scenario: EOF and malformed frames', () => {
  test('a non-JSON line is a fatal framing fault and readiness never becomes true', async () => {
    await withScenario('eof_bad_frame', async (client) => {
      const frame = await client.nextFrame(4000);
      expect(frame.kind).toBe('error');
      expect(frame.kind === 'error' ? frame.code : null).toBe('MALFORMED_JSON');
      expect(client.ready, 'a malformed stream must never be recorded as ready').toBe(false);
      expect(client.fatal).not.toBe(null);
    });
  });

  test('child death with a waiter pending settles the waiter instead of hanging', async () => {
    await withScenario('eof_bad_frame', async (client) => {
      await client.nextFrame(300);
      const pending = client.nextFrame(60000);
      await client.close();
      const settled = await pending;
      expect(settled.kind, 'a pending wait must terminate on child death').toBe('error');
      expect(client.pendingWaiters).toBe(0);
    });
  });
});

/* ================================================================== *
 * Scenario 7 — size limits
 * ================================================================== */

describe('scenario: oversize frames and buffers', () => {
  test('an oversized metadata blob is refused and never recorded as ready', async () => {
    await withScenario('oversize', async (client) => {
      const frame = await client.nextFrame(6000);
      expect(frame.kind).toBe('error');
      expect(frame.kind === 'error' ? frame.code : null).toBe('METADATA_TOO_LARGE');
      expect(client.ready).toBe(false);
      expect(runtime.DEFAULT_LIMITS.maxMetadataBytes).toBe(64 * 1024);
      expect(runtime.DEFAULT_LIMITS.maxFrameBytes).toBe(2 * 1024 * 1024);
      expect(runtime.DEFAULT_LIMITS.maxBufferBytes).toBe(4 * 1024 * 1024);
    });
  });

  test('a runaway unterminated stream trips the frame bound and never becomes ready', async () => {
    // Under the shipped limits the 2 MiB frame bound is reached before the 4 MiB
    // concatenation bound: a line with no newline grows until IT is too large.
    // The frozen test expected BUFFER_TOO_LARGE here and had therefore never
    // been run — this is the guard that actually protects the process.
    await withScenario('buffer_bomb', async (client) => {
      const frame = await client.nextFrame(8000);
      expect(frame.kind).toBe('error');
      expect(frame.kind === 'error' ? frame.code : null).toBe('FRAME_TOO_LARGE');
      expect(client.ready).toBe(false);
    });
  });

  test('the concatenation-buffer guard is enforced independently of the frame guard', async () => {
    // The buffer bound is only reachable when a single read exceeds it, so it is
    // tested by raising the frame bound above the buffer bound. Both guards must
    // exist and must be checked, not one standing in for the other.
    const client = new runtime.NoSendStdioClient({
      command: process.execPath,
      args: [childPath('buffer_bomb'), '--scenario', 'buffer_bomb', '--counters', countersPath('buffer_bomb')],
      cwd: tmpRoot,
      nonce: runtime.makeNonce(),
      requestTimeoutMs: 4000,
      limits: { maxFrameBytes: 64 * 1024 * 1024, maxBufferBytes: 256 * 1024, maxMetadataBytes: 64 * 1024 }
    });
    client.start();
    try {
      const frame = await client.nextFrame(8000);
      expect(frame.kind).toBe('error');
      expect(frame.kind === 'error' ? frame.code : null).toBe('BUFFER_TOO_LARGE');
      expect(client.ready).toBe(false);
      expect(client.bufferedByteLength).toBeLessThanOrEqual(256 * 1024);
    } finally {
      const closed = await client.close();
      expect(closed.pendingWaiters).toBe(0);
      expect(() => client.assertNoModelDispatch()).not.toThrow();
    }
  });
});

/* ================================================================== *
 * Scenario 8 — reverse (tool) requests
 * ================================================================== */

describe('scenario: reverse tool requests are refused', () => {
  test('the runtime asking for MCP auth headers or a tool call is refused, not served', async () => {
    await withScenario('tool_reverse_request', async (client) => {
      // TAPFIX(F4): the fixed `await new Promise(r => setTimeout(r, 400))` here was a
      // race against the fixture child's node boot and made this test red in roughly
      // 1 run in 5 of `npm run ci`. The driver is the spawn->first-output **tail**, not
      // the median: re-measured p50 is 38 ms idle / 149 ms under 6 CPU hogs, but 2 of
      // 40 spawns still land past 400 ms (see the `waitUntil` docblock for the full
      // table and for the withdrawn "p50 1.2-1.8 s" figure).
      // Wait for the CONDITION instead: both reverse requests refused on the client
      // side AND both answers recorded by the child. Every assertion below is
      // unchanged — it just runs once the state has actually been reached.
      await waitUntil(
        () => {
          if (Number(client.ledger.refusedReverse ?? 0) < 2) return false;
          try {
            return readCounters('tool_reverse_request').reverseResponses.length >= 2;
          } catch {
            return false; // counters file not written yet
          }
        },
        { what: 'both reverse requests refused and answered by the child', timeoutMs: 15_000 }
      );
      const ledger = client.ledger;
      expect(ledger.refusedReverse, 'both reverse requests must be refused').toBeGreaterThanOrEqual(2);
      expect(ledger.servedReverse, 'nothing may be served on the reverse channel by default').toBe(0);
      expect(ledger.modelDispatch).toBe(0);

      // I-4. Refusing a reverse request DOES write a frame — a JSON-RPC -32601
      // error — so "this product writes no frame" was false whenever the runtime
      // asked for anything. The write is now counted in its own counter and is
      // deliberately NOT counted in controlFrames, which means "requests this
      // product originated". Asserting both is what keeps the P2 wording honest.
      expect(ledger.refusalFrames, 'each refusal is a real write and must be counted').toBe(ledger.refusedReverse);
      expect(ledger.controlFrames, 'a refusal is not an originated request').toBe(0);
      expect(ledger.modelDispatchAttempts, 'refusing a reverse request is not a model-dispatch attempt').toBe(0);

      const counters = readCounters('tool_reverse_request');
      expect(counters.outboundReverseRequests).toBe(1);
      expect(counters.reverseResponses.length, 'the child must have received two answers').toBe(2);
      for (const response of counters.reverseResponses) {
        expect(response.isError, 'a refusal must be a JSON-RPC error, never a result').toBe(true);
        expect(response.errorCode).toBe(-32601);
      }
      expect(counters.modelDispatchAttempts).toBe(0);
    });
  });

  test('the auth-header reverse request is on the refused list by design', () => {
    expect(runtime.REFUSED_REVERSE_METHODS.has('interaction/requestOfficialMcpAuthHeaders')).toBe(true);
    expect(runtime.REFUSED_REVERSE_METHODS.has('interaction/requestProviderRuntimeHeaders')).toBe(true);
    expect(runtime.getCapability('mcp_tool_disable_scope').state, 'refusing a header is not the same as disabling an MCP tool').toBe('blocked');
  });

  test('REGRESSION: browserList is a reverse request, never an outbound control method', () => {
    // The pre-review allowlist contained interaction/browserList, which made
    // classifyMethod answer 'control' and would have had the product write a
    // method the official server does not serve.
    expect(runtime.CONTROL_PLANE_METHODS.has('interaction/browserList')).toBe(false);
    expect(runtime.REVERSE_REQUEST_METHODS.has('interaction/browserList')).toBe(true);
    expect(runtime.classifyMethod('interaction/browserList')).toBe('reverse_to_client');
    for (const method of runtime.CONTROL_PLANE_METHODS.keys()) {
      expect(runtime.REVERSE_REQUEST_METHODS.has(method), `${method} is on both the control and reverse lists`).toBe(false);
    }
  });
});

/* ================================================================== *
 * Streaming UTF-8 and the I01 transport fixture
 * ================================================================== */

describe('framing: cross-chunk UTF-8 and reuse of the I01 transport fixture', () => {
  test('a CJK payload split across 7-byte chunks decodes exactly', async () => {
    await withScenario('cjk_split', async (client) => {
      const frame = await client.nextFrame(4000);
      expect(frame.kind).toBe('ok');
      const note = frame.kind === 'ok' ? frame.frame.result.note : null;
      expect(note, 'multi-byte characters must survive arbitrary chunk boundaries').toBe('中文跨块流式UTF-8：零发送探针');
      expect(readCounters('cjk_split').modelDispatchAttempts).toBe(0);
    });
  });

  test('a method the peer does not implement is rejected in-band and does not make the client ready', async () => {
    const client = new runtime.NoSendStdioClient({
      command: process.execPath,
      args: [I01_FAKE_RUNTIME, '--token', 'i02-fixture-token'],
      cwd: PROJECT_ROOT,
      nonce: runtime.makeNonce(),
      requestTimeoutMs: 4000
    });
    client.start();
    try {
      const res = await client.request('runtime/capabilities', {}, 4000);
      expect(res.kind).toBe('ok');
      expect(res.kind === 'ok' && res.frame.ok).toBe(false);
      expect(res.kind === 'ok' && res.frame.error.code).toBe('UNKNOWN_METHOD');
      expect(client.ledger.modelDispatch).toBe(0);
    } finally {
      const closed = await client.close();
      expect(closed.pendingWaiters).toBe(0);
      expect(() => client.assertNoModelDispatch()).not.toThrow();
    }
  });
});

/* ================================================================== *
 * Static invariants of the shipped verdict table
 * ================================================================== */

describe('capability matrix invariants', () => {
  test('no capability claims behaviour verification without a reviewed real run', () => {
    const report = runtime.buildProbeReport(null);
    // I02-F4: was `toBe(0)`. The claim "no row is behaviour-verified" was
    // true only while every row rested on a source. The replacement asserts the
    // rule rather than the count: a behaviour_verified row MUST cite a real
    // process capture, so a fixture can never produce one.
    expect(report.counts.behaviourVerified).toBe(1);
    for (const cap of report.capabilities) {
      if (cap.state !== 'behavior_verified') continue;
      const capture = cap.evidence.filter((/** @type {any} */ e) => e.layer === 'official_process_capture');
      expect(capture.length, `${cap.id} is behaviour-verified without a real-process capture`).toBeGreaterThan(0);
    }
    expect(report.counts.unknown, 'the matrix must keep its unknowns visible').toBeGreaterThan(0);
    expect(report.runtimeReady).toBe(false);
  });

  test('every capability cites at least one official or baseline evidence ref', () => {
    for (const cap of runtime.CAPABILITY_MATRIX) {
      expect(cap.evidence.length, `${cap.id} must cite evidence`).toBeGreaterThan(0);
      for (const ev of cap.evidence) {
        expect(ev.excerpt.length, `${ev.id} must carry a verbatim excerpt`).toBeGreaterThan(0);
        expect(ev.observedAtUtc.endsWith('Z'), `${ev.id} must be time-stamped`).toBe(true);
      }
    }
  });

  test('every control-plane method is a real official server method, or a documented client reply', () => {
    // Snapshot of the official app-server method map `va`, read by static
    // inspection of the shipped bundle and pinned by the evidence table. If the
    // bundle ever changes, this test is the thing that notices.
    const OFFICIAL_SERVER_METHODS = new Set([
      'runtime/capabilities', 'computer-use/operation-event', 'session/create', 'session/resume',
      'session/list', 'session/subagents', 'session/requestRuntimePreferences', 'session/read',
      'session/messages', 'session/events', 'session/debug', 'session/subscribe', 'session/send',
      'session/stop', 'session/cancelBackgroundTask', 'session/fork', 'session/compact',
      'session/goal', 'session/close', 'session/setModel', 'session/setThoughtLevel',
      'session/setMode', 'workspace/readPresentation', 'workspace/hooks/trustGrant',
      'provider/updateAccountConfig', 'workspace/updateInteractionPreferences',
      'workspace/updateModelIoPreferences', 'workspace/updateOffPeakToolPolicy',
      'workspace/updateDynamicWorkflowPolicy', 'workspace/generateText',
      'workspace/cancelGenerateText', 'provider/testModelConnectivity', 'mcp/list',
      'plugins/list', 'plugins/referenceCatalog', 'plugins/referenceCatalogWithCategory',
      'skills/referenceCatalog', 'workflows/list', 'workflows/get', 'workflows/updateMeta',
      'workflows/delete', 'workflows/runs', 'workflows/move', 'plugins/resolveSuggestedReference',
      'plugins/setEnabled', 'plugins/overview', 'plugins/marketplace/add',
      'plugins/marketplace/remove', 'plugins/marketplace/update', 'plugins/install',
      'plugins/cancelOperation', 'plugins/uninstall', 'plugins/update', 'plugins/restoreBuiltin',
      'plugins/configure', 'plugins/resetConfig', 'plugins/validate', 'plugins/describe',
      'automation/create', 'automation/update', 'automation/checkTaskBinding', 'automation/list',
      'automation/delete', 'offPeak/create', 'offPeak/list', 'usage/stats', 'session/usage',
      'process/childProcesses', 'interaction/requestPermission', 'interaction/requestUserInput',
      'interaction/requestProviderRuntimeHeaders', 'interaction/requestOfficialMcpAuthHeaders',
      'interaction/browserList', 'interaction/browserExecute'
    ]);
    // I02-F4: the client-reply set is now EMPTY. `startup/storagePathReady` used
    // to be here as "the one client->server reply"; it is off the allowlist, so
    // there is nothing left to carve out of the server-method check. The reply
    // still exists in the bundle as schema `JUi` (E-BUNDLE-015) and still is not
    // a server method — that is asserted directly below, because "it is absent"
    // is the claim that matters now.
    const CLIENT_REPLY_METHODS = new Set();

    for (const method of runtime.CONTROL_PLANE_METHODS.keys()) {
      expect(
        OFFICIAL_SERVER_METHODS.has(method) || CLIENT_REPLY_METHODS.has(method),
        `${method} is on the write allowlist but is not a real official method`
      ).toBe(true);
    }
    expect(
      OFFICIAL_SERVER_METHODS.has('startup/storagePathReady'),
      'startup/storagePathReady is a CLIENT reply of another mode; it must never be claimed as a server method'
    ).toBe(false);
    // I-5: the fourteen demoted methods are still REAL official methods. They
    // were not invented and they were not deleted — their side-effect profile
    // is simply unproven, and the demotion must not become an excuse to lose the
    // names. If the bundle changes, this test notices in both directions.
    for (const method of runtime.PENDING_READ_ONLY_METHODS.keys()) {
      expect(
        OFFICIAL_SERVER_METHODS.has(method),
        `${method} was demoted for lack of evidence, not because it is fictional — it must still be a real official method`
      ).toBe(true);
    }
  });

  test('I-5/F4: the write allowlist is the ONE method P4 sends, and the removed reply cannot be written at all', () => {
    // This is the exact claim REV4 I-5 asked to be enforced. Before the fix the
    // allowlist held sixteen methods and P4, once implemented, would have been
    // free to send any of them. The size assertion is deliberate: an addition is
    // a visible, reviewable act, not a silent widening.
    expect(
      [...runtime.CONTROL_PLANE_METHODS.keys()].sort(),
      'the allowlist is exactly the one method P4 sends'
    ).toEqual(['runtime/capabilities']);
    expect(runtime.CONTROL_PLANE_METHODS.size, 'startup/storagePathReady was removed in I02-F4').toBe(1);
    for (const reason of runtime.CONTROL_PLANE_METHODS.values()) {
      expect(reason, 'every allowlist entry must cite an official source, not a method-name table').not.toContain('E-BUNDLE-001');
    }
    // The demoted fourteen carry the opposite justification on purpose, and the
    // two sets are disjoint so promoting one is an explicit edit.
    for (const method of runtime.PENDING_READ_ONLY_METHODS.keys()) {
      expect(runtime.CONTROL_PLANE_METHODS.has(method), `${method} is in both sets`).toBe(false);
      expect(runtime.REVERSE_REQUEST_METHODS.has(method), `${method} is on both the allowlist and the reverse list`).toBe(false);
    }

    // I02-F4, the part that has teeth. Deleting the entry is a table edit; what
    // makes the removal real is that the ordinary write gate now refuses the
    // method and COUNTS the attempt, so a future caller that re-adds the reply
    // by reaching for `request()` cannot do it quietly.
    expect(
      runtime.classifyMethod('startup/storagePathReady'),
      'an off-allowlist method must classify as dispatching, not as control'
    ).toBe('potentially_model_dispatching');
    // And the client no longer even ACCEPTS the option that used to arm it.
    // JavaScript will not complain about an unknown option key, so the check
    // that has teeth is structural: the getter is gone from the class, and the
    // one caller in the repository — the CLI's P4 path — names the option
    // nowhere. The compile-time half of the same claim is `tsc`: the field was
    // deleted from `NoSendClientOptions`, not made optional.
    const protoProps = Object.getOwnPropertyNames(runtime.NoSendStdioClient.prototype);
    expect(
      protoProps.includes('startupReply'),
      'the startupReply getter must be gone; there is no reply state left to report'
    ).toBe(false);
    const cliSource = readFileSync(VERIFY_CLI, 'utf8');
    expect(
      cliSource.includes('replyStartupStoragePathReady'),
      'the P4 path must not name the removed option — the only write path is the capabilities readback'
    ).toBe(false);
  });

  test('F4: a request for the removed reply is refused and counted, exactly like any other dispatch', async () => {
    // The behavioural half of the removal. `request()` must reject before
    // encoding a byte, and the attempt must be visible in the ledger — a
    // refusal that leaves no trace is indistinguishable from a method that was
    // never asked about. A dedicated counters file, because `ok` is shared with
    // the scenario tests and this assertion is about what THIS child received.
    const counters = join(tmpRoot, 'counters-refused-reply.json');
    const client = new runtime.NoSendStdioClient({
      command: process.execPath,
      args: [childPath('ok'), '--scenario', 'ok', '--counters', counters],
      cwd: tmpRoot,
      nonce: runtime.makeNonce(),
      requestTimeoutMs: 2000
    });
    client.start();
    await expect(client.request('startup/storagePathReady', {}, 2000)).rejects.toThrow(/storagePathReady/);
    const ledger = client.ledger;
    expect(ledger.modelDispatchAttempts, 'the attempt is counted, so the refusal is an observation').toBe(1);
    expect(ledger.modelDispatch, 'and nothing was written, so the count of real dispatches stays 0').toBe(0);
    expect(ledger.controlFrames, 'a refused method never becomes a control frame').toBe(0);
    await client.close();
    expect(JSON.parse(readFileSync(counters, 'utf8')).inboundLines, 'the child must never have seen the frame').toEqual([]);
  });

  test('I-1/F2-3/F4: the reply thread is CLOSED — the record says removed, and the trigger is documentation', () => {
    // The static facts are unchanged and are still asserted: `startup/storagePathReady`
    // occurs exactly once in the bundle, as the schema definition `JUi`, plus the
    // module export surface. No dispatch entry, no handler, no await. The record
    // is kept whole so the history of a wrong inference survives its correction.
    const decision = runtime.PENDING_REPLY_DECISION;
    expect(decision.method).toBe('startup/storagePathReady');
    expect(decision.dispatchHandlerFound, 'a dispatch handler was found; the conclusion must be revisited').toBe(false);
    expect(decision.awaitedByStartup, 'I02-F2-3 observed the server exit, not the server wait').toBe('unproven');
    expect(decision.observedServerExitWithoutIt).toBe(true);
    expect(decision.actionTaken, 'the action taken must now say removed, not armed')
      .toContain('REMOVED in I02-F4');
    expect(
      runtime.CONTROL_PLANE_METHODS.has(decision.method),
      'the method this record is about must NOT be on the write allowlist any more'
    ).toBe(false);

    // I02-F3-2 reclassified the certainty, from "derived, premise falsified"
    // to "observed inert on this surface". I02-F4 then deleted the write path, so
    // the trigger object is a RECORD ONLY. The original derivation is preserved
    // verbatim in `basis`, so a reader can still see how the trigger was reached
    // and why it was wrong.
    expect(runtime.STARTUP_REPLY_TRIGGER.certainty).toBe('observed-inert-on-the-probed-surface-e-bundle-023-and-026');
    expect(runtime.STARTUP_REPLY_TRIGGER.supersededBy).toContain('E-BUNDLE-023/025/026');
    expect(runtime.STARTUP_REPLY_TRIGGER.phase).toBe('ready');
    expect(runtime.STARTUP_REPLY_TRIGGER.wireShape).toBe('{"method":"startup/storagePathReady"}');
    expect(runtime.STARTUP_REPLY_TRIGGER.basis).toContain('EXP-LIFETIME');
    expect(
      runtime.STARTUP_REPLY_TRIGGER.status,
      'the trigger must declare itself retired, or a future reader may re-arm it'
    ).toBe('retired-in-i02-f4; no code path writes the frame it describes');

    // And the finding that justified the removal must state the removal, so a
    // report printed by a real run explains the absence rather than hiding it.
    const finding = runtime.STARTUP_REPLY_SURFACE_FINDING;
    expect(finding.conclusion).toContain('removed');
    expect(finding.actionTaken).toContain('REMOVED in I02-F4');
    expect(finding.removedAfterP4SucceededWithoutIt, 'the removal waits on the round-3 result; record that it came').toBe(true);
    expect(finding.observedOnTheSurfaceUnderTest).toContain('E-PROBE-R3-P4');
  });

  test('every forbidden method is a real official method that is deliberately never sent', () => {
    for (const method of runtime.FORBIDDEN_METHODS.keys()) {
      expect(runtime.CONTROL_PLANE_METHODS.has(method), `${method} is both forbidden and allowed`).toBe(false);
      expect(runtime.classifyMethod(method), `${method} must classify as dispatching`).toBe('potentially_model_dispatching');
      expect(runtime.FORBIDDEN_METHODS.get(method), `${method} must carry a reason`).toBeTruthy();
    }
  });

  test('naming a mechanism never unblocks a safety-bearing action, and a reviewed capture never unblocks one either', () => {
    // The pre-review blockingCapabilities() dropped a capability from the
    // blocking list as soon as its mechanism was named. It must not.
    for (const cap of runtime.blockingCapabilities()) {
      expect(cap.blocking).toBe(true);
    }
    // The invariant in its general form, and the thing this round must not
    // break: exactly ONE row moved off the blocking list. A `blocked` state
    // always blocks; the count is pinned so a second silent unblock is a red
    // test rather than a reviewer's memory.
    for (const cap of runtime.CAPABILITY_MATRIX) {
      if (cap.state === 'blocked') {
        expect(cap.blocking, `${cap.id} is blocked, so the product must be refusing it`).toBe(true);
      }
    }
    expect(
      runtime.blockingCapabilities().length,
      '15 before I02-F4 (the handshake among them) and 14 now. If this moves again, a second row moved too.'
    ).toBe(14);

    // I02-F4 is the one deliberate move off the blocking list, and it is a move
    // the old text forbade for the wrong reason. The old reason was "nothing has
    // ever been observed". Something HAS now been observed (E-PROBE-R3-P4), and
    // what it shows is that the runtime performs the whole startup announcement
    // on its own — so there is no action left to refuse. The refusal that
    // matters did not go away: the client half is off the allowlist.
    const handshake = runtime.getCapability('zero_send_startup_handshake');
    expect(handshake.state, 'a reviewed capture of the real process is the only thing that can raise this').toBe('behavior_verified');
    expect(handshake.blocking, 'nothing is left to refuse: the server never waits for a client frame').toBe(false);
    expect(
      runtime.blockingCapabilities().map((/** @type {any} */ c) => c.id),
      'the row must have left the blocking list'
    ).not.toContain('zero_send_startup_handshake');
    expect(
      runtime.CONTROL_PLANE_METHODS.has('startup/storagePathReady'),
      'and the structural refusal replaced it: the reply cannot be written'
    ).toBe(false);
  });

  test('a capture can raise an OBSERVATION row; it can never unlock an ACTION row', () => {
    // REV8 §4 narrowed the rule I02-F4 wrote. The narrow form is executable and
    // lives in the module (`behaviourClaimRefusal`), because a rule that only
    // exists in a test name is a rule nobody can fail. Four clauses:
    //   R1 a reviewed real-process capture MAY raise a row — never a fixture.
    //   R2 a row that gates a product action is NEVER unlocked by a capture.
    //      Action capabilities need a product behaviour acceptance.
    //   R3 a capture can never turn `blocked` into `behavior_verified`: a
    //      missing control surface cannot be proven present by observing a run.
    //   R4 a capture shows what one run did and never why, so it can not
    //      support a `mechanism_verified` claim.
    const refuse = (/** @type {any} */ candidate, /** @type {any} */ prior) => runtime.behaviourClaimRefusal(candidate, prior);

    // R1, forward direction, over what actually ships.
    for (const cap of runtime.CAPABILITY_MATRIX) {
      if (cap.state !== 'behavior_verified') continue;
      const captures = cap.evidence.filter((/** @type {any} */ e) => e.layer === 'official_process_capture');
      expect(captures.length, `${cap.id} is behaviour-verified on no real-process capture`).toBeGreaterThan(0);
      expect(cap.grade, `${cap.id} is a behaviour observation, never a consumption proof`).toBe('E0');
      expect(refuse(cap, cap), 'a shipped behaviour row must itself be admissible under the rule it is governed by').toBe(null);
    }

    // The real capture, used to forge an upgrade that nobody has reviewed.
    const capture = runtime.OFFICIAL_EVIDENCE.find((/** @type {any} */ e) => e.id === 'E-PROBE-R3-P4');
    expect(capture, 'the one reviewed capture must exist before it can be used to forge a second one').toBeTruthy();
    expect(capture.layer, 'and it must really be a process capture, or this guard forges nothing').toBe('official_process_capture');

    // R2, forward direction: EVERY blocking row is asked what happens when a
    // capture arrives. Pinned per-row, not by a count, so a next round that
    // unblocks one of these 14 is a red test rather than a reviewer's memory.
    const blockingRows = runtime.blockingCapabilities();
    expect(blockingRows.length, 'the 14 blocking rows are the population this guard protects').toBe(14);
    for (const prior of blockingRows) {
      const forged = { ...prior, state: 'behavior_verified', blocking: false, evidence: [...prior.evidence, capture] };
      expect(
        refuse(forged, prior),
        `R2 VIOLATED: a capture moved ${prior.id} off the blocking list. An action capability needs a product behaviour acceptance, never an observation.`
      ).toMatch(/^R2:/);
    }

    // R3, isolated from R2: same forged shape, but the prior was `blocked` and
    // not gating. The refusal must name R3, so the two clauses are separately
    // real rather than one clause wearing the other's label.
    const blockedPrior = { id: 'forged_blocked', state: 'blocked', blocking: false, grade: 'E0', evidence: [] };
    expect(
      refuse({ ...blockedPrior, state: 'behavior_verified', evidence: [capture] }, blockedPrior),
      'R3: a capture cannot prove a missing control surface is present'
    ).toMatch(/^R3:/);

    // R4.
    const mechPrior = { id: 'forged_mechanism', state: 'unknown', blocking: false, grade: 'E0', evidence: [] };
    expect(
      refuse({ ...mechPrior, state: 'mechanism_verified', evidence: [capture] }, mechPrior),
      'R4: a capture shows what one run did, never why'
    ).toMatch(/^R4:/);

    // R1, the negative half: a fixture can never produce the state.
    const fixture = runtime.OFFICIAL_EVIDENCE.filter((/** @type {any} */ e) => e.layer === 'own_fixture');
    const freePrior = { id: 'forged_fixture', state: 'unknown', blocking: false, grade: 'E0', evidence: [] };
    expect(
      refuse({ ...freePrior, state: 'behavior_verified', evidence: fixture.length ? fixture : [{ layer: 'own_fixture' }] }, freePrior),
      'R1: a fixture is not a run of the official process'
    ).toMatch(/^R1:/);

    // THE CONTROL, without which every refusal above could be a blanket "always
    // refuse" and the whole guard would be vacuous: the identical forged shape,
    // on a row that gated nothing and was not blocked, IS admissible. Only the
    // prior differs, so the predicate discriminates instead of always saying no.
    const innocent = runtime.getCapability('account_config_write_never_used');
    expect(innocent.blocking, 'the control prior must gate no action, or this proves nothing').toBe(false);
    expect(innocent.state).not.toBe('blocked');
    expect(
      refuse({ ...innocent, state: 'behavior_verified', evidence: [...innocent.evidence, capture] }, innocent),
      'the same capture on a non-action, non-blocked row is exactly what R1 permits'
    ).toBe(null);
  });

  test('the tool-disable capabilities are blocked, and plan/deny does not satisfy them', () => {
    for (const id of ['native_tool_disable_scope', 'mcp_tool_disable_scope', 'automation_task_disable_scope']) {
      expect(runtime.getCapability(id).state, `${id} must stay blocked while its control scope is unknown`).toBe('blocked');
    }
    const mode = runtime.getCapability('permission_mode_is_not_tool_disable');
    expect(mode.state).toBe('mechanism_verified');
    expect(mode.grade, 'a confirmed negative is still E0 — it establishes no entitlement').toBe('E0');
  });

  test('account entitlement is never inferred from a config write', () => {
    const rec = runtime.getCapability('account_config_write_never_used');
    expect(rec.state).toBe('mechanism_verified');
    expect(runtime.FORBIDDEN_METHODS.has('provider/updateAccountConfig')).toBe(true);
    expect(runtime.getCapability('account_entitlement_readback').state).toBe('blocked');
  });

  test('redaction removes secret-shaped values and reports names only', () => {
    const out = runtime.redact({ apiKey: 'SECRET', nested: { token: 'SECRET', keep: 'ok' } });
    expect(out.value.apiKey).toBe('[REDACTED]');
    expect(out.value.nested.token).toBe('[REDACTED]');
    expect(out.value.nested.keep).toBe('ok');
    expect(out.redactedKeys).toContain('apiKey');
    expect(JSON.stringify(out.redactedKeys)).not.toContain('SECRET');
  });
});

/* ================================================================== *
 * I-2 — the frame shape summary P3 depends on
 * ================================================================== */

describe('I-2: frame shape summary is machine-evaluable and leaks no value', () => {
  const STORAGE_PATH_FRAME = {
    jsonrpc: '2.0',
    id: 1,
    method: 'startup/storagePath',
    params: { path: 'C:\\Users\\someone\\AppData\\Roaming\\ZCode\\sessions.db' }
  };

  test('the startup/storagePath variant is identified and its path constraint is checkable', () => {
    const shape = runtime.describeFrameShape(STORAGE_PATH_FRAME);
    expect(shape.methodName, 'the method VALUE is what identifies the union variant').toBe('startup/storagePath');
    expect(shape.jsonrpc).toBe('2.0');
    expect(shape.paramsShape.map((/** @type {any} */ f) => f.name)).toEqual(['path']);
    const path = shape.paramsShape[0];
    expect(path.type).toBe('string');
    // E-BUNDLE-014 constrains this to `.min(1).max(32768)`, so the length alone
    // is enough to evaluate the constraint — which is the entire point.
    expect(path.stringLength).toBe(STORAGE_PATH_FRAME.params.path.length);
    expect(path.stringLength).toBeGreaterThanOrEqual(1);
    expect(path.stringLength).toBeLessThanOrEqual(32768);
  });

  test('the startup/storageState variant exposes both official enums and the schemaVersion literal', () => {
    const frame = {
      jsonrpc: '2.0',
      id: 2,
      method: 'startup/storageState',
      params: {
        schemaVersion: 1,
        attemptId: 'ATTEMPT-VALUE-MUST-NOT-LEAK',
        sequence: 3,
        databaseId: 'DATABASE-VALUE-MUST-NOT-LEAK',
        databaseKind: 'tasks-index',
        phase: 'committing',
        elapsedMs: 412
      }
    };
    const shape = runtime.describeFrameShape(frame);
    expect(shape.methodName).toBe('startup/storageState');
    const byName = new Map(shape.paramsShape.map((/** @type {any} */ f) => [f.name, f]));

    expect(byName.get('schemaVersion').matchesOfficialLiteral, 'E-BUNDLE-016 pins this to literal 1').toBe(true);
    expect(byName.get('sequence').type).toBe('number');
    expect(byName.get('elapsedMs').type).toBe('number');
    expect(byName.get('databaseKind').officialEnum).toBe('databaseKind');
    expect(byName.get('databaseKind').isOfficialEnumMember).toBe(true);
    expect(byName.get('phase').officialEnum).toBe('phase');
    expect(byName.get('phase').isOfficialEnumMember).toBe(true);

    // A value outside the official enum must be machine-detectable as such.
    const off = runtime.describeFrameShape({
      method: 'startup/storageState',
      params: { databaseKind: 'SOMETHING-NOT-IN-THE-OFFICIAL-ENUM', phase: 'ready' }
    });
    const offByName = new Map(off.paramsShape.map((/** @type {any} */ f) => [f.name, f]));
    expect(offByName.get('databaseKind').isOfficialEnumMember, 'membership must be a real check, not a constant true').toBe(false);
    expect(offByName.get('phase').isOfficialEnumMember).toBe(true);
  });

  test('NO value ever reaches the output — not a path, an id, or an enum member', () => {
    const frame = {
      jsonrpc: '2.0',
      id: 'A-VERY-IDENTIFIABLE-RPC-ID',
      method: 'startup/storageState',
      params: {
        schemaVersion: 1,
        attemptId: 'ATTEMPT-VALUE-MUST-NOT-LEAK',
        databaseId: 'DATABASE-VALUE-MUST-NOT-LEAK',
        databaseKind: 'tasks-index',
        phase: 'committing'
      },
      result: { note: 'RESULT-VALUE-MUST-NOT-LEAK' }
    };
    const serialised = JSON.stringify(runtime.describeFrameShape(frame));
    for (const forbidden of [
      'ATTEMPT-VALUE-MUST-NOT-LEAK',
      'DATABASE-VALUE-MUST-NOT-LEAK',
      'RESULT-VALUE-MUST-NOT-LEAK',
      'A-VERY-IDENTIFIABLE-RPC-ID'
    ]) {
      expect(serialised.includes(forbidden), `${forbidden} leaked into the shape summary`).toBe(false);
    }
    // The method name IS printed, and that is a deliberate, bounded exception:
    // it is a compile-time constant of the official protocol and naming the
    // union variant is the acceptance criterion.
    expect(serialised).toContain('startup/storageState');
    // The enum MEMBERS are not printed, only membership.
    expect(serialised).not.toContain('"tasks-index"');
    expect(serialised).not.toContain('"committing"');
    // The JSON-RPC id is described, not printed.
    const shape = runtime.describeFrameShape(frame);
    expect(shape.idType).toBe('string');
    expect(shape.idStringLength).toBe('A-VERY-IDENTIFIABLE-RPC-ID'.length);
    expect(shape.hasResult).toBe(true);
    expect(shape.valuesIncluded).toContain('none');
  });

  test('the summary survives a real frame coming off the wire', async () => {
    await withScenario('startup_state', async (client) => {
      const frame = await client.nextFrame(4000);
      expect(frame.kind, 'the official-shaped announcement must arrive').toBe('ok');
      if (frame.kind !== 'ok') return;
      const shape = runtime.describeFrameShape(frame.frame);
      expect(shape.methodName).toBe('startup/storageState');
      const byName = new Map(shape.paramsShape.map((/** @type {any} */ f) => [f.name, f]));
      expect(byName.get('schemaVersion').matchesOfficialLiteral).toBe(true);
      expect(byName.get('databaseKind').isOfficialEnumMember).toBe(true);
      expect(byName.get('phase').isOfficialEnumMember).toBe(true);
      expect(byName.get('attemptId').stringLength).toBeGreaterThan(0);
      expect(JSON.stringify(shape)).not.toContain('LEAK');
    });
  });
});

/* ================================================================== *
 * I-1 — the P4 active readback: the double gate and the one write
 * ================================================================== */

/** @param {string[]} args @returns {Promise<{code:number|null, stdout:string, stderr:string}>} */
function runCli(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [VERIFY_CLI, ...args], {
      cwd: PROJECT_ROOT,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: process.env.PATH ?? '' }
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', () => resolvePromise({ code: null, stdout, stderr }));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe('I-1: the P4 write path is real and doubly acknowledged', () => {
  test('the probe refuses with exit 3 and starts nothing when neither ack is given', async () => {
    // Our own process only. This path returns 3 before the client is even
    // constructed, so no official runtime is started and no frame is composed.
    const r = await runCli(['probe', '--timeout-ms', '5000']);
    expect(r.code).toBe(3);
    expect(r.stdout, 'a refused probe must produce no report at all').toBe('');
    expect(r.stderr).toContain('REFUSED');
  });

  test('the P4 flag alone arms nothing: the first acknowledgement is still required', async () => {
    // This is the whole point of using a second door rather than widening the
    // first one. An operator who has read only the P2/P3 paragraph holds no
    // flag that can write, and holding the write flag is not sufficient either.
    const r = await runCli(['probe', '--p4-active-readback-ack', '--timeout-ms', '5000']);
    expect(r.code).toBe(3);
    expect(r.stdout, 'no report, nothing started').toBe('');
    expect(r.stderr).toContain('REFUSED');
    expect(r.stderr, 'the P4 arming notice must not even be reached').not.toContain('P4 ACTIVE READBACK ARMED');
  });

  test('the active readback writes exactly one frame and correlates the answer', async () => {
    // The transport-level proof that P4 CAN work, against a fixture rather than
    // the official runtime. This is the step REV4 I-1 said did not exist: before
    // the fix, `client.request()` was never called anywhere in the CLI, so the
    // documented "controlFrames == 1" was unreachable.
    await withScenario('ok', async (client) => {
      const expectedId = client.nextRequestId();
      const res = await client.request('runtime/capabilities', {}, 4000);
      expect(res.kind, 'the readback must return a frame').toBe('ok');
      expect(res.kind === 'ok' && res.frame.id, 'P4 reports responseIdMatchedRequest, which needs this').toBe(expectedId);
      expect(res.kind === 'ok' && res.frame.result.independentPlanState, 'E-BUNDLE-003').toBe(true);

      const ledger = client.ledger;
      expect(ledger.controlFrames, 'P4 acceptance is controlFrames == 1').toBe(1);
      expect(ledger.modelDispatch).toBe(0);
      expect(ledger.modelDispatchAttempts, 'P4 sends an allowlisted method, so no attempt is recorded').toBe(0);
    });
  });

  test('a P4 readback that comes back wrong is a failure, not a drift to be explained away', async () => {
    // The reason the old P4 description was dangerous: it promised a result and
    // an acceptance rule, while being unable to produce the frame. Now that it
    // can produce it, the failure path has to be loud.
    await withScenario('version_change', async (client) => {
      const res = await client.request('runtime/capabilities', {}, 4000);
      expect(res.kind === 'ok' && res.frame.result.serverInfo.version).toBe('99.99.99');
      const pinned = runtime.OFFICIAL_RUNTIME_EVIDENCE_PIN.cliVersion;
      expect(res.kind === 'ok' ? res.frame.result.serverInfo.version : null).not.toBe(pinned);
      expect(client.ledger.controlFrames).toBe(1);
      expect(client.ledger.modelDispatch).toBe(0);
    });
  });
});

/* ================================================================== *
 * I02-F3 — the round-3 fixes: official frame shape, revealed diagnostics,
 * and a correlation rule that is not decided by the first error frame
 * ================================================================== */

/**
 * The exact frame the real server rejected, rebuilt from the capture in
 * review-artifacts/929/probe-r2-p4.json plus the F3-2 forensic match. The two
 * literals are the ONLY 15- and 30-character strings in that shape anywhere in
 * the official bundle, which is what makes this a reproduction rather than a
 * guess.
 */
const ROUND2_REJECTION_FRAME = {
  error: {
    code: -32600,
    data: {
      issues: [
        { code: 'unrecognized_keys', keys: ['jsonrpc'], path: [], message: 'Unrecognized key: "jsonrpc"' }
      ]
    },
    message: 'Invalid ZCode Protocol message'
  },
  id: 'invalid-message'
};

describe('F3-2: the outbound frame is the OFFICIAL one, with no jsonrpc member', () => {
  test('a request that passes the official strict message union is answered; one with jsonrpc is not', async () => {
    // RED before the fix: `request()` encoded `{jsonrpc:"2.0",id,method,params}`,
    // the fixture's strict gate rejected it, and the answer carried the
    // 15-character reason literal instead of the request id.
    //
    // This is the closest a fixture gets to the real thing: the gate below is
    // E-BUNDLE-021's four-member rule written out by hand, and the rejection
    // is E-BUNDLE-022's literal pair.
    await withScenario('official_shape_gate', async (client) => {
      const expectedId = client.nextRequestId();
      const res = await client.request('runtime/capabilities', {}, 4000);
      expect(res.kind, 'the official frame must be accepted, not rejected as an invalid message').toBe('ok');
      expect(res.kind === 'ok' && res.frame.id).toBe(expectedId);
      expect(res.kind === 'ok' && res.frame.result).toEqual({ independentPlanState: true });
      expect(res.kind === 'ok' && res.frame.jsonrpc, 'E-BUNDLE-024: a response has no jsonrpc member either').toBeUndefined();
    });
  });

  test('the exact bytes on the wire are {id, method, params} and nothing else', async () => {
    await withScenario('official_shape_gate', async (client) => {
      await client.request('runtime/capabilities', {}, 4000);
      const counters = readCounters('official_shape_gate');
      expect(counters.inboundLines).toHaveLength(1);
      const line = /** @type {string} */ (counters.inboundLines[0]);
      expect(line).toBe('{"id":"c1","method":"runtime/capabilities","params":{}}');
      expect(Object.keys(JSON.parse(line))).toEqual(['id', 'method', 'params']);
      expect(line, 'a jsonrpc member is a strict-schema violation per E-BUNDLE-021').not.toContain('jsonrpc');
      expect(runtime.OFFICIAL_REQUEST_FRAME_MEMBERS).toEqual(['id', 'method', 'params', 'trace']);
    });
  });

  test('the official method map contains no initialize, so no first frame is required', () => {
    // E-BUNDLE-027 is the negative evidence for the coordinator's question. The
    // excerpt is the COMPLETE contiguous map, and none of these substrings is a
    // method name in it.
    const excerpt = runtime.OFFICIAL_EVIDENCE.find((/** @type {any} */ e) => e.id === 'E-BUNDLE-027').excerpt;
    expect(excerpt.length).toBeGreaterThan(3000);
    for (const forbidden of ['"initialize"', 'protocol/version', '"initialized"', 'protocolVersion:']) {
      expect(excerpt, `${forbidden} must not exist in the official server method map`).not.toContain(forbidden);
    }
    expect(excerpt).toContain('runtimeCapabilities:"runtime/capabilities"');
    expect(excerpt).toContain('sessionSend:"session/send"');
  });

  test('the startup reply is documented as inert on this surface, and then REMOVED', () => {
    const f = runtime.STARTUP_REPLY_SURFACE_FINDING;
    expect(f.surfaceUnderTest).toBe('zcode app-server (no --prepare-storage)');
    expect(f.handshakeBelongsTo).toContain('--prepare-storage');
    expect(f.officialServerBehaviourForANotification).toContain('ignored by design');
    expect(f.conclusion).toContain('neither cause nor cure');
    // I02-F4: "inert" stopped being the end of the sentence. The finding that
    // proved the frame does nothing is the finding that deleted it, so the
    // record now has to say so — otherwise a reader of an old report and a
    // reader of a new one would draw opposite conclusions from one file.
    expect(f.actionTaken).toContain('REMOVED in I02-F4');
    expect(f.removedAfterP4SucceededWithoutIt).toBe(true);
    // The trigger's own certainty is unchanged: it was never a real trigger.
    expect(runtime.STARTUP_REPLY_TRIGGER.certainty).toBe('observed-inert-on-the-probed-surface-e-bundle-023-and-026');
    expect(runtime.STARTUP_REPLY_TRIGGER.certainty).not.toBe('derived-not-observed-premise-falsified');
  });
});

describe('F3-1: protocol diagnostics are revealed on the P4 path, and only there', () => {
  test('RED->GREEN: the error code, message, id and zod issues are readable, and no params value is', () => {
    // RED before the fix: `describeFrameShape` had no `errorValues` at all, so a
    // run could report "unproven correlation" and nothing else.
    const shape = runtime.describeFrameShape(/** @type {any} */ (ROUND2_REJECTION_FRAME), { exposeProtocolDiagnostics: true });
    const ev = shape.errorValues;
    expect(ev, 'F3-1 requires the error values to be exposed').not.toBeNull();
    expect(ev.code).toBe(-32600);
    expect(ev.message).toBe('Invalid ZCode Protocol message');
    expect(ev.idValue).toBe('invalid-message');
    expect(ev.idType).toBe('string');
    expect(ev.issues).toEqual([
      { path: '', code: 'unrecognized_keys', message: 'Unrecognized key: "jsonrpc"', keys: ['jsonrpc'], branches: [] }
    ]);
    expect(ev.redactionApplied).toBe('module-redact()+cli-redact()');
    // The verdict the coordinator actually needed, machine-checkable.
    expect(/** @type {string} */ (ev.idValue).length).toBe(15);
    expect(/** @type {string} */ (ev.message).length).toBe(30);
    expect(shape.valuesIncluded).toContain('protocol diagnostics only');
  });

  test('RED->GREEN: a real union rejection names the offending key in its branch issues', () => {
    // I02-F3-2, from the observed control run against the real app-server. The
    // official `qHt` union has FOUR branches, so zod reports ONE `invalid_union`
    // issue whose own message is the contentless "Invalid input"; the key that
    // was actually rejected appears only in `errors[0][0].keys`. A diagnostic
    // that stopped at the top level would have said "Invalid input" and taught
    // nobody anything — which is the exact failure mode F3-1 exists to remove.
    const realUnionRejection = {
      error: {
        code: -32600,
        data: {
          issues: [{
            code: 'invalid_union',
            errors: [
              [{ code: 'unrecognized_keys', keys: ['jsonrpc'], path: [], message: 'Unrecognized key: "jsonrpc"' }],
              [{ code: 'unrecognized_keys', keys: ['jsonrpc', 'id'], path: [], message: 'Unrecognized keys: "jsonrpc", "id"' }]
            ],
            path: [],
            message: 'Invalid input'
          }]
        },
        message: 'Invalid ZCode Protocol message'
      },
      id: 'invalid-message'
    };
    const ev = runtime.describeFrameShape(/** @type {any} */ (realUnionRejection), { exposeProtocolDiagnostics: true }).errorValues;
    expect(ev.issues[0].code).toBe('invalid_union');
    expect(ev.issues[0].message).toBe('Invalid input');
    expect(ev.nestedBranchIssuesFound).toBe(2);
    expect(ev.nestedBranchIssuesPublished).toBe(2);
    expect(ev.issues[0].branches[0].keys, 'this is the sentence that names the defect').toEqual(['jsonrpc']);
    expect(ev.issues[0].branches[0].message).toBe('Unrecognized key: "jsonrpc"');
  });

  test('the SAME frame yields no values at all when the flag is absent', () => {
    // The gate is the whole safety property. P2, P3 and every other caller must
    // keep getting the value-free summary.
    for (const opts of [undefined, {}, { exposeProtocolDiagnostics: false }]) {
      const shape = runtime.describeFrameShape(/** @type {any} */ (ROUND2_REJECTION_FRAME), /** @type {any} */ (opts));
      expect(shape.errorValues, `options=${JSON.stringify(opts)} must not reveal anything`).toBeNull();
      expect(shape.valuesIncluded).toBe('none — field names, types, lengths and enum membership only');
      expect(JSON.stringify(shape)).not.toContain('Invalid ZCode Protocol message');
      expect(JSON.stringify(shape)).not.toContain('invalid-message');
      expect(JSON.stringify(shape)).not.toContain('unrecognized_keys');
    }
  });

  test('a params value can never ride out through the diagnostics, even with a hostile error', () => {
    const hostile = {
      id: 'c1',
      method: 'runtime/capabilities',
      params: { token: 'SUPER-SECRET-VALUE', path: 'C:/Users/someone/private' },
      error: {
        code: -32602,
        data: {
          apiKey: 'ERROR-DATA-KEY-SECRET',
          issues: [{ code: 'custom', path: ['apiKey'], message: 'bad key' }]
        },
        message: 'Invalid params — apiKey: bad key'
      }
    };
    const shape = runtime.describeFrameShape(/** @type {any} */ (hostile), { exposeProtocolDiagnostics: true });
    const serialised = JSON.stringify(shape);
    // Not one of these may appear, and none of them can: the diagnostics block
    // is built from error.code / error.message / error.data.issues[] and the id
    // only. `params` is never read by buildErrorDiagnosticValues at all.
    expect(serialised).not.toContain('SUPER-SECRET-VALUE');
    expect(serialised).not.toContain('C:/Users/someone/private');
    expect(serialised).not.toContain('ERROR-DATA-KEY-SECRET');
    // A zod PATH is a schema key path, which the ruling permits; a data member
    // outside `issues` is reported as a fact, never as a value.
    const ev = /** @type {any} */ (shape.errorValues);
    expect(ev.issues[0].path).toBe('apiKey');
    expect(ev.issues[0].code).toBe('custom');
    expect(ev.issues[0].branches).toEqual([]);
    expect(ev.message).toBe('Invalid params — apiKey: bad key');
    expect(ev.dataHadOtherMembers, 'the presence of another data member is stated; its value never is').toBe(true);
    expect(ev.redactionApplied).toBe('module-redact()+cli-redact()');
  });
});

describe('F3-3: the first error frame is not the verdict', () => {
  test('RED->GREEN: a rejection arriving first does not end the wait, and the real answer is found', async () => {
    // RED before the fix: `#consumeLine` handed the FIRST frame of any shape to
    // the first waiter, so this returned the `id:"invalid-message"` frame and
    // the report could only say "the correlation is unproven".
    await withScenario('reject_then_answer', async (client) => {
      const expectedId = client.nextRequestId();
      const res = await client.request('runtime/capabilities', {}, 4000);
      expect(res.kind, 'the wait must survive the rejection frame and find the real answer').toBe('ok');
      expect(res.kind === 'ok' && res.frame.id, 'the answer must be the frame carrying OUR id').toBe(expectedId);
      expect(res.kind === 'ok' && res.frame.result).toEqual({ independentPlanState: true });
    });
  });

  test('every inbound frame is recorded in arrival order, classified, with its correlation verdict', async () => {
    await withScenario('reject_then_answer', async (client) => {
      await client.request('runtime/capabilities', {}, 4000);
      const log = client.frameLog;
      expect(log.length, 'both frames must be in the log, in order').toBe(2);
      expect(log.map((/** @type {any} */ r) => r.index)).toEqual([1, 2]);

      expect(log[0].kind, 'id + error is an error response per the official guard JHo').toBe('error_response');
      expect(log[0].idStringLength).toBe(15);
      expect(log[0].correlatedToRequest, 'its id is not ours, so it correlated to nothing').toBe(false);
      expect(log[0].evaluatedAgainstMethod).toBe('runtime/capabilities');

      expect(log[1].kind, 'id + result is a success response per the official guard GHo').toBe('response');
      expect(log[1].correlatedToRequest, 'this is the frame that answered the request').toBe(true);
      expect(log[1].evaluatedAgainstMethod).toBe('runtime/capabilities');
    });
  });

  test('a frame that is not a response at all never satisfies a request waiter', async () => {
    // The passive nextFrame() waiter keeps its old "any frame" behaviour, and
    // the asymmetry is deliberate and asserted: observing is permissive,
    // correlating is not. The child here emits one startup NOTIFICATION and
    // then answers nothing, so a client that ended its wait on the first frame
    // would report a startup announcement as the capabilities readback.
    await withScenario('notification_only', async (client) => {
      const res = await client.request('runtime/capabilities', {}, 900);
      expect(res.kind, 'a notification must not be mistaken for an answer').toBe('error');
      expect(res.kind === 'error' && res.code).toBe('TIMEOUT');
      const log = client.frameLog;
      expect(log).toHaveLength(1);
      expect(log[0].kind, 'method with no id is a notification per the official guard HHo').toBe('notification');
      expect(log[0].correlatedToRequest).toBe(false);
      expect(log[0].methodName).toBe('startup/storageState');

      // And the passive path still takes it, which is what makes the two
      // behaviours distinguishable rather than one of them broken.
      const observed = await client.nextFrame(400);
      expect(observed.kind).toBe('ok');
      expect(observed.kind === 'ok' && observed.frame.method).toBe('startup/storageState');
    });
  });

  test('classifyInboundFrame implements the four official guards verbatim', () => {
    expect(runtime.classifyInboundFrame({ id: 'c1', result: {} })).toBe('response');
    expect(runtime.classifyInboundFrame({ id: 'invalid-message', error: {} })).toBe('error_response');
    expect(runtime.classifyInboundFrame({ method: 'startup/storageState', params: {} })).toBe('notification');
    expect(runtime.classifyInboundFrame({ method: 'interaction/requestPermission', id: 9001, params: {} })).toBe('request');
    expect(runtime.classifyInboundFrame({})).toBe('unrecognised');
  });
});

/* ================================================================== *
 * m-4 — cross-chunk UTF-8 in the discovery capture path
 * ================================================================== */

describe('m-4: discovery capture reassembles bytes before decoding', () => {
  test('a CJK payload split across 3-byte reads round-trips exactly', async () => {
    const child = join(tmpRoot, 'cjk-capture.mjs');
    writeFileSync(child, CJK_CAPTURE_SOURCE, 'utf8');
    const expected = '帮助与用法：--surface 桌面或终端 --mode 构建 编辑 计划 放行 · αβγ δεζ';

    const result = await discovery.runBoundedReadOnlyCommand({
      executable: process.execPath,
      args: [child],
      cwd: tmpRoot,
      timeoutMs: 15000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout, 'every multi-byte character must survive the chunk boundaries').toBe(expected);
    // The defect this fixes replaced a character with U+FFFD, which both
    // corrupted the text AND desynchronised the character count from the byte
    // count. Both are asserted.
    expect(result.stdout).not.toContain('�');
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(Buffer.byteLength(expected, 'utf8'));
  });
});

/* ================================================================== *
 * I02-F2-1 — the child environment allowlist must be measured, not guessed
 * ================================================================== */

describe('F2-1: the forwarded environment is exactly the measured minimum plus the two provider paths', () => {
  /** @param {Record<string, string>} over */
  function syntheticEnv(over = {}) {
    /** @type {Record<string, string>} */
    const base = {
      SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
      PATH: 'C:\\Windows\\system32', PATHEXT: '.COM;.EXE', TEMP: 'C:\\Tmp', TMP: 'C:\\Tmp',
      USERPROFILE: 'C:\\Users\\d', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\d',
      APPDATA: 'C:\\Users\\d\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\d\\AppData\\Local',
      ProgramData: 'C:\\ProgramData', SystemDrive: 'C:', ProgramFiles: 'C:\\Program Files',
      OS: 'Windows_NT', NUMBER_OF_PROCESSORS: '8', PROCESSOR_ARCHITECTURE: 'AMD64', LANG: 'en_US.UTF-8',
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'C:\\Users\\d\\.zcode\\v2\\runtime\\provider\\x\\zcode-builtin.json',
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: 'C:\\Users\\d\\.zcode\\v2\\provider_config.json',
      // Present in a real ambient environment and must stay out.
      ALLUSERSPROFILE: 'C:\\ProgramData', USERNAME: 'd', NODE_OPTIONS: '--require=x',
      GITHUB_TOKEN: 'ghp_NOT_FORWARDED', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_SECRET: 'no'
    };
    return { ...base, ...over };
  }

  test('the official app-server launch keys are forwarded, and nothing else new is', () => {
    const { report } = discovery.sanitizeEnv(/** @type {any} */ (syntheticEnv()));
    expect(
      report.forwarded,
      'EXP-ENV-V1 vs EXP-ENV-V2: without the provider-config pair the official CLI exits with '
      + '"无法定位 CLI ZCode Built-in Provider Config" and emits zero frames'
    ).toEqual([
      'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LOCALAPPDATA',
      'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
      'ProgramData', 'ProgramFiles', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP',
      'USERPROFILE', 'WINDIR',
      'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'
    ]);
    expect(report.forwarded).toHaveLength(21);
  });

  test('the measurement said the PAIR is the minimum, and the code matches the measurement', () => {
    // EXP-ENV-V5 forwarded exactly these two names — no PATH, no SystemRoot, no
    // APPDATA — and the runtime started. EXP-ENV-V6/V7/V8/V9 each added one other
    // candidate to the original nineteen and every one still produced zero frames.
    // So neither ALLUSERSPROFILE nor USERNAME nor ZCODE_WINDOWS_APP_INSTALL_DIR
    // nor ZCODE_APP_VERSION/ZCODE_BASE_URL may be smuggled in on a hunch.
    const { report } = discovery.sanitizeEnv(/** @type {any} */ (syntheticEnv()));
    for (const rejected of ['ALLUSERSPROFILE', 'USERNAME', 'ZCODE_WINDOWS_APP_INSTALL_DIR', 'ZCODE_APP_VERSION', 'ZCODE_BASE_URL']) {
      expect(report.forwarded, `${rejected} was measured to be unnecessary`).not.toContain(rejected);
    }
  });

  test('F2-1 RED LINE: credential-shaped names are still hard-refused, and the deny list still fires', () => {
    const { env, report } = discovery.sanitizeEnv(/** @type {any} */ (syntheticEnv()));
    expect(Object.keys(env), 'a credential-shaped ambient variable must never reach the child')
      .not.toContain('GITHUB_TOKEN');
    expect(report.withheldNames).toContain('GITHUB_TOKEN');
    expect(report.denied).toContain('NODE_OPTIONS');
    expect(env.NODE_OPTIONS, 'a hard-denied injection carrier must not survive either').toBeUndefined();
    // And the new keys are PATHS, which is why they are not credential-shaped.
    // If someone ever renamed one to something matching the pattern, the hard
    // refuse has to win over the allowlist — this asserts the two are independent.
    const renamed = discovery.sanitizeEnv(/** @type {any} */ (syntheticEnv({
      ZCODE_BUILTIN_PROVIDER_API_KEY: 'should-never-be-forwarded'
    })));
    expect(Object.keys(renamed.env)).not.toContain('ZCODE_BUILTIN_PROVIDER_API_KEY');
    expect(renamed.report.withheldNames).toContain('ZCODE_BUILTIN_PROVIDER_API_KEY');
  });
});

/* ================================================================== *
 * I02-F2-2 — the child's stderr is captured, so a death has a reason
 * ================================================================== */

/**
 * FIXTURE-ONLY child that writes a CJK reason to stderr and dies, reproducing
 * exactly what the official CLI did in probe-r1-diagnosis.json variant D.
 */
const STDERR_CHILD_SOURCE = String.raw`
process.stderr.write('无法定位 CLI ZCode Built-in Provider Config：C:\\ZCode\\resources\\glm\\provider\\zcode-builtin.json\n');
process.stdout.write('{ not json at all\n');
setTimeout(() => { process.exit(1); }, 30);
`;

/** The exact stderr the fixture above writes, and therefore the expected capture. */
const EXPECTED_STDERR = '无法定位 CLI ZCode Built-in Provider Config：C:\\ZCode\\resources\\glm\\provider\\zcode-builtin.json\n';

describe('F2-2: a child death carries its own stderr text into the observation', () => {
  test('stderr is captured verbatim, as bytes, and a CJK reason survives the round trip', async () => {
    const stderrChild = join(tmpRoot, 'stderr-child.mjs');
    writeFileSync(stderrChild, STDERR_CHILD_SOURCE, 'utf8');
    const client = new runtime.NoSendStdioClient({
      command: process.execPath,
      args: [stderrChild],
      cwd: tmpRoot,
      nonce: runtime.makeNonce(),
      requestTimeoutMs: 4000
    });
    client.start();
    const frame = await client.nextFrame(4000);
    expect(frame.kind, 'the fixture writes a non-JSON line, so the stream must fault').toBe('error');
    await client.close();
    // The child's last words arrive on the same tick as its exit; give the pipe
    // a bounded moment so the assertion is about the code, not about scheduling.
    await new Promise((r) => setTimeout(r, 60));

    // RED LINE: before the fix there was no `childStderr` at all, and this is
    // where "EOF_WITH_PENDING" left an operator with no cause.
    const capture = client.childStderr;
    expect(capture, 'the reason the child died must be readable').toBeTruthy();
    expect(capture.text, 'the CJK reason must round-trip exactly, not as U+FFFD').toBe(EXPECTED_STDERR);
    expect(capture.text).not.toContain('�');
    expect(capture.bytes, 'bytes and characters are different things, and the count must be the byte count')
      .toBe(Buffer.byteLength(EXPECTED_STDERR, 'utf8'));
    expect(capture.truncated).toBe(false);
    expect(capture.capBytes).toBeGreaterThan(0);
    expect(() => client.assertNoModelDispatch()).not.toThrow();
  });

  test('the capture is bounded, and a child that floods stderr is marked truncated rather than exhausting memory', async () => {
    const flood = join(tmpRoot, 'stderr-flood.mjs');
    writeFileSync(flood, 'process.stderr.write("x".repeat(400000));setTimeout(()=>process.exit(1),20);\n', 'utf8');
    const client = new runtime.NoSendStdioClient({
      command: process.execPath,
      args: [flood],
      cwd: tmpRoot,
      nonce: runtime.makeNonce(),
      requestTimeoutMs: 4000
    });
    client.start();
    await client.nextFrame(500);
    await client.close();
    await new Promise((r) => setTimeout(r, 60));
    const capture = client.childStderr;
    expect(capture.truncated, 'an unbounded capture is a memory hazard, not evidence').toBe(true);
    expect(capture.text.length).toBeLessThanOrEqual(capture.capBytes);
    expect(capture.bytes, 'the true byte count is still reported even when the text is cut').toBeGreaterThan(capture.capBytes);
  });
});

/* ================================================================== *
 * I02-F2-3 — the startup handshake reply
 * ================================================================== */

describe('F2-3/F4: the startup sequence is OBSERVED, and the reply is gone for good', () => {
  /**
   * @param {string} scenario
   * @returns {Promise<{client: any, seen: any[], closed: any, counters: any}>}
   */
  async function runStartupSequence(scenario) {
    const client = new runtime.NoSendStdioClient({
      command: process.execPath,
      args: [childPath(scenario), '--scenario', scenario, '--counters', countersPath(scenario)],
      cwd: tmpRoot,
      nonce: runtime.makeNonce(),
      requestTimeoutMs: 4000
    });
    client.start();
    /** @type {any[]} */
    const seen = [];
    for (let i = 0; i < 5; i++) {
      const f = await client.nextFrame(4000);
      if (f.kind !== 'ok') break;
      seen.push(f.frame);
    }
    const closed = await client.close();
    return { client, seen, closed, counters: readCounters(scenario) };
  }

  test('the whole observed phase sequence is recorded, and it is the evidence E-PROBE-R3-P4 rests on', async () => {
    // This is the half of I02-F2-3 that survived its own conclusion. What used
    // to be "the sequence the trigger was derived from" is now simply what the
    // zero-send claim is made of: the runtime announces all five frames by
    // itself, and this product writes nothing to make that happen.
    const { client, seen, closed, counters } = await runStartupSequence('startup_sequence');
    expect(seen.map((f) => f.params.sequence), 'all five frames must survive one chunk').toEqual([1, 2, 3, 4, 5]);
    const summary = client.startupFrames;
    expect(summary.map((/** @type {any} */ s) => s.phase)).toEqual(['checking', 'checking', 'checking', 'committing', 'ready']);
    expect(summary.every((/** @type {any} */ s) => s.phaseIsOfficialEnumMember), 'every phase must be a real E-BUNDLE-016 member').toBe(true);
    expect(summary.map((/** @type {any} */ s) => s.methodName)).toEqual(Array(5).fill('startup/storageState'));
    // I02-F4: the sequence is observed and NOTHING is written. This is the whole
    // zero-send property, asserted on the bytes the child actually received.
    expect(counters.inboundLines, 'observing the sequence must cost zero frames').toEqual([]);
    expect(client.ledger.controlFrames).toBe(0);
    // I-2 must not have regressed: the sequence summary carries protocol
    // constants only, never the attemptId or databaseId values.
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain('MUST-NOT-LEAK');
    expect(closed.stage).not.toBe('sigkill');
  });

  test('F4: the "ready" frame no longer triggers any write — there is no write to trigger', async () => {
    // The old test here asserted `reply.sent === true` and the exact bytes
    // `{"method":"startup/storagePathReady"}`. The frame still arrives; the
    // frame is no longer written. Both halves are asserted, because "we stopped
    // writing it" and "we never had a reason to" are different claims and only
    // the first is a change.
    const { client, counters } = await runStartupSequence('startup_sequence');
    expect(
      client.startupFrames.some((/** @type {any} */ s) => s.phase === 'ready'),
      'the terminal success frame is still observed'
    ).toBe(true);
    expect(
      Object.getOwnPropertyNames(runtime.NoSendStdioClient.prototype).includes('startupReply'),
      'the record that reported the send must be gone, not merely empty'
    ).toBe(false);
    expect(counters.inboundLines, 'the trigger frame arrives and produces no bytes at all').toEqual([]);
    expect(client.ledger.controlFrames, 'a control frame is something this product wrote; nothing was written').toBe(0);
    expect(client.ledger.modelDispatch).toBe(0);
  });

  test('F4: a "committing" frame is no longer a special case, because nothing is sent on any phase', async () => {
    // The `startup_state` scenario emits ONE storageState frame with phase
    // "committing" and then goes quiet. It used to be the negative control for
    // the derived trigger. It stays here, with its meaning changed: no phase
    // produces a write, terminal or not.
    const client = new runtime.NoSendStdioClient({
      command: process.execPath,
      args: [childPath('startup_state'), '--scenario', 'startup_state', '--counters', countersPath('startup_state')],
      cwd: tmpRoot,
      nonce: runtime.makeNonce(),
      requestTimeoutMs: 1000
    });
    client.start();
    const frame = await client.nextFrame(4000);
    expect(frame.kind).toBe('ok');
    await client.close();
    expect(client.startupFrames.map((/** @type {any} */ s) => s.phase)).toEqual(['committing']);
    expect(readCounters('startup_state').inboundLines).toEqual([]);
    expect(client.ledger.controlFrames).toBe(0);
  });
});

/* ================================================================== *
 * I02-F2-4 — one JSON document, end to end, through the real CLI
 * ================================================================== */

/**
 * FIXTURE-ONLY stand-in for the official app-server, used ONLY so the CLI's own
 * P4 code path can be exercised without starting the official runtime. It
 * reproduces the captured phase sequence and answers `runtime/capabilities`,
 * and it records every line it receives next to itself so the test can read back
 * exactly what the CLI wrote. It implements no official behaviour.
 */
const FAKE_APP_SERVER_SOURCE = String.raw`
import { appendFileSync, writeFileSync } from 'node:fs';
const trace = process.argv[1] + '.trace.jsonl';
writeFileSync(trace, '');
const PHASES = ['checking', 'checking', 'checking', 'committing', 'ready'];
const frames = PHASES.map((phase, i) => JSON.stringify({
  method: 'startup/storageState',
  params: {
    schemaVersion: 1,
    attemptId: 'FIXTURE-ATTEMPT-ID',
    sequence: i + 1,
    databaseId: 'FIXTURE-DATABASE-ID',
    databaseKind: 'session',
    phase,
    elapsedMs: i + 1
  }
}));
process.stdout.write(frames.join('\n') + '\n');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim() === '') continue;
    appendFileSync(trace, line + '\n', 'utf8');
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'runtime/capabilities') {
      // I02-F3-2: the OFFICIAL response shape (E-BUNDLE-024) — {id, result},
      // no jsonrpc member. Mirroring the real server matters here: the test
      // below asserts the client's correlation against a response that looks
      // like the one it will actually get.
      process.stdout.write(JSON.stringify({ id: msg.id, result: { independentPlanState: true } }) + '\n');
    }
  }
});
process.stdin.on('end', () => { process.exitCode = 0; });
`;

describe('F2-4: the P4 run emits exactly one parseable JSON document', () => {
  test('a doubly-acknowledged P4 run is one JSON object, one frame, the stderr capture and the sequence', async () => {
    // The CLI is pointed at a FIXTURE with --cli, so the official runtime is not
    // started. Both acknowledgements are passed because that is the path under
    // test; the gate itself is asserted separately, and still returns 3.
    const fake = join(tmpRoot, `fake-app-server-${runtime.makeNonce().slice(0, 8)}.mjs`);
    writeFileSync(fake, FAKE_APP_SERVER_SOURCE, 'utf8');

    const r = await runCli([
      'probe', '--i02-real-probe-ack', '--p4-active-readback-ack',
      '--cli', fake, '--timeout-ms', '4000'
    ]);

    // RED LINE: before the fix this stdout was TWO concatenated documents and
    // this parse throws. A report that cannot be parsed is not a report.
    expect(r.code, `stderr was:\n${r.stderr}`).toBe(0);
    /** @type {any} */
    let parsed = null;
    expect(() => { parsed = JSON.parse(r.stdout); }, 'stdout must be a single JSON document').not.toThrow();
    expect(parsed, 'the single document must have parsed into an object').toBeTruthy();

    expect(parsed.p4.method).toBe('runtime/capabilities');
    expect(parsed.p4.result, 'E-BUNDLE-003, read back verbatim').toEqual({ independentPlanState: true });
    expect(parsed.p4.responseIdMatchedRequest).toBe(true);
    // I02-F4. The readback is the ONLY frame this product originates, and the
    // fixture's own byte trace below is the proof — not the count.
    expect(parsed.p4.controlFrames, 'the readback and nothing else').toBe(1);
    expect('handshakeReplyFrames' in parsed.p4, 'the derived field is gone with the frame it counted').toBe(false);
    expect(parsed.p4.startupFramesObserved, 'the startup announcement is still observed, just not written to').toBe(5);
    expect(parsed.p4.modelDispatch, 'a readback is not a dispatch').toBe(0);
    expect(parsed.p4.modelDispatchAttempts).toBe(0);

    // F2-2 landed in the same document.
    expect(parsed.observation.childStderr).toBeTruthy();
    expect(parsed.observation.childStderr.empty, 'this fixture says nothing on stderr, and that is reported as empty, not as missing')
      .toBe(true);
    expect(parsed.observation.childStderr.truncated).toBe(false);
    expect(parsed.observation.childStderr.capBytes).toBeGreaterThan(0);
    expect(parsed.observation.childReclaim.stage).toBeTruthy();

    // I02-F4 landed in the same document: no reply record, and the finding that
    // explains the absence instead of leaving a hole in the report.
    expect('startupReply' in parsed.observation, 'the reply record is gone; the report must not still describe one').toBe(false);
    expect(parsed.observation.startupReplySurfaceFinding.actionTaken).toContain('REMOVED in I02-F4');
    expect(parsed.observation.startupSequence.map((/** @type {any} */ s) => s.phase))
      .toEqual(['checking', 'checking', 'checking', 'committing', 'ready']);

    // The fixture independently confirms the byte stream, in order.
    const trace = readFileSync(`${fake}.trace.jsonl`, 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(trace, 'ONE frame, and the `jsonrpc` member is not on it: the official request schema qir is .strict() and declares no such slot (E-BUNDLE-021/022)').toEqual([
      // c2, not c1: the passive observation already satisfied one waiter, and
      // every satisfied waiter advances the dispatch ordinal the id is derived
      // from. The old expectation was also c2 — it just also expected a reply
      // frame in front of it.
      '{"id":"c2","method":"runtime/capabilities","params":{}}'
    ]);
    // And the pre-send notice really is on stderr, before anything else claims success.
    expect(r.stderr).toContain('about to send ONE request frame');
    expect(r.stderr, 'the removed reply must not be announced any more').not.toContain('startup handshake reply');
  });

  test('the single-ack path is still a pure observation: one JSON document, no reply, zero writes', async () => {
    const fake = join(tmpRoot, `fake-app-server-passive-${runtime.makeNonce().slice(0, 8)}.mjs`);
    writeFileSync(fake, FAKE_APP_SERVER_SOURCE, 'utf8');
    const r = await runCli(['probe', '--i02-real-probe-ack', '--cli', fake, '--timeout-ms', '4000']);
    expect(r.code, `stderr was:\n${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect('startupReply' in parsed.observation, 'one flag cannot arm what no flag can arm').toBe(false);
    expect(parsed.ledger.controlFrames, 'a passive P2/P3 run composes no request of its own').toBe(0);
    expect(readFileSync(`${fake}.trace.jsonl`, 'utf8').trim(), 'nothing may have been written').toBe('');
  });
});

/* ================================================================== *
 * m-5 — anyLayerBlocked is not a constant
 * ================================================================== */

describe('m-5: anyLayerBlocked reports real unverified layers, not the by-design one', () => {
  /** @param {Record<string, unknown>} opts */
  async function discoverWith(opts) {
    const root = join(tmpRoot, 'install');
    return discovery.discoverRuntime({ installRoot: root, hash: 'none', ...opts });
  }

  test('live_host is unknown_by_design and is never counted as blocked', async () => {
    // The pre-review expression was
    //   layers.some((l) => l.identityConfidence === 'shim_suspected' || l.observation !== 'observed')
    // which counts live_host, whose observation is unknown_by_design and always
    // will be. The flag was therefore always true and the CLI printed a failure
    // notice on runs where every acceptance criterion had passed.
    const root = join(tmpRoot, 'install-empty');
    const report = await discovery.discoverRuntime({ installRoot: root, hash: 'none' });
    const live = report.layers.find((/** @type {any} */ l) => l.layer === 'live_host');
    expect(live.observation).toBe('unknown_by_design');

    // The exact old predicate, shown to still be true on that layer...
    expect(live.observation !== 'observed', 'the old expression really did count this layer').toBe(true);
    // ...and the new output to exclude it anyway.
    expect(report.summary.unverifiedLayers).not.toContain('live_host');
    expect(report.summary.liveHostStatus).toBe('unknown_by_design');
    // The by-design layer is still reported, loudly, in its own field.
    expect(report.summary.liveHostStatus).toBe('unknown_by_design');
  });

  test('a declared file that cannot be verified does set the flag, and names itself', async () => {
    const report = await discoverWith({
      cliBundlePath: join(tmpRoot, 'install', 'zcode.cjs'),
      desktopAsarPath: join(tmpRoot, 'install', 'app.asar')
    });
    expect(report.summary.anyLayerBlocked, 'a genuinely unobserved layer must raise the flag').toBe(true);
    expect(report.summary.unverifiedLayers.sort()).toEqual(['cli_bundle', 'desktop_asar']);
    for (const layer of report.layers.filter((/** @type {any} */ l) => l.observation !== 'unknown_by_design')) {
      expect(report.summary.unverifiedLayers).toContain(layer.layer);
    }
    // A true flag must always come with a reason, so it is actionable.
    expect(report.summary.unverifiedLayers.length).toBeGreaterThan(0);
  });

  test('a file that exists inside the install root is observed, and both file layers stay honestly reported', async () => {
    const root = join(tmpRoot, 'install-observed');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'zcode.cjs'), '// fixture bundle, not the official one\n', 'utf8');
    const report = await discovery.discoverRuntime({
      installRoot: root,
      hash: 'none',
      cliBundlePath: join(root, 'zcode.cjs'),
      desktopAsarPath: join(root, 'missing.asar')
    });
    const cli = report.layers.find((/** @type {any} */ l) => l.layer === 'cli_bundle');
    const asar = report.layers.find((/** @type {any} */ l) => l.layer === 'desktop_asar');
    // Two different real problems: the bundle was found but never hashed, and
    // the ASAR is not there at all. Neither is content_verified, so both belong
    // in the list, and the layers themselves say which is which.
    expect(cli.observation).toBe('observed');
    expect(cli.identityConfidence).not.toBe('content_verified');
    expect(asar.observation).toBe('not_observed');
    expect(report.summary.unverifiedLayers.sort()).toEqual(['cli_bundle', 'desktop_asar']);
    expect(report.summary.anyLayerBlocked).toBe(true);
    expect(report.summary.unverifiedLayers).not.toContain('live_host');
  });
});
