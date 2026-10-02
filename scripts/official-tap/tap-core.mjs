/**
 * tap-core.mjs — 官方 dev stdio-tap 的**纯逻辑层**。
 *
 * 本文件只做无副作用的计算：argv 切分、id 命名空间、付费通道白名单、子进程帧
 * 路由判定、NDJSON 行扫描、子进程环境构造、诊断字段净化。**没有 fs / net /
 * child_process / process 写入**——这样每一条硬约束都能被单测直接钉死。
 *
 * 四条不可让渡的设计约束（各自对应本文件里的一组函数）：
 *
 *  1. **逐字节保真**（`pumpBytes` 在 tap-relay.mjs，本文件只提供 NDJSON 观察器
 *     `NdjsonLineScanner`）：观察器是**旁路**，它只从 chunk 里"抄走"自己需要的
 *     那一行，转发路径拿到的永远是原始 Buffer 对象本身。
 *  2. **绝不记录帧内容**（`DIAG_FIELD_ALLOWLIST` + `sanitizeDiagFields`）：诊断
 *     字段走白名单 + 原语类型 + 长度三重闸门，结构上不可能把内容写出去。
 *  3. **凭据永远不进控制通道**（`classifyChildFrame`）：只有"字符串 id 在我们命名
 *     空间内 + 没有 method 字段 + 带 result/error + 在等待表里"的帧才回控制端。
 *     凭据请求是请求帧（有 method）→ 结构性排除；凭据应答的 id 不在我们的命名
 *     空间 → 也排除。两条判据互相独立。
 *  4. **付费通道白名单必须在注入前拦截**（`evaluateInjectPolicy`）：默认拒绝，
 *     只有携带 `account:` 前缀通道标识的帧才放行；黑名单 5 个 id 只是白名单规则
 *     的一个可命名的子集。
 */

/** tap 协议版本（控制通道 `zccTap.v` 与诊断 `event` 前缀共用）。 */
export const TAP_PROTOCOL_VERSION = 1;

/** 控制通道默认端口。8790 被本机反代占用、8765 被无关进程占用，8791 是本工单核实的空闲端口。 */
export const CONTROL_DEFAULT_PORT = 8791;

/** 控制通道只绑回环。绑定之外一律拒绝连接。 */
export const CONTROL_HOST = '127.0.0.1';

/** 我们注入的请求必须使用的 id 前缀。子进程→父进程方向只有命中它的帧才回控制端。 */
export const TAP_ID_PREFIX = 'zcc-tap-';

/**
 * 控制通道单行上限（**含行终止符 `\n`**）。超界即回 `frame_too_large` 并**断开该连接**，
 * 不做"截断成一个看起来合法的请求"。
 *
 * 语义（`tap-control.mjs` 的 `socket.on('data')` 里两处检查共同实现）：
 *  - **完整行**：切出 `\n` 之前先看该行长度，超界就**不切走、不解析**，直接断连。
 *  - **未终止尾段**：每累积一块就检查一次，超界即断连。
 * 换句话说这是一个**内存上界**，不是"事后统计"；断连后没有流重同步问题——断连即止。
 *
 * 取 2 MiB（而不是 1 MiB）是为了给内层留余量：控制帧是 `{zccTap:{v,op,id,frame}}`，
 * 外层包装本身有几十字节开销，控制层必须**大于** `MAX_INJECT_LINE_BYTES`，否则"刚好在
 * 界内的注入帧"会被外层包装顶出去。**这是防御性余量，不是"对齐官方上限"**——官方入站
 * 侧根本没有行长强制上限可对齐（见 `MAX_INJECT_LINE_BYTES` 的依据说明）。
 */
export const CONTROL_MAX_LINE_BYTES = 2 * 1024 * 1024;

/** 控制通道并发连接上限。超出立即断开，不排队（避免无界堆积）。 */
export const CONTROL_MAX_CONNECTIONS = 4;

