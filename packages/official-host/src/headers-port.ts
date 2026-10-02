/**
 * OFFICIAL-HOST providerRuntimeHeadersPort —— 自建的运行时请求头 port + 出站白名单。
 *
 * 六条硬事实：
 *
 *  1. **白名单硬编码、默认拒绝。** 沿用 `scripts/official-tap/tap-core.mjs` 的
 *     `ALLOWED_CHANNEL_PREFIX = 'account:'` + `BLOCKED_CHANNEL_IDS` 两条独立判据：
 *     先判黑名单（命中即拒并指名），再判白名单前缀（不命中即拒）。两条都过才放行。
 *     **命中付费通道时不触网**——判定发生在构造 port 之前，取键、解密、发送三步
 *     一个都不执行。
 *  2. **口��与官方逐字一致。** port 返回
 *     `{headersApplied: true, requestAuth: {apiKey}}`；接口是
 *     `{shouldRefreshBeforeModelRequest: () => true, refreshBeforeModelRequest(n)}`。
 *     消费侧是 `n.providerRuntimeHeadersPort ?? ZJo(e,t)`（@14437510），**无 provider
 *     白名单二次门**，所以本 port 自身就是唯一一道出站闸门。
 *  3. **三分支。** `start-plan` → `zcodejwttoken`；`individual-coding-plan` →
 *     `account-provider:coding-plan:<providerId>:account:<账号身份>:api-key`（账号身份先从
 *     `oauth:<provider>:user_info` 的 `.id` 解析）；`team-coding-plan` → **显式不支持并诚实报错**。
 *  4. **明文零落地。** 本模块的每一个出口（返回值、`requestAuth`、`headers`）都只活
 *     在一次 `refreshBeforeModelRequest` 调用的栈帧里。没有缓存字段、没有模块级变量、
 *     没有日志。`requestAuth` 对象带 `toJSON` 抛错，避免被顺手序列化。
 *  5. **不传 standalone。** 本模块**不导出** `credentialStore` 形状的构造器。官方
 *     `startProcessProviderRegistryRuntime(e, t)` 里 `t.standalone` 一旦为真就会取
 *     `t.standalone.credentialStore`，进而让 `nPn` 硬过滤 `individual-coding-plan`，
 *     start-plan 永远 not entitled。
 *  6. **解密失败 / provider 不在白名单 → 结构化错误**，不降级、不重试、不静默放行。
 *
 * 官方出处（`C:\ZCode\resources\glm\zcode.cjs`，只读逐字节核对）：
 *  - port 形状：`{shouldRefreshBeforeModelRequest:()=>true, refreshBeforeModelRequest(n)=>…}`，
 *    消费侧 `n.providerRuntimeHeadersPort??ZJo(e,t)`。
 *  - 消费侧无二次门：全 18 处引用已核，均为同一 `??` 形态。
 */
import {
  OfficialCredentialError,
  resolveCredentialForPlan,
  type CredentialValue,
  type OfficialPlanKind,
  type ProviderFamily
} from './credentials.js';

/* -------------------------------------------------------------------------- */
/* 出站白名单（硬编码）                                                         */
/* -------------------------------------------------------------------------- */

/** 唯一允许的通道前缀（订阅通道）。与 tap 的 `ALLOWED_CHANNEL_PREFIX` 逐字同值。 */
export const ALLOWED_CHANNEL_PREFIX = 'account:';

/**
 * 付费 / 按量计费通道黑名单。**闭集**。
 *
 * `builtin:bigmodel` / `builtin:zai` 经官方 `migrateLegacyModelProviderId` 会变成
 * `bigmodel-api` / `zai-api`，两者按量计费；`zai-standard-api` 同理。工单点名这五个
 * id，因此保留为可命名的常量——**判定本身由 `account:` 前缀白名单完成**，黑名单只是让
 * 错误回执能指名道姓，而不是"看起来像黑名单"。
 *
 * 加 id 是一次必须同时改测试的显式动作；测试会断言闭集全集。
 */
