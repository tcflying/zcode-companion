/**
 * ZCode Companion 桌面程序主进程（I10）。
 *
 * 一句话：**把反代的启动、显示、操作全部收进 GUI，绝不弹独立 cmd 窗口。**
 * 用户双击一个 exe 之后看到的就是这个窗口，反代是它的子进程（`windowsHide: true`
 * + `shell: false`），不额外开任何控制台。
 *
 * 五条硬边界：
 *  1. **key 只活在主进程。** 注入、比对、脱敏都在这一侧；渲染进程拿到的只有
 *     `apiKeySet` / 掩码 / `zcc-fp:*` 指纹（见 `lib/settings.cjs`），日志与 IPC
 *     载荷里也不出现明文。
 *  2. **只管自己 spawn 的子进程。** 端口上已有服务时进入 `external` 态：只观察，
 *     启动/停止按钮禁用，绝不向不是自己拉起来的进程发信号（见 `lib/proxy-manager.cjs`）。
 *  3. **`app://` 只有两条分支**：`/v1/` 转发、其余走 `dist` 静态文件；静态目录穿越
 *     照旧 403，转发失败如实报上游状态而不是回落到静态（见 `lib/app-protocol.cjs`）。
 *  4. **smoke 模式不 spawn 任何子进程**（CI 依赖它），也不读用户真实设置。
 *  5. **渲染进程没有任何设备能力**：contextIsolation 开、nodeIntegration 关、sandbox 开、
 *     非 `app://` 的导航与开窗一律拒绝。
 */

'use strict';

const { app, BrowserWindow, Tray, Menu, protocol, net, ipcMain, nativeImage, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveRuntimePaths } = require('./lib/runtime-paths.cjs');
const { createLogRing } = require('./lib/log-ring.cjs');
const { createLogExporter } = require('./lib/log-export.cjs');
const { createProxyManager } = require('./lib/proxy-manager.cjs');
const { buildSpawnSpec: buildSpecForRuntime } = require('./lib/spawn-spec.cjs');
const {
  routeAppRequest,
  buildUpstreamRequest,
  buildResponseHeaders,
  classifyUpstreamStatus,
  UPSTREAM_HOST
} = require('./lib/app-protocol.cjs');
const {
  loadSettings,
  saveSettings,
  settingsFilePath,
  seedApiKeyFromMinimax,
  publicSettings,
  normalizeSettings
} = require('./lib/settings.cjs');
const { createJournal, journalFilePath } = require('./lib/journal.cjs');
const { assessSpawnStep } = require('./lib/verify-contract.cjs');

/**
 * 本窗口实际交给 Electron 的 `webPreferences`。
 *
 * Electron 44 的 `WebPreferences` 类型里没有 `permissions`（`node_modules/electron/electron.d.ts`
 * 全文无该字段），但这行配置是既有运行时对象的一部分：删掉它会改运行时对象。这里只做
 * **类型层的局部扩展**，断言之外的运行时内容逐字节不变。
 * @typedef {import('electron').WebPreferences & { permissions: string[] }} DesktopWebPreferences
 */

/* -------------------------------------------------------------------------- */
/* 运行形态                                                                    */
/* -------------------------------------------------------------------------- */

const ARGV = process.argv.slice(1);
const RUN_MODE = ARGV.includes('--zcc-smoke') ? 'smoke' : ARGV.includes('--zcc-verify') ? 'verify' : 'product';

const SMOKE_OUT =
  process.env['ZCC_SMOKE_OUT'] || path.resolve(__dirname, '..', '..', 'review-artifacts', 'i10', '20-smoke-render.png');
const VERIFY_OUT = process.env['ZCC_VERIFY_OUT'] || '';
/** verify 模式用的**合成** key：不是任何真实凭据，也不从任何环境或文件读取。 */
const VERIFY_SYNTHETIC_KEY = 'zcc_verify_local_only_0000000000000';
const VERIFY_PORT = Number.parseInt(process.env['ZCC_VERIFY_PORT'] ?? '8899', 10);
const VERIFY_SHOT = process.env['ZCC_VERIFY_SHOT'] || '';

