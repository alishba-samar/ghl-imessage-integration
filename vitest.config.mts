import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    setupFiles: ['test/setup.ts'],
    // All test files share one test database and truncate it between tests, so run files one at a time.
    fileParallelism: false,
    // The test database is remote (Neon, ~250ms per round trip from dev machines), so allow for latency.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Retry for transient network drops to the remote test DB ("Connection terminated unexpectedly").
    // A real bug fails every attempt; retried tests are listed in verbose output.
    retry: 2,
  },
});
