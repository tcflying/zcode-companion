/**
 * 诊断：`manager.dispose()` 对一个**真的**子进程会不会挂住（I10 MEDIUM-3 取证）。
 *
 * 现象：verify 模式的报告写出来了（`ok: true`），但整个进程不退出。
 * 报告写在 `dispose()` **之前**，所以嫌疑落在 dispose 之后的收束路径上。
 * 这里用纯 Node + 真的子进程（一个会一直睡着的 node 子进程）把 `dispose()`
 * 单独拎出来跑，逐段打点，看它停在哪一句。
 *
 * 只登记合成数据，不读任何凭据。
 *
 * 用法（在仓库 cwd 下）：
 *   node review-artifacts/i10/e2e/dispose-probe.cjs
 */
'use strict';

const { createProxyManager } = require('../../../apps/desktop/lib/proxy-manager.cjs');
const { createLogRing } = require('../../../apps/desktop/lib/log-ring.cjs');
const net = require('node:http');

const PORT = Number.parseInt(process.env['ZCC_PROBE_PORT'] ?? '8796', 10);
const SYNTHETIC_KEY = 'zcc_probe_local_only_000000000000';

/** @param {string} m */
const mark = (m) => process.stdout.write(`[probe] ${m}\n`);

/**
 * 本地回环只在子进程起来之后才「应答」。
 * 起手就应答会让第一次探测判成 external（端口上已有服务），测的就不是「自己拉起来
 * 之后怎么收」这条路径了。
 */
let serveUp = false;
const server = net.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});

/** @param {number} port */
async function probeApi(port) {
  if (!serveUp) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) });
    await res.body?.cancel().catch(() => {});
    return res.status === 200 || res.status === 401;
  } catch {
    return false;
  }
}

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const { spawn } = require('node:child_process');
  const childRef = [];
  const manager = createProxyManager({
    spawnChild: () => {
      // 一个真的会一直睡着的子进程：不给它自己退出的机会。
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
      childRef.push(child);
      // 模拟「子进程起来后就监听」：从这里起探测才探得通，start() 才走 spawn 分支。
      serveUp = true;
      return child;
    },
    probeApi,
    logRing: createLogRing({ capacity: 50 }),
    pollIntervalMs: 50,
    startTimeoutMs: 5000,
    shutdownGraceMs: 1000
  });
  manager.configure({
    port: PORT,
    spawnSpec: { command: process.execPath, args: [], env: {}, cwd: '.', windowsHide: true, shell: false }
  });

  mark('calling start()');
  const started = await manager.start();
  mark(`start → ${JSON.stringify(started)} state=${manager.getState()}`);
  if (!started.ok) {
    server.close();
    process.exitCode = 1;
    return;
  }

  const pid = manager.getSnapshot().pid;
  mark(`child pid=${String(pid)}; calling dispose()`);
  const t0 = Date.now();
  const disposed = await manager.dispose();
  mark(`dispose → ${JSON.stringify(disposed)} after ${String(Date.now() - t0)}ms`);

  // 子进程到底死没死？
  await new Promise((r) => setTimeout(r, 300));
  let alive = true;
  try {
    process.kill(Number(pid), 0);
  } catch {
    alive = false;
  }
  mark(`child ${String(pid)} still alive? ${String(alive)}`);

  server.close();
  process.exitCode = disposed.ok && !alive ? 0 : 1;
}

main().then(
  () => mark('probe finished, event loop draining'),
  (err) => {
    mark(`probe threw: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
);
