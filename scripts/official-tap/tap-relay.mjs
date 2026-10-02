/**
 * tap-relay.mjs — 三个流的逐字节中继。
 *
 * 这里的中继**不解释内容**。它做的事只有四件：
 *  1. 收到 chunk 就把**同一个 Buffer 对象**交给 `dest.write()`；
 *  2. 旁路回调（observer）拿到的也是同一个 Buffer，它只能读、只能拷走自己需要的
 *     片段，**不得写回**——所以旁路观察不可能污染转发路径；
 *  3. 下游背压时 `pause()` 源、等 `drain` 再 `resume()`：不丢帧、不无界堆积；
 *  4. 累计字节数供诊断使用（只记数字，不记内容）。
 *
 * 明确不做的事：不加换行、不重新序列化 JSON、不合并 chunk、不缓冲整帧、不
 * `pipe()`+监听混用（那会让同一段字节既被转发又被复制一份到用户态缓冲）。
 *
 * 方向与结束语义：
 *  - 父 stdin → 子 stdin：源结束时**必须** `end()` 目标，桌面关掉 stdin 等价于
 *    app-server 收到 EOF，这是与无 tap 时一致的行为。
 *  - 子 stdout → 父 stdout：源结束时**不** `end()` 目标。tap 不是 app-server，
 *    关掉父进程的 stdout 会打断桌面自己的后续写入。
 *  - 子 stderr → 父 stderr：直通，**永不旁路扫描、永不记录内容**。
 */

/**
 * 一条被泵送的流的方向标识，仅用于诊断事件名。
 *
 * @typedef {'parent_to_child' | 'child_to_parent' | 'child_stderr'} PumpDirection
 */

/**
 * 泵句柄的不可变视图。
 *
 * @typedef {Object} PumpStats
 * @property {number} bytes
 * @property {number} chunks
 */

/**
 * @typedef {Object} PumpHandle
 * @property {PumpDirection} direction
 * @property {boolean} ended 源已结束（读到 EOF）。不代表目标已结束。
 * @property {number} pauses 背压导致的暂停次数（诊断用，说明下游确实在拖慢）。
 * @property {PumpStats} stats
 * @property {() => void} stop 停止转发并摘掉监听。可重复调用。
 * @property {number} observerFailures 仅供诊断：观察器失败次数。
 */

/**
 * @typedef {Object} PumpOptions
 * @property {PumpDirection} direction
 * @property {((chunk: Buffer) => void) | undefined} [observe] 旁路观察回调。**只读**。抛出的异常会被吞掉并计数——观察永远不能打断中继。
 * @property {(() => void) | undefined} [onEnd] 源读到 EOF 时调用。
 * @property {((code: string) => void) | undefined} [onDestError] 目标流出错（如 EPIPE）时调用。
 * @property {((code: string) => void) | undefined} [onSourceError] 源流出错时调用。
 */

/** @param {unknown} error @returns {string} */
function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error ? String(/** @type {{code: unknown}} */ (error).code) : 'EUNKNOWN';
}

/**
 * 调用一个**生命周期回调**，并把它的异常吞掉（只计一次 `observerFailures` 语义的失败）。
 *
 * 为什么：`onEnd` / `onDestError` / `onSourceError` 都跑在 net/stream 的事件发射里，
 * 抛出去就是 uncaughtException → tap 进程退出 → 桌面那条 app-server 会话一起死。
 * 回调里的失败绝不能升级成"重启会话"。
 *
 * @param {(() => void) | undefined} callback
 */
function safeCallback(callback) {
  if (callback === undefined) return;
  try {
    callback();
  } catch {
    // 回调失败不改变转发语义：字节该转的已经转完了。
  }
}

/**
 * 建一条逐字节中继。**不使用 `stream.pipe`**：`pipe` 会自己做缓冲与背压决策，
 * 而我们需要在同一次 `data` 事件里既旁路观察又原样转发，并精确统计字节。
 *
 * @param {import('node:stream').Readable} source
 * @param {import('node:stream').Writable} dest
 * @param {PumpOptions} options
 * @returns {PumpHandle}
 */
export function pumpBytes(source, dest, options) {
  let bytes = 0;
  let chunks = 0;
  let pauses = 0;
  let ended = false;
  let stopped = false;
  let observerFailures = 0;

  /** @param {Buffer} chunk */
  const onData = (chunk) => {
    chunks += 1;
    bytes += chunk.length;
    if (options.observe !== undefined) {
      // 观察器抛错只计数、不上抛：中继的保真性优先于观察的便利性。
      try {
        options.observe(chunk);
      } catch {
        observerFailures += 1;
      }
    }
    let flushed = true;
    try {
      flushed = dest.write(chunk);
    } catch (error) {
      safeCallback(() => options.onDestError?.(errorCode(error)));
      return;
    }
    if (!flushed) {
      // 背压：下游满了就停读，等 drain 再继续。不丢帧，也不无界堆积。
      pauses += 1;
      source.pause();
      dest.once('drain', () => {
        if (!stopped) source.resume();
      });
    }
  };

  const onEnd = () => {
    if (ended) return;
    ended = true;
    safeCallback(options.onEnd);
  };

  // 这两个必须是**具名函数引用**：stop() 靠 `removeListener` 摘掉它们，换成内联箭头
  // 就摘不掉了（监听会一直吊着流对象，延迟关停）。
  /** @param {unknown} error */
  const onSourceError = (error) => {
    safeCallback(() => options.onSourceError?.(errorCode(error)));
  };
  /** @param {unknown} error */
  const onDestError = (error) => {
    safeCallback(() => options.onDestError?.(errorCode(error)));
  };

  source.on('data', onData);
  source.on('end', onEnd);
  source.on('error', onSourceError);
  dest.on('error', onDestError);

  return {
    direction: options.direction,
    get ended() {
      return ended;
    },
    get pauses() {
      return pauses;
    },
    get stats() {
      return { bytes, chunks };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      source.removeListener('data', onData);
      source.removeListener('end', onEnd);
      source.removeListener('error', onSourceError);
      dest.removeListener('error', onDestError);
    },
    /** 仅供诊断：观察器失败次数。 */
    get observerFailures() {
      return observerFailures;
    }
  };
}
