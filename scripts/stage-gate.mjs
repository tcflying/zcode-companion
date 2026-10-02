#!/usr/bin/env node
/**
 * stage-gate.mjs — I01 release stage gate / test category classifier.
 *
 * Single classification entry for the scripts contract. Implemented gates run
 * their real command and propagate its exit code. Everything not yet built is
 * fail-closed: prints NOT_IMPLEMENTED and exits non-zero (blocking release).
 * No console-PASS fakes, no allowNoTests anywhere.
 *
 * Implemented (provider-free only — no official app-server, no model calls,
 * no production services/databases):
 *   test           vitest run (tests/unit + tests/contract)
 *   test:unit      vitest run tests/unit
 *   test:contract  vitest run tests/contract
 *   typecheck:apps tsc --noEmit -p apps/ui/tsconfig.json  (the apps/ tree is a
 *                 separate nested project with its own tsconfig/package.json;
 *                 it is type-checked through its own project, never absorbed
 *                 into the root Node/nodenext project. See the F05 note below.
 *                 Wired into `npm run ci` (Q1): a UI type error must be able to
 *                 turn the main chain red, so this gate is not a manual-only
 *                 gate. If apps/ui/tsconfig.json is missing the gate fails with
 *                 APPS_PROJECT_NOT_CREATED (exit 4), never a silent pass.)
 *   pack:win       electron-builder --win portable (I10). Requires the desktop
 *                 app's own node_modules (electron + electron-builder, installed
 *                 under apps/desktop) plus apps/ui/dist, which ships as one of
 *                 the package's extraResources. A missing prerequisite is exit 4
 *                 GATE_PREREQUISITE_MISSING, never a "skipped" pass.
 *   verify:package runs the built portable exe from a **cwd outside the repo**,
 *                 with the package's own runtime (driver=none, synthetic key):
 *                 it must render and serve GET /v1/models through app://.
 *                 Artifact missing / oversized / not self-contained → exit 1.
 *                 Also requires the desktop app's own node_modules
 *                 (@electron/asar, declared in apps/desktop/package.json), since
 *                 the root install never covers apps/desktop.
 *
 * NOT_IMPLEMENTED (exit 3, block release):
 *   lint, test:integration, test:mutations, test:e2e, build
 *
 * Exit codes:
 *   0        gate passed
 *   1        gate ran and failed (propagated command exit code may also surface)
 *   2        USAGE / UNKNOWN_GATE / UNKNOWN_OPTION
 *   3        NOT_IMPLEMENTED gate or EMPTY_CATEGORY
 *   4        APPS_PROJECT_NOT_CREATED — the apps/ nested project config a gate
 *            depends on does not exist. Deliberately NOT the same code as 0
 *            (pass) and NOT 1 (type error): a missing project must never be
 *            confused with a clean run, and it must never be silently skipped.
 *
 * --print-targets
 *   Runs the FULL classification (gate known, every selected category proven
 *   non-empty) and prints the resolved absolute target directories, then exits
 *   0 WITHOUT spawning vitest.
 *
 *   Why it exists (F01): tests/contract/gates.test.mjs is itself a vitest
 *   target of `test:contract` and `test`. If that file executed those two gates
 *   for real, each execution would start vitest over the very file doing the
 *   asserting, deriving test processes without bound (measured: 16+ own
 *   descendants after 8s, still growing, gate never returning). --print-targets
 *   lets the contract test assert the real classification and the real target
 *   selection on the real project root, while real vitest execution of those
 *   same gates is asserted against an isolated temporary test root.
 *
 *   It is strictly a reporting/diagnostic path for one run: it performs the
 *   same gate validation and the same EMPTY_CATEGORY check as a real run, and
 *   every other invocation still spawns the real vitest CLI.
 *
 * Usage: node scripts/stage-gate.mjs <gate> [--root <project-root>] [--print-targets]
 */
import { spawn } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** @type {Record<string, string>} */
const IMPLEMENTED = {
  'test:unit': 'tests/unit',
  'test:contract': 'tests/contract'
};
const CATEGORY_DIRS = Object.values(IMPLEMENTED);
const VITEST_RUN_ALL = 'test';