const SHUTDOWN_GRACE_MS = 5_000;
const START_TIMEOUT_MS = 30_000;

/** verify/smoke 都用一次性 userData：绝不去读、也绝不去写用户真实的 settings.json。 */
if (RUN_MODE !== 'product') {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `zcc-desktop-${RUN_MODE}-`));
  app.setPath('userData', scratch);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
]);

/* -------------------------------------------------------------------------- */
/* 状态                                                                        */
/* -------------------------------------------------------------------------- */

const runtime = resolveRuntimePaths({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  repoRoot: path.resolve(__dirname, '..', '..')
});
const UI_DIST = runtime.uiDist;

const settingsFile = settingsFilePath(app.getPath('userData'));
const loaded = loadSettings(settingsFile);

/**
 * 操作 journal（929.md:875「journal不足拒新发而非丢unknown」）。
 * 与 settings.json 同根：`app.getPath('userData')/journal.json`。
 * 容量不足时 `append` 返回 `{ ok:false, reason:'journal_capacity_exceeded' }`，
 * 调用方据此**拒绝这次新发**，而不是让旧条目被静默丢掉。
 */
const journalDir = path.dirname(settingsFile);
const journal = createJournal({ dir: journalDir });
journal.load(journalDir);
const journalFile = journalFilePath(journalDir);
/**
 * 三种运行形态的凭据纪律各不相同：
 *  - `product`：首启引导允许从 `~/.minimax/config.yaml` 读回**本产品自己那把** key。
 *  - `smoke`  ：**不读任何凭据**。它只证明「不 spawn 反代也能渲染」，既然不连服务，
 *               就没有理由把一把真 key 读进内存。
 *  - `verify` ：只用一个**合成** key，跑的是包内 driver=none 的运行时，与真实凭据无关。
 */
const seeded =
  RUN_MODE === 'verify'
    ? {
        settings: { ...loaded.settings, apiKey: VERIFY_SYNTHETIC_KEY, apiPort: VERIFY_PORT, driver: 'none' },
        seeded: false,
        source: null,
        reason: 'verify 模式使用合成 key，不读任何真实凭据'
      }
    : RUN_MODE === 'smoke'
      ? { settings: { ...loaded.settings, apiKey: '' }, seeded: false, source: null, reason: null }
      : seedApiKeyFromMinimax(loaded.settings);
let settings = seeded.settings;

const logRing = createLogRing({ capacity: 600 });
if (settings.apiKey) logRing.addSecret(settings.apiKey);

/* --- 脱敏日志导出（RA-09）--- */

/** 导出取环里最近多少行。与环容量同量级：导出的对象就是「这一份本地缓冲」。 */
const EXPORT_TAIL_LINES = 600;

/**
 * 导出执行器：语义全在 `lib/log-export.cjs`，这里只把三样依赖注进去
 * （取行、取机密、选目标并落盘）。「重复动作不重复写盘」的在途标志
 * 由模块内部持有，主进程不再自己维护第二份状态。
 */
const exportLogs = createLogExporter({
  getLines: () => logRing.tail(EXPORT_TAIL_LINES),
  // 用**环里同一份**机密集，而不是在这里另猜一把 key。
  getSecrets: () => logRing.secrets(),
  saveAs: async ({ generatedAt }) => {
    const saveOptions = {
      title: '保存脱敏日志导出',
      defaultPath: `zcc-logs-${generatedAt.replace(/[:.]/g, '-')}.txt`,
      filters: [{ name: '文本日志', extensions: ['txt', 'log'] }]
    };
    // 窗口可能已经关了：对话框没有父窗口时照样能弹，所以按窗口是否可用分支。
    const window = /** @type {BrowserWindow | null} */ (mainWindow);
    return window !== null && !window.isDestroyed()
      ? dialog.showSaveDialog(window, saveOptions)
      : dialog.showSaveDialog(saveOptions);
  },
  writeFile: (filePath, text) => {
    fs.writeFileSync(filePath, text, 'utf8');
  }
});

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;

/**
 * 主进程侧的一条日志：进环形缓冲（已脱敏），不落盘、不进 IPC 载荷。
 * @param {string} text
 * @returns {void}
 */
