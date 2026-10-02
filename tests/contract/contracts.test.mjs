/**
 * I04 合同测试 —— 能力 / 政策 / 错误 数据合同。
 *
 * Provider-free：零网络、零官方进程、零数据库、零子进程。纯函数合同断言。
 *
 * 本文件由 I04 拥有（唯一新增文件），不修改 I01 的任何既有文件。位置必须在
 * `tests/contract/` 下，否则 vitest 的 include 选不中，`test:contract` / `test`
 * 两个门会看不到本文件（禁止把新合同测试移出这两个门的视野）。
 *
 * 覆盖的硬事实（与 brief 红线一一对应）：
 *  - schema round-trip（校验 → 值 → 再校验，深相等）
 *  - 畸形输入 / 超长值（字符与 UTF-8 字节两个口径）/ 非法枚举
 *  - 零值与 undefined/null 分界（0 合法；undefined 拒绝；null 只在可空位合法）
 *  - 非法日期（语法合法但日历上不存在的时刻）
 *  - 敏感字段（apiKey / token / credential / Authorization / Bearer）不允许通过校验
 *  - unknown 能力不得对外呈现 true
 *  - mechanism_verified 不得被当作 behavior_verified 使用
 *  - 不同 verified 枚举之间不可互通
 *  - 未知但影响语义的字段按严格策略拒绝（不静默丢弃后当成功）
 *  - 投递确定性：not_submitted vs outcome_unknown；错误里的"可重试"建议不得
 *    导致未知结果被自动重发
 *  - unknown / 无关事件不得制造 terminal
 */
import { describe, it, expect } from 'vitest';
import * as contractErrors from '../../packages/contracts/src/errors.js';
import * as operation from '../../packages/contracts/src/operation.js';
import * as capabilities from '../../packages/contracts/src/capabilities.js';
import * as events from '../../packages/contracts/src/events.js';

/** @typedef {import('../../packages/contracts/src/errors.js').ContractIssue} ContractIssue */
/** @typedef {import('../../packages/contracts/src/errors.js').ValidationResult<unknown>} UnknownResult */

/** 真正的控制字符（NUL），用于验证标识符拒绝控制字符而不是"看起来奇怪的字符串"。 */
const NUL = String.fromCharCode(0);

/**
 * 断言校验失败并返回全部 issue。`expect(result.ok).toBe(false)` 是承重断言：
 * 若实现放行，`issues` 为 `[]`，紧随其后的非空断言会同时失败。
 *
 * `pathContains` 是**路径前缀**（`error` 命中 `error.detail.apiKey`），
 * 这样同一类缺陷的精确位置由实现自由组织，测试仍然要求"这一支必须有诊断"。
 * @param {UnknownResult} result
 * @param {string} [pathContains]
 * @returns {readonly ContractIssue[]}
 */
function expectRejected(result, pathContains) {
  const issues = result.ok ? [] : result.issues;
  expect(result.ok, 'expected validation to REJECT this input').toBe(false);
  expect(issues.length, 'a rejection must carry at least one issue').toBeGreaterThan(0);
  if (pathContains !== undefined) {
    const at = issues.filter(
      (i) => i.path === pathContains || i.path.startsWith(`${pathContains}.`) || i.path.startsWith(`${pathContains}[`)
    );
    expect(
      at.length,
      `expected an issue under path "${pathContains}", got ${JSON.stringify(issues.map((i) => i.path))}`
    ).toBeGreaterThan(0);
  }
  return issues;
}

/**
 * 断言校验通过并返回值。不通过时抛出，测试即失败（不是恒真断言，也不是 skip）。
 * @template T
 * @param {import('../../packages/contracts/src/errors.js').ValidationResult<T>} result
 * @returns {T}
 */
function acceptedValue(result) {
  if (result.ok) return result.value;
  throw new Error(`expected acceptance, got issues: ${JSON.stringify(result.issues)}`);
}

/** @returns {import('../../packages/contracts/src/operation.js').ModelRef} */
function validModelRef() {
  return {
    catalogId: 'catalog-entry-0001',
    providerId: 'provider-exact-id',
    modelId: 'model-exact-id',
    effort: null,
    accountEpoch: 'epoch-1',
    catalogRevision: 'rev-1'
  };
}

/** @returns {import('../../packages/contracts/src/capabilities.js').RuntimeCapability} */
function validRuntimeCapability() {
  return {
    version: '0.16.9',
    fingerprint: 'a'.repeat(64),
    source: 'official-app-server',
    evidenceRefs: ['evidence-1'],
    accountEpoch: 'epoch-1',
    catalogRevision: 'rev-1',
    observedAt: '2026-09-29T00:00:00.000Z',
    expiresAt: '2026-09-29T01:00:00.000Z'
  };
}

/** @returns {import('../../packages/contracts/src/events.js').CompanionEvent} */
function validEvent() {
  return {
    requestId: 'req-1',
    inputId: 'input-1',
    sessionId: 'session-1',
    generation: 0,
    eventSeq: 3,
    type: 'operation.state_changed',
    payload: { state: 'running', previousState: 'accepted', operationId: 'op-1' }
  };
}

/**
 * 期望的完整能力矩阵：`能力 → { 入口, 取值 → [证据层级, 是否打开入口] }`。
 *
 * 这是本工单最核心的一张表，整表钉死：任何一格改动都会让本测试变红。
 * @type {Record<string, { entry: string, states: Record<string, [string, boolean]> }>}
 */
