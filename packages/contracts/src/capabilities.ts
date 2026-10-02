/**
 * I04 能力合同：普通能力状态、安全能力枚举、机制/行为分层与"允许入口"映射。
 *
 * 本模块存在的唯一理由是把一件容易被糊弄的事变成**可机检**的事实：
 *
 * > 枚举里带 "verified" 五个字母 ≠ 这个能力对外可用。
 *
 * 929 要求把"机制已证"和"行为已证"严格分开：
 *  - **行为（behavior）**：真的在当前版本上跑过、真的观察到预期效果。
 *    `CapabilityState.behavior_verified` 与 `exactCancel.verified` 属于这一层。
 *  - **机制（mechanism）**：零发送条件下已经证明"官方支持依据 + 控制读回 +
 *    provider-free 反例"足以支撑某个**受限**结论——通常是一个**禁用**或
 *    **映射**类结论。`nativeTools.disabled_verified`、`automaticRetry.disabled_verified`、
 *    `inputTerminalCorrelation.verified`、`billingEvidence.verified_mapping`、
 *    `roleFidelity.native_verified` 与 `exactCancel.mechanism_verified` 属于这一层。
 *
 * 因此本文件给出三张表和两个函数，把
 * `枚举取值 → 证据层级 → 是否打开对外入口` 变成查表 + 比较，而不是字符串包含判断：
 *  - `CAPABILITY_EVIDENCE_LAYER`：取值 → 证据层级
 *  - `CAPABILITY_GATES`：能力 → 入口 + 所需最低层级
 *  - `describeCapability()`：把上面两张表合成一个可断言的结论
 *  - `capabilityMatrix()`：整张表导出，供审计与快照比对
 *
 * 结构性后果（刻意如此，不是遗漏）：`inputTerminalCorrelation` 与 `roleFidelity`
 * **没有任何行为层取值**，因此它们的入口 `opens` 恒为 `false`。机制证据不足以
 * 让"终态可信"或"角色保真"对外成立——这是 fail-closed，不是待补的空缺。
 *
 * 全部取值都是**本产品自己的类型**。本文件不声称官方 RPC 存在同名字段，
 * 也不接受上游整块 config / unknown 外传。
 */
import {
  CONTRACT_LIMITS,
  type ContractIssue,
  type ValidationResult,
  accepted,
  collectSensitiveIssues,
  issue,
  rejected,
  validateEnumValue,
  validateIdentifier,
  validateIsoTimestamp,
  validateShape,
  validateStringList
} from './errors.js';

/* -------------------------------------------------------------------------- */
/* 普通能力                                                                    */
/* -------------------------------------------------------------------------- */

export const CAPABILITY_STATES = ['unknown', 'unsupported', 'mechanism_verified', 'behavior_verified'] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

/** 一切能力位的出厂默认。`unknown` 不是"暂缺实现"，是"权益未确认，按不可用处理"。 */
export const DEFAULT_CAPABILITY_STATE: CapabilityState = 'unknown';

export const RUNTIME_CAPABILITY_KEYS = [
  'accountReady',
  'text',
  'externalToolRoundTrip',
  'structuredReasoning',
  'quotaRead',
  'ownSessionResume'
] as const;
export type RuntimeCapabilityKey = (typeof RUNTIME_CAPABILITY_KEYS)[number];

/**
 * 对外可用 = 行为已证。
 *
 * `mechanism_verified` 在这里返回 `false` 是本模块最关键的一条判定：
 * 它只支撑"已禁用 / 映射成立"这类受限结论，不支撑"这个能力可以用"。
 */
export function isExternallyAvailable(state: CapabilityState): boolean {
  return state === 'behavior_verified';
}

export function defaultRuntimeCapabilityStates(): Readonly<Record<RuntimeCapabilityKey, CapabilityState>> {
  const out = {} as Record<RuntimeCapabilityKey, CapabilityState>;
  for (const key of RUNTIME_CAPABILITY_KEYS) out[key] = DEFAULT_CAPABILITY_STATE;
  return out;
}

/* -------------------------------------------------------------------------- */
/* 安全能力枚举（每个能力一套独立取值域，互不通用）                              */
/* -------------------------------------------------------------------------- */

/** `verified` 表示精确的真实取消行为；`mechanism_verified` 只表示取消机制已证。 */
export const EXACT_CANCEL_STATES = ['mechanism_verified', 'verified', 'unsupported', 'unknown'] as const;
export type ExactCancelState = (typeof EXACT_CANCEL_STATES)[number];

