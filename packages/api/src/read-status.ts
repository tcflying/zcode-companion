/**
 * `/v1/zcc/readstatus` 的**只读公开 DTO**。
 *
 * 这个模块的唯一职责：把 PLANSRC 已经在内存里算好的 E1 证据，投影成一份
 * **可公开、无秘密、可长期缓存**的最小事实集。**它不做任何 I/O** ——
 * 不读文件、不读数据库、不读凭据、不发起网络请求。
 *
 * ## 为什么不能"直接把 evidence 吐出去"
 *
 * `E1Evidence`（packages/plansrc/src/mapper.ts:609-635）里含这些**不可外泄**字段：
 *   - `catalog.path` / `entitlement.path` / `selection.path` —— 用户家目录结构
 *   - `*.sha256` / `*.bytes` —— 源文件指纹（指纹配合路径即可做存在性推断）
 *   - `entitlement.items[].cacheKey` —— **含账号/域标识**
 *   - `entitlement.items[].reason` —— 上游自由文本，可能含账号、域名、原始报文片段
 *   - `selection.providerFamilyDomain` / `selections[].domain` —— **域标识本身**
 *   - `credentialLocations` —— 凭据位置的 JSONPath（虽不含值，但泄露结构即风险）
 *
 * 本模块把这些**全部投影掉**，只留下"是否成立 / 有多少 / 何时读的"这类事实。
 *
 * ## 定级不在这里做
 *
 * mapper 明确写了"本包不定级"。本模块同样**不产出 E0–E3**：
 * 它只把 `gaps` 列出来（缺什么），由界面显示"为什么还不够 E1"。
 * 即使三份证据齐全，`gaps` 也不会因此为空——E1 规范由 I06 定义。
 */

/** 驱动器种类。闭集，绝不透传上游任意字符串。 */
export type ReadStatusDriverKind = 'none' | 'local-official' | 'official-host';

export const READ_STATUS_DRIVER_KINDS: readonly ReadStatusDriverKind[] = [
  'none',
  'local-official',
  'official-host'
];

/**
 * 具名缺口。闭集，不透传上游 reason 自由文本。
 *
 * 分两层（929:258 明确「有资格但缺权威桶」仍可 E1/E2）：
 *  - `E1_BLOCKING`：挡住 E1 的**资格类**缺口。账号握手、资格时效、实际选模未证。
 *  - `USAGE_WARNING`：只影响 E3（消费/活动已观测），**不得**拿来卡 E1。
 */
export type ReadStatusE1BlockingGap =
  | 'driver_not_attached'
  | 'evidence_not_captured'
  | 'catalog_absent'
  | 'entitlement_absent'
  | 'selection_absent'
  | 'driver_catalog_mismatch'
  | 'evidence_field_invalid'
  | 'timestamp_invalid'
  | 'account_unproven'
  | 'entitlement_staleness_unproven'
  | 'selection_unproven'
  | 'billing_class_mapping_unproven';

export type ReadStatusUsageWarning =
  | 'authoritative_bucket_unobserved'
  | 'consumption_unobserved';

export const READ_STATUS_E1_BLOCKING_GAPS: readonly ReadStatusE1BlockingGap[] = [
  'driver_not_attached',
  'evidence_not_captured',
  'catalog_absent',
  'entitlement_absent',
  'selection_absent',
  'driver_catalog_mismatch',
  'evidence_field_invalid',
  'timestamp_invalid',
  'account_unproven',
  'entitlement_staleness_unproven',
  'selection_unproven',
  'billing_class_mapping_unproven'
];

export const READ_STATUS_USAGE_WARNINGS: readonly ReadStatusUsageWarning[] = [
  'authoritative_bucket_unobserved',
  'consumption_unobserved'
];

/**
 * 数据**来源**种类。闭集。
 *
 * 两条 driver 分支（`local-official` 与 `official-host`）都由 PLANSRC 的
 * `readPlanSources` 读**本机官方本地文件**，因此来源都是同一个值。
 * 这与 {@link ReadStatusDriverKind}（运行时用哪个驱动器）是**两层不同的事**，
 * 界面必须分开标注，不能把来源当驱动器。
 */
export type ReadStatusSourceKind = 'local-official-files';

