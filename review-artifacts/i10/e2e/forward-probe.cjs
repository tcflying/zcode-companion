/**
 * 诊断：用**真实的** `buildUpstreamRequest` 产物去打回环，成不成立。
 *
 * 前两支探针已把范围收到最后一步：
 *  - `netfetch-probe.cjs`：主进程 `net.fetch` → 回环 = 通；
 *  - 早期版本：本文件把 `app://` 页面 → `protocol.handle` → `net.fetch` → 回环整条链
 *    原样搭出来，也是通的。
 * 于是差异只剩「头是怎么拼的」。这里直接复用 `lib/app-protocol.cjs` 的真函数，
 * 免得再造一份和线上不一致的拼头逻辑。
 *
 * 只登记回环、合成数据，不读任何凭据。
 *
 * 用法（在仓库 cwd 下）：
 *   node review-artifacts/i10/e2e/forward-probe.cjs
 */
'use strict';

const { app, BrowserWindow, protocol, net } = require('electron');
const http = require('node:http');
const { join } = require('node:path');

const { routeAppRequest, buildUpstreamRequest } = require('../../../apps/desktop/lib/app-protocol.cjs');

const PORT = Number.parseInt(process.env['ZCC_PROBE_PORT'] ?? '8791', 10);
/** 合成 key：只用于让本地回环认得 Bearer，不是任何真实凭据。 */
const SYNTHETIC_KEY = 'zcc_probe_local_only_000000000000';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, host: req.headers.host, authorization: req.headers.authorization });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, from: 'node-http-server', path: req.url }));
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1/')) {
      return new Response('<!doctype html><meta charset="utf-8"><title>probe</title>', {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      });
    }
    const decision = routeAppRequest(request.url, { distRoot: join(__dirname) });
    const built = buildUpstreamRequest(/** @type {string} */ (decision.rawPath), {
      port: PORT,
      apiKey: SYNTHETIC_KEY,
      method: request.method,
      headers: request.headers
    });
    if (!built.ok) return new Response(JSON.stringify(built), { status: built.status });
    try {
      const res = await net.fetch(built.url, /** @type {any} */ (built.init));
      return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
    } catch (err) {
      const reason = `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
      console.log(`[probe] handler 内 net.fetch 失败 → ${reason}`);
      return new Response(JSON.stringify({ error: { code: 'upstream_unreachable', reason } }), {
        status: 502,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const win = new BrowserWindow({ show: false });
  await win.loadURL('app://bundle/index.html');
  const result = await win.webContents.executeJavaScript(
    `(async () => {
       try {
         const res = await fetch('/v1/models');
         return { status: res.status, body: (await res.text()).slice(0, 200) };
       } catch (err) { return { status: 0, body: String(err) }; }
     })()`,
    true
  );
  console.log(`[probe] 渲染进程 fetch('/v1/models') → status=${result.status} body=${result.body}`);
  for (const s of seen) {
    console.log(`[probe] 回环收到 url=${s.url} host=${String(s.host)} authorization=${String(s.authorization).slice(0, 12)}…`);
  }

  server.close();
  app.exit(result.status === 200 ? 0 : 1);
});
