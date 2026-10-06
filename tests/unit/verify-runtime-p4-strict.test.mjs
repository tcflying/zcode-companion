/**
 * ZC-03 / F11 — the P4 readback is a SEMANTIC acceptance, not a transport one.
 *
 * Provider-free: every case runs `scripts/verify-runtime.mjs` against a
 * FIXTURE-ONLY NDJSON stdio child passed with `--cli`. No official ZCode, no
 * official app-server, no MCP, no network, no credentials, no model request.
 *
 * WHAT THIS FILE PINS (F11)
 *   `commandProbe()` used to decide the P4 verdict from the TRANSPORT alone:
 *   `res.kind === 'ok'` plus `frame.id === expectedId`. Two acknowledged
 *   conditions were therefore reported as a successful acceptance and exited 0:
 *     (a) the capability value came back FALSE   — `{"id":..,"result":{"independentPlanState":false}}`
 *     (b) the correlated answer was an ERROR    — `{"id":..,"error":{..}}`
 *     (c) the frame carried EXTRA top-level keys — `{"jsonrpc":"2.0","id":..,"result":{..}}`
 *   Case (b) is reachable because `classifyInboundFrame()` classifies a frame
 *   with an id and an `error` member as `error_response`, and the client's
 *   waiter selector treats `error_response` exactly like `response` when the id
 *   matches — so the correlated frame reached the "correlated" branch carrying
 *   an error. Transport ok is a true statement about bytes; it is not a
 *   statement about the capability, so it must not be the verdict.
 *
 * WHAT IS DELIBERATELY NOT CHANGED
 *   Correlation. An error frame whose id is NOT the one we sent must not end
 *   the wait and must not decide the verdict: a later, correct response still
 *   passes. That protection is asserted here in both directions.
 *
 * ASSERTION DISCIPLINE
 *   Every assertion in this file is new. Nothing is deleted and nothing is
 *   relaxed, and the file owns no assertion that exists elsewhere.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync,
  symlinkSync, rmSync, readdirSync, cpSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..', '..');
const VERIFY_CLI = join(PROJECT_ROOT, 'scripts', 'verify-runtime.mjs');

/** Built with fromCharCode so no escaping layer can corrupt a literal newline. */
const NL = String.fromCharCode(10);

/** Every fixture answers inside this bound; the whole file stays far under CI time. */
const PROBE_TIMEOUT_MS = 4000;
/** The "no correct response ever arrives" case has to wait for its own bound. */
const SILENT_TIMEOUT_MS = 2000;

let tmpRoot = '';

beforeAll(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'zcode-companion-zc03-')); });
afterAll(() => { if (tmpRoot !== '') rmSync(tmpRoot, { recursive: true, force: true }); });

/* ================================================================== *
 * Fixture-only app-server stand-ins
 * ================================================================== */

/**
 * Writes a FIXTURE-ONLY stand-in for the official app-server.
 *
 * It reproduces one passive `startup/storageState` announcement (so the run
 * looks like the real surface and the passive waiter advances the dispatch
 * ordinal) and then answers `runtime/capabilities` with whatever `respond`
 * writes. It implements no official behaviour and is not a JSON-RPC peer.
 *
 * `respond` is injected as source text with `id` (the id the CLI sent) and
 * `NL` in scope, so each case states its own answer frame byte for byte.
 *
 * @param {string} name
 * @param {string[]} respond source lines, already NL-joined by the caller
 * @returns {{ cli: string, trace: string }}
 */
