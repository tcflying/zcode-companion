/**
 * ZC-29 / F13：预探（`start()` 里的第一次 `probeApi`）在途期间保存设置，
 * 导致 **spawn 用新配置、probe 仍打旧端口** 的错位。
 *
 * provider-free：全部用**假子进程**与**受控模拟端口就绪表**，不 spawn 任何真实进程、
 * 不监听任何端口、不发任何网络请求。**「端口就绪」是受控模拟，不是真实网络探通。**
 *
 * 本文件钉死的是三条不能退让的纪律：
 *  1. 一次 `start()` 用的活动配置（端口 + spawn 规格）必须在**第一次 await 之前成对固定**；
 *     报 `STARTED`/`START_TIMEOUT` 时，探针打的那个端口必须正是子进程被要求监听的端口。
 *  2. `configure()` 必须检查 `startInFlight`：预探窗口里 `state` 还停在 `stopped`，
 *     只读 `state` 的守卫会把在途 start 的活动配置换掉。预探期间的保存**只记待生效配置**。
 *  3. 负例三条不许被"顺手优化"掉：预探后的 `starting` 仍拒绝、重复 start 仍 `BUSY`
 *     且只 spawn 一次、停机状态下的保存照常立刻生效。
 *
 * 时序纪律：预探的应答由测试**显式 resolve**（手动 Promise），超时靠**可控时钟**推到
 * 截止点，不靠墙钟 sleep 竞速。
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { at } from '../helpers/desktop-harness.mjs';

const require = createRequire(import.meta.url);
const { createProxyManager } = require('../../apps/desktop/lib/proxy-manager.cjs');
const { createLogRing } = require('../../apps/desktop/lib/log-ring.cjs');

/** 合成凭据常量（仅供 env 闭集形状断言，不是也不得是任何真实 key）。 */
const SYNTHETIC_KEY = 'zcc_zc29_unit_synthetic_key_0001';

/** 启动瞬间的活动端口。 */
const OLD_PORT = 28061;
/** 预探在途时被保存进去的新端口。 */
const NEW_PORT = 28062;

/**
 * 造一份指定端口的 spawn 规格。`ZCC_API_PORT` 就是子进程真正会去监听的端口，
 * 因此它同时充当「spawnedPorts」的取值来源——**模拟**监听端口，不做任何真实绑定。
 * @param {number} port
 */
function specFor(port) {
  return {
    command: 'node',
    args: ['/synthetic/start-api.mjs', '--driver', 'official-host'],
    env: { ZCC_API_KEY: SYNTHETIC_KEY, ZCC_API_PORT: String(port) },
    cwd: '/synthetic',
    windowsHide: true,
    shell: false
  };
}

/** 假子进程：接口与 `child_process` 的 ChildProcess 对齐（够状态机用即可）。 */
class FakeChild extends EventEmitter {
  /** @param {number} pid */
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    /** @type {string[]} 收到过的信号。 */
    this.signals = [];
  }

  /**
   * 配合型子进程：收到信号就在下一个宏任务里真的退出，不让 `stopOwned()` 的宽限期
   * 变成墙钟等待（那正是 3s/2s 墙钟教训的来源）。
   * @param {string} signal
   * @returns {boolean}
   */
  kill(signal) {
    this.signals.push(signal);
    if (signal === 'SIGINT' || signal === 'SIGKILL') {
      setImmediate(() => this.emit('exit', 0, null));
    }
    return true;
  }
}

/** 让出到下一个宏任务，用来跨过 `start()` 内部的若干次 microtask 续延。 */
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * 可控探测。前 `holdCount` 次调用**挂起不答**，由测试显式 `resolve`——这就是
 * "预探在途窗口"的精确开法；其余调用按模拟就绪表立即作答。
 *
 * `ports` 记录**每一次被探测的端口**，错位证据全在它身上。
 *
 * @param {{ up: (port: number) => boolean, holdCount?: number, onProbe?: (index: number) => void }} options
 */
function makeProbe(options) {
  /** @type {number[]} 每一次 probe 打到的端口，按调用顺序。 */
  const ports = [];
  /** @type {{ port: number, resolve: (answer: boolean) => void }[]} 挂起中的探测。 */
  const held = [];
  let index = 0;
  return {
    ports,
    held,
    /**
     * @param {number} port
     * @returns {Promise<boolean>}
     */
    probeApi(port) {
      ports.push(port);
      const i = index;
      index += 1;
      if (i < (options.holdCount ?? 0)) {
        return new Promise((resolve) => { held.push({ port, resolve }); });
      }
      options.onProbe?.(i);
      return Promise.resolve(options.up(port));
    }
  };
}

