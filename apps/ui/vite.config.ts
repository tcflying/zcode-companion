import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

// ZCode Companion UI shell build.
// - No plugin dependencies: the TSX transform is driven by tsconfig.json (jsx: react-jsx).
// - base './' so the built assets can also be loaded from a file:// or custom protocol page.
// - No plugin-provided proxies; the only proxy is the UI04 loopback catalog 反代（见下）。
//
// UI04 网络边界：浏览器只发**同源**请求。
//   /v1/zcc/catalog → ZCC_API_ORIGIN（默认 http://127.0.0.1:8790，API01 裁定端口）
// 反代做三件事，且**只做**这三件：
//   1. changeOrigin → Host 头变成 127.0.0.1:8790，满足 API 侧 Host 门；
//   2. 删掉 Origin / Cookie 头 —— API 侧「Origin 白名单默认全拒 + CORS 永不开启」，
//      同源反代让浏览器根本不产生跨源请求，因此不需要 API 侧开 CORS；
//   3. 若给了 ZCC_API_TOKEN 则注入 Authorization: Bearer —— token 只存在于本机
//      dev/preview 服务器进程，不进浏览器、不进构建产物、不落盘。
// 目标 origin 不在回环闭集内时**不注册代理**（fail-closed），联调直接失败而不是外联。
const UI_ROOT = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_API_ORIGIN = 'http://127.0.0.1:8790';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/** 只放行本机回环；返回 null 表示拒绝注册代理。 */
function loopbackTarget(raw: string | undefined): string | null {
  const value = (raw ?? DEFAULT_API_ORIGIN).trim();
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!LOOPBACK_HOSTS.includes(url.hostname.toLowerCase())) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function catalogProxy(mode: string): Record<string, ProxyOptions> | undefined {
  const env = loadEnv(mode, UI_ROOT, 'ZCC_');
  const target = loopbackTarget(env['ZCC_API_ORIGIN']);
  if (target === null) {
    // 目标不是回环 → 不挂代理。UI 的回环守卫也会在浏览器侧独立拒一次。
    console.warn(
      `[ui04] ZCC_API_ORIGIN=${env['ZCC_API_ORIGIN'] ?? '(未设置)'} 不是本机回环，不注册 /v1/zcc/catalog 代理。`
    );
    return undefined;
  }
  const token = (env['ZCC_API_TOKEN'] ?? '').trim();
  return {
    '/v1/zcc/catalog': {
      target,
      changeOrigin: true,
      secure: false,
      configure: (proxy) => {
        proxy.on('proxyReq', (proxyReq) => {
          proxyReq.removeHeader('origin');
          proxyReq.removeHeader('cookie');
          proxyReq.removeHeader('referer');
          if (token !== '') proxyReq.setHeader('authorization', `Bearer ${token}`);
        });
      }
    }
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
    sourcemap: false
  },
  server: {
    host: '127.0.0.1',
    port: 4319,
    strictPort: true,
    proxy: catalogProxy(mode)
  },
  preview: {
    host: '127.0.0.1',
    port: 4319,
    strictPort: true,
    proxy: catalogProxy('production')
  }
}));