/**
 * 注入帧单行上限（含行终止符 `\n`）。**取值 1 MiB，来源是 `fc.maxFrameBytes`
 * 的字面值**（`C:\ZCode\resources\glm\zcode.cjs` 第 72 行第 49239 列：
 * `fc = { maxFrameBytes: 1024*1024, … }`）。
 *
 * **这个取值的方向必须说准，否则会引出一个错的保证。** 逐字节核对过 `fc.maxFrameBytes`
 * 在官方 bundle 里的全部 3 处引用：
 *  - 第 72 行内 `QI = { maxPhysicalFrameBytes: fc.maxFrameBytes, maxMessageBytes: 16*1024*1024,
 *    maxFragments: 64, assemblyTimeoutMs: 3e4, transportIdMaxChars: … }`；
 *  - 第 72 行内 `J0r(...)` → `H0r(t.maxPhysicalFrameBytes, fc.maxFrameBytes, "maxPhysicalFrameBytes")`。
 * 两处都在**出站物理信封/分片组装**这一侧。
 *
 * 官方**入站**读取器是 `ZCodeProtocolNdjsonConnection`（`zcode.cjs:15262` col 97951
 * 的 `fTt=class{static{r(this,"ZCodeProtocolNdjsonConnection")}`），它的 `onData`
 * （`zcode.cjs:15263` col 69）是：
 *
 *     onData = r(t => {
 *       if (this.terminal || this.draining) return;
 *       this.buffer += typeof t == "string" ? t : t.toString("utf8");
 *       let n = this.buffer.indexOf("\n");
 *       for (; n >= 0;) { … this.dispatchLine(o) … n = this.buffer.indexOf("\n"); }
 *     }, "onData")
 *
 * `buffer += chunk` 然后 `indexOf('\n')`，**没有任何行长守卫**。整个 14.8 MB 的
 * `zcode.cjs` 里搜 `maxLineBytes` / `lineTooLong` / `maxInboundLine` / `frameTooLarge`
 * 均 **0 命中**，可证伪。
 *
 * 因此准确表述是：**1 MiB 是我们自选的、比官方更保守的取值，不是官方强制的入站上限。
 * 超过 1 MiB 的帧官方并不"必然拒收"**——它多半会在 `decodeLine` 之后的 schema 解析、
 * 逻辑帧组装上限（`logicalFrameAssemblyMaxBytes: 16*1024*1024`）或更外层的资源限制上
 * 以别的形式失败，但那不再是"1 MiB 拒收"这条规则。我们把 1 MiB 当作**自己的策略界**：
 * 超界就 `frame_too_large` 拒收，控制端立刻拿到明确回执，而不是等 120 s 超时。
 * 原先的 4 MiB 同样是自造的宽数字，只是方向相反的坏。
 *
 * 注入我们自己构造的帧才受此限；中继路径不受任何行上限约束。
 */
export const MAX_INJECT_LINE_BYTES = 1024 * 1024;

/** 旁路行扫描器的单行上限。超过后**只停观察**，转发一个字节都不少。 */
export const MAX_SCAN_LINE_BYTES = 4 * 1024 * 1024;

/** 注入请求的等待上限。超时后回一次 `timeout` 错误并丢弃等待项，不重发、不猜测。 */
export const REQUEST_TIMEOUT_MS = 120_000;

/** 控制令牌最小长度。小于此长度的令牌一律视为未配置。 */
export const MIN_CONTROL_TOKEN_CHARS = 16;

/**
 * 付费/按量计费通道黑名单。
 *
 * `builtin:bigmodel` / `builtin:zai` 经官方 `migrateLegacyModelProviderId` 会变成
 * `bigmodel-api` / `zai-api`，两者都是按量计费；`zai-standard-api` 同理。工单把
 * 这五个 id 逐个点名，因此保留为可命名的常量——判定本身由 `account:` 白名单完成，
 * 黑名单只是让错误回执能指名道姓，而不是"看起来像黑名单"。
 */
export const BLOCKED_CHANNEL_IDS = Object.freeze([
  'bigmodel-api',
  'zai-api',
  'zai-standard-api',
  'builtin:bigmodel',
  'builtin:zai'
]);

/** 唯一允许的通道前缀（订阅通道）。 */
export const ALLOWED_CHANNEL_PREFIX = 'account:';

/**
 * 被当作"通道标识"检查的字段名。取模型/通道语义的那几个键，不做全量字符串扫描：
 * 全量扫描会把提示词里出现的同名字样也当成通道，误伤面太大。
 */
export const CHANNEL_FIELD_KEYS = Object.freeze([
  'model',
  'modelId',
  'modelProvider',
  'modelProviderId',
  'provider',
  'providerId',
  'providerFamily',
  'billingMode'
]);

/* -------------------------------------------------------------------------- */
/* CLI 契约                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * argv 切分的结果。`workspaceKey` / `logDir` 只用于诊断定位，**调用方不得把它们
 * 写进诊断或回给控制端**（见 `sanitizeDiagFields`：它们不在字段白名单里）。
 *
 * @typedef {Object} ParsedTapArgv
 * @property {string | null} workspaceKey
 * @property {string | null} logDir
 * @property {number} controlPort
 * @property {string} command
 * @property {readonly string[]} args
 */

/**
 * argv 切分失败。`code` 是稳定标识，调用方据此决定退出码。
 *
 * @typedef {Object} TapArgvError
 * @property {'missing_boundary' | 'missing_command' | 'unknown_option' | 'missing_value' | 'duplicate_option' | 'bad_port'} code
 * @property {string} detail
 */

/**
 * @typedef {{ ok: true, parsed: ParsedTapArgv } | { ok: false, error: TapArgvError }} TapArgvResult
 */

const TAP_OPTIONS = new Set(['--workspace-key', '--log-dir', '--control-port']);