export interface ReadStatusCatalog {
  /** 来源种类：闭集枚举，**不含任何路径**。 */
  readonly sourceKind: ReadStatusSourceKind | 'unknown';
  /** 目录 revision（来自 catalog 映射，非文件指纹）。缺/非法时为 null。 */
  readonly revision: string | null;
  /** 目录条目数。无法确定时为 null——**不默认 0**。 */
  readonly entryCount: number | null;
  /** 源文档 schema 版本；null = 未读到或不合法。 */
  readonly schemaVersion: number | null;
  /** 源文档 revision；null = 未读到或不合法。 */
  readonly documentRevision: number | null;
  /**
   * 源被**读取**的时刻（ms）。它只表示"这是一次历史读取的结果"，
   * **不表示此刻仍然有效**——因此 `validityWindowKnown` 恒为 false。
   */
  readonly readAt: number | null;
}

export interface ReadStatusEntitlement {
  readonly present: boolean;
  /** 源声明的更新时刻（ms）；源未声明或非法时为 null。 */
  readonly updatedAt: number | null;
  /** 按上游 status 归入三类的计数（不区分具体账号）。 */
  readonly availableCount: number;
  readonly unavailableCount: number;
  readonly unknownCount: number;
  /** 条目总数。与 available+unavailable+unknown 应相等；不等即为契约违例。 */
  readonly itemCount: number;
}

export interface ReadStatusSelection {
  readonly present: boolean;
  /** 选模记录更新时间（ms）；null = 未读到。 */
  readonly updatedAt: number | null;
  /** 有明确 kind 的选模条目数（不含域内容）。 */
  readonly selectedCount: number;
}

export interface ReadStatusPayload {
  readonly schema: 'zcc-read-status';
  readonly version: 1;
  readonly driver: {
    readonly kind: ReadStatusDriverKind;
    /**
     * 固定枚举，取自 `chat.ts` 既有 DriverStatus。**不透传 statusDetail 自由文本** ——
     * 那是内部诊断串，可能含路径、bundle 信息与子宿主细节。
     */
    readonly status: 'ready' | 'not_attached' | 'unavailable';
    /**
     * **运行驱动器的目录条目数**（`driver.catalog.models.length`），与
     * `catalog.entryCount`（E1 evidence 的 catalogEntryCount）同层可比。
     * 注意这不是 servable 子集数。
     */
    readonly catalogCount: number | null;
    /** 可服务子集；按定义 ≤ catalogCount。 */
    readonly servableCount: number | null;
  };
  readonly catalog: ReadStatusCatalog;
  readonly entitlement: ReadStatusEntitlement | null;
  readonly selection: ReadStatusSelection | null;
  /** 挡住 E1 的资格类缺口。空数组**不代表**已够 E1（见 constantBlocking 说明）。 */
  readonly e1Blocking: readonly ReadStatusE1BlockingGap[];
  /** 只影响 E3 的观测类提示。**不得**用来卡 E1。 */
  readonly usageWarnings: readonly ReadStatusUsageWarning[];
  /**
   * 恒为 false：只有 `readAt`/`updatedAt`（过去某刻），**没有 expires**。
   * 因此本端点从不声称这些事实此刻仍然有效。
   */
  readonly validityWindowKnown: false;
  /** 明确声明：本端点不定级。等级由 I06 规范与界面决定。 */
  readonly gradedByServer: false;
}

/** plansrc 的 E1Evidence 的**结构子集**。我们只读这些字段，不读任何秘密字段。 */
export interface EvidenceLike {
  readonly catalog: {
    readonly schemaVersion: number | null;
    readonly documentRevision: number | null;
    readonly catalogRevision: string;
    readonly catalogEntryCount: number;
    readonly readAt: number;
    readonly providerRuleCount: number;
  };
  readonly entitlement: {
    readonly present: boolean;
    readonly updatedAt: number | null;
    readonly items: ReadonlyArray<{ readonly status: string; readonly reason: string | null }>;
  };
  readonly selection: {
    readonly present: boolean;
    readonly domainUpdatedAt: number | null;
    readonly selections: ReadonlyArray<{ readonly kind: string }>;
  };
  readonly planCount: number;
}

/**
 * 上游 status → 三类计数。**严格按 PLANSRC 既有契约**：
 * mapper.ts:562/566 只把逐字等于 `'available'` / `'unavailable'` 的当作两类，
 * 其余一律 unknown（mapper.ts:676 把非字符串也归为 `'unknown'`）。
 *
 * 这里**不做**任何别名猜测：`ready` / `valid` / `ok` / 大小写变体 / 带空格的
 * 一律是 unknown。把"就绪""有效""凭据缺失"当成"有额度"是凭空造额度。
 * 也不做 trim/lowercase —— 契约是逐字相等。
 */
function classifyStatus(status: string): 'available' | 'unavailable' | 'unknown' {
  if (status === 'available') return 'available';
  if (status === 'unavailable') return 'unavailable';
  return 'unknown';
}

