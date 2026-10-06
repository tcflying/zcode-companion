/**
 * F33 contract test: the published desktop main process / preload bridge must sit
 * inside a real type project, and that project must be reachable through a real
 * stage gate.
 *
 * What this file proves (real exit codes, real child processes — never
 * source-string comparison of the gate):
 *  - `typecheck:desktop` is a known, implemented gate (not UNKNOWN_GATE, not
 *    NOT_IMPLEMENTED), and the NOT_IMPLEMENTED set is untouched.
 *  - it is wired into `npm run ci`, so the desktop main/preload can actually
 *    turn the main chain red.
 *  - the gate propagates the real tsc exit code instead of inventing one.
 *  - a project root without `apps/desktop/package.json` fails closed with exit 4
 *    + GATE_PREREQUISITE_MISSING — never 0, never 1, and never a new code.
 *  - `tsc --listFilesOnly` really lists main.cjs and preload.cjs, i.e. the
 *    coverage is real and not a no-op project.
 *  - the gate is neither tautologically green nor tautologically red: on an
 *    isolated root shaped exactly like this one, a planted type error turns it
 *    red (exit 1, naming a real file under apps/desktop/) and removing the
 *    planted error turns it green again (exit 0).
 *
 * F01 (AGENTS.md §3) is respected: this file never executes `test:contract` or
 * `test`. Those two gates start vitest over the very file doing the asserting,
 * which derives test processes without bound. The gate under test here spawns
 * tsc, not vitest, so there is no fixed point; the `ci` wiring is asserted by
 * reading package.json, which is a pure read.
 *
 * Provider-free: no Electron, no app-server, no model calls, no network, no
 * ports. Every child process here is one this file spawned itself and reclaims
 * on its own handle.
 */
import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const STAGE_GATE = join(PROJECT_ROOT, 'scripts', 'stage-gate.mjs');
const TSC = join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const DESKTOP_TSCONFIG = join(PROJECT_ROOT, 'tsconfig.desktop.json');
const DESKTOP_DIR = join(PROJECT_ROOT, 'apps', 'desktop');
const REAL_MAIN = join(DESKTOP_DIR, 'main.cjs');
const REAL_PRELOAD = join(DESKTOP_DIR, 'preload.cjs');

/** @typedef {{ timeoutMs?: number, cwd?: string }} RunOptions */

/**
 * Runs a real child process with a bounded wait. On timeout it signals only the
 * handle it created itself and still waits for that child's close, so no test
 * can leave a detached grandchild behind.
 * @param {string[]} args
 * @param {RunOptions} [opts]
 * @returns {Promise<{ code: number | null, out: string, err: string, timedOut: boolean }>}
 */
