#!/usr/bin/env node
/**
 * zcode-stdio-tap.mjs — 官方 dev 钩子 `wrapZCodeAgentCommandWithStdioTapDevProxy`
 * 调用的那一份 tap 脚本。
 *
 * 官方 spawn 形状（从 `app.asar` 里 `out/host/chunk-MZDDONWW.js` 的
 * `wrapZCodeAgentCommandWithStdioTapDevProxy` 逐字读出来的，不是假设）：
 *
 *   { command: process.execPath,
 *     args:    [ <findUpward 找到的 tap 路径>,
 *                "--workspace-key", <workspaceKey>,
 *                "--log-dir", <v2>/dev/stdio-traffic,
 *                "--", <真实 command>, ...<真实 args> ],
 *     cwd:     <workspace path>,
 *     env:     { ...sanitizeZCodeRuntimeEnv(process.env), ELECTRON_RUN_AS_NODE: "1" } }
 *
 * 真实 command 在打包发行形态下就是 `process.execPath`（`C:\ZCode\ZCode.exe`），
 * 真实 args 是 `[<zcode.cjs 路径>, "app-server", "--stdio"]`，`--surface desktop`
 * 由官方的 `applyPresentationSurfaceToCommand` 追加在末尾。所以本脚本对 `--` 之后
 * 的 token **不做任何解释**。
 *
 * 三条不可让渡的性质（每条都有对应测试，见 tests/unit/official-tap-*.test.mjs）：
 *
 *  1. **逐字节保真**：三个流都走 `pumpBytes`——原样 `write` 同一个 Buffer、背压时
 *     pause/drain、旁路观察只读不改。桌面与 app-server 之间的字节流与没有 tap 时
 *     完全一致，**包括我们注入请求的应答帧**：因为按字节保真是红线，宁可让桌面多
 *     看见一个它没发过 id 的应答帧，也不为"只回控制端"去缓冲/重切分字节。
 *  2. **绝不记录帧内容**：诊断只经 `sanitizeDiagFields` 的键白名单 + 原语类型 +
 *     长度三重闸门；凭据应答帧会经过本进程，结构上无法被写出去。
 *  3. **凭据永远不进控制通道**：只有"命名空间 id + 应答形状 + 在等待表里"的帧才
 *     回控制端（`classifyChildFrame`），其余帧（含凭据请求与凭据应答）只中继。
 *
 * 生命周期（Windows 特有）：无法向子进程投递真信号，所以父进程消失靠**自己**
 * 发现——监听 `process.stdin` 的 `end`/`close` 为主，轮询父 pid 存活为辅。关闭顺序
 * 固定为：停新连接 → 关控制通道 → 结束子 stdin → 等子进程退出（超时则终止自己持有
 * 的 spawn handle）→ 清定时器/监听器 → **自然退出**（`process.exit(0)` 属于假绿路径，
 * 工程门禁对它有意见，因此全文件没有 `process.exit`）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startControlServer, errorClassName } from './tap-control.mjs';
import {
  CONTROL_DEFAULT_PORT,
  NdjsonLineScanner,
  REQUEST_TIMEOUT_MS,
  TAP_PROTOCOL_VERSION,
  buildChildEnv,
  buildOfficialRequestLine,
  classifyChildFrame,
  createChildStdinGate,
  evaluateInjectPolicy,
  parseTapArgv,
  resolveControlToken,
  sanitizeDiagFields
} from './tap-core.mjs';
import { pumpBytes } from './tap-relay.mjs';

/** 父进程存活轮询间隔。stdin 的 end/close 是主信号，这个只是兜底。 */
const PARENT_POLL_MS = 1000;
/** 等子进程自己退出的宽限。超过则终止**自己持有的** spawn handle。 */
const SHUTDOWN_GRACE_MS = 5000;
/** 发出 kill 之后再等多久收尾。 */
const KILL_GRACE_MS = 2000;
/** 诊断文件名（落在桌面给的 `--log-dir` 下，不落 taproot、不落安装目录）。 */
const DIAG_FILE = 'zcode-stdio-tap.diag.jsonl';
/** 令牌文件与配置的约定名（安装脚本 `install-tap.mjs` 写的就是这两个）。 */
const CONTROL_CONFIG_FILE = 'zcode-tap-control.json';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/* -------------------------------------------------------------------------- */
/* 诊断写入（约束 2）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 不含内容的诊断写入器。每条记录先过 `sanitizeDiagFields`（键白名单 + 原语 + 长度），
 * 所以即使调用方传错了键，帧内容也**出不去**。写文件失败不影响中继。
 *
 * @param {string | null} logDir
 */
