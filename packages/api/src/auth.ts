/**
 * API01 认证、Host/Origin 门、限流与请求体预算。
 *
 * 四条硬事实：
 *  1. **key 不落明文、不进日志。** 这里只做三件事：生成、定长摘要比对、算指纹。
 *     比对走 `crypto.timingSafeEqual` 且**总是**比同样长的摘要（包括没有配置 key
 *     时也比一个哑摘要），避免"key 长度/存在性"变成时序侧信道。指纹是
 *     `zcc-fp:<sha256 前 12 位>`，只用于日志与幂等作用域，**不可逆推出 key**。
 *  2. **Host 头是防 DNS rebinding 的第一道门。** 只接受本进程真实监听端口上的
 *     `127.0.0.1` / `localhost`，端口必须相等。`0.0.0.0`、`::`、任意域名一律拒。
 *  3. **Origin 默认白名单为空。** 没有 `Origin` 头的（普通 IDE 扩展、curl）
 *     放行；带 `Origin` 的（浏览器）默认**全拒**。这是 fail-closed 的方向：
 *     想放行必须显式配置。CORS 响应头由 server 层保证永不输出。
 *  4. **限流不排队。** 并发槽与令牌桶都在尝试时同步判定，拿不到就立刻 429，
 *     绝不在队列里无限等待。令牌桶**不建定时器**：过期额度按时间戳惰性计算。
 *     唯一的定时器是空闲作用域清扫器，`unref()` 且由 `close()` 显式 `clearInterval`。
 *  5. **幂等是显式 opt-in（工单 COMPAT1/C1）。** `resolveIdempotencyOptIn` 只在
 *     客户端**真的**发了 `Idempotency-Key` 或 `x-zcc-client-id` / `x-zcc-session-id`
 *     时才给出作用域；**一个头都没发 = 每次都是新 operation**。缺头回落
 *     `default-client` 那条路已整条删除——它让所有标准 OpenAI 兼容客户端落进同一
 *     作用域，首个成功请求之后全线 409（协调者实弹 0.003 s 复现）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 唯一允许的绑定地址。类型层与运行期都锁死这一条。 */
export const HOST_LOOPBACK = '127.0.0.1' as const;

/** HTTP 请求体上限 1 MiB。超限 413，不缓冲。 */
export const REQUEST_BODY_MAX_BYTES = 1024 * 1024;
/** `metadata` 对象序列化后上限 64 KiB。 */
export const METADATA_MAX_BYTES = 64 * 1024;

/** 允许出现在 Host 头里的主机名（不含端口）。 */
export const ALLOWED_HOST_NAMES: readonly string[] = [HOST_LOOPBACK, 'localhost'];

const KEY_PREFIX = 'zcc_';
const KEY_ENTROPY_BYTES = 32;

/**
 * 生成一个本机 API key。调用方负责在设置页展示一次，本产品不落明文文件。
 * key 只在设置页内存里存在，Companion 重启后由用户自行重新生成。
 */
