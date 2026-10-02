/**
 * Contract test for the I01 stage gate and fake-runtime fixture.
 * Provider-free: only spawns our own fixture processes and local npm scripts.
 *
 * Proves (with real exit codes, not source-string comparison):
 *  - implemented gates exit 0 and select the right vitest targets
 *  - NOT_IMPLEMENTED gates exit non-zero and emit the NOT_IMPLEMENTED marker
 *  - unknown gate name exits non-zero (UNKNOWN_GATE)
 *  - fake-runtime: bad config (missing --token) exits non-zero
 *  - fake-runtime: missing fixture file exits non-zero
 *  - vitest: empty test category exits non-zero (no allowNoTests anywhere)
 *  - typecheck really covers TypeScript sources under packages/ and apps/
 *
 * F01 — this file is itself a vitest target of `test:contract` and `test`.
 * Executing those two gates from inside it starts vitest over the very file
 * doing the asserting, deriving test processes without bound (measured: the
 * gate had 16 own descendants after 8s and was still deriving; it never
 * returned). The two halves of the original assertion are therefore proven
 * without that fixed point:
 *   1. on the REAL project root, gate classification and REAL target selection
 *      are asserted through `--print-targets` (full validation, no re-entry);
 *   2. REAL vitest execution of the same three gates, with REAL exit codes and
 *      REAL target selection, is asserted against an isolated temporary test
 *      root whose sentinel tests record which category actually ran.
 * Nothing is skipped, deleted or made tautological: `test:unit` is still
 * executed for real against the real project.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const STAGE_GATE = join(PROJECT_ROOT, 'scripts', 'stage-gate.mjs');
const FAKE_RUNTIME = join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-runtime.mjs');
const TSC = join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const TSCONFIG = join(PROJECT_ROOT, 'tsconfig.json');
const UNIT_DIR = resolve(PROJECT_ROOT, 'tests', 'unit');
const CONTRACT_DIR = resolve(PROJECT_ROOT, 'tests', 'contract');

/** @typedef {{ timeoutMs?: number, cwd?: string, env?: Record<string, string>, stdin?: string }} RunOptions */

/**
 * Runs a real child process with a bounded wait. On timeout it signals only the
 * handle it created itself and still waits for that child's close, so no test
 * can leave a detached grandchild behind.
 * @param {string[]} args
 * @param {RunOptions} [opts]
 * @returns {Promise<{ code: number | null, out: string, err: string, timedOut: boolean }>}
 */
function runNode(args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const stdinData = opts.stdin;
  return new Promise((resolvePromise) => {
    let out = '';
    let err = '';
    let settled = false;
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd ?? PROJECT_ROOT,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: [stdinData === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    // The stdio array above is computed, so TypeScript cannot narrow the stream
    // handles for us; they are non-null whenever 'pipe' was requested.
    const stdinStream = /** @type {import('node:stream').Writable} */ (child.stdin);
    const stdoutStream = /** @type {import('node:stream').Readable} */ (child.stdout);
    const stderrStream = /** @type {import('node:stream').Readable} */ (child.stderr);
    if (stdinData !== undefined) {
      stdinStream.on('error', () => { /* the child may exit before we finish writing */ });
      stdinStream.end(stdinData);
    }
    stdoutStream.on('data', (d) => { out += String(d); });
    stderrStream.on('data', (d) => { err += String(d); });
    /** @param {number | null} code */
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, out, err, timedOut: false });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL'); // our own child handle only
      setTimeout(() => finish(-2), 5000);
    }, timeoutMs);
    child.on('close', (code) => finish(code));
    child.on('error', (e) => { err += String(e); finish(-1); });
  });
}

/**
 * @param {string} stdout
 * @returns {string[]}
 */
function targets(stdout) {
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort();
}

/**
 * @param {string} logPath
 * @returns {string[]}
 */