function logMain(text) {
  logRing.append('main', text, Date.now());
}

/**
 * 探测上游是否在监听。`GET /v1/models` 返回 401 或 200 都算「活」：
 * 401 说明服务在、只是这次没带 key——那正是我们启动前想要知道的事实。
 * @param {number} port
 * @param {AbortSignal} [signal] 启动预算耗尽时由管理器 abort。这里**必须**透传给 `net.fetch`：
 *   不接信号的话，「取消」只是上层不再等，底层请求照旧挂着（ZC-31/F16）。
 * @returns {Promise<boolean>}
 */
async function probeApi(port, signal) {
  try {
    const res = await net.fetch(`http://${UPSTREAM_HOST}:${port}/v1/models`, { method: 'GET', signal });
    await res.body?.cancel().catch(() => {});
    return res.status === 200 || res.status === 401;
  } catch {
    return false;
  }
}

/**
 * 子进程用的 Node 运行时。
 *
 * 打包后的 portable exe 里**没有**一个独立的 `node.exe`，所以统一用「Electron 自带
 * 的 Node」：`process.execPath` + `ELECTRON_RUN_AS_NODE=1`。这条链在整棵进程树上
 * 成立——反代再用 `process.execPath` 去 spawn 官方 app-server 时会原样继承这个环境
 * 变量，于是孙进程同样以纯 Node 形态运行。
 */
