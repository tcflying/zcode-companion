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
 *     注意 `ZCC_JOURNAL_DIR` 是**条件发射**：声明在闭集内，但只有主进程给出了
 *     journal 目录时才真正写进 env。
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
  'ZCC_HOST_REASONING',
  // 929.md:875：把主进程已在用的 settings 目录交给子进程的 journal。
  // **条件发射**：只有 `journalDir` 非空时才带；缺省不带，子进程保持纯内存。
  'ZCC_JOURNAL_DIR'
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
 * @param {string} [options.journalDir] 操作 journal 落盘目录（与 settings 同根）。
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
  // 929.md:875：把主进程**已经在用**的目录交给子进程的 journal。
  // 缺省就不给这个键——子进程据此保持「纯内存、不落盘」，而不是自己猜一个目录。
  if (typeof options.journalDir === 'string' && options.journalDir !== '') {
    env['ZCC_JOURNAL_DIR'] = options.journalDir;
  }
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
 * @param {(port: number, signal?: AbortSignal) => Promise<boolean>} deps.probeApi 探测 `/v1/models`；401/200 都算活。`signal` 是启动预算耗尽时的取消口，实现必须把它透传给真正的请求。
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
   * **本次启动的代次**（ZC-33/F06）。
   *
   * `stop()` / `dispose()` 会**同步**把它推一格，预探在途的启动据此立刻作废。
   * 没有它，「停止 / 销毁」对预探窗口里的启动**完全无效**：那个窗口里
   * `child === null`（预探返回前还没 spawn），停止既拿不到句柄、也改不了
   * `attempt.code`，于是在途启动毫发无损地活过停止，返回后照样 spawn、
   * 照样报 `STARTED`，把终态写成 running。
   * @type {number}
   */
  let startEpoch = 0;
  /**
   * **收束在途**期间的非空收束 Promise（ZC-33/F06）。
   *
   * 并发的 `dispose()` 必须共享**同一个对象**并在同一次真实收束上共同落定；
   * 但 settled 之后必须回到既有幂等 `DISPOSED` 契约，所以它**不能**是永久单飞。
   * @type {Promise<{ ok: boolean, code: string }> | null}
   */
  let disposeInFlight = null;
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

  /**
   * 本次启动尝试的**一次性完成保护**。
   *
   * `error`（可执行文件 / cwd 失效时的异步 ENOENT）、`exit`、启动超时三条路径会
   * **同时**抵达同一批字段：Node 在 spawn 失败时先抛 `error`，某些平台上还会补一个
   * `close`/`exit`。三条路径共用这一个闸，**谁先到谁定终态**，后到的直接被忽略——
   * 否则会产出「先 failed 又 stopped」这种从未发生过的状态组合，界面上就是一个
   * 凭空的二次结论。
   *
   * `code === null` = 还没有任何人定终态。`wake` 是轮询等待的唤醒口：`error` 抵达时
   * 靠它把 `start()` 立刻叫醒，而不是白等到下一个轮询节拍（默认 150ms 起）、甚至
   * 一路等到 startTimeoutMs 报一个把真实原因整个丢掉的 `START_TIMEOUT`。
   * @type {{ code: string | null, wake: (() => void) | null }}
   */
  const attempt = { code: /** @type {string|null} */ (null), wake: /** @type {(() => void)|null} */ (null) };

  /**
   * 抢一次性完成保护。
   * @param {string} code
   * @returns {boolean} true = 本次调用定下了终态；false = 终态早已被别人定走。
   */
  function claimAttempt(code) {
    if (attempt.code !== null) return false;
    attempt.code = code;
    const wake = attempt.wake;
    attempt.wake = null;
    if (wake) wake();
    return true;
  }

  /**
   * 挂起一轮轮询等待，但被 `error` / `exit` **立刻**唤醒。
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function waitForAttemptTick(ms) {
    return new Promise((resolvePromise) => {
      /** @type {any} */
      let timer = null;
      const done = () => {
        if (timer !== null) clearTimeout(timer);
        if (attempt.wake === done) attempt.wake = null;
        resolvePromise(undefined);
      };
      timer = setTimeout(done, ms);
      attempt.wake = done;
    });
  }

  /**
   * 在**剩余预算**内探测一次；预算耗尽时**真的取消底层探测**。
   *
   * 为什么 `Promise.race([probe, timer])` 不够（ZC-31/F16）：
   * 那只让**上层不再等**，底层那个请求仍然挂着——句柄不释放、连接不关，
   * 预算耗尽就成了摆设，迟到的一个 `true` 还能把终态偷改成成功。
   * 所以这里额外持有 `AbortController`：预算一到立刻 `abort()`，并给迟到的
   * 落定补一个被吞掉的 catch（否则取消会变成 `unhandledRejection`）。
   *
   * 剩余预算 ≤ 0 时**根本不发探测**：预算已经用完，再发一次就是明知故犯。
   *
   * @param {number} targetPort
   * @param {number} deadline
   * @returns {Promise<{ exhausted: boolean, alive: boolean }>}
   */
  async function probeWithinDeadline(targetPort, deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) return { exhausted: true, alive: false };

    const controller = new AbortController();
    /** @type {any} */
    let timer = null;
    try {
      const probe = Promise.resolve()
        .then(() => deps.probeApi(targetPort, controller.signal))
        .then(
          (v) => ({ kind: 'probe', alive: v === true }),
          () => ({ kind: 'probe', alive: false })
        );
      const guard = new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ kind: 'budget' }), remaining);
      });
      const winner = await Promise.race([probe, guard]);
      // **probe 先赢 ≠ 它还在预算内。**`await` 让出一次微任务，事件循环在这段时间里
      // 可能已经越过 deadline——Promise 微任务优先于定时器就是最典型的场景。
      // 所以这里必须**再核一次时钟**：只有仍在预算内才接受探测结果。
      // 定时器赢、或 probe 赢但已超时，一律按「预算耗尽」处理并取消底层。
      if (winner.kind === 'probe' && now() < deadline) return { exhausted: false, alive: winner.alive };
      // 预算耗尽：**必须**取消底层，否则它会一直挂着直到自己超时。
      controller.abort();
      return { exhausted: true, alive: false };
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
  }

  /**
   * 把 Node 的 spawn `error` 收成**不扩大错误信息面**的一小段。
   *
   * 只取 `code`（`ENOENT` / `EACCES` …）这一个**原因标记**：`err.message` 里带着
   * 可执行文件的完整路径，`err.syscall` 同样带路径，两者都按「不得为『好排查』把
   * 路径/字段/参数原样写进日志或错误体」的口径**不进** `lastError`。凭据形态的字段
   * （env / args）更是完全不碰——key 只活在 env 里，失败原因不需要它。
   * @param {any} err
   * @returns {string}
   */
  function describeSpawnError(err) {
    const code =
      err !== null && typeof err === 'object' && typeof (/** @type {any} */ (err).code) === 'string'
        ? /** @type {any} */ (err).code
        : null;
    return code === null || code === '' ? 'UNKNOWN' : code;
  }

  /**
   * 自有 ChildProcess 的**异步**失败通道。
   *
   * `spawn()` 本身没抛**不代表起来了**：可执行文件或 cwd 失效是 Node 异步
   * `emit('error', err)`（`ENOENT`）。不订阅它 ⇒ EventEmitter 的「error 无监听即抛」
   * ⇒ 只能靠宿主（Electron）的全局 `uncaughtException` 兜底 ⇒ 管理器**永远等不到
   * 失败信号**，一路轮询到 startTimeoutMs，把 `ENOENT` 这个真实原因整个丢掉，只报
   * 一个误导性的 `START_TIMEOUT`。
   *
   * 宿主的既有行为已对 electron v44.4.5 上游 `lib/browser/init.ts:17-33` 核实：
   * 它注册了 `process.on('uncaughtException', ...)`，注释为 "Don't quit on fatal
   * error."，只弹错误框、**不退出**。所以这里**不能**断言「桌面必崩」——那条是假的；
   * 但「不崩」也不等于「没事」：失败信号会被宿主兜底悄悄吃掉，真实原因照样丢。
   * 正因如此，这个订阅必须由管理器自己完成，不能指望宿主。
   *
   * @param {FakeChild} target
   * @param {any} err
   */
  function onSpawnError(target, err) {
    if (target !== child) return; // 已被替换的旧子进程，忽略。
    // 两种情况都**不是**「拉起失败」，必须放行到既有路径，不许在这里捏造终态：
    //  1. `intentionalStop`：用户主动停止。`stopOwned()` 已经置位，而 SIGINT 打到
    //     一个已经不在的进程上时，Node 会补一个 `ESRCH` error —— 那是**我们自己要
    //     的收束动作**的回声，不是启动失败。只挡 `state` 会让 starting 窗口内的
    //     stop() 凭空造出 SPAWN_FAILED，终态从基线的 stopped 变成 failed。
    //  2. `state !== 'starting'`：`running` 之后 Node 仍可能为 kill 失败发 error
    //     （那时 `start()` 已经回过 `STARTED` 了），报成 `SPAWN_FAILED` 是谎报。
    if (intentionalStop || state !== 'starting') {
      deps.logRing.append('main', `反代子进程发出 error（${describeSpawnError(err)}），当前非拉起失败，已忽略。`, now());
      return;
    }
    const reason = `反代子进程拉起失败（异步 error：${describeSpawnError(err)}）。请检查反代运行时的路径与权限是否仍然有效。`;
    // 与 exit / 超时共用同一个闸：先到者定终态。
    if (!claimAttempt('SPAWN_FAILED')) return;
    detachStreams(target);
    deps.logRing.flush(now());
    // 进程根本没起来，**没有**可回收的 OS 句柄：发任何信号都是发给一个不存在的
    // 进程，属于「假装收干净」。这里只把管理器侧的引用放掉。
    child = null;
    pid = null;
    setState('failed', reason);
  }

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
      // 活动配置在这里**成对固定**：端口与 spawn 规格取自同一瞬间的同一次 `configure`。
      // 紧接着就是第一个 `await`（预探）。若把 spawn 规格留到 await 之后再读，预探期间
      // 的一次保存就会让「spawn 用新配置、probe 仍打旧端口」——子进程在 A 端口监听、
      // 探活在 B 端口打：A 已经就绪也报 `START_TIMEOUT`，B 上有残留服务反而报 `STARTED`。
      const targetPort = port;
      const activeSpec = spawnSpec;
      // **一个**启动 deadline，预探与轮询**共用**：预算从 `start()` 进入就起算。
      // 原实现把 deadline 算在预探与 spawn **之后**，等于预探完全不受预算约束。
      // **本次启动的代次**（ZC-33/F06）。`stop()` / `dispose()` 会同步把它推一格。
      const epoch = startEpoch;
      /** 本次启动是否已被停止 / 销毁作废。 */
      const invalidated = () => disposed || epoch !== startEpoch;
      const deadline = now() + startTimeoutMs;
      const pre = await probeWithinDeadline(targetPort, deadline);
      // **await 之后必须重查有效性**：这里才是真正要改状态（external / spawn）的地方。
      // 停止 / 销毁优先于超时分类——用户已经明说「别起了」，再报 START_TIMEOUT 是在说谎。
      if (invalidated()) return disposed ? { ok: false, code: 'DISPOSED' } : { ok: false, code: 'STOPPED' };
      // 预探预算耗尽：我们**不知道**端口是否已被占用，因此既不能报 EXTERNAL，
      // 也不能贸然 spawn 去抢一个可能已被占用的端口。只如实报超时。
      // **两处都要复核**：helper 内那次管的是 abort 与分类，而 helper 返回到调用方
      // 还隔着一次微任务边界 —— 真正要改状态（external / spawn）的是这里（ZC-31/F16 P1）。
      if (pre.exhausted || now() >= deadline) {
        setState(
          'failed',
          `反代预探在 ${startTimeoutMs}ms 内没有在 127.0.0.1:${targetPort} 上得出结论（GET /v1/models）；该探测已被取消，本次未拉起子进程。`
        );
        return { ok: false, code: 'START_TIMEOUT' };
      }
      const alive = pre.alive;
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
      // 一次性完成保护按**每次尝试**复位。迟到的旧子进程事件被 `target !== child`
      // 挡在 claim 之前，所以复位不会让上一次尝试的尾巴污染这一次。
      attempt.code = null;
      attempt.wake = null;
      try {
        spawned = deps.spawnChild(activeSpec);
      } catch (err) {
        setState('failed', `反代子进程拉起失败：${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, code: 'SPAWN_FAILED' };
      }
      child = spawned;
      pid = typeof spawned.pid === 'number' ? spawned.pid : null;
      attachStreams(spawned);
      // **立刻**订阅 `error`：`spawn()` 不抛 ≠ 起来了。可执行文件 / cwd 失效走的是
      // Node 的异步 error 通道（见 `onSpawnError`），漏订阅就永远进不了失败路径。
      spawned.on('error', (/** @type {any} */ err) => onSpawnError(spawned, err));
      spawned.on('exit', (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
        // 身份守卫放在抢闸**之前**：一次迟到的旧 exit 不许白白吃掉本次尝试的闸。
        if (spawned !== child) return;
        // 与 error 共用一次性完成保护：error 先到时（异步 ENOENT），终态已定，
        // 这次 exit 不得再改写状态、也不得覆盖掉真实原因。
        //
        // **但主动停止要放行**：`stopOwned()` 发的 SIGINT 引发的 exit 正是它要等的那个
        // 兑现，被同一个闸拦下 ⇒ `onExit` 永不执行 ⇒ `stopWaiter` 永不 resolve ⇒
        // 收束只能走满 grace + SIGKILL + 2s 兜底，并给子进程补一刀本不该发的 SIGKILL。
        // 主动停止的终态由 `onExit` 的 `intentionalStop` 分支负责，不会与抢闸冲突：
        // 它落的 `stopped` 随后仍会被超时分支的 `setState('failed', reason)` 收成
        // START_TIMEOUT —— 与本次修复前的既有语义逐字一致。
        if (!intentionalStop && !claimAttempt('CHILD_EXITED')) return;
        onExit(spawned, code, signal);
      });

      // deadline 已在预探之前起算（与预探共用），这里不再重算。
      // 轮询到「探通」/「子进程先死（含异步 error）」/「超时」三者之一为止。
      for (;;) {
        // 一次性完成保护：error / exit 已经定过终态就立刻交出，绝不再往下走一步，
        // 把真实原因覆盖成 CHILD_EXITED 或 START_TIMEOUT。
        if (attempt.code !== null) return { ok: false, code: attempt.code };
        if (child !== spawned) return { ok: false, code: 'CHILD_EXITED' };
        const polled = await probeWithinDeadline(targetPort, deadline);
        // 探测在途期间抵达的 error / exit 优先于「探不通」：进程都没起来，探通没有意义。
        // 这条修复了第二个连带缺陷：探测挂起时旧代码**卡在 await 里出不来**，
        // 于是 error 已经抢到闸、真实原因却永远送不到调用方。
        if (attempt.code !== null) return { ok: false, code: attempt.code };
        // **await 之后必须再核一次 child 身份**（ZC-32/F07）。
        // 原来身份检查只在 await **之前**：子进程在探测在途期间退出，`onExit` 会把
        // `child` 清成 null；而主动停止时 exit 监听**跳过** claimAttempt，
        // `attempt.code` 仍是 null —— 上面那道检查根本拦不住。
        // 后果是「晚到的 true」直接进成功分支：报 STARTED、`child === null` 的坏快照
        // （owned:false / pid:null），把终态从 stopped/failed 改写成 running，
        // 之后 start / stop / restart 全部 BUSY（死锁）。
        // 晚到的 false 不受影响：它会落到循环顶部，那里的身份检查还等着。
        if (child !== spawned) return { ok: false, code: 'CHILD_EXITED' };
        // **await 之后重查有效性**（ZC-33/F06），但**必须排在身份检查之后**。
        // 主动停止已让子进程退出时，`child !== spawned` 先命中，仍按既有语义报
        // `CHILD_EXITED`（ZC-32/F07 已签收口径）；只有「句柄还在、却已被 stop /
        // dispose 作废」这一支才由这里接管，迟到 true / false 都不会被采纳。
        if (invalidated()) return disposed ? { ok: false, code: 'DISPOSED' } : { ok: false, code: 'STOPPED' };
        // **先判截止，再看探测结果**：helper 返回到调用方之间还隔着一次微任务边界，
        // 此处若不复核，一个**已经超时**的 true 仍会把状态写成 running（ZC-31/F16 P1）。
        if (polled.exhausted || now() >= deadline) {
          const reason = `反代子进程在 ${startTimeoutMs}ms 内没有在 127.0.0.1:${targetPort} 上探通（GET /v1/models）。`;
          // **先抢闸再收束**：`stopOwned()` 期间抵达的 error 不得把 failed 改写一次，
          // 那是两个终态。
          claimAttempt('START_TIMEOUT');
          // 先收束掉这个探不通的子进程，**再**落 failed：反序会把失败态覆盖成 stopped，
          // 界面上就变成「什么都没发生过」。
          await stopOwned();
          setState('failed', reason);
          return { ok: false, code: 'START_TIMEOUT' };
        }
        // 确认仍在预算内之后，才轮到「探通 ⇒ running」这条成功分支。
        if (polled.alive) {
          // **故意不抢闸**：running 之后的意外退出仍必须由 `onExit` 正常落 failed。
          setState('running', null);
          return { ok: true, code: 'STARTED' };
        }
        await waitForAttemptTick(pollIntervalMs);
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
    // 停止必须**同步**让在途启动失效（ZC-33/F06）：预探窗口里 `child === null`，
    // 停止拿不到任何句柄；不推代次那次启动就会继续 spawn。
    // 推代次必须在 `child === null` 那个早退分支**之前**——那种情况下
    // 「本来就没什么可停」也仍然必须作废在途启动。
    startEpoch += 1;
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
  function dispose() {
    // **收束在途**：并发调用共享**同一个** pending Promise，在同一次真实收束上
    // 共同落定；第二次不许自己另起一条（ZC-33/F06）。必须返回同一个对象，所以
    // 这里刻意**不是 async**——`async function f() { return p; }` 返回的是新包装。
    if (disposeInFlight !== null) return disposeInFlight;
    // **已 settled**：回到既有幂等契约，且**不重新清理**。
    if (disposed) return Promise.resolve({ ok: true, code: 'DISPOSED' });
    disposed = true;
    // 销毁同样必须**同步**作废在途启动。
    startEpoch += 1;
    const pending = (async () => {
      if (state === 'external') return { ok: true, code: 'NOT_OWNED' };
      if (child === null) {
        // 同 stopOwned：running/starting 却没有句柄 = 所有权自相矛盾，如实报而不是装成功。
        if (state === 'running' || state === 'starting') return { ok: false, code: 'INCONSISTENT_OWNERSHIP' };
        return { ok: true, code: 'NOT_OWNED' };
      }
      return stopOwned();
    })();
    disposeInFlight = pending;
    // 清理必须**同步注册**：调用方的 `await` 续行一定排在这条之后，
    // 于是 settled 之后的调用看到的已经是 `disposeInFlight === null`，走幂等分支。
    const clear = () => {
      if (disposeInFlight === pending) disposeInFlight = null;
    };
    pending.then(clear, clear);
    return pending;
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
      // **预探窗口**：`state` 要到预探返回之后才置成 `starting`，所以这段窗口里只读
      // `state` 的守卫看到的是 `stopped`，会把在途 `start()` 的活动配置整个换掉——
      // 端口换了、spawn 规格换了，而在途 start 的探针还打旧端口，结果就是错位。
      // 这里**只记待生效配置**（`configuredPort`，界面据此显示「待重启生效」），
      // 活动配置一律不换；由 `start()` 在第一次 await 之前成对固定来保证一致。
      if (startInFlight) {
        return { applied: false, reason: 'PROXY_START_IN_FLIGHT' };
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
