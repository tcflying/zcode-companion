#!/usr/bin/env node
/**
 * official-host 子宿主 —— **薄壳**。唯一职责：**spawn** 官方 app-server、驱动会话、
 * 把结果以 NDJSON 回给父进程。
 *
 * ## HOSTFIX5：为什么从"require bundle"改成"spawn app-server"
 *
 * 上一版在这里 `createRequire(bundlePath)` **加载**官方 bundle，再从它导出的
 * `runZCodeProtocolAgent` 拿协议代理。**实弹首战（2026-10-01 09:34）证明这条路不存在**：
 * `C:\ZCode\resources\glm\zcode.cjs` **没有任何具名导出**——
 * `exports.createZCodeApp` / `exports.runZCodeProtocolAgent` /
 * `exports.startProcessProviderRegistryRuntime` 在全文各 **0 命中**，
 * 仅有的两处 `module.exports`（偏移 13483297 / 10252913）是内部库 shim（inquire / utf8）。
 * 于是 `BUNDLE_EXPORTS_INCOMPLETE` 是**必然**失败：不是 bundle 不对，是**没有导出面**。
 *
 * 真正存在的入口是**子命令**：`node <bundle> app-server --stdio`。r1–r4 探针与
 * STANDALONE_PROBE 都在这条路上跑通了握手（自发通告 5 帧、`runtime/capabilities` 应答、
 * 关 stdin 后 exit 0）。本轮在 `%TEMP%` 又做了一次**零发送**冒烟（只到
 * `runtime/capabilities` 应答即止，无 `session/send`、无 `testModelConnectivity`、
 * 无任何模型调用），结果记在工单报告里。
 *
 * **本文件因此不再 `require` 官方代码**：`createRequire` 与导出预检整套删除。
 * `BUNDLE_EXPORTS_INCOMPLETE` 与 `BUNDLE_LOAD_FAILED` 这两个失败模式**整条消失**，
 * 换成下面这条更直接的：
 *
 * ```
 * BUNDLE_SPAWN_FAILED —— 官方 app-server 起不来（spawn 抛错 / 子进程 error / 提前退出）
 * ```
 *
 * ## 为什么是 `.mjs` 放在 `scripts/`
 *
 * 官方 bundle 是 **CommonJS**（14.8 MB 单文件），而本子宿主要 import
 * `packages/official-host/src/*.ts`（本仓库的 TypeScript 源码）。
 * Node 的类型剥离只擦类型、**不改说明符**，所以 `.js` 说明符必须改指到同目录的 `.ts`。
 * 与 `packages/api/bin/start-api.mjs` 的钩子逐字同源。`scripts/official-tap/` 的四个
 * `.mjs` 正是同一个理由放在 `scripts/`。这里沿用该先例。
 *
 * ## 崩溃隔离（本文件存在的全部理由，现在多了一层）
 *
 * 官方 bundle 顶层会跑 CLI bootstrap，`runZCodeProtocolAgent` 内部还会 `process.exit()`。
 * 进程内 require 会把这些副作用拉进 API 服务进程，而 `process.exit()` 不可捕获、
 * 模块不可卸载——那会让"官方内部异常不得带崩 API 服务进程"这条硬约束**结构上**做不到。
 *
 * HOSTFIX5 起这条隔离**变成两层**，而且第二层是官方自己的原生形态：
 * ```
 * API 服务进程 ──stdio(NDJSON 父子通道)──> host-child.mjs ──stdio(NDJSON 官方协议)──> node zcode.cjs app-server --stdio
 * ```
 * 两层都是"每次请求一枚、用完即杀"。任一层 exit / 崩溃对上一��只是一次 `exit` 事件。
 * 同一形态的先例：`dsh-zcode-appserver`（`spawn(node, [zcode.cjs, 'app-server', '--stdio', '--surface', 'desktop'])`）。
 *
 * ## 凭据边界
 *
 * **明文只在本进程内存里。** 取键、解密、构造 `providerRuntimeHeadersPort` 全在这里做，
 * 明文**从不**写进任何一帧 NDJSON。父进程拿到的只有 `delta` / `usage` / `finish` /
 * `failed`——**没有任何字段承载凭据**。这条不是"约定"，是帧结构本身：凭据需求由本进程
 * 从官方本地仓直接读，不经父子通道；写给官方的 `{id, result}` 帧只进**子进程 stdin**。
 *
 * ## 零发送
 *
 * `op: 'describe'` **spawn** 官方 app-server、等它**自发**吐出第一帧（那 5 条
 * `startup/storageState` 通知），然后**一个字节都不写**就收掉它。
 * **不建会话、不发 `session/send`、不触网。** `op: 'run'` 才建会话。
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const HOST_CHANNEL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* TypeScript 源码解析钩子（与 packages/api/bin/start-api.mjs 同一形状）          */
/* -------------------------------------------------------------------------- */