function runNode(args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 180000;
  return new Promise((resolvePromise) => {
    let out = '';
    let err = '';
    let settled = false;
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd ?? PROJECT_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdoutStream = /** @type {import('node:stream').Readable} */ (child.stdout);
    const stderrStream = /** @type {import('node:stream').Readable} */ (child.stderr);
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

/** @param {{ code: number | null, out: string, err: string }} r */
const combined = (r) => r.out + r.err;

/** @param {string} p */
const toPosix = (p) => p.replace(/\\/g, '/');

const SYNTH_MAIN = `'use strict';

/**
 * Isomorphic stand-in for the published main process entry.
 * @param {number} n
 * @returns {number}
 */
function addOne(n) {
  return n + 1;
}

module.exports = { addOne };
`;

const SYNTH_PRELOAD = `'use strict';

/** @type {{ desktop: boolean }} */
const bridge = { desktop: true };

module.exports = { bridge };
`;

/**
 * The planted defect. It is a plain wrong-argument call, which every
 * compilerOptions combination reports, so a red result can never be blamed on a
 * relaxed setting. It is appended to a real main.cjs inside a real apps/desktop
 * tree, so the error must be reported against that file.
 */
const PLANTED_DEFECT = `
/**
 * @param {number} n
 * @returns {number}
 */
function zccPlantedWrongArg(n) {
  return n + 1;
}

module.exports.zccPlantedWrongArg = zccPlantedWrongArg;
const zccPlantedResult = zccPlantedWrongArg('not-a-number');
module.exports.zccPlantedResult = zccPlantedResult;
`;

/**
 * Builds an isolated project root shaped exactly like the real one as far as
 * `typecheck:desktop` is concerned:
 *   - the project's own tsconfig.desktop.json, copied verbatim, so the gate is
 *     proven against the real project file and not a softened fixture;
 *   - a real apps/desktop tree with main.cjs and preload.cjs;
 *   - a tsc entry point at the path the gate resolves, which re-executes the
 *     real compiler (a stub that merely exits 0 would prove nothing, and one
 *     that hardcodes an exit code would fake the propagation under test).
 * The ambient @types/node is a minimal local stand-in: it only has to satisfy
 * `types: ["node"]` for a fixture that uses no Node API. The real tree's type
 * fidelity is proven separately against the real tsc, not here.
 * @param {string} root
 * @param {{ withDefect?: boolean }} [opts]
 * @returns {string} the fixture main.cjs path
 */
function buildIsolatedDesktopRoot(root, opts = {}) {
  mkdirSync(join(root, 'node_modules', 'typescript', 'bin'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '@types', 'node'), { recursive: true });
  mkdirSync(join(root, 'apps', 'desktop'), { recursive: true });

  writeFileSync(
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    `'use strict';
const { spawnSync } = require('node:child_process');
const real = ${JSON.stringify(TSC)};
const r = spawnSync(process.execPath, [real, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`,
    'utf8'
  );

  writeFileSync(
    join(root, 'node_modules', '@types', 'node', 'package.json'),
    `${JSON.stringify({ name: '@types/node', version: '0.0.0-zcc-fixture', types: 'index.d.ts' }, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(
    join(root, 'node_modules', '@types', 'node', 'index.d.ts'),
    'declare const module: any;\ndeclare const require: any;\ndeclare const process: any;\n',
    'utf8'
  );

  // The hard prerequisite the gate checks before it will run anything.
  writeFileSync(
    join(root, 'apps', 'desktop', 'package.json'),
    `${JSON.stringify({ name: '@zcode-companion/desktop', version: '0.0.0', private: true, main: 'main.cjs' }, null, 2)}\n`,
    'utf8'
  );

  // Verbatim: the fixture is proven with the very project file the gate points at.
  writeFileSync(
    join(root, 'tsconfig.desktop.json'),
    readFileSync(DESKTOP_TSCONFIG, 'utf8'),
    'utf8'
  );

  const mainPath = join(root, 'apps', 'desktop', 'main.cjs');
  writeFileSync(mainPath, SYNTH_MAIN + (opts.withDefect === true ? PLANTED_DEFECT : ''), 'utf8');
  writeFileSync(join(root, 'apps', 'desktop', 'preload.cjs'), SYNTH_PRELOAD, 'utf8');
  return mainPath;
}

/**
 * @param {string} root
 */
function reclaim(root) {
  rmSync(root, { recursive: true, force: true });
  return existsSync(root);
}

describe('typecheck:desktop gate classification (F33)', () => {
  it('is a known, implemented gate — never UNKNOWN_GATE and never NOT_IMPLEMENTED', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'zcc-class-'));
    try {
      const r = await runNode([STAGE_GATE, 'typecheck:desktop', '--root', bare]);
      // The root is a bare temp dir, so the gate stops at its prerequisite (exit 4).
      // That alone proves classification: an unknown or not-implemented gate would
      // have answered 2 or 3 instead of reaching the prerequisite check.
      expect(combined(r), 'the gate must be classified, not unknown').not.toContain('UNKNOWN_GATE');
      expect(combined(r), 'the gate must be implemented, not a fail-closed stub').not.toContain('NOT_IMPLEMENTED');
      expect(r.code, combined(r)).toBe(4);
    } finally {
      expect(reclaim(bare), 'the temporary classification root must be reclaimed').toBe(false);
    }
  }, 60000);

  it('leaves the NOT_IMPLEMENTED set untouched (exit 3, still blocking)', async () => {
    for (const gate of ['lint', 'test:integration', 'test:mutations', 'test:e2e', 'build']) {
      const r = await runNode([STAGE_GATE, gate]);
      expect(r.code, `${gate} must still block release`).not.toBe(0);
      expect(combined(r), `${gate} must still be NOT_IMPLEMENTED`).toContain('NOT_IMPLEMENTED');
    }
  }, 120000);

  it('is wired into npm run ci, so desktop main/preload can turn the main chain red', () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    expect(
      manifest.scripts['typecheck:desktop'],
      'package.json must expose the new gate'
    ).toBe('node scripts/stage-gate.mjs typecheck:desktop');
    expect(
      manifest.scripts.ci,
      'ci must run typecheck:desktop, otherwise the desktop tree is still uncovered in CI'
    ).toContain('typecheck:desktop');
  });
});

describe('typecheck:desktop gate exit-code contract (F33)', () => {
  it('propagates the real tsc exit code instead of inventing one', async () => {
    const viaGate = await runNode([STAGE_GATE, 'typecheck:desktop']);
    const direct = await runNode([TSC, '--noEmit', '-p', DESKTOP_TSCONFIG]);
    expect(
      viaGate.code,
      `the gate must propagate tsc's own exit code. gate=${viaGate.code} direct=${direct.code}\n${combined(direct)}`
    ).toBe(direct.code);
  }, 600000);

  it('a root without apps/desktop/package.json fails closed: exit 4 + GATE_PREREQUISITE_MISSING', async () => {
    // A tsc entry point is present, so the gate can only pass here by refusing
    // to run: a "no project" state must never read as a clean typecheck.
    const bare = mkdtempSync(join(tmpdir(), 'zcc-desktop-noprereq-'));
    try {
      mkdirSync(join(bare, 'node_modules', 'typescript', 'bin'), { recursive: true });
      writeFileSync(join(bare, 'node_modules', 'typescript', 'bin', 'tsc'), 'process.exit(0);\n', 'utf8');
      const r = await runNode([STAGE_GATE, 'typecheck:desktop', '--root', bare], { timeoutMs: 60000 });
      expect(r.code, `a missing desktop project must block, not pass: ${combined(r)}`).toBe(4);
      expect(r.code, 'a missing prerequisite must not read as a type error').not.toBe(1);
      expect(r.code, 'a missing prerequisite must not read as a pass').not.toBe(0);
      expect(combined(r), 'the gate must name the missing prerequisite').toContain('GATE_PREREQUISITE_MISSING');
      expect(combined(r), 'the gate must name which file is missing').toContain('package.json');
    } finally {
      expect(reclaim(bare), 'the temporary no-prerequisite root must be reclaimed').toBe(false);
    }
  }, 60000);
});

