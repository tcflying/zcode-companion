/**
 * official-host 会话驱动 —— 与官方 app-server NDJSON 通道对话。
 *
 * ## 进程模型（HOSTFIX5：**spawn 官方 app-server**，不再 require bundle）
 *
 * 上一版把官方 bundle **require 进本子宿主进程**，再拿它导出的
 * `runZCodeProtocolAgent` 驱动。**实弹首战证明那条路不存在**：
 * `C:\ZCode\resources\glm\zcode.cjs` **没有任何具名导出**（`exports.createZCodeApp` /
 * `exports.runZCodeProtocolAgent` / `exports.startProcessProviderRegistryRuntime` 全文各
 * 0 命中；仅有的两处 `module.exports` 是内部库 shim），于是 `BUNDLE_EXPORTS_INCOMPLETE`
 * 是**必然**失败而不是偶发。
 *
 * 现在本文件**不再加载官方代码**。它拿到的 `child` 是一个**真实子进程**：
 * `node <bundlePath> app-server --stdio --surface desktop`（argv 与 `scripts/verify-runtime.mjs`
 * 的 I02 探针、r1–r4 捕获、STANDALONE_PROBE 一致；`--stdio` / `--surface desktop` 已由
 * HOSTFIX5 的 `%TEMP%` 零发送冒烟实测：5–27 条自发 `startup/storageState` 通知、
 * `runtime/capabilities` 应答 `{independentPlanState:true}`、关 stdin 后 `exit 0`、
 * stderr 0 字节）。本子宿主自己的 stdin/stdout 继续只承载**父子通道**。
 *
 * ## 流的方向（官方 `fTt` 传输层逐字契约，**跨进程后不变**）
 *
 * 官方传输层 `fTt`（`ZCodeProtocolNdjsonConnection`）逐字
 * `o=e.input??process.stdin, s=e.output??process.stdout`，且 `handleMessage` 挂在 `input` 上。
 * `app-server` 子命令把这对流**默认接到进程自己的 stdin/stdout**（help 逐字
 * `app-server  Run the ZCode Protocol stdio app server`）。所以方向是单向的、不可互换的，
 * **只是载体从内存 `PassThrough` 变成了真实管道**：
 *
 *  - **请求写子进程的 stdin**（本文件的 `input.write(...)`）
 *  - **应答读子进程的 stdout**（本文件的 `output.on('data', …)`）
 *
 * 本文件**曾经**把这两者接反（请求写 `output`、从 `input` 读应答），那会让 `session/create`
 * 永远到不了官方 agent，`extractSessionId` 恒为 `null` → 每次请求 100% 失败
 * `SESSION_CREATE_NO_SESSION_ID`。接线由 `tests/unit/official-host-stub-bundle.test.mjs`
 * 经**真实 spawn 路径**钉死：替身 app-server 观测自己的 **stdin 收到请求**，
 * 并观测**自己 stdout 上没有外来写入**（接反就是那里非空）。
 *
 * ## 官方自发的启动通告（r2 结论：**容忍，不答，不误判**）
 *
 * 官方 app-server 在**我们写零帧**的情况下就自发吐出 `{method, params}` 的
 * `startup/storageState` **通知**（顶层**无 `id`**；实测条数 5 或 27，从不稳定）。
 * 官方 `fTt.dispatchLine` 对 id 缺省的帧逐字记 `"ZCode Protocol notification ignored"`。
 *
 * 本文件对它们的处置是**唯一正确的那一种**：**数一下、丢掉**。
 *  - **不答**：它们不是反向请求，官方对 id 缺省的帧根本不读。
 *  - **不误判为反向请求**：`isSessionRequestRuntimePreferencesRequest` /
 *    `isProviderRuntimeHeadersRequest` 都要求 `id` 在场，天然排除。
 *  - **不混进事件流**：否则它们会污染 `extractSessionId` / `mapOfficialEventToChannel` 的输入
 *    （`params` 里带 `sessionId` 的通知会被误认成 `session/create` 的回执）。
 *  - **计数**（`unsolicitedNotificationsIgnored`）：官方到底发了几条成为一条可断言的事实。
 *
 * ## `basedOnZCodeBuiltinRevision` 现在由本子宿主**自己算**（不再从官方运行时读）
 *
 * 上一版靠 `startProcessProviderRegistryRuntime` 在同进程里起一份运行时，再从
 * `configService.read().zcodeBuiltinRevision` / `accountSource.read().basedOnZCodeBuiltinRevision`
 * 读出来。**没有 require 就没有运行时可读**，所以改成按官方公式**独立计算**：
 *
 * ```
 * UO 构造器（偏移 587490）：this.#n = createHash("sha256").update(resolve(this.#t)).digest("hex")
 * T3i（偏移 587002）：revision: `zcode-builtin:${e.revision}:${t}`
 * ```
 *
 * 而本路径（非 standalone）里 `activeFilePath` 恒 `undefined`，所以 `active = bundled =
 * ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 的值。拿不到（文件不存在 / 解析不出 `revision`）时
 * **不发** `provider/updateAccountConfig`（fail-closed，理由见 `buildAccountConfigPatch`）。
 * 替身夹具**独立复刻同一条公式**作为对照，端到端用例断言"两边算出来逐字相同"。
 *
 * ## 出站凭据闸门：为什么是"应答官方反向请求"而不是"往 createZCodeApp 塞 port"
 *
 * 上一版在这里调 `createZCodeApp({ providerRuntimeHeadersPort: port, … })` 并**丢弃返回值**，
 * 以为闸门挂上了。HOSTFIX2 §6.1 查明那是个假象，本轮（HOSTFIX3）把官方字节逐条读完，结论是：
 *
 *  - 官方 `NXo`（偏移 14678273）的 options 面**只有 9 个键**
 *    （`prepareStorageOnly / env / cwd / input / output / presentationSurface /
 *    lifecycle / version / providerEndpointRoutingPort`）。**没有** `create` 工厂、
 *    **没有** `providerRuntimeHeadersPort`、**没有** `providerRegistry`。
 *    工单里说的 `create: r(() => Ykt(z))` 是 `N3e`（`acquireProtocolStartupResource`）
 *    **自己内部**的 thunk 参数名，不是对外槽位。
 *  - `NXo` 自己 `new pTt({ createZCodeApp: r((Fe = {}) => KAn({...}), …) })`，
 *    而 `pTt` 建 app 的唯一入口是 `Hxt`（偏移 14436209）：
 *    `let o = n.providerRuntimeHeadersPort ?? ZJo(e, t)`。
 *    `Hxt` 的**三个**调用点（`QJo` / `rZo` / `session/create`）**都不传**这个键——
 *    所以 `n.providerRuntimeHeadersPort` 恒 `undefined`，那个 port 在协议代理路径上
 *    **结构上不可达**。
 *  - 唯一实际生效的是官方缺省 `ZJo`（`createProviderRuntimeHeadersPort`，偏移 14434207），
 *    它逐字 `e.requestClient(va.interactionRequestProviderRuntimeHeaders, …, DGt, …)`，
 *    即**向附着的协议客户端要凭据**；没有客户端就是 `-32020`。
 *
 * 而 `pTt.requestClient`（偏移 14667657）把请求帧写到 `this.messageSink`，
 * `messageSink` 逐字是 `Tt.setNotificationSink(Fe => Ye.send(Fe))`，`Ye` 是 `fTt`，
 * `send` 写的是 **`output`**——即**应答流**。**那条流就是我们一直在读的子进程 stdout**
 * ——我们本来就是官方眼里的"协议客户端"。所以正确的接法是**履行客户端职责**：
 * 收到那条反向请求（字面量 `interaction/requestProviderRuntimeHeaders`）就用我们的 port
 * 作答，把 `{id, result}` 写回**子进程 stdin**。
 *
 * **HOSTFIX5 不改变这个结论，只换载体**：app 仍然由官方**自己**建（`Hxt` 的三个调用点
 * 依旧不传 `providerRuntimeHeadersPort`），缺的 port 依旧恒为缺省 `ZJo`，我们依旧只能靠
 * 应答官方发来的请求。变的只是"那条应答流"从同进程的内存 `PassThrough` 变成了
 * 子进程的 stdout。
 *
 * 逐字依据（全部只读核对，见 `reverse-responder.mjs` 文件头）：`qir`/`Vir` 两种 `.strict()`
 * 帧形状、`fTt.dispatchLine` 的应答路由、`GHo` → `pTt.resolveClientRequest` → `DGt.parse`、
 * `tat` 的 `!headersApplied || !requestAuth` 拒答、以及官方只在
 * `accountAccess.mode === "start-plan"` 时才来问（`$0e.claim`）。
 *
 * 代价是诚实的记在这里：闸门从"一个对象"变成"一条应答"，但**唯一性不变**——
 * 官方那条路上除了我们没人应答，我们拒答它就 `-32031` 发不出去。
 *
 * ## HOSTFIX4：`session/requestRuntimePreferences`（**每一次 `session/create` 都要答**）
 *
 * 这条与上面那条**性质不同**，必须分开记：
 *
 * ```
 * jKo @14479718 → UKo @14479962 → ERn @14511145 → CXa @14510354
 *   → CKo @14509003  let l = await e.requestClient(va.sessionRequestRuntimePreferences,
 *                                               {sessionId:t, scope:n}, pGt, {timeoutMs: dGt})   // dGt = 15e3
 *   → catch: 只对 -32601 / -32020 返回默认对象，其余 throw l      ← -32022 走 throw
 * ```
 *
 * **不答的后果是整轮实弹报废**（复审 §10.1 实证的链路）：`-32022` 被 rethrow，
 * 而 `await ERn(...)` 在 `UKo` 的 `try` **之外** → `session/create` 不返回 sessionId
 * → 驱动在 `while (sessionId === null && Date.now() < deadline)` 里空转到
 * `SESSION_TIMEOUT_MS = 300_000` 才抛 `SESSION_CREATE_NO_SESSION_ID`。
 * **永远走不到模型请求**，HOSTFIX3 的凭据闸门一次都不会被触达。
 *
 * 所以它**没有闸门、也不设拒答**：官方那条 catch 里"拒答"根本不是一个存在的姿势。
 * fail-closed 落在**值**上——回 `{nativeSearchEnhancementsEnabled:false, memoryEnabled:false,
 * askUserQuestionAutoResolutionEnabled:false}`（三个 `false` 各自的官方消费点见
 * `reverse-responder.mjs` 的字段表；取值以官方 `pGt` 逐字为准，`dsh-zcode-appserver`
 * `lib/appserver.js:360-362` 的 `reverseAnswer` 第一个分支只作形态旁证）。
 *
 * **零凭据、零 I/O、零 port 参与**：应答值与 `request`、port、凭据仓全无关。
 * 写回是**同步**的——不 await，直接在同一个 stdout 回调里写子进程 stdin。
 *
 * ## 账号/entitled 的真实注入面（官方 `provider/updateAccountConfig`）
 *
 * 官方**不**从 `createZCodeApp` / `startProcessProviderRegistryRuntime` 的 options 里读
 * 任何账号快照。逐字证据：
 *  - `startProcessProviderRegistryRuntime`（`Ykt`，偏移 14124467）的第二参 `t` **只**认
 *    `t.standalone`（`t.standalone?.credentialStore` / `.request` / `.onAccountInitializationError`
 *    / `.legacyCliUserConfigFilePath` / `.onBuiltinRefreshResult`），其余键一律不读。
 *  - `runZCodeProtocolAgent`（`NXo`）**根本不接受** `app` 或 `providerRegistry`：它自己
 *    `Ykt(z)` 起运行时、自己 `new pTt({createZCodeApp:…, syncAccountProviderConfig:rt.syncAccountProviderConfig,…})`。
 *    所以给这两处注入东西是**无效**的。
 *  - 唯一真实入口是**协议方法** `provider/updateAccountConfig`（`va` 枚举，偏移 785128）→
 *    `XZo`（偏移 14548296）：`yl(CGt,t)` 校验 → `FHo(n)` 规范化 → `deps.syncAccountProviderConfig(o)`
 *    → `Ykt` 返回的 `syncAccountProviderConfig` → `o.replace(T,"host-account-config")` + `registryService.refresh(...)`。
 *  - `CGt`（偏移 766126）逐字：
 *    `{revision, basedOnZCodeBuiltinRevision, providers: Record<string,unknown>, states: Record<string,{availability,entitled,unavailableReason?,current?,connectionKey?,effectiveAt?}>}` `.strict()`。
 *  - `FHo` 逐字约束：`for(let[s,a]of o.entries()) if(cee(s)&&a.access?.type==="zhipu-account"&&a.access.entitled&&typeof e.states?.[s]?.current!="boolean") throw new Error(\`Account State 缺少 current: ${s}\`)`。
 *    ——**`providers[id].access.entitled` 为真时，`states[id].current` 必填布尔**，缺则整帧被拒。
 *  - 消费侧 `nZe`（`ProviderRegistryService`，偏移 583792）逐字丢弃条件：
 *    `if(s.basedOnZCodeBuiltinRevision!==o.zcodeBuiltinRevision){…continue}`——
 *    **`basedOnZCodeBuiltinRevision` 与官方当前 builtin revision 不一致时，整份账号快照被丢弃**。
 *
 * 所以注入必须在 `session/create` **之前**发一帧 `provider/updateAccountConfig`，且
 * `basedOnZCodeBuiltinRevision` 必须等于官方 builtin revision（`account:…` 快照缺它就被丢）。
 * 这就是 {@link buildAccountConfigPatch} 的存在理由。
 *
 * ## entitled 到底 gate 什么（判定结论）
 *
 * 官方 `574247` 的 effective-selection 计算逐字：
 *
 *   `rt = E.access?.type!=="zhipu-account" || E.access.entitled===!0`
 *   `Pe = t.accountStates?.[T]?.current!==!1`
 *   `Tt = L && rt && Pe && z.length===0`
 *   `… executable:_t  // _t = Tt && enabled && issues.length===0`
 *   `… selectable:Dt  // Dt = _t && visibility!=="hidden"`
 *
 * **结论：entitled gate 的是模型选择的 `executable`/`selectable`，也就是"能不能选它、
 * 能不能跑它"——不是只 gate 菜单。** 因此 `provider/updateAccountConfig` 这一帧是
 * 实弹路径的**必要**输入，不能删。（删除的前提是"发送路径不查 entitled"，逐字不成立。）
 * 父进程 `host-driver.ts` 侧那道 fail-closed 闸门因此**不是**冗余：官方那道只看
 * `access.entitled` 与 `states[id].current`，而这两项的值是我们注入的；真正独立的第二道
 * 判据在父进程，它读的是**本机缓存**而不是我们注入的值。
 *
 * ## 协议事实（工单已核，逐条照抄其形状，不加推测）
 *
 *  - 请求帧顶层键**只有** `{id, method, params, trace}`，官方 schema 是 `.strict()`，
 *    多一个键（例如 `jsonrpc`）整帧作废。`trace` 可选，**不构造**。
 *  - `session/create` 必填 `workspace.workspacePath` / `workspace.workspaceKey`；
 *    `thoughtLevel` 在**顶层**（不是 `options` 里）；`model` 是 `{providerId, modelId}` 两字段。
 *  - `session/send` 是 fire-and-forget：它返回 `accepted:true` **只代表排上了**，
 *    不代表产出。真正的收尾是事件流里的 `turn.completed`。
 *  - **必须先 `session/subscribe`**（HOSTFIX7 的首要根因，逐字见
 *    {@link OFFICIAL_DELIVERY_KINDS} 的注释）：官方 `kXa` 逐字
 *    `… , !t.deliveryKind) return;` ——协议侧会话记录上没有 `deliveryKind` 就
 *    **一条 `session/event` 都不发**，而 `session/create` 既不接收也不设置它。
 *  - 线上事件 `params.type` 是**点号**闭集 25 项（逐字见
 *    {@link OFFICIAL_SESSION_EVENT_TYPES}），不是官方内部那个下划线枚举。
 *  - 正文增量：`session/event` + `type:"model.streaming"` +
 *    `payload.kind === "text_delta"` + `payload.delta`。
 *  - 全文与 usage：`turn.completed` + `payload.response` / `payload.usage`。
 *  - 收尾：`session/close`。
 *
 * ## 凭据边界
 *
 * `port` 由本进程构造，`refreshBeforeModelRequest` 在**本进程**内被调用；它的返回值
 * 只出现在写向**子进程 stdin** 的 `{id, result}` 帧里（官方 `pTt.resolveClientRequest`
 * 在那个子进程里就地解析）。明文**从不**出现在任何写向父进程的帧里，也从不落盘。
 */
