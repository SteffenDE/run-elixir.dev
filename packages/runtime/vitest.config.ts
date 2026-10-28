import { defineConfig } from 'vitest/config';

// Unit tests (test/unit), in Node: the parts that need no browser.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
