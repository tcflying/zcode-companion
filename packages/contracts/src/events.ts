/**
 * I04 事件合同：最小信封、按类型的封闭 payload、终态判定与 NDJSON 解析。
 *
 * 三条硬事实：
 *  1. **事件是本产品自己的类型。** `CompanionEvent` 的字段不声称与官方 RPC 同名同义；
 *     我们不把上游整块 config / unknown 直接外传——`payload` 的键是按事件类型
 *     **封闭**的，多一个键就拒绝，而不是剥掉后当成功。
 *  2. **信封七件套齐全**：`requestId` / `inputId` / `sessionId` / `generation` /
 *     `eventSeq` / `type` / `payload`，缺一即拒。
 *  3. **unknown / 无关事件不得制造 terminal。** 只有
 *     `operation.state_changed` 且 `payload.state` 落在终态集合里才算终态；
 *     心跳、能力观测、准入事件、未知类型、以及任何形状不对的输入都返回 `false`。
 *     `isTerminalEvent()` 对任何输入都先做防御性判定，不会因为"看起来像 completed"
 *     就把一次操作判成已结束。
 */
import {
  CONTRACT_LIMITS,
  DELIVERY_CERTAINTIES,
  LOCAL_ERROR_CODES,
  type ContractIssue,
  type ValidationResult,
  accepted,
  isPlainObject,
  issue,
  rejected,
  utf8ByteLength,
  validateEnumValue,
  validateIdentifier,
  validateNonNegativeInteger,
  validateShape,
  validateStringList
} from './errors.js';
import {
  CAPABILITY_GATE_KEYS,
  CAPABILITY_STATES_FOR,
  type CapabilityGateKey
} from './capabilities.js';
import {
  ADMISSION_CODES,
  OPERATION_STATES,
  TERMINAL_OPERATION_STATES,
  WINDOW_MODES
} from './operation.js';

export const COMPANION_EVENT_TYPES = [
  'operation.state_changed',
  'admission.decided',
  'capability.observed',
  'error.raised',
  'runtime.heartbeat'
] as const;
export type CompanionEventType = (typeof COMPANION_EVENT_TYPES)[number];

/**
 * 每种事件的 payload 必填键。**封闭集合**：不在表里的键一律 `unknown_field` 拒绝。
 * 这就是"不把上游整块 unknown config 直接外传"的落地方式。
 */
export const EVENT_PAYLOAD_KEYS: Readonly<Record<CompanionEventType, readonly string[]>> = {
  'operation.state_changed': ['state', 'previousState', 'operationId'],
  'admission.decided': ['allowed', 'code', 'windowMode', 'windowOpen', 'warnings'],
  'capability.observed': ['key', 'state', 'runtimeVersion'],
  'error.raised': ['code', 'delivery', 'operationState'],
  'runtime.heartbeat': ['runtimeVersion', 'uptimeMs']
};

