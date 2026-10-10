/**
 * OFFICIAL-HOST 宿主驱动 —— 把"官方 bundle 当宿主"包成工程既有的 `ChatDriver`。
 *
 * ## 为什么是**子进程**宿主（工单交付物 3 的崩溃隔离结论）
 *
 * 证据（本机逆向，详见报告 §0）：
 *  - **HOSTFIX5 已证伪"进程内 require + 具名导出"这条路**：`C:\ZCode\resources\glm\zcode.cjs`
 *    （14.8 MB CJS）**没有任何具名导出**——`exports.createZCodeApp` /
 *    `exports.runZCodeProtocolAgent` / `exports.startProcessProviderRegistryRuntime`
 *    在全文各 **0 命中**（仅有的两处 `module.exports` 是内部库 shim：inquire / utf8）。
 *    所以本文件**不再 require 官方代码**，改为让子宿主
 *    **spawn** `node <bundle> app-server --stdio --surface desktop`，
 *    官方协议在**子进程自己的 stdin/stdout** 上收发。
 *  - 顶层还跑着一段 CLI bootstrap（bundle 里有 `ZAn();AHo();jkt();…`，会去读
 *    `process.argv[1]` 等），而协议代理内部还会 `process.exit()`。
 *    `process.exit()` **不可被 try/catch 捕获**，也没有"卸载模块"的办法。
 *    即便导出面还在，进程内嵌入在崩溃隔离上也是**结构上做不到**的：
 *    官方内部任何一次 `process.exit()` 或未捕获的 `abort()` 都会带走本 API 服务进程，
 *    而本仓库的硬约束要求"官方内部异常必须被兜住转为该次请求失败，**不得带崩 API 服务进程**"。
 *  - 同形态真实先例 `dsh-zcode-appserver`（MIT，见报告 §0）**也**走子进程：
 *    `spawn(node, [zcode.cjs, 'app-server', '--stdio', '--surface', 'desktop'])`，
 *    NDJSON 过 stdin/stdout；它的注释里还明确记着"openServer 维持『每次一枚、用完即杀』"。
 *
 * 因此本驱动采用**每次请求一枚子进程**的宿主模型（两层：API 服务 → `host-child.mjs`
 * → 官方 app-server）。带来的性质：
 *  - 官方 bundle 的任何崩溃（`process.exit` / 未捕获异常 / 段错误）都只是**子进程的
 *    `exit` 事件**，在父进程里被转成一次请求失败，API 服务进程继续服务。
 *  - **凭据明文不出子进程**：解密与 port 构造全在子进程内完成，明文**从不**经过
 *    父子之间的管道，因此连"父进程内存里存在过明文"这件事都不成立。
 *  - 无进程池、无跨请求状态复用——崩溃的一次请求不会污染下一次。
 *
 * 六条硬事实：
 *  1. **零发送直到显式发起。** `describe()`（拿 `status`/`models`/`catalog`）只让子宿主
 *     spawn 起一个官方 app-server、等它自发第一帧通告，然后零字节地收掉它，
 *     **不**建会话、**不**发 `session/send`。
 *  2. **不传 `standalone`。** 见 `headers-port.ts` 第 5 条。
 *  3. **entitled 只由真实来源推导。** 见 `entitlement.ts`；本驱动只负责把推导结果按官方
 *     `states[id].current` 形状推进去，**没有任何 `entitled: true` 字面量**。
 *  4. **thoughtLevel fail-closed。** 闭集 `low|high|max`；不认识 → 抛错，**不猜、不降级**。
 *  5. **usage 如实透传。** HOSTFIX7 更正：官方 `turn.completed.payload.usage` 给了
 *     `inputTokens` / `outputTokens` 就用；**任一缺失就报 `null`，不编造**。
 *     （原文写的是 `totalTokenCount`——**那个键在 `turn.completed` 的 payload 上不存在**，
 *     它在投影 reducer 上，详见 `scripts/official-host/session-drive.mjs` 的
 *     `mapOfficialUsage` 注释。）
 *  6. **目录复用 PLANSRC。** 不重复造那 18 条：直接 import `mapBuiltinToCatalog` +
 *     `readPlanSources`，得到的就是既有 `/v1/zcc/catalog` 契约的同一份 18 条。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { ApiError } from '../../api/src/errors.js';
import { redactCredentialText } from '../../contracts/src/errors.js';
import type { ChatDriver, DriverCatalog, DriverEvent, DriverModel, DriverRequest, DriverStatus } from '../../api/src/chat.js';
import { foldMessagesToPrompt } from '../../api/src/chat.js';
import { readPlanSources, type PlanSources, type ReadPlanSourcesOptions } from '../../plansrc/src/reader.js';
import { mapBuiltinToCatalog, splitOfferingId } from '../../plansrc/src/mapper.js';
import { evaluateChannelPolicy } from './headers-port.js';
import { deriveEntitledSnapshotFromDocument, type EntitlementEvidence, type SupportedPlanMode } from './entitlement.js';

/** 驱动器名。`x-zcc-driver` / `zcc.driver` 会带上它。 */
export const OFFICIAL_HOST_DRIVER_NAME = 'official-host';

/* -------------------------------------------------------------------------- */
/* thoughtLevel：fail-closed 映射                                               */
/* -------------------------------------------------------------------------- */

/**
 * 推理档位的**闭集**映射。键是本端点认识的档位名，值是官方 `session/create` 顶层
 * `thoughtLevel` 的取值。
 *
 * **只有这三个。** 少一个映射不是"少支持一个档位"，而是"多一条能把用户请求静默改成
 * 另一档的路"。因此映射是**查表 + 不认识即抛**，绝不是 `?? 'high'`。
 */
export const REASONING_TO_THOUGHT_LEVEL: Readonly<Record<string, string>> = Object.freeze({
  low: 'low',
  high: 'high',
  max: 'max'
});

/** 本驱动接受的推理档位闭集（= 映射表的键集合）。测试钉死两者一致。 */
export const KNOWN_REASONING_LEVELS: readonly string[] = Object.freeze(Object.keys(REASONING_TO_THOUGHT_LEVEL));

/* -------------------------------------------------------------------------- */
/* COMPAT1 · C4：官方 agent 的工具权限（env 旋钮的**单一出处**）                 */
/* -------------------------------------------------------------------------- */

/**
 * 官方 `session/create` params 的 `mode` **闭集**。逐字（`$j`，偏移 650957）：
 * `$j=m.enum(["plan","build","edit","yolo","auto"])`。
 *
 * `mode` 在 `session/create` 的 params schema `nGt`（偏移 757102）里逐字在场：
 * ```
 * nGt=m.object({sessionId:Dn.optional(),workspace:rd,parentSessionId:Dn.optional(),
 *              mode:$j.optional(),model:Pu.optional(),persistence:KHt.optional(),
 *              thoughtLevel:Dn.optional(),titleGenerationEnabled:m.boolean().optional(),
 *              mcpServers:m.array(Ype).optional(),toolAllowlist:m.array(Dn).optional(),
 *              toolDenylist:m.array(Dn).optional(),importedHistory:nsr.optional(),
 *              offPeakToolEnabled:m.boolean().optional(),dynamicWorkflowEnabled:m.boolean().optional()}).strict()
 * ```
 *
 * **没有** `bypassPermissions` / `acceptEdits` / `permissionMode` 这类键——`nGt` 是
 * `.strict()` 的，那三个字面量只出现在 `offPeak/create` 的 params（`qUi`，偏移 783428）
 * 与设置项枚举（`Uee`，偏移 724311）上，**都不在** `session/create` 这条路上。
 * 官方在 `session/create` 这条路上唯一的权限旋钮就是 `mode`。
 *
 * ## 逐字链路：`mode:"yolo"` 确实免问（但**不是全部**）
 *
 * ```
 * EXa @14515349   runtimeConfig:{ mode:"mode"in t?t.mode:void 0, … }
 * Gzo @13792229   e.runtimeConfig?.mode && (n.mode=e.runtimeConfig.mode)
 *                  Object.keys(n).length>0 && (t.permission=n)
 * UM  @5092771    checkPermission(t,n,o,s){ … let u=t.planEnabled??t.mode==="plan";
 *                    return t.mode==="yolo"&&!u
 *                      ? this.allow(t,a,"mode.yolo","Yolo mode bypasses permission prompts")
 *                      : t.mode==="auto"
 *                        ? this.deny(t,a,"mode.auto.unimplemented","Auto mode is reserved but not implemented yet")
 *                        : … }
 * Ooo @5002466    if(s.decision==="ask") { … e.deps.permissionBroker.requestPermission(…) }
 * ```
 *
 * 三条必须一起记的事实：
 *  1. `yolo` 让 `checkPermission` 对普通工具直接返回 `allow`（`ruleId:"mode.yolo"`），
 *     于是 `Ooo` 那条 `decision==="ask"` 的反向请求分支**根本走不到**。
 *  2. **但它不是总闸门**：`checkPermission` 的**前两条**早于 `mode` 判定——
 *     `a.requiresUserInteraction` 与 `a.alwaysAsk` 都会**先** `return this.ask(...)`。
 *     官方因此**仍有能力**发 `interaction/requestPermission`。
 *     所以"下发 mode"与"反向应答器"两条路**都要有**：前者堵住绝大多数，后者兜住剩下的。
 *  3. **`auto` 不能选**：官方逐字把它判成 `deny`
 *     （`"Auto mode is reserved but not implemented yet"`）——那等于每次工具调用都被拒。
 */
export const OFFICIAL_SESSION_MODES: readonly string[] = Object.freeze(['plan', 'build', 'edit', 'yolo', 'auto']);

/** 受控 workspace 权限档位的 env 覆盖键。缺省见 {@link resolveHostPermissionMode}。 */
export const HOST_PERMISSION_MODE_ENV_KEY = 'ZCC_HOST_PERMISSION_MODE';

/**
 * 缺省下发的 `mode`。`yolo` 是闭集里**唯一**逐字写着 "bypasses permission prompts"
 * 的取值。
 */
export const DEFAULT_HOST_PERMISSION_MODE = 'yolo';

/**
 * 解析要下发给官方 `session/create` 的 `mode`。**闭集 + 缺省 `yolo`，闭集外抛错**。
 *
 * 为什么不回落：一个拼错的 `ZCC_HOST_PERMISSION_MODE=YOLO` 若静默变成 `build`，
 * 运维会以为在免问、实际每次工具操作都在反向问——而"不答"就是挂 300 s；
 * 静默变成 `yolo` 则是**安全方向的放松**。两种都是"配置说了什么"被偷偷改掉。
 *
 * @param env 环境（可注入，测试用）
 * @returns 官方 `$j` 闭集里的一个取值
 * @throws OfficialHostConfigError（本函数抛普通 `Error`，见下方说明）
 */
export function resolveHostPermissionMode(
  env: Readonly<Record<string, string | undefined>> = process.env as Readonly<Record<string, string | undefined>>
): string {
  const raw = env[HOST_PERMISSION_MODE_ENV_KEY]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_HOST_PERMISSION_MODE;
  if (!OFFICIAL_SESSION_MODES.includes(raw)) {
    throw new OfficialHostConfigError(
      'PERMISSION_MODE_UNSUPPORTED',
      `${HOST_PERMISSION_MODE_ENV_KEY}=${JSON.stringify(raw)} 不在闭集内（${OFFICIAL_SESSION_MODES.join(' | ')}）：拒绝启动而不是猜一档权限`
    );
  }
  return raw;
}

