/**
 * 官方 app-server 的**同形替身**（常驻测试夹具）。
 *
 * ## HOSTFIX5：形态从"被 require 的模块"改成"被 spawn 的进程"
 *
 * 上一版替身伪装的是"一个被 `createRequire` 加载的 CommonJS 模块"——它导出官方那三个
 * 同形符号（`createZCodeApp` / `startProcessProviderRegistryRuntime` /
 * `runZCodeProtocolAgent`），`host-child.mjs` 在同进程里 require 它。
 *
 * **那条路在实弹里被证伪**：官方 `C:\ZCode\resources\glm\zcode.cjs` **没有任何具名导出**
 * （`exports.createZCodeApp` / `exports.runZCodeProtocolAgent` /
 * `exports.startProcessProviderRegistryRuntime` 全文各 0 命中；仅有的两处 `module.exports`
 * 是内部库 shim）。所以 `require` 拿导出这条路不存在，`BUNDLE_EXPORTS_INCOMPLETE` 是
 * 必然失败而不是偶发。
 *
 * 现在替身与真实生产路径**同形态**：它是一个**独立进程**，被
 * `node <this-file> app-server --stdio --surface desktop` 拉起来，
 * **从 `process.stdin` 读请求、往 `process.stdout` 写应答**。
 * 这与 `scripts/verify-runtime.mjs` 的 I02 探针、r1–r4 捕获、STANDALONE_PROBE
 * 是**同一条 argv**（本文件顶部有 `%TEMP%` 零发送冒烟的实测记录，见工单报告）。
 *
 * ## 它做什么、不做什么
 *
 * **做**：监听 stdin 上的 NDJSON 请求帧、按官方形状把应答写回 stdout、发两条官方形状的
 * **反向请求**（`session/requestRuntimePreferences` 与
 * `interaction/requestProviderRuntimeHeaders`）并**闸门化**（只有合格应答才放行 turn 事件）、
 * 把观测写进 `ZCC_STUB_OBSERVATION_FILE` 指定的 JSON 文件、
 * 在启动时自发吐官方那 5 条 `startup/storageState` **通知**（无 id）。
 *
 * **不做**：不加载任何官方代码、不触网、不读任何真实凭据仓、不发任何模型请求。
 * 它是一个**纯本地、纯进程**的协议对端。
 *
 * ## 为什么它必须是常驻夹具而不是一次性脚本
 *
 * `session-drive.mjs` 的**流接线**（请求进子进程 stdin、应答从子进程 stdout 读）接反过一次，
 * 那是一个 100% 失败的真 bug。**静态单测抓不到它**，纯函数单测在原理上也不可能抓到。
 * 只有让一个**同形替身**经真实 spawn 路径被拉起、并让它同时观测**两条方向**，
 * 才能把"接反"变成一条 CI 恒红的断言。
 *
 * ## HOSTFIX5 的方向断言怎么表达（B1 等价防护）
 *
 * stdio 形态下"接反"是：**请求写进子进程的 stdout、应答从子进程的 stdin 读**。
 * 两个方向各有一条观测，各有一条断言：
 *
 *  - `readFromStdin` / `parsedMethodsFromStdin`：驱动写进 stdin 的帧。
 *
 * **HOSTFIX5 更正了一条设计错误**：旧形态（内存 PassThrough）下"接反"能被替身**从自己
 * 那条应答流上看到**——因为那条流是双向的流对象，别人往它写，本进程就收得到 `data`。
 * stdio 形态下**做不到**：替身的 stdout 是**只写**的管道，别人往这条管道写，字节流向
 * **host-child**，替身自己**收不到**。所以旧版的 `readFromOutput`（以及它的改名
 * `readFromStdout`）在 stdio 形态下是一条**恒真的空断言**——它只能证明"没有人往我的
 * stdout 写"，而这件事在结构上就不可能发生。
 *
 * **接反在 stdio 形态下的真实可观测形状**（这才是现在钉住的那一条）：
 * > 驱动把请求写进子进程的 stdout、从子进程的 stdin 读应答 ⟹ **替身的 stdin 一个字节都收不到**。
 * 也就是说接反**退化成"子进程什么都没收到"**，可观测面是
 * `readFromStdin.length === 0` / `parsedMethodsFromStdin` 为空 / 会话不推进。
 * 端到端用例就钉这一条（`tests/unit/official-host-stub-bundle.test.mjs` 的
 * `**B1 方向（等价防护）**`），并已用变异体实测：把两条流一交换，该用例立刻红。
 *
 * 观测文件（由测试经 env 指定到临时目录）结构：
 * ```
 * {
 *   "invokedAs": "program" | "module",
 *   "entryPath": "…/official-host-stub-bundle.cjs",
 *   "argv": ["app-server", "--stdio", "--surface", "desktop"],
 *   "standaloneEnvKeys": [],
 *   "readFromStdin":  ["<raw chunk>"],  // 驱动写进来的原始文本（**已脱敏**）
 *   "parsedMethodsFromStdin": [...],
 *   "startupNotificationsSent": 2,
 *   "didReceiveSessionCreate": false,
 *   "stdinClosed": false,
 *   "childEnv": { …所有被观测的 env 键… },
 *   "ymrError": null | "…",
 *   "builtinRevision": "zcode-builtin:<rev>:<sha256(resolve(activePath))>" | null,
 *   "providerRuntimeHeadersRequestSent": false,
 *   …
 * }
 * ```
 *
 * ## HOSTFIX3：反向请求闸门（凭据那条）
 *
 * 官方真正跑会话的 app，其 port 恒为缺省 `ZJo`（`createProviderRuntimeHeadersPort`），
 * 它逐字 `e.requestClient(va.interactionRequestRuntimeHeaders, …, DGt, …)`，
 * 而 `pTt.requestClient` 逐字把帧写到 `messageSink` → `fTt.send` → **应答流（stdout）**。
 * 而 stdout 正是驱动在读的那条流。
 *
 * 所以替身在这里**逐字复刻官方**：收到 `session/send` 之后先**不发** turn 事件，
 * 而是往 stdout 写一帧 `interaction/requestProviderRuntimeHeaders`，**只有**收到
 * `{id, result:{headersApplied:true, requestAuth:{apiKey}}}` 才放行 turn。
 * 于是"闸门真的接上了"从推断变成一条可观测的时序。
 *
 * ## HOSTFIX4：`session/requestRuntimePreferences` 闸门（**更靠前、更致命**）
 *
 * 官方在**每一次** `session/create` 的关键路径上都会发这条（逐字链路）：
 *
 * ```
 * jKo @14479718 → UKo @14479962 → ERn @14511145 → CXa @14510354
 *   → CKo @14509003  await e.requestClient("session/requestRuntimePreferences",
 *                                         {sessionId, scope}, pGt, {timeoutMs: 15e3})
 *   → catch: 只对 -32601 / -32020 返回默认对象，其余 throw l   ← -32022 走 throw
 * ```
 *
 * 关键在 `UKo` 里 `await ERn(...)` 那一行**在 `try` 之外**：不答 → 15 秒后 `-32022`
 * 被 rethrow → `session/create` **不返回 sessionId**。所以替身逐字复刻这条的**时序**：
 *
 *  - 收到 `session/create` 之后**先不发** `session/create` 的回执，而是发偏好请求；
 *    记 `sessionCreateResponseHeldForPreferences = true`。
 *  - **只有**收到逐字通过官方 `pGt` 校验的应答，才补发 `session/create` 的回执。
 *  - 拿不到合格应答就**永远不发**那个回执（官方会 `throw`，不回 sessionId）。
 *
 * 于是"turn 事件出现了"现在要求**两道闸门都过**：
 * `session/requestRuntimePreferences` 与 `interaction/requestProviderRuntimeHeaders`。
 *
 * 替身对 `pGt` 的校验是**逐字**的（偏移 759339）：
 * `pGt=m.object({nativeSearchEnhancementsEnabled:m.boolean(),memoryEnabled:m.boolean().default(!1),askUserQuestionAutoResolutionEnabled:m.boolean().default(!0),integratedTerminalShell:aYe.optional(),modelContextBudgetStrategy:Bsr.default(WO)}).strict()`
 * ——即 **`.strict()`（多一个键就非法）+ `nativeSearchEnhancementsEnabled` 必填布尔**。
 * 替身**只校验形状**（官方 `pGt.parse` 的语义），**不校验具体取值**：
 * 取值由 `tests/unit/official-host-reverse-responder.test.mjs` 逐字段钉。
 */
'use strict';

