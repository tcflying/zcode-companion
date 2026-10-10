/**
 * 私有 mutant 配置（zc51-mutant-reaudit 轮专用，**不入正式树**）。
 *
 * 上一次失败的根因（保留在此以免重犯）：
 *   alias 的 replacement 写死成 `.../data/__mutant/modelSource.ts`，
 *   而本轮影子目录实际叫 `__mutant_reaudit` ⇒ 正则虽匹配到了
 *   `../data/modelSource`，却把它替换到一个**不存在的文件**，于是
 *   ERR_MODULE_NOT_FOUND / Tests: no tests —— 那是导入失败，**不是反例**。
 *
 * 修法：影子目录名与 replacement 统一由包装器传入的 SHADOW 决定，
 *      配置里用**相对别名**指向影子目录下同名文件，保证随影子目录改名同步。
 *
 * 这里用两个具体 alias（而非正则）以避开 Windows 路径分隔符匹配问题：
 *   '../data/modelSource'  ← ModelsPage 内部的相对导入
 *   './data/modelSource'   ← 探针自身可能用的导入
 */

import { defineConfig } from 'vitest/config';

const SHADOW_DIR = 'G:/zcode-project/zcode-companion/apps/ui/src/data/__mutant_reaudit';

export default defineConfig({
  root: 'G:/zcode-project/zcode-companion/apps/ui',
  resolve: {
    alias: [
      // 精确字符串优先于正则；顺序敏感：先长后短
      { find: '../data/modelSource', replacement: `${SHADOW_DIR}/modelSource.ts` },
      { find: './data/modelSource', replacement: `${SHADOW_DIR}/modelSource.ts` }
    ]
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 20000,
    setupFiles: ['../../review-artifacts/zc51-mutant-reaudit-20261007/private/dom-setup.ts']
  },
  optimizeDeps: {
    exclude: ['happy-dom']
  }
});