/** 严格计数校验：非有限数、负数、非整数一律 null（＝invalid，不是 0）。 */
function isCountOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Number.isInteger(v) ? v : null;
}

/**
 * 读回时钟本身必须先合法。
 * NaN / Infinity / ≤0 的 `now` 会让「未来时间戳」判断彻底失效（任何 v 都比不过 NaN），
 * 因此**先校验 now**：now 非法时，调用方必须整体降级，不能让时间校验假装通过。
 */
export function isValidNow(now: unknown): now is number {
  return typeof now === 'number' && Number.isFinite(now) && now > 0;
}

/**
 * 时间戳校验。荒谬值一律 null，由调用方记 `timestamp_invalid`。
 *
 * **不设时钟宽容**：已批准「未来即非法」。源文件的 `readAt` / `updatedAt`
 * 不可能晚于我们读它的那一刻，`v > now` 就是 `timestamp_invalid`。
 * 我们只有 `now`、没有权威时钟可比，给宽容等于自己造一个"合法"的未来证据。
 */
function isSaneTimestampOrNull(v: unknown, now: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v <= 0) return null;
  if (v > now) return null; // 未来即非法，无宽容
  return v;
}

/** 非空字符串或 null。 */
function nonEmptyStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** mapper 只承认非空字符串 kind；其余一律不计入选模数。 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

export interface BuildReadStatusOptions {
  readonly driverKind: ReadStatusDriverKind;
  /**
   * **同层**目录条目数：运行驱动器 `driver.catalog.models.length`。
   * 它与 E1 evidence 的 `catalogEntryCount` 描述同一份目录，因此可以比对。
   * 注意这**不是** servable 子集数。
   */
  readonly driverCatalogCount: number | null;
  /**
   * **同层**目录 revision：`driver.catalog.revision`。
   * 必须与 evidence 的 `catalog.catalogRevision` 同 scope 比对 ——
   * 只比 count 比不出「目录换了一版但条数没变」。**null 表示未知，不参与比对**，
   * 绝不拿改字符串伪造一致。
   */
  readonly driverCatalogRevision: string | null;
  /** 可服务子集。按定义 ≤ driverCatalogCount，**不要求与目录总数相等**。 */
  readonly servableCount: number | null;
  /** 固定枚举状态；**不透传 statusDetail 自由文本**。 */
  readonly driverStatus: 'ready' | 'not_attached' | 'unavailable';
  /** 启动时捕获的证据。缺证据（none / 未捕获）时传 null。 */
  readonly evidence: EvidenceLike | null;
  /**
   * 本次读回时的本地 `Date.now()`。**显式传入**——本模块不读时钟，
   * 测试才能确定性断言"未来时间戳"这类负例。
   */
  readonly now: number;
}
/**
 * 投影成公开 DTO。**纯函数：无 I/O、不读时钟**（时钟由 `options.now` 显式传入）。
 *
 * 三条不做的事，都是为了不制造假信号：
 *  1. 不定级：`gradedByServer` 恒 false，缺口只列名不判定。
 *  2. 不伪新鲜：`validityWindowKnown` 恒 false —— 只有 readAt/updatedAt（过去某刻），
 *     没有 expires；GET 也不重新读盘。
 *  3. 不静默吞非法形状：数组 / 枚举 / 时间戳不合法一律显式记 `evidence_field_invalid`
 *     或 `timestamp_invalid`，绝不被 `?? []` 之类默认值变成"看起来正常"。
 *
 * 本函数**不抛**：结构错一律降级成 null + 具名缺口。
 */