import {
  isProviderRuntimeHeadersRequest,
  isSessionRequestRuntimePreferencesRequest,
  isToolPermissionRequest,
  isUserInputRequest,
  REVERSE_REQUEST_PERMISSION,
  REVERSE_REQUEST_PROVIDER_RUNTIME_HEADERS,
  REVERSE_REQUEST_RUNTIME_PREFERENCES,
  REVERSE_REQUEST_USER_INPUT,
  resolveHostToolPolicy,
  resolveProviderRuntimeHeadersResponse,
  resolveSessionRuntimePreferencesResponse,
  resolveToolPermissionResponse,
  resolveUserInputResponse
} from './reverse-responder.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  OFFICIAL_APP_SERVER_EXIT_GRACE_MS as APP_SERVER_EXIT_GRACE_MS,
  HOST_DEBUG_ENV_KEY as OFFICIAL_HOST_DEBUG_ENV_KEY,
  DEFAULT_HOST_PERMISSION_MODE,
  HOST_PERMISSION_MODE_ENV_KEY,
  OFFICIAL_SESSION_MODES,
  resolveHostPermissionMode
} from '../../packages/official-host/src/host-driver.js';

// 重导出：`host-child.mjs` 的 `reapAppServer` 用的是**同一个**常量（单一出处在
// `host-driver.ts`），测试逐字断言两者同值——"两处各写一份字面量"这种漂移不可能发生。
export { APP_SERVER_EXIT_GRACE_MS };

// COMPAT1/C4：`mode` 的闭集与解析器同样**只在 `host-driver.ts` 里有一份**（本文件与
// `reverse-responder.mjs` 都从这里重导出）。理由与上面那条完全相同：官方闭集 `$j`
// 一旦在两处各写一份字面量，漂移只会在实弹里以「`session/create` 整帧被官方
// `.strict()` 拒掉」的形式出现——而那一帧被拒的表现是 300 s 挂死，不是报错。
export { DEFAULT_HOST_PERMISSION_MODE, HOST_PERMISSION_MODE_ENV_KEY, OFFICIAL_SESSION_MODES, resolveHostPermissionMode };

/**
 * 一次 `driveSession` 的摘要。**零凭据**。
 *
 * 存在的唯一理由是"出站闸门真的被触达过"这件事必须**可观测**，而不是只能靠读代码推断。
 * 字段刻意只有布尔、计数、闭集短码与毫秒数。
 *
 * `reverseRequestsByMethod` 按 method 分组是 HOSTFIX4 加的：复审（§10.1/§10.4）证明
 * "逐字节读完我们关心的那条链"**漏掉过**一条不在那条链上的反向请求，而那条漏掉的
 * （`session/requestRuntimePreferences`）会让首轮实弹挂 300 秒。分组计数让
 * "官方到底发了几条、分别是哪几条"变成**一条可断言的事实**，而不是又一次读码推断。
 *
 * `unsolicitedNotificationsIgnored` 是 HOSTFIX5 加的：官方 app-server 会**自发**吐出
 * 无 `id` 的 `startup/storageState` 通知（实测 5 或 27 条，从不稳定）。把它们"数一下、
 * 丢掉"是可观测的；把"我们容忍了它们"变成可断言的事实。
 *
 * 失败路径上打的是 {@link DriveSessionPartialSummary}（HOSTFIX6）：**同形**，
 * 只是三个阶段耗时可以是 `null` —— 那个 `null` 恰恰是**诊断价值最高**的一位：
 * 它回答"挂在哪个阶段"。成功路径的摘要**一个字未改**。
 *
 * @typedef {{
 *   reverseRequestsAnswered: number,
 *   reverseRequestsByMethod: Readonly<Record<string, number>>,
 *   unsolicitedNotificationsIgnored: number,
 *   lastReverse: import('./reverse-responder.mjs').ReverseResponseSummary | null,
 *   lastRuntimePreferences: import('./reverse-responder.mjs').RuntimePreferencesSummary | null,
 *   lastToolPermission: import('./reverse-responder.mjs').ToolPermissionSummary | null,
 *   lastUserInput: import('./reverse-responder.mjs').UserInputSummary | null,
 *   permissionMode: string,
 *   toolPolicy: 'allow' | 'deny',
 *   phaseDurationsMs: Readonly<{
 *     accountConfig: number | null,
 *     sessionCreate: number | null,
 *     turn: number | null,
 *     total: number
 *   }>,
 *   unmappedOfficialEventTypes: Readonly<Record<string, number>>
 * }} DriveSessionPartialSummary
 *
 * @typedef {Omit<DriveSessionPartialSummary, 'phaseDurationsMs'> & {
 *   phaseDurationsMs: Readonly<{
 *     accountConfig: number | null,
 *     sessionCreate: number,
 *     turn: number,
 *     total: number
 *   }>
 * }} DriveSessionSummary
 */

/**
 * 打 `DriveSessionSummary` 到 stderr 的 env 开关（HOSTFIX4 立，HOSTFIX6 接通到入口）。
 *
 * **字面量的单一出处在 `packages/official-host/src/host-driver.ts`**（`HOST_DEBUG_ENV_KEY`）：
 * 入口闭集校验它、`buildIsolatedChildEnv` 透传它、本文件从那里 import。
 * 四处各写一份字面量就是"两处漂移"那种缺陷，所以这里**重导出**而不是另写一份。
 *
 * **只认精确的 `'1'`**——`'0'` / `'true'` / 空串 / 未设置一律**不打**。
 * 理由：这是一个"实弹诊断"的开关，宁可**关不上不了**（需要显式改代码）
 * 也不要"某天被什么环境变量顺手打开了"（比如 `ZCC_HOST_DEBUG=` 在某个 CI 里为空）。
 *
 * 输出的位置是**子宿主的 stderr**：`host-driver.ts` 逐字只对 stderr 做
 * `stderrBytes += chunk.length` 的**计数**，**从不**把内容读进变量、从不转发、
 * 从不落盘（见 `host-driver.ts` 注释："stderr 只在诊断计数里出现，内容从不��被读取或
 * 转发（官方 bundle 的 stderr 可能带凭据片段）"）。所以这一行**不新增任何凭据面**，
 * 父通道帧结构也一个字不动。
 */
export const HOST_DEBUG_ENV_KEY = OFFICIAL_HOST_DEBUG_ENV_KEY;

/** 官方请求帧的**唯一**顶层键集合（对齐官方 `zcodeProtocolRequestSchema` 的 `.strict()`）。 */
export const OFFICIAL_REQUEST_KEYS = Object.freeze(['id', 'method', 'params', 'trace']);

/**
 * 官方**应答帧**的**唯一**顶层键集合。
 *
 * 逐字（偏移 735705）：`Vir = m.object({ id: yYe, result: m.unknown() }).strict()`。
 * 所以反向应答**多一个键都不行**——`fTt.dispatchLine` 逐字
 * `if ("id" in n && ("result" in n || "error" in n)) { this.handleMessage(n) … }`，
 * 而 `decodeLine` 逐字先过 `qHt.safeParse(n)`，`.strict()` 失败就发
 * `-32600 Invalid ZCode Protocol message` 并**丢掉整帧**。
 */
export const OFFICIAL_RESPONSE_KEYS = Object.freeze(['id', 'result']);

/**
 * 官方 `yee` 的空快照里 `basedOnZCodeBuiltinRevision` 的哨兵值。逐字（偏移 556411）：
 * `c3i = Object.freeze({ revision:"empty-account-config-v1", basedOnZCodeBuiltinRevision:"uninitialized", providers: uw.empty() })`。
 *
 * 它**不是**一个可用的 revision：拿到它说明官方运行时还没起完（`pZe.start()` 逐字
 * `… .basedOnZCodeBuiltinRevision === "uninitialized" && this.#t.replace(HKe(await this.configService.read()), "initial-fail-closed")`，
 * 即只有在它**等于**这个哨兵时官方才写入真实值）。所以本文件把它当"没有值"处理。
 */
export const UNINITIALIZED_BUILTIN_REVISION = 'uninitialized';

/** 单次会话的墙钟上限。超时报失败，不无限等。 */
export const SESSION_TIMEOUT_MS = 300_000;

/**
 * 官方在 `session/create` 成功应答的 `projection.sessionId` 里放的**字面量诱饵**。
 *
 * 实弹逐字：`"projection":{"activeToolCalls":[],…,"sessionId":"unknown","status":"idle",…}`。
 * 真值在 `result.session.sessionId`。所以这一个字符串**永远不能**被当成 sessionId
 * ——认了它，后续 `session/send` 就会带着 `sessionId:"unknown"` 出去。
 * 本仓库不造这个常量之外的任何"未知 session"表示。
 */
export const UNKNOWN_SESSION_ID = 'unknown';

/** {@link DriveSessionPartialSummary} 里"未映射事件类型"那张表的**键数上限**。 */
export const UNMAPPED_EVENT_TYPE_CAP = 32;

/**
 * 那张表的**键长上限**（HARDEN1 · 改进清单 #1）。
 *
 * ## 为什么键数封顶不够
 *
 * {@link UNMAPPED_EVENT_TYPE_CAP} 封的是**键的个数**，不是**键的长度**。`params.type`
 * 来自**官方 app-server 的 stdout**，是官方进程自选的**自由文本**（不在
 * {@link OFFICIAL_SESSION_EVENT_TYPES} 闭集内的任何字面量都会被照实记下来）。
 * 官方一次异常的 `type`（实测可轻松到几万字符）会**逐字**成为这张表的一个键，
 * 于是单行诊断上界变成 `32 × 键长`——而这份 `ZCC_HOST_DEBUG` 诊断行是本项目
 * **实弹期唯一的可观测面**：一次异常就能把它撑成几 MB，把真正有用的那几行淹掉。
 *
 * 这是全仓**唯一**一处"官方自由文本逐字进诊断行"的面，所以单独封一道。
 *
 * 取 **64** 字符：官方闭集里最长的字面量是 `streamRecovery.updated`（22 字符），
 * 64 留了三倍余量，**闭集内的键逐字不变**（既有断言 `toEqual` 不受影响）。
 */
export const UNMAPPED_EVENT_TYPE_MAX_KEY_CHARS = 64;

/** 键超长时保留的**头部**长度。剩下的位置留给 `…` 与 `(len=…)` 长度标记。 */
export const UNMAPPED_EVENT_TYPE_KEY_PREFIX_CHARS = 32;

/**
 * 把官方 `params.type` 钳成一条**有界长度**的诊断表键。
 *
 * - 长度 ≤ {@link UNMAPPED_EVENT_TYPE_MAX_KEY_CHARS}：**逐字返回**（闭集内的官方
 *   点号字面量一个字都不改，既有断言与实弹排障的对照价值全部保留）。
 * - 超长：取前 {@link UNMAPPED_EVENT_TYPE_KEY_PREFIX_CHARS} 个字符 + `…` +
 *   `(len=<原长度>)`。**长度标记是必须的**——没有它，"被截断的键"与"官方真的发了
 *   一个短到这个形状的键"就分不开，而那正是排障时要分辨的两件事。
 *
 * 结果键的长度上界是
 * `UNMAPPED_EVENT_TYPE_KEY_PREFIX_CHARS + 1 + '(len=' + 数字 + ')'`，
 * 与原长度**无关**（`999999999` 也只多 8 字符）。
 *
 * @param {string} type 官方 `params.type` 原样
 * @returns {string} 长度有界的诊断表键
 */
