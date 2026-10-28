import { defineConfig } from 'vitest/config';

// Unit tests (test/), in Node: the preparer's parts that need no browser.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
