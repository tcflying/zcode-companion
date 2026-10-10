/**
 * ZC-32 · F07 —— 晚到 probe 成功覆盖已退出状态。
 *
 * 需求卡 `G:/zcode-project/zcode-dev/1005.md:2025-2038`，唯一依赖 ZC-31。
 *
 * ## 缺陷
 * 轮询循环的 child 身份检查 `if (child !== spawned)` **只在 await 之前**。
 * await 之后只复核了 `attempt.code`，于是「子进程已经退出」这件事
 * **完全绕过了身份检查**：
 *   - 晚 `true` ⇒ 直接进成功分支 ⇒ 报 `STARTED`，而此时 `child === null`
 *     ⇒ 坏快照（`owned:false`、`pid:null`），且把终态从 stopped/failed 改写成 running；
 *   - 晚 `false` ⇒ 落到循环顶部，身份检查在那里等着 ⇒ `CHILD_EXITED`。
 * 这正是原卡「晚 true 失败、晚 false 正常」的原因：**只有 true 那条路不回环。**
 *
 * 为什么 `attempt.code` 拦不住主动停止：exit 监听里是
 * `if (!intentionalStop && !claimAttempt('CHILD_EXITED')) return;`
 * —— 主动停止时**短路跳过** claimAttempt，`attempt.code` 保持 null。
 *
 * ## 纪律
 *  - 直接 `require` **真实** `createProxyManager`；不复制产品函数、不造镜像实现。
 *  - 假 probe / 假 ChildProcess / 注入时钟；**不 spawn 真实进程、不监听端口、
 *    不联网、无凭据、不启 Electron / GUI**。
 *  - 测试资源（定时器、监听器、pending waiter）必须在 `finally` 里回收。
 *  - 验包纯函数用**真实**的 `assessSpawnStep`，断言它**仍拒绝** `pid: null`
 *    —— 只断言「拒绝」，**不得**把它扩大成「必假通过」。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// `ZC32_PROXY_MANAGER` 只给**私有单点变异**用：把同一份（冻结的）测试指向
// os.tmpdir() 里的 manager 副本。产品文件永不被变异脚本写入。
// 这个开关是在**任何一次红绿跑之前**加上的，所以红 / 绿 / 变异三跑用的是同一份
// 测试文件、同一个 SHA —— 不存在「改测试替身后声称同一红绿」。
const MANAGER_PATH =
  process.env['ZC32_PROXY_MANAGER'] ?? '../../apps/desktop/lib/proxy-manager.cjs';
const { createProxyManager } = require(MANAGER_PATH);
const { createLogRing } = require('../../apps/desktop/lib/log-ring.cjs');
const { assessSpawnStep } = require('../../apps/desktop/lib/verify-contract.cjs');

/** 合成 key：非真实凭据，不来自任何环境变量或文件。 */
const SYNTHETIC_KEY = 'zc32_synthetic_key_not_a_credential';
const SPAWN_SPEC = Object.freeze({
  command: 'node',
  args: ['/synthetic/start-api.mjs'],
  env: { ZCC_API_KEY: SYNTHETIC_KEY, ZCC_API_PORT: '8791' },
  cwd: '/synthetic',
  windowsHide: true,
  shell: false
});

const BUDGET = 100;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 本文件创建的全部定时器与待决 waiter，测试后必须归零。 */
const liveTimers = new Set();
/** @param {number} ms */
const trackedSleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(() => {
      liveTimers.delete(t);
      resolve(undefined);
    }, ms);
    liveTimers.add(t);
  });

afterEach(() => {
  for (const t of liveTimers) clearTimeout(t);
  liveTimers.clear();
});

/** @param {ProbeState} state @param {number} n @returns {Promise<void>} */
async function waitForCalls(state, n) {
  for (let i = 0; i < 500; i += 1) {
    if (state.calls >= n) return;
    await tick();
  }
  throw new Error(`等待第 ${n} 次探测超时（实际 ${state.calls}）`);
}

/** 假子进程：`kill()` 会真的发 exit，让收束路径被真实驱动。 */
class FakeChild extends EventEmitter {
  /** @param {number} pid */
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    /** @type {string[]} */
    this.signals = [];
  }

  /** @param {string} signal @returns {boolean} */
  kill(signal) {
    this.signals.push(signal);
    setImmediate(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }
}

/** @typedef {{ t: number }} Clock */
/** @typedef {{ calls: number, gotSignal: number, aborted: number, pending: number, settled: number }} ProbeState */

