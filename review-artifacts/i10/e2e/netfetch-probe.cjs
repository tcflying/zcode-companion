/**
 * 诊断：主进程 `net.fetch` 打本机回环端口到底通不通。
 *
 * 背景：开发形态端到端里，经 `app://` 转发 `/v1/zcc/catalog` 返回了 502
 * `upstream_unreachable`，而同一时刻用 Node 的 `fetch` 直连回环是 200。
 * 两者的差别只有「用谁的 HTTP 栈」，所以这里把两���都跑一遍，把差异钉死。
 *
 * 用法（在仓库 cwd 下）：node review-artifacts/i10/e2e/netfetch-probe.cjs
 */
'use strict';

const { app, net } = require('electron');
const http = require('node:http');

const PORT = Number.parseInt(process.env['ZCC_PROBE_PORT'] ?? '8791', 10);

/** 起一个最小的回环服务，只为让「通不通」这件事有确定答案。 */
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, from: 'node-http-server', path: req.url }));
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const url = `http://127.0.0.1:${PORT}/v1/models`;

  let nodeResult;
  try {
    const res = await fetch(url);
    nodeResult = `node fetch → ${res.status}`;
  } catch (err) {
    nodeResult = `node fetch → 抛错：${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  }

  let netResult;
  try {
    const res = await net.fetch(url, { method: 'GET' });
    await res.body?.cancel().catch(() => {});
    netResult = `electron net.fetch → ${res.status}`;
  } catch (err) {
    netResult = `electron net.fetch → 抛错：${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  }

  console.log(`[probe] ${nodeResult}`);
  console.log(`[probe] ${netResult}`);
  server.close();
  app.exit(nodeResult.includes('200') && netResult.includes('200') ? 0 : 1);
});