export function buildReadStatus(options: BuildReadStatusOptions): ReadStatusPayload {
  const blocking = new Set<ReadStatusE1BlockingGap>();
  const warnings = new Set<ReadStatusUsageWarning>();

  /* ---- options 侧先做内部可信化 ---- */
  // now 非法 → 时间校验全部不可信：记 timestamp_invalid 并把 now 置 0。
  // 置 0 后 isSaneTimestampOrNull 对任何 v>0 都返回 null —— 不会误判为合法。
  const nowValid = isValidNow(options.now);
  const now = nowValid ? options.now : 0;
  if (!nowValid) blocking.add('timestamp_invalid');

  const driverKind = READ_STATUS_DRIVER_KINDS.includes(options.driverKind) ? options.driverKind : 'none';
  if (driverKind !== options.driverKind) blocking.add('evidence_field_invalid');
  const driverStatus = (options.driverStatus === 'ready'
    || options.driverStatus === 'not_attached'
    || options.driverStatus === 'unavailable')
    ? options.driverStatus
    : 'not_attached';
  if (driverStatus !== options.driverStatus) blocking.add('evidence_field_invalid');

  const driverCatalogCount = isCountOrNull(options.driverCatalogCount);
  if (driverCatalogCount === null && options.driverCatalogCount !== null) blocking.add('evidence_field_invalid');
  const driverCatalogRevision = nonEmptyStringOrNull(options.driverCatalogRevision);
  const servableCount = isCountOrNull(options.servableCount);
  if (servableCount === null && options.servableCount !== null) blocking.add('evidence_field_invalid');

  if (driverKind === 'none' || driverCatalogCount === null) blocking.add('driver_not_attached');

  const ev = options.evidence;

  /* ---- 三份全缺：early return，但必须保留全部关键具名缺口 ---- */
  if (ev === null || typeof ev !== 'object') {
    blocking.add('evidence_not_captured');
    blocking.add('catalog_absent');
    blocking.add('entitlement_absent');
    blocking.add('selection_absent');
    blocking.add('account_unproven');
    blocking.add('entitlement_staleness_unproven');
    blocking.add('selection_unproven');
    blocking.add('billing_class_mapping_unproven');
    warnings.add('authoritative_bucket_unobserved');
    warnings.add('consumption_unobserved');
    return {
      schema: 'zcc-read-status',
      version: 1,
      driver: { kind: driverKind, status: driverStatus, catalogCount: driverCatalogCount, servableCount },
      // 无证据时不得谎称读到了本机官方文件
      catalog: {
        sourceKind: 'unknown',
        revision: null,
        entryCount: null,
        schemaVersion: null,
        documentRevision: null,
        readAt: null
      },
      entitlement: null,
      selection: null,
      e1Blocking: [...blocking].sort(),
      usageWarnings: [...warnings].sort(),
      validityWindowKnown: false,
      gradedByServer: false
    };
  }

  /* ---- catalog ---- */
  const cat = (typeof ev.catalog === 'object' && ev.catalog !== null) ? ev.catalog : null;
  if (cat === null) blocking.add('evidence_field_invalid');
  const catalogRevision = nonEmptyStringOrNull(cat?.catalogRevision);
  const catalogEntryCount = isCountOrNull(cat?.catalogEntryCount);
  const readAt = isSaneTimestampOrNull(cat?.readAt, now);
  const schemaVersion = isCountOrNull(cat?.schemaVersion);
  const documentRevision = isCountOrNull(cat?.documentRevision);
  if (catalogRevision === null || catalogEntryCount === null) blocking.add('catalog_absent');
  if (cat !== null && (schemaVersion === null || documentRevision === null)) blocking.add('evidence_field_invalid');
  if (cat !== null && cat.readAt !== null && cat.readAt !== undefined && readAt === null) {
    blocking.add('timestamp_invalid');
  }

  /* ---- 同层比对：driver.catalog 与 E1 evidence catalog（同一份目录） ----
   * servable 子集与整份官方目录本来就不同大小（目录 18 / 可服务 10 之类），
   * 那是正常的，不是缺陷。因此：
   *   - count：driverCatalogCount === catalogEntryCount（同层必须一致）
   *   - revision：driverCatalogRevision === catalogRevision（同层必须一致）
   *   - servableCount：只受子集约束（<= catalogEntryCount），不要求相等
   * 任一侧为 null（未知）则不参与比对，也绝不判为一致。
   */
  if (driverCatalogCount !== null && catalogEntryCount !== null
    && driverCatalogCount !== catalogEntryCount) {
    blocking.add('driver_catalog_mismatch');
  }
  if (driverCatalogRevision !== null && catalogRevision !== null
    && driverCatalogRevision !== catalogRevision) {
    blocking.add('driver_catalog_mismatch');
  }
  if (servableCount !== null && catalogEntryCount !== null && servableCount > catalogEntryCount) {
    blocking.add('driver_catalog_mismatch');
  }

  /* ---- entitlement ---- */
  const ent = (typeof ev.entitlement === 'object' && ev.entitlement !== null) ? ev.entitlement : null;
  if (ent === null) blocking.add('evidence_field_invalid');
  const entPresentRaw = ent?.present;
  const entPresentValid = typeof entPresentRaw === 'boolean';
  if (ent !== null && !entPresentValid) blocking.add('evidence_field_invalid');
  const entPresent = entPresentValid ? entPresentRaw : false;

  // items 形状不合法时不吞：记 invalid
  const entItemsRaw = ent?.items;
  const entItemsArray = Array.isArray(entItemsRaw);
  if (ent !== null && !entItemsArray) blocking.add('evidence_field_invalid');
  const entItems: ReadonlyArray<{ readonly status: string }> = entItemsArray
    ? (entItemsRaw as ReadonlyArray<{ status: string }>)
    : [];

  let available = 0;
  let unavailable = 0;
  let unknown = 0;
  for (const it of entItems) {
    const bucket = classifyStatus(typeof it?.status === 'string' ? it.status : '');
    if (bucket === 'available') available += 1;
    else if (bucket === 'unavailable') unavailable += 1;
    else unknown += 1;
  }
  // present 与 items 自相矛盾 -> invalid（不静默当成"没有资格"）
  if (ent !== null && entPresentValid) {
    if (entPresent === false && entItems.length > 0) blocking.add('evidence_field_invalid');
    if (entPresent === true && entItems.length === 0) blocking.add('evidence_field_invalid');
  }
  if (!entPresent) blocking.add('entitlement_absent');

  const entUpdatedAt = isSaneTimestampOrNull(ent?.updatedAt, now);
  if (ent !== null && ent.updatedAt !== null && ent.updatedAt !== undefined && entUpdatedAt === null) {
    blocking.add('timestamp_invalid');
  }

  /* ---- selection ---- */
  const sel = (typeof ev.selection === 'object' && ev.selection !== null) ? ev.selection : null;
  if (sel === null) blocking.add('evidence_field_invalid');
  const selPresentRaw = sel?.present;
  const selPresentValid = typeof selPresentRaw === 'boolean';
  if (sel !== null && !selPresentValid) blocking.add('evidence_field_invalid');
  const selPresent = selPresentValid ? selPresentRaw : false;

  const selItemsRaw = sel?.selections;
  const selItemsArray = Array.isArray(selItemsRaw);
  if (sel !== null && !selItemsArray) blocking.add('evidence_field_invalid');

  // 只按 mapper 的真实闭集计数：有非空字符串 kind 的条目才算选中。
  // 不用无条件 selections.length —— 那会把非法条目算成有效选模。
  let selectedCount = 0;
  if (selItemsArray) {
    for (const it of selItemsRaw as ReadonlyArray<{ kind?: unknown }>) {
      if (it !== null && typeof it === 'object' && isNonEmptyString(it.kind)) selectedCount += 1;
      else blocking.add('evidence_field_invalid');
    }
  }
  if (sel !== null && selPresentValid) {
    if (selPresent === false && selectedCount > 0) blocking.add('evidence_field_invalid');
    if (selPresent === true && selectedCount === 0) blocking.add('evidence_field_invalid');
  }
  if (!selPresent) blocking.add('selection_absent');

  const selUpdatedAt = isSaneTimestampOrNull(sel?.domainUpdatedAt, now);
  if (sel !== null && sel.domainUpdatedAt !== null && sel.domainUpdatedAt !== undefined && selUpdatedAt === null) {
    blocking.add('timestamp_invalid');
  }

  /* ---- 恒定资格类缺口：证据"曾经读到"不等于"当前有效" ---- */
  blocking.add('account_unproven');
  blocking.add('entitlement_staleness_unproven');
  blocking.add('selection_unproven');
  blocking.add('billing_class_mapping_unproven');

  /* ---- 仅影响 E3 的观测类提示（929:258：缺权威桶不挡 E1/E2） ---- */
  warnings.add('authoritative_bucket_unobserved');
  warnings.add('consumption_unobserved');

  return {
    schema: 'zcc-read-status',
    version: 1,
    driver: {
      kind: driverKind,
      status: driverStatus,
      catalogCount: driverCatalogCount,
      servableCount
    },
    catalog: {
      // 数据来源：两条 driver 分支都由 readPlanSources 读本机官方文件。
      // 这与 driver.kind（运行时用哪个驱动器）是两回事，UI 必须分开显示。
      sourceKind: 'local-official-files',
      revision: catalogRevision,
      entryCount: catalogEntryCount,
      schemaVersion,
      documentRevision,
      readAt
    },
    entitlement: {
      present: entPresent,
      updatedAt: entUpdatedAt,
      availableCount: available,
      unavailableCount: unavailable,
      unknownCount: unknown,
      itemCount: entItems.length
    },
    selection: {
      present: selPresent,
      updatedAt: selUpdatedAt,
      selectedCount
    },
    e1Blocking: [...blocking].sort(),
    usageWarnings: [...warnings].sort(),
    validityWindowKnown: false,
    gradedByServer: false
  };
}
