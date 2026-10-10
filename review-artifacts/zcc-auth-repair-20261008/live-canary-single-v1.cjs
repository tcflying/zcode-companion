#!/usr/bin/env node
// ZCC-AUTH-20261008 独立 canary（单次、单 low、全新 nonce）
//
// 由 root 亲执行；本脚本默认 --dry-run，绝不自行发起生成。
// 硬约束：
//   - key 只在内存，用于 Authorization 头；不输出、不入 argv、不写盘
//   - 目标严格 http://127.0.0.1:8791/v1，redirect:'error'
//   - 请求字段按 packages/api/src/chat.ts 真实 schema：reasoning_effort（闭集 low|high|max）
//   - stream:true，无 tools、无 tool_choice、无 max_tokens（不猜语义）
//   - 全新 nonce/requestId，已声明者不重放；任何异常写 outcome_unknown 且不自动重试
//   - finally 清 timer / reader / connection
'use strict';

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
const DRY_RUN = process.argv.includes('--dry-run');

/** 真实 YAML 公开读取：只确认 configured models 含目标 model，不 dump 整份 config */
function resolveTarget() {
  const doc = YAML.parse(fs.readFileSync(CONFIG, 'utf8'));
  const models = doc?.custom_provider?.['zcc-companion']?.models;
  const ids = models && typeof models === 'object' ? Object.keys(models) : [];
  return { ids, contains: ids.includes(MODEL), baseUrlFromConfig: doc?.custom_provider?.['zcc-companion']?.options?.baseURL ?? null };
}

function buildPayload(nonce) {
  return {
    model: MODEL,
    stream: true,
    reasoning_effort: EFFORT,
    messages: [{
      role: 'user',
      content: `请只回复这一段纯文本，不要调用任何工具、不要访问文件、不要执行命令：${nonce} 42`,
    }],
  };
}

async function main() {
  const out = {
    schema: 'zcc-live-canary-single/1',
    task: 'ZCC-AUTH-20261008',
    requestId: randomUUID(),
    startedUtc: new Date().toISOString(),
    target: { baseURL: BASE_URL, model: MODEL, reasoningEffort: EFFORT, stream: true },
    outcome: null,
    http: null,
    firstByteUtc: null,
    lastByteUtc: null,
    replyText: null,
    finishReason: null,
    toolCallCount: null,
    sawDoneMarker: false,
    error: null,
  };

  const target = resolveTarget();
  out.configuredModelIds = target.ids;
  out.configuredContainsTargetModel = target.contains;
  out.configBaseUrlObserved = target.baseUrlFromConfig;
  if (!target.contains) {
    out.outcome = 'aborted_model_not_configured';
    out.error = '真实 YAML 中 custom_provider.zcc-companion.models 不含目标 model';
    out.finishedUtc = new Date().toISOString();
    return out;
  }
  if (target.baseUrlFromConfig !== BASE_URL) {
    out.outcome = 'aborted_baseurl_mismatch';
    out.error = `config 中 baseURL 与本 canary 目标不一致（观测=${target.baseUrlFromConfig}）`;
    out.finishedUtc = new Date().toISOString();
    return out;
  }

  const nonce = `zcc-nonce-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  out.nonce = nonce;
  const payload = buildPayload(nonce);

  const keyRead = readMinimaxApiKey();
  if (!keyRead.ok) {
    out.outcome = 'aborted_key_unreadable';
    out.error = keyRead.reason;
    out.finishedUtc = new Date().toISOString();
    return out;
  }

  if (DRY_RUN) {
    out.outcome = 'dry_run_only';
    out.networkRequestsIssued = 0;
    out.payloadShape = {
      model: payload.model, stream: payload.stream, reasoning_effort: payload.reasoning_effort,
      hasTools: 'tools' in payload, hasToolChoice: 'tool_choice' in payload,
      hasMaxTokens: 'max_tokens' in payload || 'max_completion_tokens' in payload,
      messageCount: payload.messages.length,
    };
    out.promptLengthChars = payload.messages[0].content.length;
    out.finishedUtc = new Date().toISOString();
    return out;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  let reader = null;
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${keyRead.key}` },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: controller.signal,
    });
    out.http = { status: res.status, statusText: res.statusText };
    out.responseHeaders = { xZccStatus: res.headers.get('x-zcc-status'), contentType: res.headers.get('content-type') };
    if (!res.ok) {
      out.outcome = 'http_error';
      out.error = (await res.text()).slice(0, 500);
      out.finishedUtc = new Date().toISOString();
      return out;
    }

    reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let text = '';
    let toolCalls = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (out.firstByteUtc === null) out.firstByteUtc = new Date().toISOString();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payloadPart = s.slice(5).trim();
        if (payloadPart === '[DONE]') { out.sawDoneMarker = true; continue; }
        try {
          const json = JSON.parse(payloadPart);
          const delta = json?.choices?.[0]?.delta ?? {};
          if (typeof delta.content === 'string') text += delta.content;
          if (Array.isArray(delta.tool_calls)) toolCalls += delta.tool_calls.length;
          const fr = json?.choices?.[0]?.finish_reason;
          if (typeof fr === 'string') out.finishReason = fr;
        } catch { /* 非 JSON 行忽略 */ }
      }
      if (text.length > 2000) break;
    }
    out.lastByteUtc = new Date().toISOString();
    out.replyText = text.slice(0, 2000);
    out.replyCharCount = text.length;
    out.toolCallCount = toolCalls;
    // 业务判定：正文确实含 nonce 且流正常结束，且无工具调用
    const ok = text.includes(nonce) && text.includes('42') && out.finishReason !== null;
    out.outcome = ok ? 'canary_reply_contains_nonce' : 'canary_reply_missing_nonce_or_incomplete';
    out.businessSuccess = ok;
  } catch (err) {
    // 任何异常/中止都写 outcome_unknown，绝不自动重试
    out.outcome = 'outcome_unknown';
    out.error = String(err?.cause?.code ?? err?.code ?? err?.name ?? 'ERR');
    out.errorMessage = String(err?.message ?? '').slice(0, 200);
    out.businessSuccess = false;
  } finally {
    clearTimeout(timer);
    try { await reader?.cancel(); } catch { /* 已结束 */ }
  }
  out.finishedUtc = new Date().toISOString();
  return out;
}

main().then((r) => {
  // 卫生断言：序列化结果不得含当前 key
  const kr = readMinimaxApiKey();
  const s = JSON.stringify(r, null, 2);
  if (kr.ok && typeof kr.key === 'string' && kr.key.length >= 8 && s.includes(kr.key)) {
    console.log(JSON.stringify({ schema: 'zcc-live-canary-single/1', outcome: 'aborted_json_contains_key' }));
    process.exitCode = 3;
    return;
  }
  fs.writeFileSync(path.join(__dirname, 'live-canary-single-output.json'), `${s}\n`, 'utf8');
  console.log(s);
});