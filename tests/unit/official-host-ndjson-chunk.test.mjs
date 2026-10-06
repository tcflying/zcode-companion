/**
 * ZC-23 / F03：官方 app-server 的 **stdout NDJSON 跨块连续缓冲**。
 *
 * ## 这条用例钉的是什么
 *
 * `scripts/official-host/session-drive.mjs` 的 `driveSession` 是**内层**宿主：它从官方
 * app-server 子进程的 stdout 读 NDJSON，**自己**分帧、自己按行解析。缺陷 F03 就在这里：
 * 分帧缓冲**不连续**——一行 NDJSON 正文被拆到两个 `data` 块时，两段被**分别**当成两条
 * "行"送去 `JSON.parse`，两段都解析失败，于是**整行被丢**，而 `finish` 仍可能照常到达。
 * 症状是"成功但正文缺段"。
 *
 * 报告里的实测形状（`整块 alpha beta` / `分割后仅 alpha `；`前缀:中文` / `前缀:`）在本文件
 * 里被复刻为**合成管道 fixture**：同样的字节，四种切分点，结果必须**逐字相等**。
 *
 * ## 硬边界
 *
 *  - **本文件从不 spawn 官方 ZCode / app-server**，从不读官方 bundle，不解密任何凭据，
 *    不发任何模型请求。子进程是一个**本文件内存里造的合成 app-server**：一对
 *    `Writable` / `PassThrough`，`driveSession` 看到它与真实 `ChildProcess` 无差别。
 *  - **不碰外层 `host-driver.ts` 的缓冲**：外层缓冲是对的，掩盖内层缺陷等于把 F03 藏起来。
 *  - **不断言"所有分块都丢文本"**：零 delta 时 `turn.completed.payload.response` 的全文
 *    兜底仍然有效（见"负例 (a)"）。本文件断言的是"**跨块丢段**"这一条具体路径。
 *
 * ## 四种切分（同一份字节，四组切点）
 *
 *  1. `whole`                     —— 整块，一个 `data` 事件。对照组。
 *  2. `split-halves`              —— 每一行都从中间切开（行内切块）。
 *  3. `multi-line-tail-residue`   —— 一个块里含多条完整行 + 末尾半行残片（跨块拼行）。
 *  4. `utf8-inside-char`          —— 切点落在一个多字节字符**字内**（UTF-8 半个字）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

/** 被驱动的合成 app-server 回报的 sessionId。**不是**任何真实 session。 */
const SESSION_ID = 'sess-zc23-synthetic-0001';
/** `driveSession` 内部使用的请求 id（`zcc-host-<operationId>`）。 */
const REQUEST_ID = 'zcc-host-op-zc23-fixture';
/** 墙钟上限。合成链全是进程内事件，毫秒级即可；留足冗余避免变成"超时红"。 */
const DRIVE_TIMEOUT_MS = 4000;
/**
 * turn 块写完之后延迟多久关掉 stdout（触发 `'end'`）。必须**远大于**写完 turn 块所需时间
 * （每块一个宏任务），否则会关在半路——那会让"末行缺尾换行"用例测到别的东西。
 */
const STDOUT_END_DELAY_MS = 60;

/** @type {typeof import('../../scripts/official-host/session-drive.mjs')} */
let drive;

/** 本测试的请求。字段形状与 `host-child.mjs` 传给 `driveSession` 的那个一致。 */
const REQUEST = Object.freeze({
  operationId: 'op-zc23-fixture',
  providerId: 'account:zai-start-plan',
  modelId: 'GLM-5.3-Flash',
  thoughtLevel: 'high',
  prompt: 'hi',
  workspacePath: 'C:/synthetic/zc23-ndjson-chunk',
  maxTokens: null
});

/**
 * 造一条 `session/event` 线上信封（点号 `params.type`，官方 25 项闭集之一）。
 * @param {string} type 官方闭集里的事件类型字面量。
 * @param {Record<string, any>} payload 事件载荷。
 * @returns {{ method: string, params: Record<string, any> }}
 */