/**
 * 工具权限应答策略的 env 键（工单 COMPAT1/C4）。取值闭集 `allow | deny`，**缺省 `allow`**。
 *
 * 缺省 `allow` 的理由（不是"图省事"）：本子宿主的 workspace 是
 * {@link resolveHostWorkspaceRoot} 给的**隔离临时目录**，且有
 * {@link isZCodeStorageRootPath} 闸门保证它绝不落在 ZCode 存储根内——官方 agent 的文件
 * 工具因此天然被限制在一个一次性目录里。把这一层沙箱交给"要问谁"是不成立的：
 * **没有人在线上等这个回答**。而"不答"的代价是官方 `pTt.requestClient` 逐字
 * `s?.timeoutMs!==void 0 && (f.timeout=setTimeout(…))`——权限那条经 `dRn`（偏移 14447817）
 * **根本没有** `timeoutMs`，于是 promise 永不落定，只能挂到我们自己的 300 s 墙钟上限
 * （协调者实弹：挂满 300 秒）。
 *
 * 需要收紧的运维用 `ZCC_HOST_TOOL_POLICY=deny`：**如实回拒绝**，不假装放行。
 */
export const HOST_TOOL_POLICY_ENV_KEY = 'ZCC_HOST_TOOL_POLICY';

/** 工具权限策略的取值闭集。测试逐条断言。 */
export const HOST_TOOL_POLICIES: readonly string[] = Object.freeze(['allow', 'deny']);

/** 缺省工具权限应答策略。放行（理由见 {@link HOST_TOOL_POLICY_ENV_KEY}）。 */
export const DEFAULT_HOST_TOOL_POLICY = 'allow' as const;

/**
 * 解析工具权限应答策略。**闭集 + 缺省 `allow`，闭集外抛错**（理由同
 * {@link resolveHostPermissionMode}：不让"配置说了什么"与"实际生效什么"分叉）。
 *
 * @param env 环境（可注入，测试用）
 * @returns `'allow' | 'deny'`
 */
export function resolveHostToolPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env as Readonly<Record<string, string | undefined>>
): 'allow' | 'deny' {
  const raw = env[HOST_TOOL_POLICY_ENV_KEY]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_HOST_TOOL_POLICY;
  if (!HOST_TOOL_POLICIES.includes(raw)) {
    throw new OfficialHostConfigError(
      'TOOL_POLICY_UNSUPPORTED',
      `${HOST_TOOL_POLICY_ENV_KEY}=${JSON.stringify(raw)} 不在闭集内（${HOST_TOOL_POLICIES.join(' | ')}）：拒绝启动而不是猜一个权限策略`
    );
  }
  return raw as 'allow' | 'deny';
}

/**
 * 子宿主会话墙钟的 env 键（2026-10-10）。缺省见 {@link DEFAULT_HOST_TURN_TIMEOUT_MS}。
 *
 * 为什么必须可配：真客户端的长编码任务动辄超过缺省 5 分钟——墙钟到点 SIGKILL 子宿主，
 * SSE 流被拦腰截断，客户端侧表现为 `net::ERR_INCOMPLETE_CHUNKED_ENCODING`（协调者日志
 * 实测：两条 `ms=300034/300143` 的"200"正是墙钟收束）。运维按任务形态拉长，如
 * `ZCC_HOST_TURN_TIMEOUT_MS=1800000`（30 分钟）。
 */
export const HOST_TURN_TIMEOUT_ENV_KEY = 'ZCC_HOST_TURN_TIMEOUT_MS';

/** 缺省子宿主会话墙钟（毫秒）。历史行为原值，未配置时一字不变。 */
export const DEFAULT_HOST_TURN_TIMEOUT_MS = 300_000;

/**
 * 解析子宿主会话墙钟（毫秒）。**正整数 + 缺省 300000，非法抛错**（理由同
 * {@link resolveHostPermissionMode}：静默回落缺省会让"配置写了 30 分钟"与
 * "实际 5 分钟杀进程"分叉——那正是要修的 bug 本身）。
 *
 * @param env 环境（可注入，测试用）
 * @returns 墙钟毫秒数
 */
export function resolveHostTurnTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env as Readonly<Record<string, string | undefined>>
): number {
  const raw = env[HOST_TURN_TIMEOUT_ENV_KEY]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_HOST_TURN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 86_400_000) {
    throw new OfficialHostConfigError(
      'TURN_TIMEOUT_UNSUPPORTED',
      `${HOST_TURN_TIMEOUT_ENV_KEY}=${JSON.stringify(raw)} 必须是 1..86400000 之间的整数毫秒：拒绝启动而不是猜一个超时`
    );
  }
  return value;
}

/**
 * 推理档位 → 官方 `thoughtLevel`。**fail-closed**：不认识就抛错。
 *
 * @param reasoning 请求的 reasoning 档位原值
 * @returns 官方 `thoughtLevel` 取值
 * @throws OfficialHostConfigError（code `REASONING_LEVEL_UNKNOWN` / `REASONING_LEVEL_MISSING`）
 */
export function mapReasoningToThoughtLevel(reasoning: unknown): string {
  if (typeof reasoning !== 'string' || reasoning.trim() === '') {
    throw new OfficialHostConfigError('REASONING_LEVEL_MISSING', `推理档位缺失：只接受 ${KNOWN_REASONING_LEVELS.join(' | ')}，不猜默认值`);
  }
  const key = reasoning.trim();
  const hit = REASONING_TO_THOUGHT_LEVEL[key];
  if (hit === undefined) {
    throw new OfficialHostConfigError('REASONING_LEVEL_UNKNOWN', `推理档位 ${JSON.stringify(key)} 不在闭集内（${KNOWN_REASONING_LEVELS.join(' | ')}）：报错而不是猜一档`);
  }
  return hit;
}

export const OFFICIAL_HOST_ERROR_CODES = [
  'BUNDLE_NOT_FOUND',
  'CHILD_SPAWN_FAILED',
  'CHILD_EXITED',
  'CHILD_PROTOCOL_VIOLATION',
  'CHILD_TIMEOUT',
  'REASONING_LEVEL_MISSING',
  'REASONING_LEVEL_UNKNOWN',
  'MODEL_ID_MALFORMED',
  'PLAN_MODE_UNSUPPORTED',
  'NOT_ENTITLED',
  'STORAGE_ISOLATION_UNSAFE',
  'PROVIDER_CONFIG_NOT_FOUND',
  'PERMISSION_MODE_UNSUPPORTED',
  'TOOL_POLICY_UNSUPPORTED',
  'TURN_TIMEOUT_UNSUPPORTED'
] as const;
export type OfficialHostErrorCode = (typeof OFFICIAL_HOST_ERROR_CODES)[number];

/** 配置 / 契约层错误。**不**含任何凭据值。 */
export class OfficialHostConfigError extends Error {
  readonly code: OfficialHostErrorCode;
  constructor(code: OfficialHostErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'OfficialHostConfigError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* 父子通道协议（我们自己的，不是官方协议）                                     */
/* -------------------------------------------------------------------------- */

/** 父子通道协议版本。与官方 NDJSON 协议**无关**，不要混用。 */
export const HOST_CHANNEL_VERSION = 1;

/** 父 → 子 请求帧的**唯一**顶层键。`.strict()` 语义：多一个键就是协议违规。 */
export const HOST_REQUEST_KEYS = Object.freeze(['zccHost'] as const);

export type HostChannelRequest =
  | { readonly op: 'describe' }
  | {
      readonly op: 'run';
      readonly workspacePath: string;
      readonly providerId: string;
      readonly modelId: string;
      readonly planMode: SupportedPlanMode;
      readonly entitled: boolean;
      readonly thoughtLevel: string;
      readonly prompt: string;
      readonly maxTokens: number | null;
      readonly operationId: string;
    };

export type HostChannelEvent =
  | { readonly type: 'ready'; readonly bundle: string; readonly exports: readonly string[] }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'usage'; readonly promptTokens: number | null; readonly completionTokens: number | null; readonly usageMethod: string }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'length' }
  | { readonly type: 'failed'; readonly code: string; readonly detail: string };

/** 官方 bundle 位置。**只读 require/spawn，绝不写、绝不改。 */
export const DEFAULT_BUNDLE_PATH = 'C:/ZCode/resources/glm/zcode.cjs';

/** 子宿主脚本位置（薄壳：spawn 官方 app-server + 驱动会话；会话逻辑在 `packages/official-host/src/`，传输逻辑在 `scripts/official-host/`）。 */
export function resolveHostChildScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, '..', '..', '..', 'scripts', 'official-host', 'host-child.mjs');
}

/* -------------------------------------------------------------------------- */
/* 子进程异常文本净化（B5）                                                      */
/* -------------------------------------------------------------------------- */

/** 子宿主 detail 净化后的最大长度。**净化之后再截断**，所以截断不会切出半个密钥。 */
export const CHILD_DETAIL_MAX_CHARS = 200;

/**
 * 子宿主 `detail` 里的**错误类别名**白名单。只有匹配这一形状的前缀会原样保留；
 * 其余整段丢弃。
 *
 * 这学的是 `scripts/official-tap/tap-core.mjs` 的 `sanitizeDiagFields`
 * （键白名单 + 原语 + 长度上限，"忘了脱敏"在结构上不可能发生）的**同一档**做法，
 * 只是这里白名单的对象从"诊断字段"换成"错误类别名"。
 *
 * 形状：`^[A-Z][A-Z0-9_]{2,63}:` —— 官方与本包自己用的都是 `CODE: message` 形态。
 */
export const CHILD_DETAIL_CATEGORY_PATTERN = /^[A-Z][A-Z0-9_]{2,63}:/;

/** 凭据形态被替换成的占位符。与 contracts 侧同名常量同值（同源口径，见 `redactCredentialText`）。 */
export const CHILD_DETAIL_REDACTION = '[redacted]';

/* -------------------------------------------------------------------------- */
/* HOSTFIX5：标识符不误伤（实弹 `[redacted]` 吃掉了官方符号名）                 */
/* -------------------------------------------------------------------------- */

/**
 * **标识符形状**：`[A-Za-z_$][A-Za-z0-9_$.]{0,64}`。
 *
 * 它是"长随机串"那条规则的**反面**：32 位以上、字母数字下划线点组成的串**默认**按凭据
 * 处理（BL-3 的既有契约，见 `packages/contracts/src/errors.ts`）。所以**光有形状不构成豁免**
 * ——`A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWxYz0123456789_-`（48 字符）**逐字满足**这个形状，
 * 它仍然是凭据形态，仍然必须被脱敏。本文件的豁免是**白名单**而不是"形状"（理由见
 * {@link KNOWN_DIAGNOSTIC_IDENTIFIERS}）。
 */
export const DIAGNOSTIC_IDENTIFIER_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$.]{0,64}$/;

/**
 * **我们自己在错误消息里会逐字写出的、允许不被长 token 规则吞掉的名字**（闭集）。
 *
 * ## 为什么要有它（HOSTFIX5 实弹首战的直接后果）
 *
 * 2026-10-01 09:34 的实弹响应里，子宿主的失败 detail 是
 * `BUNDLE_EXPORTS_INCOMPLETE: 官方 bundle 缺少 createZCodeApp, [redacted], runZCodeProtocolAgent`。
 * `[redacted]` 吃掉的那个名字是 `startProcessProviderRegistryRuntime`（33 字符）——
 * **它不是凭据，是我们自己写的一个官方导出符号名**。脱敏规则在这里把**可运维性**打没了。
 *
 * ## 为什么是白名单而不是"标识符形状一律豁免"
 *
 * 形状豁免会**放宽**既有性质，量化如下：凭据的形态是 `[A-Za-z0-9_.-]` 的极大连续段，
 * 长度 ≥32。**一个 33 字符的 base62 随机串满足"标识符形状"的概率是 1**（它必然以字母开头、
 * 长度必然 ≤65、字符必然全在类里）。所以"形状即豁免"等于"33 字符以上的凭据一律放行"——
 * 直接推翻 BL-3 复审 §6.2 钉死的那条不漏拦性质，也推翻本仓 9 条 B5 断言。
 *
 * 白名单是**我们自己写死的有限个名字**，每一个都有"它是我们写的常量、不是数据"的理由。
 * 白名单成员被伪造成一个恰好等于某个成员的真实密钥的概率，等于该密钥本身就是那个名字。
 */
