import { defineConfig } from 'vitest/config';

// Unit tests (test/), in Node: Node.js's modules and the npm client.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