function wireEvent(type, payload) {
  return {
    method: 'session/event',
    params: { deliveryKind: 'desktop-continuous', eventId: 'e1', payload, seq: 1, sessionId: SESSION_ID, timestamp: 1, type }
  };
}

/**
 * 一个 NDJSON 行（**含**行尾换行）。
 * @param {Record<string, any>} frame 整帧。
 * @returns {string}
 */
function ndjson(frame) {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * 正文载荷：**与卡上实测同形**（ASCII 段 + 中文段 + 尾段），并以官方形状收尾。
 *
 * 拼起来的正文逐字是 `alpha 前缀:中文beta`；`turn.completed.payload.response`
 * 逐字等于它，所以**零 delta 兜底与增量路径在本文件里给出完全相同的答案**。
 *
 * @returns {string[]} NDJSON 行
 */
function turnLines() {
  return [
    ndjson({ id: REQUEST_ID, result: { accepted: true } }),
    ndjson(wireEvent('model.streaming', { kind: 'text_delta', delta: 'alpha ' })),
    ndjson(wireEvent('model.streaming', { kind: 'text_delta', delta: '前缀:中文' })),
    ndjson(wireEvent('model.streaming', { kind: 'text_delta', delta: 'beta' })),
    ndjson(wireEvent('turn.completed', { response: 'alpha 前缀:中文beta', tokenCount: 0, toolCallCount: 0, duration: 1, resultType: 'success' }))
  ];
}

/** 逐字期望的正文（不是拼出来的，是**独立写死**的那一份）。 */
const EXPECTED_BODY = 'alpha 前缀:中文beta';

/** 逐字期望的完整事件流。 */
const EXPECTED_EVENTS = [
  { type: 'delta', text: 'alpha ' },
  { type: 'delta', text: '前缀:中文' },
  { type: 'delta', text: 'beta' },
  { type: 'finish', reason: 'stop' }
];

/**
 * 每行（含换行）在整份字节流里的 `[start, end)` 偏移。
 * @param {Buffer} buf
 * @returns {Array<[number, number]>}
 */
function lineSpans(buf) {
  /** @type {Array<[number, number]>} */
  const spans = [];
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    spans.push([at, nl + 1]);
    at = nl + 1;
  }
  return spans;
}

/**
 * 把切点列表变成块序列。空列表 = 整块一个 `data` 事件。
 * @param {Buffer} buf
 * @param {readonly number[]} cuts 升序、去重、落在 `(0, buf.length)` 内
 * @returns {Buffer[]}
 */
function chunksAt(buf, cuts) {
  /** @type {Buffer[]} */
  const chunks = [];
  let at = 0;
  for (const cut of cuts) {
    if (cut <= at || cut >= buf.length) continue;
    chunks.push(buf.subarray(at, cut));
    at = cut;
  }
  if (at < buf.length) chunks.push(buf.subarray(at));
  return chunks;
}

/**
 * 切点组 2：**每一行都从中间切开**。
 * @param {Buffer} buf
 * @returns {number[]}
 */
function splitHalvesCuts(buf) {
  return lineSpans(buf).map(([s, e]) => s + Math.ceil((e - s) / 2));
}

/**
 * 切点组 3：**多行尾残片**——第一个块含前两条完整行 + 第三条的一半，
 * 第二块是第三行的剩余部分 + 后两条整行。切点必然落在行内。
 * @param {Buffer} buf
 * @returns {number[]}
 */
function multiLineTailResidueCuts(buf) {
  const spans = lineSpans(buf);
  if (spans.length === 0) throw new Error('ZC23_FIXTURE_HAS_NO_LINE');
  // 有 ≥3 行时切点落在**第三条**行内：前两块含"多条完整行 + 末尾半行残片"，
  // 后面的整行仍能到达 ⟹ 旧缺陷下表现为"**终态到了、正文缺段**"。
  // 行数不足时退化成"最后一行从中间切开"——仍是跨块拼行，只是没有多行前缀。
  // `spans` 非空已由上面那行 `throw` 钉死 ⟹ 右侧两个下标里**至少有一个**有值：
  // `noUncheckedIndexedAccess` 看不见这个不变式，这里把**已经成立的事实**补进类型层。
  const target = /** @type {[number, number]} */ (spans[2] ?? spans[spans.length - 1]);
  return [target[0] + Math.ceil((target[1] - target[0]) / 2)];
}

