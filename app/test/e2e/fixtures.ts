import { expect, test as base, type Page, type TestInfo } from '@playwright/test';
import { webProcessThreads } from './threads';

// What a failed test's page was doing: the runtime's debug dump (each
// node's programs, its last messages from its worker; exec/host.ts debug)
// and the console's last lines, attached and printed, so that a hang in
// CI says where it stopped.
async function report(page: Page, testInfo: TestInfo, console: string[]): Promise<void> {
  const debug = await Promise.race([
    page
      .evaluate(() => {
        // The IDE's hooks (project/lib/playground.ts), or the embedder's sandbox.
        const hooks = window as unknown as {
          playground?: { debug?: () => Promise<unknown> };
          sandbox?: { exec?: { call(name: string): Promise<unknown> } };
        };
        const asked = hooks.playground?.debug?.() ?? hooks.sandbox?.exec?.call('debug');
        // As JSON (it may hold what does not clone), without the reads'
        // timings.
        return Promise.resolve(asked ?? null).then((dump) =>
          JSON.stringify(dump, (key, value) => (key === 'millis' ? undefined : value)),
        );
      })
      .then((json) => JSON.parse(json))
      .catch((error: Error) => `debug failed: ${error.message}`),
    new Promise((resolve) => setTimeout(() => resolve('debug did not answer in 5 s'), 5000)),
  ]);
  const threads = await webProcessThreads().catch((error: Error) => error.message);
  const body = JSON.stringify({ debug, threads, console: console.slice(-50) }, null, 2);
  await testInfo.attach('runtime-debug.json', { body, contentType: 'application/json' });
  process.stdout.write(`\n--- ${testInfo.title}: runtime debug\n${body.slice(0, 16000)}\n`);
}

// Every test fails on an uncaught error in the page, and at once when the
// page crashes: a poll of a crashed page would otherwise wait out its
// timeout (helpers.ts's output() reads it as empty).
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      // WebKit also reports a fetch() that CORS blocks as an uncaught error
      // (no stack), though the page catches its rejection (https.ts). Only
      // fetch()'s: a script or worker that fails its access control
      // ("Cannot load … due to access control checks") fails the test.
      if (/^Fetch API cannot load .* due to access control checks\.?$/.test(error.message)) return;
      errors.push(error.stack || `${error.name}: ${error.message}`);
    });
    const start = Date.now();
    let crashed = false;
    page.on('crash', () => {
      crashed = true;
      testInfo.setTimeout(Date.now() - start + 1_000);
    });
    // The page's and its frames' console, kept for a failure's report.
    const console: string[] = [];
    page.on('console', (message) => {
      // A worker the runtime gave up loading (host/worker.ts), which no
      // page error reports: it fails in the exec frame's worker.
      if (message.type() === 'error' && message.text().includes('the worker did not load after'))
        errors.push(message.text());
      console.push(`${message.type()}: ${message.text()}`.slice(0, 500));
      if (console.length > 200) console.shift();
    });
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus && !crashed)
      await report(page, testInfo, console);
    expect(crashed, 'the page crashed').toBe(false);
    expect(errors, 'uncaught errors in the page').toEqual([]);
  },
});

export { expect };
