/**
 * tap-harness.mjs — TAPIMPL 测试的进程夹具工具（fixture-only，不是产品代码）。
 *
 * 职责：把 tap 当成黑盒**起进程**，给它三条 stdio 管道，等它退出；同时提供一个
 * 极简的控制端客户端。测试里不允许出现裸 `spawn`/`net.connect`，免得每个用例各
 * 写一套超时逻辑、最后各漏各的回收。
 *
 * 回收纪律（工程 AGENTS.md §3）：每个夹具子进程都由本模块 spawn，测试必须在
 * `finally` 里 `stop()`；`stop()` 走的是"关 stdin → 有界等待退出 → 再兜底终止
 * **自己持有的 handle**"，不按进程名/端口猜所有权。
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = resolve(TESTS_DIR, '..');
export const TAP_ENTRY = join(REPO_ROOT, 'scripts', 'official-tap', 'zcode-stdio-tap.mjs');
export const FIXTURE_PEER = join(TESTS_DIR, 'fixtures', 'fake-tap-peer.mjs');

/**
 * 临时目录。每个测试自己建、自己删（`finally`）。
 *
 * @param {string} prefix
 * @returns {string}
 */
export function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `zcc-tap-${prefix}-`));
}

/**
 * @param {string} dir
 */
export function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 有界轮询等待。**超时一定抛错**，绝不静默返回——静默超时会造出"假绿"。
 *
 * @param {() => unknown} probe 可以是同步或异步探测
 * @param {{ timeoutMs?: number, intervalMs?: number, what?: string }} [options]
 * @returns {Promise<unknown>}
 */
export async function waitFor(probe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // 探测函数允许抛错（例如"文件还没生成"）：未就绪 ≠ 失败，只有到 deadline
    // 仍未就绪才算超时。吞掉探测异常不会掩盖真问题——真问题会表现为超时。
    let value;
    try {
      value = await probe();
    } catch {
      value = null;
    }
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs} ms${options.what === undefined ? '' : ` (${options.what})`}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * @typedef {Object} TapHandle
 * @property {(chunk: Buffer | string) => void} write 写进 tap 的 stdin（扮演桌面）。
 * @property {() => Buffer} stdout 至今从 tap 的 stdout 收到的全部字节（扮演桌面读侧）。
 * @property {() => number} stdoutLength
 * @property {() => void} endStdin 关掉 tap 的 stdin（桌面消失）。
 * @property {() => Promise<{ code: number | null, signal: string | null }>} waitExit
 * @property {() => Promise<{ code: number | null, signal: string | null }>} whenExited 与 `waitExit` 相同，但语义上用于"与其它等待**竞速**"：它已经在退出时立即 resolve，没有退出就一直挂着。用来把"tap 死了"从一个 10 秒之后才浮现的超时，提前到**当场**变红（TAPN / N4）。
 * @property {() => Promise<void>} stop 关 stdin、有界等退出、必要时终止**自己持有的** handle。
 * @property {() => number} pid
 * @property {() => string} stderr
 * @property {{ code: number | null, signal: string | null } | null} exit
 */

/**
 * 起一个 tap 进程。
 *
 * `tapArgs` 直接替换 tap 的整个 argv（不含 `process.argv[0..1]`）。它存在的唯一
 * 理由是**启动拒绝路径**可测：正常构造出的 argv 永远带 `--` 分界符，于是
 * `parseTapArgv` 永远成功，启动拒绝分支在黑盒层面一条测试都覆盖不到。给了
 * `tapArgs` 就可以原样喂一个坏 argv，断言"恰好一行 stderr、退出码 2、无绝对路径"。
 *
 * @param {{ fixtureArgs?: readonly string[], logDir?: string | null, port?: number, env?: Record<string, string>, command?: string, commandArgs?: readonly string[], entry?: string, cwd?: string, noInheritedToken?: boolean, tapArgs?: readonly string[] }} [options]
 * @returns {TapHandle}
 */