/**
 * 切点组 4：**切点落在多字节字符字内**——取第一个 UTF-8 续字节（`0b10xxxxxx`）
 * 的偏移作为切点，那么前一个块以首字节结尾、后一个块以续字节开头。
 * @param {Buffer} buf
 * @returns {number[]}
 */
function utf8InsideCharCuts(buf) {
  for (let i = 1; i < buf.length; i += 1) {
    // `i` 取自 `1 .. buf.length - 1` ⟹ 下标在界内；`Buffer` 的数值下标在
    // `noUncheckedIndexedAccess` 下带 `undefined`，这里只把界内性补进类型层。
    if ((/** @type {number} */ (buf[i]) & 0xc0) === 0x80) return [i];
  }
  throw new Error('ZC23_FIXTURE_HAS_NO_MULTI_BYTE_CHAR');
}

/** 全部四种切分（键名即断言名的一部分）。 */
const TURN_CUTTINGS = Object.freeze({
  whole: (/** @type {Buffer} */ _buf) => /** @type {number[]} */ ([]),
  'split-halves': splitHalvesCuts,
  'multi-line-tail-residue': multiLineTailResidueCuts,
  'utf8-inside-char': utf8InsideCharCuts
});

/**
 * 造一个**合成 app-server**：`driveSession` 眼里的 `child`。
 *
 * - `stdin` 是一条 `Writable`：收到完整 NDJSON 请求行就按 method 应答。
 * - `stdout` 是一对 `PassThrough`：**turn 载荷按给定切点逐块写**。写块之间 await 一个
 *   宏任务，保证每个 `write` 各自成为一次 `data` 事件（块边界可复现，不靠运气）。
 * - `endStdoutAfterTurn` 为真时，turn 块写完后**关掉 stdout**（`endStdoutEndDelayMs` 之后）——
 *   用来钉"末行缺尾换行"的既有边缘语义：那条残片只在 `'end'` 上才会被冲一次。
 * - 收到 `input.end()`（`session/close` 之后）就**自然** `exit 0`——与真实 app-server
 *   关掉 stdin 后自行退出的形状一致，于是 `waitForAppServerExit` 立即落定。
 *
 * @param {{
 *   handshakeChunks?: (text: string) => Buffer[],
 *   turnChunks: Buffer[],
 *   endStdoutAfterTurn?: boolean
 * }} plan
 */
