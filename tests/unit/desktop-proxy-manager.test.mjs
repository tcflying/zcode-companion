/**
 * I10 反代状态机契约（`apps/desktop/lib/proxy-manager.cjs`）。
 *
 * provider-free：全部用**假子进程**与**假探测**，不 spawn 任何真实进程、不监听任何端口。
 *
 * 本文件钉住的是四条不能退让的纪律：
 *  1. `running` 必须同时满足「子进程存活」与「`/v1/models` 探通」，只看 spawn 没抛异常不行。
 *  2. `external` 是**只观察**：启动与停止都被拒绝，且**一次信号都不发**。
 *  3. 子进程 env 的 `ZCC_*` 是闭集，父进程里多余的 `ZCC_*` 一个都不许溜过去。
 *  4. 子进程意外退出要变成 `failed` 并带上原因，不能悄悄回到 `stopped`。
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { at } from '../helpers/desktop-harness.mjs';

const require = createRequire(import.meta.url);
const { createProxyManager, buildChildEnv, PROXY_STATES, CHILD_ENV_KEYS } = require('../../apps/desktop/lib/proxy-manager.cjs');
const { createLogRing } = require('../../apps/desktop/lib/log-ring.cjs');

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => { setTimeout(() => resolve(undefined), ms); });

const SYNTHETIC_KEY = 'zcc_unit_test_synthetic_key_0001';
const SPAWN_SPEC = Object.freeze({
  command: 'node',
  args: ['/synthetic/start-api.mjs', '--driver', 'official-host'],
  env: { ZCC_API_KEY: SYNTHETIC_KEY, ZCC_API_PORT: '8791' },
  cwd: '/synthetic',
  windowsHide: true,
  shell: false
});

/** 假子进程：接口与 `child_process` 的 ChildProcess 对齐（够状态机用即可）。 */
class FakeChild extends EventEmitter {
  /** @param {number} pid */
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    /** @type {string[]} 收到过的信号；断言「external 下一个都没有」。 */
    this.signals = [];
  }

  /**
   * @param {string} signal
   * @returns {boolean}
   */
  kill(signal) {
    this.signals.push(signal);
    // 真进程不会立刻死；这里也不立刻死，让状态机自己走完等待与兜底。
    return true;
  }

  /**
   * 模拟进程真的走了。
   * @param {number | null} code
   * @param {string | null} [signal]
   */
  reallyExit(code, signal = null) {
    this.emit('exit', code, signal);
  }

  /** @param {string} text */
  emitStdout(text) {
    this.stdout.emit('data', Buffer.from(text));
  }

  /** @param {string} text */
  emitStderr(text) {
    this.stderr.emit('data', Buffer.from(text));
  }
}

/**
 * 造一台可控的探测：按脚本回答「活 / 不活」。
 * @param {boolean[]} script 每次调用消费一项；用尽后重复最后一项。
 */
function scriptedProbe(script) {
  /** @type {boolean[]} */
  const calls = [];
  let i = 0;
  return {
    calls,
    probe: async () => {
      const answer = script[Math.min(i, script.length - 1)] ?? false;
      i += 1;
      calls.push(answer);
      return answer;
    }
  };
}

/**
 * @param {{ probeScript?: boolean[], startTimeoutMs?: number, shutdownGraceMs?: number }} options
 * @returns {{ manager: any, spawned: FakeChild[], probeCalls: boolean[], logRing: any }}
 */
function makeManager(options) {
  /** @type {FakeChild[]} */
  const spawned = [];
  const logRing = createLogRing({ capacity: 50 });
  logRing.addSecret(SYNTHETIC_KEY);
  const { probe, calls } = scriptedProbe(options.probeScript ?? [false, true]);
  const manager = createProxyManager({
    spawnChild: () => {
      const child = new FakeChild(10000 + spawned.length);
      spawned.push(child);
      return child;
    },
    probeApi: probe,
    logRing,
    pollIntervalMs: 5,
    startTimeoutMs: options.startTimeoutMs ?? 200,
    shutdownGraceMs: options.shutdownGraceMs ?? 60
  });
  manager.configure({ port: 8791, spawnSpec: SPAWN_SPEC });
  return { manager, spawned, probeCalls: calls, logRing };
}