/** 原生工具：只承认"已证明被禁用"。plan / deny 状态不等于禁用。 */
export const NATIVE_TOOLS_STATES = ['disabled_verified', 'unsupported', 'unknown'] as const;
export type NativeToolsState = (typeof NATIVE_TOOLS_STATES)[number];

/** 自动重试：只承认"已证明没有自动重试"。 */
export const AUTOMATIC_RETRY_STATES = ['disabled_verified', 'unknown'] as const;
export type AutomaticRetryState = (typeof AUTOMATIC_RETRY_STATES)[number];

/** 输入与终态关联：`verified` 仍是机制层，不足以对外宣称终态可信。 */
export const INPUT_TERMINAL_CORRELATION_STATES = ['verified', 'unknown'] as const;
export type InputTerminalCorrelationState = (typeof INPUT_TERMINAL_CORRELATION_STATES)[number];

/** 计费映射：`verified_mapping` 表示映射关系已证，不表示额度已读回。 */
export const BILLING_EVIDENCE_STATES = ['verified_mapping', 'unknown'] as const;
export type BillingEvidenceState = (typeof BILLING_EVIDENCE_STATES)[number];

/** 角色保真：缺失一律 `unknown`；`native_verified` 需绑定语义机制 + 后续真实行为记录。 */
export const ROLE_FIDELITY_STATES = ['native_verified', 'unsupported', 'unknown'] as const;
export type RoleFidelityState = (typeof ROLE_FIDELITY_STATES)[number];

