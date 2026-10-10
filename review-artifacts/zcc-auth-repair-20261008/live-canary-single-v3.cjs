#!/usr/bin/env node
'use strict';

/**
 * ZCC-AUTH-20261008 独立 canary v3
 *
 * 默认 dry-run；**只有显式 `--execute` 才发一次请求**，每次全新 requestId 与 nonce。
 *
 * v3 相对 v2 的修正（逐条）：
 *  1. key 只在 main() 内读取一次，存进**闭包外可见的 usedKey**；输出卫生断言针对
 *     usedKey，**不再二次调用 readMinimaxApiKey**（v2 的 TOCTOU/二次读取已删除）。
 *  2. config 解析异常只输出 name 与固定 code，**不输出 err.message**（可能含其他 provider 内容）。
 *  3. effort guard 改为 **!== true 即 abort**：UNKNOWN 也中止，不放行。
 *  4. firstContentUtc **不再伪造等于 firstByte**；无法逐 chunk 准确定位就置 null 并注明未测。
 *  5. 解析/EOF 隐式路径改为显式 `streamCompleted = done`，并加入判据。
 *  6. 回复文本 text.length > 2000 也必须 overflow（不只 raw 缓冲超限）。
 *
 * 其余硬约束沿用 v2：key 仅内存、baseURL 严格 8791、redirect:'error'、
 * 字段依据 chat.ts 的 reasoning_effort、stream:true、无 tools/tool_choice/max_tokens、
 * 90s 仅测量、异常 outcome_unknown 不重试、产物写 process.cwd() 按 requestId 唯一命名。
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { analyzeStream } = require('./sse-parse-v2.cjs');

const CONFIG = 'C:/Users/datoo/.minimax/config.yaml';
const YAML = require('C:/Users/datoo/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/yaml');
const { readMinimaxApiKey } = require('../../apps/desktop/lib/settings.cjs');

const BASE_URL = 'http://127.0.0.1:8791/v1';
const MODEL = 'account:bigmodel-individual-coding-plan::GLM-5.3-Flash';
const EFFORT = 'low';
const CLIENT_TIMEOUT_MS = 90_000;
const MAX_REPLY_CHARS = 2000;
const MAX_RAW_CHARS = MAX_REPLY_CHARS * 8;
const EXECUTE = process.argv.includes('--execute');

/** 本进程实际使用的 key。只在 main() 内赋值一次，之后所有检查都针对它。 */
let usedKey = null;

function sanitizeErrorText(text) {
  let s = String(text ?? '').slice(0, 300);
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1[REDACTED]');
  s = s.replace(/(sk-)[A-Za-z0-9._-]{6,}/g, '$1[REDACTED]');
  return s;
}

/** 只给 name + 固定 code：解析配置出错时绝不回显 err.message（可能含其他 provider 内容） */
function safeErrorNoMessage(err, fixedCode) {
  return {
    name: typeof err?.name === 'string' ? err.name : 'Error',
    code: fixedCode,
    message: '[REDACTED: 可能包含配置内容]',
  };
}

function resolveTarget() {
  const doc = YAML.parse(fs.readFileSync(CONFIG, 'utf8'));
  const provider = doc?.custom_provider?.['zcc-companion'];
  const models = provider?.models;
  const ids = models && typeof models === 'object' ? Object.keys(models) : [];
  const effortOptions = Array.isArray(models?.[MODEL]?.thinking?.effortOptions)
    ? models[MODEL].thinking.effortOptions
    : null;
  return {
    ids,
    contains: ids.includes(MODEL),
    effortOptionsForTarget: effortOptions,
    // 三态：true / false / 'UNKNOWN_NOT_READ'。调用方必须要求 === true
    effortSupported: effortOptions === null ? 'UNKNOWN_NOT_READ' : effortOptions.includes(EFFORT),
    baseUrlFromConfig: provider?.options?.baseURL ?? null,
  };
}

