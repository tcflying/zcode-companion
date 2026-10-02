import { defineConfig } from 'vitest/config';

// Minimal vitest config for the I01 provider-free skeleton.
// - passWithNoTests is deliberately false: an empty test category must exit non-zero.
// - Only tests/unit and tests/contract are wired here; they must stay provider-free
//   (no official app-server, no model calls, no production services or databases).
// - integration/mutations/e2e categories are NOT wired; their npm gates are
//   NOT_IMPLEMENTED fail-closed via scripts/stage-gate.mjs.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.mjs', 'tests/contract/**/*.test.mjs'],
    passWithNoTests: false,
    testTimeout: 15000
  }
});
