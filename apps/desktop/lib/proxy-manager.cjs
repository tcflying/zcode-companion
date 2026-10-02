/**
 * 反代生命周期管理器：`stopped / starting / running / failed / external` 五态。
 *
 * 这是本工单最硬的一块纪律，逐条写死：
 *
 *  1. **只管自己 spawn 的进程。** `external` 态表示「启动前探测到该端口已有服务」，
 *     此时**只观察**：启动/停止一律拒绝并返回 `EXTERNAL_NOT_OWNED`，绝不向一个不是
 *     自己拉起来的进程发信号。`stop()` 在 `external` 下的行为是**不改状态、不发信号**，
 *     而不是「假装停了」。
 *  2. **`running` 不是一个乐观的假设。** 它要求「子进程仍存活」**且**「`GET /v1/models`
 *     探通」两条同时成立；只看「spawn 没抛异常」就报 running，等于把「监听失败」
 *     伪装成「服务可用」。
 *  3. **子进程 env 是闭集。** 只有下表 `CHILD_ENV_KEYS` 里的 `ZCC_*` 键会被带过去；
 *     其余 `ZCC_*` 一律不带（`start-api.mjs` 对未知 `ZCC_*` 是 422 拒启动，带过去等于
 *     让子进程起不来）。另有一小组**操作系统必需**的键按白名单透传，见 `OS_ENV_PASSTHROUGH`。
 *  4. **key 走 env，不走命令行。** 命令行参数对本机所有进程可见，`--api-key` 等于
 *     把 key 贴在了进程列表上。
 *  5. **停止是有界的。** 先 `SIGINT` 走 API 侧的在途收束（`ZCC_SHUTDOWN_GRACE_MS`），
 *     到点仍不死才 `SIGKILL`。不接受「不管有没有人还在途就掐掉」。
 *
 * 所有 IO 能力（spawn / 探测 / 时钟）都从构造参数注入，因此整台状态机可以在没有
 * Electron、没有网络的条件下被单测逐条钉死。
 */

'use strict';

/** 五态闭集。界面上出现表外的值一律是 bug，不是「未知情况」。 */
const PROXY_STATES = Object.freeze(['stopped', 'starting', 'running', 'failed', 'external']);

/**
 * @typedef {(typeof PROXY_STATES)[number]} ProxyState
 */

/** 允许进入子进程的 `ZCC_*` 键闭集（全部落在 `start-api.mjs` 的 `ENTRY_ENV_KEYS` 内）。 */
const CHILD_ENV_KEYS = Object.freeze([
  'ZCC_API_KEY',
  'ZCC_API_PORT',
  'ZCC_SHUTDOWN_GRACE_MS',
  'ZCC_HOST_REASONING'
]);

/**
 * 允许从父进程透传给子进程的**非 `ZCC_`** 键。
 *
 * 这不是「把整个 env 传过去」：整个 env 会把父进程里的任何 `ZCC_*` 键一并带过去，
 * 正好违反第 3 条纪律。这里的每一项都有 Windows 上的具体理由：Node 在 Windows 上
 * 靠 `SystemRoot` 定位 Winsock/证书库，靠 `TEMP`/`TMP` 建隔离工作区，靠 `PATH` 找
 * `cmd`/系统工具。少任何一项的表现是「子进程莫名起不来」，而不是「少一个可选功能」。
 */
const OS_ENV_PASSTHROUGH = Object.freeze([
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'TEMP',
  'TMP',
  'PATH',
  'PATHEXT',
  'WINDIR'
]);

const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_START_TIMEOUT_MS = 20_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

/**
 * 构造子进程 env。
 * @param {object} options
 * @param {string} options.apiKey
 * @param {number} options.apiPort
 * @param {string} options.reasoning
 * @param {number} [options.shutdownGraceMs]
 * @param {Record<string, string | undefined>} [options.parentEnv]
 * @param {Record<string, string>} [options.extra] 额外的非 ZCC 键（如 `ELECTRON_RUN_AS_NODE`）。
 * @returns {Record<string, string>}
 */
function buildChildEnv(options) {
  /** @type {Record<string, string>} */
  const env = {};
  const source = options.parentEnv ?? {};
  for (const key of OS_ENV_PASSTHROUGH) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    // 额外键同样受闭集约束：ZCC_* 一律不许从这里溜进来。
    if (key.startsWith('ZCC_') || typeof value !== 'string' || value === '') continue;
    env[key] = value;
  }
  // 闭集逐个显式写出，而不是「过滤出所有 ZCC_」——新增设置时必须在这里显式表态。
  env['ZCC_API_KEY'] = options.apiKey;
  env['ZCC_API_PORT'] = String(options.apiPort);
  env['ZCC_SHUTDOWN_GRACE_MS'] = String(options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
  env['ZCC_HOST_REASONING'] = options.reasoning;
  return env;
}

