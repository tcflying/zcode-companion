/**
 * F32 contract test for the `pack:win` prerequisite.
 *
 * The defect (F32): `pack:win` only `required` that `apps/ui/dist/index.html`
 * EXISTS. A forgotten rebuild (complete-but-stale dist) and a build whose JS was
 * deleted afterwards (index.html survived, assets gone) both satisfied that
 * prerequisite, so electron-builder was spawned and packaged whatever was on disk.
 *
 * What this file proves, with real child processes and real exit codes — never by
 * string-scanning the gate's source:
 *  - (a) a dist without index.html is still exit 4 + GATE_PREREQUISITE_MISSING.
 *    The existing prerequisite semantics must not regress.
 *  - (b) a COMPLETE BUT STALE dist is refused, and the builder is never spawned.
 *    This is the F32 core counter-example and the one most likely to be deleted.
 *  - (c) a dist whose referenced bundle is missing is refused, builder never spawned.
 *  - control: a complete AND fresh dist passes, and the UI build runs *before* the
 *    builder — so the gate is not tautologically red.
 *  - a failing UI build fails the whole gate with its OWN exit code, not a
 *    swallowed 1, and the builder is never spawned.
 *  - `--print-targets` neither bypasses the prerequisite checks nor changes the
 *    vitest gates' print behaviour.
 *  - `build:ui` is exposed for manual re-runs, and adds no dependency.
 *
 * Every fixture carries a FULLY WORKABLE build toolchain (a real stub at the path
 * `join(resolve(root), 'node_modules/vite/bin/vite.js')`, a real apps/ui entry and
 * sources). So the negative cases below are refused by policy, not by accident of
 * a missing toolchain — which is what makes them worth keeping.
 *
 * F01 (AGENTS.md §3) is respected: this file never executes `test` or
 * `test:contract`. `test:unit --print-targets` is used instead: it performs the
 * full classification and exits 0 WITHOUT spawning vitest, so there is no fixed
 * point. No gate under test here starts vitest either.
 *
 * Provider-free: no Electron, no app-server, no model calls, no network, no ports.
 * Every child process is one this file spawned itself and reclaims on its own
 * handle. Stubs only append a line to a file inside the temp root; nothing leaves
 * the temp root and no credential ever appears in the log or the output.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const STAGE_GATE = join(PROJECT_ROOT, 'scripts', 'stage-gate.mjs');
const CALLS_LOG = '.zcc-calls.log';
const BUILD_EXIT_FILE = '.zcc-build-exit-code';

/** Two fixed instants so "stale" and "fresh" never depend on the clock. */
const T_OLD = new Date('2020-01-01T00:00:00Z');
const T_NEW = new Date('2020-06-01T00:00:00Z');

/** @typedef {RunResult & { calls: string[] }} GateRun */
/** @typedef {{ code: number | null, out: string, err: string, timedOut: boolean }} RunResult */
/** @typedef {{ timeoutMs?: number }} RunOptions */
/** @typedef {'no-index' | 'stale' | 'incomplete' | 'fresh' | 'build-fails'} FixtureKind */

/**
 * Runs a real child process with a bounded wait. On timeout it signals only the
 * handle it created itself and still waits for that close, so no test can leave a
 * detached grandchild behind.
 * @param {string[]} args
 * @param {RunOptions} [opts]
 * @returns {Promise<RunResult>}
 */