function nodeCommand() {
  return { command: process.execPath, extra: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** 用当前设置组装 spawn 规格。`cwd` 固定为运行时根：官方宿主要建隔离工作区。 */
function buildSpawnSpec() {
  return buildSpecForRuntime({
    runtime: { apiEntry: runtime.apiEntry, runtimeRoot: runtime.runtimeRoot },
    settings,
    node: nodeCommand(),
    parentEnv: process.env,
    // 929.md:875：journal 落到与 settings **同一个目录**。
    // 这是「从既有配置路径接」的字面含义——子进程不需要用户另设任何开关，
    // 它拿到的就是主进程早就在用的那个目录（上面 journalDir 已是它）。
    journalDir,
    shutdownGraceMs: SHUTDOWN_GRACE_MS
  });
}

/**
 * 把新设置装进管理器。
 *
 * 运行中换端口会被**拒绝**：快照里的端口必须始终等于子进程真正在监听的那个。
 * 新端口被记进 `configuredPort`，界面显示「待重启生效」——如实，而不是让界面
 * 指向一个没人监听的地址。
 * @returns {{ applied: boolean, reason?: string }}
 */
function applySettings() {
  const outcome = manager.configure({ port: settings.apiPort, spawnSpec: buildSpawnSpec() });
  if (!outcome.applied) {
    logMain(`设置已保存，但反代正在运行：端口/驱动改动需「重启」后才生效（${String(outcome.reason)}）。`);
  }
  return outcome;
}

const manager = createProxyManager({
  // 真实 spawn 句柄比 `FakeChild` 契约宽一格：`ChildProcess.pid` 是 `number | undefined`，
  // 契约要求 `number`。这里只做类型层断言，spawn 的调用参数与调用时机均未改动。
  spawnChild: (spec) =>
    /** @type {import('./lib/proxy-manager.cjs').FakeChild} */ (
      spawn(spec.command, spec.args, {
        env: spec.env,
        cwd: spec.cwd,
        windowsHide: spec.windowsHide,
        shell: spec.shell,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    ),
  probeApi,
  logRing,
  startTimeoutMs: START_TIMEOUT_MS,
  shutdownGraceMs: SHUTDOWN_GRACE_MS,
  onChange: () => pushToRenderer()
});

manager.configure({ port: settings.apiPort, spawnSpec: buildSpawnSpec() });

/* -------------------------------------------------------------------------- */
/* app:// 协议                                                                 */
/* -------------------------------------------------------------------------- */

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

/**
 * 本机拒绝转发时的回包：如实说「没发出去」，绝不伪装成上游错误。
 * @param {number} status
 * @param {unknown} payload
 * @returns {Response}
 */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

/**
 * 读 dist 里的静态文件。取不到就是 404，绝不回落成「成功」。
 * @param {string} file
 * @returns {Promise<Response>}
 */
async function serveStatic(file) {
  try {
    const res = await net.fetch(`file://${file.replace(/\\/g, '/')}`);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return new Response(res.body, { status: 200, headers: { 'content-type': type } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

/**
 * 把 `/v1/...` 转发到本机 API：成功如实回上游状态，失败如实报失败。
 * @param {Request} request
 * @param {string} rawPath
 * @returns {Promise<Response>}
 */
async function forwardToApi(request, rawPath) {
  const built = buildUpstreamRequest(rawPath, {
    port: settings.apiPort,
    apiKey: settings.apiKey,
    method: request.method,
    headers: request.headers,
    // GET/HEAD 不带 body；其余方法把流原样交给 net.fetch，SSE 之类的长响应不被缓冲打断。
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body
  });
  if (!built.ok) {
    logMain(`转发被本地拒绝：${rawPath} → ${built.reason}`);
    return jsonResponse(built.status, { error: { code: built.reason, message: '本机代理未配置完成，转发未发出。' } });
  }
  try {
    const res = await net.fetch(built.url, built.init);
    // 1xx / 非法状态码无法被 Response 构造器如实重建（只接受 200..599）。硬转会抛
    // RangeError 并被下面的 catch 吞成「上游不可达」——那是假的诊断，方向全错。
    // 单独判一条说人话的错误码。
    const kind = classifyUpstreamStatus(res.status);
    if (kind === 'invalid') {
      await res.body?.cancel().catch(() => {});
      const reason = `UPSTREAM_STATUS_NOT_REPRESENTABLE: 上游返回了 ${String(res.status)}，无法作为 HTTP 响应如实回传。`;
      logMain(reason);
      return jsonResponse(502, {
        error: { code: 'upstream_status_not_representable', message: `本机 API 返回了无法转发的状态码 ${String(res.status)}。` }
      });
    }
    return new Response(kind === 'bodyless' ? null : res.body, {
      status: res.status,
      statusText: res.statusText,
      // 机密串传进去做「按值丢头」：上游万一把 token 塞进某个响应头，也不许回传。
      headers: buildResponseHeaders(res.headers, settings.apiKey === '' ? [] : [settings.apiKey])
    });
  } catch (err) {
    // 上游不可达要如实说「上游不可达」，绝不回落到静态文件把 404 伪装成成功。
    const reason = `UPSTREAM_UNREACHABLE: 127.0.0.1:${settings.apiPort}（${err instanceof Error ? err.message : String(err)}）`;
    logMain(reason);
    return jsonResponse(502, {
      error: {
        code: 'upstream_unreachable',
        message: `本机 API 未响应：127.0.0.1:${settings.apiPort}。请在「总览」页确认反代状态。`
      }
    });
  }
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const decision = routeAppRequest(request.url, { distRoot: UI_DIST });
    if (decision.kind === 'reject') return new Response('forbidden', { status: 403 });
    // `RouteDecision` 把 `rawPath` / `pathname` 各自标成可选，`kind` 收窄带不动它们；
    // 但 `routeAppRequest` 的 forward 分支只返回 `{ kind: 'forward', rawPath: string }`
    // （见 lib/app-protocol.cjs），断言与下面 pathname 那行是同一套写法。
    if (decision.kind === 'forward') return forwardToApi(request, /** @type {string} */ (decision.rawPath));
    return serveStatic(/** @type {string} */ (decision.pathname));
  });
}

/* -------------------------------------------------------------------------- */
/* IPC                                                                         */
/* -------------------------------------------------------------------------- */

function snapshotPayload() {
  return manager.getSnapshot();
}

function pushToRenderer() {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('zcc:desktop:changed', {
    snapshot: snapshotPayload(),
    logs: logRing.tail(200)
  });
}

function registerIpc() {
  ipcMain.handle('zcc:desktop:state', () => snapshotPayload());
  ipcMain.handle('zcc:desktop:log', (_event, limit) => logRing.tail(typeof limit === 'number' ? limit : 200));
  // journal 只读写**结构化操作记录**（operationId / state / outcome / 时间），
  // 不含任何凭据、token、邮箱或会话标识。容量不足时如实返回拒绝原因，让渲染层
  // 能显示「本次新发被拒」而不是假装成功。
  ipcMain.handle('zcc:journal:list', () => ({
    entries: journal.list(),
    problems: journal.listProblems(),
    file: journalFile,
    capacity: journal.capacity(),
    size: journal.size()
  }));
  ipcMain.handle('zcc:journal:append', (_event, input) => journal.append(input ?? {}));
  ipcMain.handle('zcc:journal:cancel', (_event, operationId, reason) =>
    journal.cancel(String(operationId ?? ''), reason)
  );
  ipcMain.handle('zcc:desktop:settings:get', () => ({
    settings: publicSettings(settings),
    settingsFile,
    seededFrom: seeded.source,
    seedProblem: seeded.reason,
    loadProblems: loaded.problems,
    runtime: { kind: runtime.kind, runtimeRoot: runtime.runtimeRoot, apiEntry: runtime.apiEntry }
  }));
  ipcMain.handle('zcc:desktop:settings:save', (_event, input) => {
    const normalized = normalizeSettings(input, settings.apiKey);
    if (!normalized.ok) return { ok: false, reason: normalized.reason };
    settings = normalized.value;
    // key 可能被换过：清空缓冲并登记新串，旧串从此不再可能被读到。
    logRing.clear();
    logRing.addSecret(settings.apiKey);
    saveSettings(settingsFile, settings);
    applySettings();
    logMain('设置已保存；反代需要「重启」后生效。');
    return { ok: true, settings: publicSettings(settings) };
  });
  ipcMain.handle('zcc:desktop:start', () => manager.start());
  ipcMain.handle('zcc:desktop:stop', () => manager.stop());
  ipcMain.handle('zcc:desktop:restart', () => manager.restart());

  /**
   * 脱敏日志导出（RA-09 `929.md:386/445/554/876`）。
   *
   * 三条语义是刻意分开的，报告里必须逐条对得上：
   *  1. **非法输入如实拒绝**：`planLogExport` 先判，返回具体码，不静默兜底成成功。
   *  2. **取消保存不是错误**：用户在系统对话框里点取消 ⇒ `CANCELLED`，不写任何文件。
   *  3. **重复动作不重复写盘**：保存进行中再来一次 ⇒ `EXPORT_IN_PROGRESS`，
   *     而不是弹第二个对话框或写两次。
   *
   * `preview` 模式**只读不落盘**：`:445` 要求「导出有预览」，预览必须先于任何写入。
   * 脱敏与字节上限都在 `lib/log-export.cjs` 的纯函数里做，那里没有 fs、没有网络，可被完整单测。
   */
  ipcMain.handle('zcc:desktop:logs:export', (_event, input) => exportLogs(input));
}

/* -------------------------------------------------------------------------- */
/* 窗口 / 托盘 / 单实例                                                        */
/* -------------------------------------------------------------------------- */

function iconImage() {
  const file = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(file)) return nativeImage.createFromPath(file);
  return nativeImage.createEmpty();
}

/**
 * 建主窗口。硬边界在下面的 `setWindowOpenHandler` / `will-navigate` 里，配置本身不松。
 * @param {{ hidden: boolean }} options
 * @returns {BrowserWindow}
 */
function createWindow(options) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: !options.hidden,
    backgroundColor: '#f4f6fa',
    title: 'ZCode Companion（独立软件 · 非 ZCode 官方）',
    icon: iconImage(),
    // 类型层扩展只为容纳 `permissions`（见文件头的 DesktopWebPreferences），运行时对象不变。
    webPreferences: /** @type {DesktopWebPreferences} */ ({
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      permissions: []
    })
  });

  // 硬边界：任何非 app:// 的导航或窗口打开一律拒绝，保证界面不可能访问外部。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://')) event.preventDefault();
  });

  win.loadURL('app://bundle/index.html');
  return win;
}

