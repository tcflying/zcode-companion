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
 *   typecheck:desktop
 *                 tsc --noEmit -p tsconfig.desktop.json (F33). The published
 *                 Electron main process (main.cjs) and preload bridge
 *                 (preload.cjs) are CommonJS .cjs sources and used to sit in
 *                 **no** type project at all: the root project's include
 *                 excludes apps/ by the F05 ruling and typecheck:apps only
 *                 covers apps/ui, so their only "coverage" was whichever test
 *                 happened to string-scan them. Same nested-project shape as
 *                 typecheck:apps — its own project config, hard prerequisite,
 *                 exit 4 when apps/desktop/package.json is missing, never a
 *                 silent pass. Wired into `npm run ci` (Q1).
 *   pack:win       electron-builder --win portable (I10). Requires the desktop
 *                 app's own node_modules (electron + electron-builder, installed
 *                 under apps/desktop) plus apps/ui/dist, which ships as one of
 *                 the package's extraResources. A missing prerequisite is exit 4
 *                 GATE_PREREQUISITE_MISSING, never a "skipped" pass.
 *                 F32: a prerequisite that merely *exists* is not a prerequisite
 *                 that is *usable*. apps/ui/dist is only accepted when it is
 *                 COMPLETE (every local asset index.html references really is on
 *                 disk) and FRESH (no UI input file is newer than the oldest
 *                 dist output), so a forgotten rebuild — or a build whose JS was
 *                 deleted afterwards while index.html survived — can no longer be
 *                 admitted and packaged. Both rejections are exit 4 under the
 *                 existing GATE_PREREQUISITE_MISSING reason code (no new code is
 *                 introduced), and both happen BEFORE anything is spawned, so the
 *                 builder never sees a stale or broken dist. Only after those two
 *                 checks does the gate run the real UI build (build:ui) and then
 *                 hand off to electron-builder.
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
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** @type {Record<string, string>} */
const IMPLEMENTED = {
  'test:unit': 'tests/unit',
  'test:contract': 'tests/contract'
};
const CATEGORY_DIRS = Object.values(IMPLEMENTED);
const VITEST_RUN_ALL = 'test';

/**
 * F32 界面产物准入规格。用声明式字段挂在门条目上，而不是把 gate 名写死在
 * 校验逻辑里，这样新增同形门时只加数据、不改控制流。
 * @typedef {Object} VerifyDistSpec
 * @property {string} dir 产物目录（相对 root）。
 * @property {string} entry 入口 HTML（相对 dir）。
 * @property {string[]} inputs 界面输入（文件或目录，相对 root）——比 dist 产物新的输入即判定陈旧。
 * @property {string[]} [exclude] inputs 里要跳过的子树（相对 root），例如产物目录自身与 node_modules。
 */

/**
 * @typedef {Object} GateCommand
 * @property {string} bin 相对 root 的 bin 路径（join(resolve(root), bin) 可解析）。
 * @property {string[]} args 传给 bin 的参数。
 * @property {string[]} [required] 硬前提（相对 root），缺一即 exit 4。
 * @property {string} [cwd] 子进程工作目录（相对 root）。
 * @property {string[]} [pre] 先于本命令串行执行的门名。任一非零即整门失败且退出码原样透传。
 * @property {VerifyDistSpec} [verifyDist] 产物准入检查：残缺或陈旧即 exit 4，且发生在任何 spawn 之前。
 */