const { writeFileSync, writeSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

/**
 * HOSTFIX6（B-1）：启动时往 **stderr** 灌多少字节。**缺省 0 = 不灌。**
 *
 * 复审 §3.4 的 A/B 实测证明：宿主不 drain 时，写 8/32/64 KB 首帧照样到，
 * 写 200/1000 KB **永不到达**（子进程卡在 stderr 写上）。本替身逐字复刻那条曲线。
 *
 * **刻意用 `writeSync(2, …)` 而不是 `process.stderr.write`**：后者在 Node 里是
 * 异步的，管道读端没人读时它只是把数据堆进**本进程内存**的流缓冲，进程**不会**阻塞
 * ——那样就复现不出"卡在 stderr 写上"这个症状了。`writeSync` 是真同步写 fd，
 * 管道缓冲一满就真的把本进程钉在那儿，与真实进程被写爆的 stderr 表现同构。
 *
 * 灌完之后替身**照常**继续发启动通告与响应会话——所以"drain 存在"与"drain 不存在"
 * 之间的差别，就是"会话跑完"与"会话挂死"的差别。
 */
const STDERR_FLOOD_BYTES = Number.parseInt(process.env.ZCC_STUB_STDERR_BYTES || '0', 10) || 0;

/** 观测文件路径。由测试经 env 指定。**不指定就不落盘**（防止误写工程目录）。 */
const OBSERVATION_FILE = process.env.ZCC_STUB_OBSERVATION_FILE || '';

/**
 * 官方 `va` 枚举里那条反向请求的字面量（产物内偏移 787197 逐字）。
 *
 * **这里刻意硬写而不是 import**：替身是 CommonJS 常驻夹具，而应答器是 `.mjs`。
 * 两边若漂移，端到端用例会立刻红（驱动认不出这帧 → 闸门不放行 → 无 turn 事件）。
 */
const AUTH_REQUEST_METHOD = 'interaction/requestProviderRuntimeHeaders';

/**
 * 官方 `va` 枚举逐字（偏移 784446）
 * `sessionRequestRuntimePreferences:"session/requestRuntimePreferences"`。
 *
 * 同样**刻意硬写**：与上面那条同理由，两边漂移会让端到端用例立刻红。
 */
const PREFERENCES_REQUEST_METHOD = 'session/requestRuntimePreferences';

/**
 * COMPAT1/C4：官方 `va` 枚举里那两条反向请求的字面量。逐字（偏移 787107 / 787167，
 * 与 `interactionRequestProviderRuntimeHeaders` 同处一个字面量对象）：
 * ```
 * interactionRequestPermission:"interaction/requestPermission",
 * interactionRequestUserInput:"interaction/requestUserInput",
 * ```
 *
 * 同样**刻意硬写**：与上面两条同理由，两边漂移会让端到端用例立刻红
 * （驱动认不出这帧 → 不答 → 替身这两道闸门不放行 → 无 turn 事件）。
 */
const PERMISSION_REQUEST_METHOD = 'interaction/requestPermission';
const USER_INPUT_REQUEST_METHOD = 'interaction/requestUserInput';

/**
 * 官方 `jZe`（偏移 650899）逐字 `m.enum(["allow","deny","escalate","modify"])`。
 *
 * 官方 `JL`（偏移 650914）逐字：
 * ```
 * jZe=m.enum(["allow","deny","escalate","modify"]),
 * Jrr=m.enum(["allow","deny","ask"]),
 * Krr=m.object({toolName:Ru,ruleContent:m.string().optional()}).strict(),
 * BZe=m.object({type:m.literal("addRules"),behavior:Jrr,rules:m.array(Krr).min(1)}).strict(),
 * JL=m.object({decision:jZe,reason:m.string().optional(),
 *             modifiedInput:m.unknown().optional(),permissionUpdates:m.array(BZe).optional()}).strict()
 * ```
 * `.strict()` —— **未知键一律非法**。这正是替身能抓"我们多发了一个键"的唯一依据。
 */
const PERMISSION_RESULT_FIELDS = ['decision', 'reason', 'modifiedInput', 'permissionUpdates'];
const PERMISSION_DECISIONS = ['allow', 'deny', 'escalate', 'modify'];

/**
 * 官方 `CYe`（偏移 768638）逐字：
 * `m.object({action:m.enum(["accept","decline","cancel"]),content:$x.optional(),reason:m.string().optional()}).strict()`
 * 其中 `$x`（偏移 732375）逐字 `m.record(m.string(), m.unknown())`。
 */
const USER_INPUT_RESULT_FIELDS = ['action', 'content', 'reason'];
const USER_INPUT_ACTIONS = ['accept', 'decline', 'cancel'];

/**
 * COMPAT1/C4：让替身在凭据闸门放行之后额外发一条 `interaction/requestPermission`
 * （逐字复刻官方 `WZa` → `permissionBroker.requestPermission`）。缺省空 = 不发。
 *
 * **为什么需要它**：`session/create` 的 `mode:"yolo"` 让官方对**普通**工具不再发这条
 * （`checkPermission` 逐字 `this.allow(t,a,"mode.yolo",…)`），但 `requiresUserInteraction`
 * 与 `alwaysAsk` 两类能力**先于** mode 判定 `return this.ask(...)`。所以
 * "yolo + 无反向应答器"这个组合**仍然**会挂 300 s——这正是替身要复现的形状。
 */
const ASK_TOOL_PERMISSION = process.env.ZCC_STUB_ASK_TOOL_PERMISSION || '';

/** COMPAT1/C4：让替身额外发一条 `interaction/requestUserInput`（官方 `HZa` 形状）。缺省空 = 不发。 */
const ASK_USER_INPUT = process.env.ZCC_STUB_ASK_USER_INPUT || '';

/**
 * **反向开关**：把驱动答上来的权限 / 用户输入应答**丢掉**。
 *
 * 与 {@link SWALLOW_PREFERENCES_RESPONSE} 同一档理由：用来在**不动生产代码**的前提下
 * 复现"驱动没接这条反向请求"的行为，证明替身这两道闸门是真的。
 */
const SWALLOW_TOOL_INTERACTION_RESPONSE = process.env.ZCC_STUB_SWALLOW_TOOL_INTERACTION_RESPONSE || '';

/**
 * **反向开关**：把权限应答的 result 改成形状不合法的形态。
 * 取值 `'missing-decision'` / `'extra-key'`；留空 = 正常。
 */
const FORCE_PERMISSION_SHAPE = process.env.ZCC_STUB_FORCE_PERMISSION_SHAPE || '';

/** **反向开关**：把用户输入应答的 result 改成形状不合法的形态。留空 = 正常。 */
const FORCE_USER_INPUT_SHAPE = process.env.ZCC_STUB_FORCE_USER_INPUT_SHAPE || '';

/**
 * 官方 `pGt` 的**全部**字段名（偏移 759339，跨度 759339..759588）。`.strict()` 之下的全集。
 */
const PREFERENCES_RESULT_FIELDS = [
  'nativeSearchEnhancementsEnabled',
  'memoryEnabled',
  'askUserQuestionAutoResolutionEnabled',
  'integratedTerminalShell',
  'modelContextBudgetStrategy'
];

/** 官方 `Bsr`（偏移 759301）逐字 `m.enum(["legacy","preflight-v1"])`。 */
const PREFERENCES_BUDGET_STRATEGIES = ['legacy', 'preflight-v1'];

/**
 * 让替身发哪几个 `scope` 的偏好请求。缺省只有 `runtime-materialization`
 * （`CXa` 里 eager、在 `session/create` 关键路径上的那一条）。
 *
 * 测试可以经 env 追加 `user-execution`（`CXa` 里 lazy、只在解析初始 bash shell 时发的那条），
 * 用来证明驱动对**两个 scope 都应答**。逗号分隔。
 */
const PREFERENCES_SCOPES = (process.env.ZCC_STUB_RUNTIME_PREFERENCES_SCOPES || 'runtime-materialization')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');

/**
 * **反向**开关：把驱动答上来的 `session/requestRuntimePreferences` 应答**丢掉**。
 *
 * 用来在**不动生产代码**的前提下复现"HOSTFIX3 之前的行为"（一条反向请求都不答），
 * 证明替身这道闸门是真的：应答被吞 → 官方回执永不发 → 拿不到 sessionId → 无 turn 事件。
 * 与 `ZCC_STUB_FORCE_PREFERENCES_SHAPE` 一样，**默认空 = 全部关着**。
 */
const SWALLOW_PREFERENCES_RESPONSE = process.env.ZCC_STUB_SWALLOW_RUNTIME_PREFERENCES_RESPONSE || '';

/**
 * **反向**开关：把驱动答上来的偏好 result 的第一个键改名成一个 `pGt` 之外的键。
 *
 * 官方 `pGt` 是 `.strict()`（偏移 759339），未知键会让整条 parse 失败、
 * `pGt` 的 `parse` 抛错 → `CKo` 的 catch 落进 `throw l` → 同样拿不到 sessionId。
 * 这条开关让端到端用例能验证"**形状不合格也绝不放行**"。
 *
 * 取值 `'unknown-key'` = 把第一个键换成 `'notAFieldOfPGt'`。
 * 取值 `'missing-required'` = 删掉唯一必填的 `nativeSearchEnhancementsEnabled`。
 * 取值 `'extra-key'` = 三个键全对，只多加一个 `pGt` 之外的键（**只有 `.strict()` 能抓**）。
 */
const FORCE_PREFERENCES_SHAPE = process.env.ZCC_STUB_FORCE_PREFERENCES_SHAPE || '';

/**
 * **反向**开关（HOSTFIX6）：收到某个 method 的请求帧之后**立刻 `process.exit(9)`**。
 *
 * 用来让"驱动等一个**永远不会来**的回执"这条失败路径**快速**收束：
 * 官方 app-server 提前退出 ⟹ 驱动的 `outboundDone` 落定 ⟹ `driveSession` 立刻抛
 * （`session/create` 阶段就是 `SESSION_CREATE_NO_SESSION_ID`），而不是空转到
 * 300 s 墙钟上限。测的分支与"挂满 300 s"完全同一条，只是**不花 300 s**。
 *
 * 留空 = 正常服务（本替身不自己退）。
 */
const EXIT_AFTER_METHOD = process.env.ZCC_STUB_EXIT_AFTER_METHOD || '';

/**
 * **HOSTFIX6**：额外发一条**官方真实**的会话事件类型（`ZCC_STUB_EMIT_OFFICIAL_EVENT_TYPE`）。
 *
 * 用途：让"我们没接住官方事件"这条失败在测试里**真的发生一次**，
 * 从而证明 {@link DriveSessionPartialSummary.unmappedOfficialEventTypes}
 * 不是一条恒真的空断言。留空 = 不发。
 */
const EMIT_OFFICIAL_EVENT_TYPE = process.env.ZCC_STUB_EMIT_OFFICIAL_EVENT_TYPE || '';

/**
 * **反向**开关（HOSTFIX6）：对 `provider/updateAccountConfig` 回一条**错误应答**。
 *
 * 逐字复刻 2026-10-01 实弹第二轮官方回我们的那一条（`-32603` + `data.name = "ZodError"`），
 * 用来证明驱动**毫秒级**失败化，而不是把这条错误应答当普通行丢掉、空转到 300 s 墙钟上限。
 *
 * 取值 `'zod'`（默认形状：ZodError 逐字同构）/ `'timeout'`（`-32022` 形状）。
 * 留空 = 正常应答。
 */
const REJECT_ACCOUNT_CONFIG = process.env.ZCC_STUB_REJECT_ACCOUNT_CONFIG || '';

/**
 * **反向**开关（HOSTFIX6）：对 `session/create` 回一条错误应答。
 *
 * 逐字复刻官方 `Provider Registry 中不存在 Model` 那条路径的外形（`-32018`）。
 * 与上面那条配对使用，就能把"挂在 create 阶段"和"挂在账号阶段"分开观测。
 */
const REJECT_SESSION_CREATE = process.env.ZCC_STUB_REJECT_SESSION_CREATE || '';

/**
 * 造一条 JSON-RPC 错误应答（官方 `Hir = {id, error}`）。
 * @param {any} id
 * @param {{ code: number, message: string, zod?: boolean }} shape
 */
function replyError(id, shape) {
  reply(
    shape.zod === true
      ? {
          id,
          error: {
            code: shape.code,
            data: { name: 'ZodError', stack: 'ZodError: [...]\n    at parseAccountProviderConfigMap (synthetic)' },
            message: shape.message
          }
        }
      : { id, error: { code: shape.code, message: shape.message } }
  );
}

/** 观测通道里的凭据占位符。**替身自己在落盘前就把 apiKey 换掉**。 */
const REDACTED = '[zcc-stub-redacted]';

/**
 * 让替身为**别的** providerId 发反向请求（测跨通道挪用闸门）。测试经 env 指定。
 * 留空 = 用 `session/create` 里那个真实 providerId。
 */
const FORCE_AUTH_REQUEST_PROVIDER_ID = process.env.ZCC_STUB_AUTH_REQUEST_PROVIDER_ID || '';

/** 会话 ID。固定值，便于测试断言"确实拿到了官方回报的 sessionId"。 */
const SESSION_ID = 'stub-session-0001';

/**
 * **HOSTFIX7 反向开关**：默认 `'1'`（照官方 `kXa` 的 `!t.deliveryKind → return`
 * 闸门工作，没订阅就不发事件）。置 `'0'` 放行，用来证明"缺订阅 ⟹ 官方一个字都不发"。
 */
const REQUIRE_SUBSCRIBE = (process.env.ZCC_STUB_REQUIRE_SUBSCRIBE || '1') !== '0';

/** 本进程有没有收到过一条合格（闭集内 `deliveryKind`）的 `session/subscribe`。 */
let subscribed = false;

/**
 * **HOSTFIX7 反向开关**：对 `session/subscribe` 回一条**错误应答**（`-32602`）。
 *
 * 用来证明驱动在订阅这一步**毫秒级失败化**，而不是"订阅没成功也照样往下跑、
 * 最后拿 300 s 墙钟上限报一个 `SESSION_TIMEOUT`"——那正是 HOSTFIX6 踩过的形态。
 */
const REJECT_SUBSCRIBE = process.env.ZCC_STUB_REJECT_SUBSCRIBE || '';

/**
 * **HARDEN1 · 根因 2+3 的第二钉**：在**会话中途**（订阅已生效、`session/send` 已被受理、
 * 已经发出几段正文增量之后）回一条**属于 `session/send` 那个 id 的错误应答**，并且
 * **不发** `turn.completed`。
 *
 * ## 为什么必须是"中途"而不是"受理时"
 *
 * 受理时就拒的那条由 `ZCC_STUB_REJECT_*` 系列覆盖；中途这条测的是**另一件事**：
 * 驱动已经进入 turn 消费循环、已经产出了真实增量，此时官方那条 `{id,error}` 帧
 * **必须**被当成失败而不是"又一条普通行"。若它被丢掉，驱动既等不到终态事件
 * （本开关刻意不发 `turn.completed`），又不会空转到测试的墙钟上限之外——
 * 只会一路转到 `SESSION_TIMEOUT`，即**把一次毫秒级拒绝伪装成一次慢响应**。
 * 那正是 HOSTFIX6 根因 2（错误应答被丢弃）+ 根因 3（`settle` 唤醒条件错）的同构形状。
 *
 * 取值：JSON-RPC **code**（如 `'-32603'`）。非数字一律按 `-32603` 处理。
 * 留空 = 正常发完 `turn.completed`。
 */
const REJECT_SESSION_SEND_LATE_RAW = process.env.ZCC_STUB_REJECT_SESSION_SEND_LATE || '';
const REJECT_SESSION_SEND_LATE = REJECT_SESSION_SEND_LATE_RAW === '' ? null : REJECT_SESSION_SEND_LATE_RAW;
const REJECT_SESSION_SEND_LATE_CODE = (() => {
  const parsed = Number.parseInt(REJECT_SESSION_SEND_LATE_RAW, 10);
  return Number.isFinite(parsed) ? parsed : -32603;
})();
const REJECT_SESSION_SEND_LATE_MESSAGE = 'Provider Runtime Headers 回合中途被上游中止';

/** `session/send` 那个请求的 id（中途那条错误应答必须挂在它上面）。 */
/** @type {any} */
let sessionSendRequestId = null;

/* -------------------------------------------------------------------------- */
/* HOSTFIX7：实弹逐字的正文 / usage 常量                                        */
/* -------------------------------------------------------------------------- */

/**
 * ## 这三个常量全部来自**实弹**，不是编的
 *
 * 出处：`%TEMP%\zcode-companion-hostfix6-20261001`（官方隔离存储目录，只读保留）
 *  - 正文：官方 app-server 自己的 SQLite `part` 表 `data` 列逐字；
 *  - usage：同库 `model_usage.raw_usage_json` 逐字
 *    （`{"inputTokens":27285,"outputTokens":35,"totalTokens":27320,"cacheReadTokens":0,"cacheWriteTokens":0}`，
 *    `query_source = "main_turn"`、`finish_reason = "stop"`、`provider_metadata_json.rawFinishReason = "end_turn"`）；
 *  - 分段：官方日志 `model.sdk.stream.completed` 的 `chunkCounts.textDelta = 33`、
 *    `textDeltaChars = 56`，与上面那段正文的长度**逐字相符**。
 *
 * 官方日志里 `usage.inputTokens` 等显示为字面量 `"[Redacted]"`——那是**官方自己**的
 * 日志脱敏；它持久化到 SQLite 与事件 payload 里的数字是完好的，所以这里取后者。
 *
 * **零凭据**：全是模型 token 计数与模型答复正文，不含 key / header / 账号标识。
 */

/** 实弹正文逐字（56 字符，与官方 `textDeltaChars = 56` 相符）。 */
const REAL_SHOT_RESPONSE_TEXT =
  '主上，我是 ZCode，一个交互式编程助手，可以读写文件、执行命令、搜索代码与联网调研，帮助您完成软件工程任务。';

/** 实弹 assistant message / part id（官方 `part` 表逐字形状，值取实弹同构）。 */
const REAL_SHOT_ASSISTANT_MESSAGE_ID = 'msg_mupi3e8e_d0ec6497-e565-41dc-8ca9-96ed1e64a57a';
const REAL_SHOT_PART_ID = 'prt_mupi3ivh_d46d3c02-481e-4720-a1b4-64da670b3e70';

/**
 * 实弹 usage 逐字，取自官方 `Jgr`（产物偏移 1228437）聚合 `model_complete` 后的形状：
 * `{source, modelRequestCount, inputTokens, outputTokens, totalTokens,
 *   cacheReadTokens, cacheWriteTokens, reasoningTokens, webFetchRequests, webSearchRequests}`。
 * 数值与 `model_usage.raw_usage_json` 逐字一致。
 */
const REAL_SHOT_USAGE = Object.freeze({
  source: 'provider',
  modelRequestCount: 1,
  inputTokens: 27285,
  outputTokens: 35,
  totalTokens: 27320,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  webFetchRequests: 0,
  webSearchRequests: 0
});

/**
 * 把实弹正文切成 **33 段**（官方逐字 `chunkCounts.textDelta = 33`），
 * 拼回去**逐字等于** {@link REAL_SHOT_RESPONSE_TEXT}。
 *
 * 为什么要 33 段而不是一段：官方对 `model.streaming` 有自己的合批
 * （`RKo`/`DKo`：同 `batchKey` 的连续 `text_delta` 会按 `maxChars` 或 250 ms 刷出，
 * 偏移 14468671 / 14469629），真实一轮**从来不是**一条大 delta。
 * 用 33 段让端到端用例覆盖"多帧拼接"的真实形状，而不是"一帧就完"的乐观形状。
 *
 * @type {readonly string[]}
 */
const REAL_SHOT_TEXT_DELTAS = Object.freeze(splitIntoChunks(REAL_SHOT_RESPONSE_TEXT, 33));

/**
 * 把字符串切成**恰好 `count` 段**（每段非空），**逐字无损**。
 *
 * 余数均匀摊到前若干段：56 字切 33 段 = 23 段 2 字 + 10 段 1 字。
 * `count >= 长度` 时退化为逐字符（段数就是长度）。
 *
 * @param {string} text
 * @param {number} count
 * @returns {string[]}
 */
function splitIntoChunks(text, count) {
  if (count <= 1) return [text];
  const segments = Math.min(count, text.length);
  const per = Math.floor(text.length / segments);
  const extra = text.length - per * segments;
  /** @type {string[]} */
  const out = [];
  let at = 0;
  for (let i = 0; i < segments; i += 1) {
    const width = per + (i < extra ? 1 : 0);
    out.push(text.slice(at, at + width));
    at += width;
  }
  return out;
}

/**
 * 构造 `session/create` 的**成功应答**。
 *
 * ## HOSTFIX6：形状改成**实弹逐字**的那一份
 *
 * 替身原先回的是 `{result:{sessionId, mode:'agent'}}`——那是**照着我们的驱动写的**，
 * 不是照着官方写的，于是把一个**错的假设**钉进了 CI。实弹（2026-10-01，直连探针逐字）证明
 * 官方真正回的是：
 *
 * ```
 * {"id":"…","result":{
 *    "messages":[], "projection":{…,"sessionId":"unknown",…},
 *    "protocol":{…}, "runtime":{…},
 *    "session":{"createdAt":…,"mode":"build","model":{…},"sessionId":"sess_…",…},
 *    "settings":{…}}}
 * ```
 *
 * 两条要害：**真 sessionId 在 `result.session.sessionId`（四层深）**；
 * **`projection.sessionId` 是字面量 `"unknown"` 的诱饵**。替身照抄这两条，
 * 端到端用例才能真正证明驱动认的是官方那份形状。
 * 这也正是 W12 记过的那个坑的同型：mock 硬编码了与真实行为**正好相反**的东西。
 *
 * @param {{ providerId: string, modelId: string }} model
 * @returns {Record<string, unknown>}
 */
function buildSessionCreateResult(model) {
  const now = Date.now();
  return {
    messages: [],
    projection: {
      activeToolCalls: [],
      backgroundJobs: [],
      contextUsed: 0,
      contextWindow: 200000,
      mode: 'build',
      pendingPermissions: [],
      // **诱饵，逐字照抄官方**：真 sessionId 在 `session.sessionId`，不在这里。
      sessionId: 'unknown',
      status: 'idle',
      target: null,
      totalTokenCount: 0,
      turnCount: 0
    },
    protocol: { name: 'ZCode Protocol', version: 1 },
    runtime: { eventSeq: 0, pendingRequestIds: [], goalVerifications: [], goalVerificationTimeline: [], stateRevision: 2 },
    session: {
      createdAt: now,
      updatedAt: now,
      mode: 'build',
      model: { providerId: model.providerId, modelId: model.modelId },
      sessionId: SESSION_ID,
      sessionKind: 'interactive',
      status: 'idle',
      target: null,
      title: ''
    },
    settings: { mode: { current: 'build' }, model: { available: [], current: { ref: { providerId: model.providerId, modelId: model.modelId } } } }
  };
}

/**
 * 观测累加器。
 *
 * **HOSTFIX5 的字段映射**（旧字段 → 新字段，见工单报告 §2.2）：
 *  - `exports` → **删除**：替身不再导出任何东西（`module.exports` 为空），
 *    新增 `invokedAs` 钉住"我是被 **spawn 起来跑**的，不是被 require 进来当模块的"。
 *  - `runAgentOptionKeys` → `argv`：从"我们传给官方函数的 options 键"改成
 *    "官方进程**实际**被拉起时的 argv"（由子进程自己读 `process.argv`，父进程改不了）。
 *  - `startRegistryOptionKeys` → `standaloneEnvKeys`：从"传给 `Ykt` 的 options 键"
 *    改成"我真实收到的、看起来像 standalone 注入的 env 键"（stdio 形态下的等价面）。
 *  - `createAppCallCount` / `createAppOptionKeys` / `createAppHasHeadersPort` → **删除**：
 *    app 由**官方进程自己**建，我们这一侧根本不存在那个调用点（结构性消失，
 *    不是"调用了但计数为 0"）。替代断言是"替身进程是 app-server，不是被 require 的模块"。
 *  - `runtimeDisposeCalled` → `stdinClosed` + `childExitReason`：等价面从
 *    "我们 dispose 了自己起的运行时"变成"关 stdin 之后官方 app-server **自然退出**"。
 *  - `readFromInput` → `readFromStdin`：语义不变，只是流从内存 PassThrough 变成真实子进程管道。
 *  - `readFromOutput` → **删除**（不是改名）：见上面"HOSTFIX5 更正了一条设计错误"——
 *    它在 stdio 形态下是恒真的空断言。
 */
const observed = {
  invokedAs: 'program',
  entryPath: '',
  argv: [],
  moduleExports: [],
  standaloneEnvKeys: [],
  readFromStdin: [],
  parsedMethodsFromStdin: [],
  startupNotificationsSent: 0,
  startupNotificationMethods: [],
  didReceiveSessionCreate: false,
  stdinClosed: false,
  childEnv: {},
  ymrError: null,
  builtinRevision: null,
  stderrFloodRequestedBytes: 0,
  stderrFloodWrittenBytes: 0,
  exitedAfterMethod: null,
  providerRuntimeHeadersRequestSent: false,
  providerRuntimeHeadersRequestId: null,
  providerRuntimeHeadersRequestParamKeys: [],
  providerRuntimeHeadersRequestProviderId: null,
  providerRuntimeHeadersRequestReason: null,
  providerRuntimeHeadersResponseSeen: false,
  providerRuntimeHeadersResponseHeadersApplied: null,
  providerRuntimeHeadersResponseRequestAuthKeys: [],
  providerRuntimeHeadersResponseSawApiKeyField: null,
  turnProceededAfterAuth: false,
  /** HARDEN1：中途那条 `{id,error}` 错误应答发过了（挂在 `session/send` 的 id 上）。 */
  sessionSendLateRejected: null,
  sessionSendRequestId: null,
  /** HOSTFIX7：`session/subscribe` 收到几条、合格几条。 */
  subscribeRequests: 0,
  subscribeAccepted: false,
  /** HOSTFIX7：闸门真按官方语义把 turn 事件扣住了（没订阅 ⟹ 一条都不发）。 */
  turnEventsWithheldForMissingSubscribe: false,
  gateHeldForAuth: false,
  // --- HOSTFIX4：session/requestRuntimePreferences 闸门 ---
  sessionCreateResponseSent: false,
  sessionCreateResponseShapeIsReal: false,
  sessionCreateRejected: null,
  accountConfigRejected: null,
  sessionCreateResponseHeldForPreferences: false,
  runtimePreferencesRequestsSent: 0,
  runtimePreferencesRequestIds: [],
  runtimePreferencesRequestParamKeys: [],
  runtimePreferencesRequestScopes: [],
  runtimePreferencesRequestSessionIds: [],
  runtimePreferencesResponseSeen: false,
  runtimePreferencesResponseFrameKeys: [],
  runtimePreferencesResponseResultKeys: [],
  runtimePreferencesResponseResult: null,
  runtimePreferencesResponseShapeValid: null,
  runtimePreferencesResponseSatisfiedScopes: [],
  gateHeldForRuntimePreferences: false,
  // --- COMPAT1/C4：session/create 的 mode + 工具权限 / 用户输入两道闸门 ---
  sessionCreateMode: null,
  sessionCreateParamKeys: [],
  toolPermissionRequestsSent: 0,
  toolPermissionRequestIds: [],
  toolPermissionRequestParamKeys: [],
  toolPermissionResponseSeen: false,
  toolPermissionResponseFrameKeys: [],
  toolPermissionResponseResultKeys: [],
  toolPermissionResponseResult: null,
  toolPermissionResponseShapeValid: null,
  userInputRequestsSent: 0,
  userInputRequestIds: [],
  userInputRequestParamKeys: [],
  userInputResponseSeen: false,
  userInputResponseFrameKeys: [],
  userInputResponseResultKeys: [],
  userInputResponseResult: null,
  userInputResponseShapeValid: null,
  gateHeldForToolInteraction: false
};

/** 落一次观测。**只在指定了观测文件时**才写——夹具也可以被当作纯替身直接执行。 */
function flush() {
  if (OBSERVATION_FILE === '') return;
  try {
    writeFileSync(OBSERVATION_FILE, JSON.stringify(observed, null, 2), 'utf8');
  } catch {
    /* 观测落盘失败不影响替身本身的协议行为。 */
  }
}

/**
 * 落盘前把 `requestAuth.apiKey` 的**值**换掉。
 *
 * **为什么必须在这里做**：观测文件是要写到磁盘的，而反向应答帧里带着凭据明文。
 * 纪律是"解密值永不落地"，所以连**测试夹具自己的记录通道**都不许留明文。
 * 换掉之后帧仍然可解析，`requestAuth.apiKey` 仍是一个非空字符串——
 * 形状可断言，值不存在。
 *
 * @param {string} line
 * @returns {string}
 */
function redactLine(line) {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (parsed === null || typeof parsed !== 'object') return line;
  const auth = parsed?.result?.requestAuth;
  if (auth === null || typeof auth !== 'object') return line;
  if (typeof auth.apiKey !== 'string' || auth.apiKey === '') return line;
  auth.apiKey = REDACTED;
  return JSON.stringify(parsed);
}

/**
 * 把从 stdin 读到的原始文本记进观测，**逐行**记（一次 data 可能含多行）。
 *
 * @param {string} text
 * @param {string[]} sink 目标数组
 */
function recordLines(text, sink) {
  const normalized = String(text).replace(/\r/g, '');
  for (const raw of normalized.split('\n')) {
    if (raw.trim() === '') continue;
    // 先脱敏再记账：观测文件是落盘物，明文不许进去。
    const line = redactLine(raw);
    sink.push(line);
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.method === 'string') {
        observed.parsedMethodsFromStdin.push(parsed.method);
      }
    } catch {
      /* 非 JSON 行照记原文，不猜。 */
    }
  }
  flush();
}

