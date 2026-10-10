#!/usr/bin/env node
// ZCC-AUTH-20261008 有界现场诊断（只读）
// - 只定向解析 config.yaml 中 custom_provider.zcc-companion 的 enabled/api/baseURL/apiKey 存在性
// - apiKey 值只在进程内用于对配置所指 loopback 端点发一次 GET /v1/models，绝不输出/哈希/回显/落盘/入 argv
// - 不启停服务、不发模型生成请求、不读生产库
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';


const CONFIG = 'C:/Users/datoo/.minimax/config.yaml';
const AUTH_DIR = 'C:/Users/datoo/.minimax/auth';
const PROVIDER = 'zcc-companion';
const EXPECT_PORT = 8790;

const out = { schema: 'zcc-auth-diagnostic/1', startedUtc: new Date().toISOString(), task: 'ZCC-AUTH-20261008' };
const secrets = [];

function scrub(s) {
  let v = String(s ?? '');
  for (const sec of secrets) if (sec) v = v.split(sec).join('[REDACTED]');
  v = v.replace(/(sk-|Bearer\s+)[A-Za-z0-9._-]{6,}/g, '$1[REDACTED]');
  return v.length > 300 ? `${v.slice(0, 300)}...[truncated]` : v;
}

// 单一出口：stdout 与 round 内 artifact 使用同一份已消毒 payload
function emit() {
  out.finishedUtc = new Date().toISOString();
  secrets.length = 0;
  const payload = JSON.stringify(out, null, 2);
  writeFileSync(new URL('runtime-diagnostic-output.json', import.meta.url), `${payload}\n`, 'utf8');
  console.log(payload);
}

