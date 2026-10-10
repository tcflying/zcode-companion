import { defineConfig } from 'vitest/config';

// 私有配置（RA-09 真实 hook 接线轮专用，不入正式树，也不写 apps/ui/src）。
//
// 与前几轮的根本差别：前几轮的 runner 用 Copy-Item 把探针真实落盘到
// apps/ui/src/__ra*.probe.test.ts（因为官方 include 只有 src/**/*.test.ts），
// 跑完再删。那是真实写入产品源码目录，本轮主线程明令禁止。
//
// 本轮做法：root 设为仓库根，include 用绝对路径直接指向
// review-artifacts 下的私有探针，apps/ui/src 一个字节都不写。
// 官方 vitest.config.ts 与 apps/ui 全程不动。
//
// 注意：本文件刻意不使用 block 注释（/* */）。该 .mts 在本轮 root 设定下由 esbuild
// 解析，block 注释会触发 Unexpected token。行注释不受影响。
//
// 官方 environment node 一字不动，只用 setupFiles 注入 happy-dom DOM。
export default defineConfig({
  root: 'G:/zcode-project/zcode-companion',
  test: {
    environment: 'node',
    include: [
      'G:/zcode-project/zcode-companion/review-artifacts/ra09-realhook-audit-20261007/private/**/*.probe.test.ts'
    ],
    passWithNoTests: false,
    testTimeout: 20000,
    setupFiles: [
      'G:/zcode-project/zcode-companion/review-artifacts/ra09-realhook-audit-20261007/private/dom-setup.ts'
    ]
  },
  optimizeDeps: { exclude: ['happy-dom'] }
});