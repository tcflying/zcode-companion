import { defineConfig } from "vitest/config";
export default defineConfig({
  root: "G:/zcode-project/zcode-companion/apps/ui",
  resolve: {
    alias: [
      { find: /^.*[\\/]data[\\/]modelSource$/, replacement: "G:/zcode-project/zcode-companion/apps/ui/src/data/__mutant/modelSource.ts" }
    ]
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 20000,
    setupFiles: ["../../review-artifacts/zc51-dom-audit-20261007/private/dom-setup.ts"]
  }
});