export function generateApiKey(): string {
  return `${KEY_PREFIX}${randomBytes(KEY_ENTROPY_BYTES).toString('base64url')}`;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** 日志用指纹：稳定、不可逆、不含 key 任何片段。 */
export function fingerprintApiKey(key: string): string {
  return `zcc-fp:${digest(key).toString('hex').slice(0, 12)}`;
}

const DUMMY_DIGEST = digest('zcc-no-key-configured-dummy-value');

export interface KeyVerification {
  readonly ok: boolean;
  /** 验证通过时的 key 指纹；失败时为 `null`。 */
  readonly fingerprint: string | null;
}

/**
 * 校验 `Authorization: Bearer <key>`。
 * 方案名必须精确是 `Bearer`（大小写不敏感），其余一律失败。
 */
export function verifyApiKey(authorizationHeader: string | undefined, configured: readonly string[]): KeyVerification {
  const header = authorizationHeader ?? '';
  const match = /^Bearer[ ]+(\S+)$/.exec(header.trim());
  const presented = match?.[1] ?? '';
  const presentedDigest = presented === '' ? DUMMY_DIGEST : digest(presented);
  let matched: string | null = null;
  // 无论是否命中都走完整个列表的定长比对：命中不提前 return。
  for (const candidate of configured) {
    const candidateDigest = digest(candidate);
    if (timingSafeEqual(candidateDigest, presentedDigest)) matched = candidate;
  }
  if (matched === null || presented === '') return { ok: false, fingerprint: null };
  return { ok: true, fingerprint: fingerprintApiKey(matched) };
}

/** Host 头是否被允许。端口必须与真实监听端口严格相等。 */
export function isAllowedHost(hostHeader: string | undefined, listeningPort: number): boolean {
  const raw = (hostHeader ?? '').trim().toLowerCase();
  if (raw === '') return false;
  if (raw.startsWith('[')) return false; // 我们只绑 IPv4 回环，不接受 IPv6 字面量
  const colon = raw.lastIndexOf(':');
  if (colon < 0) return false;
  const name = raw.slice(0, colon);
  const port = raw.slice(colon + 1);
  if (!/^\d{1,5}$/.test(port)) return false;
  if (Number(port) !== listeningPort) return false;
  return ALLOWED_HOST_NAMES.includes(name);
}

/**
 * Origin 门。没有 Origin 头 = 非浏览器客户端，放行。
 * 有 Origin 头 = 默认全拒，只有显式列入 `allowedOrigins` 的才放行。
 */
export function isAllowedOrigin(originHeader: string | undefined, allowedOrigins: readonly string[]): boolean {
  const raw = originHeader;
  if (raw === undefined || raw.trim() === '') return true;
  if (allowedOrigins.length === 0) return false;
  return allowedOrigins.includes(raw.trim());
}

export type RateLimitRejection = 'concurrency' | 'rate';

export interface RateLimitAdmission {
  readonly ok: boolean;
  readonly reason: RateLimitRejection | null;
  readonly retryAfterMs: number;
  readonly remaining: number;
  readonly limit: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  lastSeenAt: number;
}

export interface RateLimitOptions {
  /** 同时在途请求上限。 */
  readonly maxConcurrent: number;
  /** 窗口内允许的请求数（桶容量 = 突发上限 = 该值）。 */
  readonly requests: number;
  readonly windowMs: number;
  /** 空闲作用域清扫间隔；`0` 表示不建定时器。 */
  readonly sweepMs?: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { maxConcurrent: 4, requests: 60, windowMs: 60_000 };

/**
 * 并发上限 + 令牌桶速率上限。两者都**同步判定、永不排队**。
 *
 * 定时器只有一个：清扫器。它 `unref()`（不阻止事件循环退出）并由 `close()`
 * 显式 `clearInterval`，`activeTimers` 如实反映它是否还活着——关闭测试直接断言
 * 它归零，而不是靠"进程能退出"这种间接证据。
 */
export class RateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly maxConcurrent: number;
  private readonly buckets = new Map<string, Bucket>();
  private readonly clock: () => number;
  private sweeper: NodeJS.Timeout | null = null;
  private inFlight = 0;

  constructor(options: RateLimitOptions = DEFAULT_RATE_LIMIT, clock: () => number = Date.now) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
    this.limit = Math.max(1, Math.floor(options.requests));
    this.windowMs = Math.max(1, Math.floor(options.windowMs));
    this.clock = clock;
    const sweepMs = options.sweepMs ?? 60_000;
    this.sweeper =
      sweepMs > 0
        ? setInterval(() => {
            const cutoff = this.clock() - this.windowMs * 2;
            for (const [key, bucket] of this.buckets) {
              if (bucket.lastSeenAt < cutoff) this.buckets.delete(key);
            }
          }, sweepMs)
        : null;
    // 不阻止事件循环退出：关闭与否由 stop() 决定，不由它决定。
    this.sweeper?.unref();
  }

  /** 定时器是否仍在。这是"回收所有 timer"的可断言事实。 */
  get activeTimers(): number {
    return this.sweeper === null ? 0 : 1;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  tryAcquire(scope: string): RateLimitAdmission {
    const now = this.clock();
    if (this.inFlight >= this.maxConcurrent) {
      return { ok: false, reason: 'concurrency', retryAfterMs: 250, remaining: 0, limit: this.limit };
    }
    const refillPerMs = this.limit / this.windowMs;
    const bucket = this.buckets.get(scope) ?? { tokens: this.limit, updatedAt: now, lastSeenAt: now };
    bucket.tokens = Math.min(this.limit, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;
    bucket.lastSeenAt = now;
    if (bucket.tokens < 1) {
      this.buckets.set(scope, bucket);
      const retryAfterMs = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs));
      return { ok: false, reason: 'rate', retryAfterMs, remaining: 0, limit: this.limit };
    }
    bucket.tokens -= 1;
    this.buckets.set(scope, bucket);
    this.inFlight += 1;
    return { ok: true, reason: null, retryAfterMs: 0, remaining: Math.floor(bucket.tokens), limit: this.limit };
  }

  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }

  /** 回收定时器并清空状态。可重复调用。 */
  close(): void {
    if (this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    this.buckets.clear();
    this.inFlight = 0;
  }
}

/** 稳定的 JSON 规范化 + sha256。键序无关、值敏感。幂等作用域与 body 指纹共用它。 */
export function canonicalRequestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 幂等作用域摘要：`客户端身份 + 会话 + key 指纹`。
 * 规范化 body 的哈希不参与作用域（它是冲突判据，不是作用域维度）。
 */
export function idempotencyScope(clientId: string, sessionId: string, keyFingerprint: string): string {
  return canonicalRequestHash({ clientId, sessionId, keyFingerprint });
}

/* -------------------------------------------------------------------------- */
/* COMPAT1 · C1：幂等改为**显式 opt-in**                                        */
/* -------------------------------------------------------------------------- */

