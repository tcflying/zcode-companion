import { defineConfig } from 'vitest/config';

// 私有配置（RA-09 packages/api journal 联动轮专用，不入正式树）。
//
// root 设为仓库根，include 用绝对路径直接指向 review-artifacts 下的私有探针。
// 本轮**不写任何正式源码目录**：探针只在 review-artifacts 内，
// `packages/**`、`apps/**` 一个字节都不因本探针而变。
// 官方 vitest.config.ts 与 stage-gate 全程不动。
//
// 本轮是纯 node 环境（真 HTTP + 真 fs），**不需要 happy-dom**，
// 所以不设 setupFiles —— 少一个依赖就少一个可能假绿的来源。
//
// 注意：本文件刻意不使用 block 注释（/* */）。该 .mts 由 esbuild 解析，
// block 注释会触发 Unexpected token。行注释不受影响。
export default defineConfig({
  root: 'G:/zcode-project/zcode-companion',
  test: {
    environment: 'node',
    include: [
      'G:/zcode-project/zcode-companion/review-artifacts/ra09-api-journal-audit-20261007/private/**/*.probe.test.mjs'
    ],
    passWithNoTests: false,
    testTimeout: 30000
  }
});