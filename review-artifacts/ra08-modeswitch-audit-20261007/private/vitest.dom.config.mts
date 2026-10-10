/**
 * 私有 vitest 配置（RA-08 模式切换轮专用，**不入正式树**）。
 *
 * 沿用已验证可用的方案：官方 environment:'node' 一字不动，
 * 只用 setupFiles 把 happy-dom DOM 注入 globalThis。
 * vitest 5 的 --environment 走 Vite 6 environments API，自定义环境会撞
 * "not defined in the Vite config"，故不再尝试。
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'G:/zcode-project/zcode-companion/apps/ui',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 20000,
    setupFiles: ['../../review-artifacts/ra08-modeswitch-audit-20261007/private/dom-setup.ts']
  },
  optimizeDeps: {
    exclude: ['happy-dom']
  }
});
