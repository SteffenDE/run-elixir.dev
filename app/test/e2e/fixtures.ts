import { expect, test as base, type Page } from '@playwright/test';

// Every test fails on an uncaught error in the page.
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      // WebKit also reports a fetch() that CORS blocks as an uncaught error
      // (no stack), though the page catches its rejection (https.js).
      if (`${error.name}:${error.message}`.includes('due to access control checks')) return;
      errors.push(error.stack || `${error.name}: ${error.message}`);
    });
    await use(page);
    expect(errors, 'uncaught errors in the page').toEqual([]);
  },
});

export { expect };