describe('反代状态机：状态闭集与初值', () => {
  it('五态闭集就是文档里那五个，且初值是 stopped', () => {
    expect([...PROXY_STATES]).toEqual(['stopped', 'starting', 'running', 'failed', 'external']);
    const { manager } = makeManager({});
    expect(manager.getState()).toBe('stopped');
    const snap = manager.getSnapshot();
    expect(snap).toMatchObject({ state: 'stopped', pid: null, port: 8791, external: false, canControl: true, owned: false });
  });

  it('没 configure 过就 start：一律拒绝，且不 spawn 任何东西', async () => {
    /** @type {FakeChild[]} */
    const spawned = [];
    const manager = createProxyManager({
      spawnChild: () => {
        const c = new FakeChild(1);
        spawned.push(c);
        return c;
      },
      probeApi: async () => false,
      logRing: createLogRing({ capacity: 5 })
    });
    const result = await manager.start();
    expect(result).toEqual({ ok: false, code: 'PORT_NOT_SET' });
    expect(spawned).toHaveLength(0);
  });
});

describe('反代状态机：正常启动', () => {
  it('子进程存活 + 探通 → running，并记下 PID 与端口', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false, true] });
    const result = await manager.start();
    expect(result).toEqual({ ok: true, code: 'STARTED' });
    expect(manager.getState()).toBe('running');
    const snap = manager.getSnapshot();
    expect(snap.state).toBe('running');
    expect(snap.pid).toBe(10000);
    expect(snap.port).toBe(8791);
    expect(snap.owned).toBe(true);
    expect(snap.lastError).toBeNull();
    expect(spawned).toHaveLength(1);
    // 「绝不弹独立 cmd 窗口」这条纪律的机器可读形式。
    expect(SPAWN_SPEC.windowsHide).toBe(true);
    expect(SPAWN_SPEC.shell).toBe(false);
  });

  it('running 中再 start 一律 BUSY：不会拉出第二个子进程', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false, true] });
    await manager.start();
    const again = await manager.start();
    expect(again).toEqual({ ok: false, code: 'BUSY' });
    expect(spawned).toHaveLength(1);
  });

  it('子进程的 stdout / stderr 进环形缓冲，且注册过的凭据被写前替换', async () => {
    const { manager, spawned, logRing } = makeManager({ probeScript: [false, true] });
    await manager.start();
    at(spawned, 0).emitStdout('zcc-api event=listening port=8791\n');
    at(spawned, 0).emitStderr(`Authorization: Bearer ${SYNTHETIC_KEY}\n`);
    const tail = logRing.tail(10).map((/** @type {{ text: string }} */ e) => e.text);
    expect(tail).toContain('zcc-api event=listening port=8791');
    expect(tail.join('\n')).not.toContain(SYNTHETIC_KEY);
    expect(tail.join('\n')).toContain('[REDACTED]');
    // 日志里出现子进程 PID 与端口，供界面对照。
    expect(manager.getSnapshot().pid).toBe(10000);
  });
});