function showWindow() {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createWindow({ hidden: false });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  tray = new Tray(iconImage());
  tray.setToolTip('ZCode Companion · 独立软件（非 ZCode 官方）');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: () => showWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit();
        }
      }
    ])
  );
  tray.on('click', () => showWindow());
}

/* -------------------------------------------------------------------------- */
/* 启动 / 收束                                                                 */
/* -------------------------------------------------------------------------- */

function startManagedProxy() {
  if (RUN_MODE !== 'product') return; // smoke / verify 各自走下面的专用路径。
  if (settings.apiKey.trim() === '') {
    logMain('尚未配置 API key：不启动反代。请到「设置」页完成首启引导或粘贴已有 key。');
    return;
  }
  manager
    .start()
    .then((result) => {
      logMain(result.ok ? `反代已就绪：127.0.0.1:${settings.apiPort}（${result.code}）` : `反代启动未成功：${result.code}`);
    })
    .catch((err) => logMain(`反代启动异常：${err instanceof Error ? err.message : String(err)}`));
}

function runSmoke() {
  mainWindow = createWindow({ hidden: true });
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const image = await /** @type {BrowserWindow} */ (mainWindow).webContents.capturePage();
        fs.mkdirSync(path.dirname(SMOKE_OUT), { recursive: true });
        fs.writeFileSync(SMOKE_OUT, image.toPNG());
        console.log(`[smoke] rendered -> ${SMOKE_OUT} (${image.getSize().width}x${image.getSize().height})`);
      } catch (err) {
        console.error('[smoke] capture failed:', err);
        app.exit(1);
        return;
      }
      app.exit(0);
    }, 1200);
  });
}

