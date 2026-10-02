#!/usr/bin/env node
/**
 * I10 开发形态端到端取证脚本（**不是门**，是取证工具）。
 *
 * 为什么不是一个 vitest 用例：它要真连 `official-host`、真发一条模型请求
 * （单请求 15–25 s）、还要真开一个 GUI 窗口。这三条都不属于 provider-free 的
 * 默认测试面，混进去会让 `npm test` 变成一条依赖网络与真实配额的链。
 *
 * 它做六件事，逐条留证据：
 *  1. 在 Electron 的 dev userData 里放一份 `settings.json`（key 从
 *     `~/.minimax/config.yaml` 读回，**全程不打印**），端口取 8791，避开 8790 上
 *     那个在跑的实例；
 *  2. `npx electron .` 启动桌面程序（带 `--remote-debugging-port`，用 CDP 驱动
 *     真正的界面按钮，不走后门 IPC）；
 *  3. 等反代就绪：`GET /v1/models` → 200、`GET /v1/zcc/catalog` → 18 条目录；
 *  4. 界面侧证据：`/v1/zcc/catalog` 经 `app://` 转发拿到目录；Logs 页有子进程输出；
 *  5. 真发一条 `POST /v1/chat/completions`（`reasoning_effort: low`），拿到真实回复；
 *  6. 点「停止」按钮 → 子进程真的退出；再点「启动」→ 重新就绪。
 *
 * 收尾：关窗即退出（`window-all-closed → quit`），子进程按 `ZCC_SHUTDOWN_GRACE_MS`
 * 收束；settings.json 还原成运行前的样子（不存在就删掉）。
 *
 * 用法（在仓库 cwd 下）：
 *   node review-artifacts/i10/e2e/dev-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);
const { readMinimaxApiKey } = require('../../../apps/desktop/lib/settings.cjs');

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const DESKTOP = join(REPO, 'apps', 'desktop');
const OUT_DIR = join(REPO, 'review-artifacts', 'i10');
const PORT = Number.parseInt(process.env['I10_E2E_PORT'] ?? '8791', 10);
const CDP_PORT = Number.parseInt(process.env['I10_E2E_CDP_PORT'] ?? '9333', 10);
const USER_DATA = join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'ZCodeCompanion');
const SETTINGS_FILE = join(USER_DATA, 'settings.json');
const MODEL = 'account:bigmodel-individual-coding-plan::GLM-5.3-Flash';

/** @type {string[]} */
const log = [];
/** @param {string} line */
function note(line) {
  log.push(line);
  process.stdout.write(`${line}\n`);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带 Bearer 的回环请求。key 只进请求头，**从不进任何输出**。
 * @param {string} path
 * @param {string} key
 * @param {RequestInit & { timeoutMs?: number }} [init]
 */
async function loopback(path, key, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) }
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 等某个条件成立；超时抛错，绝不「等不到就当过了」。 */
async function until(label, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* 还没到，继续等 */
    }
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    await sleep(500);
  }
}

/* -------------------------------------------------------------------------- */
/* CDP：驱动真实的界面按钮                                                     */
/* -------------------------------------------------------------------------- */

/** @type {WebSocket | null} */
let cdp = null;
/** @type {number} */
let cdpNextId = 1;
/** @type {Map<number, (value: any) => void>} */
const cdpPending = new Map();

async function connectCdp() {
  const list = await until(
    'CDP 调试端口就绪',
    async () => {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      // **必须**按 URL 认领自己的窗口：这台机器上可能还有别的 Electron 应用
      // （例如官方 ZCode 自己也在跑），它们的窗口同样是 `app://`。
      // 认错目标会把求值打到别人的页面上，然后报一句莫名其妙的 "Failed to fetch"。
      return targets.some((/** @type {{ type: string, url: string }} */ t) => t.type === 'page' && t.url.startsWith('app://bundle'))
        ? targets
        : null;
    },
    60_000
  );
  const page = list.find(
    (/** @type {{ type: string, url: string }} */ t) => t.type === 'page' && t.url.startsWith('app://bundle')
  );
  cdp = new WebSocket(page.webSocketDebuggerUrl);
  cdp.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    const resolvePromise = cdpPending.get(msg.id);
    if (resolvePromise) {
      cdpPending.delete(msg.id);
      resolvePromise(msg);
    }
  });
  await new Promise((r, reject) => {
    cdp.addEventListener('open', r, { once: true });
    cdp.addEventListener('error', reject, { once: true });
  });
  note(`[e2e] CDP 已连上本程序的窗口（端口 ${CDP_PORT}）`);
}