const EXPECTED_CAPABILITY_MATRIX = {
  accountReady: {
    entry: 'capability_available',
    states: {
      unknown: ['none', false],
      unsupported: ['none', false],
      mechanism_verified: ['mechanism', false],
      behavior_verified: ['behavior', true]
    }
  },
  text: {
    entry: 'capability_available',
    states: {
      unknown: ['none', false],
      unsupported: ['none', false],
      mechanism_verified: ['mechanism', false],
      behavior_verified: ['behavior', true]
    }
  },
  externalToolRoundTrip: {
    entry: 'capability_available',
    states: {
      unknown: ['none', false],
      unsupported: ['none', false],
      mechanism_verified: ['mechanism', false],
      behavior_verified: ['behavior', true]
    }
  },
  structuredReasoning: {
    entry: 'capability_available',
    states: {
      unknown: ['none', false],
      unsupported: ['none', false],
      mechanism_verified: ['mechanism', false],
      behavior_verified: ['behavior', true]
    }
  },
  quotaRead: {
    entry: 'capability_available',
    states: {
      unknown: ['none', false],
      unsupported: ['none', false],
      mechanism_verified: ['mechanism', false],
      behavior_verified: ['behavior', true]
    }
  },
  ownSessionResume: {
    entry: 'capability_available',
    states: {
      unknown: ['none', false],
      unsupported: ['none', false],
      mechanism_verified: ['mechanism', false],
      behavior_verified: ['behavior', true]
    }
  },
  exactCancel: {
    entry: 'exact_cancel_control',
    states: {
      unknown: ['none', false],
      unsupported: ['none', false],
      mechanism_verified: ['mechanism', false],
      verified: ['behavior', true]
    }
  },
  nativeTools: {
    entry: 'native_tools_disabled',
    states: { unknown: ['none', false], unsupported: ['none', false], disabled_verified: ['mechanism', true] }
  },
  automaticRetry: {
    entry: 'automatic_retry_disabled',
    states: { unknown: ['none', false], disabled_verified: ['mechanism', true] }
  },
  inputTerminalCorrelation: {
    entry: 'terminal_correlation',
    states: { unknown: ['none', false], verified: ['mechanism', false] }
  },
  billingEvidence: {
    entry: 'billing_mapping_display',
    states: { unknown: ['none', false], verified_mapping: ['mechanism', true] }
  },
  roleFidelity: {
    entry: 'role_composition',
    states: { unknown: ['none', false], unsupported: ['none', false], native_verified: ['mechanism', false] }
  }
};