/**
 * 以**第一个** `--` 为界切分：之前是给 tap 自己的选项，之后原封不动交给真实
 * app-server。真实命令以 `process.execPath + [zcode.cjs, "app-server", "--stdio"]`
 * 的形状出现（官方 `wrapZCodeAgentCommandWithStdioTapDevProxy` 的 spawn 实参），
 * 所以 `--` 之后**不做任何解释**：第一个 token 是可执行文件，其余是它的参数。
 *
 * @param {readonly string[]} argv
 * @returns {TapArgvResult}
 */
export function parseTapArgv(argv) {
  const boundary = argv.indexOf('--');
  if (boundary < 0) {
    return { ok: false, error: { code: 'missing_boundary', detail: 'argv 里没有 `--` 分界符' } };
  }
  /** @type {Map<string, string>} */
  const options = new Map();
  let i = 0;
  while (i < boundary) {
    const arg = argv[i] ?? '';
    if (!TAP_OPTIONS.has(arg)) {
      return { ok: false, error: { code: 'unknown_option', detail: `未知选项 ${arg}` } };
    }
    const value = argv[i + 1];
    if (value === undefined || value === '--') {
      return { ok: false, error: { code: 'missing_value', detail: `选项 ${arg} 缺少取值` } };
    }
    if (options.has(arg)) {
      return { ok: false, error: { code: 'duplicate_option', detail: `选项 ${arg} 重复` } };
    }
    options.set(arg, value);
    i += 2;
  }

  const tail = argv.slice(boundary + 1);
  const command = tail[0];
  if (command === undefined || command === '') {
    return { ok: false, error: { code: 'missing_command', detail: '`--` 之后没有真实命令' } };
  }

  const portRaw = options.get('--control-port');
  let controlPort = CONTROL_DEFAULT_PORT;
  if (portRaw !== undefined) {
    // 只认十进制数字串：`0x10` / `1e3` / ` 80 ` 这类写法一律拒绝，
    // 免得"看起来是端口"的东西被静默当成别的数。
    const port = /^\d{1,5}$/u.test(portRaw) ? Number(portRaw) : Number.NaN;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return { ok: false, error: { code: 'bad_port', detail: `控制端口非法：${portRaw}` } };
    }
    // 0 = 交由系统分配（仅测试用；生产固定 8791）。
    controlPort = port;
  }

  return {
    ok: true,
    parsed: {
      workspaceKey: options.get('--workspace-key') ?? null,
      logDir: options.get('--log-dir') ?? null,
      controlPort,
      command,
      args: tail.slice(1)
    }
  };
}

/* -------------------------------------------------------------------------- */
/* id 命名空间                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 该 id 是否属于我们的命名空间。**这是凭据隔离与桌面流量隔离的唯一判据**：桌面
 * 自己的 id 是数字或官方形状的字符串，永远不命中本函数。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNamespacedId(value) {
  return typeof value === 'string' && value.startsWith(TAP_ID_PREFIX) && value.length > TAP_ID_PREFIX.length;
}

/* -------------------------------------------------------------------------- */
/* 官方请求帧形状（B1）                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 官方 app-server 入站**请求** schema 允许的顶层键，**全集**。
 *
 * 依据（`C:\ZCode\resources\glm\zcode.cjs`，只读逐字节核对）：
 *  - 第 72 行第 137537 列：
 *    `qir = m.object({ id: yYe, method: Dn, params: m.unknown().optional(), trace: $Ht.optional() }).strict()`
 *    该符号在同文件第 96 行第 55444 列的导出表里名为 `zcodeProtocolRequestSchema`。
 *  - 第 72 行第 137887 列：`qHt = m.union([qir, Wir, Vir, Hir])`，
 *    导出名 `zcodeProtocolMessageSchema`（第 96 行第 55270 列）。
 *  - app-server 解析入站行的 `decodeLine`（第 15265 行第 2157 列）用的是
 *    `qHt.safeParse(n)`，失败即 `sendError("invalid-message", -32600, …)` 并丢弃。
 *
 * `.strict()` 意味着**多一个键就整帧作废**。`jsonrpc` 不在这个全集里，所以带
 * `jsonrpc: "2.0"` 的注入帧 100% 被官方拒收——而那条错误帧的 id 是字面量
 * `"invalid-message"`（不是我们注入的 id），tap 会判成 `forward_only` 转发给桌面、
 * 桌面静默丢弃，控制端只能干等到 120 s 超时。整条失败链**全链路静默**。
 *
 * 官方四条 schema 的顶层键并集正好是这四个：
 *   请求 `qir`     → id / method / params / trace
 *   通知 `Wir`     → method / params / trace        （无 id）
 *   应答 `Vir`     → id / result
 *   错误 `Hir`     → id / error
 * 我们只注入请求帧，因此只用 `qir` 那一条。
 */
export const OFFICIAL_REQUEST_TOP_LEVEL_KEYS = Object.freeze(['id', 'method', 'params', 'trace']);