/** 官方 `Ykt` 前置检查 `ymr`（偏移 1067031）逐字要求的那两个键。 */
const YMR_KEYS = ['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'];

/** 被观测的 env 键。与 `startProcessProviderRegistryRuntime` 时代的口径逐字相同。 */
const OBSERVED_ENV_KEYS = [
  'ZCODE_STORAGE_DIR',
  'ZCODE_SESSION_DB_PATH',
  'ZCODE_SESSION_DB',
  'ZCODE_DATA_BASE_DIR',
  'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
  'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE',
  'ZCODE_LOG_DIR',
  'ZCODE_RUNTIME_ENV'
];

/**
 * 逐字模拟官方 `resolveNodeProviderRuntimePaths`（`ymr`，偏移 1067031）：
 *
 * ```js
 * function ymr(e){ let t = e[LV]?.trim(), n = e[tte]?.trim();
 *   if(!t && !n) return null;
 *   if(!t || !n) throw new Error("ZCode Built-in 与 Personal Provider Config 路径必须同时提供");
 *   return Object.freeze({ zcodeBuiltinFilePath: t, personalFilePath: n }) }
 * ```
 *
 * 替身**照这条语义抛**，所以"生产 env 少设了这两个键"在测试里就会让整条会话失败——
 * 这正是 BL-1 要求的"用 stub 证明 `Ykt` 的前置检查能过"。
 * HOSTFIX5 起，这条前置检查发生在**进程启动期**（app-server 起不来就退 1），
 * 而不是某次函数调用里。
 *
 * @param {Record<string, any>} env
 * @returns {{ zcodeBuiltinFilePath: string, personalFilePath: string } | null}
 */