// Non-vitest implemented gates: a real command with a real propagated exit code.
/** @type {Record<string, GateCommand>} */
const COMMANDS = {
  'typecheck:apps': {
    bin: 'node_modules/typescript/bin/tsc',
    args: ['--noEmit', '-p', 'apps/ui/tsconfig.json'],
    // F05/Q1: apps/ is a separate nested project. Its project config is a hard
    // precondition of this gate and is checked explicitly below, so "the apps
    // project was never created" can never be reported as a passing typecheck.
    required: ['apps/ui/tsconfig.json']
  },
  // F33：发布桌面 main.cjs / preload.cjs 过去**不在任何类型工程里**——根 tsconfig.json
  // 的 include 不含 apps/**（F05 的隔离裁定），typecheck:apps 只查 apps/ui。于是两个入口
  // 的"被检查"完全依赖某个测试碰巧字符串扫描到它们。apps/desktop 同样是一个带自己
  // package.json 的独立嵌套工程，因此走自己的 tsconfig.desktop.json，不并入根工程、
  // 也不并入 apps/ui 工程。与 typecheck:apps 同形：项目配置缺失 = exit 4，不许静默跳过。
  'typecheck:desktop': {
    bin: 'node_modules/typescript/bin/tsc',
    args: ['--noEmit', '-p', 'tsconfig.desktop.json'],
    required: ['apps/desktop/package.json']
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
  // F32：出包前的界面构建。bin 用**相对产品根**的路径（join(resolve(root), bin) 正好解析到），
  // cwd=apps/ui —— 等价于 R8 的人工复跑形态 `node ../../node_modules/vite/bin/vite.js build`，
  // 但门内走的是既有 COMMANDS 结构：不新增 CLI 选项、不改 parseArgs、不硬编码绝对路径、不改 Vite 配置。
  // 界面入口缺失是 exit 4 前置检查，绝不允许 vite 自己崩出一段 build error 当成「构建失败」——
  // 「项目还没建好」和「构建跑挂了」必须是两种可分辨的原因码。
  'build:ui': {
    bin: 'node_modules/vite/bin/vite.js',
    args: ['build'],
    cwd: 'apps/ui',
    required: ['apps/ui/index.html', 'apps/ui/package.json']
  },
  // I10 出包：electron-builder 出 portable exe。界面产物是 extraResources 的一份，
  // 少了它包就不自足——所以它进 required，缺了就 exit 1 而不是打个残包。
  //
  // F32：光「存在」不构成可用前提。verifyDist 在任何 spawn 之前拒绝残缺/陈旧 dist，
  // pre 串上真实构建（build:ui），构建非零即整门失败、退出码不吞、builder 不被 spawn。
  'pack:win': {
    bin: 'apps/desktop/node_modules/electron-builder/cli.js',
    args: ['--win', 'portable', '--projectDir', 'apps/desktop'],
    pre: ['build:ui'],
    verifyDist: {
      dir: 'apps/ui/dist',
      entry: 'index.html',
      inputs: ['apps/ui'],
      exclude: ['apps/ui/dist', 'apps/ui/node_modules']
    },
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

/** dist/index.html 里引用的本地资源：src / href 属性值。 */
const DIST_ASSET_REF = /(?:src|href)\s*=\s*"([^"]+)"/g;
/** 明确不是磁盘产物的引用：绝对 URL、协议相对 URL、内联 data:、纯锚点。 */
const DIST_NON_FILE_REF = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/|#)/;

/**
 * 递归收集 subtree 下所有文件的绝对路径。目录不存在返回空数组。
 * @param {string} dir
 * @returns {string[]}
 */
function filesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, name.name);
      if (name.isDirectory()) walk(abs);
      else if (name.isFile()) out.push(abs);
    }
  };
  if (!existsSync(dir)) return out;
  walk(dir);
  return out;
}

/**
 * 把若干输入（文件或目录，目录递归展开到文件）摊平成一条文件列表，
 * 并剔除 exclude 命中的子树。**目录必须展开**：目录自身的 mtime 只在增删条目时
 * 变化，拿它判新鲜度会把「刚改过 src 里的文件」整个漏掉。
 * @param {string} root
 * @param {string[]} rels
 * @param {string[]} exclude
 * @returns {string[]}
 */
function expandFiles(root, rels, exclude) {
  const skipped = exclude.map((rel) => resolve(root, rel));
  /** @type {string[]} */
  const out = [];
  for (const rel of rels) {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) continue;
    const candidates = statSync(abs).isDirectory() ? filesUnder(abs) : [abs];
    for (const file of candidates) {
      if (skipped.some((prefix) => file.startsWith(prefix + sep))) continue;
      out.push(file);
    }
  }
  return out;
}

