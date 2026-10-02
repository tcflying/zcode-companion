/**
 * I04 基础层：错误数据合同 + 共享严格校验原语。
 *
 * 为什么错误模块同时承载校验原语：本子包的 5 个手写文件预算已由
 * `capabilities.ts` / `operation.ts` / `events.ts` / 本文件 / 合同测试占满，
 * 不允许再拆一个 `primitives.ts`。brief 明确授权"必要 shared 校验可在 5 文件内
 * 合并，不为拆文件制造循环"，因此本文件是最底层：其余三个合同文件只依赖它，
 * 依赖图是 `errors ← capabilities`、`errors ← operation`、`errors+operation ← events`，
 * 无环。
 *
 * 三条不可让步的边界：
 *  1. **本地错误码**：`LocalErrorCode` 是本产品自有词汇，不是上游 RPC 的错误形状。
 *     本产品不接上游整块错误对象，也不接上游凭据。
 *  2. **投递确定性**：`not_submitted`（确定没离开本产品边界）与 `outcome_unknown`
 *     （超时/断连/崩溃/来源不明 → 结果不可知）是两种不同的事实，不能合并成一个
 *     "失败"。带 `submitted_rejected` 是为了让"已投递且被明确拒绝"这种**结果确定**
 *     的失败有地方可放——否则它会被错记成 `outcome_unknown`，那才是危险的。
 *  3. **可重试提示不等于自动重发许可**：`RetryAdvice.autoResendAllowed` 的类型被钉死
 *     为字面量 `false`，`canAutoResend()` 对三种确定性都返回 `false`。`guidance` 里
 *     可以写"可重试"，但那是给人的文字，不是授权。
 */

/** 全局长度口径。字符数与 UTF-8 字节数是两个独立的上限，任何一个越界都拒绝。 */
export const CONTRACT_LIMITS = {
  /** 标识符最大字符数（UTF-16 code unit 计数）。 */
  idMaxChars: 128,
  /** 标识符最大 UTF-8 字节数。100 个中文字符 = 100 字符但 300 字节，仍须拒绝。 */
  idMaxUtf8Bytes: 256,
  /** 人类可读文本（错误消息 / 告警）最大字符数。 */
  messageMaxChars: 2000,
  /** 单个受校验对象允许的最大键数。 */
  objectMaxKeys: 32,
  /** 数组型字段（evidenceRefs / warnings）最大元素数。 */
  arrayMaxItems: 64,
  /** 单行 NDJSON 事件的最大 UTF-8 字节数。 */
  eventLineMaxBytes: 16384
} as const;

export type ContractIssueCode =
  | 'not_an_object'
  | 'missing_field'
  | 'unknown_field'
  | 'invalid_type'
  | 'invalid_value'
  | 'invalid_json'
  | 'empty_value'
  | 'too_long'
  | 'too_many_items'
  | 'invalid_enum'
  | 'invalid_number'
  | 'invalid_date'
  | 'sensitive_field'
  | 'forbidden_value';

export interface ContractIssue {
  /** 点分路径，例如 `event.payload.state`。 */
  readonly path: string;
  readonly code: ContractIssueCode;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ContractIssue[] };

export function issue(path: string, code: ContractIssueCode, message: string): ContractIssue {
  return { path, code, message };
}

export function accepted<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function rejected<T>(issues: readonly ContractIssue[]): ValidationResult<T> {
  return { ok: false, issues };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const UTF8_ENCODER = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).length;
}

/* -------------------------------------------------------------------------- */
/* 敏感字段                                                                    */
/* -------------------------------------------------------------------------- */

/** 归一化键名：小写并去掉 `.`/`_`/`-`/空格，使 `api_key` / `API-KEY` / `apiKey` 同义。 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[._\-\s]/g, '');
}

const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'apikey',
  'apikeys',
  'token',
  'tokens',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'authtoken',
  'bearertoken',
  'authorization',
  'credential',
  'credentials',
  'secret',
  'secrets',
  'clientsecret',
  'privatekey',
  'password',
  'passwd',
  'pwd'
]);

/**
 * **token 字符集**（长随机串判定用）。比经典的 `[A-Za-z0-9_-]` **多了 `.`**——
 * 官方 coding-plan 的 api-key 自有包装形态就是「长段 + 点 + 长段」，而**点会把逐段判定
 * 切成两段**，两段都不到阈值时整条规则形同虚设（复审实测 43 字符的 `30+1+12` 形态原样
 * 到达 `zcc_error.message`）。字符集里没有 `.` 时，token 就等于"一段无分隔连续串"。
 */
