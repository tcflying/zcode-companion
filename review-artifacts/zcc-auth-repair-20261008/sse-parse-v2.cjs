'use strict';

/**
 * ZCC-AUTH-20261008 live canary v2 —— 纯 SSE 解析器（无副作用，可单测）
 *
 * 判定口径（严于 v1，全部为硬条件）：
 *   - 业务成功 = trimmedReply === `${nonce} 42`
 *   - toolCalls === 0
 *   - finishReason === 'stop'
 *   - 收到**精确**的 `data: [DONE]` 且随后 EOF（不得再有内容）
 *   - 无 SSE error 事件、无 JSON 解析失败、无长度溢出
 *   - HTTP 200 且 content-type 为 text/event-stream
 *
 * 协议细节：
 *   - UTF-8 流式解码 + flush（处理被切断的多字节序列）
 *   - 事件按**空行**分隔，支持 CRLF / LF / CR
 *   - 同��事件可有多行 data:，按 SSE 规范以 \n 连接
 *   - 非 JSON 的 data 行**不算 parse error**，但会被标记为 unknown 事件并计入不通过条件
 *   - [DONE] 之后若再有内容 → 明确判失败
 */

/** 单个 SSE 事件的解析结果 */
function parseEventBlock(block) {
  const dataLines = [];
  let eventName = null;
  let hasNonDataField = false;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
    else hasNonDataField = true;
  }
  return { eventName, hasNonDataField, data: dataLines };
}

/**
 * 把 SSE 文本流切成事件块。返回 { events:[string], doneIndex:number|-1, trailingAfterDone:string }
 * doneIndex 为 data 恰为 `[DONE]` 的事件下标。
 */
function splitEvents(text) {
  // 支持 CRLF / LF / CR 三种行结束；事件以空行分隔
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n\n+/);
  const events = [];
  let doneIndex = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b.trim() === '') continue;
    events.push(b);
    const parsed = parseEventBlock(b);
    if (doneIndex === -1 && parsed.data.length === 1 && parsed.data[0] === '[DONE]') doneIndex = events.length - 1;
  }
  const trailingAfterDone = doneIndex === -1 ? '' : events.slice(doneIndex + 1).join('\n\n');
  return { events, doneIndex, trailingAfterDone };
}

/**
 * 解析完整 SSE 正文，返回回复文本与全部判据。
 * @param {string} rawText 已 flush 的完整 SSE 文本
 */
function analyzeStream(rawText) {
  const result = {
    replyText: '',
    replyTrimmed: '',
    toolCallCount: 0,
    finishReason: null,
    sawExactDone: false,
    trailingAfterDone: '',
    sseErrorEvents: 0,
    sseErrorMessages: [],
    jsonParseErrors: 0,
    nonJsonDataLines: 0,
    chunkCount: 0,
  };
  const { events, doneIndex, trailingAfterDone } = splitEvents(rawText);
  result.trailingAfterDone = trailingAfterDone;
  let text = '';
  for (let i = 0; i < events.length; i += 1) {
    if (doneIndex !== -1 && i > doneIndex) break;
    const parsed = parseEventBlock(events[i]);
    if (parsed.data.length === 0) continue;
    // [DONE] 必须精确且唯一匹配
    if (parsed.data.length === 1 && parsed.data[0] === '[DONE]') {
      result.sawExactDone = true;
      break;
    }
    // 多行 data 按 SSE 规范以 \n 连接后再解析
    const payloadText = parsed.data.join('\n');
    let json;
    try {
      json = JSON.parse(payloadText);
    } catch {
      result.jsonParseErrors += 1;
      continue;
    }
    result.chunkCount += 1;
    if (json && json.error) {
      result.sseErrorEvents += 1;
      const msg = json.error?.message ?? json.error?.code ?? 'unknown';
      result.sseErrorMessages.push(String(msg).slice(0, 200));
    }
    const choice = json?.choices?.[0];
    const delta = choice?.delta ?? {};
    if (typeof delta.content === 'string') text += delta.content;
    if (Array.isArray(delta.tool_calls)) result.toolCallCount += delta.tool_calls.length;
    if (typeof choice?.finish_reason === 'string') result.finishReason = choice.finish_reason;
  }
  result.replyText = text;
  result.replyTrimmed = text.trim();
  return result;
}

module.exports = { analyzeStream, splitEvents, parseEventBlock };