function writeFakeAppServer(name, respond) {
  const cli = join(tmpRoot, `fake-app-server-${name}.mjs`);
  const trace = `${cli}.trace.jsonl`;
  writeFileSync(cli, [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    'const NL = String.fromCharCode(10);',
    `const TRACE = ${JSON.stringify(trace)};`,
    "writeFileSync(TRACE, '');",
    // One passive announcement. It is OBSERVED, never answered.
    "process.stdout.write(JSON.stringify({",
    "  method: 'startup/storageState',",
    "  params: {",
    "    schemaVersion: 1, attemptId: 'FIXTURE-ATTEMPT-ID', sequence: 1,",
    "    databaseId: 'FIXTURE-DATABASE-ID', databaseKind: 'session',",
    "    phase: 'ready', elapsedMs: 1",
    "  }",
    "}) + NL);",
    "let buf = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    '  buf += chunk;',
    '  let nl;',
    '  while ((nl = buf.indexOf(NL)) >= 0) {',
    '    const line = buf.slice(0, nl);',
    '    buf = buf.slice(nl + 1);',
    "    if (line.trim() === '') continue;",
    "    appendFileSync(TRACE, line + NL, 'utf8');",
    '    let msg;',
    "    try { msg = JSON.parse(line); } catch { continue; }",
    "    if (msg.method !== 'runtime/capabilities') continue;",
    '    const id = msg.id;',
    ...respond,
    '  }',
    '});',
    'process.stdin.on(\'end\', () => { process.exitCode = 0; });',
    ''
  ].join(NL), 'utf8');
  return { cli, trace };
}

/** The one official answer this card accepts: E-BUNDLE-003 / E-BUNDLE-024. */
const ACCEPTED_ANSWER = "process.stdout.write(JSON.stringify({ id, result: { independentPlanState: true } }) + NL);";

/**
 * (a) The capability value is FALSE. The frame is a perfectly well-formed,
 * correlated `result` response — it is the ANSWER that is wrong.
 */
const CAPABILITY_FALSE_ANSWER = "process.stdout.write(JSON.stringify({ id, result: { independentPlanState: false } }) + NL);";

/**
 * (b) The correlated answer is an `error_response`: same id we sent, an error
 * member instead of a result. This is the case the transport alone calls a
 * success.
 */
const CORRELATED_ERROR_ANSWER = [
  "process.stdout.write(JSON.stringify({ id, error: { code: -32000, message: 'capability readback refused' } }) + NL);"
].join(NL);

/**
 * (c) The result is right, but the frame carries an EXTRA top-level key. The
 * official response schema is `.strict()` and declares no `jsonrpc` member
 * (E-BUNDLE-021/024), so its presence means the peer is not this protocol.
 */
const EXTRA_TOP_LEVEL_KEY_ANSWER = "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { independentPlanState: true } }) + NL);";

/** An error frame whose id is NOT the one the CLI sent — a whole-message rejection. */
const UNRELATED_ERROR = "process.stdout.write(JSON.stringify({ id: 'invalid-message', error: { code: -32600, message: 'Invalid ZCode Protocol message' } }) + NL);";

/** A correct answer to a request we never made: right content, wrong id. */
const WRONG_ID_ANSWER = "process.stdout.write(JSON.stringify({ id: 'c-not-ours', result: { independentPlanState: true } }) + NL);";

/* ================================================================== *
 * Driving the CLI
 * ================================================================== */

/**
 * @param {string} cli the verify-runtime.mjs to execute
 * @param {string[]} args
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runCli(cli, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, ...args], {
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

/**
 * Runs one doubly-acknowledged P4 probe and returns the real exit code plus the
 * single JSON document the CLI printed.
 *
 * `script` and `fixture` are separate on purpose: the mutation cases run a
 * MODIFIED copy of the CLI against an unmodified fixture, so binding the two
 * to one path would make the mutation untestable.
 *
 * @param {string} script the verify-runtime.mjs to execute
 * @param {string} fixture path handed to the CLI as --cli (the fake app-server)
 * @param {{ timeoutMs?: number }} [options]
 */
async function runP4Probe(script, fixture, options = {}) {
  const r = await runCli(script, [
    'probe', '--i02-real-probe-ack', '--p4-active-readback-ack',
    '--cli', fixture, '--timeout-ms', String(options.timeoutMs ?? PROBE_TIMEOUT_MS)
  ]);
  /** @type {any} */
  let parsed = null;
  let parseError = '';
  try { parsed = JSON.parse(r.stdout); } catch (e) { parseError = e instanceof Error ? e.message : String(e); }
  return { ...r, parsed, parseError };
}

/** @param {string} path @returns {string} lowercase hex sha256 of the bytes on disk */
function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** @param {string} trace @returns {readonly string[]} */
function traceLines(trace) {
  return readFileSync(trace, 'utf8').split(NL).filter((l) => l.trim() !== '');
}