describe('I04 shared validation primitives', () => {
  it('plain-object check rejects null, arrays, class instances and exotic objects', () => {
    expect(contractErrors.isPlainObject({})).toBe(true);
    expect(contractErrors.isPlainObject(Object.create(null))).toBe(true);
    expect(contractErrors.isPlainObject([])).toBe(false);
    expect(contractErrors.isPlainObject(null)).toBe(false);
    expect(contractErrors.isPlainObject('a')).toBe(false);
    expect(contractErrors.isPlainObject(new Date(0))).toBe(false);
    expect(contractErrors.isPlainObject(new Map())).toBe(false);
  });

  it('utf8 byte length is counted in bytes, not code units', () => {
    expect(contractErrors.utf8ByteLength('abc')).toBe(3);
    expect(contractErrors.utf8ByteLength('模')).toBe(3);
    expect(contractErrors.utf8ByteLength('😀')).toBe(4);
  });

  it('identifier limits are enforced on characters AND utf8 bytes', () => {
    const max = contractErrors.CONTRACT_LIMITS.idMaxChars;
    expect(contractErrors.validateIdentifier('a'.repeat(max), 'id').length).toBe(0);
    const over = contractErrors.validateIdentifier('a'.repeat(max + 1), 'id');
    expect(over.length).toBeGreaterThan(0);
    expect(over.some((i) => i.code === 'too_long')).toBe(true);
    // 100 个中文字符 = 100 字符（未超字符上限）但 300 字节（超字节上限）
    const cjk = contractErrors.validateIdentifier('模'.repeat(100), 'id');
    expect(cjk.some((i) => i.code === 'too_long')).toBe(true);
  });

  it('identifier rejects empty, whitespace-padded, control-char and wildcard values', () => {
    expect(contractErrors.validateIdentifier('', 'id').some((i) => i.code === 'empty_value')).toBe(true);
    expect(contractErrors.validateIdentifier(' x', 'id').length).toBeGreaterThan(0);
    expect(contractErrors.validateIdentifier('x ', 'id').length).toBeGreaterThan(0);
    expect(contractErrors.validateIdentifier(`a${NUL}b`, 'id').length).toBeGreaterThan(0);
    // 通配必须被拒：标识符只做精确匹配
    expect(contractErrors.validateIdentifier('model-*', 'id').length).toBeGreaterThan(0);
    expect(contractErrors.validateIdentifier('*', 'id').length).toBeGreaterThan(0);
    // 内部空格是合法字符，不应被误杀
    expect(contractErrors.validateIdentifier('GLM 4.6', 'id').length).toBe(0);
  });

  it('identifier rejects non-strings, including undefined and null (they are not empty strings)', () => {
    expect(contractErrors.validateIdentifier(undefined, 'id').some((i) => i.code === 'invalid_type')).toBe(true);
    expect(contractErrors.validateIdentifier(null, 'id').some((i) => i.code === 'invalid_type')).toBe(true);
    expect(contractErrors.validateIdentifier(0, 'id').some((i) => i.code === 'invalid_type')).toBe(true);
  });

  it('iso timestamp rejects syntactically plausible but impossible dates', () => {
    expect(contractErrors.validateIsoTimestamp('2026-09-29T00:00:00.000Z', 't').length).toBe(0);
    expect(contractErrors.validateIsoTimestamp('2026-02-30T00:00:00.000Z', 't').length).toBeGreaterThan(0);
    expect(contractErrors.validateIsoTimestamp('2026-13-01T00:00:00.000Z', 't').length).toBeGreaterThan(0);
    expect(contractErrors.validateIsoTimestamp('2026-09-29', 't').length).toBeGreaterThan(0);
    expect(contractErrors.validateIsoTimestamp('not-a-date', 't').length).toBeGreaterThan(0);
    expect(contractErrors.validateIsoTimestamp('', 't').length).toBeGreaterThan(0);
    expect(contractErrors.validateIsoTimestamp(null, 't').some((i) => i.code === 'invalid_type')).toBe(true);
  });

  it('non-negative integer accepts 0 and rejects negatives, floats, NaN and Infinity', () => {
    expect(contractErrors.validateNonNegativeInteger(0, 'n').length).toBe(0);
    expect(contractErrors.validateNonNegativeInteger(-1, 'n').some((i) => i.code === 'invalid_number')).toBe(true);
    expect(contractErrors.validateNonNegativeInteger(1.5, 'n').some((i) => i.code === 'invalid_number')).toBe(true);
    expect(contractErrors.validateNonNegativeInteger(Number.NaN, 'n').some((i) => i.code === 'invalid_number')).toBe(true);
    expect(
      contractErrors.validateNonNegativeInteger(Number.POSITIVE_INFINITY, 'n').some((i) => i.code === 'invalid_number')
    ).toBe(true);
    expect(contractErrors.validateNonNegativeInteger('0', 'n').some((i) => i.code === 'invalid_type')).toBe(true);
  });

  it('sensitive keys and credential-shaped values are reported, recursively', () => {
    const issues = contractErrors.collectSensitiveIssues(
      { outer: { apiKey: 'x', nested: { authorization: 'Bearer abcdef123456' } } },
      'p'
    );
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.every((i) => i.code === 'sensitive_field')).toBe(true);
    const bearer = contractErrors.collectSensitiveIssues({ note: 'Bearer sk-abcdefghijklmnop' }, 'p');
    expect(bearer.some((i) => i.code === 'sensitive_field')).toBe(true);
    const jwt = contractErrors.collectSensitiveIssues({ note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef' }, 'p');
    expect(jwt.some((i) => i.code === 'sensitive_field')).toBe(true);
    expect(contractErrors.isSensitiveKey('api_key')).toBe(true);
    expect(contractErrors.isSensitiveKey('API-KEY')).toBe(true);
    expect(contractErrors.isSensitiveKey('fingerprint')).toBe(false);
  });

  it('a 64-hex fingerprint is evidence, not a credential', () => {
    const issues = contractErrors.collectSensitiveIssues({ fingerprint: 'a'.repeat(64) }, 'p');
    expect(issues.length).toBe(0);
  });
});

describe('I04 operation contract', () => {
  it('window mode is a strict enum and booleans are NOT accepted by the parser', () => {
    expect(acceptedValue(operation.parseWindowMode('advisory'))).toBe('advisory');
    expect(operation.DEFAULT_WINDOW_MODE).toBe('advisory');
    expectRejected(operation.parseWindowMode(true), 'windowMode');
    expectRejected(operation.parseWindowMode(false), 'windowMode');
    expectRejected(operation.parseWindowMode('ADVISORY'), 'windowMode');
    expectRejected(operation.parseWindowMode(null), 'windowMode');
    expectRejected(operation.parseWindowMode(undefined), 'windowMode');
  });

  it('the single migration layer maps legacy booleans true=enforce / false=advisory', () => {
    expect(acceptedValue(operation.migrateLegacyWindowMode(true))).toBe('enforce');
    expect(acceptedValue(operation.migrateLegacyWindowMode(false))).toBe('advisory');
    // 非布尔非法值仍然拒绝：迁移层不吞掉它看不懂的输入
    expectRejected(operation.migrateLegacyWindowMode('yes'), 'windowMode');
    expectRejected(operation.migrateLegacyWindowMode(1), 'windowMode');
    // 已经是合法枚举时原样通过
    expect(acceptedValue(operation.migrateLegacyWindowMode('off'))).toBe('off');
  });

  it('metered_api and unknown are never sendable; subscription and promotion are legal channels', () => {
    expect(operation.BILLING_CLASS_SENDABLE).toEqual({
      subscription: true,
      promotion: true,
      metered_api: false,
      unknown: false
    });
    expect(operation.NEVER_SENDABLE_BILLING_CLASSES).toEqual(['metered_api', 'unknown']);
    expect(operation.isBillingClassSendable('subscription')).toBe(true);
    expect(operation.isBillingClassSendable('promotion')).toBe(true);
    expect(operation.isBillingClassSendable('metered_api')).toBe(false);
    expect(operation.isBillingClassSendable('unknown')).toBe(false);
  });

  it('billing class is never inferred from a display name, including -free names', () => {
    expect(operation.deriveBillingClassFromDisplayName('GLM 4.6')).toBe('unknown');
    expect(operation.deriveBillingClassFromDisplayName('some-model-free')).toBe('unknown');
    expect(operation.deriveBillingClassFromDisplayName('FREE unlimited')).toBe('unknown');
    expect(operation.deriveBillingClassFromDisplayName('')).toBe('unknown');
  });

  it('operation state is exactly the ten frozen states and terminality is explicit', () => {
    expect(operation.OPERATION_STATES).toEqual([
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
    ]);
    expect(operation.TERMINAL_OPERATION_STATES).toEqual([
      'completed',
      'failed',
      'cancelled',
      'not_submitted',
      'outcome_unknown'
    ]);
    expect(operation.NON_TERMINAL_OPERATION_STATES).toEqual(['prepared', 'queued', 'dispatching', 'accepted', 'running']);
    for (const s of operation.OPERATION_STATES) {
      const terminal = operation.isTerminalOperationState(s);
      expect(terminal).toBe(operation.TERMINAL_OPERATION_STATES.includes(s));
      expect(operation.NON_TERMINAL_OPERATION_STATES.includes(s)).toBe(!terminal);
    }
  });

  it('no operation state ever permits automatic resend, and outcome_unknown is never duplicate-safe', () => {
    for (const s of operation.OPERATION_STATES) {
      expect(operation.canAutomaticallyResend(s), `state ${s} must not allow auto resend`).toBe(false);
    }
    expect(Object.keys(operation.AUTO_RESEND_ALLOWED_BY_STATE).length).toBe(10);
    expect(operation.resendWouldNotDuplicateState('not_submitted')).toBe(true);
    expect(operation.resendWouldNotDuplicateState('outcome_unknown')).toBe(false);
    expect(operation.resendWouldNotDuplicateState('dispatching')).toBe(false);
  });

  it('modelRef round-trips and distinguishes null effort from a present effort', () => {
    const ref = validModelRef();
    const once = acceptedValue(operation.validateModelRef(ref));
    expect(once).toEqual(ref);
    expect(acceptedValue(operation.validateModelRef(once))).toEqual(ref);
    const withEffort = { ...ref, effort: 'high' };
    expect(acceptedValue(operation.validateModelRef(withEffort))).toEqual(withEffort);
    expect(operation.modelRefEquals(ref, { ...ref })).toBe(true);
    expect(operation.modelRefEquals(ref, withEffort)).toBe(false);
    expect(operation.modelRefEquals(ref, { ...ref, modelId: 'other' })).toBe(false);
  });

  it('modelRef rejects empty ids, over-long ids, bad effort and unknown fields', () => {
    const ref = validModelRef();
    expectRejected(operation.validateModelRef({ ...ref, catalogId: '' }), 'model.catalogId');
    expectRejected(
      operation.validateModelRef({ ...ref, providerId: 'p'.repeat(contractErrors.CONTRACT_LIMITS.idMaxChars + 1) }),
      'model.providerId'
    );
    expectRejected(operation.validateModelRef({ ...ref, modelId: `a${NUL}b` }), 'model.modelId');
    // effort 是可空位：null 合法，undefined 与空串都不合法
    expectRejected(operation.validateModelRef({ ...ref, effort: undefined }), 'model.effort');
    expectRejected(operation.validateModelRef({ ...ref, effort: '' }), 'model.effort');
    expectRejected(operation.validateModelRef({ ...ref, effort: 3 }), 'model.effort');
    // 未知但影响语义的字段：拒绝，不静默丢弃
    const extra = expectRejected(operation.validateModelRef({ ...ref, entitlements: ['pro'] }), 'model');
    expect(extra.some((i) => i.code === 'unknown_field')).toBe(true);
    // 整体不是普通对象
    expectRejected(operation.validateModelRef(null), 'model');
    expectRejected(operation.validateModelRef([ref]), 'model');
  });

  it('admission denies metered_api/unknown, denies missing model, honours window mode and evidence level', () => {
    const base = {
      windowMode: /** @type {const} */ ('advisory'),
      windowOpen: true,
      billingClass: /** @type {const} */ ('subscription'),
      evidenceLevel: /** @type {const} */ ('E1'),
      model: validModelRef(),
      configRevision: 'rev-1'
    };
    const allowed = operation.decideAdmission(base);
    expect(allowed.allowed).toBe(true);
    expect(allowed.code).toBe('allowed');

    const metered = operation.decideAdmission({ ...base, billingClass: 'metered_api' });
    expect(metered.allowed).toBe(false);
    expect(metered.code).toBe('billing_not_sendable');
    expect(operation.decideAdmission({ ...base, billingClass: 'unknown' }).allowed).toBe(false);

    expect(operation.decideAdmission({ ...base, model: null }).code).toBe('model_missing');
    expect(operation.decideAdmission({ ...base, evidenceLevel: 'E0' }).code).toBe('evidence_insufficient');

    const enforced = operation.decideAdmission({ ...base, windowOpen: false, windowMode: 'enforce' });
    expect(enforced.allowed).toBe(false);
    expect(enforced.code).toBe('window_closed_enforced');

    const advisory = operation.decideAdmission({ ...base, windowOpen: false, windowMode: 'advisory' });
    expect(advisory.allowed).toBe(true);
    expect(advisory.warnings.length).toBeGreaterThan(0);

    const off = operation.decideAdmission({ ...base, windowOpen: false, windowMode: 'off' });
    expect(off.allowed).toBe(true);
    expect(off.warnings).toEqual([]);

    // off 只关提示，不放宽安全结论
    expect(operation.decideAdmission({ ...base, windowMode: 'off', billingClass: 'metered_api' }).allowed).toBe(false);
    expect(operation.decideAdmission({ ...base, windowMode: 'off', evidenceLevel: 'E0' }).allowed).toBe(false);
  });

  it('admission decision round-trips and self-inconsistent "allowed" decisions are rejected', () => {
    const d = operation.decideAdmission({
      windowMode: 'advisory',
      windowOpen: true,
      billingClass: 'subscription',
      evidenceLevel: 'E1',
      model: validModelRef(),
      configRevision: 'rev-1'
    });
    expect(acceptedValue(operation.validateAdmissionDecision(d))).toEqual(d);

    const bad = /** @type {any} */ ({ ...d, billingClass: 'metered_api' });
    expectRejected(operation.validateAdmissionDecision(bad), 'decision');

    const badWindow = /** @type {any} */ ({ ...d, windowOpen: false, windowMode: 'enforce' });
    expectRejected(operation.validateAdmissionDecision(badWindow), 'decision');

    const badCode = /** @type {any} */ ({ ...d, code: 'window_closed_enforced' });
    expectRejected(operation.validateAdmissionDecision(badCode), 'decision');

    const noModel = /** @type {any} */ ({ ...d, model: null });
    expectRejected(operation.validateAdmissionDecision(noModel), 'decision');

    const extra = /** @type {any} */ ({ ...d, secretOverride: true });
    expect(expectRejected(operation.validateAdmissionDecision(extra), 'decision').some((i) => i.code === 'unknown_field')).toBe(
      true
    );
  });
});

describe('I04 capability contract', () => {
  it('every runtime capability defaults to unknown and unknown is not available', () => {
    const d = capabilities.defaultRuntimeCapabilityStates();
    expect(Object.keys(d).length).toBe(6);
    for (const k of capabilities.RUNTIME_CAPABILITY_KEYS) {
      expect(d[k]).toBe('unknown');
    }
    expect(capabilities.isExternallyAvailable('unknown')).toBe(false);
    expect(capabilities.isExternallyAvailable('unsupported')).toBe(false);
    expect(capabilities.isExternallyAvailable('mechanism_verified')).toBe(false);
    expect(capabilities.isExternallyAvailable('behavior_verified')).toBe(true);
  });

  it('enums are exactly the frozen value sets', () => {
    expect(capabilities.CAPABILITY_STATES).toEqual(['unknown', 'unsupported', 'mechanism_verified', 'behavior_verified']);
    expect(capabilities.EXACT_CANCEL_STATES).toEqual(['mechanism_verified', 'verified', 'unsupported', 'unknown']);
    expect(capabilities.NATIVE_TOOLS_STATES).toEqual(['disabled_verified', 'unsupported', 'unknown']);
    expect(capabilities.AUTOMATIC_RETRY_STATES).toEqual(['disabled_verified', 'unknown']);
    expect(capabilities.INPUT_TERMINAL_CORRELATION_STATES).toEqual(['verified', 'unknown']);
    expect(capabilities.BILLING_EVIDENCE_STATES).toEqual(['verified_mapping', 'unknown']);
    expect(capabilities.ROLE_FIDELITY_STATES).toEqual(['native_verified', 'unsupported', 'unknown']);
    expect(capabilities.ROLE_KINDS).toEqual(['system', 'developer', 'user', 'assistant', 'tool']);
  });

  it('the whole capability matrix is pinned: enum -> evidence layer -> allowed entry', () => {
    const rows = capabilities.capabilityMatrix();
    expect(rows.length).toBe(40);
    /** @type {Record<string, { entry: string, states: Record<string, [string, boolean]> }>} */
    const actual = {};
    for (const row of rows) {
      const bucket = actual[row.key] ?? { entry: row.entry, states: {} };
      bucket.states[row.state] = [row.layer, row.opens];
      actual[row.key] = bucket;
    }
    expect(actual).toEqual(EXPECTED_CAPABILITY_MATRIX);
  });

  it('every state table is exhaustive over its declared enum', () => {
    for (const key of capabilities.CAPABILITY_GATE_KEYS) {
      for (const state of capabilities.CAPABILITY_STATES_FOR[key]) {
        const looked = capabilities.describeCapability(key, state);
        expect(looked.ok, `${key}.${state} must be classified`).toBe(true);
      }
    }
    expect(capabilities.CAPABILITY_GATE_KEYS.length).toBe(Object.keys(EXPECTED_CAPABILITY_MATRIX).length);
  });

  it('mechanism-layer verified values do NOT open behavior-gated entries', () => {
    const exactMechanism = capabilities.describeCapability('exactCancel', 'mechanism_verified');
    expect(exactMechanism.ok).toBe(true);
    if (!exactMechanism.ok) throw new Error('exactCancel.mechanism_verified must be classified');
    expect(exactMechanism.layer).toBe('mechanism');
    expect(exactMechanism.opens).toBe(false);
    expect(exactMechanism.entry).toBe('exact_cancel_control');

    const exactBehavior = capabilities.describeCapability('exactCancel', 'verified');
    expect(exactBehavior.ok).toBe(true);
    if (!exactBehavior.ok) throw new Error('exactCancel.verified must be classified');
    expect(exactBehavior.layer).toBe('behavior');
    expect(exactBehavior.opens).toBe(true);

    const acct = capabilities.describeCapability('accountReady', 'mechanism_verified');
    expect(acct.ok).toBe(true);
    if (!acct.ok) throw new Error('accountReady.mechanism_verified must be classified');
    expect(acct.opens).toBe(false);
    expect(capabilities.isBehaviorProven('accountReady', 'mechanism_verified')).toBe(false);
    expect(capabilities.isMechanismProven('accountReady', 'mechanism_verified')).toBe(true);
  });

  it('mechanism-layer safety values open only their own disable/mapping entries', () => {
    const cases = [
      ['nativeTools', 'disabled_verified', 'native_tools_disabled', true],
      ['automaticRetry', 'disabled_verified', 'automatic_retry_disabled', true],
      ['inputTerminalCorrelation', 'verified', 'terminal_correlation', false],
      ['billingEvidence', 'verified_mapping', 'billing_mapping_display', true],
      ['roleFidelity', 'native_verified', 'role_composition', false]
    ];
    for (const [key, state, entry, opens] of cases) {
      const looked = capabilities.describeCapability(/** @type {string} */ (key), /** @type {string} */ (state));
      expect(looked.ok, `${key}.${state} must be classified`).toBe(true);
      if (!looked.ok) throw new Error(`${key}.${state} must be classified`);
      expect(looked.entry).toBe(entry);
      expect(looked.opens).toBe(opens);
    }
  });

  it('verified enums of one capability are not interchangeable with another', () => {
    // 'verified' 是行为层值，不能被机制层的 nativeTools 接受
    const cross = capabilities.describeCapability('nativeTools', 'verified');
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.reason).toBe('unknown_state');
    // 'disabled_verified' 不能被 exactCancel 接受
    const cross2 = capabilities.describeCapability('exactCancel', 'disabled_verified');
    expect(cross2.ok).toBe(false);
    if (!cross2.ok) expect(cross2.reason).toBe('unknown_state');
    // 行为层的 verified 也不能被 roleFidelity 接受
    const cross3 = capabilities.describeCapability('roleFidelity', 'verified');
    expect(cross3.ok).toBe(false);
    // 也不认识不存在的 capability
    const cross4 = capabilities.describeCapability('telepathy', 'behavior_verified');
    expect(cross4.ok).toBe(false);
    if (!cross4.ok) expect(cross4.reason).toBe('unknown_capability');
    // 取值域完全不相交的两个能力
    expect(capabilities.CAPABILITY_STATES_FOR['automaticRetry'].includes('unsupported')).toBe(false);
    expect(capabilities.CAPABILITY_STATES_FOR['billingEvidence'].includes('disabled_verified')).toBe(false);
  });

  it('role fidelity defaults to unknown per role and never opens composition on mechanism alone', () => {
    const d = capabilities.defaultRoleFidelity();
    expect(Object.keys(d).sort()).toEqual([...capabilities.ROLE_KINDS].sort());
    for (const r of capabilities.ROLE_KINDS) expect(d[r]).toBe('unknown');
    expect(capabilities.roleFidelityOpensComposition(d)).toBe(false);
    const partial = { ...d, tool: /** @type {any} */ ('native_verified') };
    expect(capabilities.roleFidelityOpensComposition(partial)).toBe(false);
  });

  it('safety capabilities round-trip and reject cross-enum values', () => {
    const s = capabilities.defaultSafetyCapabilities();
    expect(acceptedValue(capabilities.validateSafetyCapabilities(s))).toEqual(s);
    const swapped = /** @type {any} */ ({ ...s, exactCancel: 'disabled_verified' });
    expectRejected(capabilities.validateSafetyCapabilities(swapped), 'caps');
    const roleBad = /** @type {any} */ ({ ...s, roleFidelity: { ...s.roleFidelity, system: 'verified' } });
    expectRejected(capabilities.validateSafetyCapabilities(roleBad), 'caps.roleFidelity');
    const extra = /** @type {any} */ ({ ...s, upstreamConfig: {} });
    expect(expectRejected(capabilities.validateSafetyCapabilities(extra), 'caps').some((i) => i.code === 'unknown_field')).toBe(
      true
    );
  });

  it('runtime capability requires a real fingerprint and expiresAt=null is NOT fresh', () => {
    const rc = validRuntimeCapability();
    expect(acceptedValue(capabilities.validateRuntimeCapability(rc))).toEqual(rc);
    const now = new Date('2026-09-29T00:30:00.000Z');
    expect(capabilities.isRuntimeCapabilityFresh(rc, now)).toBe(true);
    expect(capabilities.isRuntimeCapabilityFresh({ ...rc, expiresAt: null }, now)).toBe(false);
    expect(capabilities.isRuntimeCapabilityFresh({ ...rc, expiresAt: '2026-09-29T00:10:00.000Z' }, now)).toBe(false);
    expectRejected(capabilities.validateRuntimeCapability({ ...rc, source: 'dsh' }), 'runtime.source');
    expectRejected(capabilities.validateRuntimeCapability({ ...rc, fingerprint: 'nope' }), 'runtime.fingerprint');
    expectRejected(capabilities.validateRuntimeCapability({ ...rc, fingerprint: 'A'.repeat(64) }), 'runtime.fingerprint');
    expectRejected(capabilities.validateRuntimeCapability({ ...rc, expiresAt: undefined }), 'runtime.expiresAt');
    expectRejected(capabilities.validateRuntimeCapability({ ...rc, expiresAt: 'never' }), 'runtime.expiresAt');
    expectRejected(capabilities.validateRuntimeCapability({ ...rc, observedAt: '2026-02-30T00:00:00.000Z' }), 'runtime.observedAt');
    const extra = expectRejected(capabilities.validateRuntimeCapability({ ...rc, extra: 1 }), 'runtime');
    expect(extra.some((i) => i.code === 'unknown_field')).toBe(true);
    // null 是合法取值
    expect(acceptedValue(capabilities.validateRuntimeCapability({ ...rc, expiresAt: null })).expiresAt).toBe(null);
  });
});