/**
 * @param {string} state
 * @param {string} [reason]
 * @returns {void}
 */
function assertState(state, reason) {
  if (!PROXY_STATES.includes(state)) {
    throw new Error(`UNKNOWN_PROXY_STATE: ${String(state)}${reason === undefined ? '' : ` (${reason})`}`);
  }
}

/**
 * @typedef {object} SpawnSpec
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string>} env
 * @property {string} cwd
 * @property {boolean} windowsHide
 * @property {boolean} shell
 */

/** 环形日志缓冲的最小契约（真实实现见 `log-ring.cjs`）。 */
/**
 * @typedef {object} LogRingLike
 * @property {(stream: 'stdout'|'stderr'|'main', text: string, at: number) => void} append
 * @property {(at: number) => void} flush
 */

/**
 * @typedef {object} FakeChild
 * @property {number} pid
 * @property {Record<string, any>} stdout
 * @property {Record<string, any>} stderr
 * @property {(event: string, cb: (...a: any[]) => void) => void} on
 * @property {(signal: string) => void} kill
 */

/**
 * 创建管理器。
 *
 * @param {object} deps
 * @param {(spec: SpawnSpec) => FakeChild} deps.spawnChild
 * @param {(port: number) => Promise<boolean>} deps.probeApi 探测 `/v1/models`；401/200 都算活。
 * @param {LogRingLike} deps.logRing
 * @param {() => number} [deps.now]
 * @param {number} [deps.pollIntervalMs]
 * @param {number} [deps.startTimeoutMs]
 * @param {number} [deps.shutdownGraceMs]
 * @param {() => void} [deps.onChange] 状态变化回调（用于推给渲染进程）。
 */
