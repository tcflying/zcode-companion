/**
 * ZC-30 / F14：Node **异步** `emit('error')`（可执行文件 / cwd 失效 ⇒ ENOENT）
 * 没有进入反代管理器的失败路径，被丢弃成一个误导性的 `START_TIMEOUT`。
 *
 * 事实复现（本卡开工前实测，纯 Node、无 Electron、无网络、无真实模型请求）：
 *   有效 exe + 无效 cwd ⇒ `uncaughtException code=ENOENT`、`errorListeners=0`、
 *   终态 `START_TIMEOUT`，`lastError` 写的是「Nms 内没有探通」——**ENOENT 被整个丢掉**。
 *
 * 根因（`apps/desktop/lib/proxy-manager.cjs`）：`spawnChild()` 只在**同步** throw 时
 * 落 `SPAWN_FAILED`；拿到 ChildProcess 之后只订阅了 `exit`，**一次 `error` 都没订阅**。
 * EventEmitter 的「error 无监听即抛」把这次失败变成一次宿主级全局异常，管理器那边
 * 永远等不到失败信号，只能一路轮询到 startTimeoutMs。
 *
 * provider-free：不 spawn 任何**成功**的进程、不监听任何端口、不发任何网络请求。
 * 唯一一次真实 `spawn` 用的是「有效 exe + 无效 cwd」——它**不会创建任何 OS 进程**
 * （spawn 本身就失败），拿到的是 Node 抛 ENOENT 的那个 ChildProcess 句柄。
 * 其余全部用假子进程 + 受控探测，时序不靠墙钟 sleep 竞速。
 *
 * 口径纪律：这里**不保留**「桌面必崩」断言。Electron 44.4.5 的
 * `lib/browser/init.ts:17-33`（已对 v44.4.5 上游源码核实）明确注册了
 * `process.on('uncaughtException', ...)` 且注释为 "Don't quit on fatal error."——
 * 只弹错误框、不退出。桌面**不会**因为这次 error 崩掉，但**管理器照样会丢掉原因**。
 * 那条宿主行为在本文件里只作为**既有行为的记录**（见 describe 块），断言绝不依赖
 * 宿主的全局异常处理：本文件跑在纯 Node 下，不装 `uncaughtException` 也能全绿。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { at } from '../helpers/desktop-harness.mjs';

const require = createRequire(import.meta.url);
const { createProxyManager } = require('../../apps/desktop/lib/proxy-manager.cjs');
const { createLogRing } = require('../../apps/desktop/lib/log-ring.cjs');

/** 合成凭据常量（只出现在 spawn 规格的 env 形状里，不是也不得是任何真实 key）。 */
const SYNTHETIC_KEY = 'zcc_zc30_unit_synthetic_key_0001';

/** 本卡使用的隔离端口；与 ZC-29 的 28061/28062、生产的 8790 都不重叠。 */
const PORT = 28071;

/** 一个不存在的 cwd：真实存在的 exe + 不存在的 cwd = Node 异步 ENOENT。 */
const MISSING_CWD = 'G:/zcode-project/zcode-companion/__zc30_missing_cwd__';

/** 确实存在的 cwd（仓库根），供「有效 exe + 有效 cwd」对照。 */
const VALID_CWD = 'G:/zcode-project/zcode-companion';

/**
 * @param {string} [cwd]
 */
function specFor(cwd) {
  return {
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 50)'],
    env: { ZCC_API_KEY: SYNTHETIC_KEY, ZCC_API_PORT: String(PORT) },
    cwd: cwd ?? VALID_CWD,
    windowsHide: true,
    shell: false
  };
}