function resolveNodeProviderRuntimePaths(env) {
  const t = (env ?? {})['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE']?.trim();
  const n = (env ?? {})['ZCODE_PERSONAL_PROVIDER_CONFIG_FILE']?.trim();
  if (!t && !n) return null;
  if (!t || !n) throw new Error('ZCode Built-in 与 Personal Provider Config 路径必须同时提供');
  return Object.freeze({ zcodeBuiltinFilePath: t, personalFilePath: n });
}

/**
 * 逐字模拟官方 `UO` + `T3i` 算出的 builtin revision（偏移 587490 / 587002）：
 * `` revision: `zcode-builtin:${release.revision}:${sha256(resolve(activeFilePath))}` ``。
 *
 * 本路径（非 standalone）里 `dZe` 收到的 `activeFilePath` 是 `undefined`，所以
 * `active = bundled = ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 的值（见 host-driver 的注释）。
 *
 * **这一条现在不再只是"镜像"**：HOSTFIX5 起 `host-child.mjs` 自己也按同一公式**独立算出**
 * 这个值填进 `provider/updateAccountConfig` 的 `basedOnZCodeBuiltinRevision`，
 * 而本函数是**官方形状的对照实现**——端到端用例断言"两边算出来逐字相同"。
 *
 * @param {string} builtinFilePath
 * @returns {string | null} 文件不存在 / 解析不出 release 时返回 `null`（与官方 `bnr` 抛错同构）
 */
