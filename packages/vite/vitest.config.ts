import { defineConfig } from 'vitest/config';

// The plugin against a fixture site with packages laid out as installed.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
