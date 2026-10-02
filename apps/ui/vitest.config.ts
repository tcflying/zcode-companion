import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// UI01 自有测试配置：不修改根 vitest.config.ts（该文件由 I01 独占）。
// 只覆盖 apps/ui 下的单元测试，全部为纯函数/纯本地状态，不触网。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 15000
  }
});