export interface CompanionEvent {
  readonly requestId: string;
  readonly inputId: string;
  readonly sessionId: string;
  /** 同一 requestId 下的世代号；`0` 合法。 */
  readonly generation: number;
  /** 同一 requestId + generation 内严格递增的序号；`0` 合法。 */
  readonly eventSeq: number;
  readonly type: CompanionEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

const EVENT_REQUIRED_KEYS = ['requestId', 'inputId', 'sessionId', 'generation', 'eventSeq', 'type', 'payload'] as const;

function isCompanionEventType(value: unknown): value is CompanionEventType {
  return typeof value === 'string' && (COMPANION_EVENT_TYPES as readonly string[]).includes(value);
}

function validatePayload(type: CompanionEventType, payload: unknown, path: string): ContractIssue[] {
  const required = EVENT_PAYLOAD_KEYS[type];
  const issues = validateShape(payload, required, [], path);
  if (issues.length > 0 || !isPlainObject(payload)) return issues;

  switch (type) {
    case 'operation.state_changed': {
      issues.push(...validateEnumValue(payload['state'], OPERATION_STATES, `${path}.state`));
      issues.push(...validateEnumValue(payload['previousState'], OPERATION_STATES, `${path}.previousState`));
      issues.push(...validateIdentifier(payload['operationId'], `${path}.operationId`));
      return issues;
    }
    case 'admission.decided': {
      if (typeof payload['allowed'] !== 'boolean') {
        issues.push(issue(`${path}.allowed`, 'invalid_type', 'allowed 必须是布尔值'));
      }
      issues.push(...validateEnumValue(payload['code'], ADMISSION_CODES, `${path}.code`));
      issues.push(...validateEnumValue(payload['windowMode'], WINDOW_MODES, `${path}.windowMode`));
      if (typeof payload['windowOpen'] !== 'boolean') {
        issues.push(issue(`${path}.windowOpen`, 'invalid_type', 'windowOpen 必须是布尔值'));
      }
      issues.push(...validateStringList(payload['warnings'], `${path}.warnings`, CONTRACT_LIMITS.arrayMaxItems));
      return issues;
    }
    case 'capability.observed': {
      issues.push(...validateEnumValue(payload['key'], CAPABILITY_GATE_KEYS, `${path}.key`));
      issues.push(...validateIdentifier(payload['runtimeVersion'], `${path}.runtimeVersion`));
      const key: unknown = payload['key'];
      const state: unknown = payload['state'];
      if (typeof key === 'string' && (CAPABILITY_GATE_KEYS as readonly string[]).includes(key)) {
        // 状态必须属于**这个能力自己的**取值域：跨能力取值（例如给 nativeTools 传
        // 行为层的 `verified`）在这里被拒，而不是被当成更强或更弱的证据接受。
        issues.push(...validateEnumValue(state, CAPABILITY_STATES_FOR[key as CapabilityGateKey], `${path}.state`));
      } else if (typeof state !== 'string') {
        issues.push(issue(`${path}.state`, 'invalid_type', 'state 必须是字符串'));
      }
      return issues;
    }
    case 'error.raised': {
      issues.push(...validateEnumValue(payload['code'], LOCAL_ERROR_CODES, `${path}.code`));
      issues.push(...validateEnumValue(payload['delivery'], DELIVERY_CERTAINTIES, `${path}.delivery`));
      issues.push(...validateEnumValue(payload['operationState'], OPERATION_STATES, `${path}.operationState`));
      return issues;
    }
    case 'runtime.heartbeat': {
      issues.push(...validateIdentifier(payload['runtimeVersion'], `${path}.runtimeVersion`));
      issues.push(...validateNonNegativeInteger(payload['uptimeMs'], `${path}.uptimeMs`));
      return issues;
    }
    default: {
      // 编译期兜底：新增事件类型却忘了写 payload 校验时，这里会报错。
      const exhaustive: never = type;
      return [issue(path, 'invalid_type', `未实现 payload 校验的事件类型 ${String(exhaustive)}`)];
    }
  }
}

export function validateCompanionEvent(raw: unknown, path = 'event'): ValidationResult<CompanionEvent> {
  const issues = validateShape(raw, EVENT_REQUIRED_KEYS, [], path);
  if (issues.length > 0) return rejected(issues);
  const obj = raw as Record<string, unknown>;

  issues.push(...validateIdentifier(obj['requestId'], `${path}.requestId`));
  issues.push(...validateIdentifier(obj['inputId'], `${path}.inputId`));
  issues.push(...validateIdentifier(obj['sessionId'], `${path}.sessionId`));
  issues.push(...validateNonNegativeInteger(obj['generation'], `${path}.generation`));
  issues.push(...validateNonNegativeInteger(obj['eventSeq'], `${path}.eventSeq`));
  issues.push(...validateEnumValue(obj['type'], COMPANION_EVENT_TYPES, `${path}.type`));

  if (isCompanionEventType(obj['type'])) {
    issues.push(...validatePayload(obj['type'], obj['payload'], `${path}.payload`));
  }
  if (issues.length > 0) return rejected(issues);

  return accepted({
    requestId: obj['requestId'] as string,
    inputId: obj['inputId'] as string,
    sessionId: obj['sessionId'] as string,
    generation: obj['generation'] as number,
    eventSeq: obj['eventSeq'] as number,
    type: obj['type'] as CompanionEventType,
    payload: obj['payload'] as Readonly<Record<string, unknown>>
  });
}

/**
 * 是否构成终态。
 *
 * 只有 `operation.state_changed` + 终态 `state` 才为 `true`。函数对任何输入都先做
 * 防御性判定（null / 非对象 / 缺 payload / 非终态 / 未知事件类型），因此
 * "unknown 或无关事件"永远不可能把一次操作推进到 terminal。
 */
export function isTerminalEvent(event: { readonly type?: unknown; readonly payload?: unknown } | null | undefined): boolean {
  if (event === null || typeof event !== 'object') return false;
  if (event.type !== 'operation.state_changed') return false;
  const payload: unknown = event.payload;
  if (!isPlainObject(payload)) return false;
  const state: unknown = payload['state'];
  if (typeof state !== 'string') return false;
  return (TERMINAL_OPERATION_STATES as readonly string[]).includes(state);
}

/** 序号推进：同一 requestId + 同一 generation 内 `eventSeq` 必须严格递增。 */
export function isEventSequenceAdvance(
  previous: Pick<CompanionEvent, 'requestId' | 'generation' | 'eventSeq'>,
  next: Pick<CompanionEvent, 'requestId' | 'generation' | 'eventSeq'>
): boolean {
  return (
    previous.requestId === next.requestId &&
    previous.generation === next.generation &&
    next.eventSeq > previous.eventSeq
  );
}

/** 解析一行 NDJSON。畸形 JSON、超长行、空行都不是事件。 */
export function parseCompanionEventLine(line: unknown, path = 'line'): ValidationResult<CompanionEvent> {
  if (typeof line !== 'string') return rejected([issue(path, 'invalid_type', 'NDJSON 行必须是字符串')]);
  const trimmed = line.trim();
  if (trimmed.length === 0) return rejected([issue(path, 'empty_value', '空行不是事件')]);
  if (utf8ByteLength(trimmed) > CONTRACT_LIMITS.eventLineMaxBytes) {
    return rejected([issue(path, 'too_long', `单行超过 ${CONTRACT_LIMITS.eventLineMaxBytes} 字节上限`)]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return rejected([issue(path, 'invalid_json', `NDJSON 解析失败：${e instanceof Error ? e.message : String(e)}`)]);
  }
  return validateCompanionEvent(parsed, path);
}