const CREDENTIAL_TOKEN_CLASS = 'A-Za-z0-9_.-';

/** 良形 UUID（8-4-4-4-12 十六进制 + `-`）。**不是**凭据：它是本产品的 operationId 等标识的形态。 */
const BENIGN_UUID_SHAPE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/**
 * 良形语义版本号。可选 `v` 前缀、三段数字、可选预发布段与构建元数据。
 * 官方 bundle 自身的版本、`1.2.3-alpha.1+build.20260101120000` 这类都会走到这里，**不该**被当凭据。
 */
const BENIGN_SEMVER_SHAPE =
  'v?\\d{1,9}(?:\\.\\d{1,9}){2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\\+[0-9A-Za-z][0-9A-Za-z.-]*)?';

/**
 * 良形 64 位**纯十六进制**指纹。既有契约
 * 「a 64-hex fingerprint is evidence, not a credential」
 * （`tests/contract/contracts.test.mjs`）钉死了这一点：`RuntimeCapability.fingerprint`
 * 要展示它，它是证据而不是凭据。
 */
const BENIGN_HEX_FINGERPRINT_SHAPE = '[0-9a-fA-F]{64}';

/**
 * 良形 token 的**并集**：`urn:uuid:` 形式、UUID 本身、以及带 0–3 段短标签前缀的
 * `<label>[-<label>…]-<uuid>`（例如本仓的 `operationId = "chatcmpl-" + randomUUID()`
 * 与 `session-drive.mjs` 里的 `zcc-host-<operationId>`）。
 *
 * **前缀段刻意限死**（每段 ≤24 字符、至多 3 段、只能是 `[0-9A-Za-z]`）：这样长随机密钥
 * 只要**不是**刻意拼上 UUID 后缀就仍会被拦。
 */
const BENIGN_TOKEN_SHAPE =
  `(?:${BENIGN_HEX_FINGERPRINT_SHAPE}|${BENIGN_SEMVER_SHAPE}|urn:uuid:${BENIGN_UUID_SHAPE}|(?:[0-9A-Za-z]{1,24}-){0,3}${BENIGN_UUID_SHAPE})`;

/**
 * **长随机串形态**：一整个 `token`（`[A-Za-z0-9_.-]` 的极大连续段）长度 ≥ 32，
 * 且**不是**上面任何一个良形。
 *
 * 与上一版的差别（上一版：`\b(?![0-9a-fA-F]{64}\b)[A-Za-z0-9_-]{32,}\b`）：
 *  - **正向**：从"逐段判定"改成"**整 token** 判定"并把 `.` 纳入字符集 →
 *    43 字符的 `30 + 1 + 12` 形态不再漏拦。
 *  - **反向**：良形集合（64-hex 指纹 / 语义版本号 / UUID 及其带标签前缀形态）**整体豁免** →
 *    `chatcmpl-<uuid>` 这类 43 字符标识不再被误判成凭据。
 *
 * 两个方向的判据都落在**同一个** token 上，所以"检测得到"与"脱敏得掉"仍然共用这组正则
 * （见 {@link redactCredentialText}），不留缝。
 */
const LONG_CREDENTIAL_TOKEN_PATTERN = new RegExp(
  `(?<![${CREDENTIAL_TOKEN_CLASS}])(?!(?:${BENIGN_TOKEN_SHAPE})(?![${CREDENTIAL_TOKEN_CLASS}]))[${CREDENTIAL_TOKEN_CLASS}]{32,}(?![${CREDENTIAL_TOKEN_CLASS}])`
);