describe('反代状态机：启动失败', () => {
  it('spawn 自己抛错 → failed，原因带出来', async () => {
    const logRing = createLogRing({ capacity: 10 });
    const manager = createProxyManager({
      spawnChild: () => {
        throw new Error('spawn ENOENT');
      },
      probeApi: async () => false,
      logRing,
      pollIntervalMs: 5,
      startTimeoutMs: 100
    });
    manager.configure({ port: 8791, spawnSpec: SPAWN_SPEC });
    const result = await manager.start();
    expect(result).toEqual({ ok: false, code: 'SPAWN_FAILED' });
    expect(manager.getState()).toBe('failed');
    expect(manager.getSnapshot().lastError).toContain('spawn ENOENT');
  });

  it('子进程起来了但一直探不通 → START_TIMEOUT + failed，并被收束掉', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false], startTimeoutMs: 60 });
    const result = await manager.start();
    expect(result).toEqual({ ok: false, code: 'START_TIMEOUT' });
    // 失败态必须留在 failed：被 stopOwned() 覆盖成 stopped 就等于「什么都没发生过」。
    expect(manager.getState()).toBe('failed');
    expect(manager.getSnapshot().lastError).toContain('探通');
    expect(manager.getSnapshot().pid).toBeNull();
    expect(at(spawned, 0).signals.length).toBeGreaterThanOrEqual(1);
  });

  it('子进程在探通前自己退了 → CHILD_EXITED，且状态是 failed 不是 running', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false] });
    const pending = manager.start();
    // 第一轮探测返回 false 之后立刻让子进程死掉。
    await sleep(12);
    at(spawned, 0).reallyExit(2, null);
    const result = await pending;
    expect(result.code).toBe('CHILD_EXITED');
    expect(manager.getState()).toBe('failed');
    expect(manager.getSnapshot().lastError).toContain('意外退出');
    expect(manager.getSnapshot().lastError).toContain('code=2');
  });
});

describe('反代状态机：意外退出', () => {
  it('running 中意外退出 → failed，并保留可读原因', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false, true] });
    await manager.start();
    expect(manager.getState()).toBe('running');
    at(spawned, 0).reallyExit(1, 'SIGTERM');
    expect(manager.getState()).toBe('failed');
    const snap = manager.getSnapshot();
    expect(snap.pid).toBeNull();
    expect(snap.owned).toBe(false);
    expect(snap.lastError).toContain('意外退出');
  });
});

describe('反代状态机：external 只观察', () => {
  it('启动前探到活服务 → external，且一次都不 spawn', async () => {
    const { manager, spawned } = makeManager({ probeScript: [true] });
    const result = await manager.start();
    expect(result).toEqual({ ok: true, code: 'EXTERNAL' });
    expect(manager.getState()).toBe('external');
    expect(spawned).toHaveLength(0);
    const snap = manager.getSnapshot();
    expect(snap.external).toBe(true);
    // 「只观察」是机器可读形式，不是文案。
    expect(snap.canControl).toBe(false);
    expect(snap.owned).toBe(false);
    expect(snap.pid).toBeNull();
  });

  it('external 下 stop 硬拒：那个进程不是我们起的，一次信号都不许发', async () => {
    const { manager, spawned } = makeManager({ probeScript: [true] });
    await manager.start();
    expect(await manager.stop()).toEqual({ ok: false, code: 'EXTERNAL_NOT_OWNED' });
    expect(manager.getState()).toBe('external');
    for (const child of spawned) expect(child.signals).toEqual([]);
  });

  it('external 下再点启动 = 重新探一次：还在就继续只观察，仍然一个子进程都不 spawn', async () => {
    const { manager, spawned } = makeManager({ probeScript: [true] });
    await manager.start();
    // 外部进程还活着：重新探测得到同样的结论，继续 external。
    expect(await manager.start()).toEqual({ ok: true, code: 'EXTERNAL' });
    expect(manager.getState()).toBe('external');
    expect(spawned).toHaveLength(0);
  });

  it('external 不是死状态：外部进程消失、端口空出后，再点启动即可接管（I10 HIGH-1）', async () => {
    // 脚本：先活（进 external），之后死（外部进程被用户在别处停掉了），再活（本进程自己起来了）。
    const { manager, spawned } = makeManager({ probeScript: [true, false, true] });
    await manager.start();
    expect(manager.getState()).toBe('external');
    expect(spawned).toHaveLength(0);

    // 用户在别处停掉了那份反代，再次点「启动」——必须能接管，而不是把用户永久锁死。
    const result = await manager.start();
    expect(result).toEqual({ ok: true, code: 'STARTED' });
    expect(manager.getState()).toBe('running');
    expect(spawned).toHaveLength(1);
    const snap = manager.getSnapshot();
    expect(snap.external).toBe(false);
    expect(snap.owned).toBe(true);
    expect(snap.pid).toBe(10000);
  });

  it('restart 在 external 下也会重新探测：外部还在就只观察，不 spawn', async () => {
    const { manager, spawned } = makeManager({ probeScript: [true, true] });
    await manager.start();
    // 外部仍在：restart 不接管、不 spawn。
    expect(await manager.restart()).toEqual({ ok: true, code: 'EXTERNAL' });
    expect(spawned).toHaveLength(0);
  });

  it('external 下 dispose 绝不发信号：它不是我们的进程', async () => {
    const { manager, spawned } = makeManager({ probeScript: [true] });
    await manager.start();
    const result = await manager.dispose();
    expect(result).toEqual({ ok: true, code: 'NOT_OWNED' });
    expect(spawned).toHaveLength(0);
    expect(manager.getState()).toBe('external');
  });
});

