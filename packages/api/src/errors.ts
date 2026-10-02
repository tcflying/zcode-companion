/**
 * API01 错误层：本机 OpenAI 兼容 API 的错误码、HTTP 语义与合同映射。
 *
 * 三条硬事实：
 *  1. **两层错误码。** 对外（OpenAI 形状）在 `error.code`，用的是本文件自己的
 *     `ApiErrorCode`；对内（产品合同）在 `zcc_error`，用的是 I04 的
 *     `CompanionError` 并可通过 `validateCompanionError()`。两层都是机读的，
 *     客户端和验收脚本各取所需，不靠解析中文 message。
 *  2. **不静默降级成 500。** 未知错误码在构造期就抛 `UNKNOWN_API_ERROR_CODE`，
 *     不会掉进 `internal_error` 分支冒充成功路径的错误处理。
 *  3. **凭据永远不进错误体。** `ApiError.detail` 在转成 `CompanionError.detail`
 *     之前会被剔掉凭据键名与凭据样式取值（I04 的 `isSensitiveKey` /
 *     `looksLikeCredentialValue`），因此 API key 不会通过错误消息、detail 或
 *     堆栈泄漏出去。这不是"调用方记得别放"，是出口处强制。
 *
 * 已知缺口（交协调者裁定）：I04 的 `LocalErrorCode` 只覆盖**投递与计费**语义，
 * 没有 HTTP 传输层的码（未认证 / 限流 / 幂等冲突 / 字段级 schema 问题）。
 * 本文件因此为 4xx 映射到 `contract_violation`（429 映射到
 * `operation_not_submitted`）。若协调者认为应向 contracts 增设传输层码，
 * 本文件只需改 `API_ERROR_SPECS` 一张表，接口契约不变。
 */
import {
  isSensitiveKey,
  looksLikeCredentialValue,
  toCompanionError,
  type CompanionError,
  type DeliveryCertainty,
  type LocalErrorCode
} from '../../contracts/src/errors.js';

/** 本机 API 自己的传输层错误码。不是上游 RPC 的错误枚举。 */
export const API_ERROR_CODES = [
  'host_not_allowed',
  'origin_not_allowed',
  'unauthorized',
  'not_found',
  'method_not_allowed',
  'invalid_json',
  'invalid_request',
  'unknown_field',
  'unsupported_role',
  'unsupported_content_type',
  'unsupported_parameter',
  'model_not_found',
  'payload_too_large',
  'rate_limited',
  'idempotency_conflict',
  'idempotency_in_progress',
  'idempotency_replay_unavailable',
  'server_not_enabled',
  'upstream_unavailable',
  'upstream_timeout',
  'upstream_outcome_unknown',
  'internal_error'
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorSpec {
  /** HTTP 状态码。全部落在 4xx/5xx，永远不是 2xx。 */
  readonly status: number;
  /** 映射到的 I04 `LocalErrorCode`。 */
  readonly contractCode: LocalErrorCode;
  /** 投递确定性。请求没离开本机边界的一律 `not_submitted`。 */
  readonly delivery: DeliveryCertainty;
  /** OpenAI 形状的 `error.type`。 */
  readonly type: string;
}

export const API_ERROR_SPECS: Readonly<Record<ApiErrorCode, ApiErrorSpec>> = {
  host_not_allowed: { status: 403, contractCode: 'contract_violation', delivery: 'not_submitted', type: 'permission_error' },
  origin_not_allowed: { status: 403, contractCode: 'contract_violation', delivery: 'not_submitted', type: 'permission_error' },
  unauthorized: { status: 401, contractCode: 'contract_violation', delivery: 'not_submitted', type: 'authentication_error' },
  not_found: { status: 404, contractCode: 'contract_violation', delivery: 'not_submitted', type: 'invalid_request_error' },
  method_not_allowed: {
    status: 405,
    contractCode: 'contract_violation',
    delivery: 'not_submitted',
    type: 'invalid_request_error'
  },
  invalid_json: { status: 400, contractCode: 'contract_violation', delivery: 'not_submitted', type: 'invalid_request_error' },
  invalid_request: { status: 400, contractCode: 'contract_violation', delivery: 'not_submitted', type: 'invalid_request_error' },
  unknown_field: { status: 400, contractCode: 'contract_violation', delivery: 'not_submitted', type: 'invalid_request_error' },
  unsupported_role: { status: 422, contractCode: 'contract_violation', delivery: 'not_submitted', type: 'invalid_request_error' },
  unsupported_content_type: {
    status: 422,
    contractCode: 'contract_violation',
    delivery: 'not_submitted',
    type: 'invalid_request_error'
  },
  unsupported_parameter: {
    status: 422,
    contractCode: 'contract_violation',
    delivery: 'not_submitted',
    type: 'invalid_request_error'
  },
  model_not_found: { status: 404, contractCode: 'contract_violation', delivery: 'not_submitted', type: 'invalid_request_error' },
  payload_too_large: { status: 413, contractCode: 'contract_violation', delivery: 'not_submitted', type: 'invalid_request_error' },
  rate_limited: { status: 429, contractCode: 'operation_not_submitted', delivery: 'not_submitted', type: 'rate_limit_error' },
  idempotency_conflict: {
    status: 409,
    contractCode: 'contract_violation',
    delivery: 'not_submitted',
    type: 'invalid_request_error'
  },
  idempotency_in_progress: {
    status: 409,
    contractCode: 'operation_not_submitted',
    delivery: 'not_submitted',
    type: 'invalid_request_error'
  },
  idempotency_replay_unavailable: {
    status: 409,
    contractCode: 'operation_not_submitted',
    delivery: 'not_submitted',
    type: 'invalid_request_error'
  },
  server_not_enabled: { status: 503, contractCode: 'upstream_unavailable', delivery: 'not_submitted', type: 'api_error' },
  upstream_unavailable: { status: 503, contractCode: 'upstream_unavailable', delivery: 'not_submitted', type: 'api_error' },
  upstream_timeout: { status: 504, contractCode: 'upstream_timeout', delivery: 'outcome_unknown', type: 'api_error' },
  // 驱动器在产出过程中抛错：结果不可知，且**不允许**被内部重试掩盖。
  upstream_outcome_unknown: { status: 502, contractCode: 'operation_outcome_unknown', delivery: 'outcome_unknown', type: 'api_error' },
  internal_error: { status: 500, contractCode: 'internal_error', delivery: 'outcome_unknown', type: 'server_error' }
};

export interface ApiErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: ApiErrorCode;
  };
  /** I04 合同形状的同一事实，可直接喂 `validateCompanionError()`。 */
  zcc_error: CompanionError;
}

