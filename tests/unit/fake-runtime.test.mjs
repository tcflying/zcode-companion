/**
 * Unit test for tests/fixtures/fake-runtime.mjs.
 * Provider-free: spawns only our own NDJSON fixture subprocess (no network,
 * no credentials, no official ZCode app-server).
 *
 * Proves real subprocess behavior:
 *  - deterministic handshake (token match / mismatch)
 *  - echo
 *  - observable dispatch counter on every response frame
 *  - unknown request rejection (UNKNOWN_METHOD)
 *  - natural exit (code 0) on shutdown, no lingering process
 *  - fixture-only/1 BAD_FRAME rejection for syntactically valid but structurally
 *    invalid frames (null / primitive / array / bad id / bad method / bad
 *    params), with the runtime staying alive and the dispatch counter intact
 *  - driver hygiene (F04): one settlement clears timer + pending waiter, a
 *    timed-out waiter cannot swallow a later frame, a dead child terminates a
 *    pending wait instead of hanging, and teardown reclaims only this driver's
 *    own child within a bounded wait
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

const FAKE_RUNTIME = process.env.I01_FAKE_RUNTIME ?? resolve(import.meta.dirname, '..', 'fixtures', 'fake-runtime.mjs');
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const TOKEN = 'fixture-token-i01';

const REAP_TIMEOUT_MS = 10000;
const SHUTDOWN = { id: 9999, method: 'shutdown', params: {} };

/**
 * @typedef {object} ExitResult
 * @property {number | null} code
 * @property {string | null} signal
 * @property {boolean} closed
 *
 * @typedef {object} FrameWaiter
 * @property {(frame: any) => void} resolve
 * @property {(err: Error) => void} reject
 * @property {ReturnType<typeof setTimeout>} timer
 */

/** Races a promise against a bounded timer, always clearing the timer. */
/**
 * @param {Promise<any>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms, message) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function countActiveTimers() {
  return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
}

/**
 * Drives one fake-runtime subprocess over NDJSON stdio.
 *
 * Resource contract:
 *  - every nextFrame() waiter is removed from `pending` exactly once, on
 *    settle by frame, by timeout, by unparsable output, or by child death
 *  - every timer created here is cleared on settle
 *  - reap() only ever signals `child` (our own handle) — never by process
 *    name, never by port, never a wildcard kill — and always waits for close
 *
 * @param {string[]} [args]
 */