export const ROLE_KINDS = ['system', 'developer', 'user', 'assistant', 'tool'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export function defaultRoleFidelity(): Readonly<Record<RoleKind, RoleFidelityState>> {
  const out = {} as Record<RoleKind, RoleFidelityState>;
  for (const role of ROLE_KINDS) out[role] = 'unknown';
  return out;
}

/* -------------------------------------------------------------------------- */
/* 证据层级与允许入口                                                          */
/* -------------------------------------------------------------------------- */

export type EvidenceLayer = 'none' | 'mechanism' | 'behavior';

const LAYER_RANK: Readonly<Record<EvidenceLayer, number>> = { none: 0, mechanism: 1, behavior: 2 };

/** 允许被打开的对外入口。每一项都必须有明确的所需证据层级。 */
export type CapabilityEntry =
  | 'capability_available'
  | 'exact_cancel_control'
  | 'native_tools_disabled'
  | 'automatic_retry_disabled'
  | 'terminal_correlation'
  | 'billing_mapping_display'
  | 'role_composition';

export const CAPABILITY_GATE_KEYS = [
  ...RUNTIME_CAPABILITY_KEYS,
  'exactCancel',
  'nativeTools',
  'automaticRetry',
  'inputTerminalCorrelation',
  'billingEvidence',
  'roleFidelity'
] as const;
export type CapabilityGateKey = (typeof CAPABILITY_GATE_KEYS)[number];

export interface CapabilityGateRule {
  readonly entry: CapabilityEntry;
  /** 打开该入口所需的最低证据层级。 */
  readonly requiredLayer: EvidenceLayer;
}

/** 每个能力自己的取值域。跨能力取值在这里就查不到。 */
export const CAPABILITY_STATES_FOR: Readonly<Record<CapabilityGateKey, readonly string[]>> = {
  accountReady: CAPABILITY_STATES,
  text: CAPABILITY_STATES,
  externalToolRoundTrip: CAPABILITY_STATES,
  structuredReasoning: CAPABILITY_STATES,
  quotaRead: CAPABILITY_STATES,
  ownSessionResume: CAPABILITY_STATES,
  exactCancel: EXACT_CANCEL_STATES,
  nativeTools: NATIVE_TOOLS_STATES,
  automaticRetry: AUTOMATIC_RETRY_STATES,
  inputTerminalCorrelation: INPUT_TERMINAL_CORRELATION_STATES,
  billingEvidence: BILLING_EVIDENCE_STATES,
  roleFidelity: ROLE_FIDELITY_STATES
};

/**
 * 取值 → 证据层级。这是全模块唯一判定"verified 到底证明了什么"的地方。
 *
 * 注意 `mechanism_verified` 与 `disabled_verified` / `verified_mapping` /
 * `native_verified` / `inputTerminalCorrelation.verified` 全部落在**机制**层，
 * 没有任何一个被提升到行为层——它们证明的是"官方支持依据 + 控制读回 +
 * provider-free 反例"这个**机制**成立，不是一次真实行为验收。
 */
export const CAPABILITY_EVIDENCE_LAYER: Readonly<Record<CapabilityGateKey, Readonly<Record<string, EvidenceLayer>>>> = {
  accountReady: { unknown: 'none', unsupported: 'none', mechanism_verified: 'mechanism', behavior_verified: 'behavior' },
  text: { unknown: 'none', unsupported: 'none', mechanism_verified: 'mechanism', behavior_verified: 'behavior' },
  externalToolRoundTrip: { unknown: 'none', unsupported: 'none', mechanism_verified: 'mechanism', behavior_verified: 'behavior' },
  structuredReasoning: { unknown: 'none', unsupported: 'none', mechanism_verified: 'mechanism', behavior_verified: 'behavior' },
  quotaRead: { unknown: 'none', unsupported: 'none', mechanism_verified: 'mechanism', behavior_verified: 'behavior' },
  ownSessionResume: { unknown: 'none', unsupported: 'none', mechanism_verified: 'mechanism', behavior_verified: 'behavior' },
  // verified = 精确真实取消行为（行为层）；mechanism_verified = 只证到机制
  exactCancel: { unknown: 'none', unsupported: 'none', mechanism_verified: 'mechanism', verified: 'behavior' },
  // 只承认"已证禁用"，且禁用类结论机制层即可成立
  nativeTools: { unknown: 'none', unsupported: 'none', disabled_verified: 'mechanism' },
  automaticRetry: { unknown: 'none', disabled_verified: 'mechanism' },
  // verified 只是机制：不足以让"终态可信"对外成立
  inputTerminalCorrelation: { unknown: 'none', verified: 'mechanism' },
  billingEvidence: { unknown: 'none', verified_mapping: 'mechanism' },
  // native_verified 需绑定后续真实行为记录才能对外公开
  roleFidelity: { unknown: 'none', unsupported: 'none', native_verified: 'mechanism' }
};

/** 能力 → 入口 + 所需最低证据层级。 */
export const CAPABILITY_GATES: Readonly<Record<CapabilityGateKey, CapabilityGateRule>> = {
  accountReady: { entry: 'capability_available', requiredLayer: 'behavior' },
  text: { entry: 'capability_available', requiredLayer: 'behavior' },
  externalToolRoundTrip: { entry: 'capability_available', requiredLayer: 'behavior' },
  structuredReasoning: { entry: 'capability_available', requiredLayer: 'behavior' },
  quotaRead: { entry: 'capability_available', requiredLayer: 'behavior' },
  ownSessionResume: { entry: 'capability_available', requiredLayer: 'behavior' },
  // 精确取消是行为结论：机制已证不能打开取消控件
  exactCancel: { entry: 'exact_cancel_control', requiredLayer: 'behavior' },
  // "已禁用"本身就是机制结论，机制层即可成立
  nativeTools: { entry: 'native_tools_disabled', requiredLayer: 'mechanism' },
  automaticRetry: { entry: 'automatic_retry_disabled', requiredLayer: 'mechanism' },
  // 没有任何行为层取值 → 恒不打开
  inputTerminalCorrelation: { entry: 'terminal_correlation', requiredLayer: 'behavior' },
  billingEvidence: { entry: 'billing_mapping_display', requiredLayer: 'mechanism' },
  roleFidelity: { entry: 'role_composition', requiredLayer: 'behavior' }
};

export type CapabilityLookup =
  | {
      readonly ok: true;
      readonly key: CapabilityGateKey;
      readonly state: string;
      readonly layer: EvidenceLayer;
      readonly entry: CapabilityEntry;
      /** 证据层级是否达到该入口的要求。`false` 表示对外仍不可用。 */
      readonly opens: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'unknown_capability' | 'unknown_state';
      readonly key: string;
      readonly state: string;
    };

function isCapabilityGateKey(key: string): key is CapabilityGateKey {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_GATES, key);
}

/**
 * 枚举 → 证据层级 → 允许入口 的唯一判定入口。
 *
 * 查不到就是查不到：未知能力名返回 `unknown_capability`，别的能力的 verified 取值
 * 返回 `unknown_state`。它**不会**因为字符串里含 "verified" 就降级接受，
 * 更不会把机制层当成行为层放行。
 */
