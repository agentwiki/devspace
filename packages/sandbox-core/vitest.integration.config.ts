import { defineConfig } from 'vitest/config';

// Integration tests drive a real Docker daemon + `devcontainer` CLI, so they
// live in *.itest.ts (kept out of the default unit run) and need long timeouts
// for image pulls + `devcontainer up`. They run one file, sequentially.
export default defineConfig({
  test: {
    include: ['src/**/*.itest.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