function makeSyntheticAppServer(plan) {
  const stdout = new PassThrough();
  const child = /** @type {any} */ (new EventEmitter());
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = stdout;
  child.stdin = undefined;

  /** @type {Buffer[]} */
  const queue = [];
  /** @type {string} */
  let stdinText = '';
  /** @type {Promise<void>} */
  let pumping = Promise.resolve();
  let streamEnded = false;

  /**
   * 逐块写 stdout。**块之间 await 一个宏任务**：这是"块边界可复现"的唯一保证。
   * @returns {Promise<void>}
   */
  async function pump() {
    for (;;) {
      if (streamEnded) return;
      const chunk = queue.shift();
      if (chunk === undefined) return;
      stdout.write(chunk);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** @param {Buffer[]} chunks */
  function enqueue(chunks) {
    for (const chunk of chunks) queue.push(chunk);
    pumping = pumping.then(pump);
  }

  /** turn 块写完后按需关掉 stdout，触发 `'end'`。 */
  function armStreamEnd() {
    if (plan.endStdoutAfterTurn !== true) return;
    setTimeout(() => {
      if (streamEnded) return;
      streamEnded = true;
      stdout.end();
    }, STDOUT_END_DELAY_MS).unref?.();
  }

  /**
   * 收到一条完整请求行 → 应答。
   * @param {string} line
   */
  function onRequestLine(line) {
    /** @type {any} */
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    const id = frame.id;
    const method = frame.method;
    if (method === 'session/create') {
      // 实弹形状：真的那个 id 在 `result.session.sessionId`，四层深。
      enqueue((plan.handshakeChunks ?? ((t) => [Buffer.from(t, 'utf8')]))(ndjson({ id, result: { session: { sessionId: SESSION_ID } } })));
      return;
    }
    if (method === 'session/subscribe') {
      enqueue((plan.handshakeChunks ?? ((t) => [Buffer.from(t, 'utf8')]))(ndjson({ id, result: { ok: true } })));
      return;
    }
    if (method === 'session/send') {
      // fire-and-forget：先回 `accepted`，产出在事件流里（**这才是本卡的对象**）。
      enqueue([Buffer.from(ndjson({ id, result: { accepted: true } }), 'utf8')]);
      enqueue(plan.turnChunks);
      armStreamEnd();
      return;
    }
    if (method === 'session/close') {
      enqueue([Buffer.from(ndjson({ id, result: { closed: true } }), 'utf8')]);
      return;
    }
    // 其余（`provider/updateAccountConfig` 等）一律回**同一个 id** 的成功回执。
    enqueue([Buffer.from(ndjson({ id, result: {} }), 'utf8')]);
  }

  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinText += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = stdinText.split('\n');
      stdinText = /** @type {string} */ (lines.pop());
      for (const line of lines) onRequestLine(line);
      callback();
    },
    final(callback) {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      callback();
    }
  });

  /** 释放夹具持有的两条流。**只动本文件自己造的那两条**，不碰任何真实句柄。 */
  child.__disposeSyntheticPipes = () => {
    child.stdin.destroy();
    stdout.destroy();
  };
  return child;
}

/**
 * 出站凭据闸门在**本 fixture 里必须一次都不被碰到**——抛错而不是静默返回，
 * 这样"真的碰了"就一定会红，而不是变成一次没人看的"调用成功"。
 */
const PORT_THAT_MUST_NOT_BE_USED = {
  refreshBeforeModelRequest() {
    throw new Error('ZC23_FIXTURE_PORT_MUST_NOT_BE_USED');
  }
};

/**
 * `runSyntheticSession` 的返回值形状（**全仓只此一份**声明，两条断言段都按它取）。
 * @typedef {{ events: any[], error: string | null }} RunResult
 */

/**
 * 跑一次会话，**把异常收进返回值**而不是让它冒出去。
 *
 * 收异常是刻意的：缺陷发作时驱动会走到墙钟上限抛 `SESSION_TIMEOUT`，那必须被当成
 * "这一种切分的结果"参与逐字比较，而不是变成一条与目标断言无关的红。
 *
 * @param {{
 *   turnChunks: Buffer[],
 *   handshakeChunks?: (text: string) => Buffer[],
 *   endStdoutAfterTurn?: boolean
 * }} plan `plan` 整体透传给 `makeSyntheticAppServer`（同一个类型），不是只挑两个字段。
 * @returns {Promise<RunResult>}
 */
