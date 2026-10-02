#!/usr/bin/env node
/**
 * fake-runtime.mjs — I01 fixture subprocess (fixture-only protocol).
 *
 * A real NDJSON-over-stdio child process for provider-free tests. It implements
 * NO official ZCode RPC compatibility: the protocol is explicitly
 * "fixture-only/1" so I02/I05 can reuse the transport mechanics without
 * inheriting any pre-invented facts about the production protocol.
 *
 * FIXTURE-ONLY REQUEST SCHEMA (protocol "fixture-only/1")
 *   A request line must be a single-line JSON **object** with all three keys:
 *     - id:     a string, or a finite number          (required, echoed back)
 *     - method: a non-empty string                    (required)
 *     - params: a plain object, or null               (required, may be empty)
 *   `null`, arrays, primitives, a missing/invalid id, a non-string or empty
 *   method, and a missing/non-object params are all rejected in-band with
 *     { id: <valid id or null>, ok: false,
 *       error: { code: 'BAD_FRAME', field, message } }
 *   The runtime stays alive and keeps serving after a rejection, and `dispatch`
 *   is NOT incremented for a rejected frame (it counts accepted requests only).
 *   This schema is invented for the fixture. It is NOT a statement about the
 *   official ZCode RPC schema; I02 must source that from official material.
 *
 * Guarantees:
 *  - deterministic handshake with token check (no credentials involved)
 *  - observable dispatch counter on every response frame
 *  - unknown request rejection (UNKNOWN_METHOD), bad frame rejection (BAD_FRAME)
 *  - natural exit (code 0) on "shutdown" or stdin end; no lingering timers and
 *    no process.exit() standing in for a clean shutdown
 *  - no network, no credentials, no official directory dependency
 *
 * Usage:
 *   node fake-runtime.mjs --token <secret> [--fixture <path-to-json>]
 *   fixture JSON shape: { "entries": [ { "id": "...", "label": "..." }, ... ] }
 *
 * Exit codes:
 *   0  normal (shutdown or stdin end) — reached by letting the event loop drain
 *   2  BAD_CONFIG (missing --token)
 *   3  MISSING_FIXTURE (--fixture given but unreadable)
 *
 * Codes 2 and 3 are argument-validation failures: they are raised before any
 * stdio resource is acquired, so exiting there is immediate and cannot mask a
 * dangling stream. Code 0 is a resource-holding normal shutdown and is reached
 * by releasing stdin and letting Node flush and exit on its own.
 */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

/**
 * @param {string[]} argv
 * @returns {{ token: string | undefined, fixture: string | undefined }}
 */