export function clampUnmappedEventTypeKey(type) {
  if (type.length <= UNMAPPED_EVENT_TYPE_MAX_KEY_CHARS) return type;
  return `${type.slice(0, UNMAPPED_EVENT_TYPE_KEY_PREFIX_CHARS)}…(len=${String(type.length)})`;
}

/**
 * 等 `session/subscribe` 应答的上限（ms）。
 *
 * 取 **2000 ms**，与账号帧那条（{@link waitForResponseFor}，同样 2000 ms）同量级：
 * 官方 `HKo` 只做两件事——给会话记录**记一个 `deliveryKind`**，回 `{eventSeq}`，
 * 都不碰 I/O。真实会话的模型请求在它之后才开始（实弹约 6 s 起），所以 2 s 足够，
 * 超了就是"订阅这一步真出问题了"，而不是"官方慢"。
 */
export const SUBSCRIBE_RESPONSE_TIMEOUT_MS = 2000;

/* -------------------------------------------------------------------------- */
/* HOSTFIX7：官方线上事件闭集（逐字取证，见文件头"协议事实 · 事件"）          */
/* -------------------------------------------------------------------------- */

/**
 * 官方**线上**会话事件类型的完整闭集。
 *
 * ## 取证（官方产物 `C:/ZCode/resources/glm/zcode.cjs`，只读；版本 0.16.9）
 *
 * 逐字两处，互相印证：
 *  - 偏移 **748931**，导出的 `zcodeSessionEventTypeSchema`（`L5i`）：
 *    `L5i = m.enum([…25 项…])`；
 *  - 偏移 **755406**，导出的 `zcodeSessionEventEnvelopeSchema`（`eGt`）：
 *    `eGt = m.discriminatedUnion("type", [A_("session.created",gsr), …])`。
 *
 * ## 这 25 个是**点号**，不是下划线（HOSTFIX6 第五根因的前提被证伪）
 *
 * 官方内部枚举（偏移 1234129 的 `lt`）**是**下划线：`turn_complete` / `model_complete` /
 * `model_streaming` / …。但那个枚举**不上线**：它在官方自己的日志与 SQLite 里
 * （实弹逐字 `session.event.persistence.completed … "sessionEventType":"turn_complete"`），
 * 上线前被逐字改写成点号——官方 `jZa`（偏移 14430066）：
 *
 * ```
 * case lt.TurnComplete: return "turn.completed";
 * case lt.TurnError:   return "turn.failed";
 * case lt.ModelStreaming: return "model.streaming";
 * default: return "session.updated"
 * ```
 *
 * 再由 `mapSessionEvent`（`$xt`，偏移 14416723）装配成 `params`，
 * 由 `iZo`（偏移 14473967）逐字 `e.notify({method:"session/event", params:s})` 发出。
 * **所以线上 `params.type` 是点号**；把点号表删掉换成下划线表，会让每一条事件都不被认。
 */
export const OFFICIAL_SESSION_EVENT_TYPES = Object.freeze([
  'session.created',
  'session.resumed',
  'session.updated',
  'session.titleUpdated',
  'session.closed',
  'turn.started',
  'turn.steerQueued',
  'turn.steerDrained',
  'turn.completed',
  'turn.failed',
  'message.upserted',
  'message.removed',
  'part.started',
  'part.delta',
  'part.upserted',
  'part.removed',
  'model.streaming',
  'tool.updated',
  'permission.requested',
  'permission.resolved',
  'userInput.requested',
  'userInput.resolved',
  'checkpoint.created',
  'rewind.triggered',
  'streamRecovery.updated'
]);

/**
 * 官方 `deliveryKind` 闭集。逐字（偏移 **650171**）：`kV = m.enum(["desktop-continuous","web-remote-replayable"])`。
 *
 * ## 为什么必须有它（HOSTFIX7 的**首要**根因）
 *
 * 官方的 `session/event` 通知**不是无条件发的**。`kXa`（偏移 14506989）逐字：
 * `… , e.v4Gateway?.ingest(…), !t.deliveryKind) return;`
 * ——协议侧会话记录上**没有** `deliveryKind` 就**直接 return，一条都不发**。
 *
 * 而 `session/create` 的 params schema（`nGt`，偏移 757102）**根本没有** `deliveryKind` 这个键，
 * 建出来的记录（`EXa` 的返回字面量 `R`，偏移 14513424）也**没有**这个字段。
 * 全仓唯一两处赋值（逐字检索 `deliveryKind=` 只有 3 处命中，其中一处属 v4 gateway 无关代码）：
 *  - `qKo`（`session/read`，偏移 14489970）：`o.deliveryKind = n.deliveryKind ?? o.deliveryKind`；
 *  - `HKo`（`session/subscribe`，偏移 14490824）：`o.deliveryKind = n.deliveryKind`。
 *
 * `session/subscribe` 的 params（`tGt`，偏移 756181）逐字：
 * `m.object({sessionId: Dn, deliveryKind: kV, afterSeq: …optional(), includeSnapshot: …default(!1)}).strict()`
 * ——`deliveryKind` **必填**。
 *
 * **这就是 HOSTFIX6 那次 300 秒挂死的真正原因**：模型答完了（官方逐字
 * `model.request.completed finishReason:"stop"`），但官方**一条 `session/event` 都没发**，
 * 于是我们的点号表根本没机会命中。HOSTFIX6 归因于"下划线 vs 点号"，那是在读**日志**
 * 里的内部枚举（`lt`），没读到上线路径。
 */
export const OFFICIAL_DELIVERY_KINDS = Object.freeze(['desktop-continuous', 'web-remote-replayable']);

/** 本驱动订阅时用的 `deliveryKind`——闭集里与"本地 spawn 一个 app-server"相容的那一个。 */
export const OFFICIAL_DELIVERY_KIND = 'desktop-continuous';

/**
 * `turn.completed` 的 `resultType` 闭集。逐字（`ksr`，偏移 751319）：
 * `m.enum(["success","cancelled","error_max_turns","error_max_budget","error_during_execution","error_max_tool_calls"])`。
 *
 * **只有 `"success"` 才是成功**。其余五个（取消 / 四种上限类失败）官方**同样**用
 * `turn.completed` 承载——把它们一并报成 `finish` 就是 HOSTFIX6 明令禁止的"假成功"。
 */
export const OFFICIAL_TURN_RESULT_TYPES = Object.freeze([
  'success',
  'cancelled',
  'error_max_turns',
  'error_max_budget',
  'error_during_execution',
  'error_max_tool_calls'
]);

/** `model.streaming` 的 `payload.kind` 闭集。逐字（`fsr`，偏移 747061）：`m.enum([…13 项…])`。 */
export const OFFICIAL_MODEL_STREAMING_KINDS = Object.freeze([
  'start',
  'finish',
  'error',
  'text_start',
  'text_delta',
  'text_end',
  'reasoning_start',
  'reasoning_delta',
  'reasoning_end',
  'tool_input_start',
  'tool_input_delta',
  'tool_input_end',
  'tool_call'
]);

/** usage 事件的 `usageMethod` 短码（闭集，零凭据）。 */
export const OFFICIAL_USAGE_METHOD = 'official_turn_complete_usage';

/**
 * 构造一帧官方请求。**按官方键序投影**，即使上游多挂了键，落进管线的也只有这四个。
 *
 * @param {string | number} id
 * @param {string} method
 * @param {unknown} [params]
 * @returns {{ id: string | number, method: string, params?: unknown }}
 */
export function buildOfficialRequest(id, method, params) {
  /** @type {{ id: string | number, method: string, params?: unknown }} */
  const frame = { id, method };
  if (params !== undefined) frame.params = params;
  return frame;
}

/**
 * 把官方事件映射成本通道的 `delta` / `usage` / `finish` / `failed`。
 *
 * ## 先拆信封
 *
 * 官方在 output 上吐的是 `{method:"session/event", params:<事件>}`，逐字证据
 * （产物内偏移 14473967 `iZo`）：`s&&(e.notify({method:"session/event",params:s}),KYa(e,n,s))`。
 * `type` / `payload` 在 **`params` 之下**，不是信封顶层。裸事件（无 `method`）也接受。
 *
 * ## 认哪三种（HOSTFIX7 逐字重写，映射表从点号"猜"改成官方闭集上的三条真映射）
 *
 * | 官方 `params.type` | 取值路径 | 产出 |
 * | --- | --- | --- |
 * | `model.streaming` | `payload.kind === "text_delta"` → `payload.delta` | `delta` |
 * | `turn.completed` | `payload.usage.{inputTokens,outputTokens}` + `payload.resultType` | `usage` + `finish`/`failed` |
 * | `turn.failed` | `payload.error.{code,type,message}` | `failed` |
 *
 * **其余 21 种官方类型一律不映射**，由调用方按官方字面量计入
 * {@link DriveSessionPartialSummary.unmappedOfficialEventTypes}——**计数，不猜**。
 *
 * ## 三处"原来写错了"的地方（都是 HOSTFIX6 照着**投影**或**内部枚举**写的）
 *
 * 1. **正文不在 `part.delta`**。`part.delta` 只存在于官方**导出的 schema 闭集**
 *    （`Csr`，偏移 752394）里，官方 `jZa` 的 `mapSessionEvent` **从不产出它**
 *    ——它是 0.16.9 之前的遗留类型。正文增量逐字是
 *    `model.streaming` + `payload.kind === "text_delta"` + `payload.delta`
 *    （payload schema `msr`，偏移 747256；官方投递过滤 `C3e`，偏移 14416900，
 *    对 `text_delta` 要求 `!!delta` 非空）。
 * 2. **usage 不在 `totalTokenCount`**。那个键在**投影**里（官方 reducer 逐字
 *    `[lt.TurnComplete]: (t,n)=>{… totalTokenCount: t.totalTokenCount + o.tokenCount …}`），
 *    `turn.completed` 的 payload 上**没有**这个键。逐字在 `payload.usage`
 *    （官方 `ZO`/`Jgr`，偏移 1228437 聚合全部 `model_complete` 的 `payload.usage`）。
 * 3. **`turn.cancelled` 不是官方类型**。取消也走 `turn.completed`，靠
 *    `payload.resultType === "cancelled"` 区分（`ksr` 闭集，偏移 751319）。
 *
 * ## 不猜
 *
 * `payload.delta` 缺失/非字符串/空串一律**不产** `delta`；`payload.usage` 缺
 * `inputTokens` 或 `outputTokens` 一律**不产** `usage`（父进程那条 `null → unavailable`
 * 的路径正是我们要的）；`payload.resultType` 缺失或不在官方闭集里一律**失败化**。
 *
 * @param {any} message 官方 `session/event` 帧（带信封或裸事件都接受）
 * @returns {ReadonlyArray<Record<string, unknown>>} 本通道事件（可为空）
 */
export function mapOfficialEventToChannel(message) {
  const event = unwrapSessionEvent(message);
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return [];
  const record = /** @type {Record<string, any>} */ (event);
  const type = record['type'];
  if (typeof type !== 'string') return [];
  const payload =
    record['payload'] !== null && typeof record['payload'] === 'object' && !Array.isArray(record['payload'])
      ? /** @type {Record<string, any>} */ (record['payload'])
      : {};

  if (type === 'model.streaming') return mapModelStreaming(payload);
  if (type === 'turn.completed') return mapTurnCompleted(payload);
  if (type === 'turn.failed') return mapTurnFailed(payload);
  return [];
}

/**
 * `model.streaming` → 通道事件。**只有 `text_delta` 是正文**。
 *
 * 官方投递过滤 `C3e` 逐字（偏移 14416900）：`text_delta`/`reasoning_delta` 要求
 * `!!delta`，其余四种（`tool_input_start|delta|end`、`tool_call`）放行但正文不在这。
 * 所以本函数对**非 `text_delta` 的 kind 一律返回空数组**——由调用方按官方
 * `type` 计入 unmapped（键是 `model.streaming`，不是某个 kind，不制造第二套键空间）。
 *
 * @param {Record<string, any>} payload 官方 `payload`
 * @returns {ReadonlyArray<Record<string, unknown>>}
 */
function mapModelStreaming(payload) {
  if (payload['kind'] !== 'text_delta') return [];
  const text = payload['delta'];
  if (typeof text !== 'string' || text === '') return [];
  return [{ type: 'delta', text }];
}

/**
 * `turn.completed` → `usage` + `finish`（或 `failed`）。
 *
 * `resultType` **只有** `"success"` 映射成 `finish`；其余五个官方值
 * （`cancelled` / `error_max_turns` / `error_max_budget` / `error_during_execution` /
 * `error_max_tool_calls`）一律失败化——官方用同一个类型承载"turn 结束了"，
 * 只有 `resultType` 区分它是成功还是没成功。报成 `finish` 就是假成功。
 *
 * @param {Record<string, any>} payload 官方 `payload`
 * @returns {ReadonlyArray<Record<string, unknown>>}
 */
function mapTurnCompleted(payload) {
  const resultType = payload['resultType'];
  if (typeof resultType !== 'string' || !OFFICIAL_TURN_RESULT_TYPES.includes(resultType)) {
    return [
      {
        type: 'failed',
        code: 'TURN_COMPLETED_UNRECOGNIZED',
        detail: `官方 turn.completed 的 resultType 不在闭集内: ${describeUnrecognizedResultType(resultType)}`
      }
    ];
  }
  if (resultType !== 'success') {
    return [{ type: 'failed', code: `TURN_${resultType.toUpperCase()}`, detail: OFFICIAL_TURN_RESULT_DETAIL[resultType] }];
  }
  /** @type {Record<string, unknown>[]} */
  const events = [];
  // **先于 usage / finish 的内部信号**：驱动层据此判断"本轮一条 delta 都没有"时
  // 用 `payload.response` 兜底（见 `consumeEventLine`）。它**不是**通道事件，
  // `consumeEventLine` 会把它就地消费掉，永远不会 `emit` 出去。
  events.push({ type: 'turn_completed_body', text: readTurnCompletedResponse(payload) });
  const usage = mapOfficialUsage(payload['usage']);
  if (usage !== null) events.push(usage);
  events.push({ type: 'finish', reason: 'stop' });
  return events;
}