describe('I04 event contract', () => {
  it('a well-formed event round-trips through schema validation', () => {
    const e = validEvent();
    const once = acceptedValue(events.validateCompanionEvent(e));
    expect(once).toEqual(e);
    expect(acceptedValue(events.validateCompanionEvent(once))).toEqual(e);
  });

  it('the envelope requires all seven fields and rejects unknown ones', () => {
    const e = validEvent();
    for (const key of ['requestId', 'inputId', 'sessionId', 'generation', 'eventSeq', 'type', 'payload']) {
      const partial = /** @type {any} */ ({ ...e });
      delete partial[key];
      const issues = expectRejected(events.validateCompanionEvent(partial), `event.${key}`);
      expect(issues.some((i) => i.code === 'missing_field')).toBe(true);
    }
    const extra = expectRejected(events.validateCompanionEvent({ ...e, upstreamConfig: {} }), 'event');
    expect(extra.some((i) => i.code === 'unknown_field')).toBe(true);
  });

  it('generation/eventSeq accept 0 but reject negatives, floats and non-integers', () => {
    const e = validEvent();
    const zero = { ...e, generation: 0, eventSeq: 0 };
    expect(acceptedValue(events.validateCompanionEvent(zero))).toEqual(zero);
    expectRejected(events.validateCompanionEvent({ ...e, generation: -1 }), 'event.generation');
    expectRejected(events.validateCompanionEvent({ ...e, eventSeq: 1.5 }), 'event.eventSeq');
    expectRejected(events.validateCompanionEvent({ ...e, eventSeq: undefined }), 'event.eventSeq');
    expectRejected(events.validateCompanionEvent({ ...e, eventSeq: Number.NaN }), 'event.eventSeq');
  });

  it('unknown event types and out-of-contract payload keys are rejected, never dropped', () => {
    const e = validEvent();
    expectRejected(events.validateCompanionEvent({ ...e, type: 'upstream.whatever' }), 'event.type');
    const badState = /** @type {any} */ ({ ...e, payload: { state: 'sent', previousState: 'running', operationId: 'op-1' } });
    expectRejected(events.validateCompanionEvent(badState), 'event.payload.state');
    const extraKey = /** @type {any} */ ({
      ...e,
      payload: { state: 'running', previousState: 'accepted', operationId: 'op-1', rawUpstream: { a: 1 } }
    });
    const issues = expectRejected(events.validateCompanionEvent(extraKey), 'event.payload');
    expect(issues.some((i) => i.code === 'unknown_field')).toBe(true);
  });

  it('every non-heartbeat event type is accepted with a well-formed payload', () => {
    const e = validEvent();
    const admission = acceptedValue(
      events.validateCompanionEvent({
        ...e,
        type: 'admission.decided',
        payload: { allowed: true, code: 'allowed', windowMode: 'advisory', windowOpen: true, warnings: [] }
      })
    );
    expect(admission.type).toBe('admission.decided');

    const capability = acceptedValue(
      events.validateCompanionEvent({
        ...e,
        type: 'capability.observed',
        payload: { key: 'accountReady', state: 'unknown', runtimeVersion: '0.16.9' }
      })
    );
    expect(capability.type).toBe('capability.observed');

    // 跨能力取值域：给 nativeTools 传行为层的 verified 必须被拒
    const crossed = /** @type {any} */ ({
      ...e,
      type: 'capability.observed',
      payload: { key: 'nativeTools', state: 'verified', runtimeVersion: '0.16.9' }
    });
    expectRejected(events.validateCompanionEvent(crossed), 'event.payload.state');

    const raised = acceptedValue(
      events.validateCompanionEvent({
        ...e,
        type: 'error.raised',
        payload: { code: 'operation_not_submitted', delivery: 'not_submitted', operationState: 'not_submitted' }
      })
    );
    expect(raised.type).toBe('error.raised');
  });

  it('sensitive fields are rejected anywhere in the payload', () => {
    const e = validEvent();
    const clean = /** @type {any} */ ({
      ...e,
      type: 'error.raised',
      payload: { code: 'internal_error', delivery: 'not_submitted', operationState: 'failed' }
    });
    expect(acceptedValue(events.validateCompanionEvent(clean))).toEqual(clean);
    const leaked = /** @type {any} */ ({
      ...e,
      type: 'error.raised',
      payload: { code: 'internal_error', delivery: 'not_submitted', operationState: 'failed', apiKey: 'sk-abcdefghijklmnop' }
    });
    const issues = expectRejected(events.validateCompanionEvent(leaked), 'event.payload');
    expect(issues.some((i) => i.code === 'sensitive_field')).toBe(true);
    const bearerMsg = /** @type {any} */ ({
      ...e,
      type: 'error.raised',
      payload: { code: 'internal_error', delivery: 'not_submitted', operationState: 'failed', operationId: 'Bearer abcdef123456' }
    });
    expectRejected(events.validateCompanionEvent(bearerMsg), 'event.payload');
  });

  it('only a terminal operation state creates a terminal; unrelated and unknown events do not', () => {
    const terminal = acceptedValue(
      events.validateCompanionEvent({
        ...validEvent(),
        payload: { state: 'completed', previousState: 'running', operationId: 'op-1' }
      })
    );
    expect(events.isTerminalEvent(terminal)).toBe(true);

    const running = validEvent();
    expect(events.isTerminalEvent(running)).toBe(false);

    const heartbeat = acceptedValue(
      events.validateCompanionEvent({
        ...validEvent(),
        type: 'runtime.heartbeat',
        payload: { runtimeVersion: '0.16.9', uptimeMs: 10 }
      })
    );
    expect(events.isTerminalEvent(heartbeat)).toBe(false);

    // 防御性：完全不认识的对象不得被当成 terminal
    expect(events.isTerminalEvent(/** @type {any} */ (null))).toBe(false);
    expect(events.isTerminalEvent(/** @type {any} */ (undefined))).toBe(false);
    expect(events.isTerminalEvent(/** @type {any} */ ('operation.state_changed'))).toBe(false);
    expect(events.isTerminalEvent(/** @type {any} */ ({ type: 'operation.state_changed' }))).toBe(false);
    expect(events.isTerminalEvent(/** @type {any} */ ({ type: 'operation.state_changed', payload: null }))).toBe(false);
    expect(events.isTerminalEvent(/** @type {any} */ ({ type: 'operation.state_changed', payload: { state: 'whatever' } }))).toBe(
      false
    );
    expect(events.isTerminalEvent(/** @type {any} */ ({ type: 'operation.state_changed', payload: { state: 42 } }))).toBe(false);
    // 未通过校验的输入（未知类型）也必须返回 false 而不是"制造 terminal"
    expect(events.isTerminalEvent(/** @type {any} */ ({ type: 'upstream.whatever', payload: { state: 'completed' } }))).toBe(false);
    expect(events.isTerminalEvent(/** @type {any} */ ({ type: 'error.raised', payload: { state: 'completed' } }))).toBe(false);
  });

  it('event sequence advance is computed per request+generation', () => {
    const e = validEvent();
    const next = { ...e, eventSeq: 4 };
    expect(events.isEventSequenceAdvance(e, next)).toBe(true);
    expect(events.isEventSequenceAdvance(next, e)).toBe(false);
    expect(events.isEventSequenceAdvance(e, { ...e, requestId: 'req-2' })).toBe(false);
    expect(events.isEventSequenceAdvance(e, { ...e, generation: 1 })).toBe(false);
    expect(events.isEventSequenceAdvance(e, e)).toBe(false);
  });

  it('NDJSON line parsing rejects malformed JSON and accepts a trimmed valid line', () => {
    const line = JSON.stringify(validEvent());
    expect(acceptedValue(events.parseCompanionEventLine(line))).toEqual(validEvent());
    expect(acceptedValue(events.parseCompanionEventLine(`${line}\n`))).toEqual(validEvent());
    const malformed = expectRejected(events.parseCompanionEventLine('{"broken"'), 'line');
    expect(malformed.some((i) => i.code === 'invalid_json')).toBe(true);
    expectRejected(events.parseCompanionEventLine(''), 'line');
    expectRejected(events.parseCompanionEventLine('   '), 'line');
    expectRejected(events.parseCompanionEventLine(JSON.stringify({ ...validEvent(), type: 'nope' })), 'line.type');
    expectRejected(events.parseCompanionEventLine(null), 'line');
  });
});