/**
 * 让本 `.mjs` 能 import `packages/official-host/src/*.ts`。
 *
 * Node 的类型剥离只擦类型、**不改说明符**，所以 `.js` 说明符必须改指到同目录的 `.ts`。
 * 与 `start-api.mjs` 的钩子逐字同源：只改写 `.js` → 同名 `.ts`（存在才改），其余交回
 * 默认解析器。
 */
function installTypeScriptSpecifierHook() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const parentUrl = context.parentURL ?? new URL(`file://${process.cwd()}/`).href;
        try {
          const target = new URL(specifier, parentUrl);
          if (target.pathname.endsWith('.js')) {
            const asTs = new URL(`${target.href.slice(0, -3)}.ts`);
            if (existsSync(fileURLToPath(asTs))) {
              return { url: asTs.href, format: 'module-typescript', shortCircuit: true };
            }
          }
        } catch {
          /* 解析不了就交回默认解析器。 */
        }
      }
      return nextResolve(specifier, context);
    }
  });
}

installTypeScriptSpecifierHook();

// 第二层子进程生命周期的两个窗（**单一出处**在 host-driver.ts：`scripts/` 这边不再
// 各写一份字面量，避免两处漂移）。`session-drive.mjs` 从**同一个**模块取，所以
// `waitForAppServerExit` 与 `reapAppServer` 用的一定是同一个值。
const {
  OFFICIAL_APP_SERVER_EXIT_GRACE_MS: APP_SERVER_EXIT_GRACE_MS,
  OFFICIAL_APP_SERVER_FIRST_FRAME_TIMEOUT_MS: APP_SERVER_FIRST_FRAME_TIMEOUT_MS
} = await import('../../packages/official-host/src/host-driver.js');

/* -------------------------------------------------------------------------- */
/* argv                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 只认 `--bundle <path>`。**其它任何 token 一律拒绝**：本子宿主的命令行面越小，
 * "从 argv 读出别的东西"的可能就越小。
 *
 * @param {readonly string[]} argv
 * @returns {{ bundle: string }}
 */
export function parseChildArgv(argv) {
  let bundle = '';
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--bundle') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('ARG_INVALID: --bundle 需要一个取值');
      bundle = value;
      i += 1;
      continue;
    }
    throw new Error(`ARG_UNKNOWN: 本子宿主只认 --bundle，收到 ${String(token)}`);
  }
  if (bundle === '') throw new Error('ARG_INVALID: 缺少 --bundle');
  return { bundle };
}

/* -------------------------------------------------------------------------- */
/* 官方 app-server 的启动面（HOSTFIX5 的全部 argv 决定都在这里）                */
/* -------------------------------------------------------------------------- */

/**
 * 启动官方 app-server 的 argv（**闭集**，测试逐字钉住）。
 *
 * 逐条依据：
 *  - `app-server`：官方 `--help` 逐字
 *    `app-server  Run the ZCode Protocol stdio app server`（I02 E-HELP-001）。
 *    这就是 `scripts/verify-runtime.mjs` 的 I02 探针、r1–r4 捕获与 STANDALONE_PROBE
 *    实际跑通的**同一条**子命令。
 *  - `--stdio`：官方 help 的子命令描述里逐字写的是 "**stdio** app server"；
 *    同形态先例 `dsh-zcode-appserver` 传的就是它。
 *    **本轮 `%TEMP%` 零发送冒烟实测**：`app-server`、`app-server --stdio`、
 *    `app-server --stdio --surface desktop` 三种 argv 的行为**逐字相同**
 *    （5 或 27 条自发 `startup/storageState` 通知 + `runtime/capabilities` 应答
 *    `{"independentPlanState":true}` + 关 stdin 后 `exit 0` + stderr 0 字节）。
 *    选它是因为它把"走 stdio"这件事写进了命令行，而不是依赖默认值。
 *  - `--surface desktop`：官方 help 逐字
 *    `--surface <surface>  Presentation surface for headless prompts/app-server: terminal or desktop`
 *    （I02 E-HELP-004）。上一版传给 API 的 `presentationSurface` 就是 `'desktop'`，
 *    这里**逐字保持同一个值**，不改变已验证过的行为面。
 *
 * **刻意不传的**：`--mode`（help 逐字 `--mode <mode>  Permission mode for prompts`，
 * 只作用于 prompt/TUI）、`--prepare-storage`（属于另一个模式，E-BUNDLE-026）、
 * `--prompt`、任何模型相关开关。**argv 越小，行为面越小。**
 */