/**
 * @param {{
 *   up: (port: number) => boolean,
 *   holdCount?: number,
 *   onProbe?: (index: number) => void,
 *   startTimeoutMs?: number
 * }} options
 */
function makeManager(options) {
  /** @type {number[]} 子进程每次被 spawn 时被要求监听的端口（模拟）。 */
  const spawnedPorts = [];
  /** @type {FakeChild[]} */
  const children = [];
  const logRing = createLogRing({ capacity: 50 });
  const clock = { value: 0 };
  const probe = makeProbe(options);
  const manager = createProxyManager({
    spawnChild: (spec) => {
      spawnedPorts.push(Number(spec.env.ZCC_API_PORT));
      const child = new FakeChild(31000 + children.length);
      children.push(child);
      return child;
    },
    probeApi: probe.probeApi,
    logRing,
    // 可控时钟：超时由测试显式推进，不与墙钟竞速。
    now: () => clock.value,
    pollIntervalMs: 0,
    startTimeoutMs: options.startTimeoutMs ?? 1000,
    shutdownGraceMs: 50
  });
  manager.configure({ port: OLD_PORT, spawnSpec: specFor(OLD_PORT) });
  return { manager, spawnedPorts, children, ports: probe.ports, held: probe.held, clock };
}

describe('ZC-29/F13：预探在途期间保存设置，spawn 与 probe 不得错位', () => {
  it('错位一（新端口已就绪却报超时）：spawn 端口必须与预探端口成对一致', async () => {
    // 模拟世界：只有**新**端口 28062 就绪——用户已经把设置改到那儿了。
    const { manager, spawnedPorts, children, ports, held, clock } = makeManager({
      up: (port) => port === NEW_PORT,
      holdCount: 1,
      // 轮询第一次探测就把时钟推过截止点：确定性超时，不靠墙钟。
      onProbe: () => { clock.value = 10_000; }
    });

    const pending = manager.start();
    await Promise.resolve(); // 预探经 Promise.resolve().then 包装（防同步异常），发起晚一个微任务节拍。
    // 预探在第一个 await 上挂起；此刻 state 仍是 'stopped'（守卫的唯一依据）。
    expect(held.length, 'start 的预探必须已经挂起').toBe(1);
    expect(at(ports, 0), '预探打的是启动瞬间的活动端口').toBe(OLD_PORT);

    // 预探在途时保存设置（`main.cjs` 的 `applySettings()` 就是这么调的）。
    const outcome = manager.configure({ port: NEW_PORT, spawnSpec: specFor(NEW_PORT) });
    at(held, 0).resolve(false); // 预探答「不活」⇒ 放行 spawn
    const result = await pending;

    // 验收三项之一：spawnedPorts —— 子进程必须被 spawn 在本次 start 固定的端口上。
    expect(spawnedPorts, '子进程必须 spawn 在本次 start 成对固定的活动端口上').toEqual([OLD_PORT]);
    // 验收三项之二：probePorts —— 探测端口与 spawn 端口必须是同一个。
    expect(ports, '探测端口必须与 spawn 端口成对一致').toEqual([OLD_PORT, OLD_PORT]);
    // 验收三项之三：终态。
    expect(result).toEqual({ ok: false, code: 'START_TIMEOUT' });
    const snap = manager.getSnapshot();
    expect(snap.state).toBe('failed');
    expect(snap.port).toBe(OLD_PORT);
    expect(snap.configuredPort).toBe(NEW_PORT);
    expect(snap.portChangePending).toBe(true);
    // 自己 spawn 的子进程必须被收束掉（只回收自己持有的句柄）。
    expect(snap.pid).toBeNull();
    expect(at(children, 0).signals).toContain('SIGINT');

    // 预探期间的保存只记待生效配置，不许换掉在途 start 的活动配置。
    expect(outcome).toEqual({ applied: false, reason: 'PROXY_START_IN_FLIGHT' });
  });

  it('错位二（旧端口恰好有残留服务却报成功）：STARTED 的证据必须来自子进程自己的端口', async () => {
    // 模拟世界：28061（旧，残留服务）与 28062（新，本次 spawn）都已就绪。
    const { manager, spawnedPorts, ports, held } = makeManager({
      up: () => true,
      holdCount: 1
    });

    const pending = manager.start();
    await Promise.resolve(); // 预探经 Promise.resolve().then 包装（防同步异常），发起晚一个微任务节拍。
    expect(held.length, 'start 的预探必须已经挂起').toBe(1);
    const outcome = manager.configure({ port: NEW_PORT, spawnSpec: specFor(NEW_PORT) });
    at(held, 0).resolve(false); // 预探答「不活」⇒ 放行 spawn
    const result = await pending;

    expect(result).toEqual({ ok: true, code: 'STARTED' });
    expect(spawnedPorts).toEqual([OLD_PORT]);
    expect(ports).toEqual([OLD_PORT, OLD_PORT]);
    // 报 STARTED 时，探针打的那个端口必须正是子进程被要求监听的端口：
    // 否则「running」是拿**别的**进程的存活当证据，属于误成功。
    expect(at(ports, ports.length - 1), 'running 的证据端口必须等于子进程的监听端口').toBe(
      at(spawnedPorts, 0)
    );
    const snap = manager.getSnapshot();
    expect(snap.state).toBe('running');
    expect(snap.port).toBe(OLD_PORT);
    expect(snap.configuredPort).toBe(NEW_PORT);
    expect(snap.portChangePending).toBe(true);
    expect(outcome).toEqual({ applied: false, reason: 'PROXY_START_IN_FLIGHT' });
  });
});