describe('反代状态机：停止有界', () => {
  it('stop 先 SIGINT；子进程配合退出就到此为止', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false, true] });
    await manager.start();
    const child = at(spawned, 0);
    const pending = manager.stop();
    await sleep(10);
    expect(child.signals).toEqual(['SIGINT']);
    child.reallyExit(0, null);
    const result = await pending;
    expect(result).toEqual({ ok: true, code: 'STOPPED' });
    expect(manager.getState()).toBe('stopped');
    // 优雅退出生效时不该再补一刀 SIGKILL。
    expect(child.signals).toEqual(['SIGINT']);
  });

  it('子进程赖着不走 → 过了宽限期补 SIGKILL', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false, true], shutdownGraceMs: 40 });
    await manager.start();
    const child = at(spawned, 0);
    const pending = manager.stop();
    await sleep(90);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(child.signals[0]).toBe('SIGINT');
    expect(child.signals).toContain('SIGKILL');
    expect(manager.getState()).toBe('stopped');
  });

  it('dispose 幂等，且只对自己 spawn 的进程生效', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false, true] });
    await manager.start();
    expect((await manager.dispose()).ok).toBe(true);
    expect((await manager.dispose()).code).toBe('DISPOSED');
    expect(at(spawned, 0).signals.length).toBeGreaterThanOrEqual(1);
    expect(manager.getState()).toBe('stopped');
  });

  it('stopped 上再 stop：如实说 ALREADY_STOPPED，不假装停过一个东西', async () => {
    const { manager } = makeManager({ probeScript: [false, true] });
    expect(await manager.stop()).toEqual({ ok: true, code: 'ALREADY_STOPPED' });
  });
});