export const OFFICIAL_APP_SERVER_ARGV = Object.freeze(['app-server', '--stdio', '--surface', 'desktop']);

/**
 * **持续 drain 官方 app-server 的 stderr，并只计数**（HOSTFIX6 · 复审 B-1）。
 *
 * ## 为什么这一段是承重的
 *
 * `spawnAppServer` 用 `stdio: ['pipe','pipe','pipe']`，于是 stderr 是一条**真实的
 * 匿名管道**。**本进程不读它 ⇒ 官方进程写满管道缓冲（约 64 KB，Windows 典型值）就
 * 永久阻塞在 `write` 上**。它一卡住，就同时不再从 stdout 吐任何东西，于是：
 *
 *  - `op:'describe'`：5 s 内收不到首帧 → `BUNDLE_SPAWN_FAILED`（"起不来"）；
 *  - `op:'run'`：`session/create` 或 turn 永远不落地 → 挂满 300 s 墙钟上限
 *    → `SESSION_TIMEOUT`（"慢响应"）。
 *
 * 后者正是 2026-10-01 实弹第二轮的症状（300041 ms 后 502 `upstream_outcome_unknown`，
 * 无崩溃无错误码）。复审的 A/B 实测（`%TEMP%` 假 app-server，零真实 bundle）：
 * 写 8 / 32 / 64 KB 时 stdout 首帧照样到达；写 200 / 1000 KB 时**永不到达**；
 * 加了 drain 之后 200 / 1000 KB 全部恢复。真实会话里 MCP 启动失败、Node warning、
 * 未捕获异常栈都进 stderr，写超 64 KB 完全正常。
 *
 * ## 纪律：只 drain、只计数，**绝不**把内容写进父通道
 *
 * 与上一层（`host-driver.ts:887-890` 对**子宿主**stderr 的处理）**逐字同源**：
 * 计数走闭包里的局部变量，**从不**把 chunk 存进任何数组/字符串、**从不** `emit`、
 * **从不**落盘。官方 bundle 的 stderr 是未经净化的自由文本（可能带凭据片段），
 * "只计数"是这条边界在结构上的落点，不是约定。
 *
 * 与本文件自己那行 `ZCC_HOST_DEBUG` 诊断行的关系要说清：那一行是**我们自己写的**、
 * 结构受控、零凭据的 JSON；这里排掉的是**官方写的**字节流。两者走的是同一条
 * stderr 管道，但**内容来源完全不同**——本函数不读管道内容，所以即使官方在同一时刻
 * 狂写 stderr，那行诊断也照样打得出来。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {() => number} 读当前累计字节数的函数（**只给测试与诊断**，生产路径不调用）
 */
export function attachAppServerStderrDrain(child) {
  let stderrBytes = 0;
  child.stderr?.on('data', (chunk) => {
    stderrBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
  });
  // 官方进程先死、管道被拆掉时 stderr 会 emit `EPIPE`/`ERR_STREAM_DESTROYED`。
  // 没有这个监听器，事件会变成一次**未捕获异常**并带走子宿主——那正好是
  // "崩溃隔离"要防的那件事，只不过发生在自己身上。
  child.stderr?.on('error', () => undefined);
  // `resume()` 幂等：即使上面那个 `data` 监听器因为某种原因不存在，也保证流在流动。
  // 没有它，**无人读**的 pipe 在 Node 里停在 paused 状态，等于没 drain。
  child.stderr?.resume();
  return () => stderrBytes;
}

/**
 * spawn 一个官方 app-server。**只 spawn，不写任何字节。**
 *
 * `shell: false`（不经过 shell，避免引号/路径注入面）、`windowsHide: true`（与 tap 一致）、
 * env 走 `buildIsolatedChildEnv`（由**父进程** `host-driver.ts` 建好后随请求帧一起继承——
 * 本子宿主不重建 env，也不改动它）。
 *
 * @param {string} bundlePath
 * @returns {import('node:child_process').ChildProcess}
 */
