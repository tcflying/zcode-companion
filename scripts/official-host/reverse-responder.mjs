/**
 * official-host · **官方反向请求应答器**（providerRuntimeHeadersPort 的真正落点）
 *
 * ## 为什么需要这个文件（HOSTFIX3 的全部由来）
 *
 * 官方 `runZCodeProtocolAgent`（`NXo`，产物内偏移 14678273）**自己**建 app：
 *
 * ```
 * U = await N3e({ …, create: r(() => Ykt(z), "create"), … })            // z = e.env ?? process.env，单参
 * Tt = new pTt({ createZCodeApp: r((Fe = {}) => KAn({ ...Wec(qec(Fe, n),
 *        rt.runtime.registryService, rt.configuredDefaultModelSelection), … }),
 *        cwd, env, loggerFactory, mcpPort, mcpTelemetry, sessionStore,
 *        syncAccountProviderConfig, refreshProviderRegistry, version })
 * ```
 *
 * `NXo` 的 options 面**只有 9 个键**（`prepareStorageOnly / env / cwd / input / output /
 * presentationSurface / lifecycle / version / providerEndpointRoutingPort`），
 * **没有** `create` 工厂、**没有** `providerRuntimeHeadersPort`、**没有** `providerRegistry`。
 * 那个叫 `create` 的东西是 `N3e`（`acquireProtocolStartupResource`）自己内部的 thunk 参数名，
 * 不是对外槽位。而 `pTt`（`ZCodeProtocolAgentServer`）与传输层 `fTt`
 * （`ZCodeProtocolNdjsonConnection`）**都不在 37 个导出符号里**，所以"绕开 NXo 自建 app"
 * 在公开 API 上根本不存在。
 *
 * 于是真正跑会话的那个 app，其 port 恒为官方缺省 `ZJo`（`createProviderRuntimeHeadersPort`，
 * 偏移 14434207）。而 `ZJo` 的唯一实现是**向附着的协议客户端要**：
 *
 * ```
 * s = await e.requestClient(va.interactionRequestProviderRuntimeHeaders, {…}, DGt,
 *                           { signal, trace, timeoutMs: 18e4 })
 * if (!s.headersApplied) throw new sf(-32031, …)
 * ```
 *
 * `pTt.requestClient`（偏移 14667657）逐字：
 * ```
 * if (!this.messageSink) throw new sf(-32020, `No ZCode Protocol client is attached for ${t}`)
 * … this.messageSink?.({ id: `server-${n++}`, method: t, params, …trace?{trace}:{} })
 * ```
 *
 * `messageSink` 逐字是 `Tt.setNotificationSink(Fe => Ye.send(Fe))`，`Ye` 是 `fTt`，
 * `send` 写的是 **`output`**。**而 `output` 正是我们已经在读的那条流**——
 * 也就是说，**我们本来就是官方眼里的"协议客户端"**。
 *
 * ## 机制（不是绕过，是官方定义的客户端职责）
 *
 * 官方把"取订阅凭据"定义成一条**客户端应答**：`interaction/requestProviderRuntimeHeaders`。
 * 请求帧形状是 `qir = {id, method, params?, trace?}`（`.strict()`），应答帧形状是
 * `Vir = {id, result}`（`.strict()`）。传输层 `fTt.dispatchLine` 逐字
 * `if ("id" in n && ("result" in n || "error" in n)) { this.handleMessage(n) … }`
 * → `pTt.handleMessage` 逐字 `if (GHo(t)) { this.resolveClientRequest(t.id, t.result); return }`
 * → `resolveClientRequest` 逐字 `s.resolve(s.resultSchema.parse(n))`，`resultSchema` 就是 `DGt`。
 *
 * `DGt`（偏移 769026，注册名 `zcodeProviderRuntimeHeadersResponseSchema`）逐字：
 *
 * ```
 * m.discriminatedUnion("headersApplied", [
 *   m.object({ headersApplied: m.literal(!0),
 *              requestAuth: m.object({ apiKey: Dn.optional(), headers: m.record(Dn, Dn).optional() }).strict(),
 *              errorMessage: Dn.optional() }).strict(),
 *   m.object({ headersApplied: m.literal(!1), errorMessage: … }).strict()
 * ])
 * ```
 *
 * 消费侧 `tat`（偏移 4014209）逐字：
 * `if (t?.throwIfAborted(), !o.headersApplied || !o.requestAuth) throw new Error("Provider request auth was not returned before model request attempt.")`
 * ——所以**拒答是官方认可的失败姿势**（官方自己的 `ZJo` 在 `!headersApplied` 时抛 `-32031`），
 * 而且是**立即**失败，不是挂 180 秒。
 *
 * ## 这道闸门是真闸门，不是装饰
 *
 * 官方只在 `accountAccess.mode === "start-plan"` 时才走刷新（`$0e.claim` 逐字
 * `this.model.accountAccess?.mode !== "start-plan"` → 不刷新）。也就是说
 * **本文件只在 start-plan 这条路上被调用**，而那正是我们要自给凭据的那条。
 * 每一��模型请求都必须先过我们这道；我们拒，它就发不出去。
 *
 * ## 凭据边界
 *
 * `apiKey` 只出现在**本进程内存**里：`input` 是一条内存 `PassThrough`，
 * 官方在同进程里 `resolveClientRequest` 取出即用。明文**从不**写进父通道帧、
 * **从不**落盘、**从不**进错误消息。拒绝路径只回错误码。
 *
 * 与 `headers-port.ts` 的分工：白名单判定与取键/解密**全部**留在 `headers-port.ts`，
 * 本文件**不复制**任何一条策略，只做"官方帧 → 调 port → 官方帧"的搬运与形状对齐。
 *
 * ## HOSTFIX4：`session/requestRuntimePreferences`（**实弹硬阻塞**）
 *
 * 这条**不走 port**、也**没有闸门**——它必须在**每一次** `session/create` 上无条件应答。
 * 逐字链路（`C:\ZCode\resources\glm\zcode.cjs`，只读）：
 *
 * ```
 * jKo @14479718  return UKo(e, t, n, async o => { … })
 * UKo @14479962  let g = await ERn(e, {...s, workspace:u}, l, !1, {kind:"host"}, n)   ← 在 try 之外
 * ERn @14511145  async function ERn(e,t,n,o,s,a){ let l = await CXa(e,n,s,a); … }
 * CXa @14510354  let s = await CKo(e, t, "runtime-materialization", o)              ← kind==="host" 走这一支
 * CKo @14509003  let l = await e.requestClient(va.sessionRequestRuntimePreferences,
 *                                              {sessionId:t, scope:n}, pGt, {timeoutMs: dGt, …})
 *                dGt = 15e3                                                          ← 15 秒
 * CKo catch:     if (l.code === -32601 || l.code === -32020) return {默认对象};
 *                throw l                                                            ← -32022 走这里
 * ```
 *
 * **为什么"不答"等于整轮实弹报废**：超时码是 `-32022`，而 `CKo` 的 catch **只**对
 * `-32601`（方法未实现）/ `-32020`（无客户端）给默认值兜底，`-32022` 走 `throw l`；
 * `await ERn(...)` 又在 `UKo` 的 `try` **之外**，异常直接逃出 `session/create` 处理器。
 * 于是 `session/create` **不返回 sessionId** → 驱动空转到 300 s 墙钟上限才失败，
 * 且**永远走不到模型请求**——HOSTFIX3 的凭据闸门在实弹中一次都不会被触达。
 *
 * **为什么本条不设闸门、只设 fail-closed 值**：官方那条 catch 里 `-32022` 是
 * `throw`，**没有"拒答"这个姿势**。所以"fail-closed"在这里只能落在**值**上，
 * 不能落在"不答"上——不答不是 fail-closed，是 fail-fatal。
 *
 * 官方自己对 `-32601`/`-32020` 的兜底默认值是**宽松**的
 * （`{askUserQuestionAutoResolutionEnabled:!0, memoryEnabled:!1, modelContextBudgetStrategy:WO, nativeSearchEnhancementsEnabled:!0}`）。
 * 我们**刻意不用**它：那是"官方客户端在" + 我们没有原生搜索增强、没有 memory 后端、
 * 且**没有交互式用户输入通道**（子宿主是 headless）这三条事实下唯一自洽的一组值。
 *
 * **旁证**：`G:\zcode-project\zcode-dev\dsh-zcode-appserver`（MIT，package.json
 * `"license": "MIT"`）`lib/appserver.js:356` 的 `reverseAnswer` **第一个分支**就是这条，
 * 回的正是同一组值（逐字照抄处见 {@link RUNTIME_PREFERENCES_FAIL_CLOSED}）。
 * 它与本项目形态相同（自己 spawn `zcode.cjs app-server --stdio`、自己在子进程外当协议
 * 客户端），**能真实发送的产品必须答这条**。取值以官方 `pGt` 逐字为准，DSH 只作旁证。
 *
 * **零凭据、零新状态**：应答值是三个布尔常量，与 port、凭据仓、`request` 都无关。
 */