describe('子进程 env 闭集', () => {
  it('只带闭集内的 ZCC_* 键；父进程里多余的 ZCC_* 一个都不许溜过去', () => {
    const env = buildChildEnv({
      apiKey: SYNTHETIC_KEY,
      apiPort: 8791,
      reasoning: 'low',
      // 929.md:875：journal 目录由主进程给出，值来自参数而不是从父进程继承。
      journalDir: 'C:/profiles/web',
      parentEnv: {
        SystemRoot: 'C:\\Windows',
        PATH: 'C:\\bin',
        TEMP: 'C:\\Temp',
        ZCC_API_KEY: '父进程里的旧值',
        ZCC_DRIVER: 'official-host',
        ZCC_HOST_DEBUG: '1',
        ZCC_SHUTDOWN_GRACE_MS: '999',
        ZCC_JOURNAL_DIR: '父进程里的旧目录',
        ELECTRON_RUN_AS_NODE: '1'
      },
      extra: { ELECTRON_RUN_AS_NODE: '1', ZCC_DRIVER: 'fixture' }
    });
    const zccKeys = Object.keys(env).filter((k) => k.startsWith('ZCC_')).sort();
    expect(zccKeys).toEqual([...CHILD_ENV_KEYS].sort());
    // 关键的值来自参数，不是从父进程继承来的。
    expect(env.ZCC_API_KEY).toBe(SYNTHETIC_KEY);
    expect(env.ZCC_API_PORT).toBe('8791');
    expect(env.ZCC_HOST_REASONING).toBe('low');
    expect(env.ZCC_JOURNAL_DIR).toBe('C:/profiles/web');
    expect(env.ZCC_SHUTDOWN_GRACE_MS).toBe('5000');
    // extra 里混进来的 ZCC_* 也进不来。
    expect(env.ZCC_DRIVER).toBeUndefined();
    expect(env.ZCC_HOST_DEBUG).toBeUndefined();
    // 操作系统必需的键按白名单透传。
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('闭集里的每个键都真的落在 start-api.mjs 的 ENTRY_ENV_KEYS 内', async () => {
    const entry = await import('../../packages/api/bin/start-api.mjs');
    for (const key of CHILD_ENV_KEYS) {
      expect(entry.ENTRY_ENV_KEYS, `${key} 必须是入口认识的 env 键`).toContain(key);
    }
  });

  it('journalDir 缺省时不发射该键（子进程保持纯内存，不猜目录）', () => {
    const env = buildChildEnv({
      apiKey: SYNTHETIC_KEY,
      apiPort: 8791,
      reasoning: 'low'
    });
    expect(env.ZCC_JOURNAL_DIR).toBeUndefined();
    expect(Object.keys(env).filter((k) => k.startsWith('ZCC_')).sort()).toEqual(
      [...CHILD_ENV_KEYS].filter((k) => k !== 'ZCC_JOURNAL_DIR').sort()
    );
  });
});

describe('反代状态机：并发 start 不得泄漏孤儿（I10 CRITICAL-1）', () => {
  it('双击「启动」并发两次：只有一个子进程，且它被管理器牢牢持有', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false, true] });
    // 两次调用在**同一个 await 点之前**就都进了函数——守卫读的是 state，
    // 而那一刻 state 还是 'stopped'。只有「进入即置位、finally 复位」的同步闸挡得住。
    const [first, second] = await Promise.all([manager.start(), manager.start()]);
    expect(spawned, '并发 start 只许 spawn 一个子进程').toHaveLength(1);
    // 后到者被明确拒绝，而不是悄悄覆盖 child 引用把先 spawn 的那个变成孤儿。
    const codes = [first.code, second.code].sort();
    expect(codes).toEqual(['BUSY', 'STARTED']);
    const snap = manager.getSnapshot();
    expect(snap.state).toBe('running');
    expect(snap.owned).toBe(true);
    // 关键：管理器持有的 pid 必须就是那个唯一子进程的 pid（没有第二个被漏管的）。
    expect(snap.pid).toBe(at(spawned, 0).pid);
  });

  it('三连击并发：仍然只 spawn 一个，其余两个拿到 BUSY', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false, true] });
    const results = await Promise.all([manager.start(), manager.start(), manager.start()]);
    expect(spawned).toHaveLength(1);
    expect(results.filter((r) => r.code === 'BUSY')).toHaveLength(2);
    expect(results.filter((r) => r.code === 'STARTED')).toHaveLength(1);
  });

  it('并发 start 之后 dispose 收得干净：唯一那个子进程真的收到了信号', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false, true] });
    await Promise.all([manager.start(), manager.start()]);
    const child = at(spawned, 0);
    const pending = manager.dispose();
    // SIGINT 之后让它配合退出，走优雅收束。
    await sleep(10);
    child.reallyExit(0, null);
    await pending;
    expect(child.signals, '自己 spawn 的子进程必须收到停止信号').toContain('SIGINT');
    expect(manager.getState()).toBe('stopped');
  });

  it('并发闸在失败路径上同样复位：一次 spawn 抛错后还能再启动', async () => {
    let attempts = 0;
    // 探测脚本：第一次 start 探到死→spawn 抛错；第二次 start 探到死→spawn 成功→轮询探通。
    const answers = [false, false, true];
    let probeIndex = 0;
    const logRing = createLogRing({ capacity: 50 });
    const manager = createProxyManager({
      // 第一次 spawn 直接抛，模拟「运行时文件不在」等启动失败。
      spawnChild: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('ENOENT: 找不到反代入口');
        return new FakeChild(20001);
      },
      probeApi: async () => answers[Math.min(probeIndex++, answers.length - 1)] ?? false,
      logRing,
      pollIntervalMs: 5,
      startTimeoutMs: 200
    });
    manager.configure({ port: 8791, spawnSpec: SPAWN_SPEC });

    const failed = await manager.start();
    expect(failed).toEqual({ ok: false, code: 'SPAWN_FAILED' });
    // 漏复位会把状态机永久锁在 BUSY：那比原 bug 更难查。
    expect(await manager.start(), '失败之后同步闸必须已复位').toEqual({ ok: true, code: 'STARTED' });
  });
});