const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  // `Authorization: Bearer <token>` / 裸 `Bearer <token>`
  /\bBearer\s+[A-Za-z0-9\-._~+/]{6,}=*/i,
  // JWT 三段式
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/,
  // sk- / pk- / rk- / ak- 前缀密钥
  /\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{8,}\b/,
  // 键值形态
  /\bAuthorization\s*[:=]\s*\S+/i,
  // **JWT 前缀段形态**：官方 coding-plan 的 `zcodejwttoken` / `oauth:<family>:access_token`
  // 在异常文本里可能已被截断成"只剩 eyJ 开头的一段"（子宿主 detail 有 400 字符上限），
  // 三段式匹配不上。裸 `eyJ` 后面跟 ≥16 位 base64url 已是强凭据信号。
  /\beyJ[A-Za-z0-9_-]{16,}/,
  // **长随机 token 形态**（含带点的官方 coding-plan api-key）。见 LONG_CREDENTIAL_TOKEN_PATTERN
  // 顶上方的说明：整 token 判定 + 良形豁免（64-hex 指纹 / 语义版本号 / UUID 家族）。
  LONG_CREDENTIAL_TOKEN_PATTERN
];

/**
 * 判定一段连续 64 位纯十六进制（证据指纹形状）。**只供 `redactCredentialText` 用**，
 * 不参与"是否像凭据"的判定——那个判定的口径由 {@link looksLikeCredentialValue} 独占，
 * 且它必须与既有契约（指纹不是凭据）保持一致。
 *
 * @param text 待判连续段
 * @returns `true` 表示它是 64 位纯 hex
 */
export function isHexFingerprintRun(text: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(text);
}

/** 被 {@link redactCredentialText} 替换掉的占位符。长度刻意短——它自己也不能长得像密钥。 */
export const CREDENTIAL_REDACTION_PLACEHOLDER = '[redacted]';

/**
 * 把自由文本里的凭据形态整段替换成 {@link CREDENTIAL_REDACTION_PLACEHOLDER}。
 *
 * 与 {@link looksLikeCredentialValue} 的区别：那个只回答"有没有"（用于**整条**丢弃），
 * 这个保留句子的其余部分（用于**局部**脱敏）。两者共用同一组正则，所以"能被判出来"
 * 和"能被脱敏掉"的口径永远一致——不会出现"检测得到但脱敏不掉"的缝。
 *
 * @param text 任意文本
 * @returns 脱敏后的文本；无命中时返回原值
 */
export function redactCredentialText(text: string): string {
  let out = text;
  for (const re of CREDENTIAL_VALUE_PATTERNS) {
    // 逐条重建正则：`g` 标志会污染模块级常量的 lastIndex。
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), CREDENTIAL_REDACTION_PLACEHOLDER);
  }
  return out;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

export function looksLikeCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some((re) => re.test(value));
}

/**
 * 递归扫描敏感内容。
 *
 * 路径口径（刻意区分两类命中，便于定位）：
 *  - **敏感键名**命中 → issue 落在**包含它的那个对象**的路径上
 *    （`error.detail` 而不是 `error.detail.apiKey`），因为"这个对象里带了凭据"
 *    本身就是需要处理的结论。
 *  - **凭据样式字符串值**命中 → issue 落在**该值自己的**路径上
 *    （`error.message`），因为要指出的正是那一句文本。
 *
 * 注意：64 位十六进制**不**按凭据处理——它是本产品要展示的证据指纹
 * （如 `RuntimeCapability.fingerprint`），走各自的形状校验。
 */
export function collectSensitiveIssues(value: unknown, path: string, depth = 0): ContractIssue[] {
  if (depth > 8) return [];
  if (typeof value === 'string') {
    return looksLikeCredentialValue(value)
      ? [issue(path, 'sensitive_field', '文本内容呈现凭据特征（Bearer/JWT/密钥前缀/Authorization）')]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectSensitiveIssues(item, `${path}[${index}]`, depth + 1));
  }
  if (!isPlainObject(value)) return [];

  const issues: ContractIssue[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      issues.push(issue(path, 'sensitive_field', `字段 ${key} 是凭据字段，本产品不接收任何上游凭据块`));
      continue;
    }
    issues.push(...collectSensitiveIssues(child, `${path}.${key}`, depth + 1));
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* 字段级原语                                                                  */
/* -------------------------------------------------------------------------- */

/** 控制字符检测：按码点判断，避免把不可见控制字符写进源码字面量。 */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const WILDCARD_RE = /[*?]/u;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * 标识符（catalogId / providerId / modelId / accountEpoch / requestId ...）校验。
 *
 * 显式拒绝：非字符串、空字符串、超长（字符或字节）、首尾空白、控制字符、通配符。
 * `undefined` 与 `null` 都是 `invalid_type` 而不是"空字符串"——两者语义不同：
 * "没传"和"传了空"不是同一类缺陷。
 */