/**
 * verify 的每一步记录。前五项与 `lib/verify-contract.cjs` 的 `SpawnStep` 对齐（判据只有
 * 那一份），后两项是 app:// 转发自检专用。
 * @typedef {import('./lib/verify-contract.cjs').SpawnStep & { status?: unknown, apiKeyLeaked?: boolean }} VerifyStep
 */

/**
 * 包自足性自检（`verify:package` 门用）：
 * 用**包内**的反代运行时（driver=none，不接任何真实模型）把 API 拉起来，再让渲染
 * 进程经 `app://` 真发一次 `GET /v1/models`，最后把结果写到 `ZCC_VERIFY_OUT`。
 */
async function runVerify() {
  /**
   * verify 报告：落盘内容与门判定都只读它。`dispose` 在写盘之后才补上，因此不进入 JSON。
   * @type {{
   *   ok: boolean,
   *   steps: VerifyStep[],
   *   reason: string | undefined,
   *   dispose?: { ok: boolean, code: string }
   * }}
   */
  const report = { ok: false, steps: [], reason: /** @type {string|undefined} */ (undefined) };
  /**
   * 落盘 + 收束 + 退出。
   *
   * **必须先 dispose 再 exit。** verify 模式同样 spawn 了一个真的反代子进程；直接
   * `app.exit()` 的话它只能靠「父进程的管道被 OS 断开、驱动侧读 EOF」这类副作用
   * 碰巧收干净。那是巧合不是保证：收不干净就会在门跑完之后留一个占着 8899 的孤儿，
   * 下一次跑门立刻撞上端口被占。
   * @param {number} code
   */
  const finish = async (code) => {
    if (VERIFY_OUT) {
      fs.mkdirSync(path.dirname(VERIFY_OUT), { recursive: true });
      fs.writeFileSync(VERIFY_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    const disposed = await manager.dispose().catch((err) => ({ ok: false, code: `DISPOSE_FAILED:${err instanceof Error ? err.message : String(err)}` }));
    report.dispose = disposed;
    console.log(`[verify] ${report.ok ? 'OK' : `FAIL ${report.reason ?? ''}`} dispose=${JSON.stringify(disposed)}`);
    app.exit(code);
  };

  try {
    const started = await manager.start();
    const after = manager.getSnapshot();
    report.steps.push({ step: 'spawn-runtime', ok: started.ok, code: started.code, state: after.state, pid: after.pid, port: after.port });
    // **必须**是「包自己把反代拉起来了」。判据只有一份（见 `lib/verify-contract.cjs`），
    // 因为这条一旦在两处漂起来，就会用别人的服务替本包的自足性签字。
    const verdict = assessSpawnStep(report.steps[report.steps.length - 1]);
    if (!verdict.ok) {
      report.reason = verdict.reason;
      await finish(1);
      return;
    }
    const inPage = await /** @type {BrowserWindow} */ (mainWindow).webContents.executeJavaScript(
      `(async () => {
         try {
           const res = await fetch('/v1/models', { headers: { accept: 'application/json' } });
           const text = await res.text();
           return { ok: true, status: res.status, body: text.slice(0, 400) };
         } catch (err) {
           return { ok: false, status: 0, body: String(err) };
         }
       })()`,
      true
    );
    const leaked = String(inPage.body).includes(settings.apiKey);
    report.steps.push({ step: 'app-forward-models', ok: inPage.ok === true && inPage.status === 200, status: inPage.status, apiKeyLeaked: leaked });
    report.ok = inPage.ok === true && inPage.status === 200 && !leaked;
    if (!report.ok) report.reason = `app:// → /v1/models 未打通：${JSON.stringify(inPage)}`;

    if (VERIFY_SHOT) {
      const image = await /** @type {BrowserWindow} */ (mainWindow).webContents.capturePage();
      fs.mkdirSync(path.dirname(VERIFY_SHOT), { recursive: true });
      fs.writeFileSync(VERIFY_SHOT, image.toPNG());
    }
    await finish(report.ok ? 0 : 1);
  } catch (err) {
    report.reason = err instanceof Error ? err.message : String(err);
    await finish(1);
  }
}

function bootstrap() {
  for (const problem of runtime.errors) console.error(`[startup] ${problem}`);
  if (!fs.existsSync(path.join(UI_DIST, 'index.html'))) {
    console.error(`[startup] 找不到界面产物：${path.join(UI_DIST, 'index.html')}`);
    console.error('[startup] 请先执行：cd apps/ui && npx vite build');
    app.exit(2);
    return;
  }

  registerAppProtocol();
  registerIpc();

  if (RUN_MODE === 'product') {
    // 单实例锁：二次启动只聚焦既有窗口，不拉起第二份反代。
    if (!app.requestSingleInstanceLock()) {
      app.exit(0);
      return;
    }
    app.on('second-instance', () => showWindow());
    createTray();
  }

  mainWindow = createWindow({ hidden: RUN_MODE !== 'product' });
  if (RUN_MODE === 'product') {
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  if (RUN_MODE === 'smoke') {
    runSmoke();
    return;
  }
  if (RUN_MODE === 'verify') {
    mainWindow.webContents.once('did-finish-load', () => {
      runVerify();
    });
    return;
  }
  startManagedProxy();
}

if (RUN_MODE !== 'product') {
  // 烟囱测试的硬超时：保证 smoke / verify 永远不会挂住。
  setTimeout(
    () => {
      console.error(`[${RUN_MODE}] 超时：120s 内未完成`);
      app.exit(3);
    },
    120000
  ).unref?.();
}

app.whenReady()
  .then(bootstrap)
  .catch((err) => {
    console.error('[startup] 崩溃：', err);
    app.exit(4);
  });

app.on('window-all-closed', () => {
  app.quit();
});

let cleanedUp = false;
let cleanupInFlight = false;
app.on('before-quit', (event) => {
  if (cleanedUp || RUN_MODE !== 'product') return;
  event.preventDefault();
  // **收束在途时的第二次 before-quit 只能拦住，绝不能放行**（ZC-33/F06）。
  // `cleanedUp` 要到 dispose 完成后才置位，所以重复 quit（用户连点退出、
  // 或 `window-all-closed` 之后又来一次）会在这里再发一次 `dispose()`；
  // 那一次立刻落定，`.finally()` 于是**在子进程还没退出时**就 `app.quit()`——
  // 退出被提前放行。真正收束的仍是第一次那条链，它完成后放行一次。
  if (cleanupInFlight) return;
  cleanupInFlight = true;
  manager
    .dispose()
    .catch(() => {})
    .finally(() => {
      cleanedUp = true;
      cleanupInFlight = false;
      tray?.destroy();
      tray = null;
      app.quit();
    });
});