// Non-vitest implemented gates: a real command with a real propagated exit code.
/** @type {Record<string, { bin: string, args: string[], required?: string[], cwd?: string }>} */
const COMMANDS = {
  'typecheck:apps': {
    bin: 'node_modules/typescript/bin/tsc',
    args: ['--noEmit', '-p', 'apps/ui/tsconfig.json'],
    // F05/Q1: apps/ is a separate nested project. Its project config is a hard
    // precondition of this gate and is checked explicitly below, so "the apps
    // project was never created" can never be reported as a passing typecheck.
    required: ['apps/ui/tsconfig.json']
  },
  // I10：apps/ui 自己的 vitest。UI01 把 apps/ 隔离出根 vitest 工程是有意裁定
  // （根 vitest.config.ts 不动，保持原样），但**隔离不等于免检**——
  // `desktopBridge.test.ts` 守着「桥缺席时不假装有桌面」这条产品承诺，不跑就没人守。
  // 按裁定接入 ci：它跑自己的 vitest，走真实退出码。
  'test:ui': {
    bin: 'node_modules/vitest/vitest.mjs',
    args: ['run', '--root', 'apps/ui'],
    // 隔离工程的项目配置进 required：缺了就 exit 1，不许「没有测试所以通过」。
    required: ['apps/ui/vitest.config.ts', 'apps/ui/package.json']
  },
  // I10 出包：electron-builder 出 portable exe。界面产物是 extraResources 的一份，
  // 少了它包就不自足——所以它进 required，缺了就 exit 1 而不是打个残包。
  'pack:win': {
    bin: 'apps/desktop/node_modules/electron-builder/cli.js',
    args: ['--win', 'portable', '--projectDir', 'apps/desktop'],
    required: [
      'apps/desktop/package.json',
      'apps/desktop/node_modules/electron/package.json',
      'apps/desktop/node_modules/electron-builder/package.json',
      'apps/ui/dist/index.html'
    ]
  },
  // I10 验包：产物存在 + 体积达标 + 从包外 cwd 启动 + 渲染成功 + /v1 转发可达。
  'verify:package': {
    bin: 'scripts/verify-package.mjs',
    args: [],
    // 读产物 asar 用的是 apps/desktop 自己的 @electron/asar（显式 devDependency，
    // 不是 electron-builder 的传递依赖）。它没装 = 构建前提没备齐，与 pack:win
    // 同一个原因码 exit 4，不允许跑到脚本里再含糊地报一句「读不了 asar」。
    required: [
      'apps/desktop/package.json',
      'apps/desktop/node_modules/@electron/asar/package.json',
      'scripts/verify-package.mjs'
    ]
  }
};
const NOT_IMPLEMENTED = new Set([
  'lint',
  'test:integration',
  'test:mutations',
  'test:e2e',
  'build'
]);

/**
 * Only used before any resource (child process, stream) is acquired.
 *
 * `@returns {never}` is load-bearing, not decoration: every caller below relies
 * on "after this call nothing else runs". Without the annotation TypeScript
 * keeps the narrowing at the call site open and reports a cascade of
 * "'gate' is possibly 'undefined'" / "Type 'undefined' cannot be used as an
 * index type" under --checkJs true, which is exactly the class of defensive
 * gap the F01 rewrite was supposed to close.
 *
 * @param {number} code
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const USAGE = 'USAGE: node scripts/stage-gate.mjs <gate> [--root <project-root>] [--print-targets]';

/**
 * @param {string[]} argv
 * @returns {{ gate: string | undefined, root: string, printTargets: boolean }}
 */
function parseArgs(argv) {
  /** @type {{ gate: string | undefined, root: string, printTargets: boolean }} */
  const parsed = { gate: undefined, root: process.cwd(), printTargets: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--root') {
      const value = argv[i + 1];
      if (value === undefined) fail(2, `${USAGE} (--root requires a value)`);
      parsed.root = value;
      i++;
    } else if (arg === '--print-targets') {
      parsed.printTargets = true;
    } else if (arg === '-h' || arg === '--help') {
      fail(2, USAGE);
    } else if (arg.startsWith('--')) {
      fail(2, `UNKNOWN_OPTION: ${arg}\n${USAGE}`);
    } else if (parsed.gate === undefined) {
      parsed.gate = arg;
    } else {
      fail(2, `UNEXPECTED_ARGUMENT: ${arg}\n${USAGE}`);
    }
  }
  return parsed;
}

/**
 * @param {string} root
 * @param {string} dir
 */
function categoryHasTests(root, dir) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return false;
  return readdirSync(abs).some((f) => /\.test\.[cm]?[jt]s$/.test(f));
}

/**
 * Full classification. Returns the vitest target directories, or exits.
 * @param {string} gate
 * @param {string} root
 * @returns {string[]}
 */
