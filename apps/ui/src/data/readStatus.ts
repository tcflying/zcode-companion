/**
 * ZCC-GUI-EVIDENCE-20261008-A · UI 侧 readstatus 读取层。
 *
 * 与 `localApiSource.ts` 的 catalog 通道**完全平行**：同样的回环守卫、同样的
 * 同一超时预算覆盖「头 + 正文」、同样的 `redirect: 'error'`。
 *
 * 四条硬约束：
 *  1. **默认零网络。** 本模块只被 `useAppState` 在用户显式开启「连接本机 API」
 *     并**手动点刷新**后调用；没有自动轮询、没有预取、没有后台重试。
 *  2. **迟到即失效。** 切源 / 关开关 / 卸载之后在途的响应必须被丢弃，
 *     不能让旧事实冒充当前。
 *  3. **严格 parse。** 形状不合契约 → 整体 `malformed_payload`，不做部分采纳。
 *  4. **本层不定级。** `e1Blocking` / `usageWarnings` 只是具名清单；
 *     界面据此显示"还差什么"，**不允许**据此把等级升到 E1。
 */

/** 服务端固定枚举。非法值一律 unknown，绝不透传自由文本。 */
export const READ_STATUS_DRIVER_KINDS = ['none', 'local-official', 'official-host'] as const;
export type ReadStatusDriverKind = (typeof READ_STATUS_DRIVER_KINDS)[number];

export const READ_STATUS_DRIVER_STATUSES = ['ready', 'not_attached', 'unavailable'] as const;
export type ReadStatusDriverStatus = (typeof READ_STATUS_DRIVER_STATUSES)[number];

export const READ_STATUS_SOURCE_KINDS = ['local-official-files', 'unknown'] as const;
export type ReadStatusSourceKind = (typeof READ_STATUS_SOURCE_KINDS)[number];

/** 挡住 E1 的具名缺口（闭集）。服务端已保证闭集，这里再做一次防御。 */
export const READ_STATUS_E1_BLOCKING_GAPS = [
  'driver_not_attached', 'evidence_not_captured', 'catalog_absent',
  'entitlement_absent', 'selection_absent', 'driver_catalog_mismatch',
  'evidence_field_invalid', 'timestamp_invalid', 'account_unproven',
  'entitlement_staleness_unproven', 'selection_unproven', 'billing_class_mapping_unproven'
] as const;
export type ReadStatusE1BlockingGap = (typeof READ_STATUS_E1_BLOCKING_GAPS)[number];

/** 只影响 E3 的观测提示（闭集）。**不得**当作 E1 硬门。 */
export const READ_STATUS_USAGE_WARNINGS = [
  'authoritative_bucket_unobserved', 'consumption_unobserved'
] as const;
export type ReadStatusUsageWarning = (typeof READ_STATUS_USAGE_WARNINGS)[number];

export interface ReadStatusSnapshot {
  readonly schema: 'zcc-read-status';
  readonly version: 1;
  readonly driver: {
    readonly kind: ReadStatusDriverKind;
    readonly status: ReadStatusDriverStatus;
    readonly catalogCount: number | null;
    readonly servableCount: number | null;
  };
  readonly catalog: {
    readonly sourceKind: ReadStatusSourceKind;
    readonly revision: string | null;
    readonly entryCount: number | null;
    readonly schemaVersion: number | null;
    readonly documentRevision: number | null;
    readonly readAt: number | null;
  };
  readonly entitlement: {
    readonly present: boolean;
    readonly updatedAt: number | null;
    readonly availableCount: number;
    readonly unavailableCount: number;
    readonly unknownCount: number;
    readonly itemCount: number;
  } | null;
  readonly selection: {
    readonly present: boolean;
    readonly updatedAt: number | null;
    readonly selectedCount: number;
  } | null;
  readonly e1Blocking: readonly ReadStatusE1BlockingGap[];
  readonly usageWarnings: readonly ReadStatusUsageWarning[];
  readonly validityWindowKnown: false;
  readonly gradedByServer: false;
}

export const READ_STATUS_PATH = '/v1/zcc/readstatus';

/** 默认与 catalog 通道一致：同源。 */
export const DEFAULT_READ_STATUS_BASE_URL = '';

function isCountOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Number.isInteger(v) ? v : null;
}
function inClosedSet<T extends string>(v: unknown, set: readonly T[]): T | null {
  return typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T) : null;
}

