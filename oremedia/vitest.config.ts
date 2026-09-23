import { defineConfig } from 'vitest/config';

const shared = {
  globals: false,
  environment: 'node' as const,
  passWithNoTests: true,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tooling/eslint-config/**/*.test.js'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/*.integration.test.ts',
            '**/*.cross-tenant.test.ts',
          ],
        },
      },
      {
        test: {
          ...shared,
          name: 'integration',
          include: ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          ...shared,
          name: 'cross-tenant',
          include: ['tooling/test-fixtures/**/*.cross-tenant.test.ts', 'apps/**/*.cross-tenant.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: { provider: 'v8', reporter: ['text', 'lcov'], reportsDirectory: 'coverage' },
  },
});