/* ================================================================== *
 * The four-fixture exit-code matrix
 * ================================================================== */

describe('ZC-03 / F11: the P4 verdict is semantic, not transport', () => {
  test('(d) POSITIVE CONTROL: the official answer {id, result:{independentPlanState:true}} is still accepted, exit 0', async () => {
    const { cli, trace } = writeFakeAppServer('accepted', [ACCEPTED_ANSWER]);
    const r = await runP4Probe(VERIFY_CLI, cli);

    expect(r.code, `stderr was:\n${r.stderr}`).toBe(0);
    expect(r.parseError, `stdout must be one JSON document, got: ${r.stdout}`).toBe('');
    expect(r.parsed.p4.outcome).toBe('ok');
    expect(r.parsed.p4.responseIdMatchedRequest).toBe(true);
    expect(r.parsed.p4.result).toEqual({ independentPlanState: true });
    // The shape the probe-plan has always promised (E-BUNDLE-021/024).
    expect(r.parsed.p4.resultShape.topLevelKeys).toEqual(['id', 'result']);
    // The readback is the only frame this product originates.
    expect(r.parsed.p4.controlFrames).toBe(1);
    // A readback is not a dispatch — on the accepted path either.
    expect(r.parsed.p4.modelDispatch).toBe(0);
    expect(r.parsed.p4.modelDispatchAttempts).toBe(0);
    // The pre-send notice still reaches stderr before any success claim.
    expect(r.stderr).toContain('about to send ONE request frame');
    // Independently confirmed by the fixture's own byte trace: ONE frame, and
    // the official request carries no `jsonrpc` member.
    const sent = traceLines(trace);
    expect(sent, 'P4 originates exactly one control frame').toHaveLength(1);
    expect(sent[0]).not.toContain('jsonrpc');
    expect(JSON.parse(/** @type {string} */ (sent[0])).method).toBe('runtime/capabilities');
  }, 40000);

  test('(a) a capability value of FALSE is not an acceptance', async () => {
    const { cli } = writeFakeAppServer('capability-false', [CAPABILITY_FALSE_ANSWER]);
    const r = await runP4Probe(VERIFY_CLI, cli);

    // RED LINE (F11): before the fix this exited 0 and the report said
    // `outcome: "ok"` — a false acceptance of a capability that came back false.
    expect(r.code, `stderr was:\n${r.stderr}`).not.toBe(0);
    expect(r.parseError, `stdout must still be one JSON document, got: ${r.stdout}`).toBe('');
    // The transport facts stay visible and true: the frame DID correlate.
    expect(r.parsed.p4.responseIdMatchedRequest, 'the id did match; only the answer is wrong').toBe(true);
    expect(r.parsed.p4.result).toEqual({ independentPlanState: false });
    // But it is no longer reported as a success.
    expect(r.parsed.p4.outcome, 'a false capability must not be reported as ok').not.toBe('ok');
    expect(r.stderr).toContain('independentPlanState');
    // Still no dispatch: a rejected verdict is not a model request.
    expect(r.parsed.p4.modelDispatch).toBe(0);
    expect(r.parsed.p4.modelDispatchAttempts).toBe(0);
    expect(r.parsed.p4.controlFrames).toBe(1);
  }, 40000);

  test('(b) a CORRELATED error_response is not an acceptance', async () => {
    const { cli } = writeFakeAppServer('correlated-error', [CORRELATED_ERROR_ANSWER]);
    const r = await runP4Probe(VERIFY_CLI, cli);

    // RED LINE (F11): the client's waiter selector treats `error_response`
    // like `response` when the id matches, so this correlated ERROR reached
    // the "correlated" branch and exited 0.
    expect(r.code, `stderr was:\n${r.stderr}`).not.toBe(0);
    expect(r.parseError, `stdout must still be one JSON document, got: ${r.stdout}`).toBe('');
    expect(r.parsed.p4.responseIdMatchedRequest, 'the id did match; the answer is an error').toBe(true);
    expect(r.parsed.p4.result, 'an error frame carries no result').toBeNull();
    expect(r.parsed.p4.outcome, 'a correlated error must not be reported as ok').not.toBe('ok');
    // The reason stays visible: F3-1 protocol diagnostics are still printed.
    expect(r.stderr).toContain('protocol diagnostics');
    expect(r.stderr).toContain('-32000');
    // And the frame log still classifies it as what it was.
    const kinds = r.parsed.p4.frameLog.map((/** @type {any} */ f) => f.kind);
    expect(kinds).toContain('error_response');
    expect(r.parsed.p4.modelDispatch).toBe(0);
    expect(r.parsed.p4.modelDispatchAttempts).toBe(0);
  }, 40000);

  test('(c) an EXTRA top-level key (a `jsonrpc` member) is not an acceptance', async () => {
    const { cli } = writeFakeAppServer('extra-top-level-key', [EXTRA_TOP_LEVEL_KEY_ANSWER]);
    const r = await runP4Probe(VERIFY_CLI, cli);

    // RED LINE (F11): the result was right and the id matched, so the extra
    // key passed and the run exited 0. The official response schema is
    // `.strict()` and declares no such member (E-BUNDLE-021/024).
    expect(r.code, `stderr was:\n${r.stderr}`).not.toBe(0);
    expect(r.parseError, `stdout must still be one JSON document, got: ${r.stdout}`).toBe('');
    expect(r.parsed.p4.result, 'the result itself was correct — the SHAPE was not').toEqual({ independentPlanState: true });
    expect(r.parsed.p4.responseIdMatchedRequest).toBe(true);
    expect(r.parsed.p4.outcome, 'a wrong frame shape must not be reported as ok').not.toBe('ok');
    expect(r.stderr).toContain('jsonrpc');
    expect(r.parsed.p4.modelDispatch).toBe(0);
    expect(r.parsed.p4.modelDispatchAttempts).toBe(0);
  }, 40000);

  test('(e) a frame that arrived but is NOT the one we asked is not an acceptance', async () => {
    // Not one of the card's three cases, and not a claim that this behaviour
    // changed — it did not. It is here because it is the neighbouring way to
    // fake a pass: correct CONTENT, wrong id. The waiter selector requires
    // `frame.id === expectId`, so such a frame does not even reach the verdict:
    // it is queued, the wait continues, and the run ends TIMEOUT / non-zero.
    // `responseIdMatchedRequest` is false, so the report never claims a
    // correlation it does not have.
    const { cli } = writeFakeAppServer('wrong-id', [WRONG_ID_ANSWER]);
    const r = await runP4Probe(VERIFY_CLI, cli);

    expect(r.code, `stderr was:\n${r.stderr}`).not.toBe(0);
    expect(r.parseError).toBe('');
    expect(r.parsed.p4.responseIdMatchedRequest, 'this frame did NOT carry the id we sent').toBe(false);
    expect(r.parsed.p4.outcome, 'a frame that merely arrived is never an acceptance').not.toBe('ok');
    expect(r.parsed.p4.outcome, 'the run ends on its own bound, with the frame left observable').toBe('TIMEOUT');
    // The decoy is still visible in the log, classified and uncorrelated.
    const decoy = r.parsed.p4.frameLog.find((/** @type {any} */ f) => f.kind === 'response');
    expect(decoy, 'the right-content/wrong-id frame is recorded rather than swallowed').toBeTruthy();
    expect(decoy.correlatedToRequest).toBe(false);
    expect(r.parsed.p4.modelDispatch).toBe(0);
    expect(r.parsed.p4.modelDispatchAttempts).toBe(0);
  }, 60000);
});

