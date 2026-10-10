import { defineConfig } from 'vitest/config';

/**
 * 私有配置（RA-09 日志页脱敏/上限轮专用，不入正式树）。
 * 官方 environment:'node' 一字不动，只用 setupFiles 注入 happy-dom DOM。
 */
export default defineConfig({
  root: 'G:/zcode-project/zcode-companion/apps/ui',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 20000,
    setupFiles: ['../../review-artifacts/ra09-loggate-audit-20261007/private/dom-setup.ts']
  },
  optimizeDeps: { exclude: ['happy-dom'] }
});