/** 假子进程：接口与 `child_process` 的 ChildProcess 对齐（够状态机用即可）。 */
class FakeChild extends EventEmitter {
  /**
   * @param {number} pid
   * @param {{ killEmitsError?: boolean }} [options] `killEmitsError` 模拟「kill 打到
   *   一个已经不在的进程」：Node 会为它异步发一个 `ESRCH` error，再补一个 exit。
   */
  constructor(pid, options) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    /** @type {string[]} 收到过的信号。 */
    this.signals = [];
    /** @type {boolean} */
    this.killEmitsError = options?.killEmitsError ?? false;
    // 夹具自己挂一个兜底 error 监听（真实 spawn 那条用例同理）：没有它，
    // `emit('error')` 会按 Node 语义**同步抛出**，测试先死于夹具、永远走不到目标断言。
    // 缺陷本身要由管理器侧的行为来证明，不能由夹具替它抛。
    this.on('error', () => {});
  }

  /**
   * @param {string} signal
   * @returns {boolean}
   */
  kill(signal) {
    this.signals.push(signal);
    if (this.killEmitsError) {
      // 与真实 Node 同序：先 error，再 exit。
      this.emit('error', spawnError('ESRCH'));
    }
    if (signal === 'SIGINT' || signal === 'SIGKILL') {
      setImmediate(() => this.emit('exit', 0, null));
    }
    return true;
  }
}

/**
 * 造一个 Node 形态的 spawn error。只带**原因标记** `code`，不带 `message`/`path`：
 * 真实 ENOENT 的 message 里含可执行文件完整路径，而错误体不允许把它原样透出去
 * （§4.10「不得为『好排查』把路径/字段/参数原样写进日志或错误体」）。
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function spawnError(code) {
  const err = /** @type {Error & { code: string }} */ (new Error(`spawn ${code}`));
  err.code = code;
  return err;
}

/** 让出到下一个宏任务，用来跨过 `start()` 内部的若干次 microtask 续延。 */
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * 受控探测：每次调用把序号交给 `onProbe`，由测试精确地在**哪一探**上触发异步 error。
 * 全部返回 false（端口始终「探不通」），所以终态完全由 error / 决定，不由探测决定。
 *
 * @param {{ onPoll?: (index: number) => void }} [options]
 */
function makeProbe(options) {
  /** @type {number[]} 每一次探测的序号，按调用顺序。 */
  const calls = [];
  let index = 0;
  return {
    calls,
    /**
     * @param {number} _port
     * @returns {Promise<boolean>}
     */
    probeApi(_port) {
      const i = index;
      index += 1;
      calls.push(i);
      // i === 0 是 start() 的**预探**；i >= 1 才是 spawn 之后的轮询探测。
      if (i >= 1) options?.onPoll?.(i);
      return Promise.resolve(false);
    }
  };
}

/**
 * @param {{
 *   onPoll?: (index: number) => void,
 *   startTimeoutMs?: number,
 *   pollIntervalMs?: number,
 *   shutdownGraceMs?: number,
 *   killEmitsError?: boolean,
 *   transitions?: string[]
 * }} [options]
 */
function makeManager(options) {
  /** @type {FakeChild[]} */
  const children = [];
  const logRing = createLogRing({ capacity: 50 });
  logRing.addSecret(SYNTHETIC_KEY);
  const probe = makeProbe(options);
  /** @type {any} */
  let manager;
  manager = createProxyManager({
    spawnChild: () => {
      const child = new FakeChild(32000 + children.length, { killEmitsError: options?.killEmitsError });
      children.push(child);
      return child;
    },
    probeApi: probe.probeApi,
    logRing,
    pollIntervalMs: options?.pollIntervalMs ?? 5,
    startTimeoutMs: options?.startTimeoutMs ?? 5000,
    shutdownGraceMs: options?.shutdownGraceMs ?? 50,
    onChange: () => {
      if (options?.transitions) options.transitions.push(manager.getState());
    }
  });
  manager.configure({ port: PORT, spawnSpec: specFor() });
  return { manager, children, calls: probe.calls, logRing };
}

/**
 * 真实 spawn 的安全网：本文件只允许回收**自己创建且持有句柄**的子进程。
 * 失败 spawn 不会创建 OS 进程（这里恒为空），真创建出来的那一个也只按句柄收。
 * @type {Set<import('node:child_process').ChildProcess>}
 */
const ownedHandles = new Set();

afterEach(() => {
  for (const handle of ownedHandles) {
    try {
      handle.kill('SIGKILL');
    } catch {
      /* 从没起来，没有可杀的进程 */
    }
  }
  ownedHandles.clear();
});