function createDiagWriter(logDir) {
  /** @type {number | null} */
  let fd = null;
  if (logDir !== null) {
    try {
      mkdirSync(logDir, { recursive: true });
      fd = openSync(join(logDir, DIAG_FILE), 'a');
    } catch {
      fd = null;
    }
  }
  let droppedTotal = 0;
  return {
    /**
     * @param {string} event
     * @param {Readonly<Record<string, unknown>>} fields
     */
    write(event, fields) {
      if (fd === null) return;
      const { safe, dropped } = sanitizeDiagFields({ event, at: new Date().toISOString(), ...fields });
      droppedTotal += dropped;
      try {
        writeSync(fd, `${JSON.stringify({ ...safe, droppedFields: dropped })}\n`);
      } catch {
        // 诊断写不出去就不写，绝不让它把中继带崩。
      }
    },
    get droppedTotal() {
      return droppedTotal;
    }
  };
}

/* -------------------------------------------------------------------------- */
/* 启动                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 唯一的启动失败出口：只写**一行**不含内容的固定文本到 stderr，然后设退出码 2。
 * stderr 是桌面 spawn 本脚本时接走的诊断通道（桌面的 `onStderrLine`），启动失败
 * 必须让它看得见；但绝不能带任何凭据、路径里的工作区标识或帧内容。
 *
 * 关键性质：**绝不抛**。先前这里是 `throw new StartupRefusal(code)`，异常在模块
 * 顶层无人接管，Node 会把完整的 13 行栈（含 `file:///C:/...` 绝对安装路径）打到
 * stderr 并以**退出码 1** 结束——`process.exitCode = 2` 被未捕获异常覆盖。既定的
 * "一行固定文本、退出码 2" 契约两条都是假的。现在不抛：设完退出码就正常返回，
 * 由调用方保证后续代码不执行。
 *
 * `code` 来自 `parseTapArgv` 的固定枚举（不含 argv 回显，因此 argv 内容也不会外泄）。
 *
 * @param {string} code
 * @param {number} exitCode
 */
function refuseStartup(code, exitCode) {
  try {
    process.stderr.write(`zcode-stdio-tap: startup refused (${code})\n`);
  } catch {
    // stderr 都写不了就只能靠退出码表达。
  }
  process.exitCode = exitCode;
}

/**
 * 从任意错误对象里取 `code`，用于诊断事件名。**只取 code，不取 message**——
 * message 可能带路径或内容，诊断通道不接受。
 *
 * @param {unknown} error
 * @param {string} fallback
 * @returns {string}
 */
function errorCodeOf(error, fallback) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = /** @type {{code: unknown}} */ (error).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return fallback;
}

const argvResult = parseTapArgv(process.argv.slice(2));
if (!argvResult.ok) {
  // 启动被拒：只写一行固定文本、退出码 2，然后**不再执行下面任何语句**。
  // ESM 顶层没有 `return`，所以整个运行体被收进 `run()`，在这里短路。
  refuseStartup(argvResult.error.code, 2);
} else {
  run(argvResult.parsed);
}

/**
 * 运行体。参数已经在 `parseTapArgv` 处校验过，这里只管 spawn、中继、控制通道与
 * 生命周期。
 *
 * @param {import('./tap-core.mjs').ParsedTapArgv} options
 */
