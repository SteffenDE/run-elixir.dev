import { expect, test as base, type Page } from '@playwright/test';

// Every test fails on an uncaught error in the page, and at once when the
// page crashes: a poll of a crashed page would otherwise wait out its
// timeout (helpers.ts's output() reads it as empty).
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      // WebKit also reports a fetch() that CORS blocks as an uncaught error
      // (no stack), though the page catches its rejection (https.ts).
      if (`${error.name}:${error.message}`.includes('due to access control checks')) return;
      errors.push(error.stack || `${error.name}: ${error.message}`);
    });
    const start = Date.now();
    let crashed = false;
    page.on('crash', () => {
      crashed = true;
      testInfo.setTimeout(Date.now() - start + 1_000);
    });
    await use(page);
    expect(crashed, 'the page crashed').toBe(false);
    expect(errors, 'uncaught errors in the page').toEqual([]);
  },
});

export { expect };