function startRuntime(args = []) {
  const child = spawn(process.execPath, [FAKE_RUNTIME, '--token', TOKEN, ...args], {
    cwd: PROJECT_ROOT,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rl = createInterface({ input: child.stdout, terminal: false });
  /** @type {FrameWaiter[]} */
  const pending = [];
  /** @type {any[]} */
  const ready = [];
  /** @type {any[]} */
  const frames = [];
  let stderrText = '';
  let stopped = false;
  /** @type {Promise<ExitResult> | null} */
  let exitPromise = null;

  child.stderr.on('data', (d) => { stderrText += String(d); });

  /** @param {Error} err */
  function rejectAll(err) {
    while (pending.length > 0) {
      const waiter = pending.shift();
      if (waiter === undefined) break;
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  /** @param {any} frame */
  function accept(frame) {
    frames.push(frame);
    const waiter = pending.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      ready.push(frame);
    }
  }

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch (e) {
      rejectAll(new Error(`fake-runtime emitted a non-JSON line: ${trimmed.slice(0, 200)} (${e instanceof Error ? e.message : String(e)})`));
      return;
    }
    accept(frame);
  });

  // Without this a dead child would leave a waiter pending until its timer.
  const onStreamGone = () => rejectAll(new Error('fake-runtime stdout closed while a frame wait was pending'));
  child.stdout.on('end', onStreamGone);
  child.stdout.on('error', onStreamGone);
  child.on('error', onStreamGone);

  /** @returns {Promise<ExitResult>} */
  function exitResult() {
    if (!exitPromise) {
      exitPromise = new Promise((res) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          res({ code: child.exitCode, signal: child.signalCode, closed: true });
          return;
        }
        child.once('close', (code, signal) => res({ code, signal, closed: true }));
      });
    }
    return exitPromise;
  }

  return {
    child,
    frames,
    pid: child.pid,
    stderrText: () => stderrText,
    pendingCount: () => pending.length,
    readyCount: () => ready.length,

    /** @param {any} obj */
    send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); },
    /** @param {string} text */
    sendRaw(text) { child.stdin.write(text + '\n'); },

    /** @param {number} [timeoutMs] */
    nextFrame(timeoutMs = 5000) {
      if (ready.length > 0) return Promise.resolve(ready.shift());
      return new Promise((resolveFrame, rejectFrame) => {
        /** @type {FrameWaiter} */
        const waiter = {
          resolve: (frame) => { clearTimeout(waiter.timer); resolveFrame(frame); },
          reject: (err) => { clearTimeout(waiter.timer); rejectFrame(err); },
          timer: setTimeout(() => {
            // Drop this waiter so a late frame cannot be handed to a caller that
            // already gave up (the pre-F04 driver left it queued and swallowed it).
            const index = pending.indexOf(waiter);
            if (index >= 0) pending.splice(index, 1);
            rejectFrame(new Error(`timeout waiting for response frame after ${timeoutMs}ms`));
          }, timeoutMs)
        };
        pending.push(waiter);
      });
    },

    /** Waits for the child's real close, bounded. */
    /** @param {number} [timeoutMs] */
    close(timeoutMs = REAP_TIMEOUT_MS) {
      return withTimeout(exitResult(), timeoutMs, `fake-runtime did not close within ${timeoutMs}ms`);
    },

    /**
     * Idempotent teardown: settle waiters, release streams, reclaim own child.
     * Escalation is staged so a well-behaved fixture is allowed to exit on its
     * own (stdin EOF) before any signal is sent; only this driver's own child
     * handle is ever signalled — never a name, never a port, never a wildcard.
     * @param {number} [timeoutMs]
     */
    async reap(timeoutMs = REAP_TIMEOUT_MS) {
      if (stopped) return { code: child.exitCode, signal: child.signalCode, stage: 'already-reaped' };
      stopped = true;
      rejectAll(new Error('fake-runtime driver was reaped while a frame wait was pending'));
      try { rl.close(); } catch { /* already closed */ }
      try { child.stdin.end(); } catch { /* already ended */ }

      /**
       * @param {string} stage
       * @param {number} budget
       */
      const settle = async (stage, budget) => ({
        ...(await withTimeout(exitResult(), budget, `fake-runtime did not close within ${budget}ms (${stage})`)),
        stage
      });
      try {
        return await settle('stdin-eof', Math.min(2000, timeoutMs));
      } catch { /* escalate below */ }
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        return await settle('sigterm', timeoutMs);
      } catch { /* escalate below */ }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      return settle('sigkill', timeoutMs).finally(() => {
        child.stdout.off('end', onStreamGone);
        child.stdout.off('error', onStreamGone);
        child.off('error', onStreamGone);
      });
    }
  };
}

