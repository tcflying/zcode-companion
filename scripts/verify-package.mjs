#!/usr/bin/env node
/**
 * `verify:package` 门（I10）：证明打包产物**自足**，而不是「在仓库里能跑」。
 *
 * 四道检查，逐条 fail-closed，任一条不过就非零退出：
 *  1. **产物存在**：按 electron-builder 的 `artifactName` 规则在 `release/desktop`
 *     找到那个 portable exe。没打过包就是没打过包，不许「跳过这步」。
 *  2. **体积上限**：超过 `ZCC_PACKAGE_MAX_BYTES`（缺省 260 MiB）即判失败。
 *     一个把整棵 `node_modules` 顺手打包进去的产物会在这里现形。
 *  3. **包外启动**：把 exe 的 **cwd 设成 `%TEMP%` 下的一个新目录**再启动。
 *     这一步是整道门的核心：如果产物还依赖仓库里的相对路径，在包外 cwd 下会直接起不来。
 *  4. **渲染 + `/v1` 转发**：exe 以 `--zcc-verify` 启动，用**包内**的反代运行时
 *     （`driver=none`，不接任何真实模型、不读任何真实凭据）把 API 拉起来，
 *     再让渲染进程经 `app://` 真发一次 `GET /v1/models`。
 *     exe 把结构化结果写进 `ZCC_VERIFY_OUT`，本脚本据此判定。
 *
 * 凭据纪律：本门全程只用**合成** key（`zcc_verify_local_only_*`），不读用户真实
 * settings.json、不读 `~/.minimax/config.yaml`、不碰 8790 上任何在跑的实例
 * （自检端口由 `ZCC_VERIFY_PORT` 给出，缺省 8899）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** 与产物侧（`apps/desktop/main.cjs`）共用同一份判据，两边不许各写一份。 */
const { assessSpawnStep } = require('../apps/desktop/lib/verify-contract.cjs');

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const OUTPUT_DIR = join(PROJECT_ROOT, 'release', 'desktop');
/** 缺省 260 MiB：一个自足但不臃肿的 Electron portable 应该在 100 MiB 上下。 */
const MAX_BYTES = Number.parseInt(process.env['ZCC_PACKAGE_MAX_BYTES'] ?? String(260 * 1024 * 1024), 10);
const VERIFY_PORT = Number.parseInt(process.env['ZCC_VERIFY_PORT'] ?? '8899', 10);
/** 给 portable 的自解压 + 首次渲染留足时间；超时一律算失败，绝不当作「还在跑」。 */
const VERIFY_TIMEOUT_MS = Number.parseInt(process.env['ZCC_VERIFY_TIMEOUT_MS'] ?? '180000', 10);

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`verify:package FAIL: ${message}\n`);
  process.exit(1);
}

/** 找到唯一的 portable exe；多于一个也算失败（产物目录不该有歧义）。 */
function findArtifact() {
  if (!existsSync(OUTPUT_DIR)) fail(`产物目录不存在：${OUTPUT_DIR}（先跑 npm run pack:win）`);
  const exes = readdirSync(OUTPUT_DIR).filter((f) => f.toLowerCase().endsWith('.exe'));
  if (exes.length === 0) fail(`${OUTPUT_DIR} 下没有任何 .exe 产物`);
  if (exes.length > 1) fail(`${OUTPUT_DIR} 下有多个 .exe 产物，无法判定：${exes.join(', ')}`);
  return join(OUTPUT_DIR, /** @type {string} */ (exes[0]));
}

/**
 * @param {string} command
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number | null, timedOut: boolean, out: string }>}
 */
function runExe(command, env) {
  return new Promise((resolvePromise) => {
    // cwd 落在包外：这是「自足」这两个字的全部含义。
    const cwd = mkdtempSync(join(tmpdir(), 'zcc-verify-cwd-'));
    let out = '';
    let timedOut = false;
    const child = spawn(command, ['--zcc-verify'], {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      out += String(d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // 只对自己拉起来的这个句柄发信号。
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
    }, VERIFY_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      resolvePromise({ code, timedOut, out });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      resolvePromise({ code: -1, timedOut, out: `${out}\n${err.message}` });
    });
  });
}

const artifact = findArtifact();
const size = statSync(artifact).size;
process.stdout.write(`verify:package artifact=${artifact} bytes=${size} limit=${MAX_BYTES}\n`);
if (size > MAX_BYTES) fail(`产物体积 ${size} 超过上限 ${MAX_BYTES}`);

/**
 * 起飞前的端口体检。
 *
 * 自检端口上如果已经有服务在应答，产物会进入 `external` 态——它**不 spawn 任何
 * 运行时**，后面的 `/v1` 转发打到的就是一个不是本包拉起来的进程。那条路径什么都
 * 证明不了，所以这里提前判死，而不是让它跑完再被误读成「自足」。
 * 不抢别人的端口，更不去动占着它的那个进程：硬纪律是只回收自己创建的进程。
 */