function runNode(args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120000;
  return new Promise((resolvePromise) => {
    let out = '';
    let err = '';
    let settled = false;
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
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

/** @param {{ out: string, err: string }} r */
const combined = (r) => r.out + r.err;

/** @param {string} p */
const toPosix = (p) => p.replace(/\\/g, '/');

const SRC_ENTRY_HTML = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><title>fixture source entry</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
`;

const SRC_MAIN_TSX = `const root = document.getElementById('root');
if (root !== null) root.textContent = 'fixture';
`;

/** @param {string} asset */
const distHtml = (asset) => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>fixture dist</title>
    <script type="module" crossorigin src="./assets/${asset}"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`;

/**
 * A faithful stand-in for `vite build` at the path the gate resolves
 * (`join(resolve(root), 'node_modules/vite/bin/vite.js')`, cwd = apps/ui): it reads
 * the real entry html, resolves every local reference against apps/ui, copies each
 * referenced source into dist/assets under a content-hashed name, rewrites the
 * html and writes dist/index.html. A `.zcc-build-exit-code` file in the root makes
 * it fail instead, which is how "the build itself failed" is exercised.
 * Written as an array of lines so no regex/backslash has to survive two levels of
 * string escaping.
 */
const BUILD_STUB = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const crypto = require('node:crypto');",
  'const root = path.resolve(__dirname, "..", "..", "..");',
  'const ui = path.join(root, "apps", "ui");',
  'const dist = path.join(ui, "dist");',
  `fs.appendFileSync(path.join(root, "${CALLS_LOG}"), "build\\n");`,
  `const exitFile = path.join(root, "${BUILD_EXIT_FILE}");`,
  'if (fs.existsSync(exitFile)) {',
  '  process.stderr.write("BUILD_STUB_FAIL\\n");',
  '  process.exit(Number.parseInt(fs.readFileSync(exitFile, "utf8").trim(), 10));',
  '}',
  'const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");',
  'fs.mkdirSync(path.join(dist, "assets"), { recursive: true });',
  'let out = html;',
  'const re = /(?:src|href)="([^"]+)"/g;',
  'for (const m of html.matchAll(re)) {',
  '  const ref = m[1];',
  '  if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\\/\\/|#)/.test(ref)) continue;',
  '  const src = path.resolve(ui, ref.replace(/^\\/+/, ""));',
  '  if (!fs.existsSync(src)) {',
  '    process.stderr.write("BUILD_STUB cannot resolve " + ref + "\\n");',
  '    process.exit(1);',
  '  }',
  '  const body = fs.readFileSync(src);',
  '  const ext = path.extname(src);',
  '  const digest = crypto.createHash("sha256").update(body).digest("hex").slice(0, 8);',
  '  const name = path.basename(src, ext) + "-" + digest + ext;',
  '  fs.writeFileSync(path.join(dist, "assets", name), body);',
  '  out = out.split(ref).join("./assets/" + name);',
  '}',
  'fs.writeFileSync(path.join(dist, "index.html"), out);',
  'process.stdout.write("BUILD_STUB_OK\\n");',
  'process.exit(0);'
].join('\n');

/** The real bin path of `pack:win` (apps/desktop/.../electron-builder/cli.js). */
const BUILDER_STUB = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const root = path.resolve(__dirname, "..", "..", "..", "..");',
  `fs.appendFileSync(path.join(root, "${CALLS_LOG}"), "builder\\n");`,
  'process.stdout.write("BUILDER_ADMITTED\\n");',
  'process.exit(0);'
].join('\n');

/**
 * @param {string} root
 * @param {string} rel slash-separated path relative to root
 * @param {unknown} value
 * @returns {void}
 */
function writeJson(root, rel, value) {
  writeFileSync(join(root, ...rel.split('/')), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Builds an isolated project root shaped like the real one as far as `pack:win`
 * is concerned. Every kind carries a complete desktop prerequisite set AND a
 * complete, workable UI build toolchain; only the dist differs.
 * @param {string} root
 * @param {FixtureKind} kind
 * @returns {void}
 */
function buildFixture(root, kind) {
  // apps/desktop prerequisites — all four `required` entries except dist.
  mkdirSync(join(root, 'apps', 'desktop', 'node_modules', 'electron'), { recursive: true });
  mkdirSync(join(root, 'apps', 'desktop', 'node_modules', 'electron-builder'), { recursive: true });
  writeJson(root, 'apps/desktop/package.json', { name: '@zcode-companion/desktop', version: '0.0.0', private: true });
  writeJson(root, 'apps/desktop/node_modules/electron/package.json', { name: 'electron', version: '44.4.5' });
  writeJson(root, 'apps/desktop/node_modules/electron-builder/package.json', { name: 'electron-builder', version: '0.0.0' });
  writeFileSync(
    join(root, 'apps', 'desktop', 'node_modules', 'electron-builder', 'cli.js'),
    BUILDER_STUB,
    'utf8'
  );

  // UI build inputs + the real `vite build` bin path the gate resolves.
  mkdirSync(join(root, 'node_modules', 'vite', 'bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'vite', 'bin', 'vite.js'), BUILD_STUB, 'utf8');
  mkdirSync(join(root, 'apps', 'ui', 'src'), { recursive: true });
  writeJson(root, 'apps/ui/package.json', { name: '@zcode-companion/ui', version: '0.0.0', private: true });
  writeFileSync(join(root, 'apps', 'ui', 'index.html'), SRC_ENTRY_HTML, 'utf8');
  writeFileSync(join(root, 'apps', 'ui', 'src', 'main.tsx'), SRC_MAIN_TSX, 'utf8');

  const distAssets = join(root, 'apps', 'ui', 'dist', 'assets');
  mkdirSync(distAssets, { recursive: true });
  /** @type {string[]} */
  const distFiles = [];

  if (kind === 'no-index') {
    // (a) The dist exists but the entry html is gone.
    const js = join(distAssets, 'index-AAA.js');
    writeFileSync(js, 'export const a = 1;\n', 'utf8');
    distFiles.push(js);
  } else if (kind === 'stale') {
    // (b) COMPLETE but built from older sources: every referenced asset exists,
    // and the dist is older than the UI inputs. The F32 core counter-example.
    const js = join(distAssets, 'index-STALE.js');
    writeFileSync(js, 'export const stale = true;\n', 'utf8');
    const html = join(root, 'apps', 'ui', 'dist', 'index.html');
    writeFileSync(html, distHtml('index-STALE.js'), 'utf8');
    distFiles.push(js, html);
  } else if (kind === 'incomplete') {
    // (c) index.html survived, the bundle it references did not.
    const html = join(root, 'apps', 'ui', 'dist', 'index.html');
    writeFileSync(html, distHtml('index-GONE.js'), 'utf8');
    distFiles.push(html);
  } else {
    // fresh / build-fails: complete AND newer than the inputs.
    const js = join(distAssets, 'index-NEW.js');
    writeFileSync(js, 'export const fresh = true;\n', 'utf8');
    const html = join(root, 'apps', 'ui', 'dist', 'index.html');
    writeFileSync(html, distHtml('index-NEW.js'), 'utf8');
    distFiles.push(js, html);
  }

  if (kind === 'build-fails') {
    writeFileSync(join(root, BUILD_EXIT_FILE), '7\n', 'utf8');
  }

  // Fix the clock: only the relative order matters, and it must not depend on how
  // fast this test file happens to write the fixture.
  const inputsNewest = kind === 'stale' ? T_NEW : T_OLD;
  const distOldest = kind === 'stale' ? T_OLD : T_NEW;
  for (const rel of ['apps/ui/index.html', 'apps/ui/package.json', 'apps/ui/src/main.tsx']) {
    const abs = join(root, ...rel.split('/'));
    utimesSync(abs, inputsNewest, inputsNewest);
  }
  for (const file of distFiles) utimesSync(file, distOldest, distOldest);
}

/**
 * @param {string} root
 * @returns {string[]} the ordered call record ("build" / "builder" lines)
 */
function readCalls(root) {
  const log = join(root, CALLS_LOG);
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Runs the real gate against a freshly built fixture and returns the run together
 * with the stubs' call record — the record is the proof of what the gate spawned.
 * @param {FixtureKind} kind
 * @returns {Promise<GateRun>}
 */
async function runGateOnFixture(kind) {
  const root = mkdtempSync(join(tmpdir(), `zcc-pack-${kind}-`));
  try {
    buildFixture(root, kind);
    const r = await runNode([STAGE_GATE, 'pack:win', '--root', root]);
    return { ...r, calls: readCalls(root) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function reclaim(root) {
  rmSync(root, { recursive: true, force: true });
  return existsSync(root);
}

describe('pack:win 前置检查：残缺 / 陈旧的 dist 一律拒绝 (F32)', () => {
  it('(a) 缺 dist/index.html 仍是 exit 4 + GATE_PREREQUISITE_MISSING —— 现有语义不回退', async () => {
    const r = await runGateOnFixture('no-index');
    expect(r.code, combined(r)).toBe(4);
    expect(combined(r)).toContain('GATE_PREREQUISITE_MISSING');
    expect(combined(r)).toContain('index.html');
    expect(r.calls, '前提不满足时不得 spawn 任何构建或打包').toEqual([]);
  }, 120000);

  it('(b) 关键负例：完整但陈旧的 dist 必须被拒绝，且 builder 从未被 spawn', async () => {
    const r = await runGateOnFixture('stale');
    expect(combined(r), '陈旧产物必须是前置检查拒绝，不是让 builder 蒙混过关').toContain('GATE_PREREQUISITE_MISSING');
    expect(combined(r), '拒绝原因必须点名「陈旧」').toContain('STALE_UI_DIST');
    expect(r.code, combined(r)).toBe(4);
    expect(r.code, '不得新增退出码语义').not.toBe(0);
    expect(r.code, '不得新增退出码语义').not.toBe(1);
    expect(r.calls, '陈旧 dist 到达 builder 就是 F32 未修复').not.toContain('builder');
    expect(r.calls, '陈旧 dist 被拒时不应先跑构建').not.toContain('build');
  }, 120000);

  it('(c) 有 index.html 但 assets/*.js 缺失必须被拒绝，且 builder 从未被 spawn', async () => {
    const r = await runGateOnFixture('incomplete');
    expect(combined(r)).toContain('GATE_PREREQUISITE_MISSING');
    expect(combined(r), '拒绝原因必须点名「残缺」').toContain('INCOMPLETE_UI_DIST');
    expect(combined(r), '必须指名缺失的资源').toContain('index-GONE.js');
    expect(r.code, combined(r)).toBe(4);
    expect(r.calls, '残缺 dist 到达 builder 就是残包').not.toContain('builder');
  }, 120000);

  it('对照：完整且新鲜的 dist 才通过，且构建先于 builder —— 证明门不是恒红', async () => {
    const r = await runGateOnFixture('fresh');
    expect(combined(r), `完整新鲜的产物必须放行：${JSON.stringify(r.calls)}`).not.toContain('GATE_PREREQUISITE_MISSING');
    expect(r.code, combined(r)).toBe(0);
    expect(r.calls, '必须先跑 UI 构建，再跑 builder').toEqual(['build', 'builder']);
    expect(r.out, 'builder 确实被 admit 了').toContain('BUILDER_ADMITTED');
    expect(r.out, '构建前置确实执行了').toContain('BUILD_STUB_OK');
  }, 120000);

  it('构建失败 → 整门非 0，退出码原样透传，builder 未被 spawn', async () => {
    const r = await runGateOnFixture('build-fails');
    expect(r.code, `构建失败必须整门失败且不吞退出码：${combined(r)}`).toBe(7);
    expect(r.code, '构建失败不得被改写成 1').not.toBe(1);
    expect(r.calls, '构建失败时 builder 绝不能被 spawn').toEqual(['build']);
    expect(r.out, '失败的构建不该被 admit 成成功').not.toContain('BUILDER_ADMITTED');
  }, 120000);
});

describe('pack:win 的既有分类与前置语义未被本卡破坏 (F32)', () => {
  it('裸 root：全部前提缺失 → exit 4 + GATE_PREREQUISITE_MISSING，不退化成 NOT_IMPLEMENTED', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'zcc-pack-bare-'));
    try {
      const r = await runNode([STAGE_GATE, 'pack:win', '--root', bare], { timeoutMs: 60000 });
      expect(combined(r)).not.toContain('NOT_IMPLEMENTED');
      expect(r.code, combined(r)).toBe(4);
      expect(combined(r)).toContain('GATE_PREREQUISITE_MISSING');
    } finally {
      expect(reclaim(bare), '临时裸 root 必须回收').toBe(false);
    }
  }, 60000);

  it('--print-targets 不能绕过 pack:win 的前置检查', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zcc-pack-print-'));
    try {
      buildFixture(root, 'stale');
      const r = await runNode([STAGE_GATE, 'pack:win', '--root', root, '--print-targets']);
      expect(r.code, `--print-targets 不是绕过前置检查的后门：${combined(r)}`).toBe(4);
      expect(combined(r)).toContain('STALE_UI_DIST');
      expect(readCalls(root), '--print-targets 下不得 spawn 任何东西').toEqual([]);
    } finally {
      expect(reclaim(root), '临时 root 必须回收').toBe(false);
    }
  }, 120000);

  it('vitest 门的 --print-targets 语义不变：打印真实目标目录、exit 0、不启动 vitest', async () => {
    // R5 形态。用 test:unit 而不是 test/test:contract：后者是本文件所在工程的
    // vitest 目标，真实执行会无界派生进程（F01）。
    const r = await runNode([STAGE_GATE, 'test:unit', '--print-targets'], { timeoutMs: 60000 });
    expect(r.code, combined(r)).toBe(0);
    expect(toPosix(r.out).trim()).toContain(toPosix(join(PROJECT_ROOT, 'tests', 'unit')));
    expect(combined(r), '--print-targets 不启动 vitest').not.toContain('RUN');
  }, 60000);

  it('build:ui 已暴露为人工复跑入口，走同一道门，且不新增依赖', () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    expect(
      manifest.scripts['build:ui'],
      '陈旧产物的补救路径必须可人工复跑：npm run build:ui'
    ).toBe('node scripts/stage-gate.mjs build:ui');
    expect(
      Object.keys(manifest.dependencies ?? {}),
      'build:ui 只接线，不引入运行期依赖'
    ).toEqual([]);
    expect(Object.keys(manifest.devDependencies ?? {}).sort()).toEqual([
      '@types/node', 'electron', 'react', 'react-dom', 'typescript', 'vite', 'vitest'
    ]);
    expect(
      manifest.scripts.ci,
      'CI 链不含打包/构建产物，不受本卡影响'
    ).not.toContain('build:ui');
    expect(manifest.scripts.ci).not.toContain('pack:win');
  });

  it('build:ui 单独可跑：缺界面入口 → exit 4 + GATE_PREREQUISITE_MISSING（不让 vite 崩）', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'zcc-build-ui-noprereq-'));
    try {
      const r = await runNode([STAGE_GATE, 'build:ui', '--root', bare], { timeoutMs: 60000 });
      expect(r.code, combined(r)).toBe(4);
      expect(combined(r)).toContain('GATE_PREREQUISITE_MISSING');
      expect(combined(r)).toContain('build:ui');
    } finally {
      expect(reclaim(bare), '临时 root 必须回收').toBe(false);
    }
  }, 60000);
});