import { HeadersPortError } from '../../packages/official-host/src/headers-port.js';
import {
  HOST_TOOL_POLICY_ENV_KEY,
  HOST_TOOL_POLICIES,
  DEFAULT_HOST_TOOL_POLICY,
  resolveHostToolPolicy
} from '../../packages/official-host/src/host-driver.js';

/* -------------------------------------------------------------------------- */
/* 官方协议常量（逐字，偏移见文件头）                                          */
/* -------------------------------------------------------------------------- */

/**
 * 官方 `va` 枚举里那条反向请求的字面量（偏移 787197 逐字
 * `interactionRequestProviderRuntimeHeaders:"interaction/requestProviderRuntimeHeaders"`）。
 */
export const REVERSE_REQUEST_PROVIDER_RUNTIME_HEADERS = 'interaction/requestProviderRuntimeHeaders';

/**
 * 官方 `Ysr`（`zcodeProviderRuntimeHeadersRequestReasonSchema`）的闭集。
 * 只用于**替身夹具**造请求与单测断言，本文件不据此改变判定。
 */
export const REVERSE_REQUEST_REASONS = Object.freeze(['model-request', 'captcha-retry']);

/* -------------------------------------------------------------------------- */
/* `session/requestRuntimePreferences`（HOSTFIX4）                             */
/* -------------------------------------------------------------------------- */

/**
 * 官方 `va` 枚举里那条反向请求的字面量。
 *
 * 逐字（`C:\ZCode\resources\glm\zcode.cjs` 偏移 **784446**）：
 * `sessionRequestRuntimePreferences:"session/requestRuntimePreferences"`
 * （同一个 `va` 字面量对象里，`sessionCreate:"session/create"` 也在其中）。
 */
export const REVERSE_REQUEST_RUNTIME_PREFERENCES = 'session/requestRuntimePreferences';

