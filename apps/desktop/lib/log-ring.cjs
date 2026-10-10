/**
 * 子进程输出环形缓冲 + 强制脱敏。
 *
 * 硬约束：**凭据明文永不进缓冲**。
 *  1. 写入前逐条替换：注册过的机密串（当前只有本机 API key）、`Bearer <token>`、
 *     以及 `key=value` 形态的常见凭据键。命中即替换成 `[REDACTED]`，不做二次判断。
 *  2. 注册机密时**不打印**注册动作，也不把机密写进任何可被读取的字段；缓冲区
 *     与 `tail()` 返回的对象里都只会看到 `[REDACTED]`。
 *  3. 容量固定；超出从头覆盖（最旧的行先掉），并如实报告 `dropped` 计数。
 *  4. 子进程输出按行切分，**不缓存半个行**：读到的残片进 `partial`，
 *     收到换行才落一条，**残片一旦被换行消费就从 `partial` 里删除**，
 *     进程结束后 `flush()` 把残片作为最后一条落盘。
 *
 * 纯 Node 实现，不依赖 Electron，因此可被单测直接引用。
 */

'use strict';

const REDACTED = '[REDACTED]';
const DEFAULT_CAPACITY = 500;

/** 日志来源流闭集。 */
const LOG_STREAMS = Object.freeze(['stdout', 'stderr', 'main']);

/** @typedef {(typeof LOG_STREAMS)[number]} LogStream */
/** @typedef {{ seq: number, at: number, stream: LogStream, text: string }} LogEntryRecord */

/** 常见凭据键名（大小写不敏感），命中即把右侧整段替换掉。 */
const SECRET_KEY_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|credential|password|secret|client[_-]?secret|authorization|private[_-]?key)\b\s*[:=]\s*("?)[^\s"']+\2/gi;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * 对单行做脱敏。注册过的机密按**整串精确匹配**替换，不依赖任何正则。
 * @param {string} line
 * @param {readonly string[]} secrets 已注册的机密（按长度降序替换，避免前缀互相吃掉）。
 * @returns {string}
 */
function redactLine(line, secrets) {
  let out = line;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(SECRET_KEY_PATTERN, (_m, key, quote) => `${key}=${REDACTED}`);
  out = out.replace(BEARER_PATTERN, (_m, scheme) => `${scheme} ${REDACTED}`);
  return out;
}

/**
 * 创建环形日志缓冲。
 * @param {object} [options]
 * @param {number} [options.capacity]
 */
function createLogRing(options) {
  const capacity = Math.max(1, Math.trunc(options?.capacity ?? DEFAULT_CAPACITY));
  /** @type {LogEntryRecord[]} */
  let buffer = [];
  /** @type {string[]} */
  let secrets = [];
  let seq = 0;
  let dropped = 0;
  /** @type {Map<LogStream, string>} */
  const partial = new Map();

  return {
    capacity,
    /**
     * 注册需要永久遮蔽的机密串（只增不读回）。
     * @param {string} secret
     */
    addSecret(secret) {
      if (typeof secret === 'string' && secret.length >= 8 && !secrets.includes(secret)) {
        secrets.push(secret);
        // 长串优先：短串是长串前缀时，先替换长的。
        secrets.sort((a, b) => b.length - a.length);
      }
    },
    /**
     * @param {LogStream} stream
     * @param {string} text
     * @param {number} [at]
     */
    append(stream, text, at) {
      const stamp = typeof at === 'number' ? at : Date.now();
      const prior = partial.get(stream) ?? '';
      const combined = prior + String(text);
      const lines = combined.split(/\r?\n/);
      const rest = lines.pop() ?? '';
      for (const line of lines) {
        buffer.push({ seq: ++seq, at: stamp, stream, text: redactLine(line, secrets) });
      }
      // 残片的唯一状态就是"还没被换行确认的那一段"。`rest` 为空说明上一批残片
      // 已经被换行**消费**掉了，此时必须 `delete`——只 `set` 不 `delete` 会让旧
      // 前缀一直挂在 Map 上：下个 chunk 的首行再拼一次，`flush()` 又把它当成新
      // 的一条落盘。
      if (rest.length > 0) partial.set(stream, rest);
      else partial.delete(stream);
      while (buffer.length > capacity) {
        buffer.shift();
        dropped++;
      }
    },
    /**
     * 进程结束后把残片作为最后一条落下（不换行的最后一段也算一条输出）。
     * @param {number} [at]
     */
    flush(at) {
      const stamp = typeof at === 'number' ? at : Date.now();
      for (const [stream, rest] of partial) {
        if (rest.length > 0) {
          buffer.push({ seq: ++seq, at: stamp, stream, text: redactLine(rest, secrets) });
        }
      }
      partial.clear();
      while (buffer.length > capacity) {
        buffer.shift();
        dropped++;
      }
    },
    /**
     * @param {number} [n] 取最近 n 条（默认全部），按时间正序返回。
     * @returns {LogEntryRecord[]}
     */
    tail(n) {
      const limit = typeof n === 'number' && n > 0 ? Math.min(Math.trunc(n), buffer.length) : buffer.length;
      return buffer.slice(buffer.length - limit).map((e) => ({ ...e }));
    },
    /**
     * 当前登记的机密串**副本**。
     *
     * 存在的理由：脱敏日志导出（`lib/log-export.cjs`）要在导出边界**再脱敏一次**，
     * 而它必须用**环里同一份**机密集。让导出侧去猜「登记的是哪几串」就是让它有机会漏。
     * 返回副本而不是内部数组：调用方拿到的副本再排序也污染不到环内状态。
     *
     * @returns {string[]}
     */
    secrets() {
      return secrets.slice();
    },
    clear() {
      buffer = [];
      partial.clear();
      dropped = 0;
    },
    get dropped() {
      return dropped;
    },
    get size() {
      return buffer.length;
    }
  };
}

exports.createLogRing = createLogRing;
exports.redactLine = redactLine;
exports.REDACTED = REDACTED;
exports.LOG_STREAMS = LOG_STREAMS;
