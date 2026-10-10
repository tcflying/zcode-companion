/**
 * API01 本机 OpenAI 兼容 API 的路由与生命周期。
 *
 * 八条硬事实：
 *  1. **默认关闭、只绑回环。** `enabled` 缺省为 `false`，`start()` 不监听任何端口。
 *     绑定地址在**构造期**就只接受 `127.0.0.1`；`0.0.0.0` / `::` / 任何主机名
 *     抛 `LOOPBACK_ONLY`，不是启动后才失败。
 *  2. **CORS 永不开启。** 任何路径都不输出 `access-control-*` 头，`OPTIONS` 一律
 *     405。浏览器发起的跨源请求因此读不到任何响应；不带 `Origin` 的非浏览器客户端
 *     （IDE 扩展、curl）不受影响。
 *  3. **流水线顺序即风险顺序**：Host → Origin → 路由/方法 → 声明体大小 → 认证 →
 *     限流 → 读体 → JSON → schema → 幂等 → 驱动器。声明体大小排在认证之前是
 *     有意的：不缓冲超限请求体正是这条检查存在的理由。
 *  4. **幂等只登记 2xx，且必须显式 opt-in（COMPAT1/C1）。** 失败与结果未知**不写入**
 *     幂等表，也**不自动重发**：无额度不是一次"已完成的操作"，登记下来会把临时状态
 *     固化成永久重放。已登记的 2xx 可原样重放；超预算或失败的登记返回
 *     `idempotency_replay_unavailable`。
 *     **一个幂等头都没发的请求 = 不进幂等表**：不重放、不比对 bodyHash、不 409，
 *     响应头 `x-zcc-idempotency: none`。这条取代了旧实现"缺头回落
 *     `default-client`/`default-session`"——那让所有标准 OpenAI 兼容客户端落进同一
 *     作用域，首个成功请求后全线 409（协调者实弹 0.003 s 复现，是本 API 唯一的
 *     CRITICAL 硬阻断）。
 *  5. **优雅关闭不用 `process.exit`。** `stop()` 先停止接受新连接，再等在途请求
 *     **有界**收束（超时报 `timedOut`，如实上报而不是掩盖），最后销毁剩余 socket、
 *     清理定时器与信号监听器。本文件里没有任何 `process.exit`。
 *  6. **key 不进日志。** 日志只出现 `zcc-fp:*` 指纹、路径、状态、耗时、operationId。
 *     本包不 spawn 任何子进程，因此不存在"按端口/进程名回收"的问题。
 *  7. **配置是闭集的，fixture 只能由测试显式打开。** 未登记的配置键构造期即拒；
 *     挂 fixture 驱动器必须同时持有一个只有 import 才拿得到的 symbol 令牌
 *     （`FIXTURE_TEST_TOKEN`），生产配置在结构上开不了假模型。
 *  8. **三条路径分工明确。** `/v1/models` 是给外部 IDE 的纯 OpenAI 形状；
 *     `/v1/zcc/catalog` 是给本产品界面的目录（`{revision, models[]}`，协调者裁定）；
 *     `/v1/chat/completions` 是产出。任何一条都不混用另外两条的字段。
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import { ApiError, toApiError } from './errors.js';
import {
  buildReadStatus,
  type EvidenceLike,
  type ReadStatusDriverKind
} from './read-status.js';
import { createOperationJournal, type JournalState } from './journal-store.js';
import {
  DEFAULT_RATE_LIMIT,
  HOST_LOOPBACK,
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_BODY_MAX_BYTES,
  RateLimiter,
  isAllowedHost,
  isAllowedOrigin,
  resolveIdempotencyOptIn,
  resolveSessionIdentity,
  verifyApiKey,
  type IdempotencyOptIn
} from './auth.js';
import {
  SseBudget,
  STREAM_BUFFER_MAX_BYTES,
  catalogContractDefects,
  createUnavailableDriver,
  deriveModelIsReal,
  emitChunk,
  maxTokensNotForwarded,
  maxTokensClampDisclosure,
  normalizedRequestHash,
  parseChatRequest,
  sseDone,
  TOOLS_FORWARDED_NONE,
  type CatalogModel,
  type CatalogPayload,
  type ChatDriver,
  type DriverCatalog,
  type DriverEvent,
  type ParsedChatRequest
} from './chat.js';

/**
 * IDE 要填的固定端口。改这里要同步改报告里的照抄配置。
 *
 * **2026-09-29 换过**：旧默认 8765 在本机被一个无关 python 进程（PID 33940）常驻占用
 * （`netstat -ano` + `tasklist` 实测，本包按安全边界没有动它）。实测候选端口后取
 * 8790：`net.createServer().listen(8790,'127.0.0.1')` 成功、`8765` 返回 `EADDRINUSE`。
 * 端口保持可配置（`ApiServerConfig.port`），换默认不影响任何调用方。
 */
export const DEFAULT_API_PORT = 8790;

/** 唯一允许的绑定地址。从这里再导出一次，让调用方只需要 import 一个模块。 */
export { HOST_LOOPBACK } from './auth.js';

/**
 * 仅测试可用的显式令牌（`unique symbol`）。
 *
 * fixture 驱动器是**假模型产出**，生产路径绝不能被打开。做法是让"启用它"必须持有一个
 * 只有代码 import 才拿得到的 symbol：设置页 / 配置文件**无法表达 symbol**，所以用户
 * 配置在结构上开不了它；能在生产代码里打开它的，只有特意 import 这个 token 的人。
 * 配合 {@link API_SERVER_CONFIG_KEYS} 的闭集校验（任何未登记的配置键直接抛错），
 * "加个 `fixture: true` 就能开"这类后门字段在构造期就进不来。
 */
export const FIXTURE_TEST_TOKEN: unique symbol = Symbol('zcc.fixture.test-token');

/** 扩展目录端点。协调者裁定的形状，UI02 客户端已按此实现。 */
export const CATALOG_PATH = '/v1/zcc/catalog';

/**
 * 只读证据状态端点（ZCC-GUI-EVIDENCE-20261008-A）。
 *
 * 与 {@link CATALOG_PATH} 分工：catalog 只给模型目录；本端点给"这份目录/资格/选模
 * 读回到什么程度、还差什么才能定级"的**事实**。它**不做任何 I/O**，只投影启动时
 * 已在内存捕获的证据——**GET 不会重新制造 fresh，也不会刷新 updatedAt**。
 */
export const READ_STATUS_PATH = '/v1/zcc/readstatus';