/**
 * 官方请求 params 的 `scope` 闭集。
 *
 * 逐字（偏移 **759169**，注册名 `zcodeSessionRuntimePreferencesScopeSchema` @1059080）：
 * `jsr=m.enum(["runtime-materialization","user-execution"])`
 *
 * 两条的区别（逐字 `CXa` @14510354）：
 *  - `runtime-materialization`：**eager**，`CXa` 在建 app 之前就 `await`，挂在
 *    `session/create` 的关键路径上。**这就是那条 CRITICAL。**
 *  - `user-execution`：**lazy**，`CXa` 只把它包成 thunk `resolveInitialBashShellSelection`
 *    交给 app（`EXa` 逐字 `resolveInitialBashShellSelection: s.resolveInitialBashShellSelection`），
 *    真正触发是 app 侧 `initializeSessionShellEnvironmentIfNeeded(await to())`。
 *    仅当初始 bash shell 被解析时才发。首轮纯对话不触发。
 *
 * 两条**应答同一组值**（DSH 也是这么答的），所以闭集只用于**摘要诊断**与**单测断言**，
 * 不用来改变判定——见 {@link resolveSessionRuntimePreferencesResponse}。
 */
export const REVERSE_RUNTIME_PREFERENCES_SCOPES = Object.freeze(['runtime-materialization', 'user-execution']);

/**
 * 官方 `pGt` 的 `modelContextBudgetStrategy` 闭集与其缺省值。
 *
 * 逐字（偏移 759283 / 759301）：`WO="preflight-v1"`, `Bsr=m.enum(["legacy","preflight-v1"])`，
 * 字段声明 `modelContextBudgetStrategy: Bsr.default(WO)`。
 *
 * **我们不构造这个字段**（`.strict()` 之下 `.default()` 使它在**输入侧**可选，
 * 省略后官方 `parse` 会自己填成 `"preflight-v1"`），而且官方 `CXa` 逐字**丢弃**了它：
 * `return { memoryEnabled: s.memoryEnabled, modelContextBudgetStrategy: WO, … }`
 * ——恒用 `WO`，从不看客户端回的值。省略是安全的，**写一个非 `WO` 的值才是危险的**
 * （它会被丢弃，白写；且多一个键就多一处能被塞进秘密的面）。
 */
export const RUNTIME_PREFERENCES_MODEL_CONTEXT_BUDGET_STRATEGIES = Object.freeze(['legacy', 'preflight-v1']);
export const RUNTIME_PREFERENCES_DEFAULT_MODEL_CONTEXT_BUDGET_STRATEGY = 'preflight-v1';

/**
 * 我们回给官方的 **fail-closed** 值。**逐字照抄** `dsh-zcode-appserver`（MIT）
 * `lib/appserver.js:360-362` 的 `reverseAnswer` 第一个分支：
 *
 * ```js
 * if (method === 'session/requestRuntimePreferences') {
 *   return { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false }
 * }
 * ```
 *
 * 三个 `false` 各自 fail-closed 在哪（全部有官方消费点逐字支撑）：
 *
 * | 字段 | 官方 schema（`pGt` @759339） | 消费点 | `false` 的后果 |
 * | --- | --- | --- | --- |
 * | `nativeSearchEnhancementsEnabled` | `m.boolean()`（**唯一必填**，无 default） | `EXa` @14512822 逐字 `nativeSearchEnhancementsEnabled: s.nativeSearchEnhancementsEnabled` → app `runtimeConfig` | 关掉原生搜索增强。我们是 headless 子宿主，没有原生搜索面 |
 * | `memoryEnabled` | `m.boolean().default(!1)` | `EXa` 逐字 `...s.memoryEnabled?{}:{memory:{enabled:!1}}` | 关掉 memory。我们没有任何 memory 后端 |
 * | `askUserQuestionAutoResolutionEnabled` | `m.boolean().default(!0)` ← **缺省是宽松的 `true`** | `CXa` 逐字 `await e.v4Interactions.initializeAskUserQuestionAutoResolutionEnabled(s.askUserQuestionAutoResolutionEnabled)` → `applyAskUserQuestionAutoResolutionEnabled` 逐字 `if (t) return 0;` 之后把**所有** pending 的 `askUserQuestion` 置 `autoResolutionEligible=!1` 并转 snoozed | 关掉自动放行。**这一条最关键**：本子宿主没有交互式用户输入通道，自动放行等于"官方自己替用户答了"，那不是我们在做决定 |
 *
 * **刻意偏离官方的兜底默认值**：官方 `CKo` 对 `-32601`/`-32020` 的兜底是
 * `{askUserQuestionAutoResolutionEnabled:!0, memoryEnabled:!1, modelContextBudgetStrategy:WO, nativeSearchEnhancementsEnabled:!0}`
 * ——`nativeSearchEnhancementsEnabled: true` 与 `askUserQuestionAutoResolutionEnabled: true`
 * **都是宽松方向**。那是"一个真的 ZCode 桌面客户端"的自洽取值；我们不是。
 *
 * **只回这三个键**：`integratedTerminalShell`（`aYe.optional()`，偏移 716367）省略 →
 * 官方 `IXa`/`TXa` @14508688 逐字 `if(!(!e||e.mode==="auto")) return {...}`
 * ——`undefined` 直接返回 `undefined`，即"不覆盖用户配置"，回落官方默认 shell。
 * 这与 DSH 的做法一致，也是首轮不发 bash 时唯一正确的姿势。
 *
 * **冻结**：调用方拿到的必须是只读的；`resolveSessionRuntimePreferencesResponse`
 * 每次都会**新建**一个普通对象再上 wire，不把冻结对象直接交出去。
 *
 * @returns {Readonly<{ nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false }>}
 */
export const RUNTIME_PREFERENCES_FAIL_CLOSED = Object.freeze({
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false
});