/* ================================================================== *
 * The relevance protection must not regress in either direction
 * ================================================================== */

describe('ZC-03 / F11: correlation is preserved, and stays fail-closed', () => {
  test('NEGATIVE: an UNRELATED error alone is still a non-zero run (fail-closed)', async () => {
    // The unrelated error carries a fixed diagnostic id, so it cannot satisfy
    // the pending waiter. With no correct answer ever arriving, the wait must
    // end in a failure — not in a pass, and not in a hang.
    const { cli } = writeFakeAppServer('unrelated-error-only', [UNRELATED_ERROR]);
    const r = await runP4Probe(VERIFY_CLI, cli, { timeoutMs: SILENT_TIMEOUT_MS });

    expect(r.code, `stderr was:\n${r.stderr}`).not.toBe(0);
    expect(r.parseError).toBe('');
    expect(r.parsed.p4.outcome, 'an unanswered readback is not ok').not.toBe('ok');
    // The unrelated error is still recorded, and still classified as unrelated.
    const log = r.parsed.p4.frameLog;
    const errorRecords = log.filter((/** @type {any} */ f) => f.kind === 'error_response');
    expect(errorRecords, 'the rejection frame is still observable').toHaveLength(1);
    expect(errorRecords[0].correlatedToRequest, 'it correlated to nothing').toBe(false);
    // Fail-closed, never a dispatch.
    expect(r.parsed.p4.modelDispatch).toBe(0);
    expect(r.parsed.p4.modelDispatchAttempts).toBe(0);
  }, 60000);

  test('NEGATIVE: an unrelated error FOLLOWED BY the correct response still passes', async () => {
    // The other half of the same protection (I02-F3-3): a rejection frame that
    // arrives while the readback is pending must not end the wait and must not
    // decide the verdict. The correct answer still lands on exit 0.
    const { cli } = writeFakeAppServer('unrelated-then-accepted', [
      UNRELATED_ERROR,
      ACCEPTED_ANSWER
    ]);
    const r = await runP4Probe(VERIFY_CLI, cli);

    expect(r.code, `stderr was:\n${r.stderr}`).toBe(0);
    expect(r.parseError).toBe('');
    expect(r.parsed.p4.outcome).toBe('ok');
    expect(r.parsed.p4.responseIdMatchedRequest).toBe(true);
    expect(r.parsed.p4.result).toEqual({ independentPlanState: true });
    expect(r.parsed.p4.resultShape.topLevelKeys).toEqual(['id', 'result']);
    expect(r.parsed.p4.modelDispatch).toBe(0);
    expect(r.parsed.p4.modelDispatchAttempts).toBe(0);

    // Both frames are still in the log, in arrival order, and only the second
    // one is marked as correlated.
    const log = r.parsed.p4.frameLog;
    const errorRecord = log.find((/** @type {any} */ f) => f.kind === 'error_response');
    expect(errorRecord, 'the unrelated rejection is still recorded').toBeTruthy();
    expect(errorRecord.correlatedToRequest).toBe(false);
    expect(log.some((/** @type {any} */ f) => f.correlatedToRequest === true), 'exactly the real answer correlated').toBe(true);
  }, 40000);
});

