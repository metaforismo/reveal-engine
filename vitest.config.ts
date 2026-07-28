import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/{api,core,protocol,serialization,conformance,compatibility,reference}/**/*.ts',
      ],
      exclude: ['src/**/index.ts'],
      thresholds: { statements: 80, branches: 75, functions: 90, lines: 82 },
    },
  },
});