function createProxyManager(deps) {
  const now = deps.now ?? (() => Date.now());
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startTimeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const shutdownGraceMs = deps.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  /** @type {ProxyState} */
  let state = 'stopped';
  /** @type {FakeChild | null} 只有自己 spawn 出来的那个才非 null。 */
  let child = null;
  /** @type {number | null} */
  let pid = null;
  /** @type {number | null} */
  let port = null;
  /**
   * 设置里配置的那个端口。与 `port`（**子进程真正在监听的那个**）分开记，
   * 两者不一致就说明「有改动待重启生效」。把它们合成一个字段，界面就会在
   * 运行中显示一个没人监听的端口。
   * @type {number | null}
   */
  let configuredPort = null;
  /** @type {SpawnSpec | null} */
  let spawnSpec = null;
  let external = false;
  /** @type {string | null} */
  let lastError = null;
  let lastChangedAt = now();
  /** @type {(() => void) | null} */
  let stopWaiter = null;
  let intentionalStop = false;
  let disposed = false;
  /**
   * `start()` 的**同步**在途闸。
   *
   * 为什么必须是同步的：`start()` 里有 `await probeApi(...)`，而 `state` 要到探测
   * 之后才被置成 `starting`。两次并发调用会在**同一个 await 点之前**双双穿过
   * 「state 不是 running/starting」这道守卫，然后各自 spawn 一个子进程——后者覆盖
   * `child` 引用，先 spawn 的那个从此没人管：没人发信号、没人记 pid，而 `dispose()`
   * 因为 `child === null` 还会回一个 `NOT_OWNED` 的假成功，退出时收不走它。
   * 守卫是跨 await 的，光靠读 `state` 挡不住并发；只有「进入函数即置位、finally 复位」
   * 的同步闸才挡得住。
   */
  let startInFlight = false;

  function notify() {
    lastChangedAt = now();
    deps.onChange?.();
  }

  /**
   * @param {ProxyState} next
   * @param {string | null} [error]
   */
  function setState(next, error) {
    assertState(next);
    state = next;
    lastError = error === undefined ? lastError : error;
    notify();
  }

  /**
   * @returns {{
   *   state: ProxyState, pid: number | null, port: number | null, configuredPort: number | null,
   *   external: boolean, lastError: string | null, lastChangedAt: number,
   *   canControl: boolean, owned: boolean, portChangePending: boolean
   * }}
   */
  function getSnapshot() {
    return {
      state,
      pid,
      // `port` 恒是子进程真正在监听的那个；`configuredPort` 是设置里的那个。
      port,
      configuredPort,
      external,
      lastError,
      lastChangedAt,
      // 能否由本进程控制：external 恒为 false，这是「只观察」这条纪律的机器可读形式。
      canControl: state !== 'external',
      owned: child !== null,
      // 两者不等 = 有端口改动要重启才生效，界面据此提示，而不是假装已经换掉了。
      portChangePending: port !== null && configuredPort !== null && port !== configuredPort
    };
  }

  /** 子进程可被挂接的两条输出流。`main` 是主进程自己的，不挂子进程。 */
  const CHILD_STREAMS = /** @type {const} */ (['stdout', 'stderr']);

  /** @param {FakeChild} target */
  function attachStreams(target) {
    for (const stream of CHILD_STREAMS) {
      const source = /** @type {any} */ (target)[stream];
      if (!source || typeof source.on !== 'function') continue;
      const handler = (/** @type {unknown} */ chunk) => {
        deps.logRing.append(stream, typeof chunk === 'string' ? chunk : String(chunk), now());
      };
      source.__zccHandler = handler;
      source.on('data', handler);
    }
  }

  /** @param {FakeChild} target */
  function detachStreams(target) {
    for (const stream of CHILD_STREAMS) {
      const source = /** @type {any} */ (target)[stream];
      if (source && typeof source.removeListener === 'function' && source.__zccHandler) {
        source.removeListener('data', source.__zccHandler);
      }
    }
  }

  /**
   * @param {FakeChild} target
   * @param {number | null} code
   * @param {string | null} [signal]
   */
  function onExit(target, code, signal) {
    if (target !== child) return; // 已被替换的旧子进程的退出事件，忽略。
    detachStreams(target);
    deps.logRing.flush(now());
    if (intentionalStop) {
      child = null;
      pid = null;
      setState('stopped', null);
      stopWaiter?.();
      stopWaiter = null;
      return;
    }
    child = null;
    const deadPid = pid;
    pid = null;
    setState(
      'failed',
      `反代子进程意外退出（pid=${String(deadPid)}，code=${code === null ? 'null' : String(code)}，signal=${signal ?? 'none'}）。` +
        '详情见「日志」页的子进程输出。'
    );
  }

  /**
   * 启动前先探端口。**探测活 ⇒ external**：这不是错误，是一个必须如实显示给用户的
   * 事实（本机已经有人在跑同一份 API），处理方式只能是「只观察」。
   *
   * `external` 态**不锁死**：文档承诺过「停掉那份再接管」，所以这里每次 `start()`
   * 都重新探一次——外部进程还在就继续只观察，端口空出来了就按正常路径接管。
   * 「只观察」约束的是**发信号**，不是「永远不许接管一个空端口」。
   */
  async function start() {
    if (disposed) return { ok: false, code: 'DISPOSED' };
    // 同步闸先于一切 await：见 `startInFlight` 的说明。
    if (startInFlight || state === 'running' || state === 'starting') return { ok: false, code: 'BUSY' };
    if (port === null) return { ok: false, code: 'PORT_NOT_SET' };
    if (spawnSpec === null) return { ok: false, code: 'SPAWN_SPEC_NOT_SET' };

    startInFlight = true;
    try {
      const targetPort = port;
      const alive = await deps.probeApi(targetPort).catch(() => false);
      if (alive) {
        child = null;
        pid = null;
        external = true;
        setState('external', null);
        return { ok: true, code: 'EXTERNAL' };
      }

      // 探测不活 ⇒ 端口是空的。external 到此**解除**：之前那个「别人的进程」已经不在，
      // 继续挂着 external 只会把界面永久锁在「我什么都没法做」的死状态里。
      external = false;
      lastError = null;
      intentionalStop = false;
      setState('starting', null);

      /** @type {FakeChild} */
      let spawned;
      try {
        spawned = deps.spawnChild(spawnSpec);
      } catch (err) {
        setState('failed', `反代子进程拉起失败：${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, code: 'SPAWN_FAILED' };
      }
      child = spawned;
      pid = typeof spawned.pid === 'number' ? spawned.pid : null;
      attachStreams(spawned);
      spawned.on('exit', (/** @type {number|null} */ code, /** @type {string|null} */ signal) =>
        onExit(spawned, code, signal)
      );

      const deadline = now() + startTimeoutMs;
      // 轮询到「探通」/「子进程先死」/「超时」三者之一为止。
      for (;;) {
        if (child !== spawned) return { ok: false, code: 'CHILD_EXITED' };
        const reachable = await deps.probeApi(targetPort).catch(() => false);
        if (reachable) {
          setState('running', null);
          return { ok: true, code: 'STARTED' };
        }
        if (now() >= deadline) {
          const reason = `反代子进程在 ${startTimeoutMs}ms 内没有在 127.0.0.1:${targetPort} 上探通（GET /v1/models）。`;
          // 先收束掉这个探不通的子进程，**再**落 failed：反序会把失败态覆盖成 stopped，
          // 界面上就变成「什么都没发生过」。
          await stopOwned();
          setState('failed', reason);
          return { ok: false, code: 'START_TIMEOUT' };
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    } finally {
      // 无论如何复位：漏复位会把状态机永久锁在 BUSY，比原 bug 更难查。
      startInFlight = false;
    }
  }

  /**
   * 只对**自己 spawn 的**子进程执行有界停止。external 态下这里根本不会被调用。
   * @returns {Promise<{ ok: boolean, code: string }>}
   */
  async function stopOwned() {
    const target = child;
    if (target === null) {
      // 自相矛盾的快照：状态说「在跑/在起」，手上却没有子进程句柄。静默回一个
      // 「已经停了」是**说谎**——那个进程真的还在跑，只是没人管它。必须显式报出来。
      if (state === 'running' || state === 'starting') {
        return { ok: false, code: 'INCONSISTENT_OWNERSHIP' };
      }
      setState('stopped', lastError);
      return { ok: true, code: 'ALREADY_STOPPED' };
    }
    intentionalStop = true;
    const exited = new Promise((resolvePromise) => {
      stopWaiter = () => resolvePromise(/** @type {true} */ (true));
    });
    try {
      target.kill('SIGINT');
    } catch {
      // 进程可能刚好已经没了；交给下面的等待与 SIGKILL 兜底。
    }
    const timer = new Promise((resolvePromise) => setTimeout(() => resolvePromise(/** @type {false} */ (false)), shutdownGraceMs));
    const graceful = await Promise.race([exited, timer]);
    if (!graceful && child === target) {
      try {
        target.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2_000))]);
    }
    if (child === target) {
      // exit 事件始终没来（极端情况）：自己把状态收干净，但**不**伪造一次成功退出。
      child = null;
      pid = null;
      setState('stopped', lastError);
    }
    return { ok: true, code: 'STOPPED' };
  }

  /**
   * 停止。external 态是硬拒绝：只观察，不发信号。
   * @returns {Promise<{ ok: boolean, code: string }>}
   */
  async function stop() {
    if (disposed) return { ok: false, code: 'DISPOSED' };
    if (state === 'external') return { ok: false, code: 'EXTERNAL_NOT_OWNED' };
    if (child === null) {
      if (state === 'stopped' || state === 'failed') {
        setState('stopped', lastError);
        return { ok: true, code: 'ALREADY_STOPPED' };
      }
      return { ok: false, code: 'BUSY' };
    }
    external = false;
    return stopOwned();
  }

  async function restart() {
    const stopped = await stop();
    // external 态下 stop() 必须拒绝（那个进程不是我们起的）。但 restart 的语义是
    // 「让我自己那条线重新可用」，所以仍然交给 start() 去重新探一次端口：外部进程
    // 还在就继续只观察，空了就接管。
    if (!stopped.ok && stopped.code !== 'EXTERNAL_NOT_OWNED') return stopped;
    return start();
  }

  /** 退出收束：幂等，且只碰自己 spawn 的进程。 */
  async function dispose() {
    if (disposed) return { ok: true, code: 'DISPOSED' };
    disposed = true;
    if (state === 'external') return { ok: true, code: 'NOT_OWNED' };
    if (child === null) {
      // 同 stopOwned：running/starting 却没有句柄 = 所有权自相矛盾，如实报而不是装成功。
      if (state === 'running' || state === 'starting') return { ok: false, code: 'INCONSISTENT_OWNERSHIP' };
      return { ok: true, code: 'NOT_OWNED' };
    }
    return stopOwned();
  }

  return {
    getSnapshot,
    /**
     * 由 main 在设置变更 / 启动时注入寻址结果。端口与 spawn 规格必须成对设置：
     * 只设其一会让 start() 以 `PORT_NOT_SET` / `SPAWN_SPEC_NOT_SET` 明确拒绝，
     * 而不是带着上一份配置去 spawn。
     *
     * **运行中不接受换端口。** 快照里的 `port` 必须始终等于「子进程真正在监听的那
     * 个」；此刻改成新值，界面就会显示一个没人监听的地址、转发全 502——快照说谎。
     * 新端口记进 `configuredPort`（界面据此显示「待重启生效」），要生效请走重启。
     *
     * @param {{ port: number, spawnSpec: SpawnSpec }} config
     * @returns {{ applied: boolean, reason?: string }}
     */
    configure(config) {
      configuredPort = config.port;
      if (state === 'running' || state === 'starting') {
        return { applied: false, reason: 'PROXY_RUNNING' };
      }
      port = config.port;
      spawnSpec = config.spawnSpec;
      notify();
      return { applied: true };
    },
    start,
    stop,
    restart,
    dispose,
    isExternal: () => state === 'external',
    getState: () => state
  };
}

exports.PROXY_STATES = PROXY_STATES;
exports.CHILD_ENV_KEYS = CHILD_ENV_KEYS;
exports.OS_ENV_PASSTHROUGH = OS_ENV_PASSTHROUGH;
exports.buildChildEnv = buildChildEnv;
exports.createProxyManager = createProxyManager;
