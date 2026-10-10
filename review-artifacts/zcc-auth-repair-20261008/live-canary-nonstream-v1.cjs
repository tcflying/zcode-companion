#!/usr/bin/env node
'use strict';

/**
 * ZCC-AUTH-20261008 nonstream canary v1（单次、全新 nonce）
 *
 * 默认 dry-run；**只有显式 `--execute` 才发一次请求**。不重放任何旧 ping。
 *
 * 沿用已审 v3 的硬约束：真实 YAML 读 config/model/effort、key 只读一次存入闭包外
 * usedKey、严格 loopback baseURL、redirect:'error'、默认 dry-run、90s 仅测量
 * （不提高服务端超时、不改产品）、异常 outcome_unknown 且不自动重试、
 * 产物写 process.cwd() 下按 requestId 唯一命名。
 *
 * 本版差异：stream:false，判据按非流式 JSON 响应体。
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CONFIG = 'C:/Users/datoo/.minimax/config.yaml';
const YAML = require('C:/Users/datoo/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/yaml');
const { readMinimaxApiKey } = require('../../apps/desktop/lib/settings.cjs');

const BASE_URL = 'http://127.0.0.1:8791/v1';
const MODEL = 'account:bigmodel-individual-coding-plan::GLM-5.3-Flash';
const EFFORT = 'low';
const CLIENT_TIMEOUT_MS = 90_000;
const MAX_REPLY_CHARS = 2000;
const MAX_BODY_CHARS = 64_000;
const EXECUTE = process.argv.includes('--execute');

/** 本进程实际使用的 key；只在 main() 内赋值一次，之后所有检查都针对它 */
let usedKey = null;

function sanitize(text) {
  let s = String(text ?? '').slice(0, 300);
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1[REDACTED]');
  s = s.replace(/(sk-)[A-Za-z0-9._-]{6,}/g, '$1[REDACTED]');
  return s;
}

/** 解析 config 出错：只给 name + 固定 code，绝不回显 err.message（可能含其他 provider 内容） */
function safeConfigError(err) {
  return {
    name: typeof err?.name === 'string' ? err.name : 'Error',
    code: 'CONFIG_PARSE_FAILED',
    message: '[REDACTED: 可能包含配置内容]',
  };
}

function resolveTarget() {
  const doc = YAML.parse(fs.readFileSync(CONFIG, 'utf8'));
  const provider = doc?.custom_provider?.['zcc-companion'];
  const models = provider?.models;
  const ids = models && typeof models === 'object' ? Object.keys(models) : [];
  const opts = models?.[MODEL]?.thinking?.effortOptions;
  return {
    ids,
    contains: ids.includes(MODEL),
    effortOptionsForTarget: Array.isArray(opts) ? opts : null,
    effortSupported: Array.isArray(opts) ? opts.includes(EFFORT) : 'UNKNOWN_NOT_READ',
    baseUrlFromConfig: provider?.options?.baseURL ?? null,
  };
}