/**
 * 可手动放行的探测：放行时机由测试控制，「晚」是构造出来的，不是等出来的。
 * JSDoc 类型是**必需**的：AGENTS §3 规定 `typecheck:checkjs` 覆盖 tests/ 下全部 .mjs，
 * 任何一段红都不许绕过。我第一版没写类型，`ci` 直接被我的新文件打红 8 条。
 *
 * @returns {{
 *   probe: (port?: number, signal?: AbortSignal) => Promise<boolean>,
 *   state: ProbeState,
 *   release: (n: number, v: unknown) => void
 * }}
 */
function makeGatedProbe() {
  /** @type {ProbeState} */
  const state = { calls: 0, gotSignal: 0, aborted: 0, pending: 0, settled: 0 };
  /** @type {Array<(value: unknown) => void>} */
  const gates = [];
  /** @type {(port?: number, signal?: AbortSignal) => Promise<boolean>} */
  const probe = (_port, signal) => {
    state.calls += 1;
    if (signal !== undefined) {
      state.gotSignal += 1;
      if (signal.aborted) state.aborted += 1;
      else signal.addEventListener('abort', () => { state.aborted += 1; }, { once: true });
    }
    const gate = new Promise((r) => { gates.push(r); });
    state.pending += 1;
    const abortable =
      signal === undefined
        ? gate
        : new Promise((res, rej) => {
            const onAbort = () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
            gate.then(res, rej);
          });
    return abortable.then(
      (v) => { state.pending -= 1; state.settled += 1; return v === true; },
      (e) => { state.pending -= 1; state.settled += 1; throw e; }
    );
  };
  /** @type {(n: number, v: unknown) => void} */
  const release = (n, v) => {
    const g = gates[n - 1];
    if (g === undefined) throw new Error(`没有第 ${n} 次探测可放行`);
    g(v);
  };
  return { probe, state, release };
}

/**
 * `clock` 不传 ⇒ 不注入 `now`，管理器用真实 `Date.now()`。
 * 注入静态虚拟时钟的循环**永远不会自己推进**，deadline 永远到不了 ⇒ 必然死循环；
 * 所以只有需要「精确卡在 deadline」的场景才注入，且那些场景由测试显式放行。
 *
 * @param {{ probe: (port?: number, signal?: AbortSignal) => Promise<boolean>, clock?: Clock }} opts
 * @returns {{ manager: any, spawned: FakeChild[] }}
 */
function makeManager({ probe, clock }) {
  /** @type {FakeChild[]} */
  const spawned = [];
  /** @type {Record<string, any>} */
  const deps = {
    spawnChild: () => {
      const c = new FakeChild(1000 + spawned.length);
      spawned.push(c);
      return c;
    },
    probeApi: probe,
    logRing: createLogRing({ capacity: 100 }),
    pollIntervalMs: 1,
    startTimeoutMs: BUDGET,
    shutdownGraceMs: 50
  };
  if (clock !== undefined) deps.now = () => clock.t;
  const manager = createProxyManager(deps);
  manager.configure({ port: 8791, spawnSpec: SPAWN_SPEC });
  return { manager, spawned };
}

/**
 * 把状态机推进到「轮询进行中、子进程仍存活」这一步。
 * 返回一个 `lateTrue / lateFalse`，用来在子进程退出之后才落定那次探测。
 */
async function reachPolling() {
  const clock = { t: 0 };
  const { probe, state, release } = makeGatedProbe();
  const { manager, spawned } = makeManager({ probe, clock });

  const started = manager.start();
  await waitForCalls(state, 1);
  release(1, false); // 预探：预算内落 false → 正常 spawn 并进入轮询
  await waitForCalls(state, 2); // 轮询探测已发出，挂起等待我方放行
  expect(spawned).toHaveLength(1);

  return { clock, state, release, manager, spawned, started };
}