export function describeCapability(key: string, state: string): CapabilityLookup {
  if (!isCapabilityGateKey(key)) {
    return { ok: false, reason: 'unknown_capability', key, state };
  }
  const layers = CAPABILITY_EVIDENCE_LAYER[key];
  if (!Object.prototype.hasOwnProperty.call(layers, state)) {
    return { ok: false, reason: 'unknown_state', key, state };
  }
  const gate = CAPABILITY_GATES[key];
  const layer: EvidenceLayer = layers[state] ?? 'none';
  const opens = layer !== 'none' && LAYER_RANK[layer] >= LAYER_RANK[gate.requiredLayer];
  return { ok: true, key, state, layer, entry: gate.entry, opens };
}

export function isBehaviorProven(key: string, state: string): boolean {
  const looked = describeCapability(key, state);
  return looked.ok && looked.layer === 'behavior';
}

export function isMechanismProven(key: string, state: string): boolean {
  const looked = describeCapability(key, state);
  return looked.ok && looked.layer === 'mechanism';
}

/** 五个 role 全部达到行为层才算角色保真可对外；机制层一律不够。 */
export function roleFidelityOpensComposition(
  fidelity: Readonly<Record<RoleKind, RoleFidelityState>>
): boolean {
  return ROLE_KINDS.every((role) => {
    const looked = describeCapability('roleFidelity', fidelity[role]);
    return looked.ok && looked.opens;
  });
}

export interface CapabilityMatrixRow {
  readonly key: CapabilityGateKey;
  readonly state: string;
  readonly layer: EvidenceLayer;
  readonly entry: CapabilityEntry;
  readonly opens: boolean;
}

