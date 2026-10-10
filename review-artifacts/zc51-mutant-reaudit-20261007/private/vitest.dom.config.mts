/**
 * 私有 Vite/Vitest 配置（审计用，**不入正式树**）。
 *
 * 方案演进与实测结论（避免重复踩）：
 *  1. `--environment <绝对路径 G:/...>` → 首字符非 '.'/'/'，被当包名解析
 *     `vitest-environment-G:/...`（init.IsjtLXKe.js:loadEnvironment）。
 *  2. `--environment <相对路径>` → 路径对了，但 worker 侧仍报
 *     "not defined in the Vite config"，因为 vitest 5 走 Vite 6
 *     environments API（index.C-uw7tH9.js:10438 `project.vite.environments[name]`）。
 *  3. `--setupFiles` 不是 CLI 选项（CACError: Unknown option）。
 *
 * ⇒ 终选方案：**保留官方 environment:'node' 不动**，只用 config 的
 * `test.setupFiles` 在既有 node 环境里注入 happy-dom 的 DOM 全局。
 *    环境解析完全不参与，零 config 冲突，零依赖安装。
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'G:/zcode-project/zcode-companion/apps/ui',
  test: {
    // 官方原生环境，一个字不改
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 20000,
    // 私有：只加这一条 —— 把 happy-dom DOM 装进 node 环境的 globalThis
    setupFiles: ['../../review-artifacts/zc51-mutant-reaudit-20261007/private/dom-setup.ts']
  },
  // happy-dom 在本项目 node_modules 里不存在，显式告诉 Vite 别去预打包
  optimizeDeps: {
    exclude: ['happy-dom']
  }
});
