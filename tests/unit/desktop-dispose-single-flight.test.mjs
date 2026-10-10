/**
 * ZC-33 · F06 —— 在途启动不被停止 / 销毁取消；重复 dispose 不提前放行退出。
 *
 * 需求卡 `G:/zcode-project/zcode-dev/1005.md:2042-2055`，依赖 ZC-32。
 *
 * ## 三条缺陷（全部先在**正式**模块上复现出红，再改源码）
 *
 * 1. **预探窗口无人作主**：`start()` 只在**入口**查一次 `disposed`（`proxy-manager.cjs:465`），
 *    随后 `await probeWithinDeadline(...)`（:482）。预探在途期间 `stop()` / `dispose()`
 *    既拿不到句柄（`child === null`，预探返回前还没 spawn），也改不了 `attempt.code`
 *    ——于是在途启动**毫发无损地活过停止**，返回后照样 spawn、照样报 `STARTED`。
 * 2. **`dispose()` 用 `disposed` 兼作单飞闸**：`if (disposed) return { ok: true, code: 'DISPOSED' };`
 *    （:664）让**第二次**调用立刻结算——而第一次还在 `stopOwned()` 里等子进程退出。
 *    这就是原卡的「并发 dispose 的 second 已结算而 first 未结算」。
 *    **推论（实现约束）**：`async function f() { return p; }` 返回的是**新 Promise**，
 *    不是 `p` 本身。要让并发调用拿到同一个对象，`dispose` **不能再是 async**。
 *    **语义边界（主线程 2026-10-07 澄清）**：共享只发生在**收束在途**期间；
 *    **settled 之后**的调用必须回到既有幂等 `DISPOSED` 契约、且**不重新清理**。
 *    所以不能做成「永久单飞」——那会让 settled 之后的调用也返回第一次的值，
 *    反而破坏 `desktop-proxy-manager.test.mjs:346-347` 那个串行幂等断言。
 *    本文件因此把两者**分开钉死**：在途共享同一 pending Promise 并共同等真实收束；
 *    settled 后串行调用仍是 `DISPOSED` 且信号数不变。
 * 3. **`main.cjs` 的 before-quit 没有并发闸**：`cleanedUp` 只在 dispose 完成后才置位，
 *    于是第二次 `before-quit` 会**再发一次** `dispose()`——而按缺陷 2 那一次立刻返回，
 *    `.finally()` 立刻执行 → 在子进程还没退出时 `app.quit()`（提前放行）。
 *
 * ## 纪律
 *  - 直接 `require` **真实** `createProxyManager`；不复制产品函数、不造镜像实现。
 *  - `main.cjs` 的 before-quit 段**从真实源码里提取**（记录来源 SHA）后放进受控
 *    EventEmitter / 假 manager 边界里执行，**不手写替代 quit 算法**。
 *  - 假 probe / 假 ChildProcess / 注入时钟：**不 spawn 真实进程、不监听端口、不联网、
 *    无凭据、不启 Electron / GUI**。这些一律是 FIXTURE，不是真实传输。
 *  - 所有等待都用**显式进入 / 释放 barrier**；断言「未结算」只用**微任务排空**——
 *    微任务必然先于任何定时器，所以这不是靠睡眠赌时序。
 *  - 不用 `sleep` 判时序；定时器与监听器在 `finally` / `afterEach` 里回收。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// `ZC33_PROXY_MANAGER` 只给**写前副本**与**私有单点变异**用：把同一份（冻结的）测试
// 指向别处的 manager 副本。产品文件永不被本测试写入。
// 这个开关在**任何一次红绿跑之前**就已加上，所以红 / 绿 / 变异三跑是同一份测试、同一个 SHA。
const MANAGER_PATH =
  process.env['ZC33_PROXY_MANAGER'] ?? '../../apps/desktop/lib/proxy-manager.cjs';
const { createProxyManager } = require(MANAGER_PATH);
const { createLogRing } = require('../../apps/desktop/lib/log-ring.cjs');

// `ZC33_MAIN_PATH` 同理：让 **main.cjs 的 before-quit 段**也能被指向别处的副本，
// 于是 RED 与 main 侧的变异**都不需要碰产品文件**。
const MAIN_PATH =
  process.env['ZC33_MAIN_PATH'] ?? fileURLToPath(new URL('../../apps/desktop/main.cjs', import.meta.url));

/** 合成 key：非真实凭据，不来自任何环境变量或文件。 */
const SYNTHETIC_KEY = 'zc33_synthetic_key_not_a_credential';
const SPAWN_SPEC = Object.freeze({
  command: 'node',
  args: ['/synthetic/start-api.mjs'],
  env: { ZCC_API_KEY: SYNTHETIC_KEY, ZCC_API_PORT: '8791' },
  cwd: '/synthetic',
  windowsHide: true,
  shell: false
});