/* ================================================================== *
 * Mutation — the id/result shape check is load-bearing
 * ================================================================== */

/**
 * Builds a runnable copy of the CLI in a mirrored temp root: `<root>/scripts`
 * is a real directory (so the copy can differ from the original) and
 * `<root>/packages` points at the real runtime sources, because the script
 * resolves `packages/runtime/src` relative to its own location. Nothing is
 * written inside the repository.
 *
 * @param {string} name
 * @returns {{ root: string, cli: string, cleanup: () => void, linked: boolean }}
 */
function mirrorCli(name) {
  const root = join(tmpRoot, `mirror-${name}`);
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  let linked = false;
  try {
    symlinkSync(join(PROJECT_ROOT, 'packages'), join(root, 'packages'), 'junction');
    linked = true;
  } catch {
    // Fallback for hosts that refuse links: the runtime module graph is
    // self-contained (capability-probe.ts imports discovery.js TYPE-ONLY),
    // so a plain copy is equivalent.
    cpSync(join(PROJECT_ROOT, 'packages'), join(root, 'packages'), { recursive: true });
  }
  const cli = join(scripts, 'verify-runtime.mjs');
  copyFileSync(VERIFY_CLI, cli);
  return { root, cli, cleanup: () => rmSync(root, { recursive: true, force: true }), linked };
}

/**
 * Deletes the "only id/result" shape check from a copy of the CLI, and nothing
 * else. The replacement is anchored on the predicate's own declaration, and the
 * occurrence count is asserted, so a silent no-op mutation cannot masquerade as
 * a passing mutation test.
 */