async function assertPortFree() {
  let busy = false;
  let status = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${VERIFY_PORT}/v1/models`, { signal: AbortSignal.timeout(3_000) });
    status = res.status;
    busy = true;
    await res.body?.cancel().catch(() => {});
  } catch {
    busy = false; // 连不上 = 端口空着，正是本门要的。
  }
  if (busy) {
    fail(`自检端口 127.0.0.1:${VERIFY_PORT} 上已有服务在应答（HTTP ${status}）。` +
      '换一个空闲端口：ZCC_VERIFY_PORT=<端口> npm run verify:package');
  }
}

await assertPortFree();

/**
 * 本门唯一用到的 `@electron/asar` 入口。模块形状在这里显式钉死，而不是让
 * `tsc --checkJs` 去解析那个包自己的 d.ts：见 `loadAsarModule` 的说明。
 *
 * @typedef {{ listPackage: (asarPath: string, options: { isPack?: boolean }) => string[] }} AsarModule
 */

/**
 * 运行期解析 `@electron/asar`。
 *
 * **为什么不能写成 `require('../apps/desktop/node_modules/@electron/asar')`**：那样
 * tsc 会在**编译期**静态解析这个路径，而 `@electron/asar` 只装在 `apps/desktop`
 * 下。根 `package.json` 没有 `workspaces`，根 `npm install` 不覆盖 `apps/desktop`，
 * 于是干净克隆里 `npm run ci` 的 `typecheck:checkjs` 会在跑 `verify:package`
 * **之前**就以 TS2307 变红——一道只有出包后才用得上的门，把类型门拖死了。
 *
 * 所以这里把模块 id 交给运行期拼装：tsc 不做静态解析，解析锚点则是
 * `apps/desktop/package.json`，与在 `apps/desktop` 里执行 `npm install` 后的实际
 * 解析路径一致（不再依赖「脚本恰好住在 scripts/」这一相对位置）。
 *
 * @returns {AsarModule}
 */
function loadAsarModule() {
  const desktopRequire = createRequire(join(PROJECT_ROOT, 'apps', 'desktop', 'package.json'));
  const moduleId = ['@electron', 'asar'].join('/');
  try {
    return /** @type {AsarModule} */ (desktopRequire(moduleId));
  } catch (err) {
    fail(
      `读不了 @electron/asar（${err instanceof Error ? err.message : String(err)}）。`
      + '它装在 apps/desktop 下，根 npm install 不覆盖该目录（根 package.json 没有 workspaces），'
      + '请执行：cd apps/desktop && npm install'
    );
  }
}

/**
 * 产物 asar 里必须真的带着 `verify-contract.cjs`。
 *
 * 为什么门脚本自己 require 仓库里的那份还不够：`files` 规则哪天被收窄，产物就会
 * 缺这份文件，而**门仍然绿**——因为门读的是仓库里的副本，验的却是一个没带它上车的
 * 包。那道门会变成自说自话。这条断言把「包里有」和「门读的是同一份」绑在一起。
 */
function assertAsarContains(/** @type {string} */ relative) {
  const asar = join(OUTPUT_DIR, 'win-unpacked', 'resources', 'app.asar');
  if (!existsSync(asar)) fail(`找不到产物 asar：${asar}（重新跑 npm run pack:win）`);
  let entries;
  try {
    // 这版 @electron/asar 的 ListOptions 是必填参数（d.ts 里 `isPack` 没有 `?`）。
    // isPack=false = 列出文件条目（不是 unpack 后的目录树），正是「包里到底有什么」。
    entries = loadAsarModule().listPackage(asar, { isPack: false });
  } catch (err) {
    fail(`读不了产物 asar（${err instanceof Error ? err.message : String(err)}）`);
  }
  const wanted = `\\${relative.replace(/\//g, '\\')}`;
  const hit = (entries ?? []).some((/** @type {string} */ e) => e.endsWith(wanted) || e === relative);
  if (!hit) fail(`产物 asar 里没有 ${relative}：门读仓库副本、包里却没有，自足性未被证明`);
  process.stdout.write(`verify:package asar-contains ${relative}\n`);
}

assertAsarContains('lib/verify-contract.cjs');
assertAsarContains('lib/spawn-spec.cjs');

const reportFile = join(mkdtempSync(join(tmpdir(), 'zcc-verify-out-')), 'verify.json');
const result = await runExe(artifact, {
  ...process.env,
  ZCC_VERIFY_OUT: reportFile,
  ZCC_VERIFY_PORT: String(VERIFY_PORT)
});

if (result.timedOut) fail(`产物在 ${VERIFY_TIMEOUT_MS}ms 内没有自行退出（输出：${result.out.slice(0, 800)}）`);
if (!existsSync(reportFile)) fail(`产物没有写出自检报告（exit=${result.code}，输出：${result.out.slice(0, 800)}）`);

/** @type {{ ok: boolean, steps: any[], reason?: string }} */
let report;
try {
  report = JSON.parse(readFileSync(reportFile, 'utf8'));
} catch (err) {
  fail(`自检报告不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
}

for (const step of report.steps ?? []) {
  process.stdout.write(`verify:package step=${step.step} ok=${String(step.ok)} ${JSON.stringify(step)}\n`);
}

// 「包确实把反代拉起来了」是自检的**全部**意义所在。判据与主进程共用同一份纯函数，
// 免得两边漂成「一边把 external 当通过、一边当失败」。
const spawnStep = (report.steps ?? []).find((/** @type {{ step: string }} */ s) => s.step === 'spawn-runtime');
const verdict = assessSpawnStep(spawnStep, VERIFY_PORT);
if (!verdict.ok) fail(verdict.reason);

// 凭据不变式：报告里绝不能出现那把合成 key。
if (JSON.stringify(report).includes('zcc_verify_local_only_')) {
  fail('自检报告里出现了合成 key 的明文片段');
}
if (result.code !== 0) fail(`产物自检未通过（exit=${result.code}）：${report.reason ?? '(无原因)'}`);
if (report.ok !== true) fail(`产物自检 ok !== true：${report.reason ?? '(无原因)'}`);

process.stdout.write('verify:package PASS：产物存在、体积达标、包外 cwd 启动、渲染成功、/v1 转发可达\n');
process.exit(0);