/** 本文件创建的全部定时器，测试后必须归零。 */
const liveTimers = new Set();
/** @param {() => void} fn @param {number} ms */
function trackedTimeout(fn, ms) {
  const t = setTimeout(() => {
    liveTimers.delete(t);
    fn();
  }, ms);
  liveTimers.add(t);
  return t;
}
afterEach(() => {
  for (const t of liveTimers) clearTimeout(t);
  liveTimers.clear();
});

/**
 * 排空微任务。用于「还没结算」这类断言：**微任务必然先于任何定时器**，
 * 所以排空完成时不可能已经跨过任何 `setTimeout` 回调 —— 这是 barrier，不是睡眠。
 * @param {number} [rounds]
 */
async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** 假子进程：接口与 `child_process` 的 ChildProcess 对齐（够状态机用即可）。 */
class FakeChild extends EventEmitter {
  /** @param {number} pid */
  constructor(pid) {
    super();
    /** @type {number} */
    this.pid = pid;
    /** @type {any} */
    this.stdout = new EventEmitter();
    /** @type {any} */
    this.stderr = new EventEmitter();
    /** @type {string[]} 收到过的信号。 */
    this.signals = [];
    /** @type {boolean} 收到信号后是否配合退出（由用例显式决定，不靠时间）。 */
    this.exitOnKill = false;
  }

  /**
   * @param {string} signal
   * @returns {boolean}
   */
  kill(signal) {
    this.signals.push(signal);
    if (this.exitOnKill) {
      // 配合退出：走微任务/宏任务队列，不经过任何计时等待。
      setImmediate(() => {
        this.emit('exit', 0, signal);
      });
    }
    return true;
  }

  /**
   * @param {number | null} code
   * @param {string | null} [signal]
   */
  reallyExit(code, signal = null) {
    this.emit('exit', code, signal);
  }
}

/**
 * 按脚本作答的受控探测。
 *
 * 脚本项：`true` / `false` 立刻作答；`'gate'` 挂起等用例**显式**释放；
 * `'hang'` 永不落定（由启动预算的定时器兜住）。用尽后重复最后一项。
 *
 * `entered[i]` 在**第 i 次调用进入时**兑现，用例用它确认「确实已在途」，
 * 而不是靠等一会儿来猜。
 *
 * @param {Array<boolean | 'gate' | 'hang'>} script
 */
function scriptedProbe(script) {
  /** @type {number[]} */
  const calls = [];
  /** @type {Array<{ p: Promise<void>, resolve: () => void }>} */
  const entered = script.map(() => {
    /** @type {((value: unknown) => void) | undefined} */
    let resolve;
    const p = new Promise((r) => {
      resolve = r;
    });
    return { p, resolve: /** @type {() => void} */ (resolve) };
  });
  /** @type {Array<(value: unknown) => void>} */
  const releases = [];

  /** @param {number} port @param {AbortSignal} [signal] */
  function probeApi(port, signal) {
    void signal;
    const idx = calls.length;
    calls.push(port);
    const entry = script[Math.min(idx, script.length - 1)] ?? false;
    const mark = entered[Math.min(idx, entered.length - 1)];
    if (entry === 'gate') {
      return new Promise((resolve) => {
        releases[idx] = (value) => resolve(/** @type {boolean} */ (value));
        mark?.resolve();
      });
    }
    mark?.resolve();
    if (entry === 'hang') return new Promise(() => {});
    return Promise.resolve(entry);
  }

  return {
    calls,
    probeApi,
    /** @param {number} idx */
    async waitEntered(idx) {
      const slot = entered[idx];
      if (!slot) throw new Error(`脚本里没有第 ${idx} 次探测（长度 ${entered.length}）`);
      await slot.p;
    },
    /** @param {number} idx @param {boolean} value */
    release(idx, value) {
      const rel = releases[idx];
      if (!rel) throw new Error(`第 ${idx} 次探测没有挂起，无法释放`);
      rel(value);
    }
  };
}