function computeBuiltinRevision(builtinFilePath) {
  try {
    const release = JSON.parse(readFileSync(builtinFilePath, 'utf8'));
    if (typeof release?.revision !== 'number') return null;
    const hash = createHash('sha256').update(resolve(builtinFilePath)).digest('hex');
    return `zcode-builtin:${release.revision}:${hash}`;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 启动期：进程形态自证                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 记下"我是被怎么拉起来的"。
 *
 * `invokedAs` 是 HOSTFIX5 的**形态判据**：生产代码必须**spawn** 本替身
 * （`node <this> app-server --stdio --surface desktop`），而不是 `require` 它当模块。
 * `process.argv[1]` 等于本文件路径 ⟺ 它是自己启动的程序入口。
 */
function recordInvocationShape() {
  const entry = process.argv[1];
  observed.entryPath = entry === undefined ? '' : entry;
  observed.invokedAs =
    entry !== undefined && resolve(entry) === resolve(__filename) ? 'program' : 'module';
  observed.argv = process.argv.slice(2);
  observed.moduleExports = Object.keys(module.exports ?? {});
  // stdio 形态下"往官方不读的 options 里注入"这条纪律的等价面：
  // 我们**不**传 standalone（那在 CLI 形态下只可能表现为某个 env 键）。
  observed.standaloneEnvKeys = Object.keys(process.env)
    .filter((k) => /standalone/i.test(k))
    .sort();
  observed.childEnv = {};
  for (const key of OBSERVED_ENV_KEYS) {
    observed.childEnv[key] = process.env[key] ?? null;
  }
  flush();
}

/* -------------------------------------------------------------------------- */
/* 官方自发的启动通告（r2：必须被容忍，不答、不误判为反向请求）                    */
/* -------------------------------------------------------------------------- */

/**
 * 吐官方 app-server 启动时**自发**的那几条 `startup/storageState` **通知**。
 *
 * 逐字事实（I02 E-PROBE-R3-P4 协调者实跑的捕获，HOSTFIX5 的 `%TEMP%` 冒烟复现）：
 * 顶层只有 `{method, params}`，**没有 `id`**；`params.phase` 逐字取自官方闭集
 * `checking | waiting_for_lock | migrating | committing | ready | failed`。
 * 本替身只发 `checking` 与 `ready` 两条（够驱动证明"无 id 的通知被容忍"，
 * 且**刻意不写死条数**——真实运行实测条数从 5 到 27 都出现过，驱动不得依赖条数）。
 *
 * @param {string} phase
 * @param {number} sequence
 */
function emitStartupNotification(phase, sequence) {
  observed.startupNotificationsSent += 1;
  observed.startupNotificationMethods.push('startup/storageState');
  reply({
    method: 'startup/storageState',
    params: { schemaVersion: 1, sequence, databaseKind: 'session', phase, elapsedMs: 0 }
  });
}

/* -------------------------------------------------------------------------- */
/* 协议服务                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 官方 `pTt.requestClient` 逐字 `id: \`server-${n++}\``，`n` 是**跨所有**客户端请求
 * 共享的单调计数器。替身照抄，所以第一条偏好请求拿 `server-1`、凭据那条拿 `server-2`。
 *
 * **不硬写具体 id**：HOSTFIX4 起官方每次 `session/create` 至少发一条偏好请求，
 * 凭据请求的 id 就不是固定的 `server-1` 了。真实 id 记在观测里
 * （`runtimePreferencesRequestIds` / `providerRuntimeHeadersRequestId`），由测试断言。
 */

/** 本替身自己写到 stdout 的行（用于把"反向写"从"自己的应答"里区分出来）。 */
const ownWrites = new Set();

/**
 * 吐一帧到 **stdout**（官方应答流），并把这行记进"我写过什么"，
 * 好让 stdout 侧的观测能区分"官方自己的应答"与"驱动把请求写回了应答流"。
 *
 * @param {unknown} payload
 */
function reply(payload) {
  const line = `${JSON.stringify(payload)}\n`;
  ownWrites.add(line);
  process.stdout.write(line);
}

/** `session/create` 带过来的 model（反向请求要照它填 `modelSelection`）。 */
let createdModel = { providerId: 'account:unknown', modelId: 'unknown' };
/**
 * 闸门状态。**两道**（HOSTFIX4 起）：凭据那道 + 运行时偏好那道。
 * turn 事件要求**两道都过**。
 */
let authSatisfied = false;
let runtimePreferencesSatisfied = false;
/** COMPAT1/C4：工具权限 / 用户输入两道闸门各自的状态。 */
let toolPermissionSatisfied = false;
let userInputSatisfied = false;

/**
 * COMPAT1/C4：这两道闸门**只在替身真的发了那条请求时**才参与放行判定。
 *
 * 缺省（`ZCC_STUB_ASK_*` 都没设）= 官方没问 = 不该有任何闸门参与——否则就是拿一个
 * "永远等一个不会来的应答"的替身去测一条不存在的路径。
 */
const toolPermissionRequested = ASK_TOOL_PERMISSION !== '';
const userInputRequested = ASK_USER_INPUT !== '';
/** 两道 COMPAT1/C4 闸门是否都已放行（或压根没被问到）。 */
const toolInteractionGatesPassed = () =>
  (!toolPermissionRequested || toolPermissionSatisfied) && (!userInputRequested || userInputSatisfied);

/** 闸门不放行：留痕，绝不静默放行。 */
const holdToolInteractionGate = () => {
  observed.gateHeldForToolInteraction = true;
  flush();
};
/** 两条都放行（或压根没问）时才真的发 turn 事件。 */
const maybeReleaseToolInteractionGate = () => {
  if (!toolInteractionGatesPassed()) return;
  emitTurnEvents();
};

/**
 * 官方 `pTt.requestClient` 的 id 计数器。逐字取官方（偏移 14654573）：`nextClientRequestId=1`。
 */
let nextClientRequestId = 1;
/** @type {Map<string, 'runtimePreferences' | 'providerRuntimeHeaders' | 'toolPermission' | 'userInput'>} 官方 `pendingClientRequests` 的同形替身。 */
const pendingClientRequests = new Map();
const nextRequestId = () => {
  const id = `server-${nextClientRequestId}`;
  nextClientRequestId += 1;
  return id;
};

/** 被 `session/create` 闸门压住的那条请求（HOSTFIX4）。拿到合格偏好应答后才补发回执。 */
/** @type {{ id: any } | null} */
let heldSessionCreateRequest = null;

/**
 * 两道闸门都过之后才发 turn 事件流。
 *
 * **这是 HOSTFIX3 + HOSTFIX4 的合并收口点**：事件只在
 * `runtimePreferencesSatisfied && authSatisfied` 同时为真时才发，
 * 所以"事件真的出现了"就等于
 * "① 官方 `session/create` 的偏好请求被合格应答了（不答就拿不到 sessionId）"
 * "② 真正执行会话的 app 拿着我们的 port 拿到了 requestAuth"。
 */
const emitTurnEvents = () => {
  if (!runtimePreferencesSatisfied || !authSatisfied) return;
  // 只按"是否已经放行过"去重。**不能**把两个闸门标志写进这个判断——
  // 它们在调用本函数之前刚被置真，那样会把自己挡掉（实测：应答收到了，事件没发）。
  if (observed.turnProceededAfterAuth) return;
  observed.turnProceededAfterAuth = true;
  // **HOSTFIX7：第三道闸门——官方 `kXa` 逐字 `…, !t.deliveryKind) return;`。**
  // 替身照这条语义：不订阅就不发任何 `session/event`。
  // `ZCC_STUB_REQUIRE_SUBSCRIBE=0` 才放行（留给"证明缺订阅就哑"的那条反向用例）。
  if (REQUIRE_SUBSCRIBE && !subscribed) {
    observed.turnEventsWithheldForMissingSubscribe = true;
    flush();
    return;
  }
  if (EMIT_OFFICIAL_EVENT_TYPE !== '') {
    // 逐字线上信封（`$xt` @14416723 + `hsr` @747978）：
    // `{eventId, sessionId, turnId?, seq, traceId?, timestamp, deliveryKind, type, payload}`。
    reply({ method: 'session/event', params: officialEventEnvelope('stub-unmapped-probe', EMIT_OFFICIAL_EVENT_TYPE, { tokenCount: 0 }) });
  }
  // **HOSTFIX7：正文增量逐字复刻实弹。**
  //
  // 官方 `model.streaming` 的 payload schema 是 `msr`（偏移 747256），
  // 投递过滤 `C3e`（偏移 14416900）对 `text_delta` 要求 `!!delta`。
  // 正文在 **`payload.delta`**，判别位在 **`payload.kind === "text_delta"`**——
  // **不是** `part.delta`（那个类型官方 `jZa` 从不产出，只存在于导出的 schema 闭集里）。
  //
  // 段数与总长都取实弹逐字：官方 `model.sdk.stream.completed` 记
  // `chunkCounts.textDelta = 33`、`textDeltaChars = 56`，正文取 SQLite `part` 表逐字。
  for (const [chunkIndex, chunk] of REAL_SHOT_TEXT_DELTAS.entries()) {
    // **HARDEN1：中途反转变体**——先照常发**前两段**增量（会话已经真的跑起来了，
    // 驱动已经产出真实内容），再挂一条属于 `session/send` 那个 id 的错误应答，
    // 然后**不发** `turn.completed`。于是"驱动把这条帧当普通行丢掉"这个缺陷
    // 在测试里会真的复现成"等不到终态 ⟹ 空转到墙钟上限"。
    if (REJECT_SESSION_SEND_LATE !== null && chunkIndex === 2) {
      observed.sessionSendLateRejected = String(REJECT_SESSION_SEND_LATE_CODE);
      observed.sessionSendRequestId = sessionSendRequestId;
      replyError(sessionSendRequestId, {
        code: REJECT_SESSION_SEND_LATE_CODE,
        message: REJECT_SESSION_SEND_LATE_MESSAGE
      });
      break;
    }
    reply({
      method: 'session/event',
      params: officialEventEnvelope('stub-text-delta', 'model.streaming', {
        kind: 'text_delta',
        delta: chunk,
        assistantMessageId: REAL_SHOT_ASSISTANT_MESSAGE_ID,
        partId: REAL_SHOT_PART_ID
      })
    });
  }
  if (REJECT_SESSION_SEND_LATE !== null) {
    // 终态**刻意不发**：见上面那段注释。
    flush();
    return;
  }
  // **HOSTFIX7：终态逐字复刻实弹。**
  //
  // 官方 `turn.completed` 的 payload schema 是 `ksr`（偏移 751319）：
  // `{response, tokenCount, usage?, toolCallCount, historyRoundCount?, duration,
  //   cacheStats?, inputId?, resultType, backgroundSubagentResultConsumed?}`。
  // **没有 `totalTokenCount`**（那个键在投影 reducer 上，不在事件 payload 上），
  // usage 的形状是官方 `Jgr`（偏移 1228437）的聚合结果。
  reply({
    method: 'session/event',
    params: officialEventEnvelope('stub-turn-completed', 'turn.completed', {
      response: REAL_SHOT_RESPONSE_TEXT,
      tokenCount: REAL_SHOT_USAGE.totalTokens,
      usage: { ...REAL_SHOT_USAGE },
      toolCallCount: 0,
      historyRoundCount: 1,
      duration: 6031,
      resultType: 'success'
    })
  });
  flush();
};

/**
 * 按官方 `mapSessionEvent`（`$xt`，偏移 14416723）逐字装配一帧**线上** `session/event` 的 `params`。
 *
 * ```
 * {deliveryKind: t, eventId: String(e.id), payload: …, seq: …,
 *  sessionId: String(e.sessionId), timestamp: e.timestamp.getTime(),
 *  traceId: String(e.traceId), turnId: …, type: jZa(e.type)}
 * ```
 *
 * 外层信封由 `iZo`（偏移 14473967）逐字 `{method:"session/event", params:s}` 包上。
 * 这里**不构造闭集外的 `type`**——`type` 由调用方从官方 24 项闭集里取。
 *
 * @param {string} eventId
 * @param {string} type 官方 24 项线上闭集里的一个
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
function officialEventEnvelope(eventId, type, payload) {
  return {
    deliveryKind: 'desktop-continuous',
    eventId,
    payload,
    seq: nextEventSeq(),
    sessionId: SESSION_ID,
    timestamp: 1790857132127,
    traceId: 'stub-trace-0001',
    type
  };
}

/** 官方 `seq` 是逐条递增的（`UYa` 逐字 `let l = o.lastSeq + 1`）。 */
let eventSeq = 0;
const nextEventSeq = () => {
  eventSeq += 1;
  return eventSeq;
};

/** 拒答 / 无应答：闸门不放行。观测上留痕，绝不静默放行。 */
const holdGate = () => {
  observed.gateHeldForAuth = true;
  flush();
};

/** HOSTFIX4：偏好那条没被合格应答 → 闸门不放行，且**永远不补发** `session/create` 回执。 */
const holdPreferencesGate = () => {
  observed.gateHeldForRuntimePreferences = true;
  flush();
};

/**
 * 逐字复刻官方 `CKo`（偏移 14509003）发的帧：
 * `requestClient("session/requestRuntimePreferences", {sessionId, scope}, pGt, {timeoutMs: 15e3})`。
 * params 逐字 `G5i=m.object({sessionId:Dn,scope:jsr}).strict()`。
 *
 * 官方用**同一个**计数器发 id，所以这里走 {@link nextRequestId}。
 *
 * @param {string} scope
 */
const askForRuntimePreferences = (scope) => {
  const id = nextRequestId();
  pendingClientRequests.set(id, 'runtimePreferences');
  /** @type {Record<string, unknown>} */
  const params = { sessionId: SESSION_ID, scope };
  observed.runtimePreferencesRequestsSent += 1;
  observed.runtimePreferencesRequestIds.push(id);
  observed.runtimePreferencesRequestParamKeys.push(Object.keys(params).sort());
  observed.runtimePreferencesRequestScopes.push(scope);
  observed.runtimePreferencesRequestSessionIds.push(SESSION_ID);
  reply({ id, method: PREFERENCES_REQUEST_METHOD, params });
  // 官方 `CKo` 逐字 `timeoutMs: dGt`，`dGt = 15e3`（15 s），超时码 `-32022`，
  // 而它的 catch 对 `-32022` 是 `throw l`（只对 -32601/-32020 给默认对象）
  // → 官方**抛掉**整个 `session/create`，**不回 sessionId**。
  // 替身照这条语义：超时后 `sessionCreateResponseSent` 恒为 false。
  // 官方等 15 s；替身用 3 s，让测试跑得完（真实往返是管道级）。
  const timer = setTimeout(() => {
    if (!runtimePreferencesSatisfied) holdPreferencesGate();
  }, 3000);
  timer.unref?.();
};

/**
 * 逐字复刻官方 `pTt.requestClient` 发的帧：`qir = {id, method, params?, trace?}`（`.strict()`），
 * params 是 `fUi = {requestId, sessionId, turnId?, workspace, modelSelection, providerId,
 * accountAccess?, reason}`（`.strict()`）。
 *
 * @param {unknown} workspace
 */
const askForProviderRuntimeHeaders = (workspace) => {
  const providerId = FORCE_AUTH_REQUEST_PROVIDER_ID || createdModel.providerId;
  /** @type {Record<string, unknown>} */
  const params = {
    requestId: `${SESSION_ID}:provider-runtime-headers:stub-uuid`,
    sessionId: SESSION_ID,
    workspace,
    modelSelection: { providerId, modelId: createdModel.modelId },
    providerId,
    reason: 'model-request'
  };
  observed.providerRuntimeHeadersRequestSent = true;
  observed.providerRuntimeHeadersRequestParamKeys = Object.keys(params).sort();
  observed.providerRuntimeHeadersRequestProviderId = providerId;
  observed.providerRuntimeHeadersRequestReason = params.reason;
  const id = nextRequestId();
  pendingClientRequests.set(id, 'providerRuntimeHeaders');
  observed.providerRuntimeHeadersRequestId = id;
  reply({ id, method: AUTH_REQUEST_METHOD, params });
  // 官方 `requestClient` 逐字 `timeoutMs: BZa`，`BZa = 18e4`（180 s）。
  // 替身用 3 s 判"没等到应答"——测试跑得完，而且足够宽松（真实往返是管道级）。
  const timer = setTimeout(() => {
    if (!authSatisfied) holdGate();
  }, 3000);
  timer.unref?.();
};

/**
 * HOSTFIX4：判定一帧 `session/requestRuntimePreferences` 的应答是否**合格**。
 *
 * 逐字对应官方 `pTt.resolveClientRequest` → `s.resultSchema.parse(n)`，而
 * `resultSchema` 就是 `pGt`（偏移 759339）：
 *
 * ```
 * pGt = m.object({
 *   nativeSearchEnhancementsEnabled: m.boolean(),                    // 唯一必填
 *   memoryEnabled: m.boolean().default(!1),
 *   askUserQuestionAutoResolutionEnabled: m.boolean().default(!0),
 *   integratedTerminalShell: aYe.optional(),
 *   modelContextBudgetStrategy: Bsr.default("preflight-v1")
 * }).strict()
 * ```
 *
 * zod 的 `.strict()` 语义是"**未知键一律拒**"，`.default()` 语义是"缺了就在**输出侧**
 * 补上缺省值"——所以合法应答的判据是：
 *  1. result 是非数组对象；
 *  2. **每个键都在 `pGt` 的字段表里**（`.strict()`）；
 *  3. `nativeSearchEnhancementsEnabled` 在场且是布尔（唯一无 `.default()` 的字段）。
 *
 * 其余三个字段缺了都合法（`pGt` 自己会补 / 可选）。本函数**只判形状**，
 * **不判取值**——取值由单测逐字段钉（替身不是第二个取值权威）。
 *
 * @param {any} result
 * @returns {boolean}
 */
function isValidRuntimePreferencesResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
  const keys = Object.keys(result);
  if (!keys.every((k) => PREFERENCES_RESULT_FIELDS.includes(k))) return false;
  if (typeof result.nativeSearchEnhancementsEnabled !== 'boolean') return false;
  for (const k of ['memoryEnabled', 'askUserQuestionAutoResolutionEnabled']) {
    if (result[k] !== undefined && typeof result[k] !== 'boolean') return false;
  }
  if (
    result.modelContextBudgetStrategy !== undefined &&
    !PREFERENCES_BUDGET_STRATEGIES.includes(result.modelContextBudgetStrategy)
  ) {
    return false;
  }
  // 官方 `aYe`（偏移 716367）逐字
  // `m.discriminatedUnion("mode",[{mode:m.literal("auto")},{mode:m.literal("shell"),…}])`。
  // 替身只认 `{mode:"auto"}` 与不带该字段两种合法形态。
  const shell = result.integratedTerminalShell;
  if (shell !== undefined) {
    if (shell === null || typeof shell !== 'object' || shell.mode !== 'auto') return false;
  }
  return true;
}

/**
 * 收到 `session/requestRuntimePreferences` 的应答帧时的判定（HOSTFIX4）。
 *
 * 合格就**补发被压住的 `session/create` 回执**——这正是官方 `ERn` 返回之后
 * `UKo` 才会做的事。拿不到合格应答，那个回执**永远不发**
 * （官方那边是 `session/create` 抛 `-32022`，同样拿不到 sessionId）。
 *
 * @param {any} frame
 * @param {string | null} scope
 */
const serveRuntimePreferencesResponse = (frame, scope) => {
  // **反向开关（默认关）**：模拟"驱动没答"。
  // 官方那边"应答帧从没到"与"超时"是**完全一样**的：`pTt.handleMessage` 从没调过
  // `resolveClientRequest`，`pendingClientRequests` 里那条一直挂着，15 s 后 `-32022`。
  // 所以这里**连"应答已看到"都不记**——观测口径与官方一致。
  if (SWALLOW_PREFERENCES_RESPONSE !== '') return;
  // **反向开关（默认关）**：把 result 改成形状不合法的形态。
  // 官方 `pGt` 是 `.strict()`（偏移 759339），未知键让整条 parse 失败 → `CKo` 的 catch
  // 落进 `throw l`（只对 -32601/-32020 给默认对象）→ 同样拿不到 sessionId。
  //
  // 两种形态各有分工，**都不能省**：
  //  - `'missing-required'`：**删掉** `nativeSearchEnhancementsEnabled`（`pGt` 里唯一无
  //    `.default()` 的字段）。这条由 `typeof … !== 'boolean'` 那一检查抓。
  //  - `'extra-key'`：三个必填/带缺省的键**全对**，只**多加一个** `pGt` 之外的键。
  //    这条**只有** `.strict()` 的未知键检查能抓——所以它是"替身真的按官方
  //    `.strict()` 判"的唯一可观测点。
  let result = frame.result;
  if (FORCE_PREFERENCES_SHAPE !== '' && result !== null && typeof result === 'object' && !Array.isArray(result)) {
    if (FORCE_PREFERENCES_SHAPE === 'missing-required') {
      const { nativeSearchEnhancementsEnabled: _drop, ...rest } = result;
      result = rest;
    } else if (FORCE_PREFERENCES_SHAPE === 'extra-key') {
      result = { ...result, notAFieldOfPGt: true };
    }
  }
  const valid = isValidRuntimePreferencesResult(result);
  observed.runtimePreferencesResponseSeen = true;
  observed.runtimePreferencesResponseFrameKeys = Object.keys(frame).sort();
  observed.runtimePreferencesResponseResultKeys =
    result !== null && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result).sort() : [];
  // 记**整份** result：它按构造只有布尔，零凭据，所以落盘无风险。
  observed.runtimePreferencesResponseResult = result !== null && typeof result === 'object' ? { ...result } : null;
  observed.runtimePreferencesResponseShapeValid = valid;
  if (valid) observed.runtimePreferencesResponseSatisfiedScopes.push(scope);
  flush();
  if (!valid) {
    holdPreferencesGate();
    return;
  }
  runtimePreferencesSatisfied = true;
  // **逐字复刻官方的时序**：`session/create` 的回执在这里才发出去。
  if (heldSessionCreateRequest !== null) {
    observed.sessionCreateResponseSent = true;
    // 自证"我回的是实弹那份形状"：四层深 + `"unknown"` 诱饵同时在场。
    observed.sessionCreateResponseShapeIsReal =
      Object.prototype.hasOwnProperty.call(buildSessionCreateResult(createdModel).session, 'sessionId');
    reply({ id: heldSessionCreateRequest.id, result: buildSessionCreateResult(createdModel) });
    heldSessionCreateRequest = null;
  }
  flush();
};