export const KNOWN_DIAGNOSTIC_IDENTIFIERS: ReadonlySet<string> = new Set([
  // 官方 bundle 的三个具名导出符号（HOSTFIX3 报告 §1.7 的 37 个导出符号之一部分）。
  // **注意**：`startProcessProviderRegistryRuntime` 是 33 字符，正是被长 token 规则吞掉的那个。
  'createZCodeApp',
  'startProcessProviderRegistryRuntime',
  'runZCodeProtocolAgent',
  // 官方协议里那个我们讨论了三个工单的 port 名（26 字符，本来就不到阈值，收进来是为了闭集完整）。
  'providerRuntimeHeadersPort',
  // 官方 Provider Registry 的两个必填 env 键（各 32 字符，**同样**会被长 token 规则吞掉）。
  'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
  'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE',
  // 本仓自己的诊断开关（17 字符，低于阈值；收进来是为了让闭集覆盖"我们会在 detail 里写的名字"）。
  'ZCC_HOST_DEBUG'
]);

/**
 * 这个串是不是"我们写死的、允许出现在错误消息里的标识符"。
 *
 * 判据**两条同时成立**：① 逐字满足 {@link DIAGNOSTIC_IDENTIFIER_SHAPE}（所以一个
 * 夹带空格/换行/长串的东西进不来）；② 在 {@link KNOWN_DIAGNOSTIC_IDENTIFIERS} 闭集里。
 *
 * @param value 待判的候选串
 */
export function isKnownDiagnosticIdentifier(value: string): boolean {
  return DIAGNOSTIC_IDENTIFIER_SHAPE.test(value) && KNOWN_DIAGNOSTIC_IDENTIFIERS.has(value);
}

/**
 * 脱敏期间的**替身符**前后缀。
 *
 * 选 `␟`（SYMBOL FOR UNIT SEPARATOR）的唯一理由：它**不在**长 token 规则的字符类
 * `[A-Za-z0-9_.-]` 里，所以替身符 `␟0␟` 的"token"就是一个孤零零的数字（长度 1 < 32），
 * 任何一条凭据正则都匹配不上它；而真正的名字被**整个替换掉**，不是被包围起来
 * （包围没有用——长 token 规则仍会匹配名字本身）。
 */
const DIAGNOSTIC_PLACEHOLDER_EDGE = '␟';

/** 找出文本里所有"白名单标识符"的出现位置。**只认标识符形状的完整词**。 */
function findKnownDiagnosticIdentifiers(text: string): string[] {
  return (text.match(/[A-Za-z_$][A-Za-z0-9_$.]{0,64}/g) ?? []).filter(isKnownDiagnosticIdentifier);
}

/**
 * 把白名单标识符换成替身符，交给 {@link redactCredentialText} 之后再换回来。
 *
 * 这是**局部**保护：不改共享的 `redactCredentialText`（那条是 API 层的整条丢弃判据共用
 * 的，动它风险面太大），也不改 contracts 层的任何正则——所以"`looksLikeCredentialValue`
 * 与 `redactCredentialText` 同源"那条既有性质**一字未动**。
 *
 * @param text 待保护的文本
 * @returns 受保护的文本 + 被换走的名字（按出现顺序）
 */
function protectKnownDiagnosticIdentifiers(text: string): { masked: string; names: string[] } {
  const names: string[] = [];
  const masked = text.replace(/[A-Za-z_$][A-Za-z0-9_$.]{0,64}/g, (word) => {
    if (!isKnownDiagnosticIdentifier(word)) return word;
    const index = names.length;
    names.push(word);
    return `${DIAGNOSTIC_PLACEHOLDER_EDGE}${String(index)}${DIAGNOSTIC_PLACEHOLDER_EDGE}`;
  });
  return { masked, names };
}

/**
 * 把 {@link protectKnownDiagnosticIdentifiers} 换走的名字放回去。
 * @param text 已脱敏的文本
 * @param names 换走的名字（按出现顺序）
 */
function restoreKnownDiagnosticIdentifiers(text: string, names: readonly string[]): string {
  if (names.length === 0) return text;
  const pattern = new RegExp(`${DIAGNOSTIC_PLACEHOLDER_EDGE}([0-9]+)${DIAGNOSTIC_PLACEHOLDER_EDGE}`, 'g');
  return text.replace(pattern, (whole, digits: string) => {
    const index = Number.parseInt(digits, 10);
    return index >= 0 && index < names.length ? (names[index] as string) : whole;
  });
}

/**
 * 净化子宿主产出的异常文本。**在它进 `ApiError.detail` / 错误消息之前跑**。
 *
 * 为什么要净化（B1 修好后这里的自由文本只剩协议错误，但 B2/B3 修好前**官方 bundle
 * 抛出的任意异常消息**是它唯一的出口——一条 `apiKey=<49 字符非 sk- 前缀>` 就
 * 能直达 API 响应）。API 层的 `sanitizeMessage` 只在**整条**消息像凭据时才整条丢弃，
 * 覆盖面有限（见 `packages/contracts/src/errors.ts` 的模式表），所以这里做**局部**脱敏。
 *
 * 四道，顺序固定：
 *  1. **错误类别名归一**：只有匹配 {@link CHILD_DETAIL_CATEGORY_PATTERN} 的**前缀**
 *     （形如 `SESSION_TIMEOUT:`）被认定为类别名并原样保留；不匹配的整段前缀**剥离**。
 *     这是"白名单"的落点——只有被认出的类别名才准原样出去，其余一律当作不可信自由文本。
 *  1.5. **（HOSTFIX5）白名单标识符保护**：仅在第 1 道认出错误码时，把
 *     {@link KNOWN_DIAGNOSTIC_IDENTIFIERS} 里的名字换成**任何凭据正则都匹配不上的**替身符，
 *     第 2 道之后再换回来。理由与"为什么是白名单而不是按形状豁免"见该常量的注释。
 *  2. **凭据形态 → 占位符**（`redactCredentialText`，与 API 层共用同一组正则，
 *     所以"API 层判得出"与"这里脱得掉"口径永远一致，不会留缝）。
 *  3. **长度上限**（{@link CHILD_DETAIL_MAX_CHARS}）；截断发生在脱敏**之后**、
 *     且在**标识符还原之后**，所以不会切出半个密钥，也不会把替身符写进输出。
 *
 * 注意本函数**不丢弃**不含凭据形态的正常文本：`CHANNEL_REFUSED: paid channel blocked`
 * 这类结构化失败原因必须能原样到达运维。真正的丢弃只发生在 API 层的
 * `sanitizeMessage`（整条像凭据时），那一条不动。
 *
 * @param detail 子宿主回报的原始 detail
 * @returns 可安全进入错误消息的文本
 */
export function sanitizeChildDetail(detail: unknown): string {
  const raw = typeof detail === 'string' ? detail : String(detail);
  // 第 1 道：错误类别名归一（白名单）。
  const match = CHILD_DETAIL_CATEGORY_PATTERN.exec(raw);
  const category = match === null ? '' : match[0];
  const rest = match === null ? raw : raw.slice(category.length).trim();
  // 第 1.5 道（HOSTFIX5）：**仅当**这条消息带已知错误码（`category !== ''`）时，
  // 把"我们自己写死的标识符"先摘出去，免得被第 2 道的长 token 规则当成凭据吞掉
  // （实弹：`startProcessProviderRegistryRuntime` 被 `[redacted]` 吃掉）。
  // 没有错误码前缀的自由文本**不享受**这条豁免——那类文本的来源不可控。
  const protectedIdentifiers = category === '' ? { masked: rest, names: [] as string[] } : protectKnownDiagnosticIdentifiers(rest);
  // 第 2 道：凭据形态脱敏。
  const body = restoreKnownDiagnosticIdentifiers(redactCredentialText(protectedIdentifiers.masked), protectedIdentifiers.names);
  // 第 3 道：长度上限。
  const clipped =
    body.length <= CHILD_DETAIL_MAX_CHARS ? body : `${body.slice(0, CHILD_DETAIL_MAX_CHARS)}…（已截断）`;
  if (category === '') return clipped;
  return clipped === '' ? category.replace(/:$/, '') : `${category} ${clipped}`;
}

/* -------------------------------------------------------------------------- */
/* 崩溃隔离：子进程传输层                                                      */
/* -------------------------------------------------------------------------- */

export type SpawnHostChild = (args: readonly string[]) => ChildProcessWithoutNullStreams;

/** 缺省 spawn：官方 bundle + 子宿主脚本，NDJSON 过 stdio。`windowsHide` 与 tap 一致。 */
export const defaultSpawnHostChild: SpawnHostChild = (args) => {
  const [script, ...rest] = args;
  if (script === undefined) throw new OfficialHostConfigError('CHILD_SPAWN_FAILED', '子宿主脚本路径缺失');
  // bundle 路径从 argv 里取（`--bundle <path>`），用来推导 builtin provider config 的
  // 兄弟目录落点。见 `resolveHostBuiltinProviderConfigFile`。
  const bundleFlag = rest.indexOf('--bundle');
  const bundlePath = bundleFlag >= 0 ? rest[bundleFlag + 1] : undefined;
  return spawn(process.execPath, [script, ...rest], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: buildIsolatedChildEnv(
      process.env as Readonly<Record<string, string | undefined>>,
      undefined,
      bundlePath
    )
  }) as ChildProcessWithoutNullStreams;
};

/** 不下发给子宿主的键。子宿主**不需要**我们的任何控制面配置。 */
export const HOST_CHILD_STRIPPED_ENV_KEYS = Object.freeze(['ZCC_TAP_TOKEN', 'ZCC_TAP_TOKEN_FILE']);