describe('ZC-29/F13 负例：既有纪律不许被这条修复顺手改掉', () => {
  it('负例(a)：预探之后、轮询在途（starting）时保存仍然拒绝', async () => {
    const { manager, spawnedPorts, ports, held, clock } = makeManager({
      up: () => false,
      holdCount: 2,
      onProbe: () => { clock.value = 10_000; }
    });

    const pending = manager.start();
    await Promise.resolve(); // 预探经 Promise.resolve().then 包装（防同步异常），发起晚一个微任务节拍。
    at(held, 0).resolve(false); // 预探放行 → spawn → starting
    await tick();
    expect(held.length, '轮询探测必须已经挂起').toBe(2);
    expect(manager.getState()).toBe('starting');
    expect(spawnedPorts).toEqual([OLD_PORT]);
    expect(at(ports, 1), '轮询仍打同一对端口').toBe(OLD_PORT);

    const outcome = manager.configure({ port: NEW_PORT, spawnSpec: specFor(NEW_PORT) });
    // 既有语义一个字不改：starting 与 running 同一条拒绝理由。
    expect(outcome).toEqual({ applied: false, reason: 'PROXY_RUNNING' });
    const snap = manager.getSnapshot();
    expect(snap.port).toBe(OLD_PORT);
    expect(snap.configuredPort).toBe(NEW_PORT);
    expect(snap.portChangePending).toBe(true);

    at(held, 1).resolve(false);
    const result = await pending;
    expect(result).toEqual({ ok: false, code: 'START_TIMEOUT' });
    expect(spawnedPorts, 'starting 期间保存不得换掉活动配置').toEqual([OLD_PORT]);
  });

  it('负例(b)：预探在途时重复 start 仍然 BUSY，且全程只 spawn 一次', async () => {
    const { manager, spawnedPorts, held } = makeManager({ up: () => true, holdCount: 1 });

    const pending = manager.start();
    await Promise.resolve(); // 预探经 Promise.resolve().then 包装（防同步异常），发起晚一个微任务节拍。
    expect(held.length, 'start 的预探必须已经挂起').toBe(1);
    const second = await manager.start();
    expect(second).toEqual({ ok: false, code: 'BUSY' });
    expect(spawnedPorts, '被拒的第二次 start 不得 spawn').toEqual([]);

    at(held, 0).resolve(false);
    const result = await pending;
    expect(result).toEqual({ ok: true, code: 'STARTED' });
    expect(spawnedPorts, '全程只许 spawn 一个子进程').toHaveLength(1);
  });

  it('负例(c)：停机状态下的保存照常立刻生效', async () => {
    const { manager, spawnedPorts, children, held } = makeManager({ up: () => true, holdCount: 1 });

    const pending = manager.start();
    await Promise.resolve(); // 预探经 Promise.resolve().then 包装（防同步异常），发起晚一个微任务节拍。
    at(held, 0).resolve(false);
    expect(await pending).toEqual({ ok: true, code: 'STARTED' });
    // 只收束自己 spawn 的那个句柄。
    expect(await manager.stop()).toEqual({ ok: true, code: 'STOPPED' });
    expect(at(children, 0).signals).toContain('SIGINT');
    expect(manager.getState()).toBe('stopped');

    const outcome = manager.configure({ port: NEW_PORT, spawnSpec: specFor(NEW_PORT) });
    expect(outcome).toEqual({ applied: true });
    const snap = manager.getSnapshot();
    expect(snap.state).toBe('stopped');
    expect(snap.port).toBe(NEW_PORT);
    expect(snap.configuredPort).toBe(NEW_PORT);
    expect(snap.portChangePending).toBe(false);
    expect(spawnedPorts, '保存本身绝不 spawn 任何子进程').toEqual([OLD_PORT]);
  });
});