/**
 * @param {string} root
 * @param {string[]} rels
 * @param {string[]} exclude
 * @returns {number}
 */
function newestMtimeUnder(root, rels, exclude) {
  return expandFiles(root, rels, exclude)
    .reduce((max, f) => Math.max(max, statSync(f).mtimeMs), Number.NEGATIVE_INFINITY);
}

/**
 * 产物子树里最旧的文件的修改时间（ms）。**这里不能再套用 inputs 的 exclude**：
 * 排除项本来就是为了把产物目录从输入侧剔掉，拿它去扫产物会把产物自己剔成空集，
 * 于是「取最旧」永远得到 +Infinity，陈旧检查会恒为通过。
 * 之所以取「最旧」而不是最新：一次构建要么整体写完，要么中途夭折；取最旧能让
 * 半截产物也被判成不可用。
 * @param {string} root
 * @param {string} distAbs
 * @returns {number}
 */
function oldestMtimeUnder(root, distAbs) {
  const times = expandFiles(root, [distAbs], []).map((f) => statSync(f).mtimeMs);
  if (times.length === 0) return Number.POSITIVE_INFINITY;
  return times.reduce((min, t) => Math.min(min, t), Number.POSITIVE_INFINITY);
}

/**
 * F32：界面产物准入。`existsSync` 只能证明 dist 还在，不能证明它还能用——
 * 改完源码忘了重 build（陈旧）或 build 完 JS 被删而 index.html 仍在（残缺），
 * 两种都会让旧的门把一份不可用的界面打进包。这里在**任何 spawn 之前**只读地判定：
 *   1. 完整性：dist/index.html 引用的每一个本地资源都真实存在；
 *   2. 新鲜度：没有任何界面输入比产物目录里最旧的一个文件更新。
 * 两者都不满足可用前提，因此与"前提缺失"同族：exit 4 + GATE_PREREQUISITE_MISSING，
 * 不新增退出码、不引入"跳过"语义。
 * @param {string} root
 * @param {string} gate
 * @param {VerifyDistSpec} spec
 * @returns {void}
 */
function verifyBuiltDist(root, gate, spec) {
  const distAbs = resolve(root, spec.dir);
  const entryAbs = join(distAbs, spec.entry);
  const html = readFileSync(entryAbs, 'utf8');

  /** @type {string[]} */
  const refs = [];
  for (const match of html.matchAll(DIST_ASSET_REF)) {
    const raw = (match[1] ?? '').trim();
    if (raw === '' || DIST_NON_FILE_REF.test(raw)) continue;
    refs.push(raw);
  }

  if (refs.length === 0) {
    fail(4, `GATE_PREREQUISITE_MISSING: INCOMPLETE_UI_DIST: ${gate} 的产物入口 ${entryAbs} `
      + '没有引用任何本地构建产物，这不是一次真实的 UI 构建输出；先重新构建界面再跑本门。');
  }

  /** @type {string[]} */
  const missing = [];
  for (const ref of refs) {
    const withoutQuery = (ref.split('?')[0] ?? ref).split('#')[0] ?? ref;
    const target = resolve(distAbs, withoutQuery.replace(/^\/+/, ''));
    if (!existsSync(target)) missing.push(`${ref} -> ${target}`);
  }
  if (missing.length > 0) {
    fail(4, `GATE_PREREQUISITE_MISSING: INCOMPLETE_UI_DIST: ${gate} 的产物入口 ${entryAbs} 引用了 `
      + `${missing.length} 个不存在的本地资源：${missing.join(', ')}；界面产物残缺，拒绝出包。`);
  }

  const exclude = spec.exclude ?? [];
  const newestInput = newestMtimeUnder(root, spec.inputs, exclude);
  const oldestOutput = oldestMtimeUnder(root, distAbs);
  if (newestInput > oldestOutput) {
    fail(4, `GATE_PREREQUISITE_MISSING: STALE_UI_DIST: ${gate} 的界面产物 ${distAbs} 早于界面输入`
      + `（界面输入最新 ${newestInput} > 产物最旧 ${oldestOutput}），是改了源码没重 build 的陈旧产物；`
      + '先跑 `npm run build:ui`（等价形态见 docs/USAGE.md）重新构建界面再跑本门。');
  }
}