export function buildChildEnv(ownEnv: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(ownEnv)) {
    if (value === undefined) continue;
    if (HOST_CHILD_STRIPPED_ENV_KEYS.includes(key)) continue;
    // 存储重定向键**不继承**：它必须由本文件的隔离层无条件决定（见 buildIsolatedChildEnv）。
    // 继承父进程里可能存在的同名键，等于把"是否隔离"交给一个我们不掌控的环境变量。
    if (HOST_CHILD_STORAGE_ENV_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 存储隔离（B2 安全红线）                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 子宿主重定向键的**名**。声明在 {@link HOST_CHILD_STORAGE_ENV_KEYS} 之前，
 * 因为那一条 `Object.freeze([...])` 在模块求值期就要读到它们。
 *
 * 逐字依据（`C:\ZCode\resources\glm\zcode.cjs`，latin1 只读，偏移为字符偏移）：
 *  - 偏移 1067160 `var LV,OXe,tte,MXe,vmr = Y(()=>{ LV = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
 *    OXe = "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE",
 *    tte = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", MXe = "provider_config.json"; … })`
 *  - 偏移 4073622 `rB`：`let … o = e.logDir ?? e.env?.ZCODE_LOG_DIR ?? N6s(), …`
 *  - 偏移 9063 `cz = "ZCODE_RUNTIME_ENV"`（注册名 `ZCODE_RUNTIME_ENV_KEY`）。
 */

/**
 * 子宿主的 ZCode Built-in Provider Config 路径键。**官方逐字**：
 *
 * ```
 * 偏移 1067031  function ymr(e){ let t = e[LV]?.trim(), n = e[tte]?.trim();
 *            if(!t && !n) return null;
 *            if(!t || !n) throw new Error("ZCode Built-in 与 Personal Provider Config 路径必须同时提供");
 *            return Object.freeze({ zcodeBuiltinFilePath: t, personalFilePath: n }) }
 * 偏移 14125746 function Ykt(e,t={}){ let n = ymr(e);
 *            if(!n) throw new Error("缺少进程 Provider Registry 的 ZCode Built-in / Personal Config 路径"); … }
 * ```
 *
 * **所以这两个键缺一即致命**：`Ykt`（`startProcessProviderRegistryRuntime`）的**第一句**
 * 就要求它们同时存在，缺则抛错；官方 protocol agent（`NXo`）自己也会
 * `Ykt(e.env ?? process.env)` 再起一份运行时（偏移 14679552 逐字
 * `U = await N3e({ …, create: r(() => Ykt(z), "create"), … })`），所以**只在我们自己这一份
 * 运行时上补键是不够的**——必须补在**子进程 env** 上，两份运行时才都过得去。
 */
export const HOST_BUILTIN_PROVIDER_CONFIG_ENV_KEY = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE';

/** 子宿主的 Personal Provider Config 路径键。见 {@link HOST_BUILTIN_PROVIDER_CONFIG_ENV_KEY} 的逐字证据。 */
export const HOST_PERSONAL_PROVIDER_CONFIG_ENV_KEY = 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE';

/** 子宿主官方日志目录的 env 键。逐字见 {@link HOST_LOG_DIR_ENV_KEY} 的证据。 */
export const HOST_LOG_DIR_ENV_KEY = 'ZCODE_LOG_DIR';

/** 关闭官方 model-io rollout 的官方开关键。逐字见 {@link HOST_RUNTIME_ENV_KEY} 的证据。 */
export const HOST_RUNTIME_ENV_KEY = 'ZCODE_RUNTIME_ENV';

/**
 * 子宿主重定向键（含存储、Provider Config、日志、runtime env）。
 * `buildChildEnv` **不继承**它们：是否隔离不能取决于一个我们不掌控的父进程环境变量。
 *
 * 存储三键的**官方逐字**（`C:\ZCode\resources\glm\zcode.cjs`，只读）：
 *
 *  - 偏移 4093306 `aun`（注册名 `parseEnvConfig`）逐字：
 *    `function aun(e=process.env,t={}){let n=t.prefix??Pjs;…let l=s.slice(n.length);
 *     l==="STORAGE_DIR"?(o.storage||(o.storage={}),o.storage.dir=a):
 *     l==="SESSION_DB_PATH"||l==="SESSION_DB"?(o.storage||(o.storage={}),o.storage.sessionDbPath=a):…}`
 *    其中 `Pjs="ZCODE_"`（同处注册）。所以 `ZCODE_STORAGE_DIR` → `config.storage.dir`、
 *    `ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB` → `config.storage.sessionDbPath`。
 *    （这两个名字是**前缀剥离后**比较的，所以产物里搜不到字面量 `ZCODE_SESSION_DB_PATH`。）
 *  - 偏移 4106757 `K0` 逐字：`let _=aun(e.env??process.env); Object.keys(_).length>0&&t.push(fG(gun(_,{kind:"internal"}),Ek.Env))`
 *    ——env 配置**确实**进 `config` 合并链（优先级 `Ek.Env`=40，见偏移 1300468 的
 *    `eyr={[Ek.System]:0,…,[Ek.Env]:40,[Ek.Cli]:50}`）。
 *  - 偏移 1301831 默认值逐字：`storage:{dir:"~/.zcode", sessionDbPath:"~/.zcode/cli/db/db.sqlite"}`。
 *  - 偏移 13795074 `jie`（注册名 `getSessionDbPath`）逐字：`function jie(e,t){let n=e.config.storage.sessionDbPath; …}`
 *    ——`sessionDbPath` 唯一的读点；`NXo` 启动即 `lPn({dbPath:jie(B)})`。
 *
 * **为什么不用 `ZCODE_DATA_BASE_DIR`**：它确实存在（偏移 4300169 `t$s="ZCODE_DATA_BASE_DIR"`、
 * 偏移 3937152 `dLs`），但它的消费点 `n$s`（注册名 `resolveSharedZCodeCredentialsPath`，
 * 偏移 4298550）逐字是
 * `function n$s(e={}){…let n=e.baseDir??t[t$s]??homedir(); return join(resolveUserPath(n),".zcode","v2","credentials.json")}`
 * ——**它会把凭据仓一起搬走**。我们要读真实凭据仓解 key，所以**不设**它。
 */
export const HOST_CHILD_STORAGE_ENV_KEYS: readonly string[] = Object.freeze([
  'ZCODE_STORAGE_DIR',
  'ZCODE_SESSION_DB_PATH',
  'ZCODE_SESSION_DB',
  // BL-1：官方 `Ykt` 首句的前置条件（`ymr` 要求这两个键**同时**非空）。
  HOST_BUILTIN_PROVIDER_CONFIG_ENV_KEY,
  HOST_PERSONAL_PROVIDER_CONFIG_ENV_KEY,
  // BL-4：日志目录与 model-io rollout 的关闭开关，都由隔离层无条件决定。
  HOST_LOG_DIR_ENV_KEY,
  HOST_RUNTIME_ENV_KEY
]);

/* -------------------------------------------------------------------------- */
/* Provider Registry 的两个必填 env（BL-1）                                     */
/* -------------------------------------------------------------------------- */

/**
 * 官方 CLI 为 Personal Provider Config 选的默认路径。**逐字**（偏移 1068198
 * `prepareCliProviderRuntimeEnv` = `dQi`）：
 * `let a = n ?? (0,Zj.join)(o, ".zcode", "v2", MXe)`，其中 `MXe = "provider_config.json"`、
 * `o = e.dataBaseDir ?? e.env.ZCODE_DATA_BASE_DIR?.trim() ?? (0,Smr.homedir)()`。
 *
 * 本驱动**刻意不设** `ZCODE_DATA_BASE_DIR`（那会把凭据仓一起搬走），因此官方的
 * `o` 会落到 `homedir()`，即 `~/.zcode/v2/provider_config.json`。
 */
export const OFFICIAL_PERSONAL_PROVIDER_CONFIG_RELATIVE_PATH = '.zcode/v2/provider_config.json';

/**
 * 官方 Built-in Provider Config 的**资产文件名**与它在安装目录里的相对落点。
 *
 * 逐字来源两处：
 *  - 偏移 1069537 `wmr = "zcode-provider/zcode-builtin.json"`（SEA 资产键）。
 *  - 偏移 1069159 `resolveBundledZCodeBuiltinProviderConfig` = `fQi` 逐字：
 *    `let n = (0,Zj.dirname)((0,Zj.resolve)(t)),
 *          o = [ (0,Zj.join)(n, "provider", "zcode-builtin.json"),
 *                (0,Zj.resolve)(n, "../../../../../config/provider/zcode-builtin.json") ],
 *          s = o.find(a => (0,bmr.existsSync)(a)); if(s) return s; throw new Error(…)`
 *
 * `fQi` 的第一个候选是 `dirname(bundle)/provider/zcode-builtin.json`，第二个是
 * `dirname(bundle)/../../../../../config/provider/zcode-builtin.json`。本机安装布局是
 * `C:\ZCode\resources\glm\zcode.cjs`，两个候选**都不存在**（实测 `existsSync` 均为 false，
 * 第二个解析成 `C:\config\provider\zcode-builtin.json`），真正落地的那份资产是
 * **`C:\ZCode\resources\config\provider\zcode-builtin.json`**
 * （188476 字节，mtime 2026-09-29T03:21:16Z，**只读引用**）。
 */
export const OFFICIAL_BUILTIN_PROVIDER_CONFIG_FILE_NAME = 'zcode-builtin.json';

/** 缺省 Built-in Provider Config（本机官方安装布局）。**只读引用**，本驱动从不写它。 */
export const DEFAULT_BUILTIN_PROVIDER_CONFIG_FILE = `C:/ZCode/resources/config/provider/${OFFICIAL_BUILTIN_PROVIDER_CONFIG_FILE_NAME}`;

/** Built-in Provider Config 的**运维覆盖键**。缺省见 {@link resolveHostBuiltinProviderConfigFile}。 */
export const HOST_BUILTIN_PROVIDER_CONFIG_OVERRIDE_ENV_KEY = 'ZCC_HOST_BUILTIN_PROVIDER_CONFIG';

/** Personal Provider Config 的**运维覆盖键**。缺省见 {@link resolveHostPersonalProviderConfigFile}。 */
export const HOST_PERSONAL_PROVIDER_CONFIG_OVERRIDE_ENV_KEY = 'ZCC_HOST_PERSONAL_PROVIDER_CONFIG';

/**
 * 解析子宿主的 Built-in Provider Config 路径。
 *
 * 优先级：`ZCC_HOST_BUILTIN_PROVIDER_CONFIG`（显式覆盖）→ 由 bundle 路径推出的兄弟配置目录
 * （`dirname(bundle)/../config/provider/zcode-builtin.json`，与官方 `fQi` 第二个候选同构）
 * → {@link DEFAULT_BUILTIN_PROVIDER_CONFIG_FILE}。
 *
 * **必须真实存在**（fail-closed）：官方 `Ykt` → `dZe` → `new UO({bundledFilePath: t.zcodeBuiltinFilePath, activeFilePath: undefined})`，
 * 而 `UO.read()` 的 catch 分支逐字是
 * `catch{ t = bnr(await MWt(this.#e), null) }`，`bnr`（偏移 586611）在两份都读不出来时
 * 逐字 `throw new AggregateError([e?.error,t?.error].filter(o=>o!==void 0), "Bundled 与 Active ZCode Built-in Release 均不可用")`。
 * 与其让官方抛一个 AggregateError，不如在 env 构造期就报一条说人话的错。
 *
 * @param env 环境（可注入）
 * @param bundlePath 官方 bundle 路径（可注入；缺省用 {@link DEFAULT_BUNDLE_PATH}）
 * @returns 绝对路径
 * @throws OfficialHostConfigError（code `PROVIDER_CONFIG_NOT_FOUND`）路径不存在时
 */
export function resolveHostBuiltinProviderConfigFile(
  env: Readonly<Record<string, string | undefined>> = process.env as Readonly<Record<string, string | undefined>>,
  bundlePath: string = DEFAULT_BUNDLE_PATH
): string {
  const override = env[HOST_BUILTIN_PROVIDER_CONFIG_OVERRIDE_ENV_KEY]?.trim();
  /** @type {string[]} */
  const candidates = [];
  if (override !== undefined && override !== '') candidates.push(resolvePath(override));
  const bundleDir = dirname(resolvePath(bundlePath));
  candidates.push(resolvePath(bundleDir, '..', 'config', 'provider', OFFICIAL_BUILTIN_PROVIDER_CONFIG_FILE_NAME));
  // **只有在 bundle 就是本机那一份时才回落到硬编码的缺省路径**：运维把 bundle 指到别处
  // （测试替身、另一份安装）时，静默回落到一个**不同安装**的资产比报错更糟。
  if (resolvePath(bundlePath) === resolvePath(DEFAULT_BUNDLE_PATH)) {
    candidates.push(DEFAULT_BUILTIN_PROVIDER_CONFIG_FILE);
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new OfficialHostConfigError(
    'PROVIDER_CONFIG_NOT_FOUND',
    `ZCode Built-in Provider Config 不存在（已试 ${candidates.join(' | ')}）：官方 Ykt 的 UO.read() 会因此抛 AggregateError，拒绝下发`
  );
}

/**
 * 解析子宿主的 Personal Provider Config 路径。
 *
 * **缺省指向 companion 自己的隔离目录**（`<隔离目录>/v2/provider_config.json`），**不是**
 * 用户真实的 `~/.zcode/v2/provider_config.json`。这不是偷懒，是逐字证据决定的：
 *
 *  - 官方 `Ykt` 把这个键交给 `dZe`，`dZe`（偏移 602506 `Cpe` = `NodePersonalProviderConfigRepository`）
 *    构造器只要求 `filePath` 非空（逐字 `if(!t.filePath.trim()) throw new Error("Personal Provider Config filePath 不能为空")`），
 *    **不要求文件存在**。`Cpe.#m()` 逐字：
 *    `let t = await zWt(this.#e); if(t === null && !this.#t) return Tz(uZe());`
 *    ——`zWt` = `readJsonFileIfExists`（ENOENT 返回 `null`），所以**文件不存在时官方返回空快照、
 *    并且不写盘**。复审报告里"缺失时需造一个空的合成件"这句**不成立**：`ymr` 只 `.trim()`，
 *    存在性检查在 `Cpe` 里，而 `Cpe` 对缺失是容忍的。
 *  - 反过来，**指向用户真实文件是有写入风险的**：`Cpe.#m()` 的另一条分支逐字
 *    `return lw(this.#e, () => this.#f())`，而 `#f()` 在解析结果与规范化形式不一致时
 *    调 `#p()`，`#p()` 逐字 `return await qL(this.#e, JSON.stringify(o,null,2)), this.#a += 1, n`
 *    ——**官方会把这个文件按规范化形式重写回去**。那正是本项目"不触碰用户真实 ZCode 存储"的红线。
 *
 * 因此：默认隔离，**不读不改用户真实 personal config**。确需指向真实文件时用
 * `ZCC_HOST_PERSONAL_PROVIDER_CONFIG` 显式覆盖（并自行承担上述规范化写回）。
 *
 * @param env 环境（可注入）
 * @param storageDir companion 隔离目录
 * @returns 绝对路径（**不要求存在**——官方容忍缺失）
 */
export function resolveHostPersonalProviderConfigFile(
  env: Readonly<Record<string, string | undefined>>,
  storageDir: string
): string {
  const override = env[HOST_PERSONAL_PROVIDER_CONFIG_OVERRIDE_ENV_KEY]?.trim();
  if (override !== undefined && override !== '') return resolvePath(override);
  return join(storageDir, 'v2', 'provider_config.json');
}

/* -------------------------------------------------------------------------- */
/* 日志与 model-io rollout 的隔离（BL-4）                                       */
/* -------------------------------------------------------------------------- */

/**
 * {@link HOST_LOG_DIR_ENV_KEY} 的官方逐字依据（偏移 4073622 `rB` = `createLogging`）：
 * `let … , o = e.logDir ?? e.env?.ZCODE_LOG_DIR ?? N6s(), …`
 * 而 `N6s`（偏移 4074264）逐字 `return (0,mat.join)((0,HVr.homedir)(),".zcode","cli","log")`。
 * `NXo`（偏移 14679552）头部逐字 `a = rB({env: e.env}), … u = a.createLogger("zcode")`
 * ——**不传 `logDir`**，所以 `ZCODE_LOG_DIR` 是唯一可用旋钮，且**与 `ZCODE_STORAGE_DIR` 无关**。
 */

/**
 * {@link HOST_RUNTIME_ENV_KEY} 的官方逐字依据——**model-io rollout 不可重定向，只能关**：
 *
 * `JWr`（偏移 4000626）逐字
 * `let s = RWr(e), a = n ?? !1, l = t ?? e4s(n ?? !1); (0,C1.mkdirSync)(l, {recursive:!0}); …`
 * ——`e4s`（偏移 4001820）逐字
 * `function e4s(e){ return (0,cOe.join)((0,WWr.homedir)(),".zcode","cli",e?"debug":"rollout") }`。
 * 它的两个调用点（偏移 3996150 / 3997650）**都只传 1 个实参**，所以 `t`/`n` 恒为 `undefined`
 * → 恒落 `join(homedir(), ".zcode", "cli", "rollout")`。`ZCODE_STORAGE_DIR` / `ZCODE_LOG_DIR`
 * **都不覆盖**它（它不看 `config.storage.dir`，也不看任何 env）。
 *
 * **官方关闭开关（逐字）**：
 * ```
 * 偏移 4000593  function GWr(e){ return XW(e[cz]) }        // cz = "ZCODE_RUNTIME_ENV"（偏移 9063）
 * 偏移 3996176  function Kst(e){ return GWr(e) !== "test" }
 * 偏移 3996260  function Aln(e){ if(!e.recordModelIO) return; … JWr({...}) }
 * 偏移 4022457  s = e.request.metadata?.skipTranscript !== !0 && Kst(e.env)      // ← recordModelIO 的来源
 * 偏移 7297     function XW(e){ let t=e?.trim().toLowerCase();
 *                            if(t==="development"||t==="production"||t==="test") return t }
 * ```
 * `e.request.metadata.skipTranscript` 只由官方内部路径设置（例如偏移 13044438 的
 * memory-agent bash），**协议面 `session/send` 触不到**；因此唯一可用的是 env：
 * **`ZCODE_RUNTIME_ENV=test`**。
 *
 * **改这个键的全局影响（已逐个查过，全文只有 3 处读 `ZCODE_RUNTIME_ENV`）**：
 *  - `Kst` / `Zst`（`isDev`）：`"test"` 与未设（`OCe` 缺省 `"production"`）走的是
 *    **同一条**非 development 分支，差别只有 `recordModelIO` 变 false。
 *  - 日志级别 `F6s`（偏移 4074361）逐字 `if(t==="production"||t==="test") return !1`
 *    ——同样是 Info 级，不产生 Debug 噪声。
 *  - 遥测 `g7a`（偏移 13785265）把 `deploymentEnvironment` 记成 `"test"`（我们自己的子进程，
 *    不影响宿主 ZCode）。
 *  - **官方自己写盘前对 header 做了脱敏**（`RWr`→`EWr`→`MM`），api key 本来就不会落那个文件；
 *    落进去的是**用户提示词与模型产出**。关掉它就关掉了这一项污染。
 */

/** 我们下发给子宿主的官方 runtime env 取值。**唯一**能关掉 model-io rollout 的取值。 */
export const HOST_RUNTIME_ENV_VALUE = 'test';

/** 受控 workspace 根的 env 覆盖键。缺省见 {@link resolveHostWorkspaceRoot}。 */
export const HOST_WORKSPACE_ENV_KEY = 'ZCC_HOST_WORKSPACE';

/** 受控存储根的 env 覆盖键。缺省见 {@link resolveHostStorageRoot}。 */
export const HOST_STORAGE_DIR_ENV_KEY = 'ZCC_HOST_STORAGE_DIR';

/** 缺省 companion 专属存储根（`%TEMP%` 下的一个固定名子目录）。 */
export const DEFAULT_HOST_STORAGE_DIR_NAME = 'zcode-companion-official-host';

/**
 * 官方 ZCode 存储根的**目录名**。逐字来源（`C:\ZCode\resources\glm\zcode.cjs`，只读）：
 *  - 偏移 1301831 默认配置：`storage:{dir:"~/.zcode", sessionDbPath:"~/.zcode/cli/db/db.sqlite"}`。
 *  - 偏移 11869 `RMi` 逐字（beta 通道）：`if(e.ZCODE_STORAGE_DIR?.trim())return; … e.ZCODE_STORAGE_DIR=(0,lz.join)((0,kZn.homedir)(),".zcode-beta")`。
 *
 * **只有这两条路径是红线。** 主目录下的别的东西（`%TEMP%` 在 Windows 上本来就落在
 * `C:\Users\<user>\AppData\Local\Temp`，它**在**主目录之下）不是红线——把"落在主目录
 * 之下"一刀切成不安全会让这条闸门在任何 Windows 机器上恒真，进而让驱动器根本起不来。
 * 红线的实质是：**绝不能落进 ZCode 自己的存储根**（用户真实 `~/.zcode/cli/db/db.sqlite`
 * 正在被并发 ZCode 进程使用，官方启动时会对它跑一次 SQLite 迁移）。
 */
export const ZCODE_STORAGE_DIR_NAMES: readonly string[] = Object.freeze(['.zcode', '.zcode-beta']);

/** 归一化路径：转小写、去尾部分隔符，便于大小写不敏感地比对。 */
function normalizePathForCompare(path: string): string {
  return resolvePath(path).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * 判一个路径**是否是 ZCode 自己的存储根（或其内部）**。
 *
 * 覆盖三种落法：
 *  1. 路径**就是**主目录本身（`storage.dir` 指向主目录 → 官方会去找 `~/cli/db/...`，仍在用户面上）。
 *  2. 路径在 `<home>/.zcode` 或 `<home>/.zcode-beta` 之下（含相等）。
 *  3. 路径的任一段就叫 `.zcode` / `.zcode-beta`（`TEMP` 被重定向到别处时仍能抓住）。
 *
 * @param path 待判路径
 * @returns `true` 表示**不得**作为隔离目录
 */
export function isZCodeStorageRootPath(path: string): boolean {
  const target = normalizePathForCompare(path);
  const home = normalizePathForCompare(homedir());
  if (target === home) return true;
  const segments = target.split(/[\\/]/);
  if (segments.some((seg) => ZCODE_STORAGE_DIR_NAMES.includes(seg))) return true;
  return false;
}

/**
 * 解析 companion 专属存储根。
 *
 * 优先级：`ZCC_HOST_STORAGE_DIR`（显式覆盖，运维可控）→ `%TEMP%/zcode-companion-official-host`。
 * **绝不用 `process.cwd()`，更不用 `~/.zcode`**。
 *
 * @param env 环境（可注入，测试用）
 * @returns 绝对路径
 * @throws OfficialHostConfigError（code `STORAGE_ISOLATION_UNSAFE`）落在 ZCode 存储根时
 */
export function resolveHostStorageRoot(
  env: Readonly<Record<string, string | undefined>> = process.env as Readonly<Record<string, string | undefined>>
): string {
  const override = env[HOST_STORAGE_DIR_ENV_KEY]?.trim();
  const dir = override !== undefined && override !== '' ? resolvePath(override) : join(tmpdir(), DEFAULT_HOST_STORAGE_DIR_NAME);
  if (isZCodeStorageRootPath(dir)) {
    throw new OfficialHostConfigError(
      'STORAGE_ISOLATION_UNSAFE',
      `companion 存储隔离目录落在 ZCode 存储根内（${dir}）：拒绝启动（那正是官方真实 session DB 所在）`
    );
  }
  return dir;
}

/**
 * 解析受控 workspace 根。**不用 `process.cwd()`**——那是运维启动 API 服务时碰巧所在
 * 的目录，会作为 `workspaceKey` 落进用户桌面会话列表，产生一批指向 companion 仓库
 * （甚至 `C:\`）的幽灵会话。
 *
 * @param env 环境（可注入）
 * @param explicit 显式覆盖（驱动器构造选项）
 * @returns 绝对路径
 */
export function resolveHostWorkspaceRoot(
  env: Readonly<Record<string, string | undefined>> = process.env as Readonly<Record<string, string | undefined>>,
  explicit?: string
): string {
  const dir = pickWorkspaceDir(env, explicit);
  // 同一道闸门：workspace 若落进 ZCode 存储根，会让官方在用户真实 session 库里
  // 建出指向 companion 的幽灵会话。
  if (isZCodeStorageRootPath(dir)) {
    throw new OfficialHostConfigError('STORAGE_ISOLATION_UNSAFE', `companion workspace 落在 ZCode 存储根内（${dir}）：拒绝启动`);
  }
  return dir;
}

/**
 * workspace 根的选取本身（不带闸门）。**不用 `process.cwd()`**。
 *
 * @param env 环境
 * @param explicit 显式覆盖
 * @returns 绝对路径
 */
function pickWorkspaceDir(
  env: Readonly<Record<string, string | undefined>>,
  explicit?: string
): string {
  if (explicit !== undefined && explicit.trim() !== '') return resolvePath(explicit.trim());
  const override = env[HOST_WORKSPACE_ENV_KEY]?.trim();
  if (override !== undefined && override !== '') return resolvePath(override);
  return join(tmpdir(), DEFAULT_HOST_STORAGE_DIR_NAME, 'workspace');
}

/**
 * 构造**带存储隔离**的子宿主 env：先按 {@link buildChildEnv} 透传，再**无条件**覆盖
 * 隔离与重定向键。
 *
 * ## 键表（每一行都有官方逐字依据，见各常量的注释）
 *
 * | 键 | 值 | 作用 |
 * | --- | --- | --- |
 * | `ZCODE_STORAGE_DIR` | `<隔离目录>` | `config.storage.dir`：CLI 存储根（settings / **会话 rollout** / plugins / skills） |
 * | `ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB` | `<隔离目录>/cli/db/db.sqlite` | 会话 SQLite |
 * | `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 官方真实 builtin 资产（**只读**） | **BL-1**：`Ykt` 首句的硬前置条件 |
 * | `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` | `<隔离目录>/v2/provider_config.json` | **BL-1**：同上；缺省隔离是因为官方会规范化回写它 |
 * | `ZCODE_LOG_DIR` | `<隔离目录>/cli/log` | **BL-4**：`rB` 的 `e.logDir ?? e.env?.ZCODE_LOG_DIR ?? N6s()` |
 * | `ZCODE_RUNTIME_ENV` | `"test"` | **BL-4**：`Kst` 变 false → `recordModelIO` 关闭 → 不写 `~/.zcode/cli/rollout` |
 *
 * **刻意不设** `ZCODE_DATA_BASE_DIR`：它的消费点会把 `.zcode/v2/credentials.json`
 * （凭据仓）一起搬离真实路径，而我们要读真实仓解 key。
 *
 * @param ownEnv 父进程 env
 * @param storageDir 隔离目录；缺省 {@link resolveHostStorageRoot}
 * @param bundlePath 官方 bundle 路径；缺省 {@link DEFAULT_BUNDLE_PATH}（只用于推导 builtin config 落点）
 * @throws OfficialHostConfigError `STORAGE_ISOLATION_UNSAFE`（隔离目录落进 ZCode 存储根）
 *   或 `PROVIDER_CONFIG_NOT_FOUND`（builtin config 找不到）
 */
export function buildIsolatedChildEnv(
  ownEnv: Readonly<Record<string, string | undefined>>,
  storageDir?: string,
  bundlePath?: string
): Record<string, string> {
  const dir = storageDir ?? resolveHostStorageRoot(ownEnv);
  if (isZCodeStorageRootPath(dir)) {
    throw new OfficialHostConfigError('STORAGE_ISOLATION_UNSAFE', `companion 存储隔离目录落在 ZCode 存储根内（${dir}）：拒绝下发`);
  }
  const out = buildChildEnv(ownEnv);
  out['ZCODE_STORAGE_DIR'] = dir;
  out['ZCODE_SESSION_DB_PATH'] = join(dir, 'cli', 'db', 'db.sqlite');
  out['ZCODE_SESSION_DB'] = out['ZCODE_SESSION_DB_PATH'];
  // BL-1：这两个键缺一，官方 `Ykt` 第一句就抛 `缺少进程 Provider Registry 的 ZCode Built-in / Personal Config 路径`。
  out[HOST_BUILTIN_PROVIDER_CONFIG_ENV_KEY] = resolveHostBuiltinProviderConfigFile(ownEnv, bundlePath);
  out[HOST_PERSONAL_PROVIDER_CONFIG_ENV_KEY] = resolveHostPersonalProviderConfigFile(ownEnv, dir);
  // BL-4：日志目录 + model-io rollout 关闭开关。
  out[HOST_LOG_DIR_ENV_KEY] = join(dir, 'cli', 'log');
  out[HOST_RUNTIME_ENV_KEY] = HOST_RUNTIME_ENV_VALUE;
  // HOSTFIX6：诊断开关**显式**透传。取值闭集 `0 | 1` 由入口（`start-api.mjs` 的
  // `parseHostDebug`）在**启动期**校验过；这一层只保证两件事：
  //  1. 它**不是** {@link HOST_CHILD_STRIPPED_ENV_KEYS} 的一员——被剥掉的话
  //     `ZCC_HOST_DEBUG=1` 会静默变成"没开"，而运维以为开了；
  //  2. 只在**父进程真的给了 `'1'`** 时才写。缺省**不新增**这个键，
  //     所以默认配置下子宿主 env 与 HOSTFIX5 逐字一致（`buildChildEnv` 的
  //     "其余全量透传"本来也会带上它——这里写出来是为了让它成为一条**可断言的事实**，
  //     而不是一条"碰巧成立"的行为）。
  if (ownEnv[HOST_DEBUG_ENV_KEY] === '1') out[HOST_DEBUG_ENV_KEY] = '1';
  return out;
}

/** 子宿主单行上限。自选保守界（**不是**对官方入站上限的引用）。 */
export const HOST_CHILD_MAX_LINE_BYTES = 2 * 1024 * 1024;

/**
 * official-host 诊断行的 env 键（HOSTFIX4 立此开关，HOSTFIX6 才把它接通到入口）。
 *
 * **单一出处**：`packages/api/bin/start-api.mjs` 的入口闭集校验它、
 * {@link buildIsolatedChildEnv} 透传它、`scripts/official-host/session-drive.mjs`
 * 从这里 import 并**重导出**（`host-child.mjs` 用的是那一个重导出）。
 * 四处各写一份字面量就是"两处漂移"那种缺陷，所以这里只有一份。
 *
 * 取值闭集 `0 | 1`，缺省 `0`；**只有精确的 `'1'` 才打开**（见 `session-drive.mjs` 的注释）。
 */
export const HOST_DEBUG_ENV_KEY = 'ZCC_HOST_DEBUG';

/**
 * 收束子进程时的**自然退出宽限窗**（ms）。关掉 stdin 之后给子进程这段时间自己收尾——
 * 官方在 `input` 收到 `end` 后会正常走完它自己的 shutdown 链。
 */
export const HOST_CHILD_EXIT_GRACE_MS = 400;

/** SIGKILL 之后再等这么久才认定"它真的没救了"（ms）。这段时间里不再对调用方阻塞。 */
export const HOST_CHILD_KILL_GRACE_MS = 400;

/* -------------------------------------------------------------------------- */
/* 第二层子进程生命周期：host-child → 官方 app-server（HOSTFIX5）                 */
/* -------------------------------------------------------------------------- */

/**
 * **第二层**自然退出宽限窗（ms）：`host-child.mjs` 关掉官方 app-server 的 stdin 之后，
 * 等它自己走完 shutdown 链的时间。
 *
 * **这是一个实测值，不是猜的**：I02 E-PROBE-R3-P4（协调者实跑的捕获）与 HOSTFIX5 的
 * `%TEMP%` 零发送冒烟都观察到"关 stdin → `exit 0`、stderr 0 字节"。所以它足够宽松，
 * 同时**不会**让一次正常会话多干等一秒。超时之后 `reapAppServer` 走 SIGKILL 兜底
 * （**只对��己 spawn 的句柄**动手）。
 *
 * 放在这一层（而不是在 `scripts/` 的两个文件里各写一份）是为了**单一出处**：
 * `host-child.mjs` 与 `session-drive.mjs` 都从这里取，测试逐字断言三者同值。
 */
export const OFFICIAL_APP_SERVER_EXIT_GRACE_MS = 5_000;

/**
 * `op:'describe'` 等官方 app-server **自发第一帧**的上限（ms）。
 *
 * 实测：`app-server` 起进程后**几十到几百毫秒**内就吐出第一条 `startup/storageState`
 * 通知（那是**零写入**的官方自发行为，E-BUNDLE-023 / E-PROBE-R3-P4）。给 5 s 是为了在
 * 慢机器上不误报；超时按 `BUNDLE_SPAWN_FAILED` 失败化，**不**降级成"大概起来了"。
 */
export const OFFICIAL_APP_SERVER_FIRST_FRAME_TIMEOUT_MS = 5_000;

export interface HostSessionOptions {
  readonly spawnChild?: SpawnHostChild;
  readonly bundlePath?: string;
  readonly timeoutMs?: number;
}

function parseChildLine<T>(line: string): T | null {
  if (line.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(HOST_REQUEST_KEYS as readonly string[]).includes(key)) return null;
  }
  return record['zccHost'] as T;
}

function frame(value: HostChannelRequest): string {
  return `${JSON.stringify({ zccHost: value })}\n`;
}

/**
 * 跑一次子宿主会话，把它的 NDJSON 事件流交给 `onEvent`。
 *
 * **崩溃隔离的落点就在这里**：子进程的 `error` / 提前 `exit` / stderr 噪声 / 协议违规
 * 全部被转成一次**调用方可见的失败**，本进程不抛未捕获异常、不 `exit`、不解引用已
 * 关闭的流。stderr 只在**诊断计数**里出现，**内容从不**被读取或转发（官方 bundle 的
 * stderr 可能带凭据片段）。
 *
 * @param request 请求帧
 * @param onEvent 事件回调
 * @param options spawn 注入 / bundle 路径 / 超时
 * @returns `ready` 帧里的 bundle 路径与导出面
 */
export async function runHostSession(
  request: HostChannelRequest,
  onEvent: (event: HostChannelEvent) => void,
  options: HostSessionOptions = {}
): Promise<{ readonly bundle: string; readonly exports: readonly string[] }> {
  const bundlePath = options.bundlePath ?? DEFAULT_BUNDLE_PATH;
  if (!existsSync(bundlePath)) {
    throw new OfficialHostConfigError('BUNDLE_NOT_FOUND', `官方 bundle 不存在：${bundlePath}（只读引用；本驱动不会安装或下载它）`);
  }
  const spawnChild = options.spawnChild ?? defaultSpawnHostChild;
  // 显式 options 优先；未给时读 env 旋钮（长任务运维拉长），再缺省 300000（历史原值）。
  const timeoutMs = options.timeoutMs ?? resolveHostTurnTimeoutMs();

  const child = spawnChild([resolveHostChildScript(), '--bundle', bundlePath]);
  // stderr 只 drain、只计数。**从不**把内容读进变量：官方 bundle 的 stderr 未经净化。
  let stderrBytes = 0;
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
  });
  child.stderr?.on('error', () => undefined);

  return new Promise<{ readonly bundle: string; readonly exports: readonly string[] }>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let ready: { readonly bundle: string; readonly exports: readonly string[] } | null = null;
    /** @type {NodeJS.Timeout | null} */
    let killTimer: NodeJS.Timeout | null = null;
    /** 子进程是否已被我们观察到退出（自然退出或被 kill）。 */
    let childExited = false;

    /**
     * 回收子进程（B4）。**三条路径共用**：超时、协议失败、正常完成。
     *
     * 顺序学 tap 的先例（`scripts/official-tap/zcode-stdio-tap.mjs` `beginShutdown`）：
     * 1. **自然退出优先**——关 stdin 后给它一个宽限窗；它自己退了就不动手。
     * 2. **kill 兜底**——宽限窗内没退，用**我们自己 spawn 的句柄** `child.kill('SIGKILL')`。
     *    只对持有 handle 的进程动手，绝不按名字/端口猜，也绝不碰任何既有进程。
     * 3. **句柄清理**——kill 之后再留一个短窗给 `exit` 事件，然后强制落定，
     *    不让请求的返回时间被一个不响应的子进程拖住。
     *
     * SIGKILL 而非 SIGTERM：Windows 上信号到不了目标的 JS 处理器
     * （与 `tests/contract/api-start-entry.test.mjs` 同一限制）。
     */
    const reap = (): void => {
      if (childExited) return;
      childExited = true;
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      try {
        child.stdin?.end();
      } catch {
        /* 子进程可能已退出：stdin 已关。忽略。 */
      }
      if (child.exitCode !== null || child.signalCode !== null) return; // 自然退出，句柄已释放
      // 自然退出宽限窗。子进程自己退了就再也不会触发这个 timer。
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出。忽略。 */
        }
        if (killTimer !== null) clearTimeout(killTimer);
        killTimer = setTimeout(() => {
          killTimer = null;
        }, HOST_CHILD_KILL_GRACE_MS);
        killTimer.unref?.();
      }, HOST_CHILD_EXIT_GRACE_MS);
      killTimer.unref?.();
    };

    const finish = (err: Error | null, value?: { readonly bundle: string; readonly exports: readonly string[] }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reap();
      if (err !== null) reject(err);
      else resolve(value ?? { bundle: bundlePath, exports: [] });
    };

    const timer = setTimeout(() => {
      finish(new OfficialHostConfigError('CHILD_TIMEOUT', `子宿主在 ${timeoutMs}ms 内没有结束（stderr ${stderrBytes} 字节未读取内容）`));
    }, timeoutMs);
    timer.unref();

    child.on('error', (e: Error) => finish(new OfficialHostConfigError('CHILD_SPAWN_FAILED', `子宿主无法启动：${e.message}`)));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // 观察到真实退出：清掉 reap 的 kill 宽限窗（若有），别对已退出的进程再动手。
      childExited = true;
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      // **只要还没 settled，退出就是失败。** 正常路径上子宿主先吐 `finish`，那一步已经把
      // promise settle 掉了（`finish` 里的 `if (settled) return` 让随后的 exit 空转）。
      //
      // 这条判据不能写成"ready 之后就不管"：官方 bundle 在会话中途 `process.exit()` 是
      // 完全可能的（CLI bootstrap 里的 fatal 分支），那种情况下若不失败化，请求会一路
      // 挂到墙钟上限才报 CHILD_TIMEOUT——把一次崩溃伪装成一次慢响应。
      finish(new OfficialHostConfigError('CHILD_EXITED', `子宿主退出（code=${String(code)} signal=${String(signal)}，stderr ${stderrBytes} 字节未读取内容）`));
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('error', () => finish(new OfficialHostConfigError('CHILD_PROTOCOL_VIOLATION', '子宿主 stdout 流不可读')));
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const at = buffer.indexOf('\n');
        if (at < 0) {
          if (buffer.length > HOST_CHILD_MAX_LINE_BYTES) {
            finish(new OfficialHostConfigError('CHILD_PROTOCOL_VIOLATION', '子宿主单行超过本通道自设上限'));
          }
          break;
        }
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const event = parseChildLine<HostChannelEvent>(line);
        if (event === null || typeof event !== 'object' || typeof (event as { type?: unknown }).type !== 'string') {
          finish(new OfficialHostConfigError('CHILD_PROTOCOL_VIOLATION', '子宿主产出不是合法通道帧'));
          return;
        }
        const typed = event as HostChannelEvent & { type: string };
        if (typed.type === 'ready') {
          ready = { bundle: typed.bundle, exports: typed.exports };
          onEvent(typed);
          continue;
        }
        if (typed.type === 'failed') {
          // B5：子宿主 detail **先净化再进错误消息**。子宿主只做"截断"，不脱敏；
          // 脱敏在这一层做，因为它离原始文本最近、也最容易保证不被旁路。
          finish(new OfficialHostConfigError('CHILD_EXITED', `子宿主报告失败 [${String(typed.code).slice(0, 64)}]：${sanitizeChildDetail(typed.detail)}`));
          return;
        }
        if (typed.type === 'finish') {
          onEvent(typed);
          finish(null, ready ?? { bundle: bundlePath, exports: [] });
          return;
        }
        onEvent(typed);
      }
    });

    try {
      child.stdin?.write(frame(request));
    } catch (e) {
      finish(new OfficialHostConfigError('CHILD_SPAWN_FAILED', `写子宿主 stdin 失败：${e instanceof Error ? e.message : 'unknown'}`));
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 驱动器                                                                      */
/* -------------------------------------------------------------------------- */

/** 子进程回报的宿主描述。`describe()` 的结果；不含凭据。 */
export interface HostDescriptor {
  readonly bundlePath: string;
  readonly exports: readonly string[];
  readonly detail: string;
  readonly models: readonly DriverModel[];
  readonly status: DriverStatus;
}

/** 驱动可服务模型的闭集来源：PLANSRC 的 18 条真实目录（不重复造）。 */
export interface ServableModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly offeringId: string;
  readonly planMode: SupportedPlanMode;
  readonly billingClass: string;
}

