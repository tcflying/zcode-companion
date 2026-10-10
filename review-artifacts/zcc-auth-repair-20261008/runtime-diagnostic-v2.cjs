#!/usr/bin/env node
// ZCC-AUTH-20261008 有界现场诊断 v2（只读）
// - key 一律来自 apps/desktop/lib/settings.cjs 的 readMinimaxApiKey（精确 path custom_provider.zcc-companion.options.apiKey）
// - config key 只在进程内使用：不输出、不哈希、不落盘、不入 argv
// - 对 8790 与 8791 各一次 authenticated GET /v1/models（同一把已配 key、同一 loopback 规则），不重试
// - 不启停服务、不发模型生成、不读服务侧秘密
'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const { readMinimaxApiKey, readYamlScalarAtPath, MINIMAX_KEY_PATH } = require('../../apps/desktop/lib/settings.cjs');

const CONFIG = 'C:/Users/datoo/.minimax/config.yaml';
const ENDPOINTS = [
  { label: 'zcc-api-8790', port: 8790 },
  { label: 'zcc-desktop-8791', port: 8791 },
];
const EXPECTED_PORT = 8790;

/** 只保留白名单键；任何 config 原文、key、hash 一律不进输出 */
function emitShape(o) {
  return {
    schema: 'zcc-auth-diagnostic/2',
    task: 'ZCC-AUTH-20261008',
    startedUtc: o.startedUtc,
    finishedUtc: o.finishedUtc,
    keyAvailable: o.keyAvailable,
    keySourceIsOfficialHelper: o.keySourceIsOfficialHelper,
    configReadError: o.configReadError ?? null,
    parser: o.parser,
    endpoints: o.endpoints,
    modelCatalogMatch: o.modelCatalogMatch,
    configuredModels: o.configuredModels,
    serviceStartupLogSources: o.serviceStartupLogSources,
    verdict: o.verdict,
  };
}

function writeArtifact(o) {
  const payload = JSON.stringify(emitShape(o), null, 2);
  const target = require('node:path').join(require('node:path').dirname(__filename), 'runtime-diagnostic-v2-output.json');
  writeFileSync(target, `${payload}\n`, 'utf8');
  return payload;
}

/** 解析器验证：合成 fixture，不碰真实配置，不发任何网络 */
function parserSelfTest() {
  const fixture = [
    'custom_provider:',
    '  other-vendor:',
    '    options:',
    '      apiKey: "OTHER-VENDOR-KEY-SHOULD-NEVER-WIN"',
    '      models:',
    '        - id: other-model',
    '  zcc-companion:',
    '    options:',
    '      apiKey: REAL-ZCC-KEY-THAT-MUST-WIN',
    '      baseURL: http://127.0.0.1:8790/v1',
    '    nestedDupCheck:',
    '      apiKey: NESTED-DUP-MUST-NOT-WIN',
    '  zcc-companion-shadow:',
    '    options:',
    '      apiKey: "SHADOW-MUST-NOT-WIN"',
  ].join('\n');
  const cases = [
    { name: 'exact path wins over sibling vendor + nested dup + shadow prefix', path: MINIMAX_KEY_PATH, expect: 'REAL-ZCC-KEY-THAT-MUST-WIN' },
    { name: 'double-quoted sibling is not selected', path: ['custom_provider', 'other-vendor', 'options', 'apiKey'], expect: 'OTHER-VENDOR-KEY-SHOULD-NEVER-WIN' },
    { name: 'nested dup under deeper indent not selected', path: ['custom_provider', 'zcc-companion', 'nestedDupCheck', 'apiKey'], expect: 'NESTED-DUP-MUST-NOT-WIN' },
    { name: 'shadow provider not confused with zcc-companion', path: ['custom_provider', 'zcc-companion-shadow', 'options', 'apiKey'], expect: 'SHADOW-MUST-NOT-WIN' },
    { name: 'absent path returns null', path: ['custom_provider', 'zcc-companion', 'options', 'noSuchKey'], expect: null },
    { name: 'trailing comment stripped from unquoted value', path: ['custom_provider', 'zcc-companion', 'options', 'baseURL'], expect: 'http://127.0.0.1:8790/v1' },
  ];
  const results = cases.map((c) => {
    const got = readYamlScalarAtPath(fixture, c.path);
    return { name: c.name, path: c.path.join('.'), pass: got === c.expect, gotType: got === null ? 'null' : typeof got };
  });
  return { cases: results, allPass: results.every((r) => r.pass) };
}