function readSentinels(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Builds an isolated test root whose two categories log a unique sentinel.
 * @param {string} root
 * @returns {string} the sentinel log path
 */
function buildIsolatedRoot(root) {
  mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
  mkdirSync(join(root, 'tests', 'contract'), { recursive: true });
  /** @param {string} category */
  const body = (category) => `import { it, expect } from 'vitest';
import { appendFileSync } from 'node:fs';

const LOG = process.env.I01_SENTINEL_LOG;
const CATEGORY = ${JSON.stringify(category)};

it(\`\${CATEGORY} sentinel ran\`, () => {
  expect(import.meta.url.replace(/\\\\/g, '/')).toContain(\`/tests/\${CATEGORY}/\`);
  expect(typeof LOG).toBe('string');
  appendFileSync(LOG, CATEGORY + '\\n');
});
`;
  writeFileSync(join(root, 'tests', 'unit', 'i01-sentinel.test.mjs'), body('unit'), 'utf8');
  writeFileSync(join(root, 'tests', 'contract', 'i01-sentinel.test.mjs'), body('contract'), 'utf8');
  return join(root, 'sentinel.log');
}

describe('stage gate classification contract', () => {
  it('test:unit executes for real against the real project root and exits 0', async () => {
    const r = await runNode([STAGE_GATE, 'test:unit']);
    expect(r.code, `test:unit should exit 0, stderr: ${r.err}`).toBe(0);
  }, 180000);

  it('classifies test:contract and test on the real root and selects their real targets', async () => {
    // See the F01 note at the top: these two gates are not executed from
    // inside their own vitest target. Classification and target selection are
    // still asserted on the real project root, and their real vitest execution
    // is asserted on an isolated root in the next test.
    const contract = await runNode([STAGE_GATE, 'test:contract', '--print-targets']);
    expect(contract.code, contract.err).toBe(0);
    expect(targets(contract.out)).toEqual([CONTRACT_DIR]);

    const all = await runNode([STAGE_GATE, 'test', '--print-targets']);
    expect(all.code, all.err).toBe(0);
    expect(targets(all.out)).toEqual([CONTRACT_DIR, UNIT_DIR].sort());
  }, 60000);

  it('runs real vitest for each gate with real exit codes and real target selection on an isolated root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zcode-companion-gate-'));
    try {
      const log = buildIsolatedRoot(root);
      const env = { I01_SENTINEL_LOG: log };

      rmSync(log, { force: true });
      const unit = await runNode([STAGE_GATE, 'test:unit', '--root', root], { env });
      expect(unit.code, `test:unit on isolated root: ${unit.err}`).toBe(0);
      expect(readSentinels(log)).toEqual(['unit']);

      rmSync(log, { force: true });
      const contract = await runNode([STAGE_GATE, 'test:contract', '--root', root], { env });
      expect(contract.code, `test:contract on isolated root: ${contract.err}`).toBe(0);
      expect(readSentinels(log)).toEqual(['contract']);

      rmSync(log, { force: true });
      const all = await runNode([STAGE_GATE, 'test', '--root', root], { env });
      expect(all.code, `test on isolated root: ${all.err}`).toBe(0);
      expect(readSentinels(log).sort()).toEqual(['contract', 'unit']);
    } finally {
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(root), 'the isolated test root must be reclaimed').toBe(false);
    }
  }, 180000);

  it('NOT_IMPLEMENTED gates exit non-zero with the NOT_IMPLEMENTED marker', async () => {
    // I10 实现了 pack:win 与 verify:package，因此这两个门**移出**本表；
    // 它们的分类由下一条用例从正面钉住（不再是 NOT_IMPLEMENTED）。
    const gates = ['lint', 'test:integration', 'test:mutations', 'test:e2e', 'build'];
    for (const gate of gates) {
      const r = await runNode([STAGE_GATE, gate]);
      expect(r.code, `${gate} must block release (non-zero)`).not.toBe(0);
      expect(r.out + r.err).toContain('NOT_IMPLEMENTED');
    }
  });

  it('pack:win / verify:package 已实现：不再 NOT_IMPLEMENTED，缺前提时报真实原因码', async () => {
    // 一个空 root：前提文件全都不在。这两道门**必须**因此报各自的真实原因码
    // （GATE_PREREQUISITE_MISSING / 找不到命令），而不是退回 NOT_IMPLEMENTED ——
    // 后者意味着「实现没做」，前者才是「实现做了但前提没备齐」。
    const bareRoot = mkdtempSync(join(tmpdir(), 'zcc-gate-prereq-'));
    try {
      for (const gate of ['pack:win', 'verify:package']) {
        const r = await runNode([STAGE_GATE, gate, '--root', bareRoot], { timeoutMs: 60000 });
        expect(r.out + r.err, `${gate} 不能再声称 NOT_IMPLEMENTED`).not.toContain('NOT_IMPLEMENTED');
        expect(r.code, `${gate} 缺前提时必须非零`).toBe(4);
        expect(r.out + r.err, `${gate} 必须指名缺哪个前提`).toContain('GATE_PREREQUISITE_MISSING');
      }
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
      expect(existsSync(bareRoot), 'the temporary prerequisite root must be reclaimed').toBe(false);
    }
  }, 120000);

  it('unknown gate name exits non-zero with UNKNOWN_GATE', async () => {
    const r = await runNode([STAGE_GATE, 'definitely-not-a-gate']);
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain('UNKNOWN_GATE');
  });

  it('missing gate argument exits non-zero with USAGE', async () => {
    const r = await runNode([STAGE_GATE]);
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain('USAGE');
  });

  it('unknown option exits non-zero with USAGE', async () => {
    const r = await runNode([STAGE_GATE, 'test:unit', '--not-an-option']);
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain('UNKNOWN_OPTION');
  });
});