/**
 * @typedef {object} ManagerOptions
 * @property {boolean} [exitOnKill] 收到信号后是否配合退出
 * @property {() => number} [now] 注入时钟
 * @property {number} [pollIntervalMs]
 * @property {number} [startTimeoutMs]
 * @property {number} [shutdownGraceMs]
 */

/**
 * @param {ReturnType<typeof scriptedProbe>} ctl
 * @param {ManagerOptions} [options]
 */
function makeManager(ctl, options = {}) {
  /** @type {FakeChild[]} */
  const children = [];
  let nextPid = 4001;
  let spawnCount = 0;
  const exitOnKill = options.exitOnKill ?? false;
  const manager = createProxyManager({
    spawnChild: () => {
      spawnCount += 1;
      const child = new FakeChild(nextPid);
      nextPid += 1;
      child.exitOnKill = exitOnKill;
      children.push(child);
      return child;
    },
    probeApi: ctl.probeApi,
    logRing: createLogRing({ capacity: 50 }),
    // 默认注入**冻结时钟**：预算不会自己走完，测试完全由 barrier 驱动。
    now: options.now ?? (() => 0),
    pollIntervalMs: options.pollIntervalMs ?? 5,
    startTimeoutMs: options.startTimeoutMs ?? 100,
    shutdownGraceMs: options.shutdownGraceMs ?? 200
  });
  manager.configure({ port: 8791, spawnSpec: SPAWN_SPEC });
  return { manager, children, spawnCount: () => spawnCount };
}

/** @param {FakeChild[]} children @param {number} i */
function childAt(children, i) {
  const c = children[i];
  if (!c) throw new Error(`没有第 ${i} 个子进程（实际 ${children.length} 个）`);
  return c;
}

/**
 * 从**真实** `main.cjs` 里提取 before-quit 注册段。
 *
 * 不用手写替代品：锚点 + 括号配平切出真实源码，返回原文与来源 SHA，
 * 交给 `new Function` 在受控作用域里执行。
 */
function extractBeforeQuitBlock() {
  const src = readFileSync(MAIN_PATH, 'utf8');
  const anchor = src.indexOf('let cleanedUp = false;');
  if (anchor < 0) throw new Error('main.cjs 里找不到锚点 `let cleanedUp = false;`');
  const onIdx = src.indexOf("app.on('before-quit'", anchor);
  if (onIdx < 0) throw new Error('main.cjs 里找不到 `app.on(\'before-quit\', ...)`');
  // 括号配平，找 `app.on(...)` 的收尾。
  let depth = 0;
  let started = false;
  let i = onIdx;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') {
      depth += 1;
      started = true;
    } else if (ch === ')') {
      depth -= 1;
      if (started && depth === 0) break;
    }
  }
  if (!started || depth !== 0) throw new Error('before-quit 注册段括号配平失败');
  const semi = src.indexOf(';', i);
  if (semi < 0) throw new Error('before-quit 注册段找不到收尾分号');
  const block = src.slice(anchor, semi + 1);
  // 提取歪了就当场炸，绝不拿一段垃圾去当被测对象。
  for (const marker of ['preventDefault()', 'cleanedUp', 'app.quit()', 'RUN_MODE']) {
    if (!block.includes(marker)) throw new Error(`提取到的 before-quit 段缺少 ${marker}`);
  }
  return { block, sourceSha: createHash('sha256').update(src).digest('hex') };
}

/**
 * 把真实 before-quit 段装进受控边界：假 app（EventEmitter）、假 manager（可控 dispose）。
 * @param {() => Promise<unknown>} disposeImpl
 */
function mountBeforeQuit(disposeImpl) {
  const { block, sourceSha } = extractBeforeQuitBlock();
  let disposeCalls = 0;
  /** @type {string[]} */
  const quits = [];
  /** @type {string[]} */
  const prevented = [];
  /** @type {any} */
  const app = new EventEmitter();
  app.quit = () => {
    quits.push('quit');
  };
  const manager = {
    dispose: () => {
      disposeCalls += 1;
      return disposeImpl();
    }
  };
  const tray = { destroy: () => {} };
  // 真实源码在受控作用域里执行；`cleanedUp` 由源码自己声明。
  // eslint-disable-next-line no-new-func
  const factory = new Function('app', 'manager', 'RUN_MODE', 'tray', block);
  factory(app, manager, 'product', tray);
  const fire = () => {
    app.emit('before-quit', {
      preventDefault: () => {
        prevented.push('preventDefault');
      }
    });
  };
  return { fire, quits, prevented, disposeCalls: () => disposeCalls, sourceSha, block };
}

