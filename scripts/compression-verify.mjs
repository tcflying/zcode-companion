#!/usr/bin/env node
/**
 * compression-verify（k5，痛点②「16MiB 放宽后 mmx 压缩是否真通未复核」的判读探针）。
 *
 * 读 companion 日志，按**会话指纹**（`session_fp=`，server.ts 的 event=operation /
 * event=request 行尾字段；指纹与 k3 lane 共用 chat.ts 的 `conversationFingerprint`
 * ——`messages[0..1]` 前缀哈希）分组，输出每轮的：
 *  - `bytes=`       ：该轮请求的线上字节数（event=request 已有字段，含 JSON 开销）；
 *  - `prompt_bytes=`：该轮 `parsed.messages` 序列化字节数（全量历史体积）。
 * 然后判定「压缩后下一轮请求体积是否骤降」并打印结论。
 *
 * ## 为什么必须有这个脚本（opencodex #3573 的教训）
 * 跨过请求上限线的请求**恰恰是压缩请求本身**（mmx 全量历史序列化）——只证明
 * 「413 拒得掉」不证明「压缩放得行」。放宽上限后，「压缩真通」的唯一诚实证据
 * 是：同一会话里，接近上限的那一轮之后出现一次 prompt_bytes 骤降。
 *
 * ## 口径（如实声明，都是启发式边界）
 *  - 指纹 = `messages[0..1]` 前缀哈希：客户端**编辑历史首条消息**会换组
 *    （新组被当成新会话，只影响统计分组，不影响行为）；
 *  - 每轮的 bytes 与 prompt_bytes 按「同会话内文件序就近配对」（event=request 与
 *    event=operation 逐轮成对；被 413/429/schema 拒掉的轮次没有 session_fp，不入组）；
 *  - 「骤降」判据：相邻两轮 prompt_bytes 下降 ≥50% 且前一轮 ≥64KiB
 *    （量级门槛防小请求抖动误报）。
 *
 * 用法：
 *   node scripts/compression-verify.mjs <日志文件> [更多日志文件…]
 * 退出码：0 = 正常出报告（无论结论如何）；1 = 文件读不了；2 = 用法错误。
 */
import { readFileSync } from 'node:fs';

/** 「骤降」的相对阈值：下一轮 < 上一轮 × 0.5。 */
const DROP_RATIO = 0.5;
/** 「骤降」的量级门槛：上一轮 prompt_bytes 至少 64KiB 才参与判定。 */
const DROP_FLOOR_BYTES = 64 * 1024;

/**
 * 把一行日志切成 k=v 表（按空白切；无 '=' 的 token 忽略——生产行有 `zcc-api ` 前缀）。
 * @param {string} line
 * @returns {Record<string, string>}
 */
function kv(line) {
  const out = /** @type {Record<string, string>} */ ({});
  for (const token of line.split(/\s+/)) {
    const at = token.indexOf('=');
    if (at <= 0) continue;
    out[token.slice(0, at)] = token.slice(at + 1);
  }
  return out;
}

/**
 * @typedef {object} Turn
 * @property {number} seq            全局文件序（配对与排序用）
 * @property {number|null} bytes     event=request 的 bytes=（未配对到时 null）
 * @property {number} promptBytes    event=operation 的 prompt_bytes=
 * @property {string} status         event=operation 的 status=
 */

/**
 * @param {string[]} files
 * @returns {{ sessions: Map<string, Turn[]>, unparsed: number }}
 */