/** 整张映射表导出，供审计、快照比对与界面口径核对。 */
export function capabilityMatrix(): readonly CapabilityMatrixRow[] {
  const rows: CapabilityMatrixRow[] = [];
  for (const key of CAPABILITY_GATE_KEYS) {
    for (const state of CAPABILITY_STATES_FOR[key]) {
      const looked = describeCapability(key, state);
      if (!looked.ok) {
        throw new Error(`capability table is not exhaustive: ${key}.${state}`);
      }
      rows.push({ key, state, layer: looked.layer, entry: looked.entry, opens: looked.opens });
    }
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* 安全能力集合与运行时能力描述                                                */
/* -------------------------------------------------------------------------- */

export interface SafetyCapabilities {
  readonly exactCancel: ExactCancelState;
  readonly nativeTools: NativeToolsState;
  readonly automaticRetry: AutomaticRetryState;
  readonly inputTerminalCorrelation: InputTerminalCorrelationState;
  readonly billingEvidence: BillingEvidenceState;
  readonly roleFidelity: Readonly<Record<RoleKind, RoleFidelityState>>;
}

export function defaultSafetyCapabilities(): SafetyCapabilities {
  return {
    exactCancel: 'unknown',
    nativeTools: 'unknown',
    automaticRetry: 'unknown',
    inputTerminalCorrelation: 'unknown',
    billingEvidence: 'unknown',
    roleFidelity: defaultRoleFidelity()
  };
}

const SAFETY_KEYS = [
  'exactCancel',
  'nativeTools',
  'automaticRetry',
  'inputTerminalCorrelation',
  'billingEvidence',
  'roleFidelity'
] as const;

export function validateSafetyCapabilities(raw: unknown): ValidationResult<SafetyCapabilities> {
  const path = 'caps';
  const issues: ContractIssue[] = validateShape(raw, SAFETY_KEYS, [], path);
  if (issues.length > 0) return rejected(issues);
  const obj = raw as Record<string, unknown>;

  issues.push(...validateEnumValue(obj['exactCancel'], EXACT_CANCEL_STATES, `${path}.exactCancel`));
  issues.push(...validateEnumValue(obj['nativeTools'], NATIVE_TOOLS_STATES, `${path}.nativeTools`));
  issues.push(...validateEnumValue(obj['automaticRetry'], AUTOMATIC_RETRY_STATES, `${path}.automaticRetry`));
  issues.push(
    ...validateEnumValue(obj['inputTerminalCorrelation'], INPUT_TERMINAL_CORRELATION_STATES, `${path}.inputTerminalCorrelation`)
  );
  issues.push(...validateEnumValue(obj['billingEvidence'], BILLING_EVIDENCE_STATES, `${path}.billingEvidence`));

  const rolePath = `${path}.roleFidelity`;
  const roleIssues = validateShape(obj['roleFidelity'], ROLE_KINDS, [], rolePath);
  issues.push(...roleIssues);
  if (roleIssues.length === 0) {
    const roles = obj['roleFidelity'] as Record<string, unknown>;
    for (const role of ROLE_KINDS) {
      issues.push(...validateEnumValue(roles[role], ROLE_FIDELITY_STATES, `${rolePath}.${role}`));
    }
  }
  if (issues.length > 0) return rejected(issues);

  return accepted({
    exactCancel: obj['exactCancel'] as ExactCancelState,
    nativeTools: obj['nativeTools'] as NativeToolsState,
    automaticRetry: obj['automaticRetry'] as AutomaticRetryState,
    inputTerminalCorrelation: obj['inputTerminalCorrelation'] as InputTerminalCorrelationState,
    billingEvidence: obj['billingEvidence'] as BillingEvidenceState,
    roleFidelity: obj['roleFidelity'] as Readonly<Record<RoleKind, RoleFidelityState>>
  });
}

/** 运行时来源唯一值。禁止出现 dsh / 第三方宿主等其他来源。 */
export const RUNTIME_SOURCE = 'official-app-server' as const;
export type RuntimeSource = typeof RUNTIME_SOURCE;

export interface RuntimeCapability {
  readonly version: string;
  /** 官方包 SHA-256，64 位小写十六进制。是指纹，不是凭据。 */
  readonly fingerprint: string;
  readonly source: RuntimeSource;
  readonly evidenceRefs: readonly string[];
  readonly accountEpoch: string;
  readonly catalogRevision: string;
  readonly observedAt: string;
  /**
   * 过期时刻。`null` 表示**过期时间未知**，按 fail-closed 处理，
   * 绝不解释为"永久有效"（`isRuntimeCapabilityFresh` 对 `null` 返回 `false`）。
   */
  readonly expiresAt: string | null;
}

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const RUNTIME_REQUIRED_KEYS = [
  'version',
  'fingerprint',
  'source',
  'evidenceRefs',
  'accountEpoch',
  'catalogRevision',
  'observedAt',
  'expiresAt'
] as const;

export function validateRuntimeCapability(raw: unknown): ValidationResult<RuntimeCapability> {
  const path = 'runtime';
  const issues = validateShape(raw, RUNTIME_REQUIRED_KEYS, [], path);
  if (issues.length > 0) return rejected(issues);
  const obj = raw as Record<string, unknown>;

  issues.push(...validateIdentifier(obj['version'], `${path}.version`));
  const fingerprint: unknown = obj['fingerprint'];
  if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) {
    issues.push(issue(`${path}.fingerprint`, 'invalid_value', '必须是 64 位小写十六进制 SHA-256'));
  }
  issues.push(...validateEnumValue(obj['source'], [RUNTIME_SOURCE], `${path}.source`));
  issues.push(...validateStringList(obj['evidenceRefs'], `${path}.evidenceRefs`, CONTRACT_LIMITS.arrayMaxItems));
  issues.push(...validateIdentifier(obj['accountEpoch'], `${path}.accountEpoch`));
  issues.push(...validateIdentifier(obj['catalogRevision'], `${path}.catalogRevision`));
  issues.push(...validateIsoTimestamp(obj['observedAt'], `${path}.observedAt`));

  const expiresAt: unknown = obj['expiresAt'];
  if (expiresAt === null) {
    // 可空位：null 合法，但语义是"过期时间未知"。
  } else {
    issues.push(...validateIsoTimestamp(expiresAt, `${path}.expiresAt`));
  }

  if (issues.length > 0) return rejected(issues);
  return accepted({
    version: obj['version'] as string,
    fingerprint: fingerprint as string,
    source: obj['source'] as RuntimeSource,
    evidenceRefs: obj['evidenceRefs'] as readonly string[],
    accountEpoch: obj['accountEpoch'] as string,
    catalogRevision: obj['catalogRevision'] as string,
    observedAt: obj['observedAt'] as string,
    expiresAt: expiresAt as string | null
  });
}

/**
 * 证据是否仍然新鲜。`expiresAt === null` 一律判为**不新鲜**：
 * 过期时间未知不允许被当作永不过期。
 */
export function isRuntimeCapabilityFresh(runtime: RuntimeCapability, now: Date): boolean {
  if (runtime.expiresAt === null) return false;
  const expires = Date.parse(runtime.expiresAt);
  if (!Number.isFinite(expires)) return false;
  return expires > now.getTime();
}

/** 供上层复用的敏感内容扫描（能力描述也可能被塞进事件 payload）。 */
export function scanForSensitiveFields(value: unknown, path: string): readonly ContractIssue[] {
  return collectSensitiveIssues(value, path);
}