describe('fake-runtime negative contract', () => {
  it('bad config: missing --token exits non-zero with BAD_CONFIG', async () => {
    const r = await runNode([FAKE_RUNTIME]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('BAD_CONFIG');
  });

  it('missing fixture: --fixture pointing to a nonexistent file exits non-zero with MISSING_FIXTURE', async () => {
    const r = await runNode([FAKE_RUNTIME, '--token', 't', '--fixture', join(PROJECT_ROOT, 'tests', 'fixtures', 'no-such-fixture.json')]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('MISSING_FIXTURE');
  });

  it('a structurally invalid frame does not crash the runtime: it answers BAD_FRAME in-band and still exits 0', async () => {
    const stdin = [
      'null',
      JSON.stringify({ id: 1, method: 'handshake', params: { token: 't' } }),
      JSON.stringify({ id: 2, method: 'shutdown', params: {} })
    ].join('\n') + '\n';
    const r = await runNode([FAKE_RUNTIME, '--token', 't'], { stdin, timeoutMs: 20000 });
    expect(r.code, `a null frame must not crash the runtime: ${r.err}`).toBe(0);
    expect(r.err).not.toContain('TypeError');
    const frames = r.out.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ id: null, ok: false, dispatch: 0 });
    expect(frames[0].error.code).toBe('BAD_FRAME');
    // Controlled lifecycle: valid traffic is still served after the rejection.
    expect(frames[1]).toMatchObject({ id: 1, ok: true, dispatch: 1 });
    expect(frames[2]).toMatchObject({ id: 2, ok: true });
  });
});

describe('empty test category contract', () => {
  it('a gate whose category directory has no tests exits non-zero with EMPTY_CATEGORY', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'zcode-companion-empty-'));
    try {
      const unit = await runNode([STAGE_GATE, 'test:unit', '--root', emptyDir]);
      expect(unit.code).not.toBe(0);
      expect(unit.out + unit.err).toContain('EMPTY_CATEGORY');

      const contract = await runNode([STAGE_GATE, 'test:contract', '--root', emptyDir]);
      expect(contract.code).not.toBe(0);
      expect(contract.out + contract.err).toContain('EMPTY_CATEGORY');

      // The default gate needs BOTH categories: one present is still empty.
      mkdirSync(join(emptyDir, 'tests', 'unit'), { recursive: true });
      writeFileSync(join(emptyDir, 'tests', 'unit', 'a.test.mjs'), '// sentinel\n', 'utf8');
      const all = await runNode([STAGE_GATE, 'test', '--root', emptyDir]);
      expect(all.code, `test must still fail while tests/contract is empty: ${all.out}`).not.toBe(0);
      expect(all.out + all.err).toContain('EMPTY_CATEGORY');
      expect(all.out + all.err).toContain('tests/contract');

      // --print-targets performs the same check, so it is not a bypass.
      const printed = await runNode([STAGE_GATE, 'test', '--root', emptyDir, '--print-targets']);
      expect(printed.code).not.toBe(0);
      expect(printed.out + printed.err).toContain('EMPTY_CATEGORY');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
      expect(existsSync(emptyDir), 'the temporary empty-category root must be reclaimed').toBe(false);
    }
  }, 120000);
});