/**
 * 官方 `pGt` 的**完整**字段名表（`.strict()` 之下的全集），只用于**单测逐字段断言**。
 *
 * 逐字（偏移 759339，跨度 759339..759588，长 249）：
 * `pGt=m.object({nativeSearchEnhancementsEnabled:m.boolean(),memoryEnabled:m.boolean().default(!1),askUserQuestionAutoResolutionEnabled:m.boolean().default(!0),integratedTerminalShell:aYe.optional(),modelContextBudgetStrategy:Bsr.default(WO)}).strict()`
 */
export const RUNTIME_PREFERENCES_RESULT_FIELDS = Object.freeze([
  'nativeSearchEnhancementsEnabled',
  'memoryEnabled',
  'askUserQuestionAutoResolutionEnabled',
  'integratedTerminalShell',
  'modelContextBudgetStrategy'
]);

/**
 * 官方 `G5i`（请求 params，注册名 `zcodeSessionRequestRuntimePreferencesParamsSchema`
 * @1058844）逐字（偏移 759235）：`m.object({sessionId:Dn,scope:jsr}).strict()`。
 *
 * `Dn` 逐字（偏移 732348）：`m.string().trim().min(1)`。
 */
export const RUNTIME_PREFERENCES_REQUEST_FIELDS = Object.freeze(['sessionId', 'scope']);

/* -------------------------------------------------------------------------- */
/* COMPAT1 · C4：工具权限 / 用户输入的反向请求应答                              */
/* -------------------------------------------------------------------------- */

/**
 * 官方 `va` 枚举里那两条反向请求的字面量。逐字（偏移 787107 / 787167，与
 * `interactionRequestProviderRuntimeHeaders` 同处一个字面量对象）：
 *
 * ```
 * interactionRequestPermission:"interaction/requestPermission",
 * interactionRequestUserInput:"interaction/requestUserInput",
 * interactionRequestProviderRuntimeHeaders:"interaction/requestProviderRuntimeHeaders",
 * ```
 */