describe('I04 error contract', () => {
  it('error DTO round-trips and keeps delivery certainty explicit', () => {
    const e = contractErrors.toCompanionError(
      'operation_not_submitted',
      '请求未离开本产品边界',
      'not_submitted',
      '2026-09-29T00:00:00.000Z',
      { requestId: 'req-1' }
    );
    expect(acceptedValue(contractErrors.validateCompanionError(e))).toEqual(e);
    expect(e.retry.autoResendAllowed).toBe(false);
    expect(e.retry.requiresExplicitHumanDecision).toBe(true);
    expect(e.retry.resendWouldNotDuplicate).toBe(true);
    // 构造后修改原 detail 不应渗进 DTO
    const source = { requestId: 'req-1' };
    const built = contractErrors.toCompanionError('internal_error', 'x', 'not_submitted', '2026-09-29T00:00:00.000Z', source);
    source['requestId'] = 'mutated';
    expect(built.detail['requestId']).toBe('req-1');
  });

  it('not_submitted and outcome_unknown are different facts and neither allows auto resend', () => {
    for (const c of contractErrors.DELIVERY_CERTAINTIES) {
      expect(contractErrors.canAutoResend(c), `delivery ${c} must not allow auto resend`).toBe(false);
    }
    expect(contractErrors.deriveResendWouldNotDuplicate('not_submitted')).toBe(true);
    expect(contractErrors.deriveResendWouldNotDuplicate('submitted_rejected')).toBe(false);
    expect(contractErrors.deriveResendWouldNotDuplicate('outcome_unknown')).toBe(false);

    const unknown = contractErrors.toCompanionError(
      'operation_outcome_unknown',
      '超时，投递确定性不可知',
      'outcome_unknown',
      '2026-09-29T00:00:00.000Z'
    );
    expect(unknown.retry.resendWouldNotDuplicate).toBe(false);
    expect(unknown.retry.guidance).toContain('人工');
    const notSubmitted = contractErrors.toCompanionError(
      'operation_not_submitted',
      '未提交',
      'not_submitted',
      '2026-09-29T00:00:00.000Z'
    );
    expect(notSubmitted.retry.resendWouldNotDuplicate).toBe(true);
    // 两个确定性必须给出不同的 guidance，不能是同一句话
    expect(unknown.retry.guidance).not.toBe(notSubmitted.retry.guidance);
  });

  it('a retry hint in the message never upgrades an error into an auto-resend permission', () => {
    const e = /** @type {any} */ ({
      ...contractErrors.toCompanionError('upstream_timeout', '可重试：请求超时', 'outcome_unknown', '2026-09-29T00:00:00.000Z'),
      retry: {
        autoResendAllowed: true,
        requiresExplicitHumanDecision: false,
        resendWouldNotDuplicate: true,
        guidance: '直接重发'
      }
    });
    const issues = expectRejected(contractErrors.validateCompanionError(e), 'error.retry');
    expect(issues.some((i) => i.code === 'forbidden_value')).toBe(true);
  });

  it('inconsistent resend flags are rejected rather than trusted', () => {
    const base = contractErrors.toCompanionError(
      'operation_outcome_unknown',
      'x',
      'outcome_unknown',
      '2026-09-29T00:00:00.000Z'
    );
    const lying = /** @type {any} */ ({ ...base, retry: { ...base.retry, resendWouldNotDuplicate: true } });
    expectRejected(contractErrors.validateCompanionError(lying), 'error.retry.resendWouldNotDuplicate');
    const wrongHuman = /** @type {any} */ ({ ...base, retry: { ...base.retry, requiresExplicitHumanDecision: false } });
    expectRejected(contractErrors.validateCompanionError(wrongHuman), 'error.retry');
  });

  it('error DTO rejects credentials in detail, in messages and in unknown fields', () => {
    const base = contractErrors.toCompanionError('internal_error', 'boom', 'outcome_unknown', '2026-09-29T00:00:00.000Z');
    expectRejected(contractErrors.validateCompanionError({ ...base, detail: { apiKey: 'sk-abcdefghijklmnop' } }), 'error.detail');
    expectRejected(contractErrors.validateCompanionError({ ...base, detail: { authorization: 'Bearer abcdef123456' } }), 'error.detail');
    expectRejected(contractErrors.validateCompanionError({ ...base, message: 'Authorization: Bearer abcdef123456' }), 'error.message');
    // detail 只接受扁平标量，不接受嵌套的上游整块对象
    expectRejected(contractErrors.validateCompanionError({ ...base, detail: { upstreamError: { code: 1 } } }), 'error.detail');
    const extra = expectRejected(contractErrors.validateCompanionError({ ...base, upstreamError: { a: 1 } }), 'error');
    expect(extra.some((i) => i.code === 'unknown_field')).toBe(true);
    expectRejected(contractErrors.validateCompanionError({ ...base, delivery: 'maybe' }), 'error.delivery');
    expectRejected(contractErrors.validateCompanionError({ ...base, code: 'E_UPSTREAM_TIMEOUT' }), 'error.code');
    expectRejected(contractErrors.validateCompanionError({ ...base, observedAt: '2026-02-30T00:00:00.000Z' }), 'error.observedAt');
    expectRejected(contractErrors.validateCompanionError({ ...base, observedAt: undefined }), 'error.observedAt');
    expectRejected(contractErrors.validateCompanionError({ ...base, message: '' }), 'error.message');
    expectRejected(contractErrors.validateCompanionError(null), 'error');
  });

  it('an error message over the length cap is rejected', () => {
    const base = contractErrors.toCompanionError('internal_error', 'x', 'not_submitted', '2026-09-29T00:00:00.000Z');
    const long = { ...base, message: 'x'.repeat(contractErrors.CONTRACT_LIMITS.messageMaxChars + 1) };
    expectRejected(contractErrors.validateCompanionError(long), 'error.message');
  });

  /**
   * 文案钉（REV3-I4-1）：`guidance` 是**面向人的**文字，它必须与同一个 DTO 里被强制的
   * 那两个布尔量说同一件事。此前 `submitted_rejected` 的 guidance 写「重发不会造成重复执行」，
   * 而同一对象里被 `validateRetryAdvice` 强制的 `resendWouldNotDuplicate` 是 `false`——
   * 布尔量是保守的，文字却在说反话。
   *
   * 这条断言按**不变量**写而不是按字面串写：只要某个确定性的布尔量是 `false`，它的
   * guidance 就**不得**出现任何「重发不会造成重复执行」式的断言。
   */
  it('guidance text never contradicts the enforced resend flags', () => {
    for (const delivery of contractErrors.DELIVERY_CERTAINTIES) {
      const guidance = contractErrors.retryGuidanceFor(delivery);
      expect(typeof guidance, delivery).toBe('string');
      expect(guidance.trim().length, delivery).toBeGreaterThan(0);
      expect(guidance, delivery).toContain(delivery);

      // 1) 与 resendWouldNotDuplicate 同向。
      if (contractErrors.deriveResendWouldNotDuplicate(delivery) === false) {
        expect(guidance, `${delivery}: 布尔量是 false，guidance 不得声称重发不会重复`).not.toContain('重发不会造成重复执行');
        expect(guidance, `${delivery}: 也不得用变体说法`).not.toContain('重发不会重复');
        expect(guidance, `${delivery}: 也不得声称可以放心重发`).not.toContain('可以放心重发');
      } else {
        expect(guidance, `${delivery}: 布尔量是 true，guidance 应说明重发不会造成重复执行`).toContain('重发不会造成重复执行');
      }

      // 2) 无论确定性如何，都不得暗示自动重发：那两个强制布尔量是它的下限。
      expect(guidance, `${delivery}: 不得暗示自动重发`).not.toMatch(/可以自动重发|将自动重发|系统会自动重发|自动重试/);
      expect(guidance, `${delivery}: 必须由人显式决定`).toMatch(/人工|显式决定/);
    }
  });

  it('submitted_rejected reads as "rejected, not executed" and never as auto-resendable', () => {
    const guidance = contractErrors.retryGuidanceFor('submitted_rejected');
    // 已投递、上游明确拒绝、结果确定且未执行。
    expect(guidance).toContain('拒绝');
    expect(guidance).toContain('未执行');
    // 重发可能造成重复执行：与被强制的 false 同向。
    expect(guidance).toContain('可能造成重复执行');
    // 绝不出现"可自动重发"语义（"不得/禁止自动重发"是相反的表述，不在此列）。
    expect(guidance).not.toMatch(/(可以|将|系统会|应该|可)自动重发/);
    expect(guidance).not.toMatch(/自动重试/);
    expect(guidance).toMatch(/不得自动重发|禁止自动重发|不允许自动重发/);
    expect(guidance).toMatch(/人工|显式决定/);

    // 走 DTO 一遍：文案与布尔量必须一起出现在同一个错误对象里，且整体仍通过合同校验。
    const err = contractErrors.toCompanionError('upstream_rejected', '上游拒绝', 'submitted_rejected', '2026-09-29T00:00:00.000Z');
    expect(err.retry.resendWouldNotDuplicate).toBe(false);
    expect(err.retry.autoResendAllowed).toBe(false);
    expect(err.retry.requiresExplicitHumanDecision).toBe(true);
    expect(err.retry.guidance).toBe(guidance);
    expect(acceptedValue(contractErrors.validateCompanionError(err))).toEqual(err);
  });
});