/**
 * 只允许 string / number / boolean / null，且剔除凭据键名与凭据样式取值。
 * I04 的 `CompanionError.detail` 对嵌套结构和敏感内容都是 fail-closed 的，
 * 与其在出口被拒，不如在这里就剔干净。
 */
function sanitizeDetail(detail: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (isSensitiveKey(key)) continue;
    if (value === null) continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      if (looksLikeCredentialValue(value)) continue;
      out[key] = value;
    }
  }
  return out;
}

/** 把可能含凭据样式文本的消息压成一句不含凭据形态的说明。 */
function sanitizeMessage(message: string): string {
  return looksLikeCredentialValue(message) ? '本机 API 拒绝了该请求（详情已因疑似凭据内容而省略）' : message;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** 出错字段的机读路径（`messages[0].role`）；`null` 表示不针对具体字段。 */
  readonly param: string | null;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
  private extraHeaders: Record<string, string> = {};

  constructor(code: ApiErrorCode, message: string, detail: Readonly<Record<string, unknown>> = {}, param: string | null = null) {
    const spec = API_ERROR_SPECS[code];
    if (spec === undefined) {
      throw new Error(`UNKNOWN_API_ERROR_CODE: ${String(code)}`);
    }
    super(sanitizeMessage(message));
    this.name = 'ApiError';
    this.code = code;
    this.status = spec.status;
    this.param = param;
    this.detail = Object.freeze(sanitizeDetail(detail));
  }

  /** 附加机读响应头（`Retry-After`、`x-zcc-ratelimit-*` 等）。返回自身便于链式书写。 */
  withHeaders(headers: Record<string, string>): this {
    this.extraHeaders = { ...this.extraHeaders, ...headers };
    return this;
  }

  /** 只读拷出附加头。`send` 不会看到 `extraHeaders` 本身。 */
  headers(): Record<string, string> {
    return { ...this.extraHeaders };
  }

  toCompanionError(observedAt: string): CompanionError {
    const spec = API_ERROR_SPECS[this.code];
    // 上面的构造期校验已经保证 spec 存在；这里仍走一次索引以满足类型系统。
    const resolved = spec ?? API_ERROR_SPECS.internal_error;
    return toCompanionError(resolved.contractCode, this.message, resolved.delivery, observedAt, this.detail);
  }

  toBody(observedAt: string): ApiErrorBody {
    const spec = API_ERROR_SPECS[this.code] ?? API_ERROR_SPECS.internal_error;
    return {
      error: { message: this.message, type: spec.type, param: this.param, code: this.code },
      zcc_error: this.toCompanionError(observedAt)
    };
  }
}

/**
 * 把任意抛出物转成 `ApiError`。**驱动器抛出的错误永远不被当成 `internal_error`**
 * 静默吞掉：能识别就按识别到的码走，识别不到就落到
 * `upstream_outcome_unknown`（投递结果不可知），因为那才是"来源不明"的诚实结论。
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) {
    return new ApiError('upstream_outcome_unknown', `上游驱动器异常：${err.message}`, { driver_error_name: err.name });
  }
  return new ApiError('upstream_outcome_unknown', '上游驱动器抛出非 Error 值，结果不可知', {});
}