describe('ZC-33 · F06 在途启动被停止 / 销毁取消', () => {
  it('预探在途时 dispose：不得再 spawn，也不得采纳迟到的探测结果', async () => {
    const ctl = scriptedProbe(['gate', true]);
    const { manager, spawnCount } = makeManager(ctl);

    const starting = manager.start();
    await ctl.waitEntered(0); // 预探确实在途
    const disposed = await manager.dispose();
    ctl.release(0, false); // 迟到的预探结果
    const result = await starting;

    expect(disposed.ok).toBe(true);
    // 停止 / 销毁之后，一个子进程都不许再被拉起来。
    expect(spawnCount()).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe('STARTED');
    const snap = manager.getSnapshot();
    expect(snap.state).not.toBe('running');
    expect(snap.owned).toBe(false);
  });

  it('预探在途时 stop：同样不得再 spawn，也不得采纳迟到的探测结果', async () => {
    const ctl = scriptedProbe(['gate', true]);
    const { manager, spawnCount } = makeManager(ctl);

    const starting = manager.start();
    await ctl.waitEntered(0); // 预探确实在途
    const stopped = await manager.stop();
    ctl.release(0, false); // 迟到的预探结果
    const result = await starting;

    expect(stopped.ok).toBe(true);
    expect(spawnCount()).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe('STARTED');
    expect(manager.getSnapshot().state).not.toBe('running');
  });

  it('并发 dispose（收束在途）：必须复用同一 pending Promise，并共同真正等到子进程退出', async () => {
    const ctl = scriptedProbe([false, true]);
    const { manager, children } = makeManager(ctl);
    await manager.start(); // 先真跑起来，dispose 才真的要等子进程退出
    const child = childAt(children, 0);

    const first = manager.dispose();
    const second = manager.dispose();

    // 收束**在途**时，两个调用拿到的是同一个 pending Promise 对象。
    expect(second).toBe(first);
    let settled = 0;
    first.then(() => {
      settled += 1;
    });
    second.then(() => {
      settled += 1;
    });
    await flushMicrotasks();
    // 子进程还没退出 ⇒ 两个都不得结算（微任务排空早于任何定时器）。
    expect(settled).toBe(0);

    child.reallyExit(0);
    const [r1, r2] = await Promise.all([first, second]);
    // 共同等到**真实收束完成**，不是共享一个空壳就早退。
    expect(r1).toEqual({ ok: true, code: 'STOPPED' });
    expect(r2).toEqual(r1);
    expect(child.signals).toContain('SIGINT');
    expect(manager.getState()).toBe('stopped');
    expect(manager.getSnapshot().owned).toBe(false);
  });

  it('收束 settled 之后再 dispose：保持既有幂等 DISPOSED 契约，且不重新清理', async () => {
    const ctl = scriptedProbe([false, true]);
    const { manager, children } = makeManager(ctl);
    await manager.start();
    const child = childAt(children, 0);

    const first = await manager.dispose();
    expect(first).toEqual({ ok: true, code: 'STOPPED' });
    const signalsAfterFirst = child.signals.length;

    // 已经 settled 的调用**不再共享**在途 Promise，走既有幂等分支。
    const afterSettled = manager.dispose();
    expect(await afterSettled).toEqual({ ok: true, code: 'DISPOSED' });
    // 不重新清理：不再补发任何信号，状态也不许被改写。
    expect(child.signals.length).toBe(signalsAfterFirst);
    expect(manager.getState()).toBe('stopped');
  });

  it('真实 manager + 真实 before-quit 段：子进程未退出前不得放行 quit', async () => {
    const ctl = scriptedProbe([false, true]);
    const { manager, children } = makeManager(ctl);
    await manager.start();
    const child = childAt(children, 0);

    // dispose 转发到**真实 manager**：这里不用受控空 Promise 冒充收束。
    const harness = mountBeforeQuit(() => manager.dispose());

    harness.fire();
    harness.fire();

    expect(harness.disposeCalls()).toBe(1);
    await flushMicrotasks();
    // 真实子进程尚未退出 ⇒ app.quit() 一次都不许发生。
    expect(harness.quits.length).toBe(0);
    // 真实 dispose 确实已经动了手（不是空转）。
    expect(child.signals).toContain('SIGINT');
    // 两次都得拦住，否则 quit 会绕过收束直接跑掉。
    expect(harness.prevented.length).toBe(2);

    // 真实的退出事件 ⇒ 真实收束完成 ⇒ 才放行，且只放行一次。
    child.reallyExit(0);
    await flushMicrotasks(32);
    expect(harness.quits.length).toBe(1);
    expect(manager.getState()).toBe('stopped');
  });
});