/** `account:*` offeringId → 该目录条目对应的 `mode`。team 没有缓存键，不进可服务集。 */
const PLAN_MODE_BY_OFFERING_SUFFIX: ReadonlyArray<readonly [string, SupportedPlanMode]> = Object.freeze([
  ['-start-plan', 'start-plan'],
  ['-individual-coding-plan', 'individual-coding-plan']
] as const);

/**
 * 从既有 PLANSRC 目录（`providerId::modelId`）里挑出**本驱动能服务**的条目。
 *
 * 只收 `account:*` 前缀（与出站白名单同一条判据，口径单一）+ 两个有缓存键的 planMode。
 * 团队套餐与 off-peak **不进**可服务集：前者本版显式不支持，后者官方没给缓存键。
 */
export function selectServableModels(catalog: DriverCatalog): ServableModel[] {
  const out: ServableModel[] = [];
  for (const entry of catalog.models) {
    const decision = evaluateChannelPolicy(entry.provider);
    if (!decision.ok) continue;
    const planMode = PLAN_MODE_BY_OFFERING_SUFFIX.find(([suffix]) => entry.provider.endsWith(suffix))?.[1];
    if (planMode === undefined) continue;
    const split = splitOfferingId(entry.modelId);
    out.push({
      providerId: entry.provider,
      modelId: split.modelId,
      offeringId: entry.modelId,
      planMode,
      billingClass: entry.billingClass
    });
  }
  return out;
}