/**
 * 官方 `turn.completed.payload.response`（`ksr` 逐字 `response: m.string()`，必填）。
 * 防御性地只取非空字符串。
 *
 * @param {Record<string, any>} payload 官方 `payload`
 * @returns {string}
 */
function readTurnCompletedResponse(payload) {
  const response = payload['response'];
  return typeof response === 'string' ? response : '';
}

/**
 * `turn.failed` → `failed`。逐字取 `payload.error` 的 `code` / `type` / `message`
 * （官方 `QHt`，偏移 748895：`{type, message, stack?, code?, detail?, …}`）。
 * **`stack` 一律不取**——那是绝对路径 + 产物内部符号名（与 HOSTFIX6 的
 * `describeOfficialError` 同一条纪律）。
 *
 * @param {Record<string, any>} payload 官方 `payload`
 * @returns {ReadonlyArray<Record<string, unknown>>}
 */
function mapTurnFailed(payload) {
  const error =
    payload['error'] !== null && typeof payload['error'] === 'object' && !Array.isArray(payload['error'])
      ? /** @type {Record<string, any>} */ (payload['error'])
      : {};
  const code = firstShortCode(error['code'], error['type']);
  const message = typeof error['message'] === 'string' ? error['message'].trim() : '';
  return [
    {
      type: 'failed',
      code: `TURN_FAILED_${code}`,
      detail: message === '' ? '官方 turn 失败且未给 message' : message.slice(0, 240)
    }
  ];
}

/**
 * 官方 `turn.completed.payload.usage` → 通道 `usage` 事件。
 *
 * 官方形状逐字（`Jgr`，偏移 1228437，聚合全部 `model_complete` 的 `payload.usage`）：
 * `{source, modelRequestCount, inputTokens, outputTokens, totalTokens,
 *   cacheReadTokens, cacheWriteTokens, reasoningTokens, webFetchRequests, webSearchRequests}`。
 * 且**可能整体缺失**（`Jgr` 逐字 `if(t.length!==0) return …` ——一条 `model_complete`
 * 都没有时返回 `undefined`），官方 schema 侧也是 `usage: m.unknown().optional()`（`ksr`）。
 *
 * 逐字透传官方给的 `inputTokens` / `outputTokens`；**任一缺失或非非负整数就不产
 * usage 事件**（父进程那条"没有 usage 事件 → 如实报 `usage: null` + `unavailable`"
 * 的路径正是我们要的），**不拿 `tokenCount` 顶替**——两者是不同口径，混用是编数字。
 *
 * @param {unknown} usage 官方 `payload.usage`
 * @returns {{ type: 'usage', promptTokens: number, completionTokens: number, usageMethod: string } | null}
 */
export function mapOfficialUsage(usage) {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const record = /** @type {Record<string, any>} */ (usage);
  const inputTokens = readNonNegativeInteger(record['inputTokens']);
  const outputTokens = readNonNegativeInteger(record['outputTokens']);
  if (inputTokens === null || outputTokens === null) return null;
  return { type: 'usage', promptTokens: inputTokens, completionTokens: outputTokens, usageMethod: OFFICIAL_USAGE_METHOD };
}

/** @param {unknown} value @returns {number | null} */
function readNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** @param {...unknown} candidates @returns {string} */
function firstShortCode(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 64);
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return 'UNSPECIFIED';
}

/**
 * `resultType` 不在闭集内时的**如实**描述。
 *
 * 只回"类型 + 长度"，不回内容：官方那个值不来自我们写死的闭集，转发它等于把
 * 官方侧的任意字节当成诊断文案往外送（HOSTFIX6 报告 §5 定的"原始错误不转发"纪律）。
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeUnrecognizedResultType(value) {
  if (typeof value === 'string') return `<string len=${value.length}>`;
  if (value === undefined) return '<absent>';
  return `<${value === null ? 'null' : typeof value}>`;
}

/**
 * 官方 `resultType` 五个非成功值各对应一句固定文案（闭集短码，零凭据）。
 * @type {Readonly<Record<string, string>>}
 */
const OFFICIAL_TURN_RESULT_DETAIL = Object.freeze({
  cancelled: '官方 turn 被取消（resultType=cancelled）',
  error_max_turns: '官方 turn 达到轮数上限（resultType=error_max_turns）',
  error_max_budget: '官方 turn 达到预算上限（resultType=error_max_budget）',
  error_during_execution: '官方 turn 执行中出错（resultType=error_during_execution）',
  error_max_tool_calls: '官方 turn 达到工具调用上限（resultType=error_max_tool_calls）'
});

/**
 * **按官方公式算出** builtin provider config 的 revision（HOSTFIX5 · BL-2 的新落点）。
 *
 * ## 上一版是"读"，这一版是"算"——为什么必须换
 *
 * 上一版从**已经起好的官方 Provider Registry 运行时**上读：
 *  1. `runtime.configService.read().zcodeBuiltinRevision` —— 官方 `KKe`（偏移 562051）；
 *  2. `runtime.accountSource.read().basedOnZCodeBuiltinRevision` —— 官方 `yee`（偏移 556411）。
 *
 * 那份运行时来自 `startProcessProviderRegistryRuntime`，而 HOSTFIX5 起我们**不再加载
 * 官方代码**（bundle 没有任何具名导出，`require` 这条路不存在）——所以那份运行时
 * **不存在**，"读"这个动作无从谈起。只能按官方自己的公式**独立算**，而这恰好可行：
 * 那个 revision 完全由**一个文件的路径**与**那个文件里的一个数字**决定。
 *
 * ## 公式（逐字）
 *
 * ```
 * UO 构造器（偏移 587490）  this.#n = createHash("sha256").update(resolve(this.#t)).digest("hex")
 * T3i（偏移 587002）       revision: `zcode-builtin:${e.revision}:${t}`
 * ```
 *
 * 其中 `this.#t = t.activeFilePath?.trim() || n`（`n` 是 `bundledFilePath`）。本路径
 * **非 standalone**：`Ykt` 只把 `{...n}`（`zcodeBuiltinFilePath` + `personalFilePath`）展开给
 * `pZe`，而 `l = t.standalone ? e[OXe]?.trim() : void 0` 恒 `undefined`，于是 `dZe` 逐字
 * `new UO({ bundledFilePath: t.zcodeBuiltinFilePath, activeFilePath: undefined, watch: undefined })`
 * → **`active = bundled = ` `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 的值**。
 * 官方 app-server 读的是**同一份 env**（我们用 `buildIsolatedChildEnv` 无条件下发那两个键），
 * 所以两边算出来的 revision **必然逐字相同**，`nZe` 的
 * `s.basedOnZCodeBuiltinRevision !== o.zcodeBuiltinRevision` 比对必然通过。
 *
 * ## fail-closed
 *
 * 读不到文件 / JSON 解析不出 / `revision` 不是数字 → 返回 `null`，调用方
 * **不发** `provider/updateAccountConfig`（猜错 = 官方整份丢弃 = 一条更难诊断的失败）。
 * 与官方 `bnr` 在两份都读不出来时抛 AggregateError 是同一种 fail-closed 方向。
 *
 * @param {Readonly<Record<string, string | undefined>>} env 子进程 env
 * @returns {string | null} `zcode-builtin:<rev>:<sha256>`；算不出来时 `null`
 */
export function readBuiltinProviderRevision(env) {
  const builtinFilePath = (env ?? {})['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'];
  if (typeof builtinFilePath !== 'string' || builtinFilePath.trim() === '') return null;
  const path = builtinFilePath.trim();
  /** @type {any} */
  let release;
  try {
    release = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (release === null || typeof release !== 'object' || typeof release.revision !== 'number') return null;
  const digest = createHash('sha256').update(resolvePath(path)).digest('hex');
  return `zcode-builtin:${release.revision}:${digest}`;
}

/**
 * 等官方 app-server 子进程自己退出（最多 `ms`）。**不 kill**——只观察。
 *
 * 存在的理由是"我们没留下一个还在跑的官方进程"这件事必须**可观测**，而不是靠相信。
 * 超时返回 `false`，由 `host-child.mjs` 的 `reapAppServer` 走 SIGKILL 兜底。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} ms 上限
 * @returns {Promise<boolean>} `true` = 在窗内自然退出
 */
export function waitForAppServerExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, ms);
    timer.unref?.();
    /** @returns {void} */
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('exit', onExit);
  });
}

/**
 * 剥掉官方 `{method, params}` 信封，取出真正的事件体。
 *
 * 判据逐字对应官方 `KYa`（偏移 14473456）：信封必有 `method === "session/event"`
 * 且带 `params`。裸事件（`{type, payload}`，无 `method`）原样返回——两种形态都接受，
 * 但**不猜**：`method` 不是 `session/event` 的帧一律返回 `null`，不当成事件处理。
 *
 * @param {any} message
 * @returns {any}
 */
export function unwrapSessionEvent(message) {
  if (message === null || typeof message !== 'object') return null;
  const record = /** @type {Record<string, any>} */ (message);
  if (record['method'] === undefined) return record;
  if (record['method'] !== 'session/event') return null;
  const params = record['params'];
  return params !== null && typeof params === 'object' ? params : null;
}

/**
 * 官方**事件信封**的 method 字面量。`KYa`（产物内偏移 14473456）逐字
 * `s={method:"session/event",params:n}` —— 它把内部会话事件包成这个通知发到应答流。
 *
 * **它与启动通告是同一个形状**（`{method, params}`、无 `id`），所以
 * {@link isUnsolicitedNotification} 必须显式把它**排除**，否则整个 turn 的产出
 * 会被当成"启动通告"丢掉——**这个坑是实跑踩到的**：驱动收得到 stdout 上的字节，
 * `turn.completed` 却永远不落地，会话一路空转到墙钟上限报 `SESSION_TIMEOUT`。
 */
export const OFFICIAL_SESSION_EVENT_METHOD = 'session/event';

/**
 * 这条帧是不是官方**自发的启动通告**（有 `method`、**没有 `id`**、且**不是** `session/event`）。
 *
 * ## 判据逐字（官方 `fTt` 帧 schema + `KYa` 的信封）
 *
 * 官方三类入站/出站帧的顶层键集合（都 `.strict()`，见 HOSTFIX3 报告 §1.5）：
 *  - 请求 `qir = {id, method, params?, trace?}` —— **必有 `id`**；
 *  - 通知 `Wir = {method, params?, trace?}` —— **无 `id`**；
 *  - 应答 `Vir = {id, result}` / 错误 `Hir = {id, error}` —— **必有 `id`**。
 *
 * 而在**应答流**上，无 `id` 的通知只有**两类来源**：
 *  1. **启动通告**：`{"method":"startup/storageState","params":{…}}`
 *     （I02 E-PROBE-R3-P4 协调者实跑的捕获 + HOSTFIX5 的 `%TEMP%` 冒烟，两者逐字同构；
 *      实测条数 5 或 27，从不稳定）；
 *  2. **会话事件信封**：`{"method":"session/event","params":{…}}`（`KYa` 逐字）。
 *
 * 本函数返回 `true` 的**只有第 1 类**；第 2 类必须放行到事件流，否则丢的是产出本身。
 *
 * ## 为什么必须显式识别而不是"当它不存在"
 *
 * `extractSessionId` 会遍历 `outbound` 找 `sessionId`（顶层 / `result.sessionId` /
 * `session.sessionId` 三处）。官方通知的 `params` 是**官方自己的形状**，我们不控制它；
 * 混进去就有可能被误认成 `session/create` 的回执。**丢弃即容忍**，这与官方
 * "notification ignored" 的处置一致。
 *
 * @param {unknown} frame
 * @returns {boolean}
 */
export function isUnsolicitedNotification(frame) {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return false;
  const record = /** @type {Record<string, unknown>} */ (frame);
  const method = record['method'];
  if (typeof method !== 'string' || method === '') return false;
  // **事件信封不是启动通告**：它是产出本身，必须放行（见上面的实测踩坑说明）。
  if (method === OFFICIAL_SESSION_EVENT_METHOD) return false;
  return !('id' in record);
}

/**
 * 驱动一次会话。
 *
 * **HOSTFIX5：`bundle` 没了。** 取而代之的是一个**真实的官方 app-server 子进程**：
 * `input` 是它的 `stdin`（可写），`output` 是它的 `stdout`（可读）。
 * 请求写 `input`、应答读 `output` 的方向不变（官方 `fTt` 逐字契约，见文件头）。
 *
 * @param {{
 *   child: import('node:child_process').ChildProcess,
 *   request: Record<string, any>,
 *   port: import('../../packages/official-host/src/headers-port.js').ProviderRuntimeHeadersPort,
 *   emit: (payload: unknown) => void,
 *   timeoutMs?: number
 * }} deps
 * @returns {Promise<DriveSessionSummary>} 会话摘要。**零凭据**：只有应答计数与
 *   最后一次应答的结构化结果（`refusalCode` / `headersApplied`），没有 apiKey、没有
 *   providerId 回显、没有路径。`host-child.mjs` 刻意**不**把它写进任何父通道帧。
 */
