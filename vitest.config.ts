import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These suites are exhaustive rather than sampled — `analysis-bound`
    // enumerates a wide deck and legitimately costs over a minute of test time
    // on this hardware, and more when the machine is shared. The budget is a
    // wall-clock allowance, not a performance gate: `npm run bench` is the
    // performance gate, and it judges CPU cost against a recorded baseline.
    // Sized so a loaded laptop or a small CI runner does not turn slow-but-
    // correct work into a red build.
    testTimeout: 300_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/{api,core,conformance,modules}/**/*.ts'],
      exclude: ['src/**/index.ts'],
      thresholds: { statements: 80, branches: 75, functions: 90, lines: 82 },
    },
  },
});
