import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The programs are tested as they are shipped: built once, before any test.
    globalSetup: ['test/build.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
