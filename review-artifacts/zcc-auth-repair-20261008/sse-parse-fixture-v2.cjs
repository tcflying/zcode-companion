'use strict';
// 合成 fixture 验证 sse-parse-v2（无网络、无真实凭据）
const { analyzeStream } = require('./sse-parse-v2.cjs');

function evt(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }
const chunk = (content) => ({ choices: [{ delta: { content } }] });

const cases = [];
const expect = (name, input, pred, detail) => cases.push({ name, pass: pred(input), detail });

// 1 标准：content + finish stop + DONE
expect('标准流', evt(chunk('zcc-nonce-abc 42')) + evt({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
  (s) => { const a = analyzeStream(s); return a.replyTrimmed === 'zcc-nonce-abc 42' && a.finishReason === 'stop' && a.sawExactDone && a.jsonParseErrors === 0; });

// 2 CRLF 行尾
expect('CRLF 行尾', evt(chunk('x 42')).replace(/\n/g, '\r\n') + 'data: [DONE]\r\n\r\n',
  (s) => { const a = analyzeStream(s); return a.replyTrimmed === 'x 42' && a.sawExactDone; });

// 3 DONE 后追加内容 -> 必须判 trailing
expect('DONE 后追加内容', evt(chunk('y 42')) + 'data: [DONE]\n\n' + evt(chunk('extra')),
  (s) => { const a = analyzeStream(s); return a.trailingAfterDone.trim() !== ''; });

// 4 非 JSON data -> 计入 jsonParseErrors
expect('非 JSON data', 'data: not-json\n\n',
  (s) => analyzeStream(s).jsonParseErrors === 1);

// 5 SSE error 事件
expect('SSE error 事件', evt({ error: { message: 'boom' } }) + 'data: [DONE]\n\n',
  (s) => analyzeStream(s).sseErrorEvents === 1);

// 6 多 data 行（事件内换行）
const multi = 'data: {"choices":[{"delta":\ndata: {"content":"m 42"}}]}\n\n';
expect('多 data 行', multi, (s) => { const a = analyzeStream(s); return a.chunkCount === 1; });

// 7 缺 DONE
expect('缺 DONE', evt(chunk('z 42')), (s) => analyzeStream(s).sawExactDone === false);

// 8 tool_calls
expect('tool_calls 非零', evt({ choices: [{ delta: { tool_calls: [{ id: 't1' }] } }] }) + 'data: [DONE]\n\n',
  (s) => analyzeStream(s).toolCallCount === 1);

// 9 finish_reason 非 stop
expect('finish 非 stop', evt({ choices: [{ delta: {}, finish_reason: 'length' }] }) + 'data: [DONE]\n\n',
  (s) => analyzeStream(s).finishReason === 'length');

// 10 尾部空 data
expect('尾部空 data', evt(chunk('w 42')) + 'data: \n\ndata: [DONE]\n\n',
  (s) => analyzeStream(s).sawExactDone === true);

const failed = cases.filter((c) => !c.pass);
console.log(JSON.stringify({ total: cases.length, failed: failed.length, failedNames: failed.map((f) => f.name) }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;