/**
 * 收到反向应答帧（`Vir = {id, result}`，`.strict()`）时的判定。
 *
 * 判定口径逐字对应官方两处：
 *  - `pTt.resolveClientRequest` → `s.resultSchema.parse(n)`，`resultSchema` 是 `DGt`；
 *  - `tat`（偏移 4014209）逐字
 *    `if (!o.headersApplied || !o.requestAuth) throw new Error("Provider request auth was not returned…")`。
 * 所以**只认** `headersApplied === true` 且 `requestAuth` 是对象。
 *
 * @param {any} frame
 */
const serveAuthResponse = (frame) => {
  const result = frame.result;
  const auth = result?.requestAuth;
  observed.providerRuntimeHeadersResponseSeen = true;
  observed.providerRuntimeHeadersResponseHeadersApplied = result?.headersApplied ?? null;
  observed.providerRuntimeHeadersResponseRequestAuthKeys =
    auth !== null && typeof auth === 'object' ? Object.keys(auth).sort() : [];
  observed.providerRuntimeHeadersResponseSawApiKeyField = typeof auth?.apiKey === 'string';
  flush();
  if (result?.headersApplied !== true || auth === null || typeof auth !== 'object') {
    holdGate();
    return;
  }
  authSatisfied = true;
  flush();
  // **COMPAT1/C4**：凭据这道过了之后，官方才走到工具执行那一步——而那一步可能再发
  // 权限 / 用户输入两条反向请求。所以这里**不是**无条件的 `emitTurnEvents()`：
  // 替身经 env 要求发那两条时，先发它们，答完才放行 turn。
  // 逐字对应官方 `Ooo`（偏移 5002466）：`if(s.decision==="ask") { …requestPermission… }`
  // 发生在 `authSatisfied` 之后、工具真正执行之前。
  if (toolPermissionRequested) askForToolPermission();
  if (userInputRequested) askForUserInput();
  maybeReleaseToolInteractionGate();
};

