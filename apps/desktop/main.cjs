/**
 * ZCode Companion —— Electron 最小安全壳（UI01）。
 *
 * 本文件的硬边界（与 UI01 任务范围一致）：
 * 1. 只加载本仓库自建的 apps/ui/dist 静态产物，不加载任何外部 URL。
 * 2. 不 spawn 官方 ZCode / app-server / DSH / 任何子进程。
 * 3. 不发起任何网络请求（不监听端口，不做 fetch）。
 * 4. 不读取凭据、官方配置或生产数据库；不注册单实例锁（I10 未实现，界面已标注未接入）。
 *
 * 安全设置：contextIsolation 开、nodeIntegration 关、sandbox 开、webSecurity 开。
 */

'use strict';

const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const UI_DIST = path.resolve(__dirname, '..', 'ui', 'dist');
const SMOKE = process.argv.includes('--zcc-smoke');
const SMOKE_OUT =
  process.env.ZCC_SMOKE_OUT ||
  path.resolve(__dirname, '..', '..', 'review-artifacts', 'ui01', '15-electron-shell-render.png');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
]);

function resolveInDist(requestUrl) {
  let pathname;
  try {
    // app://bundle/assets/x.js 的 host 是 bundle，文件路径在 pathname 上。
    pathname = new URL(requestUrl).pathname;
  } catch {
    return null;
  }
  const rel = decodeURIComponent(pathname === '' || pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  const target = path.resolve(UI_DIST, rel);
  // 目录穿越防护：解析后必须仍在 dist 之内。
  if (target !== UI_DIST && !target.startsWith(UI_DIST + path.sep)) return null;
  return target;
}

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const file = resolveInDist(request.url);
    if (!file) return new Response('forbidden', { status: 403 });
    try {
      const res = await net.fetch(`file://${file.replace(/\\/g, '/')}`);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return new Response(res.body, { status: 200, headers: { 'content-type': type } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: !SMOKE,
    backgroundColor: '#f4f6fa',
    title: 'ZCode Companion（独立软件 · 非 ZCode 官方）',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 本轮界面不需要任何设备能力。
      permissions: []
    }
  });

  // 硬边界：任何非 app:// 的导航或窗口打开一律拒绝，保证界面不可能访问外部。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://')) event.preventDefault();
  });

  win.loadURL('app://bundle/index.html');

  if (SMOKE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
          fs.mkdirSync(path.dirname(SMOKE_OUT), { recursive: true });
          fs.writeFileSync(SMOKE_OUT, image.toPNG());
          console.log(`[smoke] rendered -> ${SMOKE_OUT} (${image.getSize().width}x${image.getSize().height})`);
        } catch (err) {
          console.error('[smoke] capture failed:', err);
        }
        app.exit(0);
      }, 1200);
    });
  }
}

if (!fs.existsSync(path.join(UI_DIST, 'index.html'))) {
  console.error(`[startup] 找不到界面产物：${path.join(UI_DIST, 'index.html')}`);
  console.error('[startup] 请先执行：cd apps/ui && npx vite build');
  app.exit(2);
}

// 烟囱测试的硬超时：保证 --zcc-smoke 永远不会挂住。
if (SMOKE) {
  setTimeout(() => {
    console.error('[smoke] 超时：15s 内未完成渲染');
    app.exit(3);
  }, 15000).unref?.();
}

app.whenReady().then(() => {
  registerAppProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