function spawnAppServer(bundlePath) {
  const child = spawn(process.execPath, [bundlePath, ...OFFICIAL_APP_SERVER_ARGV], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  });
  // HOSTFIX6 · B-1：spawn 之后**立刻**接上 stderr drain。
  // 这一句必须在 `spawnAppServer` 内部（而不是调用方）——两条调用路径
  // （`describe` 与 `run`）共用这一个 spawn 点，挂在调用方就一定会漏掉一条。
  attachAppServerStderrDrain(child);
  return child;
}

/**
 * 收束官方 app-server 子进程（B4，**三条路径共用**：`describe` / `run` 成功 / `run` 失败）。
 *
 * 纪律与 `host-driver.ts` 的 `reap()` 逐字同源：
 *  1. **自然退出优先**——先关 stdin，给它 {@link APP_SERVER_EXIT_GRACE_MS} 自己收尾；
 *     官方实测就是关 stdin 后 `exit 0`（E-PROBE-R3-P4 与本轮冒烟）。
 *  2. **kill 兜底**——窗内没退，用**我们自己 spawn 的句柄** `child.kill('SIGKILL')`。
 *    只对持有 handle 的进程动手，**绝不按名字/端口猜**，也绝不碰任何既有进程。
 *
 * **本函数幂等**（已自然退出就直接返回），且放在 `finally` 里：**任何**抛出路径都不留孤儿。
 * 那个 kill 定时器是 `unref` 的——它**不**把子宿主的退出时间拖长，也**不**让
 * `main()` 在等待期间空转。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {void}
 */
function reapAppServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return; // 自然退出，句柄已释放
  try {
    child.stdin?.end();
  } catch {
    /* 子进程可能已退出：stdin 已关。忽略。 */
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出。忽略。 */
    }
  }, APP_SERVER_EXIT_GRACE_MS);
  timer.unref?.();
}

/**
 * 等官方 app-server **真的**开始说话（自发第一帧），或者超时。
 *
 * 这就是 `op: 'describe'` 的全部内容：**spawn 成功 + 官方确实开口**，
 * **一个字节都不写**。它是替代 `BUNDLE_EXPORTS_INCOMPLETE` 的那道**新身份闸门**：
 * 旧闸门证的是"这个模块有那几个导出"，新闸门证的是"这份 bundle 能作为官方 app-server
 * 起来并按官方协议通告"——后者才是我们真正依赖的东西。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} ms 上限
 * @returns {Promise<string | null>} 第一行的形状（`{method,params}` / `{id,result}` …），超时 `null`
 */
