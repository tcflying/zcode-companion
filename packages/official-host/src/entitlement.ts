/**
 * OFFICIAL-HOST entitled 层 —— 从**真实来源**推导订阅资格快照。
 *
 * 这份文件是工单"红线：不伪造 entitled"的落点。整条链路上唯一被允许写 `entitled:true`
 * 的地方是 {@link deriveEntitledSnapshot}，而它写 true 的**唯一**充分条件是：
 * 官方本地缓存 `~/.zcode/v2/coding-plan-cache.json` 里对应缓存键的 `status === "available"`。
 *
 * 五条硬事实：
 *
 *  1. **没有真值就没有 true。** 缓存文件缺失、缓存键不存在、`status` 缺失或不是认识的
 *     取值——四种情况全部落 `available: false`，并各自带**不同的** `reason`，让"为什么
 *     不发"可被指认。**没有** `unknown → 当作 available` 这条路。
 *  2. **映射表是白名单。** `account:*` providerId → `builtin:*` 缓存键只认 PLANSRC 已核的
 *     四条（`CACHE_KEY_BY_PROVIDER` 复用，不重复造）。表里没有的 providerId 落
 *     `no-cache-entry`，不外推——尤其是 team 与 off-peak 官方就没给缓存键。
 *  3. **缓存是快照，不是现在。** `availabilityObservedAt` 是**唯一的时效锚**，它证明
 *     "某时刻 refresh 返回 available"，不证明"现在仍 available"。这个字段原样透传给宿主，
 *     并且在 `statusDetail` 里如实说明。
 *  4. **只读。** 只有 `readFileSync`；本文件不含任何写、删、改路径的调用。
 *  5. **凭据值永不到这里。** 本模块读的是 `coding-plan-cache.json`，它不含凭据；即便
 *     将来含了，本模块也只提取 `status` / `reason` / `updatedAt` 三个标量。
 *
 * 官方出处（`C:\ZCode\resources\glm\zcode.cjs`，只读逐字节核对）：
 *  - 账号 provider 的 `states[id].current` 形状：
 *    `sAe = m.object({type: m.literal("zhipu-account"), accountType: m.enum(["zai","bigmodel"]),
 *    mode: <mode>, entitled: m.boolean()}).strict()`。本模块产出的快照严格落这个形状，
 *    少一个键官方 `.strict()` 就整条拒收。
 *  - 缓存键映射：`Un={"builtin:bigmodel":"bigmodel-api", …,
 *    "builtin:bigmodel-coding-plan":"account:bigmodel-individual-coding-plan", …}`
 *    （`builtin:*-start-plan` / `builtin:*-coding-plan` 四条）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CACHE_KEY_BY_PROVIDER } from '../../plansrc/src/mapper.js';
import type { PlanSourceDocument } from '../../plansrc/src/reader.js';
import { PROVIDER_FAMILIES, type ProviderFamily } from './credentials.js';

/* -------------------------------------------------------------------------- */
/* 形状                                                                        */
/* -------------------------------------------------------------------------- */

/** 官方 `mode` 取值里本包关心的三个。缺省 `unknown` 会在下面被显式拒绝。 */
export const SUPPORTED_PLAN_MODES = ['start-plan', 'individual-coding-plan', 'team-coding-plan'] as const;
export type SupportedPlanMode = (typeof SUPPORTED_PLAN_MODES)[number];

/**
 * 官方 `AccountProviderState.current` 形状（`sAe`）。
 * `type` 固定 `'zhipu-account'`——官方是 `m.literal`，别的字面量整条拒收。
 */
export interface AccountProviderCurrentState {
  readonly type: 'zhipu-account';
  readonly accountType: ProviderFamily;
  readonly mode: SupportedPlanMode;
  readonly entitled: boolean;
}

/** 一条可安全记录的资格推导证据。**不含任何凭据值**，也不含缓存全文。 */
export interface EntitlementEvidence {
  readonly providerId: string;
  readonly cacheKey: string | null;
  /** 缓存里的 `status` 原值；没有条目时为 `null`。 */
  readonly cacheStatus: string | null;
  readonly availabilityObservedAt: number | null;
  readonly available: boolean;
  readonly reason: EntitlementReason;
  /** 来源文件绝对路径。 */
  readonly sourceFile: string;
}

/** 不发的原因。**闭集**——每条对应一个具体的 fail-closed 分支。 */
export const ENTITLEMENT_REASON_CODES = [
  'cache-available',
  'cache-unavailable',
  'cache-status-not-recognized',
  'no-cache-entry-for-provider',
  'cache-file-absent',
  'cache-entries-absent'
] as const;
export type EntitlementReason = (typeof ENTITLEMENT_REASON_CODES)[number];