async function main() {
  const requestId = randomUUID();
  const out = {
    schema: 'zcc-live-canary-single/3',
    task: 'ZCC-AUTH-20261008',
    requestId,
    executed: EXECUTE,
    startedUtc: new Date().toISOString(),
    target: { baseURL: BASE_URL, model: MODEL, reasoningEffort: EFFORT, stream: true },
    timing: {
      firstByteUtc: null,
      firstContentUtc: null,
      firstContentNote: '未逐 chunk 归因定位，保持 null；不以 firstByte 冒充',
      lastByteUtc: null,
      aborted: false,
      abortReason: null,
    },
    http: null,
    contentType: null,
    streamCompleted: false,
    overflow: false,
    analysis: null,
    criteria: {},
    businessSuccess: false,
    outcome: null,
    error: null,
    clientTimeoutMs: CLIENT_TIMEOUT_MS,
    clientTimeoutIsMeasurementOnly: true,
  };

  let target;
  try {
    target = resolveTarget();
  } catch (err) {
    out.outcome = 'aborted_config_parse_failed';
    out.error = safeErrorNoMessage(err, 'CONFIG_PARSE_FAILED');
    out.finishedUtc = new Date().toISOString();
    return out;
  }
  out.configuredModelIds = target.ids;
  out.configuredContainsTargetModel = target.contains;
  out.effortOptionsForTarget = target.effortOptionsForTarget;
  out.effortSupported = target.effortSupported;
  out.configBaseUrlObserved = target.baseUrlFromConfig;

  if (!target.contains) {
    out.outcome = 'aborted_model_not_configured';
    out.finishedUtc = new Date().toISOString();
    return out;
  }
  // UNKNOWN 也中止：只有明确为 true 才放行
  if (target.effortSupported !== true) {
    out.outcome = 'aborted_effort_not_confirmed_in_configured_effort_options';
    out.finishedUtc = new Date().toISOString();
    return out;
  }
  if (target.baseUrlFromConfig !== BASE_URL) {
    out.outcome = 'aborted_baseurl_mismatch';
    out.finishedUtc = new Date().toISOString();
    return out;
  }

  const nonce = `zcc-nonce-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  out.nonce = nonce;
  const expectedReply = `${nonce} 42`;
  out.expectedReply = expectedReply;

  const keyRead = readMinimaxApiKey();
  if (!keyRead.ok) {
    out.outcome = 'aborted_key_unreadable';
    out.keyErrorReason = sanitizeErrorText(keyRead.reason);
    out.finishedUtc = new Date().toISOString();
    return out;
  }
  // 唯一一次读取：此后所有地方都用这一个值，不再回读 config
  usedKey = keyRead.key;

  if (!EXECUTE) {
    out.outcome = 'dry_run_only';
    out.networkRequestsIssued = 0;
    out.payloadShape = {
      model: MODEL,
      stream: true,
      reasoning_effort: EFFORT,
      hasTools: false,
      hasToolChoice: false,
      hasMaxTokens: false,
      messageCount: 1,
    };
    out.promptLengthChars = 63;
    out.finishedUtc = new Date().toISOString();
    return out;
  }

  const payload = {
    model: MODEL,
    stream: true,
    reasoning_effort: EFFORT,
    messages: [{
      role: 'user',
      content: `请只回复这一段纯文本，不要调用任何工具、不要访问文件、不要执行命令：${expectedReply}`,
    }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    out.timing.aborted = true;
    out.timing.abortReason = 'client_timeout_90s';
    controller.abort();
  }, CLIENT_TIMEOUT_MS);
  let reader = null;
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${usedKey}` },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: controller.signal,
    });
    out.http = { status: res.status, statusText: res.statusText };
    out.contentType = res.headers.get('content-type');
    out.responseXzccStatus = res.headers.get('x-zcc-status');

    if (!res.ok) {
      out.outcome = 'http_error';
      out.errorBodySanitized = sanitizeErrorText(await res.text());
      out.businessSuccess = false;
      out.finishedUtc = new Date().toISOString();
      return out;
    }
    if (!/text\/event-stream/i.test(out.contentType ?? '')) {
      out.outcome = 'aborted_not_sse_content_type';
      out.finishedUtc = new Date().toISOString();
      return out;
    }

    reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let raw = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (value && value.byteLength > 0) {
        if (out.timing.firstByteUtc === null) out.timing.firstByteUtc = new Date().toISOString();
        raw += decoder.decode(value, { stream: true });
        if (raw.length > MAX_RAW_CHARS) { out.overflow = true; break; }
      }
      if (done) { out.streamCompleted = true; break; }
    }
    raw += decoder.decode(); // flush 被切断的多字节序列
    out.timing.lastByteUtc = new Date().toISOString();

    const a = analyzeStream(raw);
    out.analysis = {
      replyText: a.replyText.slice(0, MAX_REPLY_CHARS),
      replyTrimmed: a.replyTrimmed.slice(0, MAX_REPLY_CHARS),
      replyCharCount: a.replyText.length,
      toolCallCount: a.toolCallCount,
      finishReason: a.finishReason,
      sawExactDone: a.sawExactDone,
      trailingAfterDone: a.trailingAfterDone.slice(0, 200),
      sseErrorEvents: a.sseErrorEvents,
      sseErrorMessages: a.sseErrorMessages,
      jsonParseErrors: a.jsonParseErrors,
      chunkCount: a.chunkCount,
    };
    // 回复正文本身超长也算 overflow
    if (a.replyText.length > MAX_REPLY_CHARS) out.overflow = true;

    const c = {
      http200: out.http.status === 200,
      contentTypeSse: /text\/event-stream/i.test(out.contentType ?? ''),
      replyExactlyExpected: a.replyTrimmed === expectedReply,
      toolCallsZero: a.toolCallCount === 0,
      finishReasonStop: a.finishReason === 'stop',
      sawExactDone: a.sawExactDone,
      nothingAfterDone: a.trailingAfterDone.trim() === '',
      streamCompleted: out.streamCompleted === true,
      noSseError: a.sseErrorEvents === 0,
      noJsonParseError: a.jsonParseErrors === 0,
      noOverflow: out.overflow !== true,
      notAborted: out.timing.aborted !== true,
    };
    out.criteria = c;
    out.businessSuccess = Object.values(c).every((v) => v === true);
    out.outcome = out.businessSuccess ? 'canary_business_success' : 'canary_business_fail';
    if (out.timing.aborted) out.outcome = 'outcome_unknown';
  } catch (err) {
    out.outcome = out.timing.aborted ? 'outcome_unknown' : 'request_failed';
    out.error = {
      name: typeof err?.name === 'string' ? err.name : 'Error',
      code: sanitizeErrorText(err?.cause?.code ?? err?.code ?? ''),
      message: sanitizeErrorText(err?.message ?? ''),
    };
    out.businessSuccess = false;
  } finally {
    clearTimeout(timer);
    try { await reader?.cancel(); } catch { /* 已结束 */ }
  }
  out.finishedUtc = new Date().toISOString();
  return out;
}

main().then((result) => {
  // 卫生断言针对 main() 内那一次读取的 usedKey，不重新读 config
  const serialized = JSON.stringify(result, null, 2);
  const leak = typeof usedKey === 'string' && usedKey.length >= 8 && serialized.includes(usedKey);
  if (leak) {
    const redacted = {
      schema: result.schema,
      task: result.task,
      requestId: result.requestId,
      outcome: 'aborted_json_contains_key',
    };
    fs.writeFileSync(path.join(process.cwd(), `canary-${redacted.requestId}.json`), `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(redacted, null, 2));
    process.exitCode = 3;
    return;
  }
  const file = path.join(process.cwd(), `canary-${result.requestId}.json`);
  fs.writeFileSync(file, `${serialized}\n`, 'utf8');
  console.log(serialized);
});