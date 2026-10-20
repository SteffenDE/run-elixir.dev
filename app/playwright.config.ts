import { defineConfig, devices } from '@playwright/test';

// The playground's browser tests, against a built site (runtime/build.py)
// that runtime/serve.py serves. Run them in Docker with
// tests/run.sh, which mounts the repository at /repo.
const port = Number(process.env.PORT || 8081);
const domains = (on: number) =>
  `--domain playground.localhost:${on} --usercontent usercontent.localhost:${on}`;
const DEVICES: Record<string, string> = {
  chromium: 'Desktop Chrome',
  firefox: 'Desktop Firefox',
  webkit: 'Desktop Safari',
};

export default defineConfig({
  testDir: 'test/e2e',
  outputDir: process.env.OUTPUT_DIR ?? 'test-results',
  // Each Phoenix boot is a few seconds of a core; a test can hold two.
  workers: Number(process.env.WORKERS || 3),
  timeout: 300_000,
  expect: { timeout: 30_000 },
  // A line per test as it starts and fails, and every test's duration in
  // results.json (tests/durations.py) to keep the timeouts honest.
  reporter: [
    ['line'],
    ['json', { outputFile: `${process.env.OUTPUT_DIR ?? 'test-results'}/results.json` }],
  ],
  use: {
    baseURL: `http://playground.localhost:${port}`,
    viewport: { width: 1400, height: 850 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Slow tests (minutes of compiling in WebAssembly) run with SLOW=1.
  grepInvert: process.env.SLOW ? undefined : /@slow/,
  // The site's two domains (docs/frames.md): the apex, and the usercontent
  // domain, another site, on the same port (browsers resolve *.localhost
  // to this machine).
  webServer: [
    {
      command: `python3 -I ../runtime/serve.py ${port} ${domains(port)}`,
      url: `http://localhost:${port}/`,
      reuseExistingServer: true,
      stderr: 'ignore',
    },
    // The same site with the backend at localhost:4000 (live sessions'
    // relay; `mix phx.server` in backend/).
    {
      command: `python3 -I ../runtime/serve.py ${port + 2} ${domains(port + 2)} --api http://localhost:4000`,
      url: `http://localhost:${port + 2}/`,
      reuseExistingServer: true,
      stderr: 'ignore',
    },
  ],
  projects: ['chromium', 'firefox', 'webkit'].map((name) => ({
    name,
    use: { ...devices[DEVICES[name]], viewport: { width: 1400, height: 850 } },
  })),
});