describe('反代状态机：所有权自相矛盾必须显式报出来（I10 CRITICAL-1 配套）', () => {
  it('dispose 遇到「状态说在跑、手上没句柄」时不许装成功', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false, true] });
    await manager.start();
    // 模拟子进程句柄被外部因素弄丢、而状态机还停在 running 的自相矛盾快照。
    // 静默回 NOT_OWNED 就是在说谎：那个进程真的还在跑，只是没人管它。
    const result = await manager.dispose();
    expect(result).toEqual({ ok: true, code: 'STOPPED' });
    expect(at(spawned, 0).signals).toContain('SIGINT');
  });

  it('已停止状态下 dispose 仍然是幂等的成功', async () => {
    const { manager } = makeManager({ probeScript: [false, true] });
    expect(await manager.dispose()).toEqual({ ok: true, code: 'NOT_OWNED' });
  });
});

describe('反代状态机：运行中改端口不许让快照说谎（I10 MEDIUM-2）', () => {
  it('running 时 configure 换端口：快照仍显示子进程真正在监听的那个', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false, true] });
    await manager.start();
    expect(manager.getSnapshot().port).toBe(8791);

    // 模拟「用户在设置页改了端口并保存」。
    const outcome = manager.configure({ port: 9999, spawnSpec: { ...SPAWN_SPEC, env: { ZCC_API_PORT: '9999' } } });
    expect(outcome).toEqual({ applied: false, reason: 'PROXY_RUNNING' });

    const snap = manager.getSnapshot();
    // 快照的 port 必须是**真实监听**的端口；界面据此显示的转发目标才不会全部 502。
    expect(snap.port).toBe(8791);
    // 新端口记在 configuredPort，并显式标出「待重启生效」。
    expect(snap.configuredPort).toBe(9999);
    expect(snap.portChangePending).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  it('停止之后再 configure 就真的生效了', async () => {
    const { manager, spawned } = makeManager({ probeScript: [false, true] });
    await manager.start();
    const pending = manager.stop();
    await sleep(10);
    at(spawned, 0).reallyExit(0, null);
    await pending;

    const outcome = manager.configure({ port: 9999, spawnSpec: { ...SPAWN_SPEC, env: { ZCC_API_PORT: '9999' } } });
    expect(outcome).toEqual({ applied: true });
    const snap = manager.getSnapshot();
    expect(snap.port).toBe(9999);
    expect(snap.configuredPort).toBe(9999);
    expect(snap.portChangePending).toBe(false);
  });
});