function collect(files) {
  /** @type {Map<string, Turn[]>} */
  const sessions = new Map();
  /** @type {Map<string, {seq: number, bytes: number}[]>} */
  const pendingReqs = new Map();
  let seq = 0;
  let unparsed = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.includes('event=')) continue;
      const f = kv(line);
      if (f['event'] === 'request' && f['session_fp'] !== undefined) {
        seq += 1;
        const list = pendingReqs.get(f['session_fp']) ?? [];
        list.push({ seq, bytes: Number(f['bytes'] ?? Number.NaN) });
        pendingReqs.set(f['session_fp'], list);
        continue;
      }
      if (f['event'] !== 'operation' || f['session_fp'] === undefined) continue;
      const promptBytes = Number(f['prompt_bytes']);
      if (!Number.isFinite(promptBytes)) {
        unparsed += 1;
        continue;
      }
      seq += 1;
      // 就近配对：同会话里最近一条**还没被消费**的 request 行（文件序在其之前）。
      const reqs = pendingReqs.get(f['session_fp']) ?? [];
      let bytes = null;
      for (let i = 0; i < reqs.length; i += 1) {
        const candidate = reqs[i];
        if (candidate !== undefined && candidate.seq < seq) {
          bytes = candidate.bytes;
          reqs.splice(i, 1);
          break;
        }
      }
      const turns = sessions.get(f['session_fp']) ?? [];
      turns.push({ seq, bytes: Number.isFinite(/** @type {number} */ (bytes)) ? /** @type {number} */ (bytes) : null, promptBytes, status: f['status'] ?? '?' });
      sessions.set(f['session_fp'], turns);
    }
  }
  return { sessions, unparsed };
}

/**
 * 判定一个会话内有没有「压缩骤降」。
 * @param {Turn[]} turns
 * @returns {{ hit: boolean, from: number, to: number, ratio: number } | null}
 */
function detectDrop(turns) {
  for (let i = 0; i + 1 < turns.length; i += 1) {
    const prev = turns[i]?.promptBytes;
    const next = turns[i + 1]?.promptBytes;
    if (prev === undefined || next === undefined) continue;
    if (prev < DROP_FLOOR_BYTES) continue;
    if (next < prev * DROP_RATIO) {
      return { hit: true, from: i + 1, to: i + 2, ratio: 1 - next / prev };
    }
  }
  return null;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('用法: node scripts/compression-verify.mjs <日志文件> [更多日志文件…]\n');
  process.exit(2);
}

let collected;
try {
  collected = collect(files);
} catch (e) {
  process.stderr.write(`读日志失败: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

/**
 * 字节数格式化（MiB 换算保留两位）。
 * @param {number | null} n
 * @returns {string}
 */
const fmt = (n) => (n === null ? '-' : `${String(n)} (${(n / 1024 / 1024).toFixed(2)}MiB)`);
let anyHit = false;
let sessionsWithTurns = 0;

for (const [fp, turns] of collected.sessions) {
  if (turns.length === 0) continue;
  sessionsWithTurns += 1;
  console.log(`会话 ${fp.slice(0, 12)}… ：${String(turns.length)} 轮`);
  turns.forEach((t, i) => {
    const prev = i > 0 ? turns[i - 1]?.promptBytes ?? null : null;
    const delta = prev === null || prev === 0 ? '' : `  (较上轮 ${(100 * (t.promptBytes / prev - 1)).toFixed(1)}%)`;
    console.log(`  #${String(i + 1).padStart(2)} status=${t.status.padEnd(11)} bytes=${fmt(t.bytes).padEnd(22)} prompt_bytes=${fmt(t.promptBytes)}${delta}`);
  });
  const drop = detectDrop(turns);
  if (drop !== null) {
    anyHit = true;
    console.log(`  ▶ 该会话第 ${String(drop.from)}→${String(drop.to)} 轮 prompt_bytes 下降 ${(drop.ratio * 100).toFixed(1)}%（≥50% 且前一轮 ≥64KiB）：压缩生效迹象。`);
  }
  console.log('');
}

console.log('== 结论 ==');
if (sessionsWithTurns === 0) {
  console.log('没有找到带 session_fp 的 event=operation 行：日志里还没有可判读的 chat 轮次。');
} else if (anyHit) {
  console.log('检测到压缩生效迹象（至少一个会话出现 prompt_bytes 骤降）。');
} else {
  console.log('未观察到压缩骤降：各会话 prompt_bytes 未出现 ≥50% 的相邻下降（或都低于 64KiB 门槛）。');
}
console.log(`口径：指纹=messages[0..1] 前缀哈希（编辑历史首条会换组，只影响分组）；bytes=整请求线上字节，prompt_bytes=messages 序列化字节；413/429/schema 拒掉的轮次无 session_fp 不入组${collected.unparsed > 0 ? `；${String(collected.unparsed)} 条 operation 行缺 prompt_bytes 已跳过` : ''}。`);