/**
 * 单条前提检查。缺前提一律 exit 4，原因码按门区分（既有语义，见下方注释）。
 * @param {string} root
 * @param {string} gate
 * @param {string} rel
 * @returns {void}
 */
function checkPrerequisite(root, gate, rel) {
  const requiredPath = join(resolve(root), rel);
  if (existsSync(requiredPath)) return;
  if (gate === 'typecheck:apps') {
    fail(4, `APPS_PROJECT_NOT_CREATED: ${gate} requires ${requiredPath} under root ${resolve(root)}. `
      + 'The apps/ tree is a separate nested project that is deliberately NOT part of the root '
      + 'tsconfig.json, so this gate cannot pass without it.');
  }
  fail(4, `GATE_PREREQUISITE_MISSING: ${gate} requires ${requiredPath} under root ${resolve(root)}. `
    + '先补齐该前提（见 docs/USAGE.md「桌面程序」章）再跑这道门；不允许跳过。');
}

/**
 * 按链顺序真实执行若干 COMMANDS 条目：任一条非零即整门失败，退出码原样透传
 * （不吞、不改写成 1），且后面的条目**不会被 spawn**——这正是「构建失败时 builder
 * 未被 spawn」的机制保证。
 * @param {string} root
 * @param {string[]} chain
 * @param {number} index
 * @returns {void}
 */
function runChain(root, chain, index) {
  const name = chain[index];
  if (name === undefined) return;
  const command = COMMANDS[name];
  if (command === undefined) fail(1, `GATE_ERROR: no command definition for ${name}`);
  for (const rel of command.required ?? []) checkPrerequisite(root, name, rel);
  const script = join(resolve(root), command.bin);
  if (!existsSync(script)) fail(1, `GATE_ERROR: ${name} command not found: ${script}`);
  const child = spawn(process.execPath, [script, ...command.args], {
    cwd: join(resolve(root), command.cwd ?? ''),
    env: process.env,
    stdio: 'inherit'
  });
  child.on('error', (e) => fail(1, `GATE_ERROR: ${e.message}`));
  child.on('close', (code) => {
    const exit = code ?? 1;
    if (exit !== 0 || index + 1 >= chain.length) process.exit(exit);
    runChain(root, chain, index + 1);
  });
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
  const { required, pre, verifyDist } = command;
  // Q1: the gate is wired into `npm run ci`, so "the project this gate needs is
  // not there" must be loud, distinct and blocking — never a silent skip and
  // never indistinguishable from a clean typecheck.
  //
  // 原因码按门区分：typecheck:apps 缺的是那个**独立工程**的配置（APPS_PROJECT_NOT_CREATED）；
  // 打包 / 验包缺的是构建前提（GATE_PREREQUISITE_MISSING）。两者都 exit 4，
  // 但混用同一个词会让「apps 工程没建」和「electron-builder 没装」看起来像同一件事。
  for (const rel of required ?? []) checkPrerequisite(root, gate, rel);
  // F32：存在性之外的可用性。必须在任何 spawn 之前判定——门一旦把 builder 拉起来，
  // 一份陈旧/残缺的 dist 就已经被复制进包了，那时候再拒绝已经太晚。
  if (verifyDist !== undefined) verifyBuiltDist(root, gate, verifyDist);
  // 构建前置 + 本门命令按链串行执行：任一非零即整门失败，退出码原样透传。
  runChain(root, [...(pre ?? []), gate], 0);
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