describe('typecheck scope contract (F05)', () => {
  it('packages/ sources are inside the root type-check scope (probe is really compiled)', async () => {
    const clean = await runNode([TSC, '--noEmit', '-p', TSCONFIG], { timeoutMs: 180000 });
    expect(clean.code, `baseline typecheck must pass: ${clean.out}${clean.err}`).toBe(0);

    const probe = join(PROJECT_ROOT, 'packages', 'i01-typecheck-probe.tmp.ts');
    try {
      mkdirSync(dirname(probe), { recursive: true });
      writeFileSync(probe, 'export const i01Probe: number = "not-a-number";\n', 'utf8');
      const r = await runNode([TSC, '--noEmit', '-p', TSCONFIG], { timeoutMs: 180000 });
      expect(r.code, 'typecheck must fail while the packages/ probe holds a type error').not.toBe(0);
      expect(r.out + r.err, 'tsc must report the error inside the packages/ probe').toContain('i01-typecheck-probe.tmp.ts');
    } finally {
      rmSync(probe, { force: true });
      try { rmdirSync(dirname(probe)); } catch { /* not empty: real sources live there */ }
      expect(existsSync(probe), 'the typecheck probe must not be left behind').toBe(false);
      const after = await runNode([TSC, '--noEmit', '-p', TSCONFIG], { timeoutMs: 180000 });
      expect(after.code, `typecheck must be clean again after the probe is removed: ${after.out}${after.err}`).toBe(0);
    }
  }, 600000);

  it('apps/ sources are type-checked by the real typecheck:apps gate, not by the root project', async () => {
    const appsConfig = join(PROJECT_ROOT, 'apps', 'ui', 'tsconfig.json');
    if (!existsSync(appsConfig)) {
      throw new Error(`the apps/ project config is missing: ${appsConfig} — the apps coverage hook would be a no-op`);
    }
    // The gate must propagate the real tsc exit code for the apps project.
    const viaGate = await runNode([STAGE_GATE, 'typecheck:apps'], { timeoutMs: 180000 });
    const direct = await runNode([TSC, '--noEmit', '-p', appsConfig], { timeoutMs: 180000 });
    expect(viaGate.code, 'typecheck:apps must propagate the real tsc exit code').toBe(direct.code);
    // Whether apps/ is currently clean (another workstream's state) or not, the
    // command must really be compiling apps sources, not silently doing nothing.
    const appsOutput = direct.out + direct.err;
    expect(
      direct.code === 0 || /apps[\\/]ui[\\/]/.test(appsOutput),
      `typecheck:apps must really cover apps sources, got exit ${direct.code}: ${appsOutput.slice(0, 400)}`
    ).toBe(true);
  }, 600000);

  it('a missing apps/ project config fails the typecheck:apps gate loudly instead of skipping it', async () => {
    // Q1: typecheck:apps is wired into `npm run ci`, so "the apps project is
    // not there" must be a distinct blocking outcome, never a silent pass.
    // This root has a tsc entry point but no apps/ui/tsconfig.json; the stub
    // answers 0, so this test can only pass if the gate refuses to run it.
    const bareRoot = mkdtempSync(join(tmpdir(), 'zcode-companion-noapps-'));
    try {
      mkdirSync(join(bareRoot, 'node_modules', 'typescript', 'bin'), { recursive: true });
      writeFileSync(join(bareRoot, 'node_modules', 'typescript', 'bin', 'tsc'), 'process.exit(0);\n', 'utf8');
      const r = await runNode([STAGE_GATE, 'typecheck:apps', '--root', bareRoot], { timeoutMs: 60000 });
      expect(r.code, `a missing apps project must block the gate, not pass it: ${r.out}${r.err}`).toBe(4);
      expect(r.out + r.err).toContain('APPS_PROJECT_NOT_CREATED');
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
      expect(existsSync(bareRoot), 'the temporary no-apps root must be reclaimed').toBe(false);
    }
  }, 60000);
});