export interface CreateOfficialHostDriverOptions {
  readonly descriptor: HostDescriptor;
  readonly catalog: DriverCatalog;
  readonly servableModels: readonly ServableModel[];
  /** 默认推理档位。闭集外 → 构造期就抛（fail-closed）。 */
  readonly reasoning: string;
  readonly spawnChild?: SpawnHostChild;
  readonly bundlePath?: string;
  readonly timeoutMs?: number;
  /** 注入的 entitlement 推导（测试用合成夹具；生产走真实缓存）。 */
  readonly deriveEntitled?: (providerId: string, planMode: SupportedPlanMode) => { readonly entitled: boolean; readonly evidence: EntitlementEvidence };
  /**
   * 受控 workspace 根（B2）。**缺省不是 `process.cwd()`**——那会把运维启动目录
   * 当成 workspace 落进用户桌面会话列表。缺省走 {@link resolveHostWorkspaceRoot}。
   */
  readonly workspacePath?: string;
  /** 额外的可记录诊断（不含凭据）。 */
  readonly diagnostics?: (line: string) => void;
}

/**
 * 构造 official-host 驱动器。
 *
 * **status 是构造期就定死的**，不是每次请求现算：`describe()` 已经在探测时确认了
 * bundle 可加载 + 有可服务模型。启动后再崩，子进程隔离兜住"那次请求"，不改变驱动器
 * 自身的如实状态描述。
 *
 * @param options 描述 + 目录 + 可服务模型 + 推理档位 + 注入点
 * @returns `ChatDriver`：`fixture:false`；`catalog` 复用 PLANSRC 那份
 */
