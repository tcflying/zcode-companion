/**
 * I04 操作合同：窗口策略、计费通道、模型精确引用、发送准入、操作十态。
 *
 * 四条硬事实：
 *  1. `WindowMode` 默认 `advisory`；`off` 只关掉窗口**提示**，安全校验不随之关闭。
 *     旧版布尔配置只允许经 `migrateLegacyWindowMode()` 这一个迁移层进入
 *     （`true → enforce`、`false → advisory`），`parseWindowMode()` 本身对布尔值
 *     一律拒绝——迁移是显式动作，不是解析器的隐式兜底。
 *  2. `metered_api` 与 `unknown` 永不准入；`subscription` 与 `promotion` 是合法
 *     订阅通道（promotion 是官方活动优惠，同样走套餐计费，不是按量计费）。
 *     计费类别**永不**从显示名推断——名字里带 `-free` 也不构成任何权益。
 *  3. `ModelRef` 的每个标识都精确匹配；`effort` 是可空位，`null` 表示未声明，
 *     与 `undefined`（没传）和 `''`（传了空）三者互不等价。
 *  4. 十态里的 `not_submitted` 与 `outcome_unknown` 是**投递确定性**的两种事实，
 *     任何一个都不允许自动重发。`AUTO_RESEND_ALLOWED_BY_STATE` 的取值类型被钉死为
 *     字面量 `false`，写一个 `true` 会直接编译失败。
 */
import {
  CONTRACT_LIMITS,
  type ContractIssue,
  type ValidationResult,
  accepted,
  issue,
  rejected,
  validateBoolean,
  validateEnumValue,
  validateIdentifier,
  validateShape,
  validateStringList
} from './errors.js';

/* -------------------------------------------------------------------------- */
/* 窗口策略                                                                    */
/* -------------------------------------------------------------------------- */

export const WINDOW_MODES = ['enforce', 'advisory', 'off'] as const;
export type WindowMode = (typeof WINDOW_MODES)[number];

/** 默认 advisory：窗口外提示，不阻断。 */
export const DEFAULT_WINDOW_MODE: WindowMode = 'advisory';

/** 严格解析。布尔值在这里**不**被接受——兼容只能经迁移层。 */
export function parseWindowMode(raw: unknown): ValidationResult<WindowMode> {
  if (typeof raw !== 'string') {
    return rejected([
      issue('windowMode', 'invalid_type', `WindowMode 必须是字符串枚举 ${WINDOW_MODES.join(' | ')}，不接受布尔值`)
    ]);
  }
  const issues = validateEnumValue(raw, WINDOW_MODES, 'windowMode');
  if (issues.length > 0) return rejected(issues);
  return accepted(raw as WindowMode);
}

/**
 * 唯一迁移层。`true → enforce`、`false → advisory`，其余按严格枚举处理。
 * 非布尔的非法值仍然拒绝——迁移层不吞掉它看不懂的输入。
 */
export function migrateLegacyWindowMode(raw: unknown): ValidationResult<WindowMode> {
  if (raw === true) return accepted('enforce');
  if (raw === false) return accepted('advisory');
  return parseWindowMode(raw);
}

/* -------------------------------------------------------------------------- */
/* 计费通道                                                                    */
/* -------------------------------------------------------------------------- */

export const BILLING_CLASSES = ['subscription', 'promotion', 'metered_api', 'unknown'] as const;
export type BillingClass = (typeof BILLING_CLASSES)[number];

/** 永不准入的两个取值。单独成表，便于上层直接遍历断言。 */
export const NEVER_SENDABLE_BILLING_CLASSES: readonly BillingClass[] = ['metered_api', 'unknown'];

export const BILLING_CLASS_SENDABLE: Readonly<Record<BillingClass, boolean>> = {
  subscription: true,
  promotion: true,
  metered_api: false,
  unknown: false
};

export function isBillingClassSendable(billingClass: BillingClass): boolean {
  return BILLING_CLASS_SENDABLE[billingClass];
}