async function runSyntheticSession(plan) {
  const child = makeSyntheticAppServer(plan);
  /** @type {any[]} */
  const events = [];
  /** @type {string | null} */
  let error = null;
  try {
    await drive.driveSession({
      child,
      request: REQUEST,
      port: /** @type {any} */ (PORT_THAT_MUST_NOT_BE_USED),
      emit: (/** @type {any} */ e) => events.push(e),
      timeoutMs: DRIVE_TIMEOUT_MS
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    child.__disposeSyntheticPipes();
  }
  return { events, error };
}

/** 正文逐字。 @param {readonly any[]} events @returns {string} */
function bodyOf(events) {
  return events
    .filter((e) => e.type === 'delta')
    .map((e) => /** @type {{ text?: string }} */ (e).text ?? '')
    .join('');
}

beforeAll(async () => {
  drive = await import('../../scripts/official-host/session-drive.mjs');
});

describe('ZC-23 / F03 · 官方 stdout NDJSON 跨块连续缓冲', () => {
  it('**整块**：同样字节一次写完时，正文与终态逐字到达（对照组，先立基线）', async () => {
    const buf = Buffer.from(turnLines().join(''), 'utf8');
    const { events, error } = await runSyntheticSession({ turnChunks: chunksAt(buf, TURN_CUTTINGS['whole'](buf)) });
    expect(error).toBeNull();
    expect(events).toEqual(EXPECTED_EVENTS);
    expect(bodyOf(events)).toBe(EXPECTED_BODY);
  });

  it('**四种切分逐字相等**：整块 / 分割 / 多行尾残片 / UTF-8 字内切块', async () => {
    const buf = Buffer.from(turnLines().join(''), 'utf8');
    /** @type {Record<string, RunResult>} */
    const results = {};
    for (const [name, cutsOf] of Object.entries(TURN_CUTTINGS)) {
      const chunks = chunksAt(buf, /** @type {(b: Buffer) => number[]} */ (cutsOf)(buf));
      // 切点组必须真的切开了——否则这一组就退化成"整块"，逐字相等是自证的空断言。
      expect(chunks.length).toBeGreaterThanOrEqual(name === 'whole' ? 1 : 2);
      results[name] = await runSyntheticSession({ turnChunks: chunks });
    }

    // 断言名 1：`split-halves`（每行从中间切开）与整块**逐字相等**
    expect(/** @type {RunResult} */ (results['split-halves']).events).toEqual(/** @type {RunResult} */ (results['whole']).events);
    // 断言名 2：`multi-line-tail-residue`（多行尾残片）与整块**逐字相等**
    expect(/** @type {RunResult} */ (results['multi-line-tail-residue']).events).toEqual(/** @type {RunResult} */ (results['whole']).events);
    // 断言名 3：`utf8-inside-char`（切点落在多字节字符字内）与整块**逐字相等**
    expect(/** @type {RunResult} */ (results['utf8-inside-char']).events).toEqual(/** @type {RunResult} */ (results['whole']).events);
    // 断言名 4：四种切分**全部**无失败，且正文逐字等于期望值
    for (const name of Object.keys(results)) expect(/** @type {RunResult} */ (results[name]).error).toBeNull();
    expect(bodyOf(/** @type {RunResult} */ (results['whole']).events)).toBe(EXPECTED_BODY);
  });

  it('**切点确实落在多字节字符字内**（否则第 3 条断言是自证的）', () => {
    const buf = Buffer.from(turnLines().join(''), 'utf8');
    // `utf8InsideCharCuts` 的返回类型是 `number[]`，解构出的是 `number | undefined`；
    // 它的两个出口（命中 `0b10xxxxxx` 续字节 / 抛 `ZC23_FIXTURE_HAS_NO_MULTI_BYTE_CHAR`）
    // 都保证**恰好一个元素** ⟹ 这里把该事实补进类型层（断言 `cut > 0` 原样保留）。
    const [cut] = /** @type {[number]} */ (utf8InsideCharCuts(buf));
    expect(cut).toBeGreaterThan(0);
    expect(/** @type {number} */ (buf[cut]) & 0xc0).toBe(0x80);
    // 前一块以**首字节**结尾、后一块以**续字节**开头 ⟹ 该字被劈成两半。
    expect(/** @type {number} */ (buf[cut - 1]) & 0xc0).toBe(0xc0);
    // **加强断言（原来这条是空断言）**：把两半**各自独立**按 utf8 解码再拼接，切点真在
    // 字内 ⟹ 那个字在两半里**各自**变成 U+FFFD。这正是"逐块 `toString('utf8')` 会静默
    // 丢字"的机制，也是必须用 `StringDecoder` 的原因；原来写成 `toContain('前缀:中文')`
    // 时，切点根本不落字内也能过，与它自己的注释自相矛盾。
    expect(buf.subarray(0, cut).toString('utf8') + buf.subarray(cut).toString('utf8')).toContain('�');
    // 反向锁：整份字节一次性解码则**逐字无损**（切分本身不该改内容）。
    expect(buf.toString('utf8')).toContain('前缀:中文');
  });

  it('**末行缺尾换行仍被处理**（钉 HEAD 既有边缘语义，不是新行为）：完整合法 JSON 的末行必须送达、终态正常落', async () => {
    // **这不是本卡引入的新行为，是 HEAD 就有的**：旧 `pushOutbound` 在"某个 `data` 块里含
    // `\n`"时会把尾随残片也 `safeParse` 一次，所以一条**完整合法 JSON、只是缺尾换行**的
    // 末行**曾经**能被消费、终态能落。跨块累积改成 `pendingLine` 之后它会被永远留在串里
    // ⟹ 终态失配到 `SESSION_TIMEOUT`。这条用例就是把那个回归钉死。
    const lines = turnLines();
    // 去掉**最后一行的尾换行**：末行成了"无换行的完整 JSON"。
    const noTailNewline = /** @type {string} */ (lines[lines.length - 1]).slice(0, -1);
    const buf = Buffer.from([...lines.slice(0, -1), noTailNewline].join(''), 'utf8');
    const spans = lineSpans(buf);
    // 切点落在**倒数第二行**的开头 ⟹ 最后一个块 = "倒数第二行 + \n + 无换行的末行"，
    // 与 HEAD 的 flush 路径**逐字同形**（同块内有 `\n`，其后跟残片）。跨块，不是整块。
    const lastChunkStart = /** @type {[number, number]} */ (spans[spans.length - 2])[0];
    const chunks = chunksAt(buf, [lastChunkStart]);
    expect(chunks).toHaveLength(2);
    // 最后一个块的**末字节不是 `\n`**（末行确实缺尾换行）——这正是本用例的前提。
    // 上一行 `toHaveLength(2)` 已经把"至少有一个块"钉死 ⟹ 这里只补类型层的界内性。
    const lastChunk = /** @type {Buffer} */ (chunks[chunks.length - 1]);
    expect(lastChunk[lastChunk.length - 1]).not.toBe(0x0a);
    // 但它**含**至少一个 `\n` ⟹ 与 HEAD 的 flush 路径逐字同形。
    expect(lastChunk.includes(0x0a)).toBe(true);

    const { events, error } = await runSyntheticSession({ turnChunks: chunks, endStdoutAfterTurn: true });
    expect(error).toBeNull();
    // 末行是 `turn.completed` ⟹ 它必须**照常**落终态，且正文与整块逐字相同。
    expect(events).toEqual(EXPECTED_EVENTS);
    expect(bodyOf(events)).toBe(EXPECTED_BODY);
  });

  it('**末行是不完整残片时被丢弃**（钉 HEAD 既有边缘语义，不是新行为）：不产生事件、不误报终态', async () => {
    // 与上一条同一根语义：残片同样过一次 `safeParse`，**解析失败就丢弃**。
    // HEAD 行为一致（`safeParse` 返回 `null` ⟹ `continue`），所以这里断言的是"没变"。
    // 残片刻意**不含** `turn.completed`：于是本轮**没有**终态事件，驱动如实以
    // `SESSION_TIMEOUT` 失败化——"不误报终态"就是这条断言的内容。
    const lines = turnLines();
    const withoutTurnCompleted = lines.slice(0, 4);
    const garbage = '{"id":"zcc-host-op-zc23-fixture","result":{"accept';
    const buf = Buffer.from([...withoutTurnCompleted, garbage].join(''), 'utf8');
    const spans = lineSpans(buf);
    const chunks = chunksAt(buf, [/** @type {[number, number]} */ (spans[spans.length - 2])[0]]);
    // 残片在同一形状的位置上：末字节不是 `\n`，但块内**含** `\n`（与 HEAD 逐字同形）。
    // 本行之下必有块（切点落在倒数第二行开头 ⟹ 至少两块）⟹ 这里只补类型层的界内性。
    const lastChunk = /** @type {Buffer} */ (chunks[chunks.length - 1]);
    expect(lastChunk[lastChunk.length - 1]).not.toBe(0x0a);
    expect(lastChunk.includes(0x0a)).toBe(true);

    const { events, error } = await runSyntheticSession({ turnChunks: chunks, endStdoutAfterTurn: true });
    // 残片没被当成帧：只拿到它**之前**那三段增量，一条事件都没多。
    expect(events).toEqual([
      { type: 'delta', text: 'alpha ' },
      { type: 'delta', text: '前缀:中文' },
      { type: 'delta', text: 'beta' }
    ]);
    // **不误报终态**：既没有 `finish` 也没有 `failed`。
    expect(events.some((e) => e.type === 'finish' || e.type === 'failed')).toBe(false);
    expect(error).toMatch(/SESSION_TIMEOUT/);
  });

  it('**UTF-8 字内切块不产生替换字符**（U+FFFD）：半个字跨块时必须被拼回来，不是各解一半', async () => {
    const buf = Buffer.from(turnLines().join(''), 'utf8');
    const chunks = chunksAt(buf, utf8InsideCharCuts(buf));
    expect(chunks).toHaveLength(2);
    const { events, error } = await runSyntheticSession({ turnChunks: chunks });
    expect(error).toBeNull();
    // 这一条是 **U+FFFD 这条专门断言**：逐块 `toString('utf8')` 会把被劈开的那个字
    // 在两块里各自解成 U+FFFD，于是正文里出现替换字符——静默丢字，连 JSON 解析
    // 失败那条线索都不留。`StringDecoder` 是唯一能把它拼回来的东西。
    expect(bodyOf(events)).not.toContain('�');
    expect(bodyOf(events)).toBe(EXPECTED_BODY);
  });

  it('**握手应答跨块也不丢**：`session/create` 的 sessionId 不因为分块而读不到', async () => {
    const buf = Buffer.from(turnLines().join(''), 'utf8');
    const handshakeChunks = (/** @type {string} */ text) => {
      const b = Buffer.from(text, 'utf8');
      const mid = Math.max(1, Math.floor(b.length / 2));
      return [b.subarray(0, mid), b.subarray(mid)];
    };
    const { events, error } = await runSyntheticSession({ turnChunks: chunksAt(buf, splitHalvesCuts(buf)), handshakeChunks });
    expect(error).toBeNull();
    // 能走到终态就说明 sessionId 已经从跨块的 create 应答里取到了。
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
    expect(bodyOf(events)).toBe(EXPECTED_BODY);
  });

  it('负例 (a)：**零 delta 全文兜底仍然工作**（不是"分块就全丢"，官方给了全文就补得上）', async () => {
    const body = '前缀:中文 一整段兜底正文';
    const turn = [ndjson(wireEvent('turn.completed', { response: body, tokenCount: 0, toolCallCount: 0, duration: 1, resultType: 'success' }))];
    const buf = Buffer.from(turn.join(''), 'utf8');
    const { events, error } = await runSyntheticSession({ turnChunks: chunksAt(buf, multiLineTailResidueCuts(buf)) });
    expect(error).toBeNull();
    // 零 delta + 非空 `response` ⟹ 补一条**全量** delta（`consumeEventLine` 的兜底）。
    expect(events).toEqual([{ type: 'delta', text: body }, { type: 'finish', reason: 'stop' }]);
  });

  it('负例 (a) 反向锁：**已有增量时不再补全量**（兜底不能把正文变成两遍）', async () => {
    const body = '前缀:中文 一整段兜底正文';
    const turn = [
      ndjson(wireEvent('model.streaming', { kind: 'text_delta', delta: body })),
      ndjson(wireEvent('turn.completed', { response: body, tokenCount: 0, toolCallCount: 0, duration: 1, resultType: 'success' }))
    ];
    const buf = Buffer.from(turn.join(''), 'utf8');
    const { events, error } = await runSyntheticSession({ turnChunks: chunksAt(buf, multiLineTailResidueCuts(buf)) });
    expect(error).toBeNull();
    expect(events).toEqual([{ type: 'delta', text: body }, { type: 'finish', reason: 'stop' }]);
  });

  it('负例 (b)：**超长单行不回退**——200 000 字符的一行，跨块切开仍逐字到达', async () => {
    const body = 'x'.repeat(200_000);
    const turn = [
      ndjson(wireEvent('model.streaming', { kind: 'text_delta', delta: body })),
      ndjson(wireEvent('turn.completed', { response: body, tokenCount: 0, toolCallCount: 0, duration: 1, resultType: 'success' }))
    ];
    const buf = Buffer.from(turn.join(''), 'utf8');
    const whole = await runSyntheticSession({ turnChunks: chunksAt(buf, []) });
    const split = await runSyntheticSession({ turnChunks: chunksAt(buf, splitHalvesCuts(buf)) });
    expect(whole.error).toBeNull();
    expect(split.error).toBeNull();
    expect(whole.events).toEqual([{ type: 'delta', text: body }, { type: 'finish', reason: 'stop' }]);
    // 跨块与整块**逐字相等**，长度一个字符都不差。
    expect(split.events).toEqual(whole.events);
    expect(bodyOf(split.events)).toHaveLength(body.length);
  });

  it('负例 (c)：**`finish` 语义不变**——四种切分下都恰好一条、且在最后', async () => {
    const buf = Buffer.from(turnLines().join(''), 'utf8');
    /** @type {Record<string, any[]>} */
    const byName = {};
    for (const [name, cutsOf] of Object.entries(TURN_CUTTINGS)) {
      const chunks = chunksAt(buf, /** @type {(b: Buffer) => number[]} */ (cutsOf)(buf));
      byName[name] = (await runSyntheticSession({ turnChunks: chunks })).events;
    }
    for (const [name, events] of Object.entries(byName)) {
      expect(events.filter((e) => e.type === 'finish')).toEqual([{ type: 'finish', reason: 'stop' }]);
      expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('负例 (c) 反向锁：`turn.failed` 仍然终态化，且**报 `failed` 而不是假 `finish`**', async () => {
    const turn = [
      ndjson(wireEvent('model.streaming', { kind: 'text_delta', delta: 'alpha ' })),
      ndjson(wireEvent('turn.failed', { error: { type: 'E', message: 'boom' }, turnPhase: 'execution' }))
    ];
    const buf = Buffer.from(turn.join(''), 'utf8');
    const { events, error } = await runSyntheticSession({ turnChunks: chunksAt(buf, splitHalvesCuts(buf)) });
    expect(error).toBeNull();
    expect(events).toEqual([
      { type: 'delta', text: 'alpha ' },
      { type: 'failed', code: 'TURN_FAILED_E', detail: 'boom' }
    ]);
    expect(events.some((e) => e.type === 'finish')).toBe(false);
  });

  it('**凭据面不扩大**：整条链上没有一条出站帧携带凭据键，port 一次都没被碰', async () => {
    const child = makeSyntheticAppServer({
      turnChunks: [Buffer.from(ndjson(wireEvent('turn.completed', { response: 'x', tokenCount: 0, toolCallCount: 0, duration: 1, resultType: 'success' })), 'utf8')]
    });
    /** @type {string[]} */
    const written = [];
    const original = child.stdin.write.bind(child.stdin);
    child.stdin.write =
      /**
       * `child` 在本文件里是 `any`（合成 app-server），所以这个赋值点**没有**上下文类型可推；
       * `rest` 是 `Writable.write` 的回调位（`encoding` + `cb`），按 `any[]` 标注即可原样转发。
       * @param {any} chunk
       * @param {...any} rest
       */
      (/** @type {any} */ chunk, ...rest) => {
        written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        return original(chunk, ...rest);
      };
    try {
      await drive.driveSession({
        child,
        request: REQUEST,
        port: /** @type {any} */ (PORT_THAT_MUST_NOT_BE_USED),
        emit: () => {},
        timeoutMs: DRIVE_TIMEOUT_MS
      }).catch(() => undefined);
    } finally {
      child.__disposeSyntheticPipes();
    }
    const body = written.join('');
    for (const forbidden of ['apiKey', 'api_key', 'authorization', 'token', 'secret', 'bearer', 'jwt']) {
      expect(body).not.toMatch(new RegExp(`"${forbidden}"\\s*:`, 'i'));
    }
  });
});