export function createOfficialHostDriver(options: CreateOfficialHostDriverOptions): ChatDriver {
  // fail-closed 在构造期：档位不合法时驱动器根本不存在，而不是"发出去再报"。
  const defaultThoughtLevel = mapReasoningToThoughtLevel(options.reasoning);
  const spawnChild = options.spawnChild;
  const bundlePath = options.bundlePath ?? options.descriptor.bundlePath;
  const diagnose = options.diagnostics;
  const derivedThoughtLevel = defaultThoughtLevel;
  // COMPAT1/C4：两条 env 旋钮**只解析一次**（构造期），闭集外的值让驱动器根本不存在。
  // 披露面与实际下发面读的是**同一个**结果，所以"响���里说的"与"发出去的"不可能分叉。
  const env = process.env as Readonly<Record<string, string | undefined>>;
  const permissionMode = resolveHostPermissionMode(env);
  const toolPolicy = resolveHostToolPolicy(env);

  const byOffering = new Map<string, ServableModel>();
  for (const model of options.servableModels) byOffering.set(model.offeringId, model);

  return {
    name: OFFICIAL_HOST_DRIVER_NAME,
    status: options.descriptor.status,
    statusDetail: options.descriptor.detail,
    models: options.descriptor.models,
    // 真实上游：产出由官方模型经子宿主返回，不是本地生成的假内容。
    fixture: false,
    // **COMPAT2 实弹更正**：official-host **不能**强制执行 `maxTokens`。
    // 官方 `session/create` 的 params schema（`zcode.cjs` 偏移 757102 的 `nGt`）
    // 是 `.strict()` 且**逐字没有**上限槽位（嵌套 `model` 的 `Pu` 偏移 508944 同样
    // `.strict()`、同样没有），官方在偏移 14479993 逐字 `yl(nGt,t)` 校验
    // （`yl` 偏移 14131416 = `e.parse(t)`，失败即 `-32602 Invalid params`）。
    // 此前把 `maxTokens` 塞进那份 params，等于让**每个带上限的请求**都被官方拒掉，
    // 而 `zcc.max_tokens_enforced` 还报 `true` —— 一条假披露。
    // 现在上限在 API 层按"接受 + 校验 + 如实披露未转发"处理（见 `maxTokensNotForwarded`）。
    enforcesMaxTokens: false,
    // 目录复用 PLANSRC 的 18 条真实条目，端点与契约形状都不动。
    catalog: options.catalog,
    // **COMPAT1/C4 的披露面**：官方 agent 的工具权限档位与我们自己的工具应答策略。
    // 两条都**只**在这里读一次 env（子宿主侧读的是同一份 env，见
    // `session-drive.mjs` 的 `resolveHostPermissionMode` / `resolveHostToolPolicy`），
    // 闭集外的值在这里就抛，**不**带着一个猜出来的权限语义去跑官方 agent 的工具。
    //
    // 之所以**必须在响应里说出来**：我们替客户端做了两个决定（不下发会挨问的工具、
    // 被问到时按什么策略答）。不披露的话，客户端只能从"结果里看起来正常"去猜。
    // 值是**闭集短码**，不含路径、不含 prompt、零凭据。
    host: Object.freeze({
      permission_mode: permissionMode,
      tool_policy: toolPolicy
    }),
    async *stream(request: DriverRequest): AsyncGenerator<DriverEvent> {
      if (request.signal.aborted) {
        throw new ApiError('upstream_outcome_unknown', '客户端在宿主产出前取消', { driver: OFFICIAL_HOST_DRIVER_NAME });
      }
      const model = byOffering.get(request.model);
      if (model === undefined) {
        throw new ApiError('model_not_found', `official-host 不服务模型 ${JSON.stringify(request.model)}`, { driver: OFFICIAL_HOST_DRIVER_NAME });
      }
      // 请求级 reasoning 优先于驱动器缺省（工单 COMPAT1/C2）。
      // `DriverRequest.reasoning` 现在是**正式字段**（不再是"可选字段转型"），
      // `undefined` 逐字表示"客户端没发"，两条路径过**同一张** fail-closed 闭集表。
      const rawReasoning = request.reasoning;
      const thoughtLevel = rawReasoning === undefined ? derivedThoughtLevel : mapReasoningToThoughtLevel(rawReasoning);

      const entitlement = (options.deriveEntitled ?? defaultEntitlementDeriver(options))(model.providerId, model.planMode);
      if (diagnose !== undefined) {
        diagnose(
          `official-host entitled ${entitlement.evidence.providerId} entitled=${String(entitlement.entitled)} reason=${entitlement.evidence.reason} cache_status=${entitlement.evidence.cacheStatus ?? 'none'} observed_at=${String(entitlement.evidence.availabilityObservedAt ?? 'unknown')}`
        );
      }
      if (!entitlement.entitled) {
        // 红线落点：缓存说没有资格就诚实失败，绝不硬推 entitled:true 去"试一发"。
        throw new ApiError('upstream_unavailable', `官方本地缓存未显示该套餐可用（reason=${entitlement.evidence.reason}）；不伪造 entitled`, {
          driver: OFFICIAL_HOST_DRIVER_NAME,
          entitlement_reason: entitlement.evidence.reason,
          observed_at: entitlement.evidence.availabilityObservedAt ?? null
        });
      }

      // 折叠走 **api 包共享的那一个实现**（COMPAT3）：与 fixture 驱动器逐字同一个函数，
      // 所以两个驱动器不可能各自折叠出不同的格式。
      //
      // `system` / `developer` 指令轮因此与对话轮**同格式**进入 prompt（行首带 role
      // 标签、**原顺序**保留）。这条 prompt 逐字进官方 `session/send` 的 `content`
      // （`scripts/official-host/session-drive.mjs` 的 `content: request.prompt`），
      // 也就是**一条用户轮文本**——官方协议面没有系统提示词槽位（`session/create` 的
      // `nGt` 是 `.strict()` 且逐字没有，见上面 `enforcesMaxTokens` 的注释），所以
      // "折叠成 prompt 上下文 + 在 `zcc.roles_folded` 里披露"是本端点能做到的**全部**，
      // 也是我们选择说清楚而不是静默改名成 `user` 的原因。
      // **披露的边界**：折叠后的指令与官方 agent 自己的系统提示**同不同优先级，取决于官方**，
      // 本端点既不宣称也不改变它。
      const prompt = foldMessagesToPrompt(request.messages);
      const queue: DriverEvent[] = [];
      let failure: Error | null = null;
      let pumpDone = false;

      const run = runHostSession(
        {
          op: 'run',
          // B2：受控 workspace 根。**不再用 `process.cwd()`**。
          workspacePath: resolveHostWorkspaceRoot(process.env as Readonly<Record<string, string | undefined>>, options.workspacePath),
          providerId: model.providerId,
          modelId: model.modelId,
          planMode: model.planMode,
          entitled: entitlement.entitled,
          thoughtLevel,
          prompt,
          maxTokens: request.maxTokens,
          operationId: request.operationId
        },
        (event) => {
          switch (event.type) {
            case 'delta':
              queue.push({ type: 'delta', text: event.text });
              break;
            case 'reasoning':
              // 官方深思考期持续产 `reasoning_delta`（`model.streaming` 的 kind 闭集成员，
              // 官方过滤 `C3e` 与 `text_delta` 同款要求 `!!delta`）。转发成 API 层的
              // reasoning 事件 → SSE `delta.reasoning_content`（DeepSeek 风格）：真客户端
              // mmx 在思考期收不到任何字节会判"任务进程停滞"并断开重试（2026-10-10
              // 实录 frames=1 → 70-90s client_gone）；思考流外发让流在思考期保持活着。
              queue.push({ type: 'reasoning', text: event.text });
              break;
            case 'usage':
              // usage 如实透传：官方 `turn.completed.payload.usage` 的
              // `inputTokens` / `outputTokens` **都**在才产 usage 事件。**缺失就不产**——
              // server.ts 见到"没有 usage 事件"会如实报 `usage: null` + `zcc_usage_method:
              // 'unavailable'`，那正是本驱动要的行为；编两个数字会污染那条 null 路径。
              if (event.promptTokens !== null && event.completionTokens !== null) {
                queue.push({
                  type: 'usage',
                  promptTokens: event.promptTokens,
                  completionTokens: event.completionTokens,
                  usageMethod: event.usageMethod
                });
              }
              break;
            case 'finish':
              queue.push({ type: 'finish', reason: event.reason });
              break;
            case 'failed':
              // B5：同样先净化。驱动器这一条 detail 会一路进 `ApiError` 的 message。
              failure = new Error(`官方宿主报告失败 [${String(event.code).slice(0, 64)}]：${sanitizeChildDetail(event.detail)}`);
              break;
            case 'ready':
              break;
            default:
              failure = new Error('官方宿主产出了未知事件类型');
          }
        },
        {
          ...(spawnChild === undefined ? {} : { spawnChild }),
          bundlePath,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
        }
      );
      // 崩溃隔离的**唯一**出口：runHostSession 的任何失败（子进程 exit / 崩溃 / 协议违规 /
      // 超时）都在这里被转成"该次请求失败"，绝不会以未捕获异常的形式逃出本生成器，
      // 更不会带走 API 服务进程。
      run.then(
        () => {
          pumpDone = true;
        },
        (e: unknown) => {
          failure = e instanceof Error ? e : new Error(String(e));
          pumpDone = true;
        }
      );

      while (!pumpDone || queue.length > 0) {
        if (failure !== null) {
          throw new ApiError('upstream_outcome_unknown', `官方宿主会话失败：${(failure as Error).message}`, { driver: OFFICIAL_HOST_DRIVER_NAME });
        }
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        // 队列空但子进程还在跑：让出事件循环。用 unref 的短 sleep，不留悬挂句柄。
        await new Promise((r) => {
          setTimeout(r, 4).unref?.();
        });
      }
      if (failure !== null) {
        throw new ApiError('upstream_outcome_unknown', `官方宿主会话失败：${(failure as Error).message}`, { driver: OFFICIAL_HOST_DRIVER_NAME });
      }
      // 没有 usage 事件就是"上游没报"。**不在这里补一条**——server.ts 会报 `usage: null`。
    }
  };
}

