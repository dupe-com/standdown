import { defineConfig } from 'vitest/config';

// The audit harness is its own workspace: it imports the built `standdown`
// package via `file:..` (not ../src), so its tests run from here rather than
// the root package's `tests/**` suite. Build the root lib first (`bun run
// build` at the repo root) so `standdown`/`standdown/*` resolve.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*.test.ts'],
  },
});
