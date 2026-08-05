import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/stress/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    // Stress tests deliberately saturate the event loop; give them room but
    // never let a genuinely deadlocked test hang the suite forever.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each file gets its own worker: a test that pins the CPU must not distort
    // the latency numbers another file is measuring.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    reporters: process.env.CI ? ['default'] : ['default'],
    sequence: { concurrent: false },
  },
});