async function main() {
  const out = { startedUtc: new Date().toISOString() };
  out.parser = { selfTest: parserSelfTest(), keyPathUsed: MINIMAX_KEY_PATH.join('.') };

  // 1) 已配 key：唯一来源是官方 helper
  const keyRead = readMinimaxApiKey();
  out.keyAvailable = keyRead.ok;
  out.keySourceIsOfficialHelper = true;
  if (!keyRead.ok) {
    out.endpoints = ENDPOINTS.map((e) => ({ label: e.label, port: e.port, attempted: false, reason: 'KEY_UNREADABLE' }));
    out.verdict = 'DIAG_KEY_UNREADABLE';
    out.finishedUtc = new Date().toISOString();
    console.log(writeArtifact(out));
    return;
  }
  const key = keyRead.key;

  // 2) 非敏感 model map keys + thinking.effortOptions 计数（只本 provider）
  let configText;
  try {
    configText = readFileSync(CONFIG, 'utf8');
  } catch (err) {
    configText = null;
    out.configReadError = String(err.code ?? err.message);
  }
  if (configText !== null) {
    const ids = [];
    const effortCounts = [];
    // model map 常见两种形状：models.<id>.{...} 与 models: [{id,name}]
    for (let i = 0; i < 400; i += 1) {
      const id = readYamlScalarAtPath(configText, ['custom_provider', 'zcc-companion', 'options', 'models', String(i), 'id']);
      if (id === null) break;
      const name = readYamlScalarAtPath(configText, ['custom_provider', 'zcc-companion', 'options', 'models', String(i), 'name']);
      ids.push({ id, displayName: name });
    }
    if (ids.length === 0) {
      // 映射形状：逐个探测少量已知候选键名受限，用 models 下 0..20 的数字/字符串键
      for (const key2 of ['MiniMax-M3', 'MiniMax-M3.1', 'M3', 'm3']) {
        const v = readYamlScalarAtPath(configText, ['custom_provider', 'zcc-companion', 'options', 'models', key2, 'name']);
        if (v !== null) ids.push({ id: key2, displayName: v });
      }
    }
    for (const m of ids) {
      const opts = [];
      for (let k = 0; k < 12; k += 1) {
        const v = readYamlScalarAtPath(configText, ['custom_provider', 'zcc-companion', 'options', 'models', String(m.id), 'thinking', 'effortOptions', String(k)]);
        if (v === null) break;
        opts.push(v);
      }
      effortCounts.push({ id: m.id, effortOptionsCount: opts.length > 0 ? opts.length : 'UNKNOWN_NOT_AT_THIS_PATH' });
    }
    out.configuredModels = { count: ids.length, ids, effortOptions: effortCounts };
  }

  // 3) 每端点一次 authenticated GET；8791 也要求 loopback 且为已知本机端口
  out.endpoints = [];
  for (const ep of ENDPOINTS) {
    const rec = { label: ep.label, port: ep.port, attempted: false };
    const url = new URL(`http://127.0.0.1:${ep.port}/v1/models`);
    const loopback = url.hostname === '127.0.0.1';
    rec.loopback = loopback;
    if (!loopback) {
      rec.skipped = 'NOT_LOOPBACK';
      out.endpoints.push(rec);
      continue;
    }
    if (ep.port === 8791) rec.portDeviationFromConfiguredBase = true;
    rec.attempted = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      rec.http = { status: res.status, ok: res.ok };
      rec.xStatus = res.headers.get('x-zcc-status') ?? null;
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { rec.bodyIsJson = false; }
      if (body && typeof body === 'object') {
        const err = body.error ?? null;
        rec.error = err && typeof err === 'object'
          ? { code: typeof err.code === 'string' ? err.code : null, message: typeof err.message === 'string' ? err.message.slice(0, 200) : null }
          : { code: typeof err === 'string' ? err : null, message: null };
        const data = Array.isArray(body.data) ? body.data : (Array.isArray(body.models) ? body.models : null);
        if (data) rec.modelIds = data.slice(0, 50).map((m) => (typeof m?.id === 'string' ? m.id : null)).filter((x) => x !== null);
        else rec.modelIds = null;
      } else rec.modelIds = null;
    } catch (err) {
      rec.http = { status: null, ok: false };
      rec.error = { code: String(err?.cause?.code ?? err?.code ?? 'TRANSPORT'), message: String(err?.message ?? '').slice(0, 200) };
    } finally {
      clearTimeout(timer);
      rec.timerCleared = true;
    }
    out.endpoints.push(rec);
  }

  // 4) 认证模型目录 与 MiniMax configured IDs 全等匹配（仅当某端点 200）
  const authed = out.endpoints.filter((e) => Array.isArray(e.modelIds));
  if (authed.length > 0 && out.configuredModels) {
    const configured = out.configuredModels.ids.map((m) => m.id);
    out.modelCatalogMatch = authed.map((e) => {
      const inter = configured.filter((c) => e.modelIds.includes(c));
      return {
        label: e.label,
        http: e.http?.status ?? null,
        configuredCount: configured.length,
        catalogCount: e.modelIds.length,
        exactMatch: configured.length > 0 && configured.every((c) => e.modelIds.includes(c)),
        matchedIds: inter,
        catalogOnlySample: e.modelIds.filter((x) => !configured.includes(x)).slice(0, 10),
      };
    });
  } else {
    out.modelCatalogMatch = { status: 'NO_AUTHENTICATED_CATALOG_THIS_ROUND' };
  }

  out.serviceStartupLogSources = {
    status: 'NOT_QUERIED_THIS_ROUND',
    note: '未读取服务侧启动日志；如需须另行只读授权',
  };

  const statuses = out.endpoints.map((e) => e.http?.status ?? null);
  out.verdict = statuses.includes(200) ? 'DIAG_AT_LEAST_ONE_AUTH_200' : 'DIAG_NO_AUTH_200';
  out.finishedUtc = new Date().toISOString();
  console.log(writeArtifact(out));
}

main();