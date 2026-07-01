import { defineConfig } from 'vitest/config';

// Postgres integration tests (`*.itest.ts`) need a reachable DATABASE_URL and
// migrations already applied. They self-skip when the DB is unavailable
// locally; in CI a must-not-skip assertion forces them to run for real. Kept
// out of the default unit run and run sequentially against one database.
export default defineConfig({
  test: {
    include: ['src/**/*.itest.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
