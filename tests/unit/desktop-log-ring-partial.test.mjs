/**
 * ZC-43 / F17：日志残片**已消费却未删除**，污染同一流的后续日志与 `flush()`。
 *
 * 缺陷机理（已在源码上核实，不是行号猜测）：
 * `append()` 把 `combined` 按换行切分，`rest` 是最后一段**未被换行确认的残片**。
 * 旧写法只在 `rest.length > 0` 时 `partial.set(stream, rest)`，于是 `rest` 为空时
 * 既不写新值、也**不删旧值**——上一块残留的 `partial` 就一直挂在 Map 里：
 *   1. 下一个 chunk 的首行会**再拼一次旧前缀**（`connect` + ` done` → `connect done`）；
 *   2. 进程结束 `flush()` 会把这条早已被消费掉的残片**当成新的一条**再落一次。
 *
 * 真实接线在 `proxy-manager.cjs`：`attachStreams()` 把 Node 的 `data` 事件原样喂给
 * `append()`，而 Node 的 chunk 边界**与行边界无关**；`onExit()` 再调 `flush()`。
 * 所以这不是"理论上可能"，是每一条按字节切分的子进程输出都会踩到。
 *
 * 本文件钉死的纪律：
 *  1. 残片被换行消费后必须真正从缓冲里**移除**（红例就是报告 F17 的原始序列）；
 *  2. 负例 (a) 整块输入行为不变；(b) `stdout`/`stderr` 的**后续行**与 `flush()`
 *     两处都不残留旧前缀（flush 是最易漏的一条，fresh-eyes gate 专门盯它）；
 *  3. 负例 (c) 多条残片不串行，残片按流隔离。
 *  4. 容量/上限/`dropped` 语义与 `clear()` 语义**不回退**——修残片不得顺手削容量。
 *
 * provider-free：纯内存调用，不 spawn 进程、不监听端口、不发网络请求、不读任何凭据。
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLogRing, LOG_STREAMS } = require('../../apps/desktop/lib/log-ring.cjs');

/**
 * 取缓冲里全部条目的文本（按时间正序）。
 * @param {ReturnType<typeof createLogRing>} ring
 * @returns {string[]}
 */
function textsOf(ring) {
  return ring.tail().map((/** @type {{ text: string }} */ e) => e.text);
}

/**
 * 只取某一条流的文本。用来证明残片按流隔离、不串行。
 * @param {ReturnType<typeof createLogRing>} ring
 * @param {'stdout'|'stderr'|'main'} stream
 * @returns {string[]}
 */
function textsOfStream(ring, stream) {
  return ring
    .tail()
    .filter((/** @type {{ stream: string }} */ e) => e.stream === stream)
    .map((/** @type {{ text: string }} */ e) => e.text);
}

/* -------------------------------------------------------------------------- */
/* 红例：报告 F17 的原始污染序列                                              */
/* -------------------------------------------------------------------------- */