function parseArgs(argv) {
  /** @type {{ token: string | undefined, fixture: string | undefined }} */
  const args = { token: undefined, fixture: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--token') { args.token = argv[i + 1]; i++; }
    else if (argv[i] === '--fixture') { args.fixture = argv[i + 1]; i++; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (typeof args.token !== 'string' || args.token === '') {
  process.stderr.write('FAKE_RUNTIME_BAD_CONFIG: --token is required\n');
  process.exit(2);
}

/** @type {unknown[] | null} */
let fixtureEntries = null;
if (args.fixture !== undefined) {
  try {
    const parsed = JSON.parse(readFileSync(args.fixture, 'utf8'));
    if (!Array.isArray(parsed.entries)) throw new Error('entries array missing');
    fixtureEntries = parsed.entries;
  } catch {
    process.stderr.write(`FAKE_RUNTIME_MISSING_FIXTURE: ${args.fixture}\n`);
    process.exit(3);
  }
}

const PROTOCOL = 'fixture-only/1';
let dispatch = 0;

/**
 * Writes one response frame. `result` and `error` are mutually exclusive by
 * construction; both are optional so a rejected frame never carries a result.
 * @param {string | number | null} id
 * @param {boolean} ok
 * @param {unknown} payload
 */
function respond(id, ok, payload) {
  /** @type {{ id: string | number | null, ok: boolean, dispatch: number, result?: unknown, error?: unknown }} */
  const frame = { id, ok, dispatch };
  if (ok) frame.result = payload;
  else frame.error = payload;
  process.stdout.write(JSON.stringify(frame) + '\n');
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidId(value) {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * fixture-only/1 request validation. Returns null when the frame is well formed,
 * otherwise { field, message } describing the first violation. JSON syntax
 * validity alone is NOT enough: a syntactically valid frame can still be
 * `null`, an array, a primitive, or an object with missing/invalid fields.
 * @param {any} msg raw JSON.parse output: the fixture protocol accepts only
 *   unknown-shaped input, so it is deliberately typed `any` here and every
 *   field below is validated by this function itself.
 * @returns {{ field: string, message: string } | null}
 */
function validateFrame(msg) {
  if (!isPlainObject(msg)) {
    return { field: 'frame', message: 'request frame must be a JSON object (not null, array or primitive)' };
  }
  if (!isValidId(msg.id)) {
    return { field: 'id', message: 'id must be a string or a finite number' };
  }
  if (typeof msg.method !== 'string' || msg.method.length === 0) {
    return { field: 'method', message: 'method must be a non-empty string' };
  }
  if (msg.params === undefined) {
    return { field: 'params', message: 'params is required (use {} or null)' };
  }
  if (!isPlainObject(msg.params) && msg.params !== null) {
    return { field: 'params', message: 'params must be an object or null' };
  }
  return null;
}

/**
 * Dispatches one already-validated fixture-only/1 frame.
 * @param {any} msg a frame validateFrame() has accepted
 * @returns {boolean} false when the runtime should start shutting down
 */
function handle(msg) {
  const { id, method, params } = msg;
  dispatch++;
  switch (method) {
    case 'handshake':
      if (params && params.token === args.token) {
        respond(id, true, { protocol: PROTOCOL, fixture: true });
      } else {
        respond(id, false, { code: 'HANDSHAKE_TOKEN_MISMATCH', message: 'token does not match --token' });
      }
      return true;
    case 'echo':
      respond(id, true, { echo: params ?? null });
      return true;
    case 'list':
      if (fixtureEntries === null) {
        respond(id, false, { code: 'MISSING_FIXTURE', message: 'no --fixture was provided to this runtime' });
      } else {
        respond(id, true, { entries: fixtureEntries });
      }
      return true;
    case 'count':
      respond(id, true, { dispatch });
      return true;
    case 'shutdown':
      respond(id, true, { exiting: true });
      return false;
    default:
      respond(id, false, { code: 'UNKNOWN_METHOD', message: `no fixture handler for method: ${String(method)}` });
      return true;
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });

let stdinReleased = false;

/**
 * Release the readline interface and the stdin handle. After this nothing in
 * this process holds a ref that would keep the event loop alive, so Node flushes
 * the already-queued stdout writes and exits by itself.
 */
function releaseStdin() {
  if (stdinReleased) return;
  stdinReleased = true;
  try { rl.close(); } catch { /* already closing */ }
  try { process.stdin.pause(); } catch { /* nothing to pause */ }
  try { process.stdin.destroy(); } catch { /* already destroyed */ }
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (e) {
    respond(null, false, { code: 'BAD_FRAME', field: 'json', message: `line is not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }
  const invalid = validateFrame(msg);
  if (invalid) {
    // Correlate the rejection when the id itself is usable, otherwise null.
    const echoId = isValidId(msg && msg.id) ? msg.id : null;
    respond(echoId, false, { code: 'BAD_FRAME', field: invalid.field, message: invalid.message });
    return;
  }
  const alive = handle(msg);
  if (!alive) releaseStdin();
});

rl.on('close', () => {
  // Normal exit. Deliberately no process.exit(0) here: a forced exit would hide
  // a still-open stream or a flush that has not drained yet (F03). stdin is
  // released, so the loop empties on its own and Node exits with code 0 once
  // the pending stdout writes are flushed.
  releaseStdin();
});