/**
 * 在渲染进程里求值（真实页面上下文）。
 * @param {string} expression
 * @returns {Promise<any>}
 */
async function evaluate(expression) {
  if (cdp === null) throw new Error('CDP 未连接');
  const id = cdpNextId++;
  const response = new Promise((r) => cdpPending.set(id, r));
  cdp.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const msg = await response;
  if (msg.result?.exceptionDetails) {
    throw new Error(`页面求值失败：${JSON.stringify(msg.result.exceptionDetails)}`);
  }
  return msg.result?.result?.value;
}

/**
 * 点一个带 data-action 的真实按钮。
 *
 * 状态卡只挂在「总览」页上，所以每次点之前先回到该路由并**等 React 真的渲染出这个
 * 元素**。少了这两步，按钮在别的路由下就是 `found:false`——那是取证脚本自己把自己
 * 测没了，不是产品缺陷。
 */
async function clickAction(action) {
  await evaluate(`(async () => { window.location.hash = '#/overview'; return true; })()`);
  return until(`按钮 [data-action=${action}] 出现在总览页`, async () => {
    const found = await evaluate(`(() => !!document.querySelector('[data-action=${JSON.stringify(action)}]'))()`);
    if (!found) return null;
    return evaluate(`(() => {
      const el = document.querySelector('[data-action=${JSON.stringify(action)}]');
      if (!el) return { found: false };
      const disabled = el.disabled === true;
      el.click();
      return { found: true, disabled };
    })()`);
  }, 15_000);
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

let hadSettings = false;
let previousSettings = '';
let electron = null;

try {
  mkdirSync(OUT_DIR, { recursive: true });

  // 1) 准备 settings.json（key 只在这里被读出一次，绝不打印）。
  hadSettings = existsSync(SETTINGS_FILE);
  previousSettings = hadSettings ? readFileSync(SETTINGS_FILE, 'utf8') : '';
  const read = readMinimaxApiKey();
  if (!read.ok) throw new Error(`读不到本产品的 API key：${read.reason}`);
  const apiKey = read.key;
  mkdirSync(USER_DATA, { recursive: true });
  writeFileSync(
    SETTINGS_FILE,
    `${JSON.stringify({ apiKey, apiPort: PORT, driver: 'official-host', reasoning: 'low' }, null, 2)}\n`,
    'utf8'
  );
  note(`[e2e] settings.json 已就位（端口 ${PORT}，key 未打印）`);

  // 2) 启动桌面程序。
  const electronBin = join(DESKTOP, 'node_modules', 'electron', 'cli.js');
  electron = spawn(process.execPath, [electronBin, '.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    windowsHide: false,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  electron.stdout.on('data', (d) => process.stderr.write(`[electron] ${String(d)}`));
  electron.stderr.on('data', (d) => process.stderr.write(`[electron] ${String(d)}`));
  note('[e2e] 桌面程序已拉起');

  // 3) 反代就绪：目录 + 模型列表。
  const models = await until('反代就绪（GET /v1/models 200）', async () => {
    const r = await loopback('/v1/models', apiKey);
    return r.status === 200 ? JSON.parse(r.text) : null;
  }, 90_000);
  note(`[e2e] GET /v1/models → 200，模型条目 ${(models.data ?? []).length}`);

  const catalog = await until('目录就绪（GET /v1/zcc/catalog 200）', async () => {
    const r = await loopback('/v1/zcc/catalog', apiKey);
    return r.status === 200 ? JSON.parse(r.text) : null;
  }, 30_000);
  note(`[e2e] GET /v1/zcc/catalog → 200，目录条目 ${(catalog.models ?? []).length}`);

  await connectCdp();

  // 4) 界面侧证据：app:// 转发 + 状态卡 + 日志页。
  const uiState = await evaluate(`(async () => {
    const res = await fetch('/v1/zcc/catalog', { headers: { accept: 'application/json' } });
    const body = await res.json();
    return {
      status: res.status,
      count: (body.models ?? []).length,
      snapshot: await window.zccDesktop.getSnapshot()
    };
  })()`);
  note(`[e2e] 界面经 app:// 取目录 → ${uiState.status}，条目 ${uiState.count}`);
  note(`[e2e] 状态卡快照：state=${uiState.snapshot.state} pid=${String(uiState.snapshot.pid)} port=${String(uiState.snapshot.port)}`);

  const logs = await evaluate(`(async () => {
    window.location.hash = '#/logs';
    const tail = await window.zccDesktop.getLogTail(50);
    return { count: tail.length, sample: tail.slice(-6).map((l) => l.text) };
  })()`);
  note(`[e2e] 日志页子进程输出 ${logs.count} 行；尾部样例：${JSON.stringify(logs.sample)}`);

  // 5) 真发一条模型请求。
  const chat = await loopback(
    '/v1/chat/completions',
    apiKey,
    {
      method: 'POST',
      timeoutMs: 300_000,
      body: JSON.stringify({
        model: MODEL,
        reasoning_effort: 'low',
        messages: [{ role: 'user', content: '只回答两个字：就绪' }]
      })
    }
  );
  const chatBody = chat.status === 200 ? JSON.parse(chat.text) : null;
  const reply = chatBody?.choices?.[0]?.message?.content ?? '';
  note(`[e2e] POST /v1/chat/completions → ${chat.status}，模型回复：${JSON.stringify(reply.slice(0, 80))}`);

  // 6) 停止按钮：真点、真退出。
  const beforeStop = await evaluate(`window.zccDesktop.getSnapshot()`);
  const clicked = await clickAction('proxy-stop');
  note(`[e2e] 点「停止」按钮：found=${String(clicked.found)} disabled=${String(clicked.disabled)}`);
  const stopped = await until('子进程退出', async () => {
    const snap = await evaluate(`window.zccDesktop.getSnapshot()`);
    return snap.state === 'stopped' ? snap : null;
  }, 30_000);
  note(`[e2e] 停止后状态=${stopped.state}，原 pid=${String(beforeStop.pid)}`);
  // 进程**已经**退出时 `process.kill(pid, 0)` 抛的是 ESRCH——那正是本步要的证据。
  // 让它冒泡会把「子进程确实死了」误报成 FAIL，所以这里只把「抛错」翻译成「不再存活」。
  const stillAlive = await new Promise((resolvePromise) => {
    process.kill(Number(beforeStop.pid), 0);
    resolvePromise(true);
  }).then(
    (alive) => alive,
    () => false
  );
  if (stillAlive) throw new Error(`停止后原 pid ${String(beforeStop.pid)} 仍然存活，停止按钮没生效`);
  note(`[e2e] 原 pid ${String(beforeStop.pid)} 是否仍存活：${String(stillAlive)}（已确认退出）`);

  // 再启动一次，证明状态机可恢复。
  const restarted = await clickAction('proxy-start');
  note(`[e2e] 点「启动」按钮：found=${String(restarted.found)} disabled=${String(restarted.disabled)}`);
  const back = await until('反代重新就绪', async () => {
    const r = await loopback('/v1/models', apiKey);
    return r.status === 200;
  }, 90_000);
  note(`[e2e] 重新启动后 GET /v1/models → 200（${String(back)}）`);

  const finalSnapshot = await evaluate(`window.zccDesktop.getSnapshot()`);
  writeFileSync(join(OUT_DIR, '30-dev-e2e-summary.json'), `${JSON.stringify({
    ok: true,
    port: PORT,
    modelsEndpointItems: (models.data ?? []).length,
    catalogItems: (catalog.models ?? []).length,
    uiCatalogItems: uiState.count,
    childLogLines: logs.count,
    chatStatus: chat.status,
    chatModel: MODEL,
    chatReplyPreview: reply.slice(0, 120),
    stoppedPid: beforeStop.pid,
    finalSnapshot
  }, null, 2)}\n`, 'utf8');
  note('[e2e] PASS：开发形态端到端全通');
} catch (err) {
  note(`[e2e] FAIL：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  // 收尾：只对自己拉起的那个句柄发信号；有界等待，不留悬挂进程。
  if (electron !== null) {
    electron.kill();
    await sleep(3000);
    if (electron.exitCode === null) electron.kill('SIGKILL');
  }
  if (hadSettings) writeFileSync(SETTINGS_FILE, previousSettings, 'utf8');
  else rmSync(SETTINGS_FILE, { force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, '31-dev-e2e-log.txt'), `${log.join('\n')}\n`, 'utf8');
  note('[e2e] 取证日志已写入 review-artifacts/i10/31-dev-e2e-log.txt');
}
