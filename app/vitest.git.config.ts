// git's own tests against git.wasm (test/git/: GIT_T names the scripts):
// slow, so not in the unit tests' run. `npx vitest run -c vitest.git.config.ts`.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['test/git/**/*.test.ts'],
    environment: 'node',
    testTimeout: 3_600_000,
  },
});