export async function driveSession({ child, request, port, emit, timeoutMs }) {
  /** 反向请求应答计数。**只用于诊断与测试观测**，不进任何父通道帧。 */
  let reverseRequestsAnswered = 0;
  /** @type {Record<string, number>} 按 method 分组的应答计数（键是 method 字面量）。 */
  const reverseRequestsByMethod = {};
  /** HOSTFIX5：官方自发、无 `id` 的通知条数（r2：容忍，不答，不混进事件流）。 */
  let unsolicitedNotificationsIgnored = 0;
  /** @type {import('./reverse-responder.mjs').ReverseResponseSummary | null} */
  let lastReverseSummary = null;
  /** @type {import('./reverse-responder.mjs').RuntimePreferencesSummary | null} */
  let lastRuntimePreferencesSummary = null;
  /** COMPAT1/C4：最后一次工具权限应答的摘要。**零凭据**。 */
  /** @type {import('./reverse-responder.mjs').ToolPermissionSummary | null} */
  let lastToolPermissionSummary = null;
  /** COMPAT1/C4：最后一次用户输入应答的摘要。**零凭据**。 */
  /** @type {import('./reverse-responder.mjs').UserInputSummary | null} */
  let lastUserInputSummary = null;
  /**
   * COMPAT1/C4：两条 env 策略**在这里、且只在这里**解析一次。
   *
   * 放在 `driveSession` 最开头（`try` 之外）是刻意的：闭集外的取值要在
   * **任何官方帧都没发出去之前**就失败化。若放在应答器里现解析，一个坏值会在
   * `output` 的 `data` 回调里抛——那是在事件循环回调中，不在 `driveSession` 的
   * `try` 里，于是它会变成子宿主里一条**未捕获异常**而不是一次可上报的失败。
   *
   * 解析结果全程复用，所以"策略会不会中途变"这条问题不存在（env 也不会中途变）。
   *
   * @type {'allow' | 'deny'}
   */
  const toolPolicy = resolveHostToolPolicy(process.env);
  /** @type {string} */
  const permissionMode = resolveHostPermissionMode(process.env);
  const startedAt = Date.now();

  /** @type {string[]} */
  const buffer_ = [];
  /** @type {string[]} */
  const outbound = [];
  let outboundDone = false;
  /** @type {Array<() => void>} */
  const waiters = [];

  /**
   * 把从官方 **stdout** 读到的字节切成行。非 JSON 行丢弃并继续——
   * 不猜它是什么，也不让它卡住等待。
   *
   * @param {string} text
   */
  function pushOutbound(text) {
    let at = text.indexOf('\n');
    if (at < 0) {
      buffer_.push(text);
      return;
    }
    let rest = text;
    while (at >= 0) {
      buffer_.push(rest.slice(0, at));
      rest = rest.slice(at + 1);
      at = rest.indexOf('\n');
    }
    buffer_.push(rest);
    flushBuffered();
  }

  function flushBuffered() {
    while (buffer_.length > 0) {
      const line = /** @type {string} */ (buffer_.shift());
      if (line.trim() === '') continue;
      const parsed = safeParse(line);
      if (parsed === null) continue;
      // **反向请求不进事件流**：官方 `pTt.requestClient` 把它的帧写到应答流
      // （即子进程 stdout，也就是我们这条流）。这类帧既不是对 `session/*` 的应答，
      // 也不是 `session/event`，让它混进 `outbound` 只会污染 `extractSessionId` /
      // `mapOfficialEventToChannel` 的输入。识别出来就地应答掉（见文件头"出站凭据闸门"）。
      //
      // **两条反向请求，判别互斥**（各自按 method 字面量）且**处理方式不同**：
      //  - `session/requestRuntimePreferences`（HOSTFIX4）：**同步**应答，值恒定。
      //    它挂在 `session/create` 的关键路径上（`CXa` → `CKo`，`timeoutMs: 15e3`），
      //    不答就是 15 秒后整轮 `session/create` 抛掉。
      //  - `interaction/requestProviderRuntimeHeaders`（HOSTFIX3）：**异步**应答，
      //    要过我们的 port（唯一出站凭据闸门）。
      if (isSessionRequestRuntimePreferencesRequest(parsed)) {
        answerSessionRuntimePreferences(/** @type {Record<string, any>} */ (parsed));
        continue;
      }
      // **COMPAT1/C4：工具权限 / 用户输入**。同样是**同步**应答、同样的理由——
      // 官方 `pTt.requestClient` 对这两条**没有设 `timeoutMs`**（`dRn` 逐字只给
      // `{sessionId, kind, …}`），所以不答就是 promise 永不落定、挂到我们自己的
      // 300 s 墙钟上限。处置与上面两条**不同**的是"答什么"：权限按策略允许/拒绝，
      // 用户输入恒取消（子宿主没有交互式用户通道）。
      if (isToolPermissionRequest(parsed)) {
        answerToolPermission(/** @type {Record<string, any>} */ (parsed));
        continue;
      }
      if (isUserInputRequest(parsed)) {
        answerUserInput(/** @type {Record<string, any>} */ (parsed));
        continue;
      }
      if (isProviderRuntimeHeadersRequest(parsed)) {
        answerProviderRuntimeHeaders(/** @type {Record<string, any>} */ (parsed));
        continue;
      }
      // **HOSTFIX5 · r2：容忍官方自发的无 id 通知。**
      //
      // 官方 app-server 在我们写零帧时就自发吐出 `{method, params}` 的
      // `startup/storageState` 通知（顶层**无 `id`**，实测条数 5 或 27）。官方
      // `fTt.dispatchLine` 对 id 缺省的帧逐字记 `"ZCode Protocol notification ignored"`。
      //
      // 处置必须**唯一**：**不答**（不是反向请求）、**不误判**（上面两个判别器都要求
      // `id` 在场，已天然排除）、**不进 outbound**（否则 `extractSessionId` 会拿
      // 通知 `params` 里的字段去认 `session/create` 的回执）。**只计数。**
      if (isUnsolicitedNotification(parsed)) {
        unsolicitedNotificationsIgnored += 1;
        continue;
      }
      outbound.push(line);
    }
    if (buffer_.length === 0) {
      for (const waiter of waiters.splice(0)) waiter();
    }
  }

  /**
   * 应答一条 `session/requestRuntimePreferences` 反向请求（HOSTFIX4）。
   *
   * **同步**，且**必然应答**。理由逐字见 `reverse-responder.mjs`：
   * 官方 `CKo`（偏移 14509003）的 catch 对超时码 `-32022` 是 `throw l`
   * （只对 `-32601` / `-32020` 给默认对象），而 `await ERn(...)` 在 `UKo` 的 `try` 之外
   * ——不答就是 `session/create` 整轮抛掉、拿不到 sessionId、驱动空转到 300 s 上限。
   *
   * **零凭据、零 I/O、零新状态**：应答值是三个布尔常量，不碰 port、不碰凭据仓、
   * 不碰 `request` 里的任何东西。
   *
   * @param {Record<string, any>} frame
   */
  function answerSessionRuntimePreferences(frame) {
    reverseRequestsAnswered += 1;
    reverseRequestsByMethod[REVERSE_REQUEST_RUNTIME_PREFERENCES] =
      (reverseRequestsByMethod[REVERSE_REQUEST_RUNTIME_PREFERENCES] ?? 0) + 1;
    const { frame: response, summary } = resolveSessionRuntimePreferencesResponse({ frame });
    // 逐字只放两个键：`Vir` 是 `.strict()` 的（偏移 735705）。
    input.write(`${JSON.stringify({ id: response.id, result: response.result })}\n`);
    lastRuntimePreferencesSummary = summary;
  }

  /**
   * 应答一条 `interaction/requestPermission`（工单 COMPAT1/C4）。
   *
   * **同步**、**必答**。策略来自 env `ZCC_HOST_TOOL_POLICY`（闭集 `allow|deny`，
   * 缺省 `allow`，理由与逐字依据见 `reverse-responder.mjs`）。
   *
   * **策略解析失败立刻抛**：闭集外的值**不回落**——那会让"配置写了什么"与
   * "实际生效什么"分叉。抛在这里 = 这次会话失败化，而不是带着一个猜出来的权限
   * 语义去跑官方 agent 的工具。
   *
   * @param {Record<string, any>} frame
   */
  function answerToolPermission(frame) {
    reverseRequestsAnswered += 1;
    reverseRequestsByMethod[REVERSE_REQUEST_PERMISSION] =
      (reverseRequestsByMethod[REVERSE_REQUEST_PERMISSION] ?? 0) + 1;
    const { frame: response, summary } = resolveToolPermissionResponse({ frame, policy: toolPolicy });
    input.write(`${JSON.stringify({ id: response.id, result: response.result })}\n`);
    lastToolPermissionSummary = summary;
  }

  /**
   * 应答一条 `interaction/requestUserInput`（工单 COMPAT1/C4）。
   *
   * **恒回 `action:"cancel"`**，不策略化：子宿主**没有**交互式用户输入通道，
   * `accept` 意味着"我们替用户答了"（与 `askUserQuestionAutoResolutionEnabled:false`
   * 同一个立场），`decline` 暗示"有人看了然后拒绝"（不属实）。理由与逐字依据见
   * `reverse-responder.mjs`。
   *
   * @param {Record<string, any>} frame
   */
  function answerUserInput(frame) {
    reverseRequestsAnswered += 1;
    reverseRequestsByMethod[REVERSE_REQUEST_USER_INPUT] = (reverseRequestsByMethod[REVERSE_REQUEST_USER_INPUT] ?? 0) + 1;
    const { frame: response, summary } = resolveUserInputResponse({ frame });
    input.write(`${JSON.stringify({ id: response.id, result: response.result })}\n`);
    lastUserInputSummary = summary;
  }

  /**
   * 应答一条 provider runtime headers 反向请求，并把 `{id, result}` 写回 `input`。
   *
   * 官方 `pTt.resolveClientRequest` 逐字 `String(t)` 查 `pendingClientRequests`，
   * 而那张表是 `requestClient` 逐字 `String(\`server-${n++}\`)` 建的——所以**必须原样回 `id`**，
   * 一个字符都不能差。
   *
   * 明文边界：应答帧只走内存 `input` 流（官方在**本进程**里消费），不进父通道。
   *
   * @param {Record<string, any>} frame
   */
  function answerProviderRuntimeHeaders(frame) {
    reverseRequestsAnswered += 1;
    reverseRequestsByMethod[REVERSE_REQUEST_PROVIDER_RUNTIME_HEADERS] =
      (reverseRequestsByMethod[REVERSE_REQUEST_PROVIDER_RUNTIME_HEADERS] ?? 0) + 1;
    void resolveProviderRuntimeHeadersResponse({ frame, port, expectedProviderId: String(request.providerId) })
      .then(({ frame: response, summary }) => {
        // 逐字只放两个键：`Vir` 是 `.strict()` 的。
        const wire = { id: response.id, result: response.result };
        input.write(`${JSON.stringify(wire)}\n`);
        lastReverseSummary = summary;
      })
      .catch(() => {
        // 应答器**不会**抛（它把一切都转成拒答帧）；这一支是"连拒答都写不出去"的兜底。
        // 官方会在 180 s 后以 `-32022` 超时失败——不会静默放行。
        lastReverseSummary = { id: String(frame.id), providerIdMatched: false, headersApplied: false, refusalCode: 'UNEXPECTED' };
      });
  }

  // **HOSTFIX5：流不再是我们造的内存流，而是官方 app-server 子进程的真实管道。**
  // 方向不变（请求进 `input`、应答出 `output`，见文件头"流的方向"），
  // 变的只是 `input` 是它的 stdin、`output` 是它的 stdout。
  const childStdin = child.stdin;
  const childStdout = child.stdout;
  if (childStdin === null || childStdout === null) {
    throw new Error('APP_SERVER_STDIO_UNAVAILABLE: 官方 app-server 没有可用的 stdio 管道');
  }
  const input = childStdin;
  const output = childStdout;
  // 读应答只认 `output`；`input` 上的 data 事件对我们没有意义（官方不会往请求流写）。
  output.on('data', (/** @type {Buffer|string} */ chunk) => {
    pushOutbound(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });
  output.on('end', () => {
    outboundDone = true;
    for (const waiter of waiters.splice(0)) waiter();
  });
  // 子进程提前退出（官方 fatal）时 stdout 可能根本不 `end`；把 `outboundDone` 落定，
  // 否则下面那些 `while (… && Date.now() < deadline)` 会空转到 300 s 墙钟上限。
  // 崩溃隔离仍然成立：那只是一次 `exit` 事件，父进程把它转成该次请求失败。
  child.on('exit', () => {
    outboundDone = true;
    for (const waiter of waiters.splice(0)) waiter();
  });
  // **补挂后再看一眼**：官方 app-server 完全可能在我们挂监听器**之前**就退出
  // （启动参数错、env 前置检查不过、bundle 损坏……）。那种情况下 `exit` 与 `end` 事件
  // **都已经发过了**，再挂就永远收不到——驱动会一路空转到 300 s 墙钟上限才报
  // `SESSION_CREATE_NO_SESSION_ID`，而正确姿势是**立刻**失败化。实测踩到过：
  // 用一个"立刻 exit 3"的假 bundle 时，本子宿主会挂满 8 s 墙钟上限才被父进程收掉。
  if (child.exitCode !== null || child.signalCode !== null) {
    outboundDone = true;
    for (const waiter of waiters.splice(0)) waiter();
  }

  // **BL-2：真实 builtin revision 现在由本子宿主自己按官方公式算。**
  // 上一版靠 `startProcessProviderRegistryRuntime` 起一份同进程运行时再从上面读，
  // 而 HOSTFIX5 起我们**不再加载官方代码**，那份运行时不存在了。
  // 公式逐字见文件头"`basedOnZCodeBuiltinRevision` 现在由本子宿主自己算"。
  const runtimeBuiltinRevision = readBuiltinProviderRevision(process.env);
  //
  // 下面这一大段（`createZCodeApp` 调用的删除理由、`startRegistryRuntime` 那个
  // **自己起的运行时**的 dispose 义务）在 HOSTFIX5 起**整条不存在**了——不是被注释掉：
  //  - 我们不再 `createZCodeApp`（app 由**官方 app-server 进程自己**建），所以
  //    "删除这次调用"变成了"这条调用点在本进程里根本不存在"。删除的理由逐字不变：
  //    `NXo`（偏移 14678273）的 9 键 options 面没有 `providerRuntimeHeadersPort` 槽位，
  //    而 `Hxt`（偏移 14436209）的三个调用点（`QJo` / `rZo` / `session/create`）
  //    **都不传**那个键 → 那条 port 结构上不可达。
  //  - 我们不再 `startProcessProviderRegistryRuntime`（没有运行时可 dispose，也就没有
  //    Windows `fs.watch` 保活句柄那个新义务）。
  // 代价是诚实的记在这里：少了一个"启动期身份闸门"（`REQUIRED_EXPORTS` 预检），
  // 换来的是**唯一真实存在的官方入口**。新的 fail-closed 落点是会话层：
  // 官方进程起不来 = `BUNDLE_SPAWN_FAILED`；起来了却不按协议应答 = 超时/协议违规。

  const id = `zcc-host-${request.operationId}`;
  //
  // **HOSTFIX6：阶段标记声明在 `try` 之外**，这样下面那个 `catch` 才读得到它们。
  // 为什么要 `try`：`driveSession` 抛错时（`SESSION_TIMEOUT` /
  // `SESSION_CREATE_NO_SESSION_ID` / `APP_SERVER_STDIO_UNAVAILABLE`）**成功摘要
  // 根本不会被构造**，于是 HOSTFIX4 那行 `ZCC_HOST_DEBUG` 诊断行**一次都打不出来**。
  // 而"打不出诊断行"恰恰发生在最需要它的时候——2026-10-01 实弹第二轮挂满 300 s，
  // 留下的唯一线索是"什么都没打"。所以失败路径也把**同形**的阶段摘要挂到错误对象上，
  // 由 `host-child.mjs` 在 `ZCC_HOST_DEBUG=1` 时打出来。
  //
  // **行为一个字没变**：`catch` 只挂一个属性再 `throw`，不改错误类型、不改错误码、
  // 不改父通道帧（那个新属性只进 stderr 诊断行，而 stderr 内容**从不**被父进程读取）。
  /** 阶段耗时（ms）。**只在内存里**，只进 {@link DriveSessionSummary}。 */
  /** @type {number | null} */
  let accountConfigMs = null;
  /** `session/create` 阶段耗时。`null` = 压根没走到发 `session/create` 之后（诊断关键位）。 */
  /** @type {number | null} */
  let sessionCreateMs = null;
  /** turn 阶段起点。`null` = 没走到发 `session/send`。 */
  /** @type {number | null} */
  let turnStartedAt = null;
  /**
   * **没被 {@link mapOfficialEventToChannel} 认出来**的官方事件类型，按官方字面量计数。
   *
   * HOSTFIX6 立这一位时的判断**已被 HOSTFIX7 证伪并更正**：那版把键写成官方**内部**
   * 枚举（`lt` 的 `turn_complete` / `model_complete` …，下划线）。真实上线路径
   * `mapSessionEvent`（`$xt`）逐字用 `type: jZa(e.type)`，发出去的是**点号**
   * （{@link OFFICIAL_SESSION_EVENT_TYPES} 那 25 项）。下划线闭集只出现在官方**自己的
   * 日志与 SQLite** 里（实弹逐字 `"sessionEventType":"turn_complete"`）——
   * **它不上线**。所以这张表的键一律是**线上点号字面量**。
   *
   * 键**只取 `params.type` 这一层**，不掺 `payload.kind`：那才是官方 envelope 的判别位
   * （`eGt` 逐字 `m.discriminatedUnion("type", …)`），掺进去就等于造出第二套键空间。
   * 官方闭集里那 21 种我们不接的类型（如 `tool.updated` / `part.delta`）照实计数，
   * 闭集之外的字面量也照实计数——**计数，不猜**。
   *
   * **零凭据**（不含 prompt、不含正文、不含路径、不含 usage 数字）。
   * 条数封顶 {@link UNMAPPED_EVENT_TYPE_CAP}，**键长**封顶
   * {@link UNMAPPED_EVENT_TYPE_MAX_KEY_CHARS}（HARDEN1）——两条上限各管一件事：
   * 前者管**有多少个键**，后者管**每个键有多长**。缺了后者，一次官方异常的长
   * `type` 就能把实弹排障时唯一有用的那几行诊断淹掉。
   *
   * @type {Record<string, number>}
   */
  const unmappedEventTypes = {};
  /**
   * 本轮（一次 `driveSession` 调用 = 一次 turn）**已经产出过**至少一条 `delta`。
   * 只用于 `turn.completed` 的正文兜底，见 {@link consumeEventLine}。
   * @type {boolean}
   */
  let deltaEmittedThisTurn = false;
  try {
  // 账号/entitled 的**唯一**真实注入面：`provider/updateAccountConfig`。
  // 见文件头"账号/entitled 的真实注入面"——它在 `session/create` 之前发，
  // 否则官方 effective-selection 的 `Tt = L && rt && Pe && …` 会把模型判成不可执行。
  const accountPatch = await buildAccountConfigPatch(request, runtimeBuiltinRevision);
  if (accountPatch !== null) {
    const accountStartedAt = Date.now();
    const accountRequestId = `${id}-acct`;
    writeRequest(input, buildOfficialRequest(accountRequestId, 'provider/updateAccountConfig', accountPatch));
    // 等它回执，然后**把这一帧的应答抽干**。不抽干的话，下一步等 session/create
    // 时会被"outbound 已非空"提前唤醒，读到的还是这条账号回执。
    //
    // **HOSTFIX6：这里必须"等到属于这个 id 的那一帧"，不能只 settle 一次。**
    // `settle` 的唤醒条件是"buffer 空了"，而官方**自发的启动通告**同样会触发它——
    // 实测（`%TEMP%` 替身 + 直连探针）：账号帧写出去之后，官方先吐了 5 条
    // `startup/storageState`，`settle` 立刻返回，`drainOutbound()` 拿到的是**空数组**。
    // 于是"官方拒了账号帧"这条错误应答就**根本没被看过**——这正是上一版
    // 300 s 挂死的最后一环。
    const accountRejected = await waitForResponseFor(accountRequestId, 2000);
    // **HOSTFIX6：账号帧被拒必须立刻失败化。**
    // 上一版把这一段的应答抽干之后就**再也不看**，于是官方那条
    // `-32603 ZodError（unrecognized_keys: accountType, mode）` 被静默丢掉，
    // 后果一路传到 300 s 墙钟上限才暴露成 `SESSION_CREATE_NO_SESSION_ID`。
    if (accountRejected !== null) {
      throw new Error(`ACCOUNT_CONFIG_REJECTED: ${accountRejected}`);
    }
    accountConfigMs = Math.max(0, Date.now() - accountStartedAt);
  }

  const sessionCreateStartedAt = Date.now();
  writeRequest(input, buildOfficialRequest(id, 'session/create', {
    workspace: { workspacePath: request.workspacePath, workspaceKey: request.workspacePath },
    // **HOSTFIX6：`model.options.reasoningLevel` 必填。**
    //
    // 实弹（2026-10-01，官方 `bootstrap.app.startup.failed` 逐字）第三次栽在这里：
    // `error.name = "ModelProtocolError"` /
    // `error.message = "Reasoning level is required for account:zai-start-plan/GLM-5.3-Flash"` /
    // `error.code = "invalid_model_request"`。
    //
    // 逐字依据（官方产物，只读核对）：
    //  - 模型选择 schema `Pu` 逐字
    //    `m.object({providerId, modelId, options: m.object({reasoningLevel: m.string().trim().min(1).optional()}).strict().optional()}).strict()`
    //    ——`options` 在 schema 上**可省**，但省了之后下面那条校验就过不去；
    //  - 校验 `bpe` 逐字
    //    `let n = t.options?.reasoningLevel; … return n === void 0 ? {ok:!1, code:"reasoning-level-missing", …} : o.values.includes(n) ? {ok:!0} : {ok:!1, code:"reasoning-level-not-supported", …}`
    //    ——**`reasoningLevel` 实际是必填的**，且必须落在该模型
    //    `config.optionSpecs.reasoningLevel.values` 之内；
    //  - `session/create` 的初始模型走 `Vie(registry, selection)`，**不**带
    //    `allowMissingReasoning`（只有 `setModel` 那条带），所以缺了**直接抛**。
    //
    // 取值：本驱动 `REASONING_TO_THOUGHT_LEVEL` 的闭集 `low|high|max` 正是官方对
    // GLM-5.3 系列的取值——官方 builtin config 里那条逐字
    // `modelMatch: ".*glm-5\.3(?:-flash)?(?:[.\-:/\[].*)?"` 的
    // `optionSpecs.reasoningLevel.values` 恰是 `["low","high","max"]`。
    // 不支持的档位会被官方以 `reasoning-level-not-supported` 拒掉，而现在我们
    // **毫秒级**失败化（见上面两处 `*_REJECTED`），不会再伪装成挂死。
    model: {
      providerId: request.providerId,
      modelId: request.modelId,
      options: { reasoningLevel: request.thoughtLevel }
    },
    thoughtLevel: request.thoughtLevel,
    // **COMPAT1/C4：官方 `nGt` 的 `mode`（逐字 `$j=m.enum(["plan","build","edit","yolo","auto"])`）**。
    // 缺省 `yolo` = 官方 `PermissionService.checkPermission` 逐字那条
    // `this.allow(t,a,"mode.yolo","Yolo mode bypasses permission prompts")`，
    // 于是普通工具**不再**走 `decision==="ask"` → `permissionBroker.requestPermission`
    // 那条反向请求。逐字链路见 {@link OFFICIAL_SESSION_MODES} 的注释。
    //
    // **它不是总闸门**：`requiresUserInteraction` / `alwaysAsk` 两类能力仍在
    // `mode` 判定**之前**就 `return this.ask(...)`，所以
    // {@link answerToolPermission} 那条反向应答器**必须**同时存在。
    mode: permissionMode
    // **COMPAT2 删掉的那一行**（原 `...(request.maxTokens === null ? {} : { maxTokens: request.maxTokens })`）
    // **逐字理由**（官方 `C:\ZCode\resources\glm\zcode.cjs`，只读）：
    //  1. `session/create` 的 params schema 是偏移 757102 的
    //     `nGt=m.object({sessionId,workspace,parentSessionId,mode,model,persistence,
    //      thoughtLevel,titleGenerationEnabled,mcpServers,toolAllowlist,toolDenylist,
    //      importedHistory,offPeakToolEnabled,dynamicWorkflowEnabled}).strict()`
    //     —— **`.strict()`，逐字没有 `maxTokens` 这个键**。
    //  2. 嵌套的 `model` 子 schema 是偏移 508944 的
    //     `Pu=m.object({providerId,modelId,options:{reasoningLevel}}).strict()`，
    //     同样 `.strict()`、同样没有上限槽位。
    //  3. 官方在偏移 14479993 的 `UKo` 里逐字 `yl(nGt,t)`，而 `yl`（偏移 14131416）
    //     逐字是 `function yl(e,t){try{return e.parse(t)}catch(n){…throw new sf(-32602,"Invalid params")}}`
    //     —— 于是**任何带 `maxTokens` 的 params 都被官方以 `-32602 Invalid params` 拒掉**。
    // 2026-10-02 D3 实弹：带 `max_completion_tokens` 的请求 1.2 s 后
    // `upstream_outcome_unknown`，宿主日志里 app-server 起完 126 ms 就 `shutdown.completed`、
    // 没有任何 session 活动 —— 与"params 被 strict 校验拒掉"逐字吻合。
    // 现在上限由 API 层如实披露为"未转发"（`zcc.parameters_not_forwarded` 里带客户端
    // 发来的那个键名，`zcc.max_tokens_enforced:false`），不再拿它去毒化官方协议面。
  }));
  // **边等边扫**：官方对 session/create 的回执可能与账号回执、乃至更早的行挤在
  // 同一次 output 写入里。只"等 outbound 非空再整表扫一遍"会漏——因此这里
  // 逐行消费直到认出 sessionId。
  const deadline = Date.now() + (timeoutMs ?? SESSION_TIMEOUT_MS);
  /** @type {string[]} */
  const pending = [];
  /** @type {string | null} */
  let sessionId = null;
  // `!outboundDone`：官方 app-server 已经退出的那一刻，等待**不可能再有结果**，
  // 必须立刻落定成失败——否则这里会变成一段**忙等**（settle 立即返回、循环空转
  // 300 s），把一次"起不来"伪装成一次"慢响应"。
  while (sessionId === null && !outboundDone && Date.now() < deadline) {
    for (const line of drainOutbound()) {
      // **HOSTFIX6：官方对 `session/create` 的错误应答必须立刻失败化。**
      // 实弹第二轮的官方日志逐字：
      //   `zcode_protocol.session_create.failed` / `durationMs: 482` /
      //   `errorMessage: "Provider Registry 中不存在 Model: account:zai-start-plan/GLM-5.3-Flash"`
      // 官方在 **482 ms** 就拒了，驱动却空转到 **300 000 ms** 才报
      // `SESSION_CREATE_NO_SESSION_ID`——把"毫秒级拒绝"伪装成"慢响应"。
      // 这一段现在同时回答两件事：**拒了没有**（毫秒级）、**为什么拒**（精确短码）。
      const createRejected = findOfficialErrorFor([line], id);
      if (createRejected !== null) {
        throw new Error(`SESSION_CREATE_REJECTED: ${createRejected}`);
      }
      const found = extractSessionId([line]);
      if (found !== null) {
        sessionId = found;
        break;
      }
      pending.push(line);
    }
    if (sessionId !== null) break;
    await settle(outbound, waiters, outboundDone, 100);
  }
  if (sessionId === null) {
    throw new Error('SESSION_CREATE_NO_SESSION_ID: 官方未回报 sessionId');
  }
  // **这一段的耗时是 HOSTFIX4 的核心观测值**：官方在 `session/create` 关键路径上
  // 会发一条 `session/requestRuntimePreferences`（`CKo`，`timeoutMs: 15e3`）。
  // 答了就是**毫秒级**；不答就是 **≥15000 ms**，而且随后整轮失败。
  // 也就是说这一个数字就能一眼分辨"HOSTFIX4 修没修好"。
  sessionCreateMs = Math.max(0, Date.now() - sessionCreateStartedAt);

  // ------------------------------------------------------------------ //
  // HOSTFIX7 的首要修复：先订阅，再发 turn。                            //
  //                                                                     //
  // 官方 `kXa`（偏移 14506989）逐字 `…, !t.deliveryKind) return;`：     //
  // 协议侧会话记录上没有 `deliveryKind` 就**一条 `session/event` 都不发**。//
  // `session/create` 的 params（`nGt`）没有这个键，建出来的记录（`EXa` 返 //
  // 回的 `R`）也没有这个字段。全仓唯一两处赋值都在 `session/read` 与     //
  // `session/subscribe` 的处理函数里。                                   //
  //                                                                     //
  // 放在 `session/send` **之前**是必须的：反过来的话，订阅生效到发 turn  //
  // 之间官方产出的事件会永久丢失（官方不做补发，除非请求带 `afterSeq`）。 //
  // ------------------------------------------------------------------ //
  writeRequest(input, buildOfficialRequest(id, 'session/subscribe', {
    sessionId,
    // 闭集成员（逐字 `kV`），不构造闭集外的值。
    deliveryKind: OFFICIAL_DELIVERY_KIND
  }));
  // 与账号帧同一条纪律：**等到属于这个 id 的那一帧**再往下走，拒了立刻失败化。
  // 区别是这里**不丢**别的行——抽干 outbound 时把非本 id 的行原样塞回 `pending`，
  // 让 turn 段照常消费（`waitForResponseFor` 会静默丢掉它们，那在订阅刚生效、
  // 事件可能已经在路上的边界上会丢产出）。
  //
  // **超时/官方已退出也失败化**（`noResponse`）：官方那一步只是纯簿记，正常是毫秒级；
  // 拿不到应答就意味着"事件可能根本不会来"，继续往下跑就是拿 300 s 上限去换一个
  // 早已注定的 `SESSION_TIMEOUT`。诚实失败比伪装成慢响应好。
  const subscribeOutcome = await awaitResponseFor(id, SUBSCRIBE_RESPONSE_TIMEOUT_MS, pending);
  if (!subscribeOutcome['received']) {
    throw new Error(
      `SESSION_SUBSCRIBE_NO_RESPONSE: 官方在 ${SUBSCRIBE_RESPONSE_TIMEOUT_MS} ms 内没有回 session/subscribe 的应答` +
        `${outboundDone ? '（官方 app-server 已退出）' : ''}`
    );
  }
  if (subscribeOutcome['error'] !== null) {
    throw new Error(`SESSION_SUBSCRIBE_REJECTED: ${subscribeOutcome['error']}`);
  }

  turnStartedAt = Date.now();
  writeRequest(input, buildOfficialRequest(id, 'session/send', {
    sessionId,
    content: request.prompt,
    inputId: request.operationId,
    queryId: request.operationId
  }));

  let finished = false;
  // 同上：进程已经没了就不要再空转。
  while (!finished && !outboundDone && Date.now() < deadline) {
    for (const line of pending.splice(0)) {
      // **HOSTFIX6：`session/send` 的错误应答同样立刻失败化**（与 create 段同一条纪律）。
      // 实测官方对 `session/send` 只回 `{accepted:true}`，但拒绝路径（模型不可执行、
      // 会话已关闭、参数不合法）同样回 `{id, error}`，那一条也不能被空转到墙钟上限。
      const sendRejected = findOfficialErrorFor([line], id);
      if (sendRejected !== null) throw new Error(`SESSION_SEND_REJECTED: ${sendRejected}`);
      if (consumeEventLine(line)) finished = true;
    }
    if (finished) break;
    await settle(outbound, waiters, outboundDone, 100);
    for (const line of drainOutbound()) {
      const sendRejected = findOfficialErrorFor([line], id);
      if (sendRejected !== null) throw new Error(`SESSION_SEND_REJECTED: ${sendRejected}`);
      if (consumeEventLine(line)) finished = true;
    }
  }

  writeRequest(input, buildOfficialRequest(id, 'session/close', { sessionId }));
  input.end();
  // **HOSTFIX5：等官方 app-server 自己走完 shutdown 链。**
  // 实测（I02 E-PROBE-R3-P4 + 本轮 `%TEMP%` 冒烟）：关掉它的 stdin 之后它**自然**
  // `exit 0`、stderr 0 字节。所以这里等的是一个**预期会发生**的事实，不是靠超时兜底；
  // 真没退也不会把本函数挂死（`APP_SERVER_EXIT_GRACE_MS` 之后返回，由 `host-child.mjs`
  // 的 `reapAppServer` 走 SIGKILL 兜底——仍然只对**我们自己 spawn 的句柄**动手）。
  await waitForAppServerExit(child, APP_SERVER_EXIT_GRACE_MS);
  if (!finished) throw new Error('SESSION_TIMEOUT: 会话在墙钟上限内没有收到终态事件');

  return {
    reverseRequestsAnswered,
    reverseRequestsByMethod: Object.freeze({ ...reverseRequestsByMethod }),
    unsolicitedNotificationsIgnored,
    lastReverse: lastReverseSummary,
    lastRuntimePreferences: lastRuntimePreferencesSummary,
    lastToolPermission: lastToolPermissionSummary,
    lastUserInput: lastUserInputSummary,
    permissionMode,
    toolPolicy,
    phaseDurationsMs: Object.freeze({
      accountConfig: accountConfigMs,
      sessionCreate: /** @type {number} */ (sessionCreateMs),
      turn: Math.max(0, Date.now() - /** @type {number} */ (turnStartedAt)),
      total: Math.max(0, Date.now() - startedAt)
    }),
    unmappedOfficialEventTypes: Object.freeze({ ...unmappedEventTypes })
  };
  } catch (e) {
    // HOSTFIX6：把**失败当时**的阶段摘要挂到错误对象上再原样抛出。
    //
    // 挂的属性名 `zccHostPartialSummary` 是我们自己的约定，只有 `host-child.mjs`
    // 的诊断分支读它；它**不进**父通道帧、**不进**任何错误消息（那个消息走
    // `sanitizeChildDetail` 的白名单归一），只进 `ZCC_HOST_DEBUG=1` 时的 stderr 一行。
    //
    // 抛出的**不是**这个错误：原错误对象、原 message、原类型原样上抛，
    // 所以父进程看到的失败码与文案**一个字都没变**。
    if (e !== null && typeof e === 'object') {
      try {
        Object.defineProperty(e, 'zccHostPartialSummary', {
          value: buildPartialSummary(),
          enumerable: false,
          configurable: true,
          writable: true
        });
      } catch {
        /* 冻结的 Error 对象挂不上属性：诊断行缺失，但失败路径本身照常。 */
      }
    }
    throw e;
  }

  /**
   * 等到**属于 `requestId` 的那一帧应答**出现（或到期限 / 官方退出）。
   *
   * ## 为什么不能只 `settle` 一次（HOSTFIX6 实测踩到）
   *
   * `settle` 的唤醒条件是 `flushBuffered` 末尾的 `if (buffer_.length === 0)`，
   * 也就是"**读缓冲空了**"，而**不是**"outbound 里有东西了"。官方 app-server
   * 自发的 5–27 条 `startup/storageState` 通知同样会满足它——它们被
   * `isUnsolicitedNotification` 计数后丢掉，**一行都不进 outbound**。
   * 于是 `await settle(...); drainOutbound()` 拿到的是**空数组**，
   * 随后的错误应答根本没被看过。
   *
   * 本函数因此**按 id 判**：每一轮都抽干 outbound、逐行判"是不是这个 id 的应答"，
   * 没判到就再等 50 ms。**有界**（`ms` 上限 + 官方退出即止），不忙等。
   *
   * ## HOSTFIX7：多一个 `keep` 参数
   *
   * 抽干 outbound 时，**不属于本 id 的行默认仍然被丢掉**（那是 HOSTFIX6 定的
   * 语义，账号帧那一段就靠它避免残留）。但 `session/subscribe` 那一段不能丢：
   * 订阅一生效，官方就可能开始推 `session/event`，那些行会被这一轮抽走。
   * 传 `keep` 就把它们**原样放回** `pending`，交给 turn 段照常消费。
   *
   * @param {string | number} requestId
   * @param {number} ms 上限
   * @param {string[]} [keep] 非本 id 的行塞回这里（可选）
   * @returns {Promise<string | null>} 该 id 的错误应答短描述；没有则 `null`
   */
  async function waitForResponseFor(requestId, ms, keep) {
    const outcome = await awaitResponseFor(requestId, ms, keep);
    return outcome['error'] ?? null;
  }

  /**
   * {@link waitForResponseFor} 的**带状态**版本：把"没等到任何应答"与"等到了成功应答"
   * 分开。
   *
   * HOSTFIX7 的 `session/subscribe` 必须分：**订阅失败还继续往下跑，就等于把
   * "收不到任何 `session/event`"这个状态原样放行**——那正是我们这一轮在修的
   * 300 秒挂死，fail-open 会让它以另一个名字回来。
   *
   * @param {string | number} requestId
   * @param {number} ms 上限
   * @param {string[]} [keep] 非本 id 的行塞回这里
   * @returns {Promise<{ received: boolean, error: string | null }>}
   */
  async function awaitResponseFor(requestId, ms, keep) {
    const wanted = String(requestId);
    const deadline = Date.now() + ms;
    for (;;) {
      for (const line of drainOutbound()) {
        const parsed = safeParse(line);
        if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
          if (keep !== undefined) keep.push(line);
          continue;
        }
        const record = /** @type {Record<string, any>} */ (parsed);
        if (String(record['id']) === wanted) {
          // 本 id 的应答：认下来，同样不再回灌（它已被消费）。
          return { received: true, error: describeOfficialError(record) };
        }
        if (keep !== undefined) keep.push(line);
      }
      if (outboundDone || Date.now() >= deadline) return { received: false, error: null };
      await settle(outbound, waiters, outboundDone, 50);
    }
  }

  /**
   * 抽干已到的应答行。**消费即移除**——不抽干的话，"outbound 非空"会让下一次
   * 等待提前返回，读到的是上一帧的残留。
   *
   * @returns {string[]}
   */
  function drainOutbound() {
    return outbound.splice(0);
  }

  /**
   * 消费一条官方事件行：映射成通道事件并 `emit`，同时**记下没被认出来的事件类型**。
   *
   * ## HOSTFIX7：正文兜底（`turn.completed.payload.response`）
   *
   * 官方把**全文**也放在 `turn.completed.payload.response`（`ksr` 逐字
   * `response: m.string()`）。正常情况下它与一路流过来的 `model.streaming` /
   * `text_delta` 增量**逐字等价**（实弹两侧都是 56 字符），所以**正常不重复发**。
   *
   * 但增量可能被官方自己合批/丢弃（`RKo`/`DKo` 的 `maxChars` 与 `FYa = 250 ms`
   * 两个刷出条件），于是"整段正文一条增量都没落地"是可能的。**那种情况下只发
   * `finish` 就是一条"成功但内容为空"的假成功**——HOSTFIX6 明确拒绝过那种结果。
   * 所以：**本轮一条 `delta` 都没产出过**且官方给了非空 `response` 时，先补一条
   * 全量 `delta`。反过来（已经有增量）就**不补**，避免正文出现两遍。
   *
   * 这个兜底状态是**每轮会话重置**的（`driveSession` 每次调用都新建本函数的闭包）。
   *
   * @param {string} line
   * @returns {boolean} 这行是否带出了终态（`finish` / `failed`）
   */
  function consumeEventLine(line) {
    const parsed = safeParse(line);
    const mapped = mapOfficialEventToChannel(parsed);
    if (mapped.length === 0) {
      const type = unwrapSessionEvent(parsed)?.type;
      if (typeof type === 'string' && type !== '' && Object.keys(unmappedEventTypes).length < UNMAPPED_EVENT_TYPE_CAP) {
        // **HARDEN1：键长必须钳**（键数封顶不等于键长有界，理由见
        // {@link clampUnmappedEventTypeKey}）。闭集内的官方字面量逐字不变。
        const key = clampUnmappedEventTypeKey(type);
        unmappedEventTypes[key] = (unmappedEventTypes[key] ?? 0) + 1;
      }
    }
    /** @type {Record<string, unknown>[]} */
    const toEmit = [];
    for (const event of mapped) {
      if (event['type'] === 'turn_completed_body') {
        // 内部信号，不是通道事件（见 `readTurnCompletedResponse`）。
        if (deltaEmittedThisTurn === false) {
          const full = /** @type {{ text: string }} */ (event);
          if (full.text !== '') {
            deltaEmittedThisTurn = true;
            toEmit.push({ type: 'delta', text: full.text });
          }
        }
        continue;
      }
      if (event['type'] === 'delta') deltaEmittedThisTurn = true;
      toEmit.push(event);
    }
    let terminal = false;
    for (const event of toEmit) {
      emit(event);
      if (event['type'] === 'finish' || event['type'] === 'failed') terminal = true;
    }
    return terminal;
  }

  /**
   * 阶段摘要。**成功与失败共用同一份构造**（字段完全同形），失败时三个阶段耗时
   * 可以是 `null`——那个 `null` 就是"挂在哪一段"的答案。
   *
   * 只含布尔、计数、闭集短码与毫秒数。**零凭据**：没有 apiKey、没有 providerId 回显、
   * 没有 sessionId、没有 prompt、没有路径。
   *
   * @returns {DriveSessionPartialSummary}
   */
  function buildPartialSummary() {
    return {
      reverseRequestsAnswered,
      reverseRequestsByMethod: Object.freeze({ ...reverseRequestsByMethod }),
      unsolicitedNotificationsIgnored,
      lastReverse: lastReverseSummary,
      lastRuntimePreferences: lastRuntimePreferencesSummary,
      lastToolPermission: lastToolPermissionSummary,
      lastUserInput: lastUserInputSummary,
      permissionMode,
      toolPolicy,
      phaseDurationsMs: Object.freeze({
        accountConfig: accountConfigMs,
        sessionCreate: sessionCreateMs,
        turn: turnStartedAt === null ? null : Math.max(0, Date.now() - turnStartedAt),
        total: Math.max(0, Date.now() - startedAt)
      }),
      unmappedOfficialEventTypes: Object.freeze({ ...unmappedEventTypes })
    };
  }
}