function waitForFirstFrame(child, ms) {
  return new Promise((resolve) => {
    let buffered = '';
    /** @param {string | null} line */
    const done = (line) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      resolve(line);
    };
    let settled = false;
    const timer = setTimeout(() => {
      done(null);
    }, ms);
    timer.unref?.();
    /** @param {Buffer | string} chunk */
    const onData = (chunk) => {
      buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const at = buffered.indexOf('\n');
      if (at >= 0) done(buffered.slice(0, at));
    };
    child.stdout?.on('data', onData);
    child.on('exit', () => {
      done(null);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* 输出                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 写一帧通道消息。**顶层键只有 `zccHost`**——凭据没有位置存在（见文件头"凭据边界"）。
 *
 * @param {unknown} payload
 */
function emit(payload) {
  process.stdout.write(`${JSON.stringify({ zccHost: payload })}\n`);
}

/**
 * 报一次失败。`detail` 只放**结构化失败原因**，不放任何凭据值——
 * 构造失败原因的地方已经遵守"只报错误码与键名"的纪律。
 *
 * @param {string} code
 * @param {string} detail
 */
function fail(code, detail) {
  emit({ type: 'failed', code, detail: String(detail).slice(0, 400) });
}

/**
 * 本子宿主可能回报的**失败码闭集**（测试逐条钉住这个闭集）。
 *
 * HOSTFIX5 删掉了两个成员，而它们的删除是**机器可核**的：
 *  - `BUNDLE_EXPORTS_INCOMPLETE`：**不再 require，就不再有这个失败模式**；
 *  - `BUNDLE_LOAD_FAILED`：同上（连加载都不发生了）。
 * 新增一个成员 `BUNDLE_SPAWN_FAILED`：官方 app-server 起不来时的那一条。
 */
export const HOST_CHILD_FAILURE_CODES = Object.freeze([
  'ARG_INVALID',
  'BUNDLE_NOT_FOUND',
  'BUNDLE_SPAWN_FAILED',
  'CHILD_PROTOCOL_VIOLATION',
  'CHANNEL_REFUSED',
  'SESSION_FAILED',
  'CHILD_UNCAUGHT'
]);

/* -------------------------------------------------------------------------- */
/* 主流程                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  /** @type {string} */
  let bundlePath;
  try {
    ({ bundle: bundlePath } = parseChildArgv(argv));
  } catch (e) {
    fail('ARG_INVALID', e instanceof Error ? e.message : String(e));
    return 1;
  }
  if (!existsSync(bundlePath)) {
    fail('BUNDLE_NOT_FOUND', `官方 bundle 不存在：${bundlePath}`);
    return 1;
  }

  const request = await readRequest();
  if (request === null) {
    fail('CHILD_PROTOCOL_VIOLATION', 'stdin 关闭前没有收到请求帧');
    return 1;
  }

  // describe：**spawn 一次官方 app-server，等它自发开口，然后一个字节都不写地收掉它。**
  // 零发送：不建会话、不取凭据、不发 session/send。
  if (request.op === 'describe') {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawnAppServer(bundlePath);
    } catch {
      fail('BUNDLE_SPAWN_FAILED', '官方 app-server 无法 spawn（原始错误不转发）');
      return 1;
    }
    try {
      const firstFrame = await waitForFirstFrame(child, APP_SERVER_FIRST_FRAME_TIMEOUT_MS);
      if (firstFrame === null) {
        fail('BUNDLE_SPAWN_FAILED', `官方 app-server 启动后 ${String(APP_SERVER_FIRST_FRAME_TIMEOUT_MS)}ms 内没有按协议开口`);
        return 1;
      }
      // `exports` 恒为空数组：HOSTFIX5 起**我们不再从 bundle 取任何导出**，
      // 父通道帧结构一个字不动（`{type:'ready', bundle, exports}`），值如实为空。
      emit({ type: 'ready', bundle: bundlePath, exports: [] });
    } finally {
      reapAppServer(child);
    }
    emit({ type: 'finish', reason: 'stop' });
    return 0;
  }

  // op === 'run'：spawn app-server + 取键 + 构造 port + 驱动会话。**明文只在这一层的内存里。**
  const { createHeadersPort } = await import('../../packages/official-host/src/headers-port.js');
  const family = request.providerId.startsWith('account:bigmodel') ? 'bigmodel' : 'zai';
  /** @type {import('../../packages/official-host/src/headers-port.js').ProviderRuntimeHeadersPort | null} */
  let port = null;
  try {
    port = createHeadersPort({
      providerId: request.providerId,
      planKind: request.planMode,
      family
    });
  } catch (e) {
    fail('CHANNEL_REFUSED', e instanceof Error ? e.message : String(e));
    return 1;
  }

  /** @type {import('node:child_process').ChildProcess} */
  let child;
  try {
    child = spawnAppServer(bundlePath);
  } catch {
    fail('BUNDLE_SPAWN_FAILED', '官方 app-server 无法 spawn（原始错误不转发）');
    return 1;
  }
  // **子进程一 error 就立刻失败**，不等会话超时：官方起不来时 `session/create` 永远
  // 不会有回执，而那条路要空转到 300 s 墙钟上限。`spawnAppServer` 本身**不附原始错误**
  // （官方 bundle 的加载/启动错误可能带绝对路径与内部符号名）。
  /** @type {string | null} */
  let spawnErrored = null;
  child.on('error', () => {
    spawnErrored = 'error';
  });
  child.on('exit', (code, signal) => {
    if (spawnErrored === null && code !== 0) {
      spawnErrored = `exit:${String(code)}/${String(signal)}`;
    }
  });

  const { driveSession, HOST_DEBUG_ENV_KEY } = await import('./session-drive.mjs');
  try {
    emit({ type: 'ready', bundle: bundlePath, exports: [] });
    const summary = await driveSession({ child, request, port, emit });
    if (spawnErrored !== null) {
      fail('BUNDLE_SPAWN_FAILED', `官方 app-server 在会话期间异常终止（${spawnErrored}）`);
      return 1;
    }
    // HOSTFIX4 · 实弹诊断：**默认关**，只在 `ZCC_HOST_DEBUG=1` 时把零凭据的
    // `DriveSessionSummary` 打到 **stderr**。
    //
    // 为什么是 stderr 而不是父通道：父通道帧结构是**闭集** `{zccHost:{type}}`，
    // 加一种 type 属于**通道变更**（复审 §10.7）。而 `host-driver.ts` 逐字对 stderr 只做
    // `stderrBytes += chunk.length` 的**计数**——**从不**把内容读进变量、从不转发、
    // 从不落盘。所以这一行既不动帧结构，也不新增任何凭据面。
    //
    // 内容为什么是零凭据的：`DriveSessionSummary` 只有计数、闭集短码与毫秒数
    // （`reverseRequestsByMethod` / `lastReverse.refusalCode` / `phaseDurationsMs`），
    // 没有 apiKey、没有 providerId 回显、没有 sessionId、没有路径。
    if (process.env[HOST_DEBUG_ENV_KEY] === '1') {
      process.stderr.write(`ZCC_HOST_DEBUG ${JSON.stringify(summary)}\n`);
    }
  } catch (e) {
    // HOSTFIX6：**失败路径也打诊断行**。
    //
    // HOSTFIX4 只在 `driveSession` **正常返回**时打这一行。于是最需要诊断的那一类
    // 失败（`SESSION_TIMEOUT` / `SESSION_CREATE_NO_SESSION_ID`）恰恰**一行都打不出来**
    // ——2026-10-01 实弹第二轮挂满 300 s 就是这样：连"挂在哪个阶段"都没留下。
    // `driveSession` 现在把失败当时的阶段摘要挂在 `zccHostPartialSummary` 上，
    // 这里在**原样上报失败之前**把它打出来。
    //
    // 结构与成功路径**同形**（同一个 `ZCC_HOST_DEBUG <json>` 前缀、同一个 JSON 体），
    // 只多一个 `failed: true` 标记位，便于按行区分。摘要本身零凭据。
    if (process.env[HOST_DEBUG_ENV_KEY] === '1' && e !== null && typeof e === 'object') {
      const partial = /** @type {{ zccHostPartialSummary?: unknown }} */ (e).zccHostPartialSummary;
      if (partial !== undefined) {
        process.stderr.write(`ZCC_HOST_DEBUG ${JSON.stringify({ failed: true, .../** @type {any} */ (partial) })}\n`);
      }
    }
    fail('SESSION_FAILED', e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    // **无孤儿**：无论成功、失败还是抛异常，官方 app-server 都被收束。
    reapAppServer(child);
  }
  return 0;
}

/**
 * 读一帧请求。**只取一帧**：本子宿主是"每次一枚、用完即杀"模型（与
 * `dsh-zcode-appserver` 的 openServer 同一纪律），不做长驻多请求。
 *
 * @returns {Promise<Record<string, any> | null>}
 */
function readRequest() {
  return new Promise((resolve) => {
    let buffer = '';
    /** @param {Buffer | string} chunk */
    const onData = (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const at = buffer.indexOf('\n');
      if (at < 0) return;
      process.stdin.off('data', onData);
      // **只取一帧**之后必须把 stdin 的读句柄**摘掉**（HOSTFIX5 实测踩到）：
      // 在 Node 里一旦挂了 `data` 监听器，stdin 的读句柄就被 **ref**；`pause()` 单独**不够**
      // （实测：pause 之后 `main()` 返回、没有任何其它句柄，进程仍然不退），必须再
      // `unref()`。不摘的话每次请求都要靠父进程 `runHostSession.reap()` 的 400 ms 宽限窗
      // + 一次 SIGKILL 才收场——"一次一枚、用完即杀"就变成了名不副实。
      // 实测：摘掉之后子宿主在 `main()` 返回后**自然退出**。
      process.stdin.pause?.();
      process.stdin.unref?.();
      try {
        const parsed = JSON.parse(buffer.slice(0, at));
        resolve(parsed && typeof parsed === 'object' ? parsed.zccHost ?? null : null);
      } catch {
        resolve(null);
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', () => resolve(null));
    process.stdin.on('error', () => resolve(null));
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      // 顶层兜底：**任何**逃逸的异常都在这里被转成一次失败，绝不带着未捕获异常
      // 留下一条非零退出码之外的可疑状态。原始异常不转发（可能含路径与符号名）。
      fail('CHILD_UNCAUGHT', err instanceof Error ? err.name : 'unknown');
      process.exitCode = 1;
    }
  );
}