/**
 * 注入请求的 `id` 为什么可以用**字符串**——这是从官方 schema 直接读出来的，不靠推断。
 *
 * 依据：`C:\ZCode\resources\glm\zcode.cjs` 第 72 行第 137377 列
 *   `yYe = m.union([ m.string(), m.number().int() ])`
 * 该符号在同文件第 96 行第 55407 列的导出表里名为 **`zcodeProtocolRequestIdSchema`**。
 *
 * 也就是说官方 app-server 在**入站请求**上明确接受字符串 id，`m.string()` 没有格式
 * 约束（官方只对**出站**信封有 `transportEnvelopeIdMaxChars: 256` 的长度上限，见
 * `zcode.cjs` 第 72 行第 49462 列；`zcc-tap-` 形状远在其内）。所以我们坚持用
 * `zcc-tap-` 前缀字符串 id 是有据的，不是"JSON-RPC 2.0 允许字符串"这种弱论证。
 */
export const OFFICIAL_REQUEST_ID_SCHEMA_NOTE =
  'zcode.cjs:72 col 137377 `yYe=m.union([m.string(),m.number().int()])` ' +
  '= zcodeProtocolRequestIdSchema (zcode.cjs:96 col 55407)';

/**
 * 按官方 `zcodeProtocolRequestSchema` 校验一个注入帧的形状。
 *
 * 只做**结构性**判定，不碰 `params` 的内容（官方那里是 `m.unknown()`）：
 *  1. 必须是普通对象（不是 null / 数组 / 原始值）；
 *  2. 顶层键必须是 `OFFICIAL_REQUEST_TOP_LEVEL_KEYS` 的**子集**——多出来的键
 *     （典型如 `jsonrpc`）一律拒收，这正是官方 `.strict()` 的行为；
 *  3. `id` 必填，且必须是字符串或整数（官方 `yYe`）；
 *  4. `method` 必填，且必须是 `trim()` 后非空的字符串（官方 `Dn = m.string().trim().min(1)`，
 *     见 `zcode.cjs` 第 72 行第 134359 列）。
 *
 * `trace` 官方是 `$Ht.optional()` 且同样 `.strict()`；我们**刻意不递归校验它**——
 * 它的字段全 optional，深校验会变成我们替官方猜协议。要用 trace 的调用端自己负责。
 *
 * **为什么是"拒绝"而不是"静默剥离 `jsonrpc`"**：静默改写会让"注入的到底是什么"
 * 变得不可追，而本 tap 的其余判定（白名单、id 命名空间）全是**默认拒绝 + 明确
 * 错误码**。剥离是"看不见的修改"，拒绝是"看得见的失败"，后者与整体设计一致。
 *
 * @param {unknown} frame
 * @returns {{ ok: true, frame: Record<string, unknown> } | { ok: false, code: 'unparsable_frame' | 'invalid_frame_shape', field: string | null, matched: null, detail: string }}
 */
export function validateOfficialRequestFrame(frame) {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return {
      ok: false,
      code: 'unparsable_frame',
      field: null,
      matched: null,
      detail: '注入帧必须是 JSON 对象'
    };
  }
  const record = /** @type {Record<string, unknown>} */ (frame);
  for (const key of Object.keys(record)) {
    if (!OFFICIAL_REQUEST_TOP_LEVEL_KEYS.includes(key)) {
      return {
        ok: false,
        code: 'invalid_frame_shape',
        field: `frame.${key}`,
        matched: null,
        detail:
          `顶层键 ${key} 不在官方 zcodeProtocolRequestSchema 的键集合 ` +
          `{${OFFICIAL_REQUEST_TOP_LEVEL_KEYS.join(', ')}} 内，官方 .strict() 会拒收整帧`
      };
    }
  }
  const id = record['id'];
  const idOk = typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id));
  if (!idOk) {
    return {
      ok: false,
      code: 'invalid_frame_shape',
      field: 'frame.id',
      matched: null,
      detail: `id 必须是字符串或整数（官方 zcodeProtocolRequestIdSchema），收到 ${typeof id}`
    };
  }
  const method = record['method'];
  if (typeof method !== 'string' || method.trim().length === 0) {
    return {
      ok: false,
      code: 'invalid_frame_shape',
      field: 'frame.method',
      matched: null,
      detail: 'method 必须是非空字符串（官方 m.string().trim().min(1)）'
    };
  }
  return { ok: true, frame: record };
}

/**
 * 把校验通过的注入帧**投影**成官方请求帧并序列化成要写进子进程 stdin 的那一行。
 *
 * 投影而不是"原样 JSON.stringify(控制端送来的对象)"是有意的：这里的输出是**按
 * 官方键集合重建**的，即使校验被绕过、`frame` 上多挂了什么键，落进子进程 stdin 的
 * 字节也只可能有 `id/method/params/trace` 四个顶层键。写出去的字节因此是**构造出来
 * 的**，不是转发来的——`jsonrpc` 在结构上没有位置存在。
 *
 * 键序固定为官方 schema 的声明序（`id, method, params, trace`），使同一输入永远得到
 * 同一串字节，便于逐字节断言。
 *
 * @param {unknown} frame
 * @returns {{ ok: true, line: string, bytes: number }
 *   | { ok: false, code: 'unparsable_frame' | 'invalid_frame_shape' | 'frame_too_large', field: string | null, matched: null, detail: string }}
 */