/**
 * 往官方的 **input** 流（HOSTFIX5：子进程 stdin）写一帧请求。**只走 `input`**——
 * 写 `output`（子进程 stdout）是接反，官方 `handleMessage` 挂在 `input` 上，
 * 写 `output` 等于把请求丢进应答流。
 *
 * @param {{ write: (chunk: string) => unknown }} input 子进程 stdin
 * @param {{ id: string | number, method: string, params?: unknown }} frame
 */
function writeRequest(input, frame) {
  input.write(`${JSON.stringify(frame)}\n`);
}

/**
 * 构造 `provider/updateAccountConfig` 的参数——**官方唯一的账号/entitled 注入面**。
 *
 * 逐字对齐官方 `CGt`（偏移 766126）与 `FHo`（偏移 14127215）两条约束：
 *
 *  1. `FHo` 逐字：`if(cee(s)&&a.access?.type==="zhipu-account"&&a.access.entitled&&typeof e.states?.[s]?.current!="boolean") throw new Error(\`Account State 缺少 current: ${s}\`)`。
 *     → `providers[id].access.entitled` 为真时，**`states[id].current` 必填布尔**。
 *  2. `nZe` 逐字：`if(s.basedOnZCodeBuiltinRevision!==o.zcodeBuiltinRevision){…continue}`。
 *     → 快照带的 `basedOnZCodeBuiltinRevision` 与官方当前 builtin revision 不一致时，
 *     **整份账号快照被丢弃**。
 *
 * 关键形状（**不是**本文件原先那个凭空猜的 `accountProviderStates`）：
 *  - `providers[id].access` 是官方 `sAe`：`{type:"zhipu-account", accountType, mode, entitled}`。
 *  - `states[id]` 是官方 `{availability, entitled, current?, …}`，
 *    `availability` 是**闭集** `available|pending|unavailable|unknown`。
 *
 * ## `basedOnZCodeBuiltinRevision` 的来源：子进程内**按官方公式自己算**（BL-2 · HOSTFIX5）
 *
 * 上一版把它当"显式外部输入"（BL-1 未修时），再改成为"从**同进程**里官方运行时读出来"。
 * **HOSTFIX5 两条前提同时没了**：我们不再 require bundle（它没有具名导出），所以
 * **既不能读**、也**没有运行时可读**。于是改成按官方自己的公式独立算——
 * 见 {@link readBuiltinProviderRevision} 的逐字依据：
 *
 *  - `UO`（偏移 587490）构造器逐字
 *    `this.#t = t.activeFilePath?.trim() || n; this.#n = createHash("sha256").update(resolve(this.#t)).digest("hex")`
 *    且 `read()` 逐字 `return this.#c ??= gAe(t), T3i(t, this.#n)`、
 *    `T3i`（偏移 587002）逐字 `revision: \`zcode-builtin:${e.revision}:${t}\``。
 *
 * **本路径（非 standalone）里 `dZe` 收到的 `activeFilePath` 是 `undefined`**：
 * `Ykt` 只把 `{...n}`（`zcodeBuiltinFilePath` + `personalFilePath`）展开给 `pZe`，
 * 而 `l = t.standalone ? e[OXe]?.trim() : void 0` 恒为 `undefined`。于是 `dZe` 逐字
 * `new UO({ bundledFilePath: t.zcodeBuiltinFilePath, activeFilePath: undefined, watch: undefined })`
 * → `active = bundled = ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 的值。
 * **这正是这个值可算的原因**：revision 的 sha256 段 = `sha256(resolve(那个 env 键的值))`，
 * 而官方 app-server 读的是**同一份 env**（`buildIsolatedChildEnv` 无条件下发那两个键），
 * 所以两边算出的 revision **逐字相同**，比对必然通过。
 *
 * 拿不到时仍然**不发这一帧**（fail-closed）：猜错 = 官方整份丢弃 = 一条更难诊断的失败。
 *
 * @param {Record<string, any>} request
 * @param {string | null} [runtimeBuiltinRevision] 子进程内从官方运行时读到的真实 builtin revision
 * @returns {Promise<Record<string, unknown> | null>} `null` = 不知道 builtin revision，不发
 */