/* -------------------------------------------------------------------------- */
/* COMPAT1/C4：工具权限 / 用户输入两道闸门                                       */
/* -------------------------------------------------------------------------- */

/**
 * COMPAT1/C4：逐字复刻官方 `WZa`（偏移 14442835 附近）发的帧。
 *
 * params 逐字 `dUi`（偏移 767390）：
 * `m.object({requestId:Dn,sessionId:Dn,turnId:Dn.optional(),toolCallId:Dn,toolName:Dn,reason:m.string(),riskLevel:m.enum(["low","medium","high","critical"]),input:m.unknown(),origin:KL.optional(),options:m.array(wYe).min(1)}).strict()`
 *
 * 其中 `wYe`（偏移 740692）逐字
 * `m.object({optionId:Dn,kind:Dn,name:Dn,description:m.string().optional(),response:JL}).strict()`。
 *
 * 官方用**同一个**单调计数器（`server-${nextClientRequestId++}`）发 id。
 */
const askForToolPermission = () => {
  /** @type {Record<string, unknown>} */
  const params = {
    requestId: `${SESSION_ID}:perm:stub-uuid`,
    sessionId: SESSION_ID,
    toolCallId: 'stub-toolcall-0001',
    toolName: 'Bash',
    reason: 'Stub tool requires approval',
    riskLevel: 'medium',
    input: { command: 'echo stub' },
    options: [
      { optionId: 'allowOnce', kind: 'allow', name: 'Allow once', response: { decision: 'allow' } },
      { optionId: 'allowAlways', kind: 'allow_always', name: 'Always allow', response: { decision: 'allow' } },
      { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }
    ]
  };
  observed.toolPermissionRequestsSent += 1;
  observed.toolPermissionRequestParamKeys.push(Object.keys(params).sort());
  const id = nextRequestId();
  pendingClientRequests.set(id, 'toolPermission');
  observed.toolPermissionRequestIds.push(id);
  reply({ id, method: PERMISSION_REQUEST_METHOD, params });
  // 官方 `pTt.requestClient` 对这条**没有** `timeoutMs`（经 `dRn` 只给
  // `{sessionId, kind, …}`），所以真实挂死是**无限**的。替身用 3 s 判"没等到"，
  // 让测试跑得完——与 `authSatisfied` / `runtimePreferencesSatisfied` 同一档处理。
  const timer = setTimeout(() => {
    if (!toolPermissionSatisfied && !userInputSatisfied) holdToolInteractionGate();
  }, 3000);
  timer.unref?.();
};

/** COMPAT1/C4：逐字复刻官方 `HZa`（偏移 14444876）发的帧，params 逐字 `pUi`（偏移 768496）。 */
const askForUserInput = () => {
  /** @type {Record<string, unknown>} */
  const params = {
    requestId: `${SESSION_ID}:userinput:stub-uuid`,
    sessionId: SESSION_ID,
    toolCallId: 'stub-toolcall-0002',
    toolName: 'AskUserQuestion',
    prompt: 'Which approach should I take?',
    questions: [
      { question: 'Which approach?', header: 'Approach', options: [{ value: 'a', label: 'Approach A' }] }
    ],
    input: { questions: [{ question: 'Which approach?', header: 'Approach', options: [{ value: 'a', label: 'Approach A' }] }] },
    schema: { toolName: 'AskUserQuestion' }
  };
  observed.userInputRequestsSent += 1;
  observed.userInputRequestParamKeys.push(Object.keys(params).sort());
  const id = nextRequestId();
  pendingClientRequests.set(id, 'userInput');
  observed.userInputRequestIds.push(id);
  reply({ id, method: USER_INPUT_REQUEST_METHOD, params });
  const timer = setTimeout(() => {
    if (!toolPermissionSatisfied && !userInputSatisfied) holdToolInteractionGate();
  }, 3000);
  timer.unref?.();
};

/**
 * 判定一帧 `interaction/requestPermission` 的应答是否**合格**。
 *
 * 逐字对应官方 `pTt.resolveClientRequest` → `s.resultSchema.parse(n)`，
 * `resultSchema` 就是 `JL`（`.strict()` 的枚举 + 三个可选字段）。
 *
 * @param {any} result
 * @returns {boolean}
 */
function isValidPermissionResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
  // `.strict()`：未知键一律拒——这是"替身真的按官方 `.strict()` 判"的唯一可观测点。
  if (!Object.keys(result).every((k) => PERMISSION_RESULT_FIELDS.includes(k))) return false;
  if (!PERMISSION_DECISIONS.includes(result.decision)) return false;
  if (result.reason !== undefined && typeof result.reason !== 'string') return false;
  return true;
}

/** 判定一帧 `interaction/requestUserInput` 的应答是否**合格**（`CYe`，`.strict()`）。 */
function isValidUserInputResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
  if (!Object.keys(result).every((k) => USER_INPUT_RESULT_FIELDS.includes(k))) return false;
  if (!USER_INPUT_ACTIONS.includes(result.action)) return false;
  if (result.reason !== undefined && typeof result.reason !== 'string') return false;
  return true;
}

/**
 * 收到 `interaction/requestPermission` 应答时的判定。
 *
 * **合格并不放行 turn**：官方那边这条闸门是在工具执行**之前**问的，问完才继续。
 * 替身把它做成"必须答完才放行 turn"，于是"不答"这条缺陷在测试里会**真的**复现成
 * 与实弹同构的形状（turn 事件永不发 → 驱动空转到墙钟上限）。
 *
 * @param {any} frame
 */
const serveToolPermissionResponse = (frame) => {
  if (SWALLOW_TOOL_INTERACTION_RESPONSE !== '') return;
  let result = frame.result;
  if (FORCE_PERMISSION_SHAPE !== '' && result !== null && typeof result === 'object' && !Array.isArray(result)) {
    if (FORCE_PERMISSION_SHAPE === 'missing-decision') {
      const { decision: _drop, ...rest } = result;
      result = rest;
    } else if (FORCE_PERMISSION_SHAPE === 'extra-key') {
      result = { ...result, notAFieldOfJL: true };
    }
  }
  const valid = isValidPermissionResult(result);
  observed.toolPermissionResponseSeen = true;
  observed.toolPermissionResponseFrameKeys = Object.keys(frame).sort();
  observed.toolPermissionResponseResultKeys =
    result !== null && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result).sort() : [];
  observed.toolPermissionResponseResult = result !== null && typeof result === 'object' ? { ...result } : null;
  observed.toolPermissionResponseShapeValid = valid;
  flush();
  if (!valid) {
    holdToolInteractionGate();
    return;
  }
  toolPermissionSatisfied = true;
  maybeReleaseToolInteractionGate();
};

/** 收到 `interaction/requestUserInput` 应答时的判定（同 {@link serveToolPermissionResponse}）。 */
const serveUserInputResponse = (frame) => {
  if (SWALLOW_TOOL_INTERACTION_RESPONSE !== '') return;
  let result = frame.result;
  if (FORCE_USER_INPUT_SHAPE !== '' && result !== null && typeof result === 'object' && !Array.isArray(result)) {
    if (FORCE_USER_INPUT_SHAPE === 'missing-action') {
      const { action: _drop, ...rest } = result;
      result = rest;
    } else if (FORCE_USER_INPUT_SHAPE === 'extra-key') {
      result = { ...result, notAFieldOfCYe: true };
    }
  }
  const valid = isValidUserInputResult(result);
  observed.userInputResponseSeen = true;
  observed.userInputResponseFrameKeys = Object.keys(frame).sort();
  observed.userInputResponseResultKeys =
    result !== null && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result).sort() : [];
  observed.userInputResponseResult = result !== null && typeof result === 'object' ? { ...result } : null;
  observed.userInputResponseShapeValid = valid;
  flush();
  if (!valid) {
    holdToolInteractionGate();
    return;
  }
  userInputSatisfied = true;
  maybeReleaseToolInteractionGate();
};

/**
 * 对一帧进来的请求给应答。**只对 stdin 上的行应答**——这正是官方 transport 的方向。
 * @param {string} text
 */