describe('ZC-30/F14：异步 spawn error 必须进入管理器失败路径', () => {
  it('有效 exe + 无效 cwd：errorListeners 之前是 0、终态是丢掉原因的 START_TIMEOUT', async () => {
    /** @type {any} */
    let handle = null;
    /** @type {any[]} 真实 Node 抛出来的那个 error（由测试自己兜底接住，见下）。 */
    const observed = [];
    const logRing = createLogRing({ capacity: 20 });
    const manager = createProxyManager({
      spawnChild: (/** @type {any} */ spec) => {
        handle = spawn(spec.command, spec.args, {
          env: spec.env,
          cwd: spec.cwd,
          windowsHide: spec.windowsHide,
          shell: spec.shell,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        ownedHandles.add(handle);
        // **测试自己**挂一个兜底 error 监听：没有它，EventEmitter「error 无监听即抛」
        // 会把整条 vitest 进程带走，反而掩盖管理器本身的行为。所以下面量的是
        // 「管理器自己注册了几个 error 监听」= 总数 − 这一个夹具监听。
        handle.on('error', (/** @type {any} */ err) => {
          observed.push(err);
        });
        return handle;
      },
      probeApi: async () => false,
      logRing,
      pollIntervalMs: 20,
      startTimeoutMs: 300,
      shutdownGraceMs: 50
    });
    manager.configure({ port: PORT, spawnSpec: specFor(MISSING_CWD) });

    const result = await manager.start();
    const snap = manager.getSnapshot();

    // 复现的机器可读证据：Node 确实以 ENOENT 拒绝了这次 spawn。
    expect(observed.length, '真实 spawn 必须以异步 error 收场').toBeGreaterThanOrEqual(1);
    expect(at(observed, 0).code, '失败原因必须真的拿到 ENOENT').toBe('ENOENT');

    // 卡上「errorListeners=0」的可核对替身：夹具占了 1 个，其余全归管理器。
    const managerErrorListeners = handle.listenerCount('error') - 1;
    expect(
      managerErrorListeners,
      '管理器必须自己订阅 ChildProcess 的 error（没订阅 ⇒ 永远进不了失败路径）'
    ).toBeGreaterThanOrEqual(1);

    // 验收：同步 throw 之外的第二条失败入口也必须给出 SPAWN_FAILED，并带上真实原因。
    expect(result, '异步 error 的终态码必须是 SPAWN_FAILED，不能是 START_TIMEOUT').toEqual({
      ok: false,
      code: 'SPAWN_FAILED'
    });
    expect(snap.state, '终态必须落在 failed').toBe('failed');
    expect(String(snap.lastError), '失败原因必须带 ENOENT').toContain('ENOENT');
    // 进程根本没起来 ⇒ 没有可回收的 OS 句柄，管理器引用必须放干净，且不发任何信号。
    expect(snap.pid).toBeNull();
    expect(snap.owned).toBe(false);
  });

  it('异步 error 落 failed 之后：失败后同步闸必须已复位，还能再启动', async () => {
    /** @type {any} */
    let handle = null;
    let spawnCount = 0;
    const logRing = createLogRing({ capacity: 20 });
    const probe = makeProbe();
    const manager = createProxyManager({
      spawnChild: (/** @type {any} */ spec) => {
        spawnCount += 1;
        // 第一次：无效 cwd ⇒ 真 ENOENT。第二次：有效 cwd ⇒ 正常起来，且**活得比
        // startTimeoutMs 久**，好让终态确定地落在 START_TIMEOUT 上，而不是被一次
        // 真实退出抢先变成 CHILD_EXITED（那会把「同步闸是否复位」和「进程活多久」
        // 两件事混在一条断言里）。
        const cwd = spawnCount === 1 ? MISSING_CWD : VALID_CWD;
        const args = spawnCount === 1 ? spec.args : ['-e', 'setTimeout(() => {}, 30000)'];
        handle = spawn(spec.command, args, {
          env: spec.env,
          cwd,
          windowsHide: spec.windowsHide,
          shell: spec.shell,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        ownedHandles.add(handle);
        handle.on('error', () => {});
        return handle;
      },
      probeApi: probe.probeApi,
      logRing,
      pollIntervalMs: 20,
      startTimeoutMs: 300,
      shutdownGraceMs: 60
    });
    manager.configure({ port: PORT, spawnSpec: specFor(MISSING_CWD) });

    expect(await manager.start(), '第一次必是 SPAWN_FAILED').toEqual({ ok: false, code: 'SPAWN_FAILED' });
    expect(manager.getState()).toBe('failed');

    // 漏复位会把状态机永久锁在 BUSY：那样用户只能重启桌面。
    const again = await manager.start();
    expect(again.code, '失败后同步闸必须已复位，第二次必须真的走到探通判定').not.toBe('BUSY');
    expect(again.code, '有效 exe + 有效 cwd 必须走正常启动路径').toBe('START_TIMEOUT');
    expect(manager.getState()).toBe('failed');
    // 只回收自己持有的句柄：超时收束必须真的对那个子进程发过信号。
    expect(await manager.dispose()).toEqual({ ok: true, code: 'NOT_OWNED' });
  });

  it('异步 error 必须**结算等待**：不等 startTimeoutMs 就立刻定终态', async () => {
    // pollIntervalMs 远大于「失败到终态」的合理耗时：只有真的去唤醒等待，
    // 才可能在几毫秒内拿到 SPAWN_FAILED；靠轮询兜底必然拖到 START_TIMEOUT。
    const { manager, children } = makeManager({
      pollIntervalMs: 2000,
      startTimeoutMs: 4000,
      onPoll: (index) => {
        if (index === 1) at(children, 0).emit('error', spawnError('ENOENT'));
      }
    });

    const startedAt = Date.now();
    const result = await manager.start();
    const elapsed = Date.now() - startedAt;

    expect(result).toEqual({ ok: false, code: 'SPAWN_FAILED' });
    expect(elapsed, '终态必须在唤醒后的毫秒级落地，而不是白等到 startTimeoutMs').toBeLessThan(1500);
    expect(manager.getState()).toBe('failed');
  });
});

describe('ZC-30/F14 负例：既有纪律不许被这条修复顺手改掉', () => {
  it('负例(a)：同步 throw 对照保留，合法路径行为不回退', async () => {
    const logRing = createLogRing({ capacity: 20 });
    const manager = createProxyManager({
      spawnChild: () => {
        throw new Error('spawn ENOENT: 找不到反代入口');
      },
      probeApi: async () => false,
      logRing,
      pollIntervalMs: 5,
      startTimeoutMs: 200
    });
    manager.configure({ port: PORT, spawnSpec: specFor() });

    const result = await manager.start();
    // 这条路径一个字都不许改：同步 throw 仍走它自己的 message，仍然 SPAWN_FAILED。
    expect(result).toEqual({ ok: false, code: 'SPAWN_FAILED' });
    expect(manager.getState()).toBe('failed');
    expect(String(manager.getSnapshot().lastError)).toContain('spawn ENOENT: 找不到反代入口');
  });

  it('负例(b)：有效 exe + 有效 cwd 正常启动，error 订阅不许干扰既有路径', async () => {
    /** @type {any} */
    let handle = null;
    /** @type {any[]} 真实子进程上收到过的 error。 */
    const observed = [];
    let reachable = false;
    const logRing = createLogRing({ capacity: 20 });
    const manager = createProxyManager({
      spawnChild: (/** @type {any} */ spec) => {
        handle = spawn(spec.command, spec.args, {
          env: spec.env,
          cwd: spec.cwd,
          windowsHide: spec.windowsHide,
          shell: spec.shell,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        ownedHandles.add(handle);
        handle.on('error', (/** @type {any} */ err) => {
          observed.push(err);
        });
        return handle;
      },
      // 预探答 false（端口是空的），第一轮轮询答 true（起来了且探通）。
      probeApi: async () => {
        if (reachable) return true;
        reachable = true;
        return false;
      },
      logRing,
      pollIntervalMs: 5,
      startTimeoutMs: 2000,
      shutdownGraceMs: 100
    });
    manager.configure({ port: PORT, spawnSpec: specFor(VALID_CWD) });

    const result = await manager.start();
    expect(result, '有效 exe + 有效 cwd 必须是正常的 STARTED').toEqual({ ok: true, code: 'STARTED' });
    expect(manager.getState()).toBe('running');
    const snap = manager.getSnapshot();
    expect(snap.pid).toBe(handle.pid);
    expect(snap.owned).toBe(true);
    expect(snap.lastError).toBeNull();
    // 正常路径上子进程不该发出任何 error。
    expect(observed).toEqual([]);
    // 只回收自己持有句柄的那个进程。
    expect(await manager.stop()).toEqual({ ok: true, code: 'STOPPED' });
    expect(manager.getState()).toBe('stopped');
  });

  it('负例(c-1)：error 与 exit 同时抵达，先到者定终态，不产生双终态', async () => {
    /** @type {string[]} 每一次状态变化的快照。 */
    const transitions = [];
    const { manager, children } = makeManager({
      transitions,
      onPoll: (index) => {
        if (index === 1) {
          const child = at(children, 0);
          // 同一个宏任务里前后脚抵达：Node 上 error 与 exit 常常就是这样成对出现。
          child.emit('error', spawnError('ENOENT'));
          child.emit('exit', 1, null);
        }
      }
    });

    const result = await manager.start();
    expect(result, '先到的 error 定终态').toEqual({ ok: false, code: 'SPAWN_FAILED' });
    const snap = manager.getSnapshot();
    expect(snap.state).toBe('failed');
    expect(String(snap.lastError)).toContain('ENOENT');
    // 后到的 exit 绝不允许把真实原因改写掉。
    expect(String(snap.lastError)).not.toContain('意外退出');
    // 终态只落一次：failed 之后没有第二个结论（没有 stopped / running）。
    const failedAt = transitions.indexOf('failed');
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(transitions.filter((s) => s === 'failed'), 'failed 只能落一次').toHaveLength(1);
    expect(
      transitions.slice(failedAt + 1),
      'failed 之后不得再有任何状态变化（那就是双终态）'
    ).toEqual([]);
  });

  it('负例(c-2)：exit 先到则 exit 定终态，随后抵达的 error 不得改写', async () => {
    /** @type {string[]} */
    const transitions = [];
    const { manager, children } = makeManager({
      transitions,
      onPoll: (index) => {
        if (index === 1) {
          const child = at(children, 0);
          child.emit('exit', 3, null);
          child.emit('error', spawnError('ENOENT'));
        }
      }
    });

    const result = await manager.start();
    expect(result, '先到的 exit 定终态，既有语义不回退').toEqual({ ok: false, code: 'CHILD_EXITED' });
    const snap = manager.getSnapshot();
    expect(snap.state).toBe('failed');
    expect(String(snap.lastError)).toContain('意外退出');
    expect(String(snap.lastError), '迟到的 error 不得覆盖已定的终态原因').not.toContain('ENOENT');
    expect(transitions.filter((s) => s === 'failed'), 'failed 只能落一次').toHaveLength(1);
  });

  it('负例(d)：「桌面不退出」只是 Electron 既有行为的记录，断言不得依赖宿主全局异常处理', () => {
    // 记录（已对 electron v44.4.5 上游 `lib/browser/init.ts:17-33` 核实）：
    // Electron 注册了 `process.on('uncaughtException', ...)`，注释为
    // "Don't quit on fatal error."，只弹错误框、不退出。所以桌面**不会**因为这次
    // 异步 error 崩掉——因此本卡**不保留**「桌面必崩」断言。
    //
    // 这条断言反过来钉住「我们不依赖宿主兜底」：**不**去数 `process` 上的
    // uncaughtException 监听（测试运行器自己就装了一个，数它等于在测 vitest，
    // 恰恰是「依赖宿主全局异常处理」）。真正可核对的是 Node 的 emitter 语义本身：
    // 没订阅就抛，订阅了就不逃逸——管理器必须自己完成那一步订阅。
    // 真实 Node 的「error 无监听即抛」在本文件里是**可复现**的，不是理论推断。
    const bare = new EventEmitter();
    expect(() => bare.emit('error', spawnError('ENOENT'))).toThrow();
    // 订阅之后，同一个事件不再逃逸——这正是管理器必须立刻订阅的那一步。
    const guarded = new EventEmitter();
    guarded.on('error', () => {});
    expect(() => guarded.emit('error', spawnError('ENOENT'))).not.toThrow();
  });

  it('负例(e)：START_TIMEOUT 的收束不许被一次性完成保护卡死（只 SIGINT、且及时返回）', async () => {
    // 回归缺陷 1：超时分支先抢闸（START_TIMEOUT），随后 `stopOwned()` 发的 SIGINT 引发
    // 的 exit 又被**同一个闸**拦下 → `onExit` 永不执行 → `stopWaiter` 永不 resolve →
    // `stopOwned()` 只能走满 grace + SIGKILL + 2s 兜底。一个「子进程配合退出」的正常
    // 收束被拖成 2 秒以上的假等待（实测基线 ~69ms，被拖到 ~2874ms），并且对子进程多发
    // 了本不该发的 SIGKILL。
    const { manager, children } = makeManager({ startTimeoutMs: 60, pollIntervalMs: 5, shutdownGraceMs: 60 });

    const startedAt = Date.now();
    const result = await manager.start();
    const elapsed = Date.now() - startedAt;

    expect(result, '终态码不受影响').toEqual({ ok: false, code: 'START_TIMEOUT' });
    expect(manager.getState(), '失败态必须留在 failed').toBe('failed');
    expect(String(manager.getSnapshot().lastError)).toContain('探通');
    // 配合退出的子进程只需一次 SIGINT；多出来的 SIGKILL 说明 exit 事件被闸吞了。
    expect(
      at(children, 0).signals,
      '子进程配合退出时不得补 SIGKILL（补了就是 exit 事件被一次性完成保护吞掉）'
    ).toEqual(['SIGINT']);
    expect(
      elapsed,
      'grace + SIGKILL + 2s 兜底不该被走满：一次 SIGINT 就该把收束收干净'
    ).toBeLessThan(1500);
  });

  it('负例(f)：starting 期间用户 stop() 引发 kill error 时不得捏造 SPAWN_FAILED', async () => {
    // 回归缺陷 2：`onSpawnError` 原本只挡 `state !== 'starting'`。而用户点「停止」时
    // `intentionalStop` 已置位、state 仍停在 `starting`，于是 SIGINT 打到已经不在的
    // 进程上、Node 补的那个 `ESRCH` error 会被当成「拉起失败」——凭空造出一个
    // SPAWN_FAILED，终态 failed 而基线是 stopped / lastError=null。
    /** @type {string[]} 每一次状态变化的快照。 */
    const transitions = [];
    /** @type {any} */
    let stopPromise = null;
    const { manager, children } = makeManager({
      transitions,
      killEmitsError: true,
      startTimeoutMs: 5000,
      pollIntervalMs: 5,
      shutdownGraceMs: 60,
      // 第一轮**轮询**探测（i=1）时子进程已经起来、state 正是 starting：就在这个点上
      // 同步地发起 stop()，不靠墙钟 sleep 竞速。
      onPoll: (index) => {
        if (index === 1) stopPromise = manager.stop();
      }
    });

    const started = manager.start();
    await started;
    const stopped = await stopPromise;

    expect(stopped, '用户主动停止必须如实报 STOPPED').toEqual({ ok: true, code: 'STOPPED' });
    expect(manager.getState(), '主动停止后的终态是 stopped，不是 failed').toBe('stopped');
    const snap = manager.getSnapshot();
    expect(snap.lastError, '主动停止不产生任何失败原因').toBeNull();
    expect(String(snap.lastError)).not.toContain('拉起失败');
    expect(
      transitions.filter((s) => s === 'failed'),
      'kill error 绝不允许把状态推进 failed'
    ).toEqual([]);
    // 收束确实对那个自 spawn 的句柄发生过。
    expect(at(children, 0).signals).toContain('SIGINT');
  });
});