export async function buildAccountConfigPatch(request, runtimeBuiltinRevision = null) {
  const providerId = /** @type {string} */ (request.providerId);
  // **优先请求帧上的显式值**（测试与将来"父进程自己算"的路径），
  // 缺省用**子进程内从官方运行时读到的真实值**（BL-2 的生产路径）。
  const candidates = [request.zcodeBuiltinRevision, runtimeBuiltinRevision];
  let basedOn = '';
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '' && candidate.trim() !== UNINITIALIZED_BUILTIN_REVISION) {
      basedOn = candidate.trim();
      break;
    }
  }
  if (basedOn === '') {
    // 真的拿不到就不猜：理由见本函数注释末段。
    return null;
  }
  const env = /** @type {Readonly<Record<string, string | undefined>>} */ (process.env);
  const { deriveEntitledSnapshot } = await import('../../packages/official-host/src/entitlement.js');
  const snapshot = deriveEntitledSnapshot({ providerId, planMode: request.planMode, env });
  const entitled = snapshot.current.entitled;
  // 不伪造：`revision` 是官方比对 `replace()` 是否生效的依据，必须随内容变化。
  const revision = `zcc-account:${providerId}:${snapshot.current.mode}:${String(entitled)}:${String(snapshot.evidence.reason)}`;
  return {
    revision,
    basedOnZCodeBuiltinRevision: basedOn,
    providers: {
      [providerId]: {
        // **HOSTFIX6：这两个键就是 300 s 挂死的根因。**
        //
        // 上一版在这里多写了 `accountType` 与 `mode`。实弹（2026-10-01，直连探针实测）
        // 证明官方 `Qtr` = `parseAccountProviderConfigMap` 逐字
        // `m.record(m.string().min(1), s3i).parse(e)`，而
        // `s3i = kz.pick({builtinModelIds:!0}).extend({access: fWt.pick({type:!0, entitled:!0}).nullable().optional()})`、
        // `fWt = m.object({...VL(sAe.shape), type: sAe.shape.type}).strict()`——
        // 也就是说 `access` 在**这条**路径上**只认 `type` 与 `entitled` 两个键**，
        // `.strict()` 之下多一个键就整帧被拒：
        //
        //   ZodError: [{ code:"unrecognized_keys", keys:["accountType","mode"],
        //                path:["account:zai-start-plan","access"],
        //                message:'Unrecognized keys: "accountType", "mode"' }]
        //   （官方 -32603 / data.name = "ZodError"）
        //
        // 后果链：账号快照**整份没进去** → Provider Registry 里没有
        // `account:zai-start-plan` → `session/create` 抛
        // `Provider Registry 中不存在 Model: account:zai-start-plan/GLM-5.3-Flash`。
        //
        // **为什么丢掉这两个键不是妥协**：官方自己的 fail-closed 空快照
        // （`HKe`，逐字 `new zj({entitled:!1})`）**同样只带 `entitled`**——
        // 官方在这条通道上从来不传 `accountType` / `mode`。我们多写它们才是偏离。
        access: {
          type: 'zhipu-account',
          entitled
        }
      }
    },
    states: {
      [providerId]: {
        availability: entitled ? 'available' : 'unavailable',
        entitled,
        // `FHo` 硬要求：access.entitled 为真时 current 必须是布尔。
        current: entitled
      }
    }
  };
}