/**
 * 显示名 → 计费类别。**恒为 `unknown`**。
 *
 * 这是把一条政策写成可执行事实：权益只来自权威读数与资格证据，
 * 绝不来自名字。`some-model-free`、`FREE unlimited` 之类的名字不改变任何结论，
 * 恒定落到 `unknown` → 恒定不可发送。
 */
export function deriveBillingClassFromDisplayName(_displayName: string): BillingClass {
  return 'unknown';
}

/* -------------------------------------------------------------------------- */
/* 操作十态                                                                    */
/* -------------------------------------------------------------------------- */

export const OPERATION_STATES = [
  'prepared',
  'queued',
  'dispatching',
  'accepted',
  'running',
  'completed',
  'failed',
  'cancelled',
  'not_submitted',
  'outcome_unknown'
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const TERMINAL_OPERATION_STATES: readonly OperationState[] = [
  'completed',
  'failed',
  'cancelled',
  'not_submitted',
  'outcome_unknown'
];

export const NON_TERMINAL_OPERATION_STATES: readonly OperationState[] = [
  'prepared',
  'queued',
  'dispatching',
  'accepted',
  'running'
];

export function isTerminalOperationState(state: OperationState): boolean {
  return TERMINAL_OPERATION_STATES.includes(state);
}

/**
 * 自动重发许可表。全部为 `false`，且类型被钉死为字面量 `false`。
 * 新增一个操作态时必须显式表态——漏写就是编译错误。
 */
export const AUTO_RESEND_ALLOWED_BY_STATE: Readonly<Record<OperationState, false>> = {
  prepared: false,
  queued: false,
  dispatching: false,
  accepted: false,
  running: false,
  completed: false,
  failed: false,
  cancelled: false,
  not_submitted: false,
  outcome_unknown: false
};

export function canAutomaticallyResend(state: OperationState): false {
  return AUTO_RESEND_ALLOWED_BY_STATE[state];
}

/**
 * 仅凭状态判断"重发会不会造成重复执行"。**只作启发式**。
 *
 * 权威答案是错误 DTO 里的 `delivery`：一个 `failed` 操作的投递确定性由错误携带，
 * 不能由状态名推断。因此本函数在 `failed` 上返回 `false`，并且文档上明确
 * 上层必须以错误 DTO 为准。
 */
export function resendWouldNotDuplicateState(state: OperationState): boolean {
  if (state === 'not_submitted' || state === 'prepared' || state === 'queued') return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* 模型精确引用                                                                */
/* -------------------------------------------------------------------------- */

export interface ModelRef {
  readonly catalogId: string;
  readonly providerId: string;
  readonly modelId: string;
  /** 推理档位；`null` = 未声明。与 `undefined`（没传）、`''`（传了空）都不等价。 */
  readonly effort: string | null;
  readonly accountEpoch: string;
  readonly catalogRevision: string;
}

const MODEL_REQUIRED_KEYS = ['catalogId', 'providerId', 'modelId', 'effort', 'accountEpoch', 'catalogRevision'] as const;

export function validateModelRef(raw: unknown): ValidationResult<ModelRef> {
  const path = 'model';
  const issues = validateShape(raw, MODEL_REQUIRED_KEYS, [], path);
  if (issues.length > 0) return rejected(issues);
  const obj = raw as Record<string, unknown>;

  issues.push(...validateIdentifier(obj['catalogId'], `${path}.catalogId`));
  issues.push(...validateIdentifier(obj['providerId'], `${path}.providerId`));
  issues.push(...validateIdentifier(obj['modelId'], `${path}.modelId`));
  issues.push(...validateIdentifier(obj['accountEpoch'], `${path}.accountEpoch`));
  issues.push(...validateIdentifier(obj['catalogRevision'], `${path}.catalogRevision`));

  const effort: unknown = obj['effort'];
  if (effort !== null) {
    issues.push(...validateIdentifier(effort, `${path}.effort`));
  }

  if (issues.length > 0) return rejected(issues);
  return accepted({
    catalogId: obj['catalogId'] as string,
    providerId: obj['providerId'] as string,
    modelId: obj['modelId'] as string,
    effort: effort as string | null,
    accountEpoch: obj['accountEpoch'] as string,
    catalogRevision: obj['catalogRevision'] as string
  });
}

/** 逐字段精确比较。`effort: null` 与 `effort: 'high'` 不相等。 */
export function modelRefEquals(left: ModelRef, right: ModelRef): boolean {
  return (
    left.catalogId === right.catalogId &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.effort === right.effort &&
    left.accountEpoch === right.accountEpoch &&
    left.catalogRevision === right.catalogRevision
  );
}

/* -------------------------------------------------------------------------- */
/* 发送准入                                                                    */
/* -------------------------------------------------------------------------- */

/** 证据等级。与界面 `apps/ui/src/data/snapshot.ts` 的口径一致，不另造一套。 */
export const EVIDENCE_LEVELS = ['E0', 'E1', 'E2', 'E3'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

const EVIDENCE_RANK: Readonly<Record<EvidenceLevel, number>> = { E0: 0, E1: 1, E2: 2, E3: 3 };

/** 达到该等级及以上的资格/计费证据才允许发送。 */
export const MINIMUM_SEND_EVIDENCE: EvidenceLevel = 'E1';

export type AdmissionCode =
  | 'allowed'
  | 'model_missing'
  | 'billing_not_sendable'
  | 'evidence_insufficient'
  | 'window_closed_enforced';

export const ADMISSION_CODES: readonly AdmissionCode[] = [
  'allowed',
  'model_missing',
  'billing_not_sendable',
  'evidence_insufficient',
  'window_closed_enforced'
];

export interface AdmissionInput {
  readonly windowMode: WindowMode;
  readonly windowOpen: boolean;
  readonly billingClass: BillingClass;
  readonly evidenceLevel: EvidenceLevel;
  /** `null` 表示没有精确模型引用。 */
  readonly model: ModelRef | null;
  readonly configRevision: string;
}

export interface AdmissionDecision {
  readonly allowed: boolean;
  readonly code: AdmissionCode;
  readonly configRevision: string;
  readonly model: ModelRef | null;
  readonly billingClass: BillingClass;
  readonly windowMode: WindowMode;
  readonly windowOpen: boolean;
  readonly warnings: readonly string[];
}

/**
 * 准入判定。判定顺序即风险顺序，从"最硬的拒绝"到"最软的提示"：
 * 无模型 → 不可发送通道 → 证据不足 → 窗口强制 → 窗口提示。
 *
 * `off` 模式只关掉提示，不改变任何安全结论：它不会让 `metered_api` 变得可发。
 */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const base = {
    configRevision: input.configRevision,
    model: input.model,
    billingClass: input.billingClass,
    windowMode: input.windowMode,
    windowOpen: input.windowOpen
  };

  if (input.model === null) {
    return { allowed: false, code: 'model_missing', warnings: ['未提供精确模型引用：不猜 provider、不拼 modelId'], ...base };
  }
  if (!isBillingClassSendable(input.billingClass)) {
    return {
      allowed: false,
      code: 'billing_not_sendable',
      warnings: [`计费通道 ${input.billingClass} 永不准入：不换通道补发`],
      ...base
    };
  }
  if (EVIDENCE_RANK[input.evidenceLevel] < EVIDENCE_RANK[MINIMUM_SEND_EVIDENCE]) {
    return {
      allowed: false,
      code: 'evidence_insufficient',
      warnings: [`证据等级 ${input.evidenceLevel} 低于发送所需的 ${MINIMUM_SEND_EVIDENCE}`],
      ...base
    };
  }
  if (!input.windowOpen && input.windowMode === 'enforce') {
    return {
      allowed: false,
      code: 'window_closed_enforced',
      warnings: ['窗口外发送被 enforce 模式强制拒绝'],
      ...base
    };
  }

  const warnings: string[] = [];
  if (!input.windowOpen && input.windowMode === 'advisory') {
    warnings.push('窗口外发送：advisory 模式不阻断，但可能扣套餐');
  }
  if (input.billingClass === 'promotion') {
    warnings.push('promotion 为订阅通道：需活动有效期证据独立成立，目录出现活动条目不等于可立即发送');
  }
  return { allowed: true, code: 'allowed', warnings, ...base };
}

const ADMISSION_REQUIRED_KEYS = [
  'allowed',
  'code',
  'configRevision',
  'model',
  'billingClass',
  'windowMode',
  'windowOpen',
  'warnings'
] as const;

export function validateAdmissionDecision(raw: unknown): ValidationResult<AdmissionDecision> {
  const path = 'decision';
  const issues: ContractIssue[] = validateShape(raw, ADMISSION_REQUIRED_KEYS, [], path);
  if (issues.length > 0) return rejected(issues);
  const obj = raw as Record<string, unknown>;

  issues.push(...validateBoolean(obj['allowed'], `${path}.allowed`));
  issues.push(...validateEnumValue(obj['code'], ADMISSION_CODES, `${path}.code`));
  issues.push(...validateIdentifier(obj['configRevision'], `${path}.configRevision`));
  issues.push(...validateEnumValue(obj['billingClass'], BILLING_CLASSES, `${path}.billingClass`));
  issues.push(...validateEnumValue(obj['windowMode'], WINDOW_MODES, `${path}.windowMode`));
  issues.push(...validateBoolean(obj['windowOpen'], `${path}.windowOpen`));
  issues.push(...validateStringList(obj['warnings'], `${path}.warnings`, CONTRACT_LIMITS.arrayMaxItems));

  const model: unknown = obj['model'];
  if (model === null) {
    // 可空位。
  } else {
    const modelResult = validateModelRef(model);
    if (!modelResult.ok) {
      for (const modelIssue of modelResult.issues) {
        issues.push({ ...modelIssue, path: `${path}.${modelIssue.path}` });
      }
    }
  }

  // 自洽性：allowed 与 code 必须一致，且被拒的通道不允许出现在 allowed 决策里。
  const allowed = obj['allowed'];
  const code = obj['code'];
  if (typeof allowed === 'boolean' && typeof code === 'string' && (ADMISSION_CODES as readonly string[]).includes(code)) {
    if (allowed !== (code === 'allowed')) {
      issues.push(issue(`${path}.allowed`, 'forbidden_value', `allowed=${String(allowed)} 与 code=${code} 矛盾`));
    }
  }
  const billingClass: unknown = obj['billingClass'];
  if (allowed === true && typeof billingClass === 'string' && (BILLING_CLASSES as readonly string[]).includes(billingClass)) {
    if (!isBillingClassSendable(billingClass as BillingClass)) {
      issues.push(issue(`${path}.allowed`, 'forbidden_value', `计费通道 ${billingClass} 永不准入，不允许出现在 allowed 决策中`));
    }
  }
  if (allowed === true && (model === null || model === undefined)) {
    issues.push(issue(`${path}.model`, 'invalid_value', 'allowed 决策必须携带精确模型引用'));
  }
  if (allowed === true && obj['windowMode'] === 'enforce' && obj['windowOpen'] === false) {
    issues.push(issue(`${path}.allowed`, 'forbidden_value', 'enforce 模式 + 窗口关闭 不允许 allowed'));
  }
  if (code === 'window_closed_enforced' && obj['windowMode'] !== 'enforce') {
    issues.push(issue(`${path}.code`, 'forbidden_value', 'window_closed_enforced 只在 enforce 模式成立'));
  }
  if (code === 'billing_not_sendable' && typeof billingClass === 'string' && isBillingClassSendable(billingClass as BillingClass)) {
    issues.push(issue(`${path}.code`, 'forbidden_value', `计费通道 ${billingClass} 可发送，不能给出 billing_not_sendable`));
  }
  if (code === 'model_missing' && model !== null && model !== undefined) {
    issues.push(issue(`${path}.code`, 'forbidden_value', '携带精确模型引用时不能给出 model_missing'));
  }

  if (issues.length > 0) return rejected(issues);
  return accepted({
    allowed: obj['allowed'] as boolean,
    code: obj['code'] as AdmissionCode,
    configRevision: obj['configRevision'] as string,
    model: model as ModelRef | null,
    billingClass: obj['billingClass'] as BillingClass,
    windowMode: obj['windowMode'] as WindowMode,
    windowOpen: obj['windowOpen'] as boolean,
    warnings: obj['warnings'] as readonly string[]
  });
}