// --- 缩进路径解析：只取 custom_provider -> zcc-companion 下的标量键 ---
function parseProviderScalar(text, providerName) {
  const lines = text.split(/\r?\n/);
  let i = lines.findIndex((l) => /^custom_provider:\s*(#.*)?$/.test(l));
  if (i < 0) return { found: false, reason: 'no-top-level-custom_provider' };
  const cpIndent = 0;
  let pIdx = -1;
  let pIndent = -1;
  for (let j = i + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const m = l.match(/^(\s*)([^\s:][^:]*):\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    if (indent <= cpIndent) break;
    if (indent === 2 && m[2].trim() === providerName) { pIdx = j; pIndent = indent; break; }
  }
  if (pIdx < 0) return { found: false, reason: 'provider-key-not-found' };
  const fields = {};
  for (let j = pIdx + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const m = l.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) break;
    const indent = m[1].length;
    if (indent <= pIndent) break;
    const key = m[2];
    let val = m[3].trim();
    if (val.startsWith('>') || val.startsWith('|')) continue; // 不解析块标量
    val = val.replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '');
    fields[key] = val;
  }
  return { found: true, fields };
}

try {
  const text = readFileSync(CONFIG, 'utf8');
  const parsed = parseProviderScalar(text, PROVIDER);
  out.provider = { name: PROVIDER, blockFound: parsed.found, parseNote: parsed.reason ?? null };
  if (!parsed.found) {
    out.verdict = 'BLOCKED_NO_PROVIDER_BLOCK';
  } else {
    const f = parsed.fields;
    const rawKey = f.apiKey ?? f.api_key ?? '';
    const envRef = /^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|![A-Za-z_][A-Za-z0-9_]*)$/.test(rawKey);
    if (rawKey) secrets.push(rawKey.replace(/^\$\{?|\}?$/g, ''));
    out.config = {
      enabled: f.enabled ?? null,
      api: f.api ?? null,
      baseURL: f.baseURL ?? f.base_url ?? f.baseUrl ?? null,
      apiKeyPresent: Boolean(rawKey),
      apiKeyIsEnvRef: rawKey ? envRef : null,
      apiKeyEnvRefResolvableFromThisProcess: rawKey && envRef
        ? Boolean(process.env[rawKey.replace(/^\$\{|\}$|^\$/g, '')])
        : null,
      apiKeyEnvRefNote: rawKey && envRef
        ? 'envRef 可见性只代表本诊断进程，Desktop 继承环境未测'
        : null,
    };

    // --- 认证目录状态（只报存在性/计数，不列条目名） ---
    try {
      const entries = readdirSync(AUTH_DIR);
      out.authDirStatus = {
        path: AUTH_DIR,
        exists: true,
        entryCount: entries.length,
        hasProviderNamedEntry: entries.some((e) => e.toLowerCase().includes(PROVIDER)),
      };
    } catch (e) {
      out.authDirStatus = { path: AUTH_DIR, exists: false, error: scrub(e.code ?? e.message) };
    }

    // --- URL 前置校验：必须 loopback 且 8790 ---
    const base = out.config.baseURL;
    let url = null;
    try {
      url = new URL(base);
      const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
      out.precheck = { scheme: url.protocol, hostname: url.hostname, port: url.port, loopback, portMatchesExpected: Number(url.port) === EXPECT_PORT };
      if (!loopback || Number(url.port) !== EXPECT_PORT) {
        out.verdict = 'ABORT_NOT_LOOPBACK_8790';
        out.models = null;
        throw new Error('aborted');
      }
    } catch (e) {
      if (out.verdict === 'ABORT_NOT_LOOPBACK_8790') { emit(); process.exit(0); }
      out.precheck = { parseError: scrub(e.message) };
      out.verdict = 'ABORT_BAD_BASE_URL';
      emit();
      process.exit(0);
    }

    // --- 一次 GET /v1/models ---
    const target = `${url.origin}/v1/models`;
    const headers = { accept: 'application/json' };
    if (rawKey && !envRef) headers.authorization = `Bearer ${rawKey}`;
    else if (envRef) out.note = 'apiKey 为环境变量引用，本次未注入值，探测结果代表无凭据路径';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(target, { method: 'GET', headers, signal: controller.signal });
      out.http = { status: res.status, statusText: res.statusText };
      out.xZcc = {
        present: res.headers.has('x-zcc-status') || res.headers.has('x-zcc'),
        status: res.headers.get('x-zcc-status') ? scrub(res.headers.get('x-zcc-status')) : null,
        version: res.headers.get('x-zcc-version') ? scrub(res.headers.get('x-zcc-version')) : null,
      };
      const text2 = await res.text();
      try {
        const body = JSON.parse(text2);
        out.bodyShape = { topLevelKeys: Object.keys(body).slice(0, 12), errorCode: body?.error?.code ?? body?.code ?? null };
        out.bodyErrorMessage = body?.error?.message ? scrub(body.error.message) : null;
        const data = body?.data ?? body?.models;
        if (Array.isArray(data)) {
          out.models = data.slice(0, 30).map((m) => ({ id: m.id ?? null, name: m.name ?? null, owned_by: m.owned_by ?? null }));
          out.modelCount = data.length;
        } else out.models = null;
      } catch {
        out.bodyShape = { parse: 'non-json', bytes: text2.length };
      }
      out.verdict = res.status === 200 ? 'DIAG_HTTP_200' : `DIAG_HTTP_${res.status}`;
    } catch (e) {
      out.http = { status: null };
      out.error = { name: e.name, code: scrub(e.cause?.code ?? e.code ?? ''), message: scrub(e.message) };
      out.verdict = 'DIAG_TRANSPORT_ERROR';
    } finally {
      clearTimeout(timer);
      out.timerCleared = true;
      secrets.length = 0;
    }
  }
} catch (e) {
  out.verdict = 'DIAG_SCRIPT_ERROR';
  out.error = { name: e.name, code: scrub(e.cause?.code ?? e.code ?? ''), message: scrub(e.message) };
}
out.finishedUtc = new Date().toISOString();
const payload = JSON.stringify(out, null, 2);
// 供 evidence-gate 收集为 round 内 artifact；路径来自本脚本固定子目录，不接受外部任意写入
const outDir = new URL('./', import.meta.url);
writeFileSync(new URL('runtime-diagnostic-output.json', outDir), `${payload}\n`, 'utf8');
console.log(payload);