function resolveTargets(gate, root) {
  const single = gate === VITEST_RUN_ALL ? undefined : IMPLEMENTED[gate];
  if (gate !== VITEST_RUN_ALL && single === undefined) fail(2, `UNKNOWN_GATE: ${gate}`);
  const dirs = single === undefined ? CATEGORY_DIRS : [single];
  // Empty category must be non-zero: verify test files exist before invoking
  // vitest. This runs identically for a real run and for --print-targets.
  const missing = dirs.filter((dir) => !categoryHasTests(root, dir));
  if (missing.length > 0) {
    fail(3, `EMPTY_CATEGORY: no *.test.* files for ${missing.join(', ')} under root ${resolve(root)}`);
  }
  return dirs;
}

const { gate, root, printTargets } = parseArgs(process.argv.slice(2));
if (gate === undefined) fail(2, USAGE);
if (NOT_IMPLEMENTED.has(gate)) {
  fail(3, `NOT_IMPLEMENTED: ${gate} (fail-closed: blocks release until implemented)`);
}
if (gate !== VITEST_RUN_ALL && !(gate in IMPLEMENTED) && !(gate in COMMANDS)) {
  fail(2, `UNKNOWN_GATE: ${gate}`);
}

if (gate in COMMANDS) {
  // F05: apps/ is a separate nested project (own package.json + tsconfig.json,
  // moduleResolution "bundler", DOM lib). It is type-checked by the real tsc
  // through its own project, with the real exit code propagated. It is never
  // folded into the root Node/nodenext project: that would both duplicate a
  // foreign project config and make the I01 typecheck gate depend on another
  // workstream's in-flight sources. packages/** is the root project's own
  // source root and IS inside tsconfig.json's include.
  const command = COMMANDS[gate];
  if (command === undefined) fail(1, `GATE_ERROR: no command definition for ${gate}`);
  const { bin, args, required, cwd } = command;
  // Q1: the gate is wired into `npm run ci`, so "the project this gate needs is
  // not there" must be loud, distinct and blocking — never a silent skip and
  // never indistinguishable from a clean typecheck.
  //
  // 原因码按门区分：typecheck:apps 缺的是那个**独立工程**的配置（APPS_PROJECT_NOT_CREATED）；
  // 打包 / 验包缺的是构建前提（GATE_PREREQUISITE_MISSING）。两者都 exit 4，
  // 但混用同一个词会让「apps 工程没建」和「electron-builder 没装」看起来像同一件事。
  for (const rel of required ?? []) {
    const requiredPath = join(resolve(root), rel);
    if (existsSync(requiredPath)) continue;
    if (gate === 'typecheck:apps') {
      fail(4, `APPS_PROJECT_NOT_CREATED: ${gate} requires ${requiredPath} under root ${resolve(root)}. `
        + 'The apps/ tree is a separate nested project that is deliberately NOT part of the root '
        + 'tsconfig.json, so this gate cannot pass without it.');
    }
    fail(4, `GATE_PREREQUISITE_MISSING: ${gate} requires ${requiredPath} under root ${resolve(root)}. `
      + '先补齐该前提（见 docs/USAGE.md「桌面程序」章）再跑这道门；不允许跳过。');
  }
  const script = join(resolve(root), bin);
  if (!existsSync(script)) {
    fail(1, `GATE_ERROR: ${gate} command not found: ${script}`);
  }
  const child = spawn(process.execPath, [script, ...args], {
    cwd: join(resolve(root), cwd ?? ''),
    env: process.env,
    stdio: 'inherit'
  });
  child.on('error', (e) => fail(1, `GATE_ERROR: ${e.message}`));
  child.on('close', (code) => process.exit(code ?? 1));
} else {
  const vitestTargets = resolveTargets(gate, root);

  if (printTargets) {
    for (const dir of vitestTargets) process.stdout.write(`${resolve(root, dir)}\n`);
    process.exit(0);
  }

  /** @type {string | undefined} */
  let vitestBin;
  try {
    // vitest does not export ./vitest.mjs via its exports map; resolve the
    // declared bin path from the package manifest instead.
    const manifestPath = require.resolve('vitest/package.json');
    const manifest = require('vitest/package.json');
    vitestBin = join(dirname(manifestPath), manifest.bin.vitest);
  } catch (e) {
    fail(1, `GATE_ERROR: cannot resolve vitest CLI: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (vitestBin === undefined) fail(1, 'GATE_ERROR: vitest CLI path could not be resolved');

  const child = spawn(process.execPath, [vitestBin, 'run', ...vitestTargets], {
    cwd: resolve(root),
    env: process.env,
    stdio: 'inherit'
  });
  child.on('error', (e) => fail(1, `GATE_ERROR: ${e.message}`));
  child.on('close', (code) => process.exit(code ?? 1));
}