export function buildOfficialRequestLine(frame) {
  const checked = validateOfficialRequestFrame(frame);
  if (!checked.ok) return checked;
  /** @type {Record<string, unknown>} */
  const projected = {};
  for (const key of OFFICIAL_REQUEST_TOP_LEVEL_KEYS) {
    if (key in checked.frame) projected[key] = checked.frame[key];
  }
  let line;
  try {
    line = `${JSON.stringify(projected)}\n`;
  } catch {
    return {
      ok: false,
      code: 'unparsable_frame',
      field: null,
      matched: null,
      detail: '帧无法序列化'
    };
  }
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_INJECT_LINE_BYTES) {
    return {
      ok: false,
      code: 'frame_too_large',
      field: null,
      matched: null,
      // **TAPN / N2：这条文案是发给控制端的运行时输出，不是注释。** 原文写的是
      // "超过官方 maxFrameBytes 上限"，那正是 TAPFIX3 / P3 更正掉的**方向反了的引证**：
      // `fc.maxFrameBytes` 只被用在**出站**物理信封/分片组装那一侧，官方**入站**读取器
      // （`ZCodeProtocolNdjsonConnection.onData`）是 `buffer += chunk; indexOf('\n')`，
      // **没有任何行长守卫**。也就是说"官方强制 1 MiB"这件事根本不存在。
      //
      // 所以这里**只陈述我们自己的事实**：这是本控制通道自设的策略界，取值多少，
      // 以及它是自选的保守界。**不再声称对齐任何外部实现的强制上限。**
      detail: `注入帧 ${bytes} 字节超过本通道自设的单行上限 ${MAX_INJECT_LINE_BYTES} 字节（自选保守界，不是对外部实现的强制上限）`
    };
  }
  return { ok: true, line, bytes };
}

/* -------------------------------------------------------------------------- */
/* 出站白名单                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 通道标识扫描的最大递归深度。
 *
 * 为什么必须有：TAPFIX 独立复审实测，一条**约 1.6 MB、嵌套约 2 万层**的控制帧会让
 * `collectChannelTokens` 的递归抛 `RangeError: Maximum call stack size exceeded`。
 * V8 默认栈（约 984 KB）在这种"每层一个 `walk` 帧"的形状上大约 1 万层就爆——而
 * `CONTROL_MAX_LINE_BYTES` 是 2 MiB，所以这条帧**在控制通道行长上限之内**，是能合法
 * 到达这里的。未加深度上限时这个 `RangeError` 会从 `socket.on('data')` 逃出去，
 * 杀掉 tap 进程，**连带杀掉桌面那条 app-server 会话**。
 *
 * 取 128：比真实注入帧的结构深度（`params` / `options` 之类，个位数到十几层）高一个
 * 数量级，又比爆栈阈值低 1～2 个数量级。**默认拒绝方向的性质不变**：深度被截断的帧
 * 拿不到通道标识，仍然走 `model_field_missing`（或新的 `frame_too_deep`）拒收。
 */
export const MAX_CHANNEL_SCAN_DEPTH = 128;

/**
 * 收集帧里所有"通道标识"取值。只认 `CHANNEL_FIELD_KEYS` 里的键，递归进入对象与
 * 数组，因此 `params`、`params.model`、`params.options[0].provider` 都能覆盖。
 *
 * 递归深度受 `MAX_CHANNEL_SCAN_DEPTH` 约束（见该常量的说明）。不设上限时深嵌套帧会
 * 抛 `RangeError`，异常会逃出 socket 处理器并杀掉整个 tap 进程。
 *
 * @param {unknown} frame
 * @returns {Array<{ field: string, value: string }>}
 */
export function collectChannelTokens(frame) {
  return scanChannelTokens(frame).tokens;
}

/**
 * 与 `collectChannelTokens` 同一个扫描，但额外报告**是否因为触到深度上限而提前截断**。
 * `truncated: true` 意味着"下面的内容我们没看过"，因此判定必须偏保守（拒收）而不是
 * 乐观放行。
 *
 * @param {unknown} frame
 * @returns {{ tokens: Array<{ field: string, value: string }>, truncated: boolean }}
 */
export function scanChannelTokens(frame) {
  /** @type {Array<{ field: string, value: string }>} */
  const out = [];
  let truncated = false;
  /**
   * @param {unknown} node
   * @param {string} path
   * @param {number} depth
   */
  const walk = (node, path, depth) => {
    if (depth > MAX_CHANNEL_SCAN_DEPTH) {
      truncated = true;
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      const at = path === '' ? key : `${path}.${key}`;
      if (CHANNEL_FIELD_KEYS.includes(key) && typeof value === 'string') {
        out.push({ field: at, value });
      } else {
        walk(value, at, depth + 1);
      }
    }
  };
  walk(frame, '', 0);
  return { tokens: out, truncated };
}

