import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // The library suite lives in tests/. audit/ is a separate workspace that
    // imports the built `standdown` package via `file:..`, so its tests run
    // from audit/ (see audit/README.md), not the root package's test run.
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: ['text'],
    },
  },
});
