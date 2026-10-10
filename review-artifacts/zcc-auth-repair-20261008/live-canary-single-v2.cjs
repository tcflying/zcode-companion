#!/usr/bin/env node
'use strict';

/**
 * ZCC-AUTH-20261008 独立 canary v2
 *
 * **默认 dry-run。只有显式 `--execute` 才发一次请求**，且每次 run 生成全新
 * requestId 与 nonce（已声明者不重放，任何异常不自动重试）。
 *
 * 硬约束：
 *   - key 只在内存用于 Authorization 头；不输出、不入 argv、不落盘
 *   - 目标严格 http://127.0.0.1:8791/v1，redirect:'error'
 *   - 字段依据 packages/api/src/chat.ts: reasoning_effort（闭集 low|high|max）
 *   - stream:true，无 tools / tool_choice / max_tokens（不猜语义）
 *   - 90s 覆盖 fetch 与整个流的读取，**仅测量**，不是产品修复
 *   - 产物写在 process.cwd()（root run 的 round 目录）下的唯一 requestId JSON，不覆盖历史
 *   - 任何 throw 都不输出原内容/stack；错误正文脱敏
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
const EXECUTE = process.argv.includes('--execute');

/** 脱敏：错误正文只保留 code/短消息，绝不回显原 key */
function sanitizeErrorText(text) {
  let s = String(text ?? '').slice(0, 300);
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1[REDACTED]');
  s = s.replace(/(sk-)[A-Za-z0-9._-]{6,}/g, '$1[REDACTED]');
  return s;
}

function safeMessage(err) {
  if (!err) return null;
  return {
    name: typeof err.name === 'string' ? err.name : 'Error',
    code: sanitizeErrorText(err.cause?.code ?? err.code ?? ''),
    message: sanitizeErrorText(err.message ?? ''),
  };
}

/** 真实 YAML 公开字段：models keys + 该 model 的 thinking.effortOptions + baseURL */
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
    effortSupported: effortOptions === null ? 'UNKNOWN_NOT_READ' : effortOptions.includes(EFFORT),
    baseUrlFromConfig: provider?.options?.baseURL ?? null,
  };
}

async function main() {
  const requestId = randomUUID();
  const out = {
    schema: 'zcc-live-canary-single/2',
    task: 'ZCC-AUTH-20261008',
    requestId,
    executed: EXECUTE,
    startedUtc: new Date().toISOString(),
    target: { baseURL: BASE_URL, model: MODEL, reasoningEffort: EFFORT, stream: true },
    timing: { firstByteUtc: null, firstContentUtc: null, lastByteUtc: null, aborted: false, abortReason: null },
    http: null,
    contentType: null,
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
    out.error = safeMessage(err);
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
  if (target.effortSupported === false) {
    out.outcome = 'aborted_effort_not_in_configured_effort_options';
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
  // 卫生检查针对**实际要用的这把原 key**，且在进程内断言
  const actualKey = keyRead.key;

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
    const probe = JSON.stringify(out, null, 2);
    out._hygiene = { checkedAgainstActualKey: actualKey.length >= 8, leakDetected: probe.includes(actualKey) };
    if (out._hygiene.leakDetected) { out.outcome = 'aborted_json_contains_key'; }
    delete out._hygiene.leakDetected;
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
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${actualKey}` },
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
        if (raw.length > MAX_REPLY_CHARS * 8) {
          out.overflow = true;
          break;
        }
      }
      if (done) break;
    }
    // flush：处理被切断的多字节序列
    raw += decoder.decode();
    out.timing.lastByteUtc = new Date().toISOString();

    const a = analyzeStream(raw);
    out.analysis = {
      replyText: a.replyText.slice(0, MAX_REPLY_CHARS),
      replyTrimmed: a.replyTrimmed.slice(0, MAX_REPLY_CHARS),
      toolCallCount: a.toolCallCount,
      finishReason: a.finishReason,
      sawExactDone: a.sawExactDone,
      trailingAfterDone: a.trailingAfterDone.slice(0, 200),
      sseErrorEvents: a.sseErrorEvents,
      sseErrorMessages: a.sseErrorMessages,
      jsonParseErrors: a.jsonParseErrors,
      chunkCount: a.chunkCount,
    };
    if (a.chunkCount > 0 && out.timing.firstContentUtc === null) {
      out.timing.firstContentUtc = out.timing.firstByteUtc;
    }
    out.overflow = out.overflow === true;

    // 硬判据
    const c = {
      http200: out.http.status === 200,
      contentTypeSse: /text\/event-stream/i.test(out.contentType ?? ''),
      replyExactlyExpected: a.replyTrimmed === expectedReply,
      toolCallsZero: a.toolCallCount === 0,
      finishReasonStop: a.finishReason === 'stop',
      sawExactDone: a.sawExactDone,
      nothingAfterDone: a.trailingAfterDone.trim() === '',
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
    out.error = safeMessage(err);
    out.businessSuccess = false;
  } finally {
    clearTimeout(timer);
    try { await reader?.cancel(); } catch { /* 已结束 */ }
  }
  out.finishedUtc = new Date().toISOString();
  return out;
}

main().then((result) => {
  const payload = { ...result };
  // 卫生：序列化后断言不含实际使用的 key
  const kr = readMinimaxApiKey();
  const serialized = JSON.stringify(payload, null, 2);
  const keyLen = kr.ok ? String(kr.key ?? '').length : 0;
  const leak = kr.ok && keyLen >= 8 && serialized.includes(kr.key);
  if (leak) {
    const redacted = { schema: payload.schema, task: payload.task, requestId: payload.requestId, outcome: 'aborted_json_contains_key' };
    fs.writeFileSync(path.join(process.cwd(), `canary-${redacted.requestId}.json`), `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(redacted, null, 2));
    process.exitCode = 3;
    return;
  }
  const file = path.join(process.cwd(), `canary-${payload.requestId}.json`);
  fs.writeFileSync(file, `${serialized}\n`, 'utf8');
  console.log(serialized);
});