export function validateIdentifier(value: unknown, path: string): ContractIssue[] {
  if (typeof value !== 'string') {
    return [issue(path, 'invalid_type', '标识符必须是字符串（undefined / null / 数字均不接受）')];
  }
  if (value.length === 0) {
    return [issue(path, 'empty_value', '标识符不得为空字符串')];
  }
  if (value.length > CONTRACT_LIMITS.idMaxChars) {
    return [issue(path, 'too_long', `标识符超过 ${CONTRACT_LIMITS.idMaxChars} 字符上限`)];
  }
  if (utf8ByteLength(value) > CONTRACT_LIMITS.idMaxUtf8Bytes) {
    return [issue(path, 'too_long', `标识符超过 ${CONTRACT_LIMITS.idMaxUtf8Bytes} UTF-8 字节上限`)];
  }
  if (value !== value.trim()) {
    return [issue(path, 'invalid_value', '标识符不得含首尾空白')];
  }
  if (hasControlChars(value)) {
    return [issue(path, 'invalid_value', '标识符不得含控制字符')];
  }
  if (WILDCARD_RE.test(value)) {
    return [issue(path, 'invalid_value', '标识符只做精确匹配，不接受通配符')];
  }
  return [];
}

export function validateEnumValue(value: unknown, allowed: readonly string[], path: string): ContractIssue[] {
  if (typeof value !== 'string') {
    return [issue(path, 'invalid_type', '枚举取值必须是字符串')];
  }
  if (!allowed.includes(value)) {
    return [issue(path, 'invalid_enum', `非法枚举取值 "${value}"，允许值：${allowed.join(' | ')}`)];
  }
  return [];
}

export function validateText(value: unknown, path: string): ContractIssue[] {
  if (typeof value !== 'string') return [issue(path, 'invalid_type', '文本字段必须是字符串')];
  if (value.length === 0) return [issue(path, 'empty_value', '文本字段不得为空')];
  if (value.length > CONTRACT_LIMITS.messageMaxChars) {
    return [issue(path, 'too_long', `文本超过 ${CONTRACT_LIMITS.messageMaxChars} 字符上限`)];
  }
  return [];
}

/**
 * 严格 ISO-8601 UTC 时间戳（毫秒精度，`Z` 结尾）。
 *
 * 语法通过还不够：再做一次"解析后回写必须逐字相同"的往返校验，
 * 这样 `2026-02-30T00:00:00.000Z` 这类语法合法但日历上不存在的值也会被拒。
 */
export function validateIsoTimestamp(value: unknown, path: string): ContractIssue[] {
  if (typeof value !== 'string') return [issue(path, 'invalid_type', '时间戳必须是 ISO-8601 字符串')];
  if (!ISO_UTC_RE.test(value)) {
    return [issue(path, 'invalid_date', `时间戳必须是 YYYY-MM-DDTHH:MM:SS.sssZ：收到 "${value}"`)];
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return [issue(path, 'invalid_date', `时间戳不是真实存在的时刻：收到 "${value}"`)];
  }
  if (new Date(ms).toISOString() !== value) {
    return [issue(path, 'invalid_date', `时间戳日历非法：收到 "${value}"`)];
  }
  return [];
}

/** 非负安全整数。`0` 合法；负数、小数、NaN、Infinity、字符串数字一律拒绝。 */
export function validateNonNegativeInteger(value: unknown, path: string): ContractIssue[] {
  if (typeof value !== 'number') return [issue(path, 'invalid_type', '必须是数字')];
  if (!Number.isFinite(value)) return [issue(path, 'invalid_number', '不允许 NaN / Infinity')];
  if (!Number.isInteger(value)) return [issue(path, 'invalid_number', '必须是整数')];
  if (value < 0) return [issue(path, 'invalid_number', '不允许负数')];
  if (!Number.isSafeInteger(value)) return [issue(path, 'invalid_number', '超过安全整数范围')];
  return [];
}

export function validateBoolean(value: unknown, path: string): ContractIssue[] {
  if (typeof value !== 'boolean') return [issue(path, 'invalid_type', '必须是布尔值')];
  return [];
}