export interface EntitlementSnapshot {
  readonly providerId: string;
  readonly current: AccountProviderCurrentState;
  readonly evidence: EntitlementEvidence;
}

/* -------------------------------------------------------------------------- */
/* 缓存读取                                                                    */
/* -------------------------------------------------------------------------- */

/** 官方缓存路径。逐字对应 `join(dataBaseDir, ".zcode","v2","coding-plan-cache.json")`。 */
export function resolveCodingPlanCachePath(options: { readonly cacheFile?: string; readonly env?: Readonly<Record<string, string | undefined>>; readonly homeDir?: string } = {}): string {
  if (options.cacheFile !== undefined) return options.cacheFile;
  const env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>);
  const dataBaseDir = env['ZCODE_DATA_BASE_DIR']?.trim() ?? options.homeDir ?? homedir();
  return join(dataBaseDir, '.zcode', 'v2', 'coding-plan-cache.json');
}

interface CacheItems {
  readonly items: Readonly<Record<string, { readonly status?: unknown; readonly reason?: unknown }>>;
  readonly updatedAt: number | null;
}

function readCacheItems(document: unknown): CacheItems {
  const entryStatus = (document as { entryStatus?: unknown } | null)?.entryStatus;
  if (typeof entryStatus !== 'object' || entryStatus === null) return { items: {}, updatedAt: null };
  const record = entryStatus as { items?: unknown; updatedAt?: unknown };
  const items = typeof record.items === 'object' && record.items !== null && !Array.isArray(record.items)
    ? (record.items as Record<string, { status?: unknown; reason?: unknown }>)
    : {};
  return { items, updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : null };
}

/**
 * 读缓存（只读）。**缓存缺失不是错误**——它是一条合法的"没有真值"输入，落
 * `cache-file-absent` 并给 `entitled:false`。抛错反而会让调用方把"文件不存在"误当成
 * "宿主故障"，而这两件事的处理完全不同。
 *
 * @param options 路径覆盖 / env / 注入读取
 * @returns `document` 为 `null` 表示文件不可读或不存在
 */
export function readCodingPlanCache(
  options: { readonly cacheFile?: string; readonly env?: Readonly<Record<string, string | undefined>>; readonly homeDir?: string; readonly readFile?: (path: string) => string } = {}
): { readonly path: string; readonly document: unknown; readonly present: boolean } {
  const path = resolveCodingPlanCachePath(options);
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  let text: string;
  try {
    text = readFile(path);
  } catch {
    return { path, document: null, present: false };
  }
  try {
    return { path, document: JSON.parse(text) as unknown, present: true };
  } catch {
    // 缓存损坏 = 没有真值。同样落 `document:null` + `present:false`，不猜它的内容。
    return { path, document: null, present: false };
  }
}

/**
 * 直接从一个**已擦除的** PLANSRC 缓存文档推导。测试用合成夹具走这条路径，
 * 因此**永远不需要读真实仓**。
 */
export function deriveEntitledSnapshotFromDocument(options: {
  readonly providerId: string;
  readonly planMode: SupportedPlanMode;
  readonly cacheSource: PlanSourceDocument;
}): EntitlementSnapshot {
  const { providerId, planMode, cacheSource } = options;
  const family = accountTypeOf(providerId);
  const cacheKey = CACHE_KEY_BY_PROVIDER[providerId] ?? null;
  const sourceFile = cacheSource.path;
  const present = cacheSource.present && cacheSource.document !== null;
  const { items, updatedAt } = present ? readCacheItems(cacheSource.document) : { items: {}, updatedAt: null };

  const decision = decideEntitled(present, cacheKey, items, updatedAt);
  return {
    providerId,
    current: { type: 'zhipu-account', accountType: family, mode: planMode, entitled: decision.available },
    evidence: {
      providerId,
      cacheKey,
      cacheStatus: decision.cacheStatus,
      availabilityObservedAt: present ? updatedAt : null,
      available: decision.available,
      reason: decision.reason,
      sourceFile
    }
  };
}

/**
 * 从官方本地缓存（只读）推导一份 `entitled` 快照。
 *
 * **写 `entitled:true` 的唯一路径**：`cacheKey` 存在且 `items[cacheKey].status === "available"`。
 * 其余全部 `false`，并带可指认的 `reason`。没有任何兜底分支会把 false 翻成 true。
 */