/**
 * 注入前的白名单判定。**默认拒绝**：拿不到通道标识（`model_field_missing`）、
 * 命中黑名单（`blocked_channel`）、或不是 `account:` 前缀（`channel_not_allowlisted`），
 * 三者都不得把帧写进子进程 stdin。
 *
 * 错误回执里只带字段路径与判定码；命中的取值仅在**恰好等于黑名单常量**时回显，
 * 其余情况一个字符都不回——避免调用方把自己的秘密塞进 `model` 再被回显。
 *
 * 扫描被深度上限截断（`scanChannelTokens().truncated`）时返回 `frame_too_deep`：
 * 那一段我们**没看过**，不能拿"在截断点之上找到的合法通道"去放行整个帧。
 *
 * @param {unknown} frame
 * @returns {{ ok: true, channel: string } | { ok: false, code: 'unparsable_frame' | 'frame_too_deep' | 'model_field_missing' | 'blocked_channel' | 'channel_not_allowlisted', field: string | null, matched: string | null, detail: string }}
 */
export function evaluateInjectPolicy(frame) {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return {
      ok: false,
      code: 'unparsable_frame',
      field: null,
      matched: null,
      detail: '注入帧必须是 JSON 对象'
    };
  }
  const scan = scanChannelTokens(frame);
  const tokens = scan.tokens;
  if (scan.truncated) {
    return {
      ok: false,
      code: 'frame_too_deep',
      field: null,
      matched: null,
      detail: `注入帧嵌套深度超过 ${MAX_CHANNEL_SCAN_DEPTH}，无法证明它全程走订阅通道`
    };
  }
  if (tokens.length === 0) {
    return {
      ok: false,
      code: 'model_field_missing',
      field: null,
      matched: null,
      detail: `注入帧未携带通道标识字段（${CHANNEL_FIELD_KEYS.join(' | ')}），无法证明它走订阅通道`
    };
  }
  for (const token of tokens) {
    const value = token.value.trim();
    if (BLOCKED_CHANNEL_IDS.includes(value)) {
      return {
        ok: false,
        code: 'blocked_channel',
        field: token.field,
        matched: value,
        detail: `${token.field} 命中付费通道黑名单，拒绝注入`
      };
    }
    if (!value.startsWith(ALLOWED_CHANNEL_PREFIX)) {
      return {
        ok: false,
        code: 'channel_not_allowlisted',
        field: token.field,
        matched: null,
        detail: `${token.field} 不是 ${ALLOWED_CHANNEL_PREFIX} 前缀的订阅通道，拒绝注入`
      };
    }
  }
  const first = tokens[0];
  return { ok: true, channel: first === undefined ? '' : first.value.trim() };
}

/* -------------------------------------------------------------------------- */
/* 子进程帧路由                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 子进程→父进程方向的单帧路由决策。
 *
 * 只有同时满足四条才回控制端：
 *  1. `id` 是**字符串**且落在 `TAP_ID_PREFIX` 命名空间内；
 *  2. 帧里**没有** `method`（即它是应答而不是请求——凭据请求是请求帧，结构性排除）；
 *  3. 帧里有 `result` 或 `error`（应答形状）；
 *  4. 该 id 在等待表里（未匹配 id 不交给任何控制端，也不猜测归属）。
 *
 * 其余一切（含桌面自己的流量、含凭据请求与凭据应答）一律 `forward_only`。
 *
 * @param {unknown} frame
 * @param {ReadonlySet<string>} pendingIds
 * @returns {{ kind: 'control_response', id: string } | { kind: 'forward_only', reason: 'namespace' | 'request_frame' | 'no_result' | 'unmatched' }}
 */
export function classifyChildFrame(frame, pendingIds) {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return { kind: 'forward_only', reason: 'namespace' };
  }
  const record = /** @type {Record<string, unknown>} */ (frame);
  const id = record['id'];
  if (!isNamespacedId(id)) {
    return { kind: 'forward_only', reason: 'namespace' };
  }
  if (typeof record['method'] === 'string') {
    return { kind: 'forward_only', reason: 'request_frame' };
  }
  if (!('result' in record) && !('error' in record)) {
    return { kind: 'forward_only', reason: 'no_result' };
  }
  if (!pendingIds.has(/** @type {string} */ (id))) {
    return { kind: 'forward_only', reason: 'unmatched' };
  }
  return { kind: 'control_response', id: /** @type {string} */ (id) };
}