describe('fake-runtime NDJSON fixture', () => {
  it('deterministic handshake with matching token, observable dispatch counter, echo, unknown rejection, clean exit 0', async () => {
    const rt = startRuntime();
    try {
      rt.send({ id: 1, method: 'handshake', params: { token: TOKEN } });
      const hs = await rt.nextFrame();
      expect(hs).toMatchObject({ id: 1, ok: true, dispatch: 1 });
      expect(hs.result.protocol).toBe('fixture-only/1');

      rt.send({ id: 2, method: 'echo', params: { msg: 'ping-i01' } });
      const echo = await rt.nextFrame();
      expect(echo).toMatchObject({ id: 2, ok: true, dispatch: 2 });
      expect(echo.result.echo).toEqual({ msg: 'ping-i01' });

      rt.send({ id: 3, method: 'definitely_unknown', params: {} });
      const unk = await rt.nextFrame();
      expect(unk.ok).toBe(false);
      expect(unk.error.code).toBe('UNKNOWN_METHOD');
      expect(unk.dispatch).toBe(3);

      rt.send(SHUTDOWN);
      const bye = await rt.nextFrame();
      expect(bye).toMatchObject({ id: SHUTDOWN.id, ok: true, dispatch: 4 });

      // Natural exit: the runtime released stdin and Node flushed and returned
      // on its own. No process.exit(0) and no signal from this driver.
      const closed = await rt.close();
      expect(closed.code).toBe(0);
      expect(closed.signal).toBeNull();
      expect(rt.pendingCount()).toBe(0);
    } finally {
      await rt.reap();
    }
  }, 15000);

  it('rejects handshake with wrong token', async () => {
    const rt = startRuntime();
    try {
      rt.send({ id: 1, method: 'handshake', params: { token: 'wrong-token' } });
      const hs = await rt.nextFrame();
      expect(hs.ok).toBe(false);
      expect(hs.error.code).toBe('HANDSHAKE_TOKEN_MISMATCH');
      rt.send(SHUTDOWN);
      await rt.nextFrame();
      expect((await rt.close()).code).toBe(0);
    } finally {
      await rt.reap();
    }
  }, 15000);

  it('list without --fixture is rejected in-band with MISSING_FIXTURE (no official directory dependency)', async () => {
    const rt = startRuntime();
    try {
      rt.send({ id: 1, method: 'handshake', params: { token: TOKEN } });
      await rt.nextFrame();
      rt.send({ id: 2, method: 'list', params: {} });
      const list = await rt.nextFrame();
      expect(list).toMatchObject({ id: 2, ok: false, dispatch: 2 });
      expect(list.error.code).toBe('MISSING_FIXTURE');
      rt.send(SHUTDOWN);
      await rt.nextFrame();
      expect((await rt.close()).code).toBe(0);
    } finally {
      await rt.reap();
    }
  }, 15000);

  it('serves deterministic directory entries from a valid --fixture file', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'zcode-companion-fixture-'));
    const fixturePath = join(fixtureDir, 'valid-fixture.json');
    // The fixture file must exist before the runtime starts: it reads it once
    // during argument validation.
    await writeFile(fixturePath, JSON.stringify({ entries: [{ id: 'alpha', label: 'Alpha entry' }, { id: 'beta', label: 'Beta entry' }] }), 'utf8');
    const rt = startRuntime(['--fixture', fixturePath]);
    try {
      rt.send({ id: 1, method: 'handshake', params: { token: TOKEN } });
      await rt.nextFrame();
      rt.send({ id: 2, method: 'list', params: {} });
      const list = await rt.nextFrame();
      expect(list.ok).toBe(true);
      expect(list.result.entries).toEqual([
        { id: 'alpha', label: 'Alpha entry' },
        { id: 'beta', label: 'Beta entry' }
      ]);
      rt.send(SHUTDOWN);
      await rt.nextFrame();
      expect((await rt.close()).code).toBe(0);
    } finally {
      await rt.reap();
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 15000);
});