async function main() {
  const requestId = randomUUID();
  const out = {
    schema: 'zcc-live-canary-nonstream/1',
    task: 'ZCC-AUTH-20261008',
    requestId,
    executed: EXECUTE,
    target: { baseURL: BASE_URL, model: MODEL, reasoningEffort: EFFORT, stream: false },
    timing: {
      requestStartedUtc: null,
      httpReceivedUtc: null,
      bodyFinishedUtc: null,
      durationMs: null,
      aborted: false,
      abortReason: null,
    },
    clientTimeoutMs: CLIENT_TIMEOUT_MS,
    clientTimeoutIsMeasurementOnly: true,
    http: null,
    contentType: null,
    bodyBytes: null,
    bodyParsedAsJson: false,
    replyText: null,
    replyTrimmed: null,
    finishReason: null,
    toolCallCount: null,
    criteria: {},
    businessSuccess: false,
    outcome: null,
    error: null,
  };

  let target;
  try {
    target = resolveTarget();
  } catch (err) {
    out.outcome = 'aborted_config_parse_failed';
    out.error = safeConfigError(err);
    out.finishedUtc = new Date().toISOString();
    return out;
  }
  out.configuredModelIds = target.ids;
  out.configuredContainsTargetModel = target.contains;
  out.effortOptionsForTarget = target.effortOptionsForTarget;
  out.effortSupported = target.effortSupported;
  out.configBaseUrlObserved = target.baseUrlFromConfig;

  if (!target.contains) { out.outcome = 'aborted_model_not_configured'; out.finishedUtc = new Date().toISOString(); return out; }
  if (target.effortSupported !== true) { out.outcome = 'aborted_effort_not_confirmed'; out.finishedUtc = new Date().toISOString(); return out; }
  if (target.baseUrlFromConfig !== BASE_URL) { out.outcome = 'aborted_baseurl_mismatch'; out.finishedUtc = new Date().toISOString(); return out; }

  const nonce = `zcc-nonce-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const expectedReply = `${nonce} 42`;
  out.nonce = nonce;
  out.expectedReply = expectedReply;

  const keyRead = readMinimaxApiKey();
  if (!keyRead.ok) {
    out.outcome = 'aborted_key_unreadable';
    out.keyErrorReason = sanitize(keyRead.reason);
    out.finishedUtc = new Date().toISOString();
    return out;
  }
  usedKey = keyRead.key; // 唯一一次读取，之后不再回读 config

  const payload = {
    model: MODEL,
    stream: false,
    reasoning_effort: EFFORT,
    messages: [{
      role: 'user',
      content: `请只回复这一段纯文本，不要调用任何工具、不要访问文件、不要执行命令：${expectedReply}`,
    }],
  };

  if (!EXECUTE) {
    out.outcome = 'dry_run_only';
    out.networkRequestsIssued = 0;
    out.payloadShape = {
      model: payload.model,
      stream: payload.stream,
      reasoning_effort: payload.reasoning_effort,
      hasTools: 'tools' in payload,
      hasToolChoice: 'tool_choice' in payload,
      hasMaxTokens: 'max_tokens' in payload || 'max_completion_tokens' in payload,
      messageCount: payload.messages.length,
    };
    out.promptLengthChars = payload.messages[0].content.length;
    out.finishedUtc = new Date().toISOString();
    return out;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    out.timing.aborted = true;
    out.timing.abortReason = 'client_timeout_90s';
    controller.abort();
  }, CLIENT_TIMEOUT_MS);
  try {
    out.timing.requestStartedUtc = new Date().toISOString();
    const t0 = Date.now();
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${usedKey}` },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: controller.signal,
    });
    out.timing.httpReceivedUtc = new Date().toISOString();
    out.http = { status: res.status, statusText: res.statusText };
    out.contentType = res.headers.get('content-type');
    out.responseXzccStatus = res.headers.get('x-zcc-status');

    const raw = await res.text();
    out.timing.bodyFinishedUtc = new Date().toISOString();
    out.timing.durationMs = Date.now() - t0;
    out.bodyBytes = Buffer.byteLength(raw, 'utf8');

    let body = null;
    let jsonOk = false;
    try { body = JSON.parse(raw); jsonOk = true; } catch { body = null; }
    out.bodyParsedAsJson = jsonOk;

    const httpOk = res.status === 200;
    let reply = null; let finish = null; let toolCalls = 0;
    let topLevelError = null; let baseRespStatus = null;

    if (jsonOk && body && typeof body === 'object') {
      // 顶层 error / base_resp.error.status 均视为服务侧拒绝
      if (body.error) {
        topLevelError = {
          code: typeof body.error.code === 'string' ? body.error.code : null,
          message: sanitize(body.error.message ?? body.error.type ?? ''),
        };
      }
      const brs = body.base_resp?.error_status ?? body.base_resp?.error?.status ?? null;
      if (brs !== null && brs !== undefined) baseRespStatus = String(brs);

      const choice = Array.isArray(body.choices) ? body.choices[0] : null;
      if (choice) {
        if (typeof choice.message?.content === 'string') reply = choice.message.content;
        if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
        if (Array.isArray(choice.message?.tool_calls)) toolCalls = choice.message.tool_calls.length;
      }
    }

    out.replyText = reply === null ? null : reply.slice(0, MAX_REPLY_CHARS);
    out.replyTrimmed = reply === null ? null : reply.trim();
    out.replyCharCount = reply === null ? null : reply.length;
    out.finishReason = finish;
    out.toolCallCount = jsonOk && Array.isArray(body?.choices) ? toolCalls : null;
    out.topLevelError = topLevelError;
    out.baseRespStatus = baseRespStatus;

    const c = {
      http200: httpOk,
      bodyIsJson: jsonOk,
      noServiceError: topLevelError === null && (baseRespStatus === null || baseRespStatus === '0'),
      choicesPresent: Array.isArray(body?.choices) && body.choices.length > 0,
      replyExactlyExpected: out.replyTrimmed === expectedReply,
      replyWithinLengthLimit: reply !== null && reply.length <= MAX_REPLY_CHARS,
      toolCallsAbsent: out.toolCallCount === 0,
      finishReasonStop: finish === 'stop',
      notAborted: out.timing.aborted !== true,
      bodyWithinLimit: out.bodyBytes <= MAX_BODY_CHARS,
    };
    out.criteria = c;
    out.businessSuccess = Object.values(c).every((v) => v === true);
    out.outcome = out.businessSuccess
      ? 'canary_business_success'
      : (out.timing.aborted ? 'outcome_unknown' : 'canary_business_fail');
  } catch (err) {
    out.timing.bodyFinishedUtc = new Date().toISOString();
    out.outcome = out.timing.aborted ? 'outcome_unknown' : 'request_failed';
    out.error = {
      name: typeof err?.name === 'string' ? err.name : 'Error',
      code: sanitize(err?.cause?.code ?? err?.code ?? ''),
      message: sanitize(err?.message ?? ''),
    };
    out.businessSuccess = false;
  } finally {
    clearTimeout(timer);
  }
  out.finishedUtc = new Date().toISOString();
  return out;
}

main().then((result) => {
  const serialized = JSON.stringify(result, null, 2);
  const leak = typeof usedKey === 'string' && usedKey.length >= 8 && serialized.includes(usedKey);
  if (leak) {
    const redacted = { schema: result.schema, task: result.task, requestId: result.requestId, outcome: 'aborted_json_contains_key' };
    fs.writeFileSync(path.join(process.cwd(), `canary-nonstream-${redacted.requestId}.json`), `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(redacted, null, 2));
    process.exitCode = 3;
    return;
  }
  fs.writeFileSync(path.join(process.cwd(), `canary-nonstream-${result.requestId}.json`), `${serialized}\n`, 'utf8');
  console.log(serialized);
});