export function startTap(options = {}) {
  const logDir = options.logDir ?? null;
  const port = options.port ?? 8791;
  const args =
    options.tapArgs === undefined
      ? (() => {
          const built = [options.entry ?? TAP_ENTRY, '--workspace-key', 'fixture-workspace-key', '--control-port', String(port)];
          if (logDir !== null) built.push('--log-dir', logDir);
          const childCommand = options.command ?? process.execPath;
          const childArgs = options.commandArgs ?? [FIXTURE_PEER, ...(options.fixtureArgs ?? [])];
          built.push('--', childCommand, ...childArgs);
          return built;
        })()
      : [options.entry ?? TAP_ENTRY, ...options.tapArgs];

  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (options.noInheritedToken === true) {
    // 显式清掉：用来证明"令牌来自文件"而不是"碰巧继承了环境变量"。
    delete env['ZCC_TAP_TOKEN'];
    delete env['ZCC_TAP_TOKEN_FILE'];
  }
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...env, ...(options.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  /** @type {Buffer[]} */
  const outChunks = [];
  /** @type {string[]} */
  const errChunks = [];
  let exited = false;
  /** @type {{ code: number | null, signal: string | null } | null} */
  let exit = null;
  /** @type {Array<(record: { code: number | null, signal: string | null }) => void>} */
  const exitWaiters = [];

  child.stdout.on('data', (chunk) => outChunks.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => errChunks.push(chunk.toString('utf8')));
  child.on('exit', (code, signal) => {
    exited = true;
    exit = { code, signal };
    const record = exit;
    for (const waiter of exitWaiters.splice(0, exitWaiters.length)) waiter(record);
  });

  /**
   * @returns {Promise<{ code: number | null, signal: string | null }>}
   */
  const waitExit = () =>
    exited && exit !== null
      ? Promise.resolve(exit)
      : new Promise((resolveExit, rejectExit) => {
          const timer = setTimeout(() => rejectExit(new Error('tap did not exit within timeout')), 20_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolveExit(exit ?? { code: null, signal: null });
          });
        });

  /**
   * 已退出就立即返回；没退出就一直挂着（**永不 reject**——"tap 还没死"不是错误）。
   * 调用方拿它和别的 promise `Promise.race`，把退出变成一条**当场**的失败信号。
   *
   * @returns {Promise<{ code: number | null, signal: string | null }>}
   */
  const whenExited = () =>
    exited && exit !== null
      ? Promise.resolve(exit)
      : new Promise((resolveExit) => {
          exitWaiters.push(resolveExit);
        });

  return {
    write(chunk) {
      child.stdin.write(chunk);
    },
    stdout() {
      return Buffer.concat(outChunks);
    },
    stdoutLength() {
      let total = 0;
      for (const chunk of outChunks) total += chunk.length;
      return total;
    },
    endStdin() {
      child.stdin.end();
    },
    waitExit,
    whenExited,
    async stop() {
      if (exited) return;
      child.stdin.end();
      // 有界等待：8 秒内自己退不出来，才终止**自己持有的** spawn handle。
      const deadline = Date.now() + 8000;
      while (!exited && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!exited) child.kill();
    },
    pid() {
      return child.pid ?? -1;
    },
    stderr() {
      return errChunks.join('');
    },
    get exit() {
      return exit;
    }
  };
}

/**
 * 控制端客户端（测试侧）。先 auth，再按"匹配条件"收帧。
 *
 * 两份账本：`log` 记下**收到过的每一帧**（供"控制端从未收到 X"这类断言），
 * `queue` 是尚未被 `nextWhere` 消费的部分。匹配式收帧而不是只按 op 收，是因为
 * 一次断言往往要区分同 op 的多帧（例如五次 `inject.error`）。
 *
 * @typedef {Object} ControlClient
 * @property {(envelope: Record<string, unknown>) => void} send
 * @property {(raw: string) => void} sendFrame 发**原始一行**（自动补换行），用来测非法 JSON。
 * @property {(chunk: string | Buffer) => void} writeRaw 发**原始字节**（**不补换行**）。行在累积阶段就超界的那条路径要求整段流里一个 `\n` 都没有，补了换行就变成"一条普通大行"，测的是另一条守卫。
 * @property {(match: (frame: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>} nextWhere 收下一帧匹配的 zccTap（匹配后即被消费）。
 * @property {(op: string, timeoutMs?: number) => Promise<Record<string, unknown>>} next 收下一帧指定 op 的 zccTap。
 * @property {() => Record<string, unknown>[]} all 至今收到的全部 zccTap。
 * @property {() => void} close
 */