/**
 * 把一帧官方**错误应答**（`Hir = {id, error}`）压成一句可进错误消息的短描述。
 *
 * ## 为什么需要它（HOSTFIX6）
 *
 * 官方对**任何**我们写过去的请求都可能回 `{id, error}`。上一版驱动把这类帧
 * 当成"没找到 sessionId 的普通行"塞进 `pending`，然后**空转到 300 s 墙钟上限**
 * 才报 `SESSION_CREATE_NO_SESSION_ID`——把一次**毫秒级**的官方拒绝伪装成了一次
 * "慢响应"。实弹第二轮（2026-10-01）就是这样挂掉的：官方在 482 ms 就拒了
 * `session/create`，驱动却等了 300 000 ms。
 *
 * ## 只取 `code` 与 `message`，**不取** `data.stack`
 *
 * 官方 `KHo`（偏移 14131884）逐字
 * `if(e instanceof Error){…return {code:-32603, data:{name:e.name, stack:e.stack}, message:e.message}}`。
 * `data.stack` 里是**绝对路径 + 产物内部符号名**（`at parseAccountProviderConfigMap (C:\ZCode\…:71:26784)`），
 * 按本仓库"原始错误不转发"的纪律**一律不取**。
 * 而 `message` 本身已经足够 actionable：zod 的 `ZodError.message` 就是那份
 * issues JSON（`code` / `keys` / `path` / `message`），不含任何路径。
 *
 * @param {any} frame 官方帧
 * @returns {string | null} 短描述；不是错误应答时 `null`
 */
export function describeOfficialError(frame) {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return null;
  const error = /** @type {Record<string, any>} */ (frame)['error'];
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return null;
  const code = error['code'];
  const message = error['message'];
  const codeText = typeof code === 'number' || typeof code === 'string' ? String(code) : 'unknown';
  const messageText = typeof message === 'string' && message.trim() !== '' ? message.trim() : '(官方未给 message)';
  return `code=${codeText} message=${messageText.slice(0, 240)}`;
}

/**
 * 在一批已收到的官方行里找**针对某个请求 id** 的错误应答。
 *
 * **只认 id 精确相等**（官方 `pTt.resolveClientRequest` 逐字 `String(t)` 查表），
 * 不做前缀/模糊匹配——把别的请求的错误当成本请求的错，比不报还糟。
 *
 * @param {readonly string[]} lines 已收到的官方行
 * @param {string | number} requestId 我们发出的请求 id
 * @returns {string | null} {@link describeOfficialError} 的结果；没有则 `null`
 */
export function findOfficialErrorFor(lines, requestId) {
  const wanted = String(requestId);
  for (const line of lines) {
    const parsed = safeParse(line);
    if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = /** @type {Record<string, any>} */ (parsed);
    if (!('id' in record) || String(record['id']) !== wanted) continue;
    if (!('error' in record)) continue;
    return describeOfficialError(record);
  }
  return null;
}

/**
 * 等到有输出或到期限。**不轮询忙等**。
 *
 * @param {string[]} outbound
 * @param {Array<() => void>} waiters
 * @param {boolean} outboundDone
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function settle(outbound, waiters, outboundDone, ms) {
  if (outbound.length > 0 || outboundDone) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      const at = waiters.indexOf(woken);
      if (at >= 0) waiters.splice(at, 1);
      resolve(undefined);
    }, ms);
    timer.unref?.();
    /** @returns {void} */
    function woken() {
      clearTimeout(timer);
      resolve(undefined);
    }
    waiters.push(woken);
  });
}

/**
 * @param {string} line
 * @returns {any}
 */
function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * 从已收到的官方应答里取 `sessionId`。**只认结构上有 sessionId 的应答**，
 * 读不到就报 `null` 让调用方失败——不猜。
 *
 * ## 四处都查（HOSTFIX6 补了第 4 处，它才是实弹那条）
 *
 * 实弹（2026-10-01，直连探针拿到的**逐字**成功应答）形状是：
 *
 * ```
 * {"id":"…","result":{
 *    "messages":[…],
 *    "projection":{…,"sessionId":"unknown",…},      ← 诱饵：字面量 "unknown"
 *    "protocol":{…},"runtime":{…},
 *    "session":{"createdAt":…,"mode":"build","model":{…},
 *               "sessionId":"sess_55bc17d1-…","sessionKind":"interactive",…},
 *    "settings":{…}}}
 * ```
 *
 * **真的那个在 `result.session.sessionId`，四层深。** 上一版只查三处
 * （顶层 / `result.sessionId` / 顶层 `session.sessionId`），**一处都不命中** ⟹
 * `extractSessionId` 恒 `null` ⟹ 驱动在 `session/create` 上空转到 300 s 墙钟上限，
 * 而官方那边 `zcode_protocol.session_create.completed` **早就成功了**（实测 643 ms）。
 *
 * 顺序也是**刻意的**：`result.session.sessionId` 排在 `projection.sessionId` 之前——
 * 官方那份 `projection.sessionId` 在真值之前恒为字符串 `"unknown"`，先认它就会
 * 拿一个假 id 去 `session/send`。
 *
 * @param {readonly string[]} outbound
 * @returns {string | null}
 */
export function extractSessionId(outbound) {
  for (const line of outbound) {
    const parsed = safeParse(line);
    if (parsed === null || typeof parsed !== 'object') continue;
    const record = /** @type {Record<string, any>} */ (parsed);
    const direct = record['sessionId'];
    if (typeof direct === 'string' && direct !== '' && direct !== UNKNOWN_SESSION_ID) return direct;
    const result = record['result'];
    if (result !== null && typeof result === 'object') {
      const viaResult = /** @type {Record<string, any>} */ (result)['sessionId'];
      if (typeof viaResult === 'string' && viaResult !== '' && viaResult !== UNKNOWN_SESSION_ID) return viaResult;
      // **实弹那条**：官方 `session/create` 的成功应答把会话实体放在 `result.session`。
      const session = /** @type {Record<string, any>} */ (result)['session'];
      if (session !== null && typeof session === 'object') {
        const viaSession = /** @type {Record<string, any>} */ (session)['sessionId'];
        if (typeof viaSession === 'string' && viaSession !== '' && viaSession !== UNKNOWN_SESSION_ID) return viaSession;
      }
    }
    const session = record['session'];
    if (session !== null && typeof session === 'object') {
      const viaSession = /** @type {Record<string, any>} */ (session)['sessionId'];
      if (typeof viaSession === 'string' && viaSession !== '' && viaSession !== UNKNOWN_SESSION_ID) return viaSession;
    }
  }
  return null;
}