/* -------------------------------------------------------------------------- */
/* 子进程 stdin 写入门                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 子进程 stdin 的**一次性写入门**。存在的原因是 P1 的最后一条补强要求：
 * "注入失败不得留下半写的 stdin"。
 *
 * ## 为什么需要一个门
 *
 * 注入帧是先由 `buildOfficialRequestLine` **整行构造好**、再一次性 `write` 出去的，
 * 我们从不增量拼接，因此正常路径上不存在"写了一半"的中间态。唯一的不确定来源是
 * `child.stdin.write(...)` **抛错**：抛错时那行可能已经有一部分进了 OS 管道，我们
 * **无法证明**写了多少。
 *
 * 此刻只有两种选择，两种都不会污染流：
 *  - 继续写下一帧 → 下一帧会拼在一条可能残缺的行后面，产生一条**永久畸形**的行。
 *    官方入站读取器只按 `\n` 切行、不校验行长（见 `MAX_INJECT_LINE_BYTES` 的依据
 *    说明），于是这条畸形行会被它当成一帧去解析——错误会一路漂到 app-server 逻辑层。
 *  - **永久冻结**：此后所有注入一律回 `child_unavailable`，一个字节都不再碰这条流。
 *
 * 选后者。代价是"子进程 stdin 坏了之后不能再注入"，收益是**流的状态永远可判定**：
 * 要么这条流上写过的每一行都是完整的，要么这条流上什么都没再写过。
 *
 * 它是纯逻辑闭包（无 fs / net / child_process / process 写入），因此可以被单测
 * 直接钉死；`zcode-stdio-tap.mjs` 的 `handleInject` 与 `onDestError` 共用同一个实例。
 *
 * @returns {{ readonly writable: boolean, markBroken: () => void }}
 */
export function createChildStdinGate() {
  let writable = true;
  return {
    get writable() {
      return writable;
    },
    /** 永久冻结这条流。幂等；冻结之后没有任何路径能把它解冻。 */
    markBroken() {
      writable = false;
    }
  };
}

/* -------------------------------------------------------------------------- */
/* NDJSON 旁路行扫描器                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 增量 NDJSON 行扫描器。**只用于旁路观察**：`push()` 收到的 chunk 与转发的 chunk
 * 是同一个 Buffer 引用，扫描器只从中拷走自己需要的行文本，绝不写回、绝不拼接、
 * 绝不影响转发路径的任何一个字节。
 *
 * 行内容去掉行终止符（`\n` 或 `\r\n`）。超过 `MAX_SCAN_LINE_BYTES` 后进入
 * `overflowed`：清空累积缓冲并跳到下一个 `\n` 重新同步——**只停观察**，转发照旧。
 */
export class NdjsonLineScanner {
  /** @type {string} */
  #pending = '';
  #overflowed = false;

  constructor() {
    this.#pending = '';
    this.#overflowed = false;
  }

  /** 当前是否有"停观察"发生（诊断计数用，不含内容）。 */
  get overflowed() {
    return this.#overflowed;
  }

  /**
   * @param {Buffer} chunk
   * @returns {string[]} 本次新形成的完整行（不含行终止符）
   */
  push(chunk) {
    const text = chunk.toString('utf8');
    this.#pending += text;
    /** @type {string[]} */
    const lines = [];
    let start = 0;
    for (;;) {
      const nl = this.#pending.indexOf('\n', start);
      if (nl < 0) break;
      let line = this.#pending.slice(start, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (this.#overflowed) {
        start = nl + 1;
        continue;
      }
      if (line.length > MAX_SCAN_LINE_BYTES) {
        // 单行超上界：记下"停观察"，这一行与之后的行都不再解析。转发一个字节都不少。
        this.#overflowed = true;
        start = nl + 1;
        continue;
      }
      lines.push(line);
      start = nl + 1;
    }
    this.#pending = start === 0 ? this.#pending : this.#pending.slice(start);
    if (this.#pending.length > MAX_SCAN_LINE_BYTES) {
      this.#pending = '';
      this.#overflowed = true;
    }
    return lines;
  }

  /**
   * 没有行终止符的尾段。**不因为尾段没有换行就丢弃**——官方 NDJSON 的最后一帧可能
   * 就没有换行，观察器必须看到它。
   *
   * @returns {string[]}
   */
  flush() {
    if (this.#overflowed || this.#pending.length === 0) {
      this.#pending = '';
      return [];
    }
    const rest = this.#pending.endsWith('\r') ? this.#pending.slice(0, -1) : this.#pending;
    this.#pending = '';
    return rest.length === 0 ? [] : [rest];
  }
}

/* -------------------------------------------------------------------------- */
/* 回环判定                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 判断对端地址是否在回环内。控制通道虽然只绑 `127.0.0.1`，仍逐连接复核一次：
 * 绑定是"我们只收本地连接"，复核是"即便有连接进来也必须是本地"。
 *
 * @param {string | undefined} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false;
  if (address === '::1' || address === '::ffff:127.0.0.1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (m === null) return false;
  const octets = [m[1], m[2], m[3], m[4]];
  if (octets.some((part) => part === undefined || Number(part) > 255)) return false;
  return Number(octets[0]) === 127;
}

/* -------------------------------------------------------------------------- */
/* 子进程环境                                                                  */
/* -------------------------------------------------------------------------- */

