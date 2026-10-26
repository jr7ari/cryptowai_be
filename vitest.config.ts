import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    pool: 'forks',
  },
});