function run(options) {
  const startedAtMs = Date.now();
  const diag = createDiagWriter(options.logDir);

  /** 父进程 pid。stdin end/close 是主信号，它只是兜底。 */
  const parentPid = process.ppid;

  /* -------------------------------------------------------------------------- */
  /* 子进程                                                                      */
  /* -------------------------------------------------------------------------- */

  const child = spawn(options.command, [...options.args], {
    cwd: process.cwd(),
    env: buildChildEnv(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  diag.write('child_spawn', {
    pid: typeof child.pid === 'number' ? child.pid : null,
    ppid: parentPid,
    controlPort: options.controlPort,
    phase: 'start'
  });

  /* -------------------------------------------------------------------------- */
  /* 状态机                                                                      */
  /* -------------------------------------------------------------------------- */

  /** @type {'running' | 'shutting_down' | 'stopped'} */
  let state = 'running';
  /** @type {import('./tap-control.mjs').ControlServer | null} */
  let control = null;
  /** @type {NodeJS.Timeout | null} */
  let pollTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let graceTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let killTimer = null;
  /** @type {number | null} */
  let childExitCode = null;
  let childExited = false;

  /**
   * 等待表：`注入请求 id → 归属连接 + 超时定时器`。
   *
   * @type {Map<string, { connectionId: number, timer: NodeJS.Timeout | null }>}
   */
  const pending = new Map();
  const pendingIds = new Set();

  /** @type {Array<import('./tap-relay.mjs').PumpHandle>} */
  const pumps = [];
  let scannedLines = 0;
  let unmatchedFrames = 0;

  /**
   * 某条中继方向已转发的字节数。**取自泵自己的计数器**而不是旁边另记一份——
   * 手写的计数器曾经漏掉一个方向（`bytesToChild` 永远是 0），字节数必须只有一个来源。
   *
   * @param {0 | 1 | 2} index 0=父→子 1=子→父 2=子 stderr
   * @returns {number}
   */
  function relayBytes(index) {
    const pump = pumps[index];
    return pump === undefined ? 0 : pump.stats.bytes;
  }

  const scanner = new NdjsonLineScanner();

  /**
   * 把应答帧回给发起它的控制连接，并结清等待项。
   *
   * 隔离（TAPFIX3 / P1）：`control?.sendTo` 走的是 socket，写失败可能抛。这一层
   * **绝不 rethrow**——它跑在子进程→父进程的旁路观察回调里，异常逃出去就是 tap 进程
   * 退出，桌面那条会话跟着死。丢一个应答远好过丢整个会话。
   *
   * @param {string} requestId
   * @param {unknown} frame
   */
  function deliverResponse(requestId, frame) {
    const entry = pending.get(requestId);
    if (entry === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    pending.delete(requestId);
    pendingIds.delete(requestId);
    try {
      control?.sendTo(entry.connectionId, {
        v: TAP_PROTOCOL_VERSION,
        op: 'response',
        requestId,
        frame
      });
    } catch {
      diag.write('response_deliver_failed', { code: 'EDELIVER', result: 'error' });
    }
  }

  /**
   * 子进程→父进程方向的**旁路**观察。字节已经原样交给 `process.stdout` 了，这里只
   * 做"要不要额外回一份给控制端"的判定，绝不改动转发路径。
   *
   * 隔离（TAPFIX3 / P1）：`JSON.parse` 之外的任何一步（`deliverResponse`、诊断）都
   * 不允许把异常带出这个函数——它在 relay 的 observe 回调里。
   *
   * @param {string} line
   */
  function onScannedLine(line) {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 不是 JSON 的行照样已经在转发路径上原样送出去了。这里只记一个计数。
      return;
    }
    try {
      scannedLines += 1;
      const decision = classifyChildFrame(parsed, pendingIds);
      if (decision.kind === 'control_response') {
        deliverResponse(decision.id, parsed);
        return;
      }
      if (decision.reason === 'unmatched') {
        // 我们命名空间内但没人等它：确定行为是计数并继续，**不重发、不猜测**，
        // 也绝不交给任何控制端。
        unmatchedFrames += 1;
      }
    } catch {
      // 旁路观察失败绝不影响转发路径：字节已经交出去了，这里只是"额外回一份"。
      diag.write('scan_dispatch_failed', { code: 'ESCAN', result: 'error' });
    }
  }

  /**
   * 子进程 stdin 的一次性写入门。
   *
   * TAPFIX3 / P1 的"**注入失败不得留下半写的 stdin**"由这个门兑现：一旦往
   * `child.stdin` 写抛了错，我们就**无法证明**那一行没有写进去一半。此后所有注入
   * 一律确定性回 `child_unavailable`，一个字节都不再碰这条流——这样"半行 + 下一帧"
   * 拼成一条畸形行的永久污染就不可能发生。门的语义与选型理由见
   * `tap-core.mjs` 的 `createChildStdinGate`。
   */
  const childStdin = createChildStdinGate();

  /**
   * 注入判定 + 落子进程 stdin。白名单不通过时**一个字节都不写**。
   *
   * **结构上绝不抛（TAPFIX3 / P1）**。这不是一句约定：整个函数体包在一个 try 里，
   * 任何逃出来的异常都在这里被转成 `internal_error` 判定。`tap-control.mjs` 那一侧
   * 还有第二道隔离，两层都不许异常到达 `socket.on('data')`——那个位置一旦抛出去，
   * tap 进程就死了，桌面那条 app-server 会话跟着一起死。
   *
   * **半写 stdin 的处置**：`child.stdin.write` 是本函数里唯一碰子进程流的操作，也是
   * 唯一可能"写了一部分才失败"的操作。它抛错时我们无法证明那行是否完整，所以把
   * `childStdinWritable` 置 false，此后所有注入一律回 `child_unavailable`——
   * 确定性拒绝，**而不是**把下一帧拼到一条可能残缺的行后面。
   *
   * @param {Record<string, unknown>} frame
   * @param {number} connectionId
   * @returns {import('./tap-control.mjs').InjectVerdict}
   */
  function handleInject(frame, connectionId) {
    try {
      const requestId = frame['id'];
      if (typeof requestId !== 'string' || requestId.length === 0) {
        return { ok: false, code: 'bad_id_namespace', field: 'frame.id', matched: null, detail: '注入请求缺少 id' };
      }
      if (pending.has(requestId)) {
        return { ok: false, code: 'duplicate_id', field: 'frame.id', matched: null, detail: '该 id 已在等待表中，不重发' };
      }
      if (!childStdin.writable) {
        // 上一帧写过子进程 stdin 且失败过：这条流已被判定为不可信，不再写。
        return {
          ok: false,
          code: 'child_unavailable',
          field: null,
          matched: null,
          detail: '子进程 stdin 上一次写入失败，已停止接受注入以免拼出半行'
        };
      }
      const verdict = evaluateInjectPolicy(frame);
      if (!verdict.ok) return verdict;

      // B1：写进子进程 stdin 的那一行是**按官方 zcodeProtocolRequestSchema 投影重建
      // 的**，不是把控制端送来的对象原样序列化。官方那条 schema 是 `.strict()` 且键
      // 集合只有 {id, method, params, trace}——历史上我们每帧都带 `jsonrpc: "2.0"`，
      // 于是官方 `decodeLine` 的 `qHt.safeParse` 必然失败、回 -32600 并丢弃，而那条
      // 错误帧的 id 是字面量 "invalid-message"，tap 判成 forward_only 转发给桌面、
      // 桌面静默丢弃：整条失败链全链路静默，控制端只能干等 120 s。
      // 投影让"顶层多一个键"这件事在结构上不可能抵达子进程 stdin。
      const line = buildOfficialRequestLine(frame);
      if (!line.ok) return line;
      if (child.stdin.destroyed || !child.stdin.writable) {
        return { ok: false, code: 'child_unavailable', field: null, matched: null, detail: '子进程 stdin 已不可写' };
      }
      try {
        child.stdin.write(line.line);
      } catch {
        // 无法证明写了多少 → 永久停止对这条流的写入（P1 的"不留半写 stdin"）。
        childStdin.markBroken();
        diag.write('child_stdin_write_failed', { code: 'ESTDINWRITE', result: 'error', bytes: line.bytes });
        return { ok: false, code: 'child_unavailable', field: null, matched: null, detail: '写子进程 stdin 失败' };
      }
      const timer = setTimeout(() => {
        // 定时器回调同样不允许把异常带出（它在 timer phase 里跑，逃出去就是进程退出）。
        try {
          const entry = pending.get(requestId);
          if (entry === undefined) return;
          clearTimeout(entry.timer ?? undefined);
          pending.delete(requestId);
          pendingIds.delete(requestId);
          control?.sendTo(entry.connectionId, {
            v: TAP_PROTOCOL_VERSION,
            op: 'response.error',
            requestId,
            error: { code: 'timeout', detail: `等待应答超过 ${REQUEST_TIMEOUT_MS} ms` }
          });
          diag.write('inject_timeout', { code: 'timeout', result: 'error' });
        } catch {
          diag.write('inject_timeout_failed', { code: 'ETIMEOUTCB', result: 'error' });
        }
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      pending.set(requestId, { connectionId, timer });
      pendingIds.add(requestId);
      return { ok: true, requestId };
    } catch (error) {
      // 兜底：这一层把"入口绝不抛"从约定变成事实。诊断只记**类别名**，不记 message
      //（message 可能含调用方回显的内容，见 P4）。
      diag.write('inject_internal_error', { code: errorClassName(error), result: 'error' });
      return { ok: false, code: 'child_unavailable', field: null, matched: null, detail: '注入处理失败' };
    }
  }

  /* -------------------------------------------------------------------------- */
  /* 中继                                                                        */
  /* -------------------------------------------------------------------------- */

  pumps.push(
    pumpBytes(process.stdin, child.stdin, {
      direction: 'parent_to_child',
      onEnd: () => {
        // 桌面关掉 stdin 等价于 app-server 收到 EOF，与无 tap 时一致。
        try {
          child.stdin.end();
        } catch {
          // 子进程已经没了，忽略。
        }
      },
      onDestError: () => {
        // 子进程先走了（EPIPE 家族）：父进程的写入不再有去处，交给关闭流程。
        // 同时把 stdin 写入门永久关闭（P1）：流已经坏掉，绝不再往上面拼新的注入帧。
        childStdin.markBroken();
        beginShutdown('child_stdin_closed');
      },
      onSourceError: () => {
        beginShutdown('parent_stdin_error');
      }
    })
  );

  pumps.push(
    pumpBytes(child.stdout, process.stdout, {
      direction: 'child_to_parent',
      observe: (chunk) => {
        for (const line of scanner.push(chunk)) onScannedLine(line);
      },
      onEnd: () => {
        for (const line of scanner.flush()) onScannedLine(line);
      },
      onDestError: () => {
        beginShutdown('parent_stdout_closed');
      },
      onSourceError: () => {
        beginShutdown('child_stdout_error');
      }
    })
  );

  pumps.push(
    pumpBytes(child.stderr, process.stderr, {
      direction: 'child_stderr',
      // 旁路观察器刻意缺席：子进程 stderr 既不扫描也不记录内容。
      onSourceError: () => {
        beginShutdown('child_stderr_error');
      }
    })
  );

  /* -------------------------------------------------------------------------- */
  /* 生命周期                                                                    */
  /* -------------------------------------------------------------------------- */

  /**
   * 父进程是否还活着。Windows 上没有 Unix 式的信号语义，`process.kill(pid, 0)`
   * 走的是 OpenProcess 存在性检查；`EPERM` 说明进程在但我们无权探测，按"活着"处理。
   * pid 复用会让这个判断偏保守（假"活着"），所以它只是兜底，主信号是 stdin 的
   * end/close。
   *
   * @param {number} pid
   * @returns {boolean}
   */
  function parentAlive(pid) {
    if (pid <= 1) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return typeof error === 'object' && error !== null && /** @type {{code?: unknown}} */ (error).code === 'EPERM';
    }
  }

  pollTimer = setInterval(() => {
    if (state !== 'running') return;
    if (!parentAlive(parentPid)) beginShutdown('parent_gone');
  }, PARENT_POLL_MS);
  pollTimer.unref?.();

  process.stdin.on('end', () => beginShutdown('parent_stdin_end'));
  process.stdin.on('close', () => beginShutdown('parent_stdin_close'));
  process.stdin.on('error', () => beginShutdown('parent_stdin_error'));

  /**
   * 结束流程。幂等；顺序固定为：停新连接 → 关控制通道 → 结束子 stdin → 等子退出 →
   * 必要时终止自己持有的 handle → 清定时器与监听 → 自然退出。
   *
   * @param {string} reason
   */
  function beginShutdown(reason) {
    if (state !== 'running') return;
    state = 'shutting_down';
    diag.write('shutdown_begin', { phase: reason, result: 'shutting_down' });

    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    // 顺序：先把在等的控制端都告知"tap 正在关闭"，再关控制通道。
    const server = control;
    for (const [requestId, entry] of [...pending]) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      server?.sendTo(entry.connectionId, {
        v: TAP_PROTOCOL_VERSION,
        op: 'response.error',
        requestId,
        error: { code: 'shutting_down', detail: 'tap 正在关闭' }
      });
    }
    pending.clear();
    pendingIds.clear();
    if (server !== null) {
      server.close();
      control = null;
    }
    for (const pump of pumps) pump.stop();
    try {
      child.stdin.end();
    } catch {
      // 子进程已退出。
    }
    // 让事件循环能自然走到空：stdin 引用计数摘掉后没有任何东西再吊着本进程。
    try {
      process.stdin.pause();
      process.stdin.unref?.();
    } catch {
      // 老版本运行时没有 unref，忽略。
    }

    if (childExited) {
      finish();
      return;
    }
    graceTimer = setTimeout(() => {
      graceTimer = null;
      diag.write('shutdown_escalate', { phase: reason, result: 'kill_child' });
      try {
        // 只对自己 spawn 出来的、持有 handle 的子进程动手；不按名字/端口猜。
        child.kill();
      } catch {
        // 已经退出。
      }
      killTimer = setTimeout(() => {
        killTimer = null;
        finish();
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }, SHUTDOWN_GRACE_MS);
    graceTimer.unref?.();
  }

  /** 收尾：摘监听、定退出码，然后让事件循环自然排空。绝不用 `process.exit(0)`。 */
  function finish() {
    if (state === 'stopped') return;
    state = 'stopped';
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (graceTimer !== null) {
      clearInterval(graceTimer);
      graceTimer = null;
    }
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (control !== null) {
      control.close();
      control = null;
    }
    for (const pump of pumps) pump.stop();
    diag.write('shutdown_done', {
      phase: 'stopped',
      pid: typeof child.pid === 'number' ? child.pid : null,
      exitCode: childExitCode,
      result: state,
      bytesToChild: relayBytes(0),
      bytesToParent: relayBytes(1),
      stderrBytes: relayBytes(2),
      scannedLines,
      unmatchedFrames,
      overflowed: scanner.overflowed,
      durationMs: Date.now() - startedAtMs
    });
    process.exitCode = childExitCode ?? 0;
  }

  child.on('error', (error) => {
    diag.write('child_error', { code: errorCodeOf(error, 'ECHILD'), result: 'error' });
    childExitCode = 1;
    childExited = true;
    if (state === 'running') beginShutdown('child_error');
    else if (state === 'shutting_down') finish();
  });

  child.on('exit', (code, signal) => {
    childExitCode = code;
    childExited = true;
    diag.write('child_exit', {
      pid: typeof child.pid === 'number' ? child.pid : null,
      exitCode: code,
      signal: signal ?? null,
      result: 'exit'
    });
    // 已经进入关闭流程时（例如先收到 stdin end、再等到子进程退出），beginShutdown
    // 会因幂等保护直接返回，所以这里必须显式收尾，否则 shutdown_done 永不落盘。
    if (state === 'running') beginShutdown('child_exit');
    else if (state === 'shutting_down') finish();
  });

  /* -------------------------------------------------------------------------- */
  /* 控制通道                                                                    */
  /* -------------------------------------------------------------------------- */

  /**
   * 令牌来源：环境变量优先，其次是 `ZCC_TAP_TOKEN_FILE`，最后是脚本同目录
   * `zcode-tap-control.json` 指向的令牌文件。**没有任何写死的默认值**：拿不到令牌
   * 就不监听控制端口（中继照常工作，注入入口不存在），绝不为了"能连上"降级成免令牌。
   *
   * @returns {{ path: string | null, content: string | null }}
   */
  function loadTokenFile() {
    const fromEnv = process.env['ZCC_TAP_TOKEN_FILE'];
    const candidates = [];
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) candidates.push(resolve(fromEnv.trim()));
    else {
      try {
        const raw = readFileSync(join(SCRIPT_DIR, CONTROL_CONFIG_FILE), 'utf8');
        const parsed = JSON.parse(raw);
        const file = typeof parsed === 'object' && parsed !== null ? /** @type {Record<string, unknown>} */ (parsed)['tokenFile'] : undefined;
        if (typeof file === 'string' && file.trim().length > 0) candidates.push(resolve(SCRIPT_DIR, file.trim()));
      } catch {
        // 没有配置文件：安装脚本还没跑过，或故意不给令牌。
      }
    }
    for (const candidate of candidates) {
      try {
        return { path: candidate, content: readFileSync(candidate, 'utf8') };
      } catch {
        return { path: candidate, content: null };
      }
    }
    return { path: null, content: null };
  }

  const tokenFile = loadTokenFile();
  const tokenResult = resolveControlToken(process.env, tokenFile.path, tokenFile.content);
  if (!tokenResult.ok) {
    // 没有可用令牌 → 拒绝启动控制通道。桌面侧的 agent 行为与没有 tap 时完全一致。
    diag.write('control_refused', { code: tokenResult.code, result: 'refused', controlPort: options.controlPort });
  } else {
    startControlServer({
      host: '127.0.0.1',
      port: options.controlPort,
      token: tokenResult.token,
      inject: handleInject,
      diag: (event, fields) => diag.write(event, fields),
      status: () => ({
        pid: typeof child.pid === 'number' ? child.pid : null,
        exitCode: childExitCode,
        controlConnections: control?.connections ?? 0,
        controlPort: options.controlPort,
        bytesToChild: relayBytes(0),
        bytesToParent: relayBytes(1),
        stderrBytes: relayBytes(2),
        scannedLines,
        unmatchedFrames,
        overflowed: scanner.overflowed,
        tokenSource: tokenResult.source,
        state
      })
    })
      .then((server) => {
        if (state !== 'running') {
          // 令牌解析期间就已经进入关闭流程：别把监听又拉起来。
          server.close();
          return;
        }
        control = server;
        diag.write('control_listen', {
          controlPort: server.port,
          tokenSource: tokenResult.source,
          result: 'ok',
          phase: 'start'
        });
      })
      .catch((error) => {
        diag.write('control_listen_failed', {
          code: errorCodeOf(error, 'ECONTROL'),
          result: 'error',
          controlPort: options.controlPort
        });
      });
  }
}

export { CONTROL_DEFAULT_PORT };