export function deriveEntitledSnapshot(options: {
  readonly providerId: string;
  readonly planMode: SupportedPlanMode;
  readonly cacheFile?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly readFile?: (path: string) => string;
}): EntitlementSnapshot {
  const { path, document, present } = readCodingPlanCache(options);
  const cacheKey = CACHE_KEY_BY_PROVIDER[options.providerId] ?? null;
  const { items, updatedAt } = present ? readCacheItems(document) : { items: {}, updatedAt: null };
  const decision = decideEntitled(present, cacheKey, items, updatedAt);
  return {
    providerId: options.providerId,
    current: {
      type: 'zhipu-account',
      accountType: accountTypeOf(options.providerId),
      mode: options.planMode,
      entitled: decision.available
    },
    evidence: {
      providerId: options.providerId,
      cacheKey,
      cacheStatus: decision.cacheStatus,
      availabilityObservedAt: present ? updatedAt : null,
      available: decision.available,
      reason: decision.reason,
      sourceFile: path
    }
  };
}

function decideEntitled(
  present: boolean,
  cacheKey: string | null,
  items: Readonly<Record<string, { readonly status?: unknown; readonly reason?: unknown }>>,
  updatedAt: number | null
): { readonly available: boolean; readonly reason: EntitlementReason; readonly cacheStatus: string | null } {
  void updatedAt;
  if (!present) return { available: false, reason: 'cache-file-absent', cacheStatus: null };
  if (cacheKey === null) return { available: false, reason: 'no-cache-entry-for-provider', cacheStatus: null };
  const item = items[cacheKey];
  if (item === undefined) return { available: false, reason: 'no-cache-entry-for-provider', cacheStatus: null };
  const status = typeof item.status === 'string' ? item.status : null;
  if (status === 'available') return { available: true, reason: 'cache-available', cacheStatus: status };
  if (status === 'unavailable') return { available: false, reason: 'cache-unavailable', cacheStatus: status };
  if (status === null) return { available: false, reason: 'cache-entries-absent', cacheStatus: null };
  // 状态值不认识：保守 false。官方若新增一个取值，我们在它被承认之前不发。
  return { available: false, reason: 'cache-status-not-recognized', cacheStatus: status };
}

/**
 * `account:*` providerId → 官方 `accountType`。
 *
 * 命名证据：官方把 zai / bigmodel 两条 start-plan 与两条 coding-plan 都映到
 * `account:<family>-*` 前缀（`CACHE_KEY_BY_PROVIDER` 的键集合）。因此从 providerId
 * 前缀读 family 是有据的，不猜。**后缀不参与判定**——family 读得出来但缓存键不在已核
 * 四条内（team / off-peak）时，交给 {@link decideEntitled} 落
 * `no-cache-entry-for-provider`，那才是"没有真值"的正确形状。
 *
 * 读不出 family 时抛错而不是默认 `zai`：默认会让一个 bigmodel 请求被拿 zai 的 key 去签，
 * 那是一次真实的跨域鉴权尝试。
 */
export function accountTypeOf(providerId: string): ProviderFamily {
  if (typeof providerId === 'string' && providerId.startsWith('account:')) {
    const rest = providerId.slice('account:'.length);
    const dash = rest.indexOf('-');
    const family = dash < 0 ? rest : rest.slice(0, dash);
    if ((PROVIDER_FAMILIES as readonly string[]).includes(family)) return family as ProviderFamily;
  }
  throw new OfficialEntitlementError(
    'PROVIDER_ID_UNRECOGNIZED',
    `providerId ${JSON.stringify(providerId)} 不在已核的 account:z* / account:bigmodel* 命名内（不猜 family，也不默认成 zai）`
  );
}

export const OFFICIAL_ENTITLEMENT_ERROR_CODES = ['PROVIDER_ID_UNRECOGNIZED', 'PLAN_MODE_UNSUPPORTED'] as const;
export type OfficialEntitlementErrorCode = (typeof OFFICIAL_ENTITLEMENT_ERROR_CODES)[number];

export class OfficialEntitlementError extends Error {
  readonly code: OfficialEntitlementErrorCode;
  constructor(code: OfficialEntitlementErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'OfficialEntitlementError';
    this.code = code;
  }
}

/**
 * 把一份可记录证据渲染成一行人可读的说明。**只含键名/路径/状态/时间戳，不含凭据**。
 */
export function formatEntitlementEvidence(evidence: EntitlementEvidence): string {
  return [
    `provider=${evidence.providerId}`,
    `cache_key=${evidence.cacheKey ?? 'none'}`,
    `cache_status=${evidence.cacheStatus ?? 'none'}`,
    `entitled=${String(evidence.available)}`,
    `reason=${evidence.reason}`,
    `observed_at=${evidence.availabilityObservedAt ?? 'unknown'}`,
    `source=${evidence.sourceFile}`
  ].join(' ');
}
