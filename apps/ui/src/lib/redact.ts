/**
 * 日志与诊断脱敏（UI01）。
 *
 * 约束：任何 apiKey / token / credential 样式字符串在"写入界面状态之前"必须被替换为
 * `[REDACTED]`。本模块是唯一的写入口，所有日志条目都经过 `redact()` 后才进入 React state。
 *
 * 零依赖、零网络、零 I/O。
 */

export const REDACTED = '[REDACTED]';

/** `Authorization: Bearer <token>` 样式。必须最先执行，否则 KV 规则只会吃掉 "Bearer" 这个词。 */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]{6,}=*/g;

/** JWT 三段式。 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

/** `sk-` / `pk-` / `rk-` / `ak-` 前缀的密钥样式。 */
const PREFIXED_KEY_RE = /\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{8,}\b/g;

/**
 * `键名[:=] 值` 样式；键名可能带引号（JSON 形态），值可能是双引号、单引号或裸串。
 * 值里的 `Bearer ` 前缀一起吞掉，避免只把 "Bearer" 这个词当成值替换掉。
 */
const KEYED_VALUE_RE =
  /((?:api[_-]?keys?|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer[_-]?token|session[_-]?token|auth[_-]?token|authorization|credential|credentials|password|passwd|secret|client[_-]?secret|private[_-]?key|token)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|(?:Bearer\s+)?[^\s,;"']+)/gi;

/** `键名=64位十六进制` 形态：属于要展示的证据指纹，不按凭据处理。 */
const KEYED_SHA256_RE = /^[A-Za-z0-9_\-.]{0,24}=[0-9a-f]{64}$/i;

/** 独立出现的长 base64/hex 串（无键名上下文时也要拦）。 */
const BLOB_RE = /(?<![A-Za-z0-9_\-+/=])[A-Za-z0-9_\-+/=]{32,}(?![A-Za-z0-9_\-+/=])/g;

/** 32 位十六进制即 SHA-256 指纹，属于本产品需要展示的证据，不是凭据。 */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

/** 明显不是秘密的占位值，避免把"未接入"这类界面文案洗成 [REDACTED]。 */
const NON_SECRET_VALUES = new Set([
  '未接入',
  '未实现',
  '未知',
  'unknown',
  'undefined',
  'null',
  'none',
  'true',
  'false',
  '已脱敏',
  REDACTED,
  '（空）',
  '-'
]);

function isNonSecret(raw: string): boolean {
  const unquoted = raw.length >= 2 && /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
  return NON_SECRET_VALUES.has(unquoted.trim().toLowerCase());
}

function keepQuotes(raw: string): string {
  const first = raw.charAt(0);
  if ((first === '"' || first === "'") && raw.length >= 2 && raw.endsWith(first)) {
    return `${first}${REDACTED}${first}`;
  }
  return REDACTED;
}

/**
 * 对任意字符串做脱敏。幂等：已脱敏内容再次调用结果不变。
 * 纯函数，不修改入参。
 */
export function redact(input: string): string {
  let out = input;

  out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
  out = out.replace(JWT_RE, REDACTED);
  out = out.replace(PREFIXED_KEY_RE, REDACTED);

  out = out.replace(KEYED_VALUE_RE, (match: string, prefix: string, value: string) => {
    if (match.includes(REDACTED)) return match;
    if (isNonSecret(value)) return match;
    return `${prefix}${keepQuotes(value)}`;
  });

  out = out.replace(BLOB_RE, (match: string) => {
    if (match.includes(REDACTED)) return match;
    if (SHA256_HEX_RE.test(match)) return match;
    if (KEYED_SHA256_RE.test(match)) return match;
    if (new Set(match).size <= 2) return match;
    return REDACTED;
  });

  return out;
}

/** 把任意对象递归渲染为脱敏后的单行文本，供诊断摘要使用。 */
export function redactValue(value: unknown): string {
  if (value === null || value === undefined) return '未接入';
  if (typeof value === 'string') return redact(value);
  try {
    return redact(JSON.stringify(value) ?? '未接入');
  } catch {
    return REDACTED;
  }
}