describe('ZC-32 · F07 晚到 probe 不得覆盖已退出状态', () => {
  it('红：子进程已退出后，晚到的 true 不得报 STARTED', async () => {
    const { manager, release, started, spawned } = await reachPolling();

    // 主动停止：intentionalStop 置位 ⇒ exit 监听**跳过** claimAttempt，
    // attempt.code 保持 null（这正是晚 true 能溜过去的条件）。
    const stopping = manager.stop();
    await waitFor(() => manager.getSnapshot().state === 'stopped');
    await stopping;

    release(2, true); // 晚到 true
    const result = await started;

    expect(result).not.toEqual({ ok: true, code: 'STARTED' });
    const snap = manager.getSnapshot();
    expect(snap.state).not.toBe('running');
    // 子进程是**被正常停掉**的，所以 pid=null、owned=false 恰恰是**正确**快照。
    // 坏快照是 `state==='running' 且 owned===false`（下面单独一条断言）。
    // 我第一版在这里断言 `pid !== null` / `owned === true`，把「已停止」当成了缺陷。
    expect(snap.pid).toBeNull();
    expect(snap.owned).toBe(false);
    expect(snap.state).toBe('stopped');
    expect(spawned[0]?.signals ?? []).toContain('SIGINT');
  });

  it('红：晚到 true 之后，快照不得是「坏快照」（state=running 且 owned=false）', async () => {
    const { manager, release, started } = await reachPolling();
    const stopping = manager.stop();
    await waitFor(() => manager.getSnapshot().state === 'stopped');
    await stopping;

    release(2, true);
    await started;

    const snap = manager.getSnapshot();
    // 坏快照的机器可读形状：声称 running，却没有任何子进程。
    expect(snap.state === 'running' && snap.owned === false).toBe(false);
  });

  it('红：晚到 true 之后 start / stop / restart 不得全部 BUSY（死锁）', async () => {
    const { manager, release, started } = await reachPolling();
    const stopping = manager.stop();
    await waitFor(() => manager.getSnapshot().state === 'stopped');
    await stopping;

    release(2, true);
    await started;

    const again = await manager.start();
    const stopped = await manager.stop();
    const restarted = await manager.restart();
    const codes = [again, stopped, restarted].map((r) => r.code);
    expect(codes).not.toEqual(['BUSY', 'BUSY', 'BUSY']);
  });

  it('对照：晚到 false 仍是 CHILD_EXITED（这条本来就对，不许回归）', async () => {
    const { manager, release, started } = await reachPolling();
    const stopping = manager.stop();
    await waitFor(() => manager.getSnapshot().state === 'stopped');
    await stopping;

    release(2, false);
    const result = await started;

    expect(result).toEqual({ ok: false, code: 'CHILD_EXITED' });
    expect(manager.getSnapshot().state).not.toBe('running');
  });

  it('对照：存活子进程的 in-budget true 必须仍然正常 STARTED', async () => {
    const { manager, clock, release, started } = await reachPolling();
    clock.t = BUDGET - 1; // 仍在预算内
    release(2, true);

    const result = await started;
    expect(result).toEqual({ ok: true, code: 'STARTED' });
    const snap = manager.getSnapshot();
    expect(snap.state).toBe('running');
    expect(snap.pid).not.toBeNull();
    expect(snap.owned).toBe(true);
  });

  it('对照：同步启动闸仍有效 —— 并发两次 start()，第二次必须 BUSY', async () => {
    // 这条**不注入时钟**：注入静态虚拟时钟的话 deadline 永远到不了，循环会死等。
    const { probe, state, release } = makeGatedProbe();
    const { manager, spawned } = makeManager({ probe });

    const first = manager.start();
    await waitForCalls(state, 1); // 第一次仍卡在预探的 await 上（同步闸已置位）
    const second = await manager.start();
    expect(second).toEqual({ ok: false, code: 'BUSY' });

    // 收尾：把两次探测都放行，让第一次在预算内自然走到 START_TIMEOUT。
    // 不留悬挂 waiter，也不去篡改 state 计数（那是把自己的量具改绿）。
    release(1, false);
    await waitForCalls(state, 2);
    release(2, false);
    const result = await first;

    expect(result.code).toBe('START_TIMEOUT');
    expect(spawned).toHaveLength(1);
    // 不得留下永远挂着的 probe（pending 必须归零）
expect(state.pending).toBe(0);
    // 走到 START_TIMEOUT 时，**取消在途 probe 是正确行为**（ZC-31 已定），所以这里是 1 不是 0。
    // 我第一版误断言成 0，把自己量具的红当成了产品缺陷 —— 对照组写错比对照组缺失更糟。
    // 同理别给 toBe 传第二个「消息」参数：vitest 的 toBe 只收一个，多的那个是类型错误。
    expect(state.aborted).toBe(1);
  });

  it('对照：验包纯函数仍拒绝 pid=null（只断言拒绝，不扩大为必假通过）', async () => {
    const bad = assessSpawnStep({ code: 'STARTED', state: 'running', pid: null, port: 8791 }, 8791);
    expect(bad.ok).toBe(false);

    const good = assessSpawnStep({ code: 'STARTED', state: 'running', pid: 1234, port: 8791 }, 8791);
    expect(good.ok).toBe(true);
  });
});

/**
 * 等到谓词成立；超时抛错而不是死等，保证失败路径有界。
 * @param {() => boolean} predicate
 * @param {number} [maxTicks]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, maxTicks = 500) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('waitFor 超时');
}