describe('ZC-33 · F06 负例：修得对，但不能把正常路径一起打死', () => {
  it('正常并发 start：第二次仍 BUSY，且只 spawn 一次', async () => {
    const ctl = scriptedProbe([false, true]);
    const { manager, children, spawnCount } = makeManager(ctl, { exitOnKill: true });

    const first = manager.start();
    const second = manager.start(); // 同步第二次：startInFlight 闸必须挡住
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toEqual({ ok: true, code: 'STARTED' });
    expect(r2).toEqual({ ok: false, code: 'BUSY' });
    expect(spawnCount()).toBe(1);
    expect(children.length).toBe(1);
    await manager.dispose();
  });

  it('正常 dispose：仍收敛到已停态，并真的对子进程发过信号', async () => {
    const ctl = scriptedProbe([false, true]);
    const { manager, children } = makeManager(ctl, { exitOnKill: true });
    await manager.start();
    const child = childAt(children, 0);

    const disposed = await manager.dispose();
    expect(disposed.ok).toBe(true);
    expect(child.signals).toContain('SIGINT');
    expect(manager.getState()).toBe('stopped');
    expect(manager.getSnapshot().owned).toBe(false);
  });

  it('stop 完成之后，下一次 start 必须真正 STARTED（停止不许废掉自己这条线）', async () => {
    const ctl = scriptedProbe([false, true, false, true]);
    const { manager, children, spawnCount } = makeManager(ctl, { exitOnKill: true });

    await manager.start();
    const firstChild = childAt(children, 0);
    expect(firstChild.signals.length).toBe(0);

    const stopped = await manager.stop();
    expect(stopped.ok).toBe(true);
    expect(manager.getState()).toBe('stopped');

    const again = await manager.start();
    expect(again).toEqual({ ok: true, code: 'STARTED' });
    expect(spawnCount()).toBe(2);
    expect(manager.getSnapshot().state).toBe('running');
    expect(manager.getSnapshot().pid).toBe(childAt(children, 1).pid);
    await manager.dispose();
  });
});

describe('ZC-33 · F06 回归：ZC-31 / ZC-32 的判定不许被这次修复挪动', () => {
  it('轮询在途时子进程退出，迟到的 true 不得改写成 STARTED', async () => {
    const ctl = scriptedProbe([false, 'gate']);
    const { manager, children } = makeManager(ctl);

    const starting = manager.start();
    await ctl.waitEntered(1); // 轮询探测确实在途
    const child = childAt(children, 0);
    child.reallyExit(0); // 非主动停止
    ctl.release(1, true); // 迟到的 true

    const result = await starting;
    expect(result).toEqual({ ok: false, code: 'CHILD_EXITED' });
    expect(manager.getSnapshot().state).not.toBe('running');
  });

  it('轮询在途时子进程退出，迟到的 false 同样不得改写终态', async () => {
    const ctl = scriptedProbe([false, 'gate']);
    const { manager, children } = makeManager(ctl);

    const starting = manager.start();
    await ctl.waitEntered(1);
    const child = childAt(children, 0);
    child.reallyExit(0);
    ctl.release(1, false); // 迟到的 false

    const result = await starting;
    expect(result).toEqual({ ok: false, code: 'CHILD_EXITED' });
    expect(manager.getSnapshot().state).not.toBe('running');
  });

  it('预探预算耗尽：报 START_TIMEOUT，且一个子进程都不许拉起', async () => {
    const ctl = scriptedProbe(['hang']);
    // 这一条必须用**真实时钟**：预算耗尽本身就是靠定时器落定的。
    const { manager, spawnCount } = makeManager(ctl, { now: () => Date.now(), startTimeoutMs: 30 });

    const result = await manager.start();
    expect(result).toEqual({ ok: false, code: 'START_TIMEOUT' });
    expect(spawnCount()).toBe(0);
    // 预算定时器必须已被回收。
    trackedTimeout(() => {}, 0);
  });
});