/**
 * OpenAI 惯例的幂等头（工单 COMPAT1/C1）。本端点认它，也**只**把它与下面两个
 * `x-zcc-*` 头当作"我要幂等"的显式声明。
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** 本端点自定义的客户端身份头 / 会话头。二者任一在场同样是**显式 opt-in**。 */
export const CLIENT_ID_HEADER = 'x-zcc-client-id';
export const SESSION_ID_HEADER = 'x-zcc-session-id';

/**
 * 幂等头里**允许**出现的字符形状。超长 / 含控制字符 / 含分隔符的一律**不算**
 * 一次显式声明（退化成"无头 = 每次新 operation"），而不是被原样写进作用域键。
 *
 * 为什么要有形状闸门：作用域键会进 `operations` 这张表的键。没有闸门的话，
 * 任意字节都能成为表键，而 `MAX_IDEMPOTENCY_ENTRIES` 是唯一的容量兜底——那等于
 * 让未验证的客户端输入决定内存布局。
 */
const IDEMPOTENCY_TOKEN_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * 把一个幂等头值规范化成可作作用域维度的 token；不合形状就返回 `null`。
 *
 * 与 `server.ts` 里 `sanitizeIdentity` 的差别是**意图**相同、**落点**不同：
 * 那一个不合形状时**回落到一个缺省身份**（隐式坍缩，正是 C1 要消灭的东西），
 * 这一个**直接判定"这次请求没有显式 opt-in"**。
 *
 * @param value 原始头值（Node 可能给 `string[]`）
 * @returns 合法 token；没有或不合形状时 `null`
 */
export function sanitizeIdempotencyToken(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  const trimmed = raw.trim();
  if (!IDEMPOTENCY_TOKEN_SHAPE.test(trimmed)) return null;
  return trimmed;
}

/**
 * 一次请求的**幂等 opt-in 判定结果**。
 *
 * 三个取值，**没有第四个**：
 *  - `none`：**一个幂等头都没发**（或发的值不合形状）。每次都是新 operation：
 *    不重放、不比对 bodyHash、不 409。
 *  - `identity`：发了 `x-zcc-client-id` 或 `x-zcc-session-id`（至少一个合法）。
 *    作用域 = `clientId + sessionId + keyFingerprint`，缺的一维用缺省值。
 *  - `key`：发了 `Idempotency-Key`（合法）。作用域 = `key + keyFingerprint`。
 *
 * **为什么 `key` 优先于 `identity`**：OpenAI 惯例里 `Idempotency-Key` 是**逐次请求**
 * 的令牌，同一个键复用两次就是"同一次操作重试"，而 `x-zcc-session-id` 是**逐会话**
 * 的身份。两者同时在场时按更具体的那一维判冲突，才符合客户端的直觉。
 */
export type IdempotencyOptIn =
  | { readonly kind: 'none' }
  | { readonly kind: 'identity'; readonly clientId: string; readonly sessionId: string; readonly scope: string }
  | { readonly kind: 'key'; readonly scope: string };

/**
 * 从请求头判定幂等 opt-in。
 *
 * ## 这条判据取代了"缺头即 default-client/default-session"（工单 COMPAT1/C1）
 *
 * 旧实现在**没有** `x-zcc-client-id` / `x-zcc-session-id` 时把它们各自回落到
 * `default-client` / `default-session`，于是**所有**不带头的请求（标准 OpenAI 兼容
 * 客户端、mcode、其它 IDE 的默认配置）落进**同一个**作用域；而 `runChat` 在首个
 * **成功**请求后就把 `(scope → bodyHash)` 钉进 operations 表，任何**不同**请求体
 * 直接 409 `idempotency_conflict`（协调者实弹：0.003 s 拿到 409），直到进程重启。
 * 那是一条 100% 复现的硬阻断。
 *
 * 现在的方向是 **fail-open 到"每次新 operation"**：不带头 = 客户端没有要幂等，
 * 我们就不替它猜。显式 opt-in 的两条路径（`Idempotency-Key` / `x-zcc-*` 双头）
 * replay 与冲突检测逻辑**一字未动**。
 *
 * @param headers Node 的入站请求头（只需读取三个键）
 * @param keyFingerprint 已通过认证的 key 指纹
 */
export function resolveIdempotencyOptIn(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  keyFingerprint: string
): IdempotencyOptIn {
  const token = sanitizeIdempotencyToken(headers[IDEMPOTENCY_KEY_HEADER]);
  if (token !== null) {
    return { kind: 'key', scope: canonicalRequestHash({ idempotencyKey: token, keyFingerprint }) };
  }
  const clientId = sanitizeIdempotencyToken(headers[CLIENT_ID_HEADER]);
  const sessionId = sanitizeIdempotencyToken(headers[SESSION_ID_HEADER]);
  if (clientId === null && sessionId === null) return { kind: 'none' };
  const client = clientId ?? 'default-client';
  const session = sessionId ?? 'default-session';
  return { kind: 'identity', clientId: client, sessionId: session, scope: idempotencyScope(client, session, keyFingerprint) };
}
