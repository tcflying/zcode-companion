import { defineConfig } from 'vitest/config';

/** 私有配置（delta-after-delete 轮专用，不入正式树）。官方 environment:'node' 不动。 */
export default defineConfig({
  root: 'G:/zcode-project/zcode-companion/apps/ui',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 20000,
    setupFiles: ['../../review-artifacts/ra08-delta-after-delete-20261007/private/dom-setup.ts']
  },
  optimizeDeps: { exclude: ['happy-dom'] }
});