/** 不传给子进程的控制通道变量。控制令牌绝不下发给 app-server。 */
export const CONTROL_ENV_KEYS = Object.freeze(['ZCC_TAP_TOKEN', 'ZCC_TAP_TOKEN_FILE']);

/**
 * 构造子进程环境：以 tap 自己的环境为基底（官方在无 tap 时就是把同一份
 * `sanitizeZCodeRuntimeEnv(process.env)` 交给 app-server，所以基底一致才等于
 * "与没有 tap 时完全一致"），删掉控制通道变量，其余**原样**保留。
 *
 * `ELECTRON_RUN_AS_NODE` 被父进程传进来就必须原样透传——桌面 spawn 真实 app-server
 * 时它同样带着这个变量。这里只做"保留/透传"，不凭空伪造。
 *
 * @param {Readonly<Record<string, string | undefined>>} ownEnv
 * @returns {Record<string, string>}
 */
export function buildChildEnv(ownEnv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(ownEnv)) {
    if (value === undefined) continue;
    if (CONTROL_ENV_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 控制令牌解析                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{ ok: true, token: string, source: 'env' | 'file' }
 *   | { ok: false, code: 'token_missing' | 'token_too_short' | 'token_malformed' }} ControlTokenResult
 */

/**
 * 令牌形状校验。拒绝空白/控制字符，避免令牌里出现换行导致协议错位。
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isUsableControlToken(token) {
  if (token.length < MIN_CONTROL_TOKEN_CHARS) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\s\u0000-\u001f\u007f]/u.test(token);
}

/**
 * 控制令牌解析。**没有令牌就不开控制通道**，不存在任何写死的默认值。
 *
 * 顺序：环境变量 `ZCC_TAP_TOKEN` → 环境变量/配置给出的令牌文件。环境变量优先，
 * 因为它更明确、更好审计；文件是"桌面 spawn 时不透传自定义环境变量"时的退路
 * （官方 spawn 走 `sanitizeZCodeRuntimeEnv`，自定义变量能透传，但当前已在运行的
 * 桌面进程没有这个变量，而本轮不许重启它）。
 *
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string | null} tokenFilePath
 * @param {string | null} fileContent
 * @returns {ControlTokenResult}
 */
export function resolveControlToken(env, tokenFilePath, fileContent) {
  const fromEnv = env['ZCC_TAP_TOKEN'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return isUsableControlToken(fromEnv)
      ? { ok: true, token: fromEnv, source: 'env' }
      : { ok: false, code: 'token_too_short' };
  }
  if (tokenFilePath === null || fileContent === null) {
    return { ok: false, code: 'token_missing' };
  }
  const trimmed = fileContent.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: 'token_missing' };
  }
  return isUsableControlToken(trimmed)
    ? { ok: true, token: trimmed, source: 'file' }
    : { ok: false, code: 'token_too_short' };
}

/* -------------------------------------------------------------------------- */
/* 诊断字段净化（约束 2 的结构化实现）                                          */
/* -------------------------------------------------------------------------- */

/**
 * 诊断字段白名单。**只有这些键能离开 tap**。任何与内容有关的键（frame / params /
 * message / text / body / model / token / secret / id …）都不在里面，因此写日志
 * 时"忘了脱敏"这种错误在结构上不可能发生——键根本过不了这一关。
 */
export const DIAG_FIELD_ALLOWLIST = Object.freeze([
  'event',
  'at',
  'pid',
  'ppid',
  'exitCode',
  'signal',
  'phase',
  'result',
  'code',
  'bytes',
  'bytesToParent',
  'bytesToChild',
  'stderrBytes',
  'scannedLines',
  'unmatchedFrames',
  'controlConnections',
  'connectionId',
  'controlPort',
  'tokenSource',
  'droppedFields',
  'overflowed',
  'durationMs',
  'uptimeMs'
]);

/** 诊断字段名的最大长度：即便键在白名单里，值也必须有长度上限才准出。 */
export const DIAG_MAX_VALUE_CHARS = 64;

/**
 * 净化诊断字段：键不在白名单 → 丢弃并计数；值不是原语 → 丢弃并计数；字符串超过
 * `DIAG_MAX_VALUE_CHARS` → 丢弃并计数。**返回的字段里不可能出现帧内容。**
 *
 * @param {Readonly<Record<string, unknown>>} fields
 * @returns {{ safe: Record<string, string | number | boolean | null>, dropped: number }}
 */
export function sanitizeDiagFields(fields) {
  /** @type {Record<string, string | number | boolean | null>} */
  const safe = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (!DIAG_FIELD_ALLOWLIST.includes(key)) {
      dropped += 1;
      continue;
    }
    if (value === null) {
      safe[key] = null;
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        dropped += 1;
        continue;
      }
      safe[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      safe[key] = value;
      continue;
    }
    if (typeof value === 'string' && value.length <= DIAG_MAX_VALUE_CHARS) {
      safe[key] = value;
      continue;
    }
    dropped += 1;
  }
  return { safe, dropped };
}