/**
 * @param {number} port
 * @param {string} token
 * @param {number} [timeoutMs]
 * @returns {Promise<ControlClient>}
 */
export function connectControl(port, token, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  /** @param {number} remaining @returns {Promise<ControlClient>} */
  const attempt = (remaining) =>
    new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
    /** @type {Buffer} */
    let buffered = Buffer.alloc(0);
    /** @type {Record<string, unknown>[]} */
    const log = [];
    /** @type {Record<string, unknown>[]} */
    const queue = [];
    /** @type {Array<{ match: (frame: Record<string, unknown>) => boolean, resolve: (v: Record<string, unknown>) => void, timer: NodeJS.Timeout }>} */
    const waiters = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) reject(new Error(`control connect to 127.0.0.1:${port} timed out`));
    }, timeoutMs);
    timer.unref?.();

    /** @param {Record<string, unknown>} zccTap */
    const dispatch = (zccTap) => {
      log.push(zccTap);
      for (let i = 0; i < waiters.length; i++) {
        const waiter = waiters[i];
        if (waiter !== undefined && waiter.match(zccTap)) {
          waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(zccTap);
          return;
        }
      }
      queue.push(zccTap);
    };

    socket.on('connect', () => {
      settled = true;
      clearTimeout(timer);
      socket.write(`${JSON.stringify({ zccTap: { v: 1, op: 'auth', token } })}
`);
      /**
       * @param {(frame: Record<string, unknown>) => boolean} match
       * @param {number} [opTimeoutMs]
       * @returns {Promise<Record<string, unknown>>}
       */
      const nextWhere = (match, opTimeoutMs = 10_000) => {
          const at = queue.findIndex((frame) => match(frame));
          if (at >= 0) {
            const [hit] = queue.splice(at, 1);
            return Promise.resolve(hit ?? {});
          }
          return new Promise((resolveNext, rejectNext) => {
            const waiterTimer = setTimeout(() => {
              const index = waiters.findIndex((w) => w !== undefined && w.timer === waiterTimer);
              if (index >= 0) waiters.splice(index, 1);
              rejectNext(new Error(`control frame not received within ${opTimeoutMs} ms; saw ops=${JSON.stringify(log.map((f) => f['op']))}`));
            }, opTimeoutMs);
            waiterTimer.unref?.();
            waiters.push({ match, resolve: resolveNext, timer: waiterTimer });
          });
        };
      resolve({
        send(envelope) {
          socket.write(`${JSON.stringify(envelope)}
`);
        },
        sendFrame(raw) {
          socket.write(`${raw}${String.fromCharCode(10)}`);
        },
        writeRaw(chunk) {
          socket.write(chunk);
        },
        nextWhere,
        next(op, opTimeoutMs = 10_000) {
          return nextWhere((/** @type {Record<string, unknown>} */ frame) => String(frame['op'] ?? '') === op, opTimeoutMs);
        },
        all() {
          return [...log];
        },
        close() {
          socket.destroy();
        }
      });
    });
    socket.on('error', (error) => {
      if (settled) return;
      clearTimeout(timer);
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(/** @type {{code: unknown}} */ (error).code) : 'EUNKNOWN';
      if (code === 'ECONNREFUSED' && Date.now() < deadline) {
        // 监听还没起来（tap 还在启动）：有界重试，不当成"拒绝服务"。
        setTimeout(() => {
          attempt(deadline - Date.now()).then(resolve, reject);
        }, 50).unref?.();
        return;
      }
      reject(error);
    });
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const nl = buffered.indexOf(0x0a);
        if (nl < 0) break;
        const line = buffered.subarray(0, nl).toString('utf8');
        buffered = buffered.subarray(nl + 1);
        if (line.trim().length === 0) continue;
        try {
          const parsed = JSON.parse(line);
          const zccTap = /** @type {Record<string, unknown>} */ (parsed)['zccTap'];
          if (typeof zccTap === 'object' && zccTap !== null) dispatch(/** @type {Record<string, unknown>} */ (zccTap));
        } catch {
          // 不是 JSON 的控制帧：本测试工具只关心合法帧。
        }
      }
    });
    socket.on('close', () => {
      for (const waiter of waiters.splice(0, waiters.length)) {
        clearTimeout(waiter.timer);
        waiter.resolve({ op: '__closed__' });
      }
    });
    });
  return attempt(timeoutMs);
}

