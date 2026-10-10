import { defineConfig } from 'vitest/config';

// 私有配置（RA-09 跨进程重启承接轮专用，不入正式树）。
//
// 与既有 vitest.api.config.mts **刻意分开**：父审要求本轮不重跑旧的 40 条集成用例，
// 所以 include 只指向本轮跨进程探针，root 仍是仓库根（绝对路径 include）。
//
// 本轮要起真实子进程，环境是纯 node（真 HTTP + 真 fs + 真 spawn），不需要 happy-dom，
// 因此不设 setupFiles。
//
// 注意：本文件刻意不使用 block 注释（/* */）。该 .mts 由 esbuild 解析，
// block 注释会触发 Unexpected token。行注释不受影响。
export default defineConfig({
  root: 'G:/zcode-project/zcode-companion',
  test: {
    environment: 'node',
    include: [
      'G:/zcode-project/zcode-companion/review-artifacts/ra09-crossproc-restart-v96-audit-20261007/private/**/*.probe.test.mjs'
    ],
    passWithNoTests: false,
    testTimeout: 90000,
    hookTimeout: 30000
  }
});