describe('fake-runtime fixture-only/1 frame validation (F02)', () => {
  const BAD_CASES = [
    { label: 'null', raw: 'null', field: 'frame' },
    { label: 'number primitive', raw: '42', field: 'frame' },
    { label: 'string primitive', raw: '"hello"', field: 'frame' },
    { label: 'boolean primitive', raw: 'true', field: 'frame' },
    { label: 'array', raw: '[{"id":1,"method":"count","params":{}}]', field: 'frame' },
    { label: 'missing id', raw: JSON.stringify({ method: 'count', params: {} }), field: 'id' },
    { label: 'null id', raw: JSON.stringify({ id: null, method: 'count', params: {} }), field: 'id' },
    { label: 'object id', raw: JSON.stringify({ id: { n: 1 }, method: 'count', params: {} }), field: 'id' },
    { label: 'non-string method', raw: JSON.stringify({ id: 7, method: 12, params: {} }), field: 'method' },
    { label: 'empty method', raw: JSON.stringify({ id: 7, method: '', params: {} }), field: 'method' },
    { label: 'missing params', raw: JSON.stringify({ id: 7, method: 'count' }), field: 'params' },
    { label: 'array params', raw: JSON.stringify({ id: 7, method: 'count', params: [1] }), field: 'params' },
    { label: 'string params', raw: JSON.stringify({ id: 7, method: 'count', params: 'nope' }), field: 'params' }
  ];

  it('rejects every structurally invalid frame in-band and stays alive (no crash on valid JSON)', async () => {
    const rt = startRuntime();
    try {
      for (const bad of BAD_CASES) {
        rt.sendRaw(bad.raw);
        const frame = await rt.nextFrame();
        expect(frame.ok, `${bad.label} must be rejected, got ${JSON.stringify(frame)}`).toBe(false);
        expect(frame.error.code, `${bad.label} error code`).toBe('BAD_FRAME');
        expect(frame.error.field, `${bad.label} offending field`).toBe(bad.field);
        // A rejected frame is not a dispatch, and the id is only echoed when it
        // was itself usable — the rejection stays correlatable.
        expect(frame.dispatch, `${bad.label} must not increment dispatch`).toBe(0);
      }
      expect(rt.stderrText(), 'a structurally invalid frame must not crash the runtime').not.toContain('TypeError');

      // Controlled lifecycle: the runtime still serves valid traffic afterwards.
      rt.send({ id: 'after-bad', method: 'handshake', params: { token: TOKEN } });
      const hs = await rt.nextFrame();
      expect(hs).toMatchObject({ id: 'after-bad', ok: true, dispatch: 1 });

      rt.send(SHUTDOWN);
      await rt.nextFrame();
      expect((await rt.close()).code).toBe(0);
    } finally {
      await rt.reap();
    }
  }, 20000);

  it('echoes a usable id on BAD_FRAME so the rejection is correlatable', async () => {
    const rt = startRuntime();
    try {
      rt.send({ id: 'req-abc', method: 'count', params: 'invalid' });
      const frame = await rt.nextFrame();
      expect(frame).toMatchObject({ id: 'req-abc', ok: false, dispatch: 0 });
      expect(frame.error).toMatchObject({ code: 'BAD_FRAME', field: 'params' });
    } finally {
      await rt.reap();
    }
  }, 15000);

  it('unparsable JSON is also rejected in-band as BAD_FRAME without killing the runtime', async () => {
    const rt = startRuntime();
    try {
      rt.sendRaw('{not json at all');
      const frame = await rt.nextFrame();
      expect(frame).toMatchObject({ id: null, ok: false, dispatch: 0 });
      expect(frame.error.code).toBe('BAD_FRAME');
      expect(frame.error.field).toBe('json');

      rt.send({ id: 'alive', method: 'count', params: {} });
      expect(await rt.nextFrame()).toMatchObject({ id: 'alive', ok: true, dispatch: 1 });
    } finally {
      await rt.reap();
    }
  }, 15000);
});