describe('ZC-43 / F17 已消费的日志残片必须从缓冲中删除', () => {
  it('半行 → 换行 → 换行：残片不得串进后续行，也不得被 flush 再落一次', () => {
    const ring = createLogRing({ capacity: 50 });

    ring.append('stdout', 'connect', 1); // 半行，没有换行
    ring.append('stdout', ' ready\n', 2); // 补齐并落一行；此时 partial 必须被清掉
    ring.append('stdout', ' done\n', 3); // 全新的一条，不得再带 `connect` 前缀
    ring.flush(4); // 没有未消费残片，必须什么都不加

    // 缺陷态实际得到 ['connect ready', 'connect done', 'connect']。
    // 第二行保留**它自己的**前导空格（日志逐字节原样保留，不是缺陷），丢掉的只是
    // 上一批已经被消费掉的 `connect` 前缀；第三行是 flush 本不该多落的那条残片。
    expect(textsOf(ring)).toEqual(['connect ready', ' done']);
    expect(ring.size).toBe(2);
    expect(ring.dropped).toBe(0);
  });

  it('残片被消费后：后续行与 flush 两处都不残留旧前缀', () => {
    // (b) 报告明确要求覆盖的两处。`stdout` 与 `stderr` 都要过。
    // `@type {const}` 把循环源钉成字面量元组，循环变量才是 `'stdout'|'stderr'` 而不是 `string`。
    for (const stream of /** @type {const} */ (['stdout', 'stderr'])) {
      const ring = createLogRing({ capacity: 50 });

      ring.append(stream, 'connect', 1);
      ring.append(stream, ' ready\n', 2);
      ring.append(stream, ' done\n', 3);

      // 第一处：后续行。每一行都必须是干净的 `前缀 + 本次内容`。
      expect(textsOfStream(ring, stream)).toEqual(['connect ready', ' done']);

      // 第二处：flush 不得凭空多出一条残片。
      const beforeFlush = ring.size;
      ring.flush(4);
      expect(ring.size).toBe(beforeFlush);
      expect(textsOfStream(ring, stream)).toEqual(['connect ready', ' done']);
    }
  });

  it('每一条流都同等对待（残片 Map 是共享代码路径）', () => {
    // `LOG_STREAMS` 的运行时值就是这三个字面量（log-ring.cjs:23 的 `Object.freeze`），
    // 只是 `Object.freeze` 让 TS 推成 `readonly string[]`；此处按源码补回字面量精度。
    for (const stream of /** @type {readonly ['stdout', 'stderr', 'main']} */ (LOG_STREAMS)) {
      const ring = createLogRing({ capacity: 50 });
      ring.append(stream, 'alpha', 1);
      ring.append(stream, 'beta\n', 2);
      ring.append(stream, 'gamma\n', 3);
      ring.flush(4);
      expect(textsOfStream(ring, stream)).toEqual(['alphabeta', 'gamma']);
      expect(ring.size).toBe(2);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 负例 (a)：整块输入行为不变                                                  */
/* -------------------------------------------------------------------------- */

describe('负例 (a) 整块输入行为不变', () => {
  it('干净的缓冲上整块多行输入：行数、行内容、flush 后都不变', () => {
    const ring = createLogRing({ capacity: 50 });

    ring.append('stdout', 'alpha\nbeta\n', 1);
    expect(textsOf(ring)).toEqual(['alpha', 'beta']);
    expect(ring.size).toBe(2);

    // 整块本身不产生残片：flush 不得加任何东西。
    ring.flush(2);
    expect(textsOf(ring)).toEqual(['alpha', 'beta']);
    expect(ring.size).toBe(2);

    // 后续整块也照常落行。
    ring.append('stdout', 'gamma\n', 3);
    expect(textsOf(ring)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('已有半行之后再来整块输入：整块不得带旧前缀', () => {
    const ring = createLogRing({ capacity: 50 });

    ring.append('stdout', 'par', 1);
    ring.append('stdout', 'tial one\nline two\n', 2); // 整块：两个换行
    expect(textsOf(ring)).toEqual(['partial one', 'line two']);

    ring.append('stdout', 'tail\n', 3);
    expect(textsOf(ring)).toEqual(['partial one', 'line two', 'tail']);
  });
});

/* -------------------------------------------------------------------------- */
/* 负例 (c)：多条残片不串行                                                    */
/* -------------------------------------------------------------------------- */

describe('负例 (c) 多条残片不串行', () => {
  it('stdout / stderr 交替喂残片：各流只带自己的前缀', () => {
    const ring = createLogRing({ capacity: 50 });

    ring.append('stdout', 'a', 1);
    ring.append('stderr', 'b', 2);
    ring.append('stdout', '1\n', 3); // stdout 残片被消费
    ring.append('stderr', '2\n', 4); // stderr 残片被消费
    ring.append('stdout', '3\n', 5); // stdout 此刻不该再有任何残片
    ring.append('stderr', '4\n', 6);

    expect(textsOfStream(ring, 'stdout')).toEqual(['a1', '3']);
    expect(textsOfStream(ring, 'stderr')).toEqual(['b2', '4']);

    ring.flush(7);
    expect(ring.size).toBe(4);
  });

  it('同一流连续多次残片：逐次消费，互不叠加', () => {
    const ring = createLogRing({ capacity: 50 });

    ring.append('stdout', 'a', 1);
    ring.append('stdout', '1\n', 2);
    ring.append('stdout', 'b', 3);
    ring.append('stdout', '2\n', 4);
    ring.append('stdout', 'c', 5);
    ring.append('stdout', '3\n', 6);

    expect(textsOf(ring)).toEqual(['a1', 'b2', 'c3']);
    ring.flush(7);
    expect(ring.size).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* 回归护栏：容量/上限/clear 语义不得回退                                       */
/* -------------------------------------------------------------------------- */

describe('回归护栏：容量、上限、dropped 与 clear 语义', () => {
  it('容量上限与 dropped 计数：整块溢出照常丢最旧', () => {
    const ring = createLogRing({ capacity: 3 });
    ring.append('stdout', 'l1\nl2\nl3\nl4\nl5\n', 1);
    expect(ring.size).toBe(3);
    expect(ring.dropped).toBe(2);
    expect(textsOf(ring)).toEqual(['l3', 'l4', 'l5']);
  });

  it('容量上限下被消费的残片仍算一条完整行', () => {
    const ring = createLogRing({ capacity: 2 });
    ring.append('stdout', 'x\n', 1);
    ring.append('stdout', 'y\n', 2);
    ring.append('stdout', 'p', 3);
    ring.append('stdout', 'q\n', 4); // 残片被消费成 `pq` 这一条

    expect(ring.size).toBe(2);
    expect(ring.dropped).toBe(1);
    expect(textsOf(ring)).toEqual(['y', 'pq']);
  });

  it('flush 幂等：第一次落残片，第二次什么都不加', () => {
    const ring = createLogRing({ capacity: 50 });
    ring.append('stdout', 'kept\n', 1);
    ring.append('stdout', 'tail-fragment', 2);

    ring.flush(3);
    expect(textsOf(ring)).toEqual(['kept', 'tail-fragment']);
    expect(ring.size).toBe(2);

    ring.flush(4);
    expect(textsOf(ring)).toEqual(['kept', 'tail-fragment']);
    expect(ring.size).toBe(2);
    expect(ring.dropped).toBe(0);
  });

  it('clear() 之后残片不得复活', () => {
    const ring = createLogRing({ capacity: 50 });
    ring.append('stdout', 'gone', 1);
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.dropped).toBe(0);

    ring.append('stdout', 'fresh\n', 2);
    expect(textsOf(ring)).toEqual(['fresh']);
    ring.flush(3);
    expect(textsOf(ring)).toEqual(['fresh']);
  });
});