export interface ApiLogger {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

const NOOP_LOGGER: ApiLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * `ApiServerConfig` 的**闭集键表**。构造期逐键校验：不在表里的键一律抛
 * `UNKNOWN_API_CONFIG_KEY`，不静默忽略。
 *
 * 为什么要闭集：多认一个键就等于多一条"配置能改变行为"的边。`fixture` 这类后门字段
 * 的危害正是它平时看着无害（默认 false），某天有人把默认值改了或把它接上了某个读取
 * 路径。闭集让"新增配置项"变成一次**必须同时改这张表并让测试变红**的显式动作。
 * 契约测试把本表钉死（`API_SERVER_CONFIG_KEYS` 精确相等断言）。
 */
export const API_SERVER_CONFIG_KEYS = [
  'enabled',
  'host',
  'port',
  'apiKeys',
  'allowedOrigins',
  'rateLimit',
  'shutdownGraceMs',
  'driver',
  'testOnlyFixtureToken',
  'logger',
  'now',
  'journalDir',
  'journalMaxEntries',
  'readStatus'
] as const;

/**
 * journal 条目上限缺省值。与幂等表的 `MAX_IDEMPOTENCY_ENTRIES` 同量级，
 * 但**两者独立**：一个管「重放正文预算」，一个管「操作事实记录」，
 * 混用会让任一侧的淘汰语义悄悄改变对方的容量语义。
 */
export const DEFAULT_JOURNAL_MAX_ENTRIES = 512;

export interface ApiServerConfig {
  /** 缺省关闭。必须显式 `enabled: true` 才会监听。 */
  readonly enabled?: boolean;
  /** 只接受 `127.0.0.1`。其他值在构造期抛错。 */
  readonly host?: typeof HOST_LOOPBACK;
  /** 缺省 8790；测试用 0 取临时端口。 */
  readonly port?: number;
  readonly apiKeys: readonly string[];
  /** 缺省空数组 = 带 Origin 头的请求全拒。 */
  readonly allowedOrigins?: readonly string[];
  readonly rateLimit?: { readonly maxConcurrent: number; readonly requests: number; readonly windowMs: number };
  /** 在途请求的收束上限；超时如实报 `timedOut`，不使用 `process.exit`。 */
  readonly shutdownGraceMs?: number;
  readonly driver?: ChatDriver;
  /**
   * **仅测试**。挂 fixture 驱动器时必须显式传 {@link FIXTURE_TEST_TOKEN}，否则构造期
   * 抛 `FIXTURE_DRIVER_TEST_ONLY`。生产配置不可能持有这个 symbol，因此结构上开不了假模型。
   */
  readonly testOnlyFixtureToken?: typeof FIXTURE_TEST_TOKEN;
  readonly logger?: ApiLogger;
  readonly now?: () => number;
  /**
   * 操作 journal 的落盘目录（929.md:875「journal不足拒新发而非丢unknown」）。
   *
   * **缺省即不启用持久化**：此时 journal 纯内存、容量拒绝仍生效，但不落盘。
   * 显式传入才会读写 `<journalDir>/journal.json`，且**登记发生在真实副作用
   * （`driver.stream`）之前**——容量不足或写失败时直接拒绝本次新发，
   * 驱动器一次都不被调用。
   */
  readonly journalDir?: string;
  /** journal 条目上限；缺省 {@link DEFAULT_JOURNAL_MAX_ENTRIES}。 */
  readonly journalMaxEntries?: number;
  /**
   * 启动时捕获的**只读证据状态**（ZCC-GUI-EVIDENCE-20261008-A）。
   *
   * 缺省即"没有证据可报"——`/v1/zcc/readstatus` 此时返回 `evidence: null`
   * 对应的 `evidence_not_captured` 缺口，而不是伪造一份。**这里不接受任何文件路径**，
   * 调用方传什么就只是什么；真正的读源发生在驱动器构造期，不在本端点。
   */
  readonly readStatus?: ReadStatusProvider;
}

/**
 * readstatus 的证据提供者。**纯函数、无 I/O**：
 * 由启动入口在读源之后构造一次，此后每次 GET 只调用它投影，不重新读盘。
 */
export type ReadStatusProvider = () => {
  readonly driverKind: ReadStatusDriverKind;
  readonly driverCatalogCount: number | null;
  /** 同层目录 revision；与 evidence 的 catalogRevision 同 scope 可比。null = 未知。 */
  readonly driverCatalogRevision: string | null;
  readonly servableCount: number | null;
  readonly driverStatus: 'ready' | 'not_attached' | 'unavailable';
  readonly evidence: EvidenceLike | null;
};

export interface ApiStartResult {
  readonly started: boolean;
  readonly reason?: 'disabled_by_default';
  readonly port?: number;
  readonly address?: string;
}

export interface ApiDiagnostics {
  readonly inFlight: number;
  readonly trackedSockets: number;
  readonly activeTimers: number;
  readonly signalListeners: number;
  readonly idempotencyEntries: number;
  readonly driverCalls: number;
  readonly status: string;
  readonly replayBytes: number;
}

export interface ApiServer {
  start(): Promise<ApiStartResult>;
  /** 有界收束的优雅关闭。可重复调用。 */
  stop(): Promise<{ closed: boolean; timedOut: boolean }>;
  address(): { readonly address: string; readonly port: number } | null;
  /** 实时诊断快照。关闭测试直接断言它归零。 */
  readonly diagnostics: ApiDiagnostics;
  readonly requestListener: http.RequestListener;
}

interface RequestIdentity {
  readonly keyFingerprint: string;
  /**
   * 幂等 opt-in 判定（工单 COMPAT1/C1）。**没有**默认值：缺头 = `kind:'none'`
   * = 每次都是新 operation。旧的 `clientId`/`sessionId` 缺省回落字段已整条删除。
   */
  readonly idempotency: IdempotencyOptIn;
}

interface RateLimitVerdict {
  readonly ok: boolean;
  readonly reason: 'concurrency' | 'rate' | null;
  readonly retryAfterMs: number;
  readonly remaining: number;
  readonly limit: number;
}

interface StoredOperation {
  readonly operationId: string;
  readonly bodyHash: string;
  /** `done` 才允许重放；`in_flight` / `failed` 都不重放。 */
  state: 'in_flight' | 'done' | 'failed';
  replay: string | null;
  contentType: string;
  bytes: number;
}

/** 可重放响应的总字节与条目预算，超出即逐出最旧条目，避免内存无界增长。 */
const REPLAY_STORE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_IDEMPOTENCY_ENTRIES = 512;
const OPERATION_ID_PREFIX = 'chatcmpl-';

export function createApiServer(config: ApiServerConfig): ApiServer {
  // 闭集校验放在最前面：先拒绝"我们不认识的配置"，再谈别的。
  for (const key of Object.keys(config)) {
    if (!(API_SERVER_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(`UNKNOWN_API_CONFIG_KEY: 本机 API 不接受配置项 ${key}（不静默忽略未知配置）`);
    }
  }
  const host = config.host ?? HOST_LOOPBACK;
  if (host !== HOST_LOOPBACK) {
    // 构造期 fail-closed：非回环绑定直接拒绝，不给"先起来再说"的机会。
    throw new Error(`LOOPBACK_ONLY: 本机 API 只允许绑定 ${HOST_LOOPBACK}，收到 ${String(host)}`);
  }
  const enabled = config.enabled === true;
  const requestedPort = config.port ?? DEFAULT_API_PORT;
  const apiKeys = [...(config.apiKeys ?? [])];
  const allowedOrigins = [...(config.allowedOrigins ?? [])];
  const logger = config.logger ?? NOOP_LOGGER;
  const now = config.now ?? Date.now;
  const shutdownGraceMs = config.shutdownGraceMs ?? 5_000;
  const driver: ChatDriver = config.driver ?? createUnavailableDriver({ status: 'not_attached' });
  if (driver.fixture === true && config.testOnlyFixtureToken !== FIXTURE_TEST_TOKEN) {
    // fixture = 假模型产出。生产配置拿不到 FIXTURE_TEST_TOKEN（symbol 无法被配置表达），
    // 所以这条路对生产是关闭的；测试必须显式声明"我知道我在造假"。
    throw new Error(
      'FIXTURE_DRIVER_TEST_ONLY: fixture 驱动器只允许测试使用。生产配置无法启用它——需要显式传入 FIXTURE_TEST_TOKEN。'
    );
  }
  const rateLimiter = new RateLimiter({ ...DEFAULT_RATE_LIMIT, ...(config.rateLimit ?? {}) });
  // 操作 journal（929.md:875）。`journalDir` 缺省 = 纯内存、不落盘；
  // 容量拒绝语义两种模式下都生效，持久化只是额外的跨重开保障。
  const operationJournal = createOperationJournal(config.journalDir);
  const journalMaxEntries = config.journalMaxEntries ?? DEFAULT_JOURNAL_MAX_ENTRIES;

  const operations = new Map<string, StoredOperation>();
  const sockets = new Set<Socket>();
  let replayBytes = 0;
  let inFlight = 0;
  let driverCalls = 0;
  let signalListeners = 0;
  let boundPort = requestedPort;
  let server: http.Server | null = null;
  /** @type {(() => void) | null} */
  let removeSignalHandlers: null | (() => void) = null;

  /* ------------------------------------------------------------------ */
  /* 响应头与响应体                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * `x-zcc-fixture` **只在真的是 fixture 时出现**：缺席即"不是 fixture"，
   * 不会让客户端误以为背后有真实模型。
   */
  const stateHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      'x-zcc-status': driver.status,
      'x-zcc-driver': driver.name,
      'x-zcc-detail': encodeURIComponent(driver.statusDetail)
    };
    if (driver.fixture) headers['x-zcc-fixture'] = 'true';
    return headers;
  };

