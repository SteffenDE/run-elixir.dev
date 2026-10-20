import { expect, test } from './fixtures';
import { prompted, run } from './helpers';

// The tab goes between the apex's pages in place (navigate.ts): the page
// is not loaded again, so what lives as long as it does (the Tailscale
// node's connection) stays, and one project's page gives way to another's
// as a load would have.
test('the tab goes between pages in place, and from one project to another', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => Object.assign(window, { stayed: true }));
  const stayed = () => page.evaluate(() => 'stayed' in window);
  const newEmpty = async () => {
    await page.getByRole('link', { name: 'Empty project' }).click();
    await page.waitForURL(/\/[a-z0-9]{10}\/$/);
    await prompted(page, 1);
    return page.url();
  };

  // The Tailscale page from the home page's button, and back.
  await page.locator('.tailscale-button').click();
  await expect(page).toHaveURL(/\/tailscale$/);
  await expect(page.getByRole('heading', { name: 'Tailscale' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('link', { name: 'Empty project' })).toBeVisible();

  // A project, a file of its own; home by the top bar; another project,
  // without it.
  const first = await newEmpty();
  await run(page, 'echo one > a.txt');
  await page.getByTitle('All projects').click();
  await expect(page.locator('.project-row')).toHaveCount(1);
  const second = await newEmpty();
  expect(second).not.toBe(first);
  expect(await run(page, 'ls')).not.toContain('a.txt');
  await expect(page.locator('.exec-frame')).toHaveCount(1);

  // Back twice: the first project again, its file kept.
  await page.goBack();
  await expect(page.locator('.project-row')).toHaveCount(2);
  await page.goBack();
  await expect(page).toHaveURL(first);
  await prompted(page, 1);
  expect(await run(page, 'cat a.txt')).toContain('one');
  await expect(page.locator('.exec-frame')).toHaveCount(1);

  expect(await stayed()).toBe(true);
});