/**
 * 严格解析。**任何一处形状不符 → 整体 null**（不做部分采纳）。
 * 服务端已做严格投影；UI 这层是**第二道防线**，防止中间代理或版本漂移把脏数据放进来。
 */
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  return Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key)) ? object : null;
}
function timestampValid(value: unknown, now: number): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now);
}
function countValid(value: unknown): boolean { return value === null || isCountOrNull(value) !== null; }

/** Exact DTO only; historical read time never establishes current qualification. */
export function parseReadStatus(raw: unknown, now: number = Date.now()): ReadStatusSnapshot | null {
  if (!Number.isFinite(now) || now <= 0) return null;
  const r = exactObject(raw, ['schema', 'version', 'driver', 'catalog', 'entitlement', 'selection', 'e1Blocking', 'usageWarnings', 'validityWindowKnown', 'gradedByServer']);
  if (!r || r['schema'] !== 'zcc-read-status' || r['version'] !== 1 || r['validityWindowKnown'] !== false || r['gradedByServer'] !== false) return null;
  const dr = exactObject(r['driver'], ['kind', 'status', 'catalogCount', 'servableCount']);
  const cr = exactObject(r['catalog'], ['sourceKind', 'revision', 'entryCount', 'schemaVersion', 'documentRevision', 'readAt']);
  if (!dr || !cr) return null;
  const kind = inClosedSet(dr['kind'], READ_STATUS_DRIVER_KINDS);
  const status = inClosedSet(dr['status'], READ_STATUS_DRIVER_STATUSES);
  const sourceKind = inClosedSet(cr['sourceKind'], READ_STATUS_SOURCE_KINDS);
  if (kind === null || status === null || sourceKind === null) return null;
  if (!['catalogCount', 'servableCount'].every((key) => countValid(dr[key])) || !['entryCount', 'schemaVersion', 'documentRevision'].every((key) => countValid(cr[key]))) return null;
  if (!(cr['revision'] === null || (typeof cr['revision'] === 'string' && cr['revision'].trim() !== '')) || !timestampValid(cr['readAt'], now)) return null;
  const catalogCount = isCountOrNull(dr['catalogCount']);
  const servableCount = isCountOrNull(dr['servableCount']);
  const entryCount = isCountOrNull(cr['entryCount']);
  if (servableCount !== null && catalogCount !== null && servableCount > catalogCount) return null;

  let entitlement: ReadStatusSnapshot['entitlement'] = null;
  if (r['entitlement'] !== null) {
    const er = exactObject(r['entitlement'], ['present', 'updatedAt', 'availableCount', 'unavailableCount', 'unknownCount', 'itemCount']);
    if (!er || typeof er['present'] !== 'boolean' || !timestampValid(er['updatedAt'], now)) return null;
    const availableCount = isCountOrNull(er['availableCount']);
    const unavailableCount = isCountOrNull(er['unavailableCount']);
    const unknownCount = isCountOrNull(er['unknownCount']);
    const itemCount = isCountOrNull(er['itemCount']);
    if (availableCount === null || unavailableCount === null || unknownCount === null || itemCount === null || availableCount + unavailableCount + unknownCount !== itemCount) return null;
    if (er['present'] !== (itemCount > 0)) return null;
    entitlement = { present: er['present'], updatedAt: er['updatedAt'] as number | null, availableCount, unavailableCount, unknownCount, itemCount };
  }
  let selection: ReadStatusSnapshot['selection'] = null;
  if (r['selection'] !== null) {
    const sr = exactObject(r['selection'], ['present', 'updatedAt', 'selectedCount']);
    if (!sr || typeof sr['present'] !== 'boolean' || !timestampValid(sr['updatedAt'], now)) return null;
    const selectedCount = isCountOrNull(sr['selectedCount']);
    if (selectedCount === null || sr['present'] !== (selectedCount > 0)) return null;
    selection = { present: sr['present'], updatedAt: sr['updatedAt'] as number | null, selectedCount };
  }
  const gb = r['e1Blocking']; const gw = r['usageWarnings'];
  if (!Array.isArray(gb) || !Array.isArray(gw) || new Set(gb).size !== gb.length || new Set(gw).size !== gw.length) return null;
  if (!gb.every((g) => inClosedSet(g, READ_STATUS_E1_BLOCKING_GAPS) !== null) || !gw.every((g) => inClosedSet(g, READ_STATUS_USAGE_WARNINGS) !== null)) return null;
  const blocking = new Set<string>(gb as string[]);
  // These are invariants of this historical DTO, not an entitlement adjudication.
  if (!['account_unproven', 'entitlement_staleness_unproven', 'selection_unproven', 'billing_class_mapping_unproven'].every((gap) => blocking.has(gap))) return null;
  if ((kind === 'none' || catalogCount === null) && !blocking.has('driver_not_attached')) return null;
  if ((cr['revision'] === null || entryCount === null) && !blocking.has('catalog_absent')) return null;
  if ((entitlement === null || !entitlement.present) && !blocking.has('entitlement_absent')) return null;
  if (entitlement?.present && blocking.has('entitlement_absent')) return null;
  if ((selection === null || !selection.present) && !blocking.has('selection_absent')) return null;
  if (selection?.present && blocking.has('selection_absent')) return null;
  if (catalogCount !== null && entryCount !== null && catalogCount !== entryCount && !blocking.has('driver_catalog_mismatch')) return null;
  if (sourceKind === 'unknown') {
    if (['revision', 'entryCount', 'schemaVersion', 'documentRevision', 'readAt'].some((key) => cr[key] !== null) || entitlement !== null || selection !== null || !blocking.has('evidence_not_captured')) return null;
  } else if (blocking.has('evidence_not_captured')) return null;
  return {
    schema: 'zcc-read-status', version: 1,
    driver: { kind, status, catalogCount, servableCount },
    catalog: { sourceKind, revision: cr['revision'] as string | null, entryCount, schemaVersion: isCountOrNull(cr['schemaVersion']), documentRevision: isCountOrNull(cr['documentRevision']), readAt: cr['readAt'] as number | null },
    entitlement, selection,
    e1Blocking: gb as ReadStatusE1BlockingGap[], usageWarnings: gw as ReadStatusUsageWarning[],
    validityWindowKnown: false, gradedByServer: false
  };
}