  const send = (
    res: http.ServerResponse,
    status: number,
    contentType: string,
    body: string,
    headers: Record<string, string> = {}
  ): void => {
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(buf.length),
      'cache-control': 'no-store',
      // 幂等不是上游 exactly-once：重放的是 Companion 侧 operation，不代表上游只执行一次。
      'x-zcc-idempotency-scope': 'companion-operation-replay-not-upstream-exactly-once',
      ...stateHeaders(),
      ...headers
    });
    res.end(buf);
  };

  const sendError = (res: http.ServerResponse, err: ApiError): void => {
    send(res, err.status, 'application/json; charset=utf-8', JSON.stringify(err.toBody(new Date(now()).toISOString())), err.headers());
  };

  const rateLimitHeaders = (verdict: RateLimitVerdict): Record<string, string> => ({
    'x-zcc-ratelimit-limit': String(verdict.limit),
    'x-zcc-ratelimit-remaining': String(verdict.remaining)
  });

  const rateLimitError = (verdict: RateLimitVerdict): ApiError =>
    new ApiError(
      'rate_limited',
      verdict.reason === 'concurrency' ? '并发请求数超过上限，已直接拒绝（不排队）' : '速率超过上限，已直接拒绝（不排队）',
      { reason: verdict.reason ?? '', limit: verdict.limit }
    ).withHeaders({
      'retry-after': String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))),
      ...rateLimitHeaders(verdict)
    });

  /**
   * `journal.reserve` 的拒绝原因 → 具体 `ApiError`。
   *
   * 每个原因给**自己的**错误码与文案，不合并：
   * 客户端按 `code` 做的处置完全不同（清理容量 / 看坏原件 / 换会话），
   * 把它们糊成一个「写入失败」会让运维照着错的处置走。
   *
   * 五种情况的共同点只有一条：**驱动器一次都不会被调用，本次请求未提交上游**。
   */
  const journalRejection = (reason: string | undefined, operationId: string): ApiError => {
    const r = String(reason ?? 'unknown');
    const detail = { journal_rejected: true, reason: r, operation_id: operationId, driver_called: false };
    if (r === 'journal_capacity_exceeded') {
      return new ApiError(
        'journal_capacity_exceeded',
        '操作 journal 已满且无可淘汰条目：本次新发被拒，不会丢弃任何 unknown 记录。清理后重试。',
        detail
      );
    }
    if (r === 'journal_corrupt') {
      return new ApiError(
        'journal_corrupt',
        '操作 journal 原件读不懂：本次新发被拒（驱动器未被调用）。坏原件已原样保留、未被覆盖，请人工检查后再恢复发送。',
        detail
      );
    }
    if (r === 'operation_outcome_unknown') {
      return new ApiError(
        'upstream_outcome_unknown',
        '该 operationId 已有结果不可知的记录：拒绝再次发送，避免对同一件事重复提交上游。',
        detail
      );
    }
    if (r === 'operation_in_progress') {
      return new ApiError(
        'idempotency_in_progress',
        '该 operationId 仍在途：拒绝并发执行第二次。',
        detail
      ).withHeaders({ 'retry-after': '1' });
    }
    // 含 `journal_write_failed: <原始错误>` 的落盘失败，以及任何未预期的拒绝原因。
    return new ApiError(
      'journal_write_failed',
      `操作 journal 落盘失败，本次新发被拒（驱动器未被调用，未发出任何请求）：${r}`,
      detail
    );
  };

  const zccBlock = (usageMethod: string, parsed: ParsedChatRequest): Record<string, unknown> => ({
    fixture: driver.fixture,
    driver: driver.name,
    // 从驱动器能力推导，不硬编码（见 chat.ts 的 deriveModelIsReal）：
    // fixture → false；无驱动器 → false；真实驱动器（ready + 非 fixture + 有模型）→ true。
    model_is_real: deriveModelIsReal(driver),
    status: driver.status,
    usage_method: usageMethod,
    // **COMPAT2**：这条**不再**等于"客户端发了上限"，而是**驱动器能不能真的强制执行**。
    // 旧实现报 `parsed.maxTokens !== null`，而 official-host 那时会把上限塞进官方
    // `session/create` 的 params —— 那份 schema 逐字是 `.strict()` 且**没有**这个键，
    // 于是每个带上限的请求都被官方拒掉，而这里仍然报 `true`：一条**假披露**。
    // 现在口径由 `ChatDriver.enforcesMaxTokens` 决定（见 chat.ts 的逐字出处注释）。
    max_tokens_enforced: driver.enforcesMaxTokens && parsed.maxTokens !== null,
    idempotency: 'companion-operation-replay-not-upstream-exactly-once',
    auto_resend_allowed: false,
    // **COMPAT1/C2**：实际采用的推理档位（`null` = 用驱动器缺省）。
    reasoning_effort_applied: parsed.reasoning,
    // **COMPAT1/C3 + COMPAT2**：本次请求里"我们校验通过、但没有转发"的参数名。
    // 恒在场（可能是 `[]`），所以"客户端查了就知道"不需要先读文档。
    // 这是"接受但明示未生效"与"静默丢弃"的分界线。
    // 上限那一条**按驱动器能力**追加，并**逐字用客户端发来的键名**（`max_completion_tokens`
    // 就报 `max_completion_tokens`）——报成别的名字等于告诉客户端一件与它无关的事。
    parameters_not_forwarded: [...parsed.parametersNotForwarded, ...maxTokensNotForwarded(parsed, driver.enforcesMaxTokens)],
    // 上限超额被钳制时披露原值与上限（键**缺席**=未钳制）："接受了但缩小到上限"
    // 与"收下但没进驱动"（parameters_not_forwarded）语义不同，不共用一张表。
    ...maxTokensClampDisclosure(parsed),
    // **COMPAT3**：本次请求里被**折叠**进 prompt 上下文的指令 role（`system` /
    // `developer`）。恒在场（无折叠时是 `[]`），口径与 `parameters_not_forwarded` 一致：
    // 客户端要知道"你的系统提示词被并进了 prompt 上下文"，而不是靠猜产出里那个
    // `developer:` 行标签是谁写的。按首次出现序、去重。
    // 披露**只**到"折叠了哪些 role"为止：不宣称折叠后的内容与官方 agent 自己的系统提示
    // 同优先级（那条优先级由官方决定，见 chat.ts 的 `FOLDED_PROMPT_ROLES` 注释）。
    roles_folded: [...parsed.rolesFolded],
    // **COMPAT4**：工具**声明**被接受（逐项浅校验）但**一条也不转发**。三个键**恒在场**，
    // 合起来把"本端点是纯对话形态"变成可机读事实，而不是一句文档说明：
    //  - `tools_received`：客户端这次声明了几条（缺席 / `[]` / `null` 都是 0）；
    //  - `tools_forwarded`：**恒为 0**。这是结构事实（`DriverRequest` 上没有工具
    //    槽位，官方 `session/send` 只收一条 `content` 文本），不是可调策略；
    //  - `tool_choice_received`：客户端实际发的那个值（`null` = 没发）——披露"发了什么"，
    //    不是"我们采用了什么"（这里永远没有"采用"这个动作发生）。
    // 仍然拒的只有"要求必须调工具"那一类（`required` / 具名指定），它们会让客户端
    // 等一个永远不会来的 `tool_calls`。流式与非流式**共用这一个块**，两条路径同形。
    tools_received: parsed.toolsReceived,
    tools_forwarded: TOOLS_FORWARDED_NONE,
    tool_choice_received: parsed.toolChoiceReceived,
    // **COMPAT1/C4**：驱动器自报的实现事实（宿主权限档位 / 工具策略等）。
    // 缺省缺席 = 驱动器没有可披露的实现事实（fixture / 无驱动器）。
    ...(driver.host === undefined ? {} : { host: { ...driver.host } })
  });

  /* ------------------------------------------------------------------ */
  /* 网络门：Host / Origin                                                */
  /* ------------------------------------------------------------------ */

  const passNetworkGates = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    if (!isAllowedHost(req.headers.host, boundPort)) {
      sendError(
        res,
        new ApiError('host_not_allowed', 'Host 头不是本机 API 的监听地址，拒绝（防 DNS rebinding）', {
          host_present: req.headers.host !== undefined
        })
      );
      return false;
    }
    if (!isAllowedOrigin(req.headers.origin, allowedOrigins)) {
      sendError(
        res,
        new ApiError('origin_not_allowed', 'Origin 不在白名单内，拒绝（默认白名单为空）', {
          origin_present: true,
          allowed_count: allowedOrigins.length
        })
      );
      return false;
    }
    return true;
  };

  /* ------------------------------------------------------------------ */
  /* 认证                                                                */
  /* ------------------------------------------------------------------ */

  const authenticate = (req: http.IncomingMessage, res: http.ServerResponse): RequestIdentity | null => {
    const verdict = verifyApiKey(req.headers.authorization, apiKeys);
    if (!verdict.ok || verdict.fingerprint === null) {
      // 只说"需要 key"，绝不说"你给的 key 不对"、更不回显任何 key 片段。
      sendError(
        res,
        new ApiError('unauthorized', '需要有效的本机 API key：请求头 Authorization 使用 Bearer 方案', {}).withHeaders({
          'www-authenticate': 'Bearer'
        })
      );
      return null;
    }
    return {
      keyFingerprint: verdict.fingerprint,
      // **COMPAT1/C1**：作用域只在客户端**显式** opt-in 时才存在。一个幂等头都没发
      // 的请求（标准 OpenAI 兼容客户端的常态）拿到 `kind:'none'`，`runChat` 整条
      // 幂等路径被跳过——不再落进共享的 `default-client/default-session` 作用域。
      idempotency: resolveIdempotencyOptIn(req.headers, verdict.fingerprint)
    };
  };

  /* ------------------------------------------------------------------ */
  /* GET /v1/models                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * 无上游时返回 **200 + 空列表**（而不是 503）：OpenAI 兼容客户端普遍把
   * `/v1/models` 当作连通性探测，503 会让整个配置被判成"服务不可用"，把真实原因
   * 盖住。空列表是**诚实**的——确实没有可服务的模型；`x-zcc-status` 头如实说明状态。
   * 绝不返回占位假模型。
   */
  const handleModels = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.method !== 'GET') {
      throw new ApiError('method_not_allowed', '/v1/models 只接受 GET', { method: req.method ?? '' }, 'method');
    }
    const identity = authenticate(req, res);
    if (identity === null) return;
    const verdict = rateLimiter.tryAcquire(identity.keyFingerprint);
    if (!verdict.ok) throw rateLimitError(verdict);
    try {
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ object: 'list', data: driver.models }), {
        'x-zcc-model-count': String(driver.models.length),
        ...rateLimitHeaders(verdict)
      });
    } finally {
      rateLimiter.release();
    }
  };

  /* ------------------------------------------------------------------ */
  /* GET /v1/zcc/catalog                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * 扩展目录端点。与标准 `/v1/models` **分工**：后者是给外部 IDE 用的纯 OpenAI 形状
   * （id/object/created/owned_by），本端点是给本产品界面用的目录（协调者裁定，UI02
   * 已按此形状实现解析层，勿改）。
   *
   * 三条硬规则：
   *  1. **无驱动器也返回 200**：`{revision:'none', models:[]}` + `x-zcc-status` 如实标注。
   *     目录"是空的"是事实，不是故障；503 会让界面把"没接上游"误读成"服务坏了"。
   *  2. **绝不列占位条目。** 模型只能来自驱动器的 `catalog`，生产侧不合成、不猜测。
   *  3. **产出侧自检。** 驱动器给出的目录若违反已公布契约（缺字段 / 类型错 / 非法枚举 /
   *     重复 modelId），整份响应被拒并如实报错，**不部分采纳**——部分采纳等于把一个
   *     会被严格客户端整体拒绝的响应发出去。
   */
  const handleCatalog = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.method !== 'GET') {
      throw new ApiError('method_not_allowed', `${CATALOG_PATH} 只接受 GET`, { method: req.method ?? '' }, 'method');
    }
    const identity = authenticate(req, res);
    if (identity === null) return;
    const verdict = rateLimiter.tryAcquire(identity.keyFingerprint);
    if (!verdict.ok) throw rateLimitError(verdict);
    try {
      const payload = buildCatalogPayload(driver.catalog);
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(payload), {
        'x-zcc-catalog-count': String(payload.models.length),
        ...rateLimitHeaders(verdict)
      });
    } finally {
      rateLimiter.release();
    }
  };

  /**
   * 目录产出侧自检 + 投影。任何一条缺陷 → 整份拒绝（抛错），返回的 payload 一定满足
   * 契约的每一个字段与取值，客户端不需要做容错。
   */
  const buildCatalogPayload = (catalog: DriverCatalog): CatalogPayload => {
    const defects = catalogContractDefects(catalog);
    if (defects.length > 0) {
      logger.warn(`event=catalog_contract_violation defects=${defects.slice(0, 8).join(',')} driver=${driver.name}`);
      throw new ApiError(
        'upstream_unavailable',
        `驱动器提供的模型目录不满足已公布契约，已整体拒绝（不做部分采纳）：${defects.slice(0, 3).join('、')}`,
        { catalog_contract_violation: true, defect_count: defects.length, first_defect: defects[0] ?? '' }
      );
    }
    const models: CatalogModel[] = (catalog.models as readonly CatalogModel[]).map((m) => ({
      modelId: m.modelId,
      displayName: m.displayName,
      provider: m.provider,
      billingClass: m.billingClass,
      contextLength: m.contextLength,
      reasoning: [...m.reasoning],
      capabilities: [...m.capabilities]
    }));
    return { revision: catalog.revision, models };
  };

  /* ------------------------------------------------------------------ */
  /* GET /v1/zcc/readstatus                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 只读证据状态（ZCC-GUI-EVIDENCE-20261008-A）。三条硬规则：
   *  1. **不做任何 I/O。** 证据在启动时由驱动器读源后捕获；本处理器只投影。
   *     GET **不会**重新读盘、不会刷新 `readAt`/`updatedAt`——它是历史读取的呈现，
   *     不是"现在仍然有效"的证明。
   *  2. **不定级。** 响应里恒有 `gradedByServer: false` 与 `validityWindowKnown: false`，
   *     并列出具名缺口。E1 规范由 I06 定义，不由这个端点擅自满足。
   *  3. **复用既有守卫。** 方法、身份认证、Origin/Host、限流、错误形状全部照
   *     {@link handleCatalog}；不开放 CORS、不扩任何闭集。
   */
  const handleReadStatus = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.method !== 'GET') {
      throw new ApiError('method_not_allowed', `${READ_STATUS_PATH} 只接受 GET`, { method: req.method ?? '' }, 'method');
    }
    const identity = authenticate(req, res);
    if (identity === null) return;
    const verdict = rateLimiter.tryAcquire(identity.keyFingerprint);
    if (!verdict.ok) throw rateLimitError(verdict);
    try {
      const captured = config.readStatus?.() ?? {
        driverKind: driver.name === 'local-official'
          ? ('local-official' as const)
          : (driver.name === 'official-host' ? ('official-host' as const) : ('none' as const)),
        driverCatalogCount: driver.catalog?.models?.length ?? null,
        driverCatalogRevision: driver.catalog?.revision ?? null,
        servableCount: null,
        driverStatus: 'not_attached' as const,
        evidence: null
      };
      const payload = buildReadStatus({
        driverKind: captured.driverKind,
        driverCatalogCount: captured.driverCatalogCount,
        driverCatalogRevision: captured.driverCatalogRevision,
        servableCount: captured.servableCount,
        driverStatus: captured.driverStatus,
        evidence: captured.evidence,
        // GET **不重读源**；now 只用于判断源时间戳是否荒谬（未来/负数/NaN）。
        now: (config.now ?? Date.now)()
      });
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(payload), {
        // 本端点只读且不含个人可识别内容；仍不缓存，避免界面拿旧事实当当前。
        'cache-control': 'no-store',
        'x-zcc-read-status-e1-blocking': String(payload.e1Blocking.length),
        ...rateLimitHeaders(verdict)
      });
    } finally {
      rateLimiter.release();
    }
  };

  /* ------------------------------------------------------------------ */
  /* POST /v1/chat/completions                                           */
  /* ------------------------------------------------------------------ */

  const handleChat = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      throw new ApiError('method_not_allowed', '/v1/chat/completions 只接受 POST', { method: req.method ?? '' }, 'method');
    }
    const identity = authenticate(req, res);
    if (identity === null) return;
    const verdict = rateLimiter.tryAcquire(identity.keyFingerprint);
    if (!verdict.ok) {
      logger.warn(
        `event=rate_limited key=${identity.keyFingerprint} reason=${verdict.reason ?? ''} limit=${verdict.limit}`
      );
      throw rateLimitError(verdict);
    }
    // 并发槽持有到响应真正结束（流式则持有到流写完），所以 release 必须在 await 之后。
    try {
      const raw = await readBody(req, res);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch (e) {
        throw new ApiError('invalid_json', `请求体不是合法 JSON：${e instanceof Error ? e.message : 'parse failed'}`, {
          bytes: Buffer.byteLength(raw, 'utf8')
        });
      }
      await runChat(req, res, parseChatRequest(parsedJson), identity);
    } finally {
      rateLimiter.release();
    }
  };

  const runChat = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsed: ParsedChatRequest,
    identity: RequestIdentity
  ): Promise<void> => {
    const operationId = `${OPERATION_ID_PREFIX}${randomUUID()}`;
    const bodyHash = normalizedRequestHash(parsed);
    // **COMPAT1/C1：作用域存在与否由显式 opt-in 决定。**
    // `scope === null` 时：既不查表、也不登记、不比对 bodyHash、更不会 409——
    // 每次都是一次全新的 operation。这条路径**没有**任何共享状态，所以
    // N 个并发无头请求互不影响（协调者实弹的 6 路并发正是这种形态）。
    const scope = identity.idempotency.kind === 'none' ? null : identity.idempotency.scope;
    const existing = scope === null ? undefined : operations.get(scope);

    if (existing !== undefined) {
      if (existing.bodyHash !== bodyHash) {
        throw new ApiError(
          'idempotency_conflict',
          '同一 幂等键/客户端身份+会话 已用不同请求体提交过；不会静默改写，请换会话或修正请求体',
          { body_hash_conflicts: true, idempotency_kind: identity.idempotency.kind }
        );
      }
      if (existing.state === 'in_flight') {
        throw new ApiError('idempotency_in_progress', '同一幂等作用域的请求正在处理中；不会并发执行第二次', {
          in_flight: true
        }).withHeaders({ 'retry-after': '1', 'x-zcc-operation-id': existing.operationId });
      }
      if (existing.replay === null) {
        throw new ApiError('idempotency_replay_unavailable', '原操作没有可重放的 2xx 响应；请开启新会话', {
          replayable: false
        }).withHeaders({ 'x-zcc-operation-id': existing.operationId });
      }
      logger.info(
        `event=idempotent_replay key=${identity.keyFingerprint} operation=${existing.operationId} status=200 kind=${identity.idempotency.kind}`
      );
      send(res, 200, existing.contentType, existing.replay, {
        'x-zcc-operation-id': existing.operationId,
        'x-zcc-idempotency': 'replayed'
      });
      return;
    }

    /**
     * **跨重启**的幂等守卫（父审 v90/v91：不能只靠随机 operationId）。
     *
     * 内存 `operations` 表随进程一起消失。重启后同一个幂等键再来一次，
     * 若只看内存表就会把它当成**全新操作**再发一次——那是对同一次用户意图
     * 的重复投递，可能重复扣上游额度。所以持久 journal 里额外记了
     * `scope` 与 `bodyHash`（**只存哈希，不存正文**），重启后据此判断：
     *
     *  - 哈希不同 ⇒ 同键异体，`idempotency_conflict`。
     *  - `in_flight` / `unknown` ⇒ 崩溃前那次发出去了、结果不可知，
     *    自动重发可能重复提交，拒绝（`upstream_outcome_unknown`）。
     *  - `done` / `failed` ⇒ 已结算，但**正文没有持久化**，
     *    拿不到可重放的 2xx 响应 ⇒ `idempotency_replay_unavailable`。
     *
     * **只在 journal 真的落盘时启用。** 没有 `journalDir` 就没有跨重启这回事，
     * 此时内存表就是全部真相——必须保持与加 journal 之前**逐字一致**，否则会
     * 顶掉 F02 明确要求的「重放预算淘汰后，同键作为全新操作重新执行」。
     * （实测：不加这个条件，`tests/unit/api-replay-budget-inflight.test.mjs`
     * 会从 200 退化成 409。）
     *
     * 边界如实说明：**跨重启的「原样重放正文」没有实现**，因为那要求把响应
     * 正文写进 journal，与「journal 不存正文」这条硬要求冲突。
     * 这里保证的是**不重复发送**（安全性），不是**跨重启重放**（便利性）。
     */
    if (existing === undefined && scope !== null && operationJournal.persistent()) {
      const persisted = operationJournal.lookupScope(scope);
      if (persisted !== undefined) {
        if (persisted.bodyHash !== undefined && persisted.bodyHash !== bodyHash) {
          throw new ApiError(
            'idempotency_conflict',
            '同一 幂等键/客户端身份+会话 在上一次进程运行中已用不同请求体提交过；重启后仍拒绝静默改写',
            { body_hash_conflicts: true, idempotency_kind: identity.idempotency.kind, survived_restart: true }
          ).withHeaders({ 'x-zcc-operation-id': persisted.operationId });
        }
        if (persisted.state === 'in_flight' || persisted.state === 'unknown') {
          throw new ApiError(
            'upstream_outcome_unknown',
            '该幂等作用域在重启前有一次结果不可知的操作；自动重发可能重复提交上游，本次拒绝发送。请人工确认后换新会话。',
            {
              idempotency_kind: identity.idempotency.kind,
              survived_restart: true,
              persisted_state: persisted.state,
              auto_resend_allowed: false
            }
          ).withHeaders({ 'x-zcc-operation-id': persisted.operationId });
        }
        throw new ApiError(
          'idempotency_replay_unavailable',
          '该幂等作用域的操作在重启前已完成；响应正文不持久化，无法跨重启重放。请开启新会话。',
          { replayable: false, survived_restart: true }
        ).withHeaders({ 'x-zcc-operation-id': persisted.operationId });
      }
    }

    /**
     * **会话级闸门**（929.md:347 / :853 / :916）——本轮补的唯一原需求缺口。
     *
     * 上面那个守卫只管「同一个键」。但外部客户端在失联后的**默认**行为是换一个
     * `Idempotency-Key` 重试（`:347`：「外部客户端默认新key重试也不能穿透同会话
     * unknown保护」）。换键 ⇒ 新作用域 ⇒ 作用域级守卫打不中 ⇒ 同会话那条
     * 「结果不可知」的记录被穿透，又发一次上游。这正是 `:853` 明令禁止的
     * 「同session新输入新增dispatch」。
     *
     * 判定只看 `unknown`：会话锁定针对的是「已发出、结果不可知」。
     * **不看 `in_flight`**——那会把一个会话里的正常并发也一起冻住；
     * 同一键的并发重复另有 `idempotency_in_progress` 兜底。
     *
     * 位置在**任何登记与发送之前**：被拒的请求不写幂等表、不写 journal、
     * 驱动器零调用。跨重建同样生效（会话身份哈希已随记录落盘）。
     *
     * 缺会话身份（客户端没发 `x-zcc-*`）时 `resolveSessionIdentity` 返回 `null`，
     * 这条闸门**不做任何判定**——我们不知道它属于哪个会话，编一个会话号会把
     * 会话锁定变成全局锁定。该边界在交付报告里如实列为未覆盖。
     */
    const session = resolveSessionIdentity(req.headers, identity.keyFingerprint);
    if (session !== null) {
      const pending = operationJournal.lookupSessionUnknown(session.sessionKey);
      if (pending !== undefined) {
        // 日志只写**指纹**，绝不写 client/session 原值。
        // 原值是客户端自报的标识，落进日志就等于把一份可关联的原始身份复制到盘上，
        // 而 `929.md:876` 要求的是可审计的拒绝码，不是可复原的原始身份。
        // `session.sessionKey` 就是 client+session+keyFingerprint 的规范化哈希，
        // 与会话闸门判重用的是**同一把键**，所以定位能力不变，原始值不再外流。
        //
        // 刻意**不动**下面 throw 出去的 detail：`client_id`/`session_id` 是回给
        // 「提交这两个头的那同一个已认证调用方」的，不构成外带；改它会扩大本轮修复面。
        logger.warn(
          `event=session_locked key=${identity.keyFingerprint} session_key=${session.sessionKey} pending_operation=${pending.operationId} new_key=${String(identity.idempotency.kind)}`
        );
        throw new ApiError(
          'upstream_outcome_unknown',
          '该会话存在结果不可知的在途操作：换用新幂等键或新输入都不能绕过同会话保护，本次拒绝发送。请先人工核销上一条结果。',
          {
            session_locked: true,
            client_id: session.clientId,
            session_id: session.sessionId,
            pending_operation_id: pending.operationId,
            auto_resend_allowed: false,
            driver_called: false
          }
        ).withHeaders({ 'x-zcc-operation-id': pending.operationId, 'retry-after': '1' });
      }
    }

    // 无上游：fail-closed。不返回任何模型内容，也不登记幂等表——无额度不是一次
    // "已完成的操作"，登记下来会把临时状态固化成永久重放。
    if (driver.status !== 'ready') {
      throw new ApiError('upstream_unavailable', driver.statusDetail, {
        driver: driver.name,
        status: driver.status,
        idempotency_registered: false,
        auto_resend_allowed: false
      }).withHeaders({ 'x-zcc-operation-id': operationId, 'x-zcc-idempotency': idempotencyLabel(scope) });
    }

    const stored: StoredOperation | null =
      scope === null
        ? null
        : { operationId, bodyHash, state: 'in_flight', replay: null, contentType: 'application/json; charset=utf-8', bytes: 0 };
    if (scope !== null && stored !== null) operations.set(scope, stored);

    /**
     * 真实副作用**之前**的强制登记（929.md:875）。
     *
     * 位置是关键：必须在下面 `driver.stream(...)` 之前完成登记。
     * 容量不足、原件损坏、写盘失败、或这个 operationId 已经有在途/未知记录
     * ⇒ 直接抛错，**驱动器一次都不会被调用**——这就是条款要的「不足拒新发」，
     * 而不是先发出去再补记录。
     *
     * `scope` / `bodyHash` 一并登记：它们是**跨重启**识别「这个幂等键已经发过」
     * 的唯一依据（只存哈希，不存正文，见 journal-store.ts 的说明）。
     */
    const reserved = operationJournal.reserve({
      operationId,
      ...(scope === null ? {} : { scope }),
      bodyHash,
      ...(session === null ? {} : { sessionKey: session.sessionKey }),
      at: now(),
      maxEntries: journalMaxEntries
    });
    if (!reserved.ok) {
      // 拒新发：把刚登记的幂等登记一并撤掉，避免留下「在途却没发」的幽灵条目。
      if (scope !== null) operations.delete(scope);
      throw journalRejection(reserved.reason, operationId).withHeaders({
        'x-zcc-operation-id': operationId
      });
    }

    const controller = new AbortController();
    const onGone = (): void => controller.abort();
    req.on('aborted', onGone);
    res.on('close', onGone);
    driverCalls += 1;
    const events = driver.stream({
      operationId,
      model: parsed.model,
      messages: parsed.messages,
      maxTokens: parsed.maxTokens,
      // **COMPAT1/C2**：请求级档位**优先**于驱动器缺省。`undefined` = 客户端没发，
      // 驱动器用自己的 `CreateOfficialHostDriverOptions.reasoning`。
      ...(parsed.reasoning === null ? {} : { reasoning: parsed.reasoning }),
      signal: controller.signal
    });
    try {
      const delivery = parsed.stream
        ? await writeSseStream(res, events, parsed, operationId, scope, stored)
        : ((await writeJsonCompletion(res, events, parsed, operationId, scope, stored)), 'completed' as const);

      /**
       * 客户端中途断开：流被掐断，**上游结果不可知**。
       *
       * 记 `done` 会让 journal 声称「这次操作成功完成」，而我们只知道它没送达到客户端，
       * 上游有没有做完**无从判断**。按 929.md:875 记 `unknown`——它受淘汰豁免保护、
       * 跨重开保留，正是这张表存在的意义。
       *
       * 幂等表那边**故意维持原状**（仍置 `done`）：此时 `replay === null`，
       * 同键重试会拿到 `idempotency_replay_unavailable`（409）。若改成 `in_flight`，
       * 这个作用域会永远卡在「处理中」，因为再没有任何东西会去结算它——那才是真 bug。
       */
      if (delivery === 'client_gone') {
        if (stored !== null) stored.state = 'done';
        operationJournal.settle(operationId, 'unknown', 'client_disconnected_midstream');
        logger.warn(
          `event=operation key=${identity.keyFingerprint} operation=${operationId} status=client_gone stream=${String(parsed.stream)} idempotency=${idempotencyLabel(scope)}`
        );
        return;
      }

      if (stored !== null) stored.state = 'done';
      // 终态写 journal：已成功是**确定结果**，不占「不可知」的豁免额度。
      operationJournal.settle(operationId, 'done');
      // 每个 operation 恰好一条带指纹的日志：key 只以 zcc-fp:* 形式出现。
      logger.info(
        `event=operation key=${identity.keyFingerprint} operation=${operationId} status=200 stream=${String(parsed.stream)} fixture=${String(driver.fixture)} idempotency=${idempotencyLabel(scope)}`
      );
    } catch (e) {
      const err = toApiError(e);
      // 结果不可知或失败：不登记幂等，也**不自动重发**。
      if (stored !== null) {
        stored.state = 'failed';
        stored.replay = null;
      }
      if (scope !== null) releaseOperation(scope);
      /**
       * 终态结算（929.md:875 的「不丢 unknown」落在这里）。
       *
       * 分流**读错误表里的投递语义**（`err.delivery`），不按码名字典序判断。
       * 原先写死 `err.code === 'upstream_outcome_unknown'`，漏掉了同样属于
       * `outcome_unknown` 的 `upstream_timeout`：一次超时会被记成 `failed`
       *（可淘汰），那条本该永久保留的「结果不可知」于是能被容量压力静默清掉——
       * 正是条款禁止的那件事。语义在 `errors.ts` 的表里，调用方不重复维护名单。
       *
       * `unknown`（结果不可知）vs `failed`（确定失败）：把两者混为一谈，
       * 要么让 `unknown` 混进可淘汰里被清掉，要么让明确失败永久占着容量。
       */
      const settlement: JournalState = err.delivery === 'outcome_unknown' ? 'unknown' : 'failed';
      const settled = operationJournal.settle(
        operationId,
        settlement,
        settlement === 'unknown' ? `outcome_unknown: ${err.code}` : err.code
      );
      if (!settled) {
        // 结算写盘失败：如实报出来。该条会停在 in_flight（不可淘汰、不会丢），
        // 但运维需要知道「终态没记上」，否则会以为它已经结算过了。
        logger.warn(`event=journal_settle_failed operation=${operationId} code=${err.code} state=${settlement}`);
      }
      if (res.headersSent) {
        // 流已开始，改不了状态码：如实销毁连接，不静默截断成"看起来成功"。
        res.destroy();
        logger.warn(`event=stream_failed key=${identity.keyFingerprint} operation=${operationId} code=${err.code}`);
      } else {
        sendError(res, err);
        logger.warn(`event=rejected key=${identity.keyFingerprint} code=${err.code} status=${err.status}`);
      }
    } finally {
      req.off('aborted', onGone);
      res.off('close', onGone);
    }
  };

  /* ------------------------------------------------------------------ */
  /* 产出：非流式与流式                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * 非流式：把驱动器产出流收集成标准 `chat.completion`。
   * usage 数字**完全来自驱动器**；驱动器没报就报 `null`，绝不自己编一个。
   */
  const writeJsonCompletion = async (
    res: http.ServerResponse,
    events: AsyncGenerator<DriverEvent>,
    parsed: ParsedChatRequest,
    operationId: string,
    scope: string | null,
    stored: StoredOperation | null
  ): Promise<void> => {
    let content = '';
    let reasoning = '';
    let usage: Extract<DriverEvent, { type: 'usage' }> | null = null;
    let finishReason = 'stop';
    let outBytes = 0;
    for await (const event of events) {
      if (event.type === 'delta') {
        content += event.text;
        outBytes += Buffer.byteLength(event.text, 'utf8');
        if (outBytes > STREAM_BUFFER_MAX_BYTES) {
          throw new ApiError('payload_too_large', `响应产出超过 ${STREAM_BUFFER_MAX_BYTES} 字节上限`, {
            limit_bytes: STREAM_BUFFER_MAX_BYTES
          });
        }
      } else if (event.type === 'reasoning') {
        // 思考流与正文分开聚合；同受缓冲上限约束（它同样占真实内存）。
        reasoning += event.text;
        outBytes += Buffer.byteLength(event.text, 'utf8');
        if (outBytes > STREAM_BUFFER_MAX_BYTES) {
          throw new ApiError('payload_too_large', `响应产出超过 ${STREAM_BUFFER_MAX_BYTES} 字节上限`, {
            limit_bytes: STREAM_BUFFER_MAX_BYTES
          });
        }
      } else if (event.type === 'usage') {
        usage = event;
      } else {
        finishReason = event.reason;
      }
    }
    const payload = {
      id: operationId,
      object: 'chat.completion',
      created: Math.floor(now() / 1000),
      model: parsed.model,
      choices: [{ index: 0, message: { role: 'assistant', content, ...(reasoning === '' ? {} : { reasoning_content: reasoning }) }, finish_reason: finishReason }],
      usage:
        usage === null
          ? null
          : {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.promptTokens + usage.completionTokens
            },
      zcc: zccBlock(usage?.usageMethod ?? 'unavailable', parsed)
    };
    const body = JSON.stringify(payload);
    if (scope !== null && stored !== null) commitReplay(scope, stored, 'application/json; charset=utf-8', body);
    send(res, 200, 'application/json; charset=utf-8', body, {
      'x-zcc-operation-id': operationId,
      'x-zcc-idempotency': idempotencyLabel(scope)
    });
    logger.info(
      `event=completion operation=${operationId} status=200 fixture=${String(driver.fixture)} bytes=${String(body.length)}`
    );
  };

  /**
   * 流式：逐 delta 转发成 SSE。**首帧在驱动器产出结束前就写出去**——这是真流，
   * 不是把一段完整结果切片假装流式。
   *
   * 返回值是**投递结果**，不是产出结果，两者不可混为一谈：
   *  - `'completed'`：驱动器产出走完，客户端拿到了完整流。
   *  - `'client_gone'`：客户端中途断开（`:806`）。驱动器是被 `events.return()`
   *    **中途掐断**的，上游到底有没有把这次操作做完——**我们不知道**。
   *
   * 调用方靠这个返回值决定结算：把被掐断的流记成 `done` 等于替一件我们
   * 确知不了的事背书，那正是 929.md:875 要防的「丢 unknown」。
   */
  const writeSseStream = async (
    res: http.ServerResponse,
    events: AsyncGenerator<DriverEvent>,
    parsed: ParsedChatRequest,
    operationId: string,
    scope: string | null,
    stored: StoredOperation | null
  ): Promise<'completed' | 'client_gone'> => {
    const created = Math.floor(now() / 1000);
    const ctx = {
      id: operationId,
      object: 'chat.completion.chunk' as const,
      created,
      model: parsed.model,
      zcc: zccBlock('not_reported', parsed)
    };
    const budget = new SseBudget();
    const frames: string[] = [];
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close',
      'x-zcc-operation-id': operationId,
      'x-zcc-idempotency': idempotencyLabel(scope),
      'x-zcc-idempotency-scope': 'companion-operation-replay-not-upstream-exactly-once',
      ...stateHeaders()
    });
    const push = (frame: string): void => {
      budget.write(frame);
      frames.push(frame);
      if (!res.destroyed) res.write(frame);
    };
    push(emitChunk(ctx, [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]));

    // SSE 注释行心跳（2026-10-10）：官方深思考期 `reasoning_delta` 之外仍可能有整段
    // 静默（create/工具执行/网络等待）。真客户端 mmx 的停滞检测在 ~70-90 s 无字节时
    // 判"任务进程停滞"并断开重试（实录 frames=1 → client_gone）。注释行（`:` 开头）
    // 是 SSE 规范的合法忽略帧：网络层看到字节流动，内容层不受污染。
    // 15 s 一拍：远低于实测的 mmx 停滞阈值，也远低于普通代理的 idle 超时。
    const heartbeat = setInterval((): void => {
      if (!res.destroyed) res.write(': keep-alive\n\n');
    }, 15_000);
    heartbeat.unref?.();

    let usage: Extract<DriverEvent, { type: 'usage' }> | null = null;
    let finishReason = 'stop';
    let clientGone = false;
    try {
      for await (const event of events) {
        if (res.destroyed) {
          clientGone = true;
          break;
        }
        if (event.type === 'delta') {
          push(emitChunk(ctx, [{ index: 0, delta: { content: event.text }, finish_reason: null }]));
        } else if (event.type === 'reasoning') {
          // 思考流外发（DeepSeek 风格 `delta.reasoning_content`）：思考期流保持活着，
          // 支持思考展示的客户端还能把思考过程画出来。
          push(emitChunk(ctx, [{ index: 0, delta: { reasoning_content: event.text }, finish_reason: null }]));
        } else if (event.type === 'usage') {
          usage = event;
        } else {
          finishReason = event.reason;
        }
      }
    } finally {
      clearInterval(heartbeat);
      // 客户端断开时立刻收掉产出，不让它继续空转。
      if (clientGone || res.destroyed) await events.return(undefined);
    }
    /**
     * 循环结束后**必须再查一次** `res.destroyed`，不能只看 `clientGone`。
     *
     * `clientGone` 只在「循环体内某一轮开头发现已断开」时才置位。存在一条完全
     * 绕开它的路径：客户端在上一轮写完之后、驱动器产出收尾的那段时间断开——
     * 此时循环**正常走完**（`clientGone` 始终为 false），驱动器的 `finally`
     * 已经在上面看到 `res.destroyed` 并收掉了产出，但下面这行若只判 `clientGone`
     * 就会走进「completed」分支：对一个**早已不存在的连接**记 `status=200`、
     * 结算 `done`、还 `push` 一个完成帧。客户端什么都没收到，我们却宣称成功——
     * 这正是 journal 存在的意义要防的那类假账。
     */
    if (clientGone || res.destroyed) {
      logger.info(`event=sse_aborted operation=${operationId} frames=${frames.length}`);
      return 'client_gone';
    }
    push(emitChunk(ctx, [{ index: 0, delta: {}, finish_reason: finishReason }]));
    if (parsed.includeUsage) {
      push(
        emitChunk(ctx, [], {
          usage:
            usage === null
              ? null
              : {
                  prompt_tokens: usage.promptTokens,
                  completion_tokens: usage.completionTokens,
                  total_tokens: usage.promptTokens + usage.completionTokens,
                  zcc_usage_method: usage.usageMethod
                }
        })
      );
    }
    push(sseDone());
    const body = frames.join('');
    if (scope !== null && stored !== null && Buffer.byteLength(body, 'utf8') <= STREAM_BUFFER_MAX_BYTES) {
      commitReplay(scope, stored, 'text/event-stream; charset=utf-8', body);
    }
    // 超出重放预算：登记保持存在但 replay 为 null，重复请求会拿到
    // idempotency_replay_unavailable，而不是假装能原样重放。
    if (!res.destroyed) res.end();
    logger.info(`event=sse operation=${operationId} frames=${frames.length} fixture=${String(driver.fixture)}`);
    return 'completed';
  };

  /* ------------------------------------------------------------------ */
  /* 幂等表                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * **可淘汰**的重放条目 = 已结算（`state === 'done'`）**且**确实持有可重放正文
   * （`replay !== null`）。两条缺一都还会漏：
   *
   *  - 缺 `state`：一条 `in_flight`（驱动器还在跑）的登记会被当成最旧条目删掉，
   *    下一个同作用域请求查不到登记 → 第二次进驱动器 → 同一次操作两次 200、
   *    上游额度被重复消耗（F02）。`current === entry` 只保护**提交**，
   *    它**不保护在途登记**。
   *  - 缺 `replay`：SSE 产出超过 `STREAM_BUFFER_MAX_BYTES` 时不会调用
   *    `commitReplay`（见 `writeSseStream`），那条登记是「已结算但没有可重放正文」。
   *    删掉它会把同键重试从 `idempotency_replay_unavailable` 退化成新 operation，
   *    于是又是一次重复执行。
   *
   * **仍未消除的风险（不得当成已修复）**：一条**已结算**的条目被淘汰之后，
   * 同键重试仍会变成一次新的驱动器调用。这条「预算压力下的潜在重复额度消耗」
   * 是预算有界性与幂等语义之间**本来就存在**的取舍，本卡只把淘汰范围收紧到
   * 「已结算且可释放」，并没有、也无法靠本卡把它消掉。
   */
  const isEvictableReplay = (entry: StoredOperation): boolean => entry.state === 'done' && entry.replay !== null;

  /**
   * 逐出最旧的**可淘汰**条目，直到回到预算之内。
   *
   * 找不到候选就停（而不是退而求其次删一条仍在执行的登记）：宁可让预算**暂时**
   * 超限，也不让一条还在跑的登记消失——省下的那点内存远小于重复执行一次上游的代价。
   * 实际可发生的情形只有「表里剩下的全是 `in_flight`」，而这类条目 `bytes === 0`、
   * 不占 `replayBytes`，因此字节预算（真正的内存上限）不会被突破；条目数则由限流
   * 的并发上限从外部封顶。
   */
  const evictReplayOverflow = (): void => {
    while (replayBytes > REPLAY_STORE_MAX_BYTES || operations.size > MAX_IDEMPOTENCY_ENTRIES) {
      let victimScope: string | null = null;
      // 插入序 = 登记序 = 请求到达序；这里跳过的那些**不是**被保护，而是不能删。
      for (const [key, candidate] of operations) {
        if (isEvictableReplay(candidate)) {
          victimScope = key;
          break;
        }
      }
      if (victimScope === null) break;
      const victim = operations.get(victimScope);
      if (victim === undefined) break;
      replayBytes -= victim.bytes;
      operations.delete(victimScope);
    }
  };

  const commitReplay = (scope: string, entry: StoredOperation, contentType: string, body: string): void => {
    const current = operations.get(scope);
    if (current === undefined) return;
    // COMPAT1/C1：写进**调用方自己持有**的那一条，而不是"表里此刻恰好挂着的那一条"。
    // 旧签名只按 scope 查表，一旦作用域语义改成"无头=不入表"，`undefined` 分支就会
    // 静默吞掉重放登记——而那条丢失只有下一次重放时才看得见。
    if (current !== entry) return;
    entry.replay = body;
    entry.contentType = contentType;
    entry.bytes = Buffer.byteLength(body, 'utf8');
    replayBytes += entry.bytes;
    // **结算必须先于淘汰。** 本函数就是「已结算」的时刻：驱动器产出结束、完整 2xx
    // 正文已经拿到。旧顺序把 `state = 'done'` 留在 `runChat` 里（`commitReplay` 之后），
    // 于是本条在淘汰扫描里仍被读成 `in_flight`——被自己的淘汰条件挡在门外。真按
    // 「只加 state 过滤、顺序照旧」去改，本条永远不是候选：表一旦被在途条目占满，
    // `MAX_IDEMPOTENCY_ENTRIES` 就再也收不回来，预算上限静默失效。先结算再淘汰，
    // 「已结算且可释放」才是同一时刻成立的事实。
    entry.state = 'done';
    evictReplayOverflow();
  };

  const releaseOperation = (scope: string): void => {
    const entry = operations.get(scope);
    if (entry === undefined) return;
    replayBytes -= entry.bytes;
    operations.delete(scope);
  };

  /* ------------------------------------------------------------------ */
  /* 请求入口与生命周期                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * 解码失败时 `urlPath` 停留的**占位标签**。
   *
   * 它**不是**一个合法路径，只用来让下面 catch / finally 两条日志在解码失败时
   * 仍有话可说。之所以不给原始路径占位：这条路径是**完全不受信任**的请求字节，
   * 把它原样写进日志正是「为『好排查』把路径/字段/参数原样写出」。
   */
  const UNDECODABLE_PATH_LABEL = '<invalid-percent-encoding>';

  /**
   * 请求路径的百分号解码。**解码失败必须是一次普通的拒绝，不是一次进程退出。**
   *
   * F01（未持 key 即可终止 API）：这段解码原来在请求 `try` **之外**、且在
   * Host / Origin / Bearer 三道门**之前**，`/%`、`/%ZZ` 让 `decodeURIComponent`
   * 抛 `URIError`；异常沿 `parserOnIncoming` 逃逸成 uncaught，API 进程带
   * `exit.code=1` 退出，而攻击者连一把 key 都不需要。
   *
   * 三条边界都在这里守住：
   *  1. **不把解码后移到认证门之后**——那样会改变现有 401/403 语义，是另一个
   *     入口的修法。解码仍留在原来的位置（门之前），只是失败不再外泄。
   *  2. **不装全局兜底**——没有 `uncaughtException`、没有 try/catch 吞异常，
   *     失败就地变成一条 400 响应。
   *  3. **不新增 errors.ts 的 code**——复用既有 `invalid_request`
   *     （`API_ERROR_SPECS` 里就是 400 / `contract_violation` / `not_submitted`）。
   */
  const decodeRequestPath = (rawPath: string): string => {
    try {
      return decodeURIComponent(rawPath);
    } catch {
      // 错误体与日志都不回显原始路径：只给一个固定的「编码不合法」结论。
      throw new ApiError('invalid_request', '请求路径不是合法的百分号编码', { path_encoding: 'invalid' });
    }
  };

  const requestListener: http.RequestListener = (req, res) => {
    inFlight += 1;
    const startedAt = now();
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      inFlight -= 1;
    };
    res.on('finish', settle);
    res.on('close', settle);

    // 只切掉查询串：`?q=%` 里的 `%` 从来不参与解码（split('?')[0]），这条既有行为不变。
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    // 解码失败时 `urlPath` 停在占位标签上，于是 catch / finally 两条日志都不会
    // 把这条不受信任的原始路径原样写出。
    let urlPath = UNDECODABLE_PATH_LABEL;
    void (async () => {
      try {
        // 仍在原来的位置：Host / Origin / Bearer 门之前。位置不动，语义就不变。
        urlPath = decodeRequestPath(rawPath);
        if (req.method === 'OPTIONS') {
          // CORS 关闭：预检一律 405，且不写任何 access-control-* 头。
          throw new ApiError('method_not_allowed', '本机 API 不开启 CORS，不处理预检请求', { cors: 'disabled' }, 'method');
        }
        if (!passNetworkGates(req, res)) return;
        if (urlPath === '/v1/models') {
          handleModels(req, res);
          return;
        }
        if (urlPath === CATALOG_PATH) {
          handleCatalog(req, res);
          return;
        }
        if (urlPath === READ_STATUS_PATH) {
          handleReadStatus(req, res);
          return;
        }
        if (urlPath === '/v1/chat/completions') {
          await handleChat(req, res);
          return;
        }
        throw new ApiError(
          'not_found',
          `未知路径 ${urlPath}：本机 API 只提供 /v1/models、${CATALOG_PATH}、${READ_STATUS_PATH} 与 /v1/chat/completions`,
          { path: urlPath }
        );
      } catch (e) {
        const err = toApiError(e);
        if (res.headersSent || res.writableEnded) {
          res.destroy();
        } else {
          sendError(res, err);
          logger.warn(`event=rejected path=${urlPath} code=${err.code} status=${err.status}`);
        }
      } finally {
        logger.info(
          `event=request path=${urlPath} method=${req.method ?? ''} status=${res.statusCode} ms=${now() - startedAt} in_flight=${inFlight}`
        );
      }
    })();
  };

  const destroySockets = (): void => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };

  const start = async (): Promise<ApiStartResult> => {
    if (!enabled) {
      logger.info('event=not_started reason=disabled_by_default');
      return { started: false, reason: 'disabled_by_default' };
    }
    if (apiKeys.length === 0) {
      // 没有 key 的本机 API 等于无认证的模型入口：宁可不启动。
      throw new Error('NO_API_KEY: 本机 API 必须在配置了至少一个 API key 的前提下才能开启');
    }
    const created = http.createServer(requestListener);
    created.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    created.on('clientError', (_err, socket) => {
      // 畸形 HTTP 直接断开，不产生业务响应，也不把 socket 留在池里。
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => reject(e);
      created.once('error', onError);
      created.listen(requestedPort, HOST_LOOPBACK, () => {
        created.off('error', onError);
        resolve();
      });
    });
    server = created;
    boundPort = (created.address() as AddressInfo).port;

    const onSignal = (): void => {
      void stop();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    removeSignalHandlers = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      signalListeners = 0;
    };
    signalListeners = 2;

    logger.info(`event=listening address=${HOST_LOOPBACK} port=${boundPort} driver=${driver.name} status=${driver.status}`);
    return { started: true, port: boundPort, address: HOST_LOOPBACK };
  };

  const stop = async (): Promise<{ closed: boolean; timedOut: boolean }> => {
    // 3a) 回收定时器与信号监听器（无论是否监听过，都幂等）。
    rateLimiter.close();
    if (removeSignalHandlers !== null) {
      removeSignalHandlers();
      removeSignalHandlers = null;
    }
    const target = server;
    server = null;
    if (target === null) {
      destroySockets();
      operations.clear();
      replayBytes = 0;
      return { closed: true, timedOut: false };
    }
    // 1) 停止接受新连接。
    const closedPromise = new Promise<void>((resolve) => {
      target.close(() => resolve());
    });
    target.closeIdleConnections();
    // 2) 在途请求有界收束。超时如实报 timedOut 并强拆，绝不用 process.exit 掩盖。
    const timedOut = !(await waitFor(() => inFlight === 0, shutdownGraceMs));
    // 3) 收束后**再收一次**空闲长连接：在途请求刚结束的那一刻连接才转入空闲，
    //    只在第 1 步收一次会让 close() 一直等到客户端的 keepAliveTimeout（实测 ~4s）。
    target.closeIdleConnections();
    if (timedOut) {
      logger.warn(`event=shutdown_timed_out grace_ms=${shutdownGraceMs} in_flight=${inFlight}`);
      target.closeAllConnections();
      destroySockets();
    }
    await closedPromise;
    destroySockets();
    operations.clear();
    replayBytes = 0;
    logger.info(`event=stopped timed_out=${String(timedOut)}`);
    return { closed: true, timedOut };
  };

  return {
    start,
    stop,
    address: () => {
      const addr = server?.address();
      if (addr === null || addr === undefined || typeof addr === 'string') return null;
      return { address: addr.address, port: addr.port };
    },
    requestListener,
    get diagnostics(): ApiDiagnostics {
      return {
        inFlight,
        trackedSockets: sockets.size,
        activeTimers: rateLimiter.activeTimers,
        signalListeners,
        idempotencyEntries: operations.size,
        driverCalls,
        status: driver.status,
        replayBytes
      };
    }
  };
}

