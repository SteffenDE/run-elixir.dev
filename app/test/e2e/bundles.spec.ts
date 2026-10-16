import { expect, test } from './fixtures';
import { output } from './helpers';

// The node's files come lazily, in bundles (fs/bundles/N.tar). A bundle
// whose download fails is tried again, not taken for loaded.
test('bundles that fail to download at first still load', async ({
  page,
  context,
  browserName,
}) => {
  // Playwright's WebKit routes none of a worker's own requests.
  test.skip(browserName === 'webkit', "WebKit's routing does not see the node's downloads");
  const tries = new Map<string, number>();
  await context.route('**/fs/bundles/*.tar', (route) => {
    const url = route.request().url();
    const count = (tries.get(url) ?? 0) + 1;
    tries.set(url, count);
    return count <= 2 ? route.abort('failed') : route.continue();
  });
  await page.goto('/iex');
  await expect.poll(() => output(page), { timeout: 120_000 }).toContain('iex(1)>');
  await page.locator('.terminal-host:not([hidden])').click();
  await page.keyboard.type('Enum.sum([1, 2, 3]) + String.length("abc")\n');
  await expect.poll(() => output(page), { timeout: 60_000 }).toContain('9');
  expect([...tries.values()].some((count) => count > 2)).toBe(true);
});