const serve = (text) => {
  let at = text.indexOf('\n');
  let rest = text;
  while (at >= 0) {
    const line = rest.slice(0, at);
    rest = rest.slice(at + 1);
    at = rest.indexOf('\n');
    if (line.trim() === '') continue;
    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    // HOSTFIX6：**反向**开关——收到这个 method 之后立刻非零退出，让驱动走
    // "等一个永远不会来的回执"那条失败路径。放在最前面：连方法分派都不做。
    if (EXIT_AFTER_METHOD !== '' && parsed.method === EXIT_AFTER_METHOD) {
      observed.exitedAfterMethod = EXIT_AFTER_METHOD;
      flush();
      process.exit(9);
    }
    // 应答帧先判：官方 `fTt.dispatchLine` 逐字
    // `if ("id" in n && ("result" in n || "error" in n)) { this.handleMessage(n) … return }`。
    // 官方 `pTt.handleMessage` 逐字 `String(t)` 查 `pendingClientRequests` —— 同一个
    // 计数器发出去的 id，所以这里**按 id 路由**（HOSTFIX4 起有两条）。
    if ('id' in parsed && ('result' in parsed || 'error' in parsed)) {
      const kind = pendingClientRequests.get(String(parsed.id));
      if (kind === 'runtimePreferences') {
        const scope = PREFERENCES_SCOPES[observed.runtimePreferencesRequestIds.indexOf(String(parsed.id))] ?? null;
        serveRuntimePreferencesResponse(parsed, scope);
      } else if (kind === 'providerRuntimeHeaders') {
        serveAuthResponse(parsed);
      } else if (kind === 'toolPermission') {
        serveToolPermissionResponse(parsed);
      } else if (kind === 'userInput') {
        serveUserInputResponse(parsed);
      }
      continue;
    }
    // **无 id 的通知**（官方自发通告）：官方 app-server 对 id 缺省的帧逐字
    // `"ZCode Protocol notification ignored"`。替身照这条语义**直接丢弃**，不误解成请求。
    if (typeof parsed.method === 'string' && !('id' in parsed)) continue;
    if (parsed.method === 'provider/updateAccountConfig') {
      // HOSTFIX6 **反向**开关：逐字复刻实弹那条 ZodError 拒答。
      if (REJECT_ACCOUNT_CONFIG !== '') {
        observed.accountConfigRejected = REJECT_ACCOUNT_CONFIG;
        flush();
        replyError(parsed.id, {
          code: REJECT_ACCOUNT_CONFIG === 'zod' ? -32603 : -32022,
          zod: REJECT_ACCOUNT_CONFIG === 'zod',
          message:
            REJECT_ACCOUNT_CONFIG === 'zod'
              ? '[\n  {\n    "code": "unrecognized_keys",\n    "keys": [\n      "accountType",\n      "mode"\n    ],\n    "path": [\n      "account:zai-start-plan",\n      "access"\n    ],\n    "message": "Unrecognized keys: \\"accountType\\", \\"mode\\""\n  }\n]'
              : 'Client request timed out: provider/updateAccountConfig'
        });
        continue;
      }
      // 官方 `XZo` 成功时的返回形状：`{receivedRevision, providerCount, status}`。
      reply({
        id: parsed.id,
        result: {
          receivedRevision: parsed.params?.revision ?? 'stub',
          providerCount: Object.keys(parsed.params?.providers ?? {}).length,
          status: 'received'
        }
      });
      continue;
    }
    if (parsed.method === 'session/create') {
      observed.didReceiveSessionCreate = true;
      // HOSTFIX6 **反向**开关：逐字复刻官方那条「Provider Registry 中不存在 Model」的外形。
      if (REJECT_SESSION_CREATE !== '') {
        observed.sessionCreateRejected = REJECT_SESSION_CREATE;
        flush();
        replyError(parsed.id, { code: -32018, message: 'Provider Registry 中不存在 Model' });
        continue;
      }
      createdModel = parsed.params?.model ?? createdModel;
      // **COMPAT1/C4**：记下 `session/create` 的 `mode` 与完整 params 键表。
      // 官方 `nGt`（偏移 757102）是 `.strict()` 的，所以**多一个键整帧作废**；
      // 测试逐字断言键表就是这条"我们没多发键、也没少发键"的证据。
      observed.sessionCreateMode = parsed.params?.mode ?? null;
      observed.sessionCreateParamKeys = Object.keys(parsed.params ?? {}).sort();
      // **HOSTFIX4：先不回执。** 逐字 `UKo @14479962` 的 `await ERn(...)` 在
      // `session/create` 响应之前，而 `ERn → CXa → CKo` 会先向客户端要偏好。
      // 官方那边不答就是 `-32022` rethrow → 整个 `session/create` 抛掉、不回 sessionId。
      // 替身照这条语义：合格应答到了才补发。
      heldSessionCreateRequest = { id: parsed.id };
      observed.sessionCreateResponseHeldForPreferences = true;
      for (const scope of PREFERENCES_SCOPES) askForRuntimePreferences(scope);
      continue;
    }
    if (parsed.method === 'session/subscribe') {
      // **HOSTFIX7：逐字复刻官方 `HKo`（偏移 14490824）**
      // `o.deliveryKind = n.deliveryKind, o.legacyStreamSubscribed = !0`
      // 以及 `kXa`（偏移 14506989）逐字 `…, !t.deliveryKind) return;` 的闸门。
      //
      // 替身**真的**按这个闸门工作：没订阅过就**一条 `session/event` 都不发**。
      // 于是"驱动忘了订阅"这条缺陷在测试里会**真的**复现成 300 秒挂死的同构形状
      // （`ZCC_STUB_REQUIRE_SUBSCRIBE=0` 打开时）。
      const deliveryKind = parsed.params?.deliveryKind;
      observed.subscribeRequests += 1;
      if (REJECT_SUBSCRIBE !== '') {
        observed.subscribeAccepted = false;
        reply({ id: parsed.id, error: { code: -32602, message: '订阅被替身反向开关拒掉' } });
        continue;
      }
      if (deliveryKind === 'desktop-continuous' || deliveryKind === 'web-remote-replayable') {
        subscribed = true;
        observed.subscribeAccepted = true;
      } else {
        observed.subscribeAccepted = false;
        reply({
          id: parsed.id,
          error: { code: -32602, message: 'deliveryKind 不在闭集 ["desktop-continuous","web-remote-replayable"] 内' }
        });
        continue;
      }
      // 官方逐字回 `{eventSeq, events, sessionId, snapshot?}`（`$5i`）。
      // `afterSeq` 缺省时官方 `events` 是**空数组**（`HKo` 逐字
      // `let s = n.afterSeq === void 0 ? [] : await SRn(…)`），这里同构。
      reply({ id: parsed.id, result: { eventSeq: nextEventSeq(), events: [], sessionId: SESSION_ID } });
    }
    if (parsed.method === 'session/send') {
      // 应答 1：官方对 session/send 的受理回执。
      // **HARDEN1：记下这个 id**——中途那条错误应答必须挂在它上面（根因 2 修的正是
      // "按 id 精确认领应答"，挂错 id 就等于没认出来）。
      sessionSendRequestId = parsed.id;
      reply({ id: parsed.id, result: { accepted: true } });
      // 应答 2（HOSTFIX3）：**先要凭据，再发 turn 事件**。
      // 兜底：驱动若连反向请求都没接（老行为），闸门不放行 → 不会有 turn 事件。
      askForProviderRuntimeHeaders(parsed.params?.workspace ?? parsed.params ?? {});
    }
  }
  flush();
};

/* -------------------------------------------------------------------------- */
/* 启动                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 往 fd 2（stderr）**同步**灌 `STDERR_FLOOD_BYTES` 字节。分块写，每块 16 KB。
 *
 * 内容是一段固定 ASCII 噪声：**不含任何凭据形态**（测试纪律：夹具也不许造得像凭据），
 * 也不含任何真实路径或内部符号名。
 *
 * @param {number} total 目标字节数；<= 0 时什么都不做
 * @returns {number} 实际写入的字节数
 */
function floodStderr(total) {
  if (total <= 0) return 0;
  const block = Buffer.alloc(16 * 1024, 0x61 /* 'a' */);
  let written = 0;
  while (written < total) {
    const want = Math.min(block.length, total - written);
    written += writeSync(2, want === block.length ? block : block.subarray(0, want));
  }
  return written;
}

recordInvocationShape();

/** 前置检查：官方 `Ykt` 的 `ymr`（偏移 1067031）语义。起不来就退 1（fail-closed）。 */
let paths = null;
try {
  paths = resolveNodeProviderRuntimePaths(process.env);
} catch (e) {
  observed.ymrError = e instanceof Error ? e.message : String(e);
  flush();
  process.exit(1);
}
if (paths === null) {
  observed.ymrError = '缺少进程 Provider Registry 的 ZCode Built-in / Personal Config 路径';
  flush();
  process.exit(1);
}
// 官方 builtin config 必须**真实存在且可解析**，否则 `bnr` 抛 AggregateError。
if (!existsSync(paths.zcodeBuiltinFilePath)) {
  observed.ymrError = `BUNDLED 与 ACTIVE ZCODE BUILTIN RELEASE 均不可用（${paths.zcodeBuiltinFilePath} 不存在）`;
  flush();
  process.exit(1);
}
observed.ymrError = null;
observed.builtinRevision = computeBuiltinRevision(paths.zcodeBuiltinFilePath);
observed.stderrFloodRequestedBytes = STDERR_FLOOD_BYTES;
flush();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  recordLines(text, observed.readFromStdin);
  serve(text);
});
// 官方 app-server 逐字行为：stdin 收到 `end` 之后走完自己的 shutdown 链、`exit 0`
// （I02 E-PROBE-R3-P4 与 HOSTFIX5 的 `%TEMP%` 冒烟都是 exit code=0、stderr 0 字节）。
// 所以这里**不 kill、不 process.exit**——自然退就是"没有孤儿"的那条证据。
process.stdin.on('end', () => {
  observed.stdinClosed = true;
  flush();
});
process.stdin.on('error', () => {
  flush();
});
process.stdin.on('close', () => {
  flush();
});

// 自发通告：官方是在**零帧**写出的情况下就发这 5 条的（E-BUNDLE-023 / E-PROBE-R3-P4）。
// 替身把它们放在"注册完监听器"之后发，这样驱动**必须**容忍它们。
//
// **HOSTFIX6（B-1）：stderr 洪流灌在通告之前**——这样"首帧到底发不发得出去"
// 就成了 drain 存在与否的直接判据（复审 §3.4 的 A/B 曲线同构）。
observed.stderrFloodWrittenBytes = floodStderr(STDERR_FLOOD_BYTES);
flush();
emitStartupNotification('checking', 1);
emitStartupNotification('ready', 2);

module.exports = {};