function defaultEntitlementDeriver(options: CreateOfficialHostDriverOptions) {
  return (providerId: string, planMode: SupportedPlanMode) => {
    const readOptions: ReadPlanSourcesOptions = { allowMissing: ['builtinFile', 'settingFile', 'cacheFile'] };
    const sources = readPlanSources(readOptions);
    const snapshot = deriveEntitledSnapshotFromDocument({ providerId, planMode, cacheSource: sources.cache });
    return { entitled: snapshot.evidence.available, evidence: snapshot.evidence };
  };
}

/* -------------------------------------------------------------------------- */
/* 组装                                                                        */
/* -------------------------------------------------------------------------- */

export interface LoadOfficialHostOptions extends Partial<HostSessionOptions> {
  readonly reasoning: string;
  readonly planSourceOptions?: ReadPlanSourcesOptions;
  /** 受控 workspace 根（B2）。缺省走 {@link resolveHostWorkspaceRoot}，不用 `process.cwd()`。 */
  readonly workspacePath?: string;
  readonly diagnostics?: (line: string) => void;
  /**
   * ZCC-GUI-EVIDENCE-20261008-A：**在这一次已经完成的读源之上**把证据交出去。
   *
   * 它复用本函数第 1471 行已经 `readPlanSources` 读到的同一份 sources，
   * **不产生任何二次 I/O、不新增官方配置/凭据/数据库读取**。
   * 缺省不传 → 完全不构造证据，行为与此前一字不差。
   */
  readonly onSourceEvidence?: (evidence: {
    readonly sources: PlanSources;
    readonly catalog: DriverCatalog;
    readonly servableCount: number;
  }) => void;
}

/**
 * 一步装配：读 PLANSRC 目录（只读、零发送）→ 探测子宿主 → 构造驱动器。
 *
 * `describe` 只让子宿主 spawn 起一个官方 app-server、等它**自发**吐出第一帧协议通告，
 * 然后**一个字节都不写**地收掉它；`ready` 帧里的 `exports` 恒为 `[]`
 * （HOSTFIX5 起我们不再从官方 bundle 取任何导出）。**不建会话、不发请求。**
 */
export async function loadOfficialHostDriver(options: LoadOfficialHostOptions): Promise<ChatDriver> {
  const sources = readPlanSources(options.planSourceOptions ?? { allowMissing: ['builtinFile', 'settingFile', 'cacheFile'] });
  const catalog = mapBuiltinToCatalog(sources.builtin);
  const servableModels = selectServableModels(catalog);
  const bundlePath = options.bundlePath ?? DEFAULT_BUNDLE_PATH;
  const models: DriverModel[] = servableModels.map((m) => ({
    id: m.offeringId,
    object: 'model' as const,
    created: sources.builtin.readAt,
    owned_by: `${m.providerId} (official-host)`
  }));
  const detail =
    `官方 bundle 作宿主（子进程隔离，${bundlePath}）：目录 ${catalog.models.length} 条 / revision ${catalog.revision}，本驱动可服务 ${servableModels.length} 条；` +
    `凭据在子进程内解析，明文不经过父子通道；付费通道白名单 account: 生效；` +
    `会话存储与 workspace 隔离在 ${resolveHostStorageRoot()}，不触碰用户真实 session DB`;

  // ZCC-GUI-EVIDENCE-20261008-A：把**这一次已读**的 sources 交出去，不重读。
  if (typeof options.onSourceEvidence === 'function') {
    options.onSourceEvidence({ sources, catalog, servableCount: servableModels.length });
  }

  return createOfficialHostDriver({
    descriptor: { bundlePath, exports: [], detail, models, status: models.length > 0 ? 'ready' : 'not_attached' },
    catalog,
    servableModels,
    reasoning: options.reasoning,
    ...(options.spawnChild === undefined ? {} : { spawnChild: options.spawnChild }),
    bundlePath,
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics })
  });
}

// 仅为让 evaluateChannelPolicy 的 import 在本文件里可见（重导出供测试与子宿主使用）。
export { evaluateChannelPolicy } from './headers-port.js';