/** UI 读取四态。与 catalog 刷新语义一致，但**更保守**：失败即 unknown，不保留旧事实。 */
export type ReadStatusPhase = 'idle' | 'loading' | 'loaded' | 'failed' | 'disabled';

export interface ReadStatusState {
  readonly phase: ReadStatusPhase;
  readonly snapshot: ReadStatusSnapshot | null;
  readonly failure: { readonly code: string; readonly message: string; readonly at: number } | null;
  /** 本次成功读回的时刻（本地）。null = 从未成功读过。 */
  readonly loadedAt: number | null;
}

/** 读取四态的中文标签。界面各处共用一份，避免两套说法。 */
export const READ_PHASE_LABEL: Record<ReadStatusPhase, string> = {
  idle: '未读取（零网络）',
  loading: '读取中',
  loaded: '历史证据状态已读回',
  failed: '读取失败',
  disabled: '未开启连接本机 API'
};

export const INITIAL_READ_STATUS_STATE: ReadStatusState = {
  phase: 'idle',
  snapshot: null,
  failure: null,
  loadedAt: null
};

/**
 * 缺口语义：界面据此说明"为什么还不是 E1"。
 * **本函数不产生等级**，它只是把服务端给的具名清单转成可读缺口。
 */
export function describeBlockingGaps(snapshot: ReadStatusSnapshot | null): string[] {
  if (snapshot === null) return ['尚未读到证据状态'];
  return snapshot.e1Blocking.map((g) => GAP_LABEL[g] ?? g);
}

export const GAP_LABEL: Record<ReadStatusE1BlockingGap, string> = {
  driver_not_attached: '运行驱动器未挂载',
  evidence_not_captured: '未捕获到任何资格证据',
  catalog_absent: '模型目录证据缺失',
  entitlement_absent: '套餐资格证据缺失',
  selection_absent: '实际选模证据缺失',
  driver_catalog_mismatch: '驱动器目录与证据目录不一致',
  evidence_field_invalid: '证据字段形状不合法',
  timestamp_invalid: '证据时间戳不可信',
  account_unproven: '账号登录未证明',
  entitlement_staleness_unproven: '资格时效未证明',
  selection_unproven: '实际选模未证明',
  billing_class_mapping_unproven: '计费类别映射未证明'
};

export const USAGE_WARNING_LABEL: Record<ReadStatusUsageWarning, string> = {
  authoritative_bucket_unobserved: '权威桶读数未观测（影响 E3，不阻塞 E1）',
  consumption_unobserved: '消费记录未观测（影响 E3，不阻塞 E1）'
};