/**
 * 等 tap 报出它**实际**绑定的控制端口。
 *
 * 为什么测试一律用 `--control-port 0`（系统分配）而不是固定端口：工程的
 * `tests/contract/gates.test.mjs` 会对真实工程根再跑一次真实的 `test:unit`，
 * 于是同一批单测在**两个 vitest 进程里同时**执行。任何固定端口都会自己撞自己。
 * 生产端口 8791 是 `CONTROL_DEFAULT_PORT` 常量，由纯函数单测钉住；这里只负责
 * 让黑盒测试之间互不干扰。
 *
 * @param {string} logDir
 * @param {number} [timeoutMs]
 * @returns {Promise<number>}
 */
export function waitForControlPort(logDir, timeoutMs = 10_000) {
  return /** @type {Promise<number>} */ (waitFor(
    () => {
      const hit = readDiagEvents(logDir).find((record) => record['event'] === 'control_listen');
      return hit === undefined ? null : Number(hit['controlPort']);
    },
    { what: 'control_listen diag', timeoutMs }
  ));
}

/**
 * 读 tap 的诊断 JSONL 并解析成对象数组。文件还没生成时返回空数组。
 *
 * @param {string} logDir
 * @returns {Array<Record<string, unknown>>}
 */
export function readDiagEvents(logDir) {
  const path = join(logDir, 'zcode-stdio-tap.diag.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(String.fromCharCode(10))
    .filter((line) => line.trim().length > 0)
    .map((line) => /** @type {Record<string, unknown>} */ (JSON.parse(line)));
}

/**
 * 等到诊断里出现指定事件。
 *
 * @param {string} logDir
 * @param {string} event
 * @param {number} [timeoutMs]
 * @returns {Promise<Record<string, unknown>>}
 */
export function waitForDiagEvent(logDir, event, timeoutMs = 10_000) {
  return /** @type {Promise<Record<string, unknown>>} */ (
    waitFor(() => readDiagEvents(logDir).find((record) => record['event'] === event), {
      what: `diag event ${event}`,
      timeoutMs
    })
  );
}

/**
 * 把收到的字节按换行切开并逐行 JSON.parse（测试侧的观察工具，与 tap 无关）。
 *
 * @param {Buffer} buffer
 * @returns {Array<Record<string, unknown>>}
 */
export function parseNdjsonLines(buffer) {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  const lines = buffer.toString('utf8').split(String.fromCharCode(10));
  for (const raw of lines) {
    if (raw.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) out.push(/** @type {Record<string, unknown>} */ (parsed));
    } catch {
      // 非 JSON 行由字节断言负责，解析列表里跳过。
    }
  }
  return out;
}

/**
 * 端口是否可绑（"没被占用"的独立核实手段）。
 *
 * @param {number} port
 * @returns {Promise<{ ok: boolean, code: string | null }>}
 */
export function probePortFree(port) {
  return new Promise((resolve) => {
    const probe = connect({ host: '127.0.0.1', port });
    probe.once('connect', () => {
      probe.destroy();
      resolve({ ok: false, code: 'ECONNECTED' });
    });
    probe.once('error', (error) => {
      const code = typeof error === 'object' && error !== null && 'code' in error ? /** @type {{code: unknown}} */ (error).code : null;
      resolve({ ok: true, code: typeof code === 'string' ? code : 'EUNKNOWN' });
    });
  });
}
