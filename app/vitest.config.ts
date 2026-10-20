import { defineConfig } from 'vitest/config';

// Unit tests (test/unit), in Node: the parts that need no browser.
export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