/** 字符串数组：逐项走标识符校验，元素数有上限。 */
export function validateStringList(value: unknown, path: string, maxItems = CONTRACT_LIMITS.arrayMaxItems): ContractIssue[] {
  if (!Array.isArray(value)) return [issue(path, 'invalid_type', '必须是数组')];
  if (value.length > maxItems) return [issue(path, 'too_many_items', `数组元素超过 ${maxItems} 上限`)];
  return value.flatMap((item, index) => validateIdentifier(item, `${path}[${index}]`));
}

/**
 * 对象形状校验：必填键必须在场、**任何未知键一律拒绝**、键数有上限、整棵树扫敏感内容。
 *
 * 未知字段策略是显式的"拒绝"而不是"丢弃"：一个我们不认识的字段可能携带权益、
 * 配额或投递结论，静默丢掉再按"成功"处理，是把未知当成安全。
 */
export function validateShape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string
): ContractIssue[] {
  if (!isPlainObject(value)) {
    return [issue(path, 'not_an_object', '必须是普通对象（不接受 null / 数组 / 类实例）')];
  }
  const issues: ContractIssue[] = [];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      issues.push(issue(`${path}.${key}`, 'missing_field', `缺少必填字段 ${key}`));
    }
  }
  const allowed = new Set<string>([...required, ...optional]);
  const present = Object.keys(value);
  for (const key of present) {
    if (!allowed.has(key)) {
      issues.push(
        issue(`${path}.${key}`, 'unknown_field', `未知字段 ${key}：影响语义的未知字段一律拒绝，不静默丢弃`)
      );
    }
  }
  if (present.length > CONTRACT_LIMITS.objectMaxKeys) {
    issues.push(issue(path, 'too_many_items', `对象键数超过 ${CONTRACT_LIMITS.objectMaxKeys} 上限`));
  }
  issues.push(...collectSensitiveIssues(value, path));
  return issues;
}

/* -------------------------------------------------------------------------- */
/* 错误 DTO                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 投递确定性。取值是**本产品**的判定，不是上游返回的字段。
 *
 * - `not_submitted`：确定没有任何请求离开本产品边界（例如在本地校验阶段就被拒）。
 * - `submitted_rejected`：已投递，上游明确拒绝，结果确定且未执行。
 * - `outcome_unknown`：投递结果不可知（超时、断连、进程崩溃、来源不明）。
 */
export type DeliveryCertainty = 'not_submitted' | 'submitted_rejected' | 'outcome_unknown';

export const DELIVERY_CERTAINTIES: readonly DeliveryCertainty[] = [
  'not_submitted',
  'submitted_rejected',
  'outcome_unknown'
];

/**
 * 人工重发会不会造成重复执行。由投递确定性唯一决定，不接受调用方自报。
 *
 * 只有 `not_submitted` 为 `true`——那表示重发**不会**造成重复执行，
 * 仍然**不代表允许自动重发**（见 `AUTO_RESEND_ALLOWED_BY_CERT`）。
 */
export const RESEND_WOULD_NOT_DUPLICATE_BY_CERT: Readonly<Record<DeliveryCertainty, boolean>> = {
  not_submitted: true,
  submitted_rejected: false,
  outcome_unknown: false
};

export function deriveResendWouldNotDuplicate(certainty: DeliveryCertainty): boolean {
  return RESEND_WOULD_NOT_DUPLICATE_BY_CERT[certainty];
}

/**
 * 自动重发许可表。**所有取值都是 `false`**，且类型被钉死为字面量 `false`：
 * 往这个表里加一个 `true` 会直接编译失败。
 *
 * 这不是"当前还没实现"，而是安全边界的固化：未知结果永不自动重发。
 * `Record<DeliveryCertainty, false>` 同时保证了"新增确定性取值时必须显式表态"。
 */
export const AUTO_RESEND_ALLOWED_BY_CERT: Readonly<Record<DeliveryCertainty, false>> = {
  not_submitted: false,
  submitted_rejected: false,
  outcome_unknown: false
};

export function canAutoResend(certainty: DeliveryCertainty): false {
  return AUTO_RESEND_ALLOWED_BY_CERT[certainty];
}

