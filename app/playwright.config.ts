import { defineConfig, devices } from '@playwright/test';

// The playground's browser tests, against a built site (runtime/build.py)
// that runtime/serve.py serves. Run them in Docker with
// playground/tests/run.sh, which mounts the repository at /repo.
const port = Number(process.env.PORT ?? 8081);

export default defineConfig({
  testDir: 'test/e2e',
  outputDir: process.env.OUTPUT_DIR ?? 'test-results',
  // Each Phoenix boot is a few seconds of a core; a test can hold two.
  workers: Number(process.env.WORKERS ?? 3),
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1400, height: 850 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Slow tests (minutes of compiling in WebAssembly) run with SLOW=1.
  grepInvert: process.env.SLOW ? undefined : /@slow/,
  webServer: {
    command: `python3 -I ../runtime/serve.py ${port}`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 850 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1400, height: 850 } } },
  ],
});