describe('typecheck:desktop really covers the published desktop entry points (F33)', () => {
  it('tsc --listFilesOnly lists both main.cjs and preload.cjs (coverage only — not a pass claim)', () => {
    expect(existsSync(REAL_MAIN), 'the published main entry must exist').toBe(true);
    expect(existsSync(REAL_PRELOAD), 'the published preload entry must exist').toBe(true);
    expect(existsSync(DESKTOP_TSCONFIG), 'the desktop type project must exist').toBe(true);

    const listed = listedFiles();
    for (const entry of [REAL_MAIN, REAL_PRELOAD]) {
      const abs = toPosix(resolve(entry));
      expect(
        listed,
        `${toPosix(entry)} must be part of the desktop type project — otherwise F33 is not fixed`
      ).toContain(abs);
    }
  }, 600000);
});

/**
 * `--listFilesOnly` is used strictly as a coverage assertion. It proves the
 * files are compiled; it proves nothing about whether they are error-free, and
 * it must never be reported as a "typecheck passed" signal.
 * @returns {string[]}
 */
function listedFiles() {
  const out = execFileSync(process.execPath, [TSC, '--listFilesOnly', '-p', DESKTOP_TSCONFIG], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(toPosix);
}

describe('typecheck:desktop is neither tautologically green nor tautologically red (F33)', () => {
  it('红: a planted type error under apps/desktop/ turns the gate red and names the real file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zcc-desktop-red-'));
    try {
      buildIsolatedDesktopRoot(root, { withDefect: true });
      const r = await runNode([STAGE_GATE, 'typecheck:desktop', '--root', root]);
      expect(r.code, `the planted defect must turn the gate red: ${combined(r)}`).toBe(1);
      expect(combined(r), 'the gate must name the offending real file').toMatch(/apps[\\/]desktop[\\/]main\.cjs/);
      expect(combined(r), 'the gate must name the offending line').toMatch(/main\.cjs\(\d+,\d+\): error TS\d+/);
    } finally {
      expect(reclaim(root), 'the temporary red root must be reclaimed').toBe(false);
    }
  }, 300000);

  it('对照: the same isomorphic project WITHOUT the planted error exits 0 (proves not tautological)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zcc-desktop-control-'));
    try {
      buildIsolatedDesktopRoot(root, { withDefect: false });
      const r = await runNode([STAGE_GATE, 'typecheck:desktop', '--root', root]);
      // This is also the harness soundness proof: if the fixture itself were
      // broken (missing @types/node, a bad project file), the red case above
      // would have "passed" for a setup reason instead of for the planted defect.
      expect(r.code, `the control project must be clean, or the red case proves nothing: ${combined(r)}`).toBe(0);
    } finally {
      expect(reclaim(root), 'the temporary control root must be reclaimed').toBe(false);
    }
  }, 300000);

  it('绿: removing the planted error from the same command returns the gate to exit 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zcc-desktop-green-'));
    try {
      buildIsolatedDesktopRoot(root, { withDefect: true });
      const red = await runNode([STAGE_GATE, 'typecheck:desktop', '--root', root]);
      expect(red.code, `precondition: must be red first: ${combined(red)}`).toBe(1);

      const mainPath = join(root, 'apps', 'desktop', 'main.cjs');
      writeFileSync(mainPath, SYNTH_MAIN, 'utf8'); // the deliberate error is removed
      const green = await runNode([STAGE_GATE, 'typecheck:desktop', '--root', root]);
      expect(green.code, `the gate must return to exit 0 once the error is gone: ${combined(green)}`).toBe(0);
    } finally {
      expect(reclaim(root), 'the temporary green root must be reclaimed').toBe(false);
    }
  }, 600000);
});