/** 本地错误码。不接上游错误块，不携带上游凭据。 */
export type LocalErrorCode =
  | 'admission_denied'
  | 'window_closed'
  | 'billing_not_sendable'
  | 'evidence_insufficient'
  | 'operation_not_submitted'
  | 'operation_outcome_unknown'
  | 'upstream_rejected'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'event_schema_invalid'
  | 'capability_not_behavior_verified'
  | 'contract_violation'
  | 'internal_error';

export const LOCAL_ERROR_CODES: readonly LocalErrorCode[] = [
  'admission_denied',
  'window_closed',
  'billing_not_sendable',
  'evidence_insufficient',
  'operation_not_submitted',
  'operation_outcome_unknown',
  'upstream_rejected',
  'upstream_unavailable',
  'upstream_timeout',
  'event_schema_invalid',
  'capability_not_behavior_verified',
  'contract_violation',
  'internal_error'
];

export interface RetryAdvice {
  /** 恒为 `false`。任何失败、超时、来源不明的结果都不得自动重发。 */
  readonly autoResendAllowed: false;
  /** 恒为 `true`。重发必须由人显式决定。 */
  readonly requiresExplicitHumanDecision: true;
  /** 重发是否会造成重复执行；由投递确定性推导，不可自报。 */
  readonly resendWouldNotDuplicate: boolean;
  /** 给人看的文字。它不是授权，也不改变上面两个布尔量。 */
  readonly guidance: string;
}

export interface CompanionError {
  readonly code: LocalErrorCode;
  readonly message: string;
  readonly delivery: DeliveryCertainty;
  readonly retry: RetryAdvice;
  readonly observedAt: string;
  /** 扁平的结构化补充信息。值只允许 string / number / boolean，不接受嵌套块。 */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

const ERROR_REQUIRED_KEYS = ['code', 'message', 'delivery', 'retry', 'observedAt', 'detail'] as const;
const RETRY_REQUIRED_KEYS = [
  'autoResendAllowed',
  'requiresExplicitHumanDecision',
  'resendWouldNotDuplicate',
  'guidance'
] as const;

function isDeliveryCertainty(value: unknown): value is DeliveryCertainty {
  return typeof value === 'string' && (DELIVERY_CERTAINTIES as readonly string[]).includes(value);
}

function validateDetail(value: unknown, path: string): ContractIssue[] {
  if (!isPlainObject(value)) return [issue(path, 'not_an_object', 'detail 必须是普通对象')];
  const issues: ContractIssue[] = [];
  const keys = Object.keys(value);
  if (keys.length > CONTRACT_LIMITS.objectMaxKeys) {
    issues.push(issue(path, 'too_many_items', `detail 键数超过 ${CONTRACT_LIMITS.objectMaxKeys} 上限`));
  }
  for (const key of keys) {
    const item: unknown = value[key];
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      issues.push(
        issue(`${path}.${key}`, 'invalid_type', 'detail 的值只允许 string / number / boolean，不接受嵌套结构或上游整块对象')
      );
    }
  }
  if (keys.length > 0 && collectSensitiveIssues(value, path).length > 0) {
    issues.push(issue(path, 'sensitive_field', 'detail 含凭据字段或凭据样式取值，本产品不接上游凭据'));
  }
  return issues;
}

function validateRetryAdvice(value: unknown, delivery: unknown, path: string): ContractIssue[] {
  const issues = validateShape(value, RETRY_REQUIRED_KEYS, [], path);
  if (!isPlainObject(value) || issues.length > 0) return issues;

  const forbidden: string[] = [];
  if (value['autoResendAllowed'] !== false) forbidden.push('autoResendAllowed');
  if (value['requiresExplicitHumanDecision'] !== true) forbidden.push('requiresExplicitHumanDecision');

  const duplicate: unknown = value['resendWouldNotDuplicate'];
  if (typeof duplicate !== 'boolean') {
    issues.push(issue(`${path}.resendWouldNotDuplicate`, 'invalid_type', '必须是布尔值'));
  } else if (isDeliveryCertainty(delivery) && duplicate !== RESEND_WOULD_NOT_DUPLICATE_BY_CERT[delivery]) {
    // 自报的"重发不会重复"与投递确定性冲突：以确定性为准，自报一律拒绝。
    issues.push(
      issue(
        `${path}.resendWouldNotDuplicate`,
        'forbidden_value',
        `与投递确定性 ${delivery} 矛盾：应为 ${String(RESEND_WOULD_NOT_DUPLICATE_BY_CERT[delivery])}`
      )
    );
  }

  issues.push(...validateText(value['guidance'], `${path}.guidance`));

  if (forbidden.length > 0) {
    for (const field of forbidden) {
      issues.push(issue(`${path}.${field}`, 'forbidden_value', `${field} 的取值被合同禁止`));
    }
    issues.push(issue(path, 'forbidden_value', `禁止的取值：${forbidden.join('、')}（自动重发许可恒为 false）`));
  }
  return issues;
}