const SHAPE_CHECK_PATTERN = /function hasOfficialP4Shape\([^)]*\) \{[\s\S]*?\n\}/;
const SHAPE_CHECK_DECLARATIONS = /function hasOfficialP4Shape\(/g;
const SHAPE_CHECK_STUB = 'function hasOfficialP4Shape(keys) {' + NL + '  return true;' + NL + '}';

describe('ZC-03 / F11: the id/result shape check is load-bearing (mutation)', () => {
  test('deleting only the shape check turns case (c) green again, and nothing else', async () => {
    const mirror = mirrorCli('shape-check');
    try {
      const originalSha = sha256Of(VERIFY_CLI);
      const copyShaBefore = sha256Of(mirror.cli);
      expect(copyShaBefore, 'the copy starts byte-identical to the original').toBe(originalSha);

      // ---- MUTATE: remove the shape check from the temp copy only ----
      const source = readFileSync(mirror.cli, 'utf8');
      const declarations = source.match(SHAPE_CHECK_DECLARATIONS) ?? [];
      expect(declarations, 'the predicate must exist exactly ONCE for this mutation to be surgical').toHaveLength(1);
      const mutated = source.replace(SHAPE_CHECK_PATTERN, SHAPE_CHECK_STUB);
      expect(mutated, 'the mutation MUST have changed the file; a no-op mutation proves nothing').not.toBe(source);
      // Only the predicate body differs: the mutated source is the original
      // with exactly that one span removed, and the length delta equals it.
      const removed = source.replace(SHAPE_CHECK_PATTERN, '');
      expect(mutated.length - SHAPE_CHECK_STUB.length, 'nothing outside the predicate body changed').toBe(removed.length);
      writeFileSync(mirror.cli, mutated, 'utf8');
      const copyShaMutated = sha256Of(mirror.cli);
      expect(copyShaMutated, 'the mutated copy must differ from the original').not.toBe(originalSha);

      // ---- RED: the target assertion (case c) no longer fails the run ----
      const { cli: extraKeyCli } = writeFakeAppServer('mutation-extra-top-level-key', [EXTRA_TOP_LEVEL_KEY_ANSWER]);
      const mutatedRun = await runP4Probe(mirror.cli, extraKeyCli, { timeoutMs: PROBE_TIMEOUT_MS });
      expect(mutatedRun.code, 'with the shape check deleted, the extra-key frame is accepted again — this is exactly why the assertion is load-bearing').toBe(0);

      // The mutation is surgical, not a blanket bypass: the other two
      // negatives must STILL fail without the shape check.
      const { cli: capFalseCli } = writeFakeAppServer('mutation-capability-false', [CAPABILITY_FALSE_ANSWER]);
      expect((await runP4Probe(mirror.cli, capFalseCli, { timeoutMs: PROBE_TIMEOUT_MS })).code,
        'the capability-value check is independent of the shape check').not.toBe(0);

      // ---- RESTORE: byte identity is provable ----
      copyFileSync(VERIFY_CLI, mirror.cli);
      const copyShaRestored = sha256Of(mirror.cli);
      expect(copyShaRestored, 'the copy is restored byte for byte').toBe(originalSha);
      const restoredRun = await runP4Probe(mirror.cli, extraKeyCli, { timeoutMs: PROBE_TIMEOUT_MS });
      expect(restoredRun.code, 'the restored copy rejects the extra-key frame again').not.toBe(0);
      expect(sha256Of(VERIFY_CLI), 'the ORIGINAL file was never touched').toBe(originalSha);
    } finally {
      mirror.cleanup();
    }
  }, 120000);
});

/* ================================================================== *
 * Hygiene
 * ================================================================== */

describe('ZC-03 / F11: test hygiene', () => {
  test('no mutated or generated CLI copy is left inside the repository', () => {
    // Every fixture, fixture trace and mutated CLI lives in the OS temp dir
    // and is removed in afterAll. The repository's scripts/ directory must
    // still hold exactly one verify-runtime.
    const scriptsDir = join(PROJECT_ROOT, 'scripts');
    const verifyRuntimes = readdirSync(scriptsDir).filter((name) => name.includes('verify-runtime'));
    expect(verifyRuntimes).toEqual(['verify-runtime.mjs']);
  });
});