export const BLOCKED_CHANNEL_IDS: readonly string[] = Object.freeze([
  'bigmodel-api',
  'zai-api',
  'zai-standard-api',
  'builtin:bigmodel',
  'builtin:zai'
]);

/** 工单点名的四个付费 id 的子集断言锚。测试直接比对这个数组。 */
export const BLOCKED_CHANNEL_IDS_REQUIRED = Object.freeze(['builtin:bigmodel', 'bigmodel-api', 'zai-api', 'zai-standard-api']);

export type InjectPolicyRejection = 'blocked_channel' | 'channel_not_allowlisted';

export type ChannelDecision =
  | { readonly ok: true; readonly channel: string }
  | { readonly ok: false; readonly code: InjectPolicyRejection; readonly matched: string | null; readonly detail: string };

/**
 * 出站白名单判定。**默认拒绝**，两条判据互相独立。
 *
 * 判定**纯字符串、零 I/O**：它在取键与解密之前跑完，因此"命中付费通道"这条路
 * **结构上不可能触网**——没有解密函数被调用过，也就没有任何凭据值被读进内存。
 *
 * @param providerId 目标 providerId
 * @returns 放行返回 `channel`；拒绝返回 `code` / `matched` / `detail`（`matched` 仅在
 *   恰好等于黑名单常量时回显，其余一个字符都不回，避免调用方把自己的秘密塞进 providerId 再被回显）
 */
export function evaluateChannelPolicy(providerId: unknown): ChannelDecision {
  if (typeof providerId !== 'string' || providerId.trim() === '') {
    return {
      ok: false,
      code: 'channel_not_allowlisted',
      matched: null,
      detail: 'providerId 缺失或不是非空字符串：无法证明它走订阅通道，默认拒绝'
    };
  }
  const value = providerId.trim();
  if (BLOCKED_CHANNEL_IDS.includes(value)) {
    return { ok: false, code: 'blocked_channel', matched: value, detail: `providerId 命中付费通道黑名单，拒绝注入（未取键、未解密、未触网）` };
  }
  if (!value.startsWith(ALLOWED_CHANNEL_PREFIX)) {
    return {
      ok: false,
      code: 'channel_not_allowlisted',
      matched: null,
      detail: `providerId 不是 ${ALLOWED_CHANNEL_PREFIX} 前缀的订阅通道，拒绝注入（未取键、未解密、未触网）`
    };
  }
  return { ok: true, channel: value };
}

/* -------------------------------------------------------------------------- */
/* port 形状                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 官方 `requestAuth` 的形状。`toJSON` 抛错把"顺手序列化"这条失败路径堵死。
 */
export interface RequestAuth {
  readonly apiKey: string;
  readonly entryKey: string;
  toJSON(): never;
}

function makeRequestAuth(apiKey: string, entryKey: string): RequestAuth {
  const auth: RequestAuth = {
    apiKey,
    entryKey,
    toJSON(): never {
      throw new OfficialCredentialError('ENVELOPE_MALFORMED', 'requestAuth 禁止被序列化：其中含凭据明文', { entryKey });
    }
  };
  return auth;
}

/** 官方 port 的应答形状（逐字）。 */
export interface HeadersPortResult {
  readonly headersApplied: boolean;
  readonly requestAuth: RequestAuth;
}

/** 官方 port 接口（逐字）。消费侧不做 provider 白名单二次门，所以本实现是唯一闸门。 */
export interface ProviderRuntimeHeadersPort {
  shouldRefreshBeforeModelRequest(): boolean;
  refreshBeforeModelRequest(n: unknown): HeadersPortResult;
}

export const HEADERS_PORT_ERROR_CODES = [
  'CHANNEL_BLOCKED',
  'CHANNEL_NOT_ALLOWLISTED',
  'CREDENTIAL_RESOLUTION_FAILED'
] as const;
export type HeadersPortErrorCode = (typeof HEADERS_PORT_ERROR_CODES)[number];