export function validateCompanionError(raw: unknown): ValidationResult<CompanionError> {
  const path = 'error';
  const issues = validateShape(raw, ERROR_REQUIRED_KEYS, [], path);
  if (issues.length > 0) return rejected(issues);
  const obj = raw as Record<string, unknown>;

  issues.push(...validateEnumValue(obj['code'], LOCAL_ERROR_CODES, `${path}.code`));
  issues.push(...validateText(obj['message'], `${path}.message`));
  issues.push(...validateEnumValue(obj['delivery'], DELIVERY_CERTAINTIES, `${path}.delivery`));
  issues.push(...validateIsoTimestamp(obj['observedAt'], `${path}.observedAt`));
  issues.push(...validateRetryAdvice(obj['retry'], obj['delivery'], `${path}.retry`));
  issues.push(...validateDetail(obj['detail'], `${path}.detail`));
  if (issues.length > 0) return rejected(issues);

  return accepted({
    code: obj['code'] as LocalErrorCode,
    message: obj['message'] as string,
    delivery: obj['delivery'] as DeliveryCertainty,
    observedAt: obj['observedAt'] as string,
    detail: obj['detail'] as Readonly<Record<string, string | number | boolean>>,
    retry: obj['retry'] as RetryAdvice
  });
}

const NOT_SUBMITTED_GUIDANCE =
  '投递确定性为 not_submitted：确认没有任何请求离开本产品边界。重发不会造成重复执行，但重发必须由人显式决定，系统不得自动重发。';
/**
 * `submitted_rejected` = **已投递、上游明确拒绝、结果确定且未执行**。
 *
 * 文案必须与同对象里被强制的 `resendWouldNotDuplicate: false` 同向（REV3-I4-1）：
 * 重发**可能**造成重复执行，所以不得写成"重发不会造成重复执行"——那是布尔量在说反话，
 * 会让人以为重发是安全操作。同时它也**不得**暗示自动重发：`autoResendAllowed` 恒为
 * `false`，重发一律要人显式决定。
 */
const REJECTED_GUIDANCE =
  '投递确定性为 submitted_rejected：已投递，上游明确拒绝，结果确定且未执行。重发仍可能造成重复执行，不能视为安全操作；任何重发都必须由人显式决定，系统不得自动重发。';
const UNKNOWN_GUIDANCE =
  '投递确定性为 outcome_unknown：结果不可知，重发可能造成重复执行。禁止自动重发；任何"可重试"提示都只是给人看的说明，必须由人工显式决定后才能重发。';

export function retryGuidanceFor(delivery: DeliveryCertainty): string {
  if (delivery === 'not_submitted') return NOT_SUBMITTED_GUIDANCE;
  if (delivery === 'submitted_rejected') return REJECTED_GUIDANCE;
  return UNKNOWN_GUIDANCE;
}

/**
 * 构造错误 DTO。`detail` 由调用方提供但会被复制一份，调用方后续修改不会渗进 DTO；
 * 敏感内容请在构造前剔除——校验器会在使用前再次拒绝。
 */
export function toCompanionError(
  code: LocalErrorCode,
  message: string,
  delivery: DeliveryCertainty,
  observedAt: string,
  detail: Readonly<Record<string, string | number | boolean>> = {}
): CompanionError {
  return {
    code,
    message,
    delivery,
    observedAt,
    detail: { ...detail },
    retry: {
      autoResendAllowed: false,
      requiresExplicitHumanDecision: true,
      resendWouldNotDuplicate: deriveResendWouldNotDuplicate(delivery),
      guidance: retryGuidanceFor(delivery)
    }
  };
}