export const REVERSE_REQUEST_PERMISSION = 'interaction/requestPermission';
export const REVERSE_REQUEST_USER_INPUT = 'interaction/requestUserInput';

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
 *             modifiedInput:m.unknown().optional(),
 *             permissionUpdates:m.array(BZe).optional()}).strict()
 * ```
 *
 * `.strict()` 是硬要求：官方 `pTt.resolveClientRequest` 逐字
 * `s.resolve(s.resultSchema.parse(n))`，多一个键就让整条 parse 抛错 → 反向请求被
 * reject。所以我们**只**发 `decision` + `reason` 两个键。
 */
export const PERMISSION_DECISIONS = Object.freeze(['allow', 'deny', 'escalate', 'modify']);

/**
 * 官方 `CYe`（偏移 768638）逐字：
 * `m.object({action:m.enum(["accept","decline","cancel"]),content:$x.optional(),reason:m.string().optional()}).strict()`
 * 其中 `$x`（偏移 732375）逐字 `m.record(m.string(), m.unknown())`。
 */
export const USER_INPUT_ACTIONS = Object.freeze(['accept', 'decline', 'cancel']);

// COMPAT1/C4：工具权限策略的 env 键 / 闭集 / 解析器**同样只在 `host-driver.ts` 里
// 有一份**（`packages/official-host/src/host-driver.ts`），本文件从那里重导出。
// 理由与 `session-drive.mjs` 里 `OFFICIAL_SESSION_MODES` 那条完全相同：闭集一旦
// 在两处各写一份字面量，"入口校验的闭集"与"子宿主实际判的闭集"就会悄悄分叉。
export {
  HOST_TOOL_POLICY_ENV_KEY,
  HOST_TOOL_POLICIES,
  DEFAULT_HOST_TOOL_POLICY,
  resolveHostToolPolicy
};

/**
 * `interaction/requestPermission` 应答里的 `reason` 文案（闭集常量，零凭据）。
 *
 * **不含**工具名、不含路径、不含 prompt——它会逐字进官方日志与投影，是唯一一处
 * "我们替客户端做了决定"必须**留痕**的位置，所以文案本身要能被外部读者看懂，
 * 同时不能把工作区内容带出去。
 */
export const TOOL_PERMISSION_ALLOW_REASON =
  'ZCC host headless: workspace is an isolated temp dir; auto-allowed by policy=allow';
export const TOOL_PERMISSION_DENY_REASON =
  'ZCC host headless: denied by policy=deny (workspace is an isolated temp dir)';
export const USER_INPUT_CANCEL_REASON = 'ZCC host headless: no interactive user channel; interaction cancelled';

/**
 * 判一条帧是不是 `interaction/requestPermission`。
 *
 * 判据与 {@link isProviderRuntimeHeadersRequest} **逐条同构**（有 `id` +
 * `method` 字面量 + `params` 是对象），因为三条反向请求在官方那边共用
 * `pTt.requestClient` 与同一张 `pendingClientRequests` 表（逐字 `String(\`server-${n++}\`)`）。
 *
 * @param {unknown} frame
 * @returns {boolean}
 */
export function isToolPermissionRequest(frame) {
  if (frame === null || typeof frame !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (frame);
  const id = record['id'];
  if (typeof id !== 'string' && typeof id !== 'number') return false;
  if (typeof id === 'string' && id.trim() === '') return false;
  if (record['method'] !== REVERSE_REQUEST_PERMISSION) return false;
  const params = record['params'];
  return params !== null && typeof params === 'object';
}

/**
 * 判一条帧是不是 `interaction/requestUserInput`。
 *
 * **与上面同一条判据**（有 `id` + `method` 字面量 + `params` 是对象）：官方两条调用点
 * （`HZa` 偏移 14444876 / `JZa` 偏移 14445581）发的 params 都是 `pUi`（偏移 768496）
 * 逐字 `m.object({requestId:Dn,sessionId:Dn,turnId:Dn.optional(),toolCallId:Dn.optional(),toolName:Dn.optional(),prompt:m.string().optional(),questions:m.array(Zsr).min(1).optional(),input:m.unknown().optional(),origin:KL.optional(),schema:m.unknown().optional()}).strict()`。
 *
 * 这里**不**沿用 runtime preferences 那条"不要求 params 是对象"的宽松判据：权限/输入
 * 这两条的应答**确实**取决于 `params`（我们只答最小允许/取消，不复述任何 params 字段），
 * 所以认帧时至少要求 `params` 在场；**认出就必答**的理由与那条完全相同——不答就挂满 300 s。
 *
 * @param {unknown} frame
 * @returns {boolean}
 */
export function isUserInputRequest(frame) {
  if (frame === null || typeof frame !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (frame);
  const id = record['id'];
  if (typeof id !== 'string' && typeof id !== 'number') return false;
  if (typeof id === 'string' && id.trim() === '') return false;
  if (record['method'] !== REVERSE_REQUEST_USER_INPUT) return false;
  const params = record['params'];
  return params !== null && typeof params === 'object';
}

/**
 * 一次工具权限应答的**可断言摘要**。**零凭据**、不回显 toolName / input / 路径。
 *
 * @typedef {{
 *   id: string,
 *   method: string,
 *   decision: string,
 *   policy: 'allow' | 'deny',
 *   answered: true
 * }} ToolPermissionSummary
 */

/**
 * 应答一条 `interaction/requestPermission`。
 *
 * **同步**、**必答**、**零 I/O**——与 {@link resolveSessionRuntimePreferencesResponse}
 * 同一档纪律。**不答的代价逐字**（官方 `pTt.requestClient`，偏移 14668930）：
 * `s?.timeoutMs!==void 0 && (f.timeout=setTimeout(…))` —— 而权限这条经 `dRn`（偏移
 * 14447817）只给 `{sessionId, kind, …}`，**根本没有 `timeoutMs`**，所以 promise
 * 永不落定（唯一会动的是 `uRn` 逐字 `reannounceIntervalMs: 1e3` 的**重播**）。
 * 于是挂到的是**我们自己的** 300 s 墙钟上限（协调者实弹：挂满 300 秒）。
 *
 * ## 形状
 *
 * 只发 `decision` + `reason` 两个键（`JL` 是 `.strict()` 的）。**不发**：
 *  - `modifiedInput`：那会让工具拿到**被我们改写过**的入参——那不是授权，是改写。
 *  - `permissionUpdates`：那是"记住这个规则，以后都这么办"的持久化决定；
 *    我们是 headless 子宿主，没有权限替用户立规矩。
 *
 * @param {{ frame: Record<string, any>, policy?: 'allow' | 'deny' }} input
 * @returns {{ frame: { id: string, result: { decision: string, reason: string } }, summary: ToolPermissionSummary }}
 */
export function resolveToolPermissionResponse({ frame, policy = 'allow' }) {
  const id = String(frame.id);
  const decision = policy === 'deny' ? 'deny' : 'allow';
  const reason = policy === 'deny' ? TOOL_PERMISSION_DENY_REASON : TOOL_PERMISSION_ALLOW_REASON;
  // **新建普通对象**：模块级常量保持冻结，调用方拿不到引用。
  return {
    frame: { id, result: { decision, reason } },
    summary: { id, method: REVERSE_REQUEST_PERMISSION, decision, policy, answered: true }
  };
}

/**
 * 一次用户输入应答的**可断言摘要**。**零凭据**。
 *
 * @typedef {{
 *   id: string,
 *   method: string,
 *   action: string,
 *   answered: true
 * }} UserInputSummary
 */

/**
 * 应答一条 `interaction/requestUserInput` —— **恒回 `cancel`**。
 *
 * ## 为什么是 `cancel` 而不是 `accept` / `decline`
 *
 * 官方 `XZa`（偏移 14446700 附近）逐字把 `action` 映射成工具执行器看到的结果：
 * 非 `accept` → `decision:"deny"`，`reason: t.reason ?? (t.action==="cancel" ? "AskUserQuestion was cancelled" : "AskUserQuestion was declined")`。
 * 也就是说**对下游而言 `cancel` 与 `decline` 同构**；选 `cancel` 是因为它对用户更
 * 诚实——子宿主**没有**任何交互式用户输入通道，"decline" 暗示"有人看了然后拒绝"，
 * `cancel` 才是"这个交互被取消了"。
 *
 * **绝不 `accept`**：`accept` 要带 `content`，而我们没有任何真实答案。官方侧
 * `tYa(n, t.content)` 会把它当**用户填的答案**写回工具入参——那等于"我们替用户答了"，
 * 与 `session/requestRuntimePreferences` 里 `askUserQuestionAutoResolutionEnabled: false`
 * 的 fail-closed 取值是**同一个立场**。
 *
 * **不构造 `content`**：官方 `GZa` 逐字
 * `e.action==="accept" ? {action:"accept",content:e.content??{}} : {action:e.action}`——
 * 非 accept 路径**根本不读** `content`，所以省略是官方支持的形态，
 * 少一个键就少一处能被塞进秘密的面。
 *
 * @param {{ frame: Record<string, any> }} input
 * @returns {{ frame: { id: string, result: { action: string, reason: string } }, summary: UserInputSummary }}
 */
export function resolveUserInputResponse({ frame }) {
  const id = String(frame.id);
  return {
    frame: { id, result: { action: 'cancel', reason: USER_INPUT_CANCEL_REASON } },
    summary: { id, method: REVERSE_REQUEST_USER_INPUT, action: 'cancel', answered: true }
  };
}

/**
 * 本模块的拒答码。**闭集**——测试逐条断言。
 *
 * 全部是**结构化短码**，不携带任何 providerId 回显、任何路径、任何凭据片段。
 */
export const REVERSE_REFUSAL_CODES = Object.freeze([
  /** 反向请求的 `providerId` 与本 port 绑定的 providerId 不一致（跨通道挪用）。 */
  'PROVIDER_MISMATCH',
  /** port 的 `shouldRefreshBeforeModelRequest` 返回了假：官方已问，我们必须给肯定答复。 */
  'HEADERS_PORT_DECLINED',
  /** port 抛了 `HeadersPortError`：把它的**结构化** code 与 detail 搬过去（detail 零凭据）。 */
  'HEADERS_PORT_FAILED',
  /** port 的返回值不满足官方 `DGt` 必需条件（`headersApplied:true` + `requestAuth`）。 */
  'HEADERS_PORT_SHAPE_INVALID',
  /** 其它一切未知失败。不附原始异常。 */
  'UNEXPECTED'
]);

/** 拒答时回给官方的 `errorMessage` 上限。与子宿主 `fail()` 的 400 字符同量级。 */
export const REFUSAL_MESSAGE_MAX = 300;

/* -------------------------------------------------------------------------- */
/* 判别                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 这条帧是不是"官方要 provider runtime headers"的反向请求。
 *
 * **必须同时满足三条**（逐字依据）：
 *  1. 有 `id` —— 官方 `requestClient` 逐字 `id: \`server-${n++}\``（字符串），
 *     `pTt.resolveClientRequest` 逐字 `String(t)` 查表。
 *  2. `method` **正好**是那条字面量。应答帧 `{id, result}` 与通知帧 `{method, params}`
 *     都因为"没有这个 method"被排除。
 *  3. `params` 是对象 —— `fUi` 是 `.strict()` 的对象，缺了就答不了。
 *
 * @param {unknown} frame 已解析的帧
 * @returns {boolean}
 */
export function isProviderRuntimeHeadersRequest(frame) {
  if (frame === null || typeof frame !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (frame);
  const id = record['id'];
  if (typeof id !== 'string' && typeof id !== 'number') return false;
  if (typeof id === 'string' && id.trim() === '') return false;
  if (record['method'] !== REVERSE_REQUEST_PROVIDER_RUNTIME_HEADERS) return false;
  const params = record['params'];
  return params !== null && typeof params === 'object';
}

/**
 * 这条帧是不是"官方要会话运行时偏好"的反向请求。
 *
 * **只要求两条**（`id` + `method` 字面量），**不要求 `params` 是对象**——这是与
 * {@link isProviderRuntimeHeadersRequest} 刻意的分歧，理由是**应答值与请求参数无关**：
 * {@link RUNTIME_PREFERENCES_FAIL_CLOSED} 是三个布尔常量，`params` 缺失、形状不对、
 * 甚至 scope 越界，都不改变我们该回什么。
 *
 * 为什么不跟着收紧：`CKo` 的 catch 对超时码 `-32022` 是 `throw l`（**没有默认值兜底**），
 * 所以"因为帧没认出来而不答"不是 fail-closed，是**必然 15 秒后整轮失败**。
 * 认出来就答，答的内容恒定——这是这条路径上唯一安全的方向。
 * `params` 只用来填摘要里的 `scope` / `requestShapeValid`，不参与判定。
 *
 * @param {unknown} frame 已解析的帧
 * @returns {boolean}
 */
export function isSessionRequestRuntimePreferencesRequest(frame) {
  if (frame === null || typeof frame !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (frame);
  const id = record['id'];
  if (typeof id !== 'string' && typeof id !== 'number') return false;
  if (typeof id === 'string' && id.trim() === '') return false;
  return record['method'] === REVERSE_REQUEST_RUNTIME_PREFERENCES;
}

/* -------------------------------------------------------------------------- */
/* 替身/单测用的请求构造器                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 造一帧官方形状的反向请求（`qir` + `fUi`，都 `.strict()`）。
 *
 * **生产路径不用它**——生产是官方 `pTt.requestClient` 发出来的。它只给替身夹具与
 * 单测用，让"官方帧"这件事本身也有可构造、可断言的单一出处。
 *
 * @param {{
 *   id: string,
 *   requestId: string,
 *   sessionId: string,
 *   turnId?: string,
 *   workspace: Record<string, unknown>,
 *   providerId: string,
 *   modelId: string,
 *   accountAccess?: Record<string, unknown>,
 *   reason?: string
 * }} input
 * @returns {Record<string, unknown>} 一帧 `{id, method, params}`
 */
export function buildProviderRuntimeHeadersRequest(input) {
  /** @type {Record<string, unknown>} */
  const params = {
    requestId: input.requestId,
    sessionId: input.sessionId,
    workspace: input.workspace,
    modelSelection: { providerId: input.providerId, modelId: input.modelId },
    providerId: input.providerId,
    reason: input.reason ?? 'model-request'
  };
  if (input.turnId !== undefined) params['turnId'] = input.turnId;
  if (input.accountAccess !== undefined) params['accountAccess'] = input.accountAccess;
  return { id: input.id, method: REVERSE_REQUEST_PROVIDER_RUNTIME_HEADERS, params };
}

/* -------------------------------------------------------------------------- */
/* 应答                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 一次应答的**可断言摘要**。**不含任何凭据值**，也不回显 providerId
 * （providerId 是我们自己的输入，回显它没有诊断价值，却多一处可被塞进秘密的面）。
 *
 * @typedef {{
 *   id: string,
 *   providerIdMatched: boolean,
 *   headersApplied: boolean,
 *   refusalCode: string | null
 * }} ReverseResponseSummary
 */

/**
 * 拒答。
 * @param {string} id
 * @param {string} code {@link REVERSE_REFUSAL_CODES} 之一
 * @param {string} detail 结构化说明，**不含**任何凭据值/providerId 回显
 * @returns {{ frame: { id: string, result: { headersApplied: false, errorMessage: string } }, summary: ReverseResponseSummary }}
 */
function refuse(id, code, detail) {
  const errorMessage = `${code}: ${detail}`.slice(0, REFUSAL_MESSAGE_MAX);
  return {
    frame: { id, result: { headersApplied: false, errorMessage } },
    summary: { id, providerIdMatched: false, headersApplied: false, refusalCode: code }
  };
}

/**
 * 官方在 `refreshBeforeModelRequest` 里**逐字**传给 port 的实参形状
 * （`ZJo` 偏移 14434207）。我们照同一形状调自己的 port：
 * 一来 port 契约与官方一致，二来测试可以逐字段断言。
 *
 * @param {Record<string, any>} params 官方 `fUi` 的 params
 * @returns {Record<string, unknown>}
 */
function toPortArgument(params) {
  /** @type {Record<string, unknown>} */
  const arg = {
    providerId: String(params.providerId ?? ''),
    modelId: String(params.modelSelection?.modelId ?? ''),
    sessionId: params.sessionId,
    reason: params.reason ?? 'model-request'
  };
  if (params.turnId !== undefined) arg['turnId'] = params.turnId;
  if (params.traceContext !== undefined) arg['traceContext'] = params.traceContext;
  if (params.accountAccess !== undefined) arg['accountAccess'] = params.accountAccess;
  return arg;
}

/**
 * 应答一条 provider runtime headers 反向请求。
 *
 * **形状对齐是硬要求**，两处 `.strict()` 都在官方那边：
 *  - 帧：`Vir = {id, result}`，多一个键（`method` / `trace` / `params`）整帧被
 *    `qHt.safeParse` 拒掉（`-32600 Invalid ZCode Protocol message`）。
 *  - result：`DGt` 的 `requestAuth` 是 `{apiKey?, headers?}` 且 `.strict()`。
 *    我们自建 port 的 `requestAuth` 还多一个 `entryKey`，而且**带一个会抛错的
 *    `toJSON`**——所以这里**必须新建对象只取 `apiKey`**，绝不能把 port 的对象直接序列化。
 *
 * @param {{
 *   frame: Record<string, any>,
 *   port: { shouldRefreshBeforeModelRequest?: (n: unknown) => boolean | undefined, refreshBeforeModelRequest: (n: unknown) => unknown },
 *   expectedProviderId: string
 * }} input
 * @returns {Promise<{ frame: Record<string, unknown>, summary: ReverseResponseSummary }>}
 */
export async function resolveProviderRuntimeHeadersResponse({ frame, port, expectedProviderId }) {
  const id = String(frame.id);
  const params = /** @type {Record<string, any>} */ (frame.params);
  const requested = String(params.providerId ?? '');

  // 闸门 1：**跨通道挪用**。port 是按请求帧上的 providerId 建的；官方若为别的
  // providerId 来要凭据，我们拒——否则"白名单只对构造期那一个 providerId 生效"
  // 就会退化成"白名单对所有 providerId 生效"。
  if (requested !== expectedProviderId) {
    return refuse(id, 'PROVIDER_MISMATCH', '反向请求的 providerId 与本次会话绑定的 providerId 不一致，拒绝取键');
  }

  const portArg = toPortArgument(params);

  // 闸门 2：**镜像官方 `dT` 的 shouldRefresh 门**（偏移 12784092）。
  // 注意官方那边"返回假"的后果是**根本不建刷新函数**；而官方自己的缺省 port 恒返回真，
  // 所以它**一定会来问**。我们这边一旦问到了就必须给肯定答复——给不了就只有拒答。
  let should = true;
  if (typeof port.shouldRefreshBeforeModelRequest === 'function') {
    should = port.shouldRefreshBeforeModelRequest(portArg) ?? true;
  }
  if (should !== true) {
    return { ...refuse(id, 'HEADERS_PORT_DECLINED', '自建 port 判定本次模型请求不需要刷新凭据'), summary: { id, providerIdMatched: true, headersApplied: false, refusalCode: 'HEADERS_PORT_DECLINED' } };
  }

  /** @type {unknown} */
  let raw;
  try {
    raw = await port.refreshBeforeModelRequest(portArg);
  } catch (e) {
    if (e instanceof HeadersPortError) {
      // `HeadersPortError.message` 按构造约定只含 code + detail，**零凭据**。
      const refusal = refuse(id, 'HEADERS_PORT_FAILED', `${e.code}: ${e.detail}`);
      return { ...refusal, summary: { id, providerIdMatched: true, headersApplied: false, refusalCode: 'HEADERS_PORT_FAILED' } };
    }
    const refusal = refuse(id, 'UNEXPECTED', '自建 port 抛出未知错误（不附原始异常）');
    return { ...refusal, summary: { id, providerIdMatched: true, headersApplied: false, refusalCode: 'UNEXPECTED' } };
  }

  const result = /** @type {any} */ (raw);
  const apiKey = result?.requestAuth?.apiKey;
  if (result?.headersApplied !== true || typeof apiKey !== 'string' || apiKey.trim() === '') {
    const refusal = refuse(id, 'HEADERS_PORT_SHAPE_INVALID', '自建 port 的返回值不满足官方 DGt 必需条件（headersApplied:true + requestAuth.apiKey）');
    return { ...refusal, summary: { id, providerIdMatched: true, headersApplied: false, refusalCode: 'HEADERS_PORT_SHAPE_INVALID' } };
  }

  // **新建对象、只带 apiKey**：官方 `DGt` 的 `requestAuth` 是 `.strict()` 的
  // `{apiKey?, headers?}`，我们 port 那个多一个 `entryKey`，且 `toJSON` 会抛。
  return {
    frame: { id, result: { headersApplied: true, requestAuth: { apiKey } } },
    summary: { id, providerIdMatched: true, headersApplied: true, refusalCode: null }
  };
}

/* -------------------------------------------------------------------------- */
/* `session/requestRuntimePreferences` 的应答（HOSTFIX4）                     */
/* -------------------------------------------------------------------------- */

/**
 * 一次 runtime preferences 应答的**可断言摘要**。**零凭据**。
 *
 * 字段刻意只有：帧 id、method 字面量、scope（闭集短码或 `null`）、
 * 以及一个布尔 `requestShapeValid`。**没有** providerId 回显、**没有** sessionId
 * （那是官方自己发来的、我们原样回即可的东西，回显它没有诊断价值）、
 * 更没有任何凭据面。
 *
 * @typedef {{
 *   id: string,
 *   method: string,
 *   scope: string | null,
 *   requestShapeValid: boolean,
 *   answered: true
 * }} RuntimePreferencesSummary
 */

/**
 * 应答一条 `session/requestRuntimePreferences` 反向请求。
 *
 * **同步**——不需要 port、不需要 I/O、不需要 await。
 * 这一点很重要：`session-drive.mjs` 必须在同一个 `output` 事件回调里就把
 * `{id, result}` 写回 `input`，否则 `session/create` 会被拖到下一个微任务轮次之后。
 *
 * ## 为什么**没有**拒答分支
 *
 * 本文件其余部分有五道闸门、六条闭集拒答码；**这里一条都没有**，而且是刻意的。
 * 官方 `CKo` 的 catch（逐字）只对 `-32601`（方法未实现）与 `-32020`（无客户端）
 * 返回默认对象，其余一律 `throw l`；`-32022`（15 秒超时）落在"其余"里。
 * 所以对这条 method，**"拒答"在官方那边不是一个存在的姿势**——
 * 我们能做的只有"答"与"15 秒后让整轮 `session/create` 抛掉"两种，
 * 后者显然更糟。fail-closed 落在**值**上（三个 `false`），不落在"不答"上。
 *
 * **因此 {@link REVERSE_REFUSAL_CODES} 保持闭集不变，本分支不新增任何拒答码。**
 *
 * ## 形状对齐
 *
 * 帧逐字 `Vir = m.object({id: yYe, result: m.unknown()}).strict()`（偏移 735705），
 * 多一个键（`method` / `params` / `trace`）整帧会被 `qHt.safeParse` 拒掉并发 `-32600`。
 * `result` 逐字对齐 `pGt`（偏移 759339）——见 {@link RUNTIME_PREFERENCES_FAIL_CLOSED}
 * 的字段表与逐字理由。
 *
 * @param {{ frame: Record<string, any> }} input
 * @returns {{ frame: { id: string, result: Record<string, boolean> }, summary: RuntimePreferencesSummary }}
 */
export function resolveSessionRuntimePreferencesResponse({ frame }) {
  const id = String(frame.id);
  const params = frame.params;
  const scope = params !== null && typeof params === 'object' ? (/** @type {any} */ (params)['scope'] ?? null) : null;

  // 形状核对**只进摘要，不参与判定**（理由见上）。对齐官方 `G5i`（偏移 759235）：
  // `m.object({sessionId:Dn, scope:jsr}).strict()`，其中 `Dn = m.string().trim().min(1)`。
  // `.strict()` 意味着**多一个键就是非法请求**，所以这里逐键比。
  const paramKeys =
    params !== null && typeof params === 'object' ? Object.keys(/** @type {object} */ (params)).sort() : [];
  const sessionId = params !== null && typeof params === 'object' ? (/** @type {any} */ (params)['sessionId']) : undefined;
  const requestShapeValid =
    params !== null &&
    typeof params === 'object' &&
    typeof sessionId === 'string' &&
    sessionId.trim() !== '' &&
    typeof scope === 'string' &&
    REVERSE_RUNTIME_PREFERENCES_SCOPES.includes(scope) &&
    paramKeys.length === RUNTIME_PREFERENCES_REQUEST_FIELDS.length &&
    RUNTIME_PREFERENCES_REQUEST_FIELDS.every((k) => paramKeys.includes(k));

  // **新建普通对象**（不是把冻结常量直接交出去）：应答帧的 `result` 要能被
  // `JSON.stringify`，调用方也不该有能力改到模块级常量。
  return {
    frame: { id, result: { ...RUNTIME_PREFERENCES_FAIL_CLOSED } },
    summary: {
      id,
      method: REVERSE_REQUEST_RUNTIME_PREFERENCES,
      scope: typeof scope === 'string' ? scope : null,
      requestShapeValid,
      answered: true
    }
  };
}