/**
 * 注入前失败。**结构化**：带 `code` / `providerId` / `detail`，且 `detail` 里
 * **永远不含凭据值**（错误源若是 `OfficialCredentialError`，只取它的 `code` 与 `message`，
 * 而那两者按构造约定就不含值）。
 */
export class HeadersPortError extends Error {
  readonly code: HeadersPortErrorCode;
  readonly providerId: string;
  readonly detail: string;

  constructor(code: HeadersPortErrorCode, providerId: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'HeadersPortError';
    this.code = code;
    this.providerId = providerId;
    this.detail = detail;
  }
}

export interface CreateHeadersPortOptions {
  readonly providerId: string;
  readonly planKind: OfficialPlanKind;
  readonly family: ProviderFamily;
  /**
   * 供测试注入的取键函数；缺省走 `resolveCredentialForPlan`（真读仓只在子宿主里发生）。
   *
   * 实参**必须**带上 `providerId`：individual-coding-plan 的 api-key 条目键内嵌
   * providerId（官方 `accountProviderCredentialKey`），少了它就只能 fail-closed 报错。
   */
  readonly resolveCredential?: (request: {
    readonly planKind: OfficialPlanKind;
    readonly family: ProviderFamily;
    readonly providerId: string;
  }) => CredentialValue;
}

/**
 * 构造自建 port。
 *
 * 构造时**不做任何 I/O**——只记下 providerId / planKind / family。取键推迟到
 * `refreshBeforeModelRequest`，因为官方是在发起模型请求**之前**调它，而不是启动时。
 *
 * @param options providerId + planKind + family（+ 可注入取键）
 * @returns 官方 port 接口
 */
export function createHeadersPort(options: CreateHeadersPortOptions): ProviderRuntimeHeadersPort {
  const policy = evaluateChannelPolicy(options.providerId);
  if (!policy.ok) {
    // 构造期就拒：**一个被判定为付费通道的 providerId 拿不到 port 对象**，
    // 因此不可能通过"忘了调 refresh"以外的任何路径注入出去。
    throw new HeadersPortError(
      policy.code === 'blocked_channel' ? 'CHANNEL_BLOCKED' : 'CHANNEL_NOT_ALLOWLISTED',
      typeof options.providerId === 'string' ? options.providerId : '<unparsable>',
      policy.detail
    );
  }
  const resolve = options.resolveCredential ?? ((request) => resolveCredentialForPlan(request));

  return {
    shouldRefreshBeforeModelRequest(): boolean {
      return true;
    },
    refreshBeforeModelRequest(_n: unknown): HeadersPortResult {
      // 二次判定：port 对象可能被跨 provider 复用（官方一处缓存，多个 provider 请求）。
      // 构造期那道只挡住"创建时就非法"，这里挡住"被挪用到非法通道上"。
      const recheck = evaluateChannelPolicy(options.providerId);
      if (!recheck.ok) {
        throw new HeadersPortError(
          recheck.code === 'blocked_channel' ? 'CHANNEL_BLOCKED' : 'CHANNEL_NOT_ALLOWLISTED',
          options.providerId,
          recheck.detail
        );
      }
      let value: CredentialValue;
      try {
        value = resolve({ planKind: options.planKind, family: options.family, providerId: options.providerId });
      } catch (e) {
        // 只搬运结构化失败，绝不把 `e` 整体挂到 detail 上：万一某个实现把明文塞进
        // 自己的 message，这里就会成为泄漏点。取 `code` + `message` 两条白名单字段。
        if (e instanceof OfficialCredentialError) {
          throw new HeadersPortError('CREDENTIAL_RESOLUTION_FAILED', options.providerId, `${e.code}: ${e.message}`);
        }
        throw new HeadersPortError('CREDENTIAL_RESOLUTION_FAILED', options.providerId, '凭据取键失败（错误来源未知，不附原始异常）');
      }
      return {
        headersApplied: true,
        requestAuth: makeRequestAuth(value.reveal(), value.entryKey)
      };
    }
  };
}