/* -------------------------------------------------------------------------- */
/* 辅助                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 有界等待条件成立。`false` = 超时。**定时器在所有路径都被清掉**，
 * 不留悬挂句柄，也不靠 `process.exit` 收尾。
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (predicate()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return predicate();
    const step = Math.min(20, remaining);
    const timer = setTimeout(() => undefined, step);
    timer.unref();
    try {
      await new Promise<void>((resolve) => {
        const inner = setTimeout(resolve, step);
        inner.unref();
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 有界读体。`content-length` 预检在认证之前；这里兜住 chunked 的情况。
 *
 * 两条超限路径的收尾方式不同，都是为了不留悬挂读流：
 *  - **声明超限**：响应里带 `connection: close`，并在响应 flush 之后 `req.destroy()`。
 *    不这么做的话，服务端不再读、客户端还在写 1MiB+，TCP 缓冲写满后客户端会一直
 *    阻塞到服务端关闭（实测 4s 才拿到响应）。
 *  - **chunked 超限**：继续把流排空（丢弃而不缓冲），让连接保持可回收。
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<string>}
 */
async function readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > REQUEST_BODY_MAX_BYTES) {
    res.setHeader('connection', 'close');
    // 排空（丢弃而不缓冲），**不是** destroy：destroy 会让客户端在读到 413 之前
    // 先收到 RST，响应体就丢了。排空让客户端把 1MiB+ 写完、正常读到响应。
    // 排空量有上限，超过就强拆：拒绝一个超限请求不等于替它读完任意大的流。
    const drainCap = REQUEST_BODY_MAX_BYTES * 8;
    let drained = 0;
    const onDrain = (chunk: Buffer): void => {
      drained += chunk.length;
      if (drained > drainCap) req.destroy();
    };
    req.on('data', onDrain);
    req.once('end', () => req.off('data', onDrain));
    req.resume();
    throw new ApiError('payload_too_large', `请求体超过 ${REQUEST_BODY_MAX_BYTES} 字节上限`, {
      limit_bytes: REQUEST_BODY_MAX_BYTES
    });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    size += buf.length;
    if (size > REQUEST_BODY_MAX_BYTES) {
      exceeded = true;
      chunks.length = 0;
      continue; // 排空丢弃，绝不缓冲超限内容
    }
    if (!exceeded) chunks.push(buf);
  }
  if (exceeded) {
    throw new ApiError('payload_too_large', `请求体超过 ${REQUEST_BODY_MAX_BYTES} 字节上限`, {
      limit_bytes: REQUEST_BODY_MAX_BYTES,
      drained_bytes: size
    });
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `x-zcc-idempotency` 响应头的值域（工单 COMPAT1/C1 在 `original | replayed` 之外
 * 新增 `none`）。
 *
 * - `original`：这次是真跑了一次驱动器，响应是**首次**产出。
 * - `replayed`：命中已登记的幂等作用域，原样重放**上一次**的 2xx。
 * - `none`：**客户端没有显式 opt-in 幂等**（一个幂等头都没发），本次既不重放、
 *   也不可被将来的请求重放。值域闭合就这三种，不存在"看起来像 original 但其实
 *   是一次重放"的第四种。
 */
export const IDEMPOTENCY_RESPONSE_VALUES = ['original', 'replayed', 'none'] as const;
export type IdempotencyResponseValue = (typeof IDEMPOTENCY_RESPONSE_VALUES)[number];

/** `scope === null`（无显式 opt-in）就是 `none`，否则是 `original`。 */
function idempotencyLabel(scope: string | null): IdempotencyResponseValue {
  return scope === null ? 'none' : 'original';
}