describe('fake-runtime driver hygiene (F04)', () => {
  it('a timed-out waiter is removed and cannot swallow a later frame', async () => {
    const rt = startRuntime();
    try {
      await expect(rt.nextFrame(150), 'no frame is coming yet').rejects.toThrow(/timeout waiting for response frame/);
      expect(rt.pendingCount(), 'the timed-out waiter must be unqueued').toBe(0);

      rt.send({ id: 'late-1', method: 'count', params: {} });
      const frame = await rt.nextFrame(5000);
      expect(frame, 'the orphaned waiter must not have consumed this response').toMatchObject({ id: 'late-1', ok: true, dispatch: 1 });
      expect(rt.pendingCount()).toBe(0);
    } finally {
      await rt.reap();
    }
  }, 15000);

  it('clears the timeout timer on every settled wait (no accumulating 5s timers)', async () => {
    const rt = startRuntime();
    try {
      rt.send({ id: 0, method: 'handshake', params: { token: TOKEN } });
      await rt.nextFrame(5000);
      const before = countActiveTimers();
      for (let i = 1; i <= 5; i++) {
        rt.send({ id: i, method: 'count', params: {} });
        await rt.nextFrame(5000);
      }
      const leaked = countActiveTimers() - before;
      expect(leaked, `${leaked} timer(s) still active after 5 settled waits`).toBeLessThanOrEqual(1);
      expect(rt.pendingCount()).toBe(0);
    } finally {
      await rt.reap();
    }
  }, 15000);

  it('a pending wait is rejected promptly when the child dies instead of hanging until the timer', async () => {
    const rt = startRuntime();
    try {
      // Attach the handler first: the rejection may land while we await reap().
      const pending = expect(rt.nextFrame(60000)).rejects.toThrow(/stdout closed/);
      rt.child.kill('SIGKILL'); // this driver's own child handle only
      await pending;
      const closed = await rt.close(10000);
      expect(closed.code === null || closed.signal !== null, 'death must surface as a signal, not a normal code').toBe(true);
      expect(rt.pendingCount()).toBe(0);
    } finally {
      await rt.reap();
    }
  }, 30000);

  it('reap() reclaims only its own child, within a bounded wait, with no pending waiter left', async () => {
    const rt = startRuntime();
    // spawn() only reports a pid for a real child; asserted right above, so the
    // cast records that invariant for the checker instead of hiding it.
    const pid = /** @type {number} */ (rt.pid);
    expect(typeof pid).toBe('number');
    const pending = expect(rt.nextFrame(60000)).rejects.toThrow(/reaped/);
    const result = await rt.reap(10000);
    await pending;
    expect(rt.pendingCount()).toBe(0);
    expect(result.stage).toBe('stdin-eof');
    // The fixture exited because we closed its stdin, i.e. a natural 0, not a kill.
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(rt.child.exitCode !== null || rt.child.signalCode !== null).toBe(true);
    expect(() => process.kill(pid, 0), `fixture pid ${pid} must no longer exist`).toThrow();
  }, 30000);
});

describe('fake-runtime natural shutdown drains large writes (F03)', () => {
  it('a 256 KiB echo frame is written in full and the process still exits 0 on its own', async () => {
    const rt = startRuntime();
    try {
      const blob = 'x'.repeat(256 * 1024);
      rt.send({ id: 1, method: 'echo', params: { blob } });
      const echo = await rt.nextFrame(15000);
      expect(echo.ok).toBe(true);
      expect(echo.result.echo.blob.length).toBe(blob.length);
      expect(echo.result.echo.blob).toBe(blob);

      rt.send(SHUTDOWN);
      const bye = await rt.nextFrame(15000);
      expect(bye).toMatchObject({ id: SHUTDOWN.id, ok: true });
      const closed = await rt.close(15000);
      expect(closed.code).toBe(0);
      expect(closed.signal).toBeNull();
    } finally {
      await rt.reap();
    }
  }, 40000);

  it('exits 0 on stdin end without a shutdown frame', async () => {
    const rt = startRuntime();
    try {
      rt.send({ id: 1, method: 'count', params: {} });
      await rt.nextFrame();
      rt.child.stdin.end(); // parent closes the pipe: readline 'close' path
      const closed = await rt.close(10000);
      expect(closed.code).toBe(0);
      expect(closed.signal).toBeNull();
    } finally {
      await rt.reap();
    }
  }, 15000);
});

// Guard the two fixtures this module writes outside the OS temp dir: none.
describe('test residue guard', () => {
  it('leaves no temp fixture file inside the repository', () => {
    expect(existsSync(join(PROJECT_ROOT, 'tests', 'fixtures', 'valid-fixture.tmp.json'))).toBe(false);
  });
});
