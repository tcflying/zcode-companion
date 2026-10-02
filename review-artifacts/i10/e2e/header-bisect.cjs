/**
 * 诊断：把 `net.fetch` 的头逐个减bisect，钉死 `ERR_INVALID_ARGUMENT` 的真凶。
 *
 * 背景：`buildUpstreamRequest` 拼出来的头（注入 `authorization` + 显式 `host`）
 * 交给 Electron 的 `net.fetch` 会抛 `net::ERR_INVALID_ARGUMENT`，转发整条链因此 502。
 * 这里对同一个回环地址逐个变体试，给出「哪个头让请求失败」的实证，而不是靠记忆断言。
 *
 * 只登记回环、合成数据，不读任何凭据。
 *
 * 用法（在仓库 cwd 下）：
 *   node review-artifacts/i10/e2e/header-bisect.cjs
 */
'use strict';

const { app, net } = require('electron');
const http = require('node:http');

const PORT = Number.parseInt(process.env['ZCC_PROBE_PORT'] ?? '8791', 10);
const SYNTHETIC_KEY = 'zcc_probe_local_only_000000000000';
const URL_TARGET = `http://127.0.0.1:${PORT}/v1/models`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url, host: req.headers.host }));
});

/** @type {Array<{ label: string, headers: Record<string, string> }>} */
const VARIANTS = [
  { label: '无任何头', headers: {} },
  { label: '只带 authorization', headers: { authorization: `Bearer ${SYNTHETIC_KEY}` } },
  { label: '只带 host', headers: { host: `127.0.0.1:${PORT}` } },
  { label: 'authorization + host（当前 buildUpstreamRequest 的产物）', headers: { authorization: `Bearer ${SYNTHETIC_KEY}`, host: `127.0.0.1:${PORT}` } }
];

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  for (const variant of VARIANTS) {
    try {
      const res = await net.fetch(URL_TARGET, { method: 'GET', headers: variant.headers });
      await res.body?.cancel().catch(() => {});
      console.log(`[bisect] ${variant.label} → ${res.status}`);
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.log(`[bisect] ${variant.label} → 失败（${reason}）`);
    }
  }

  server.close();
  app.exit(0);
});
