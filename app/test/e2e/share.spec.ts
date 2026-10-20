import { expect, test } from './fixtures';
import {
  APP,
  exists,
  HOME_HEEX,
  markHome,
  newProject,
  prompted,
  readText,
  seesInPreview,
  serverRunning,
  writeText,
} from './helpers';

// The project's link, from the Share button.
async function share(page: import('@playwright/test').Page): Promise<string> {
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByRole('button', { name: /^Link/ }).click();
  const url = page.getByLabel('Link to this project');
  await expect(url).toHaveValue(/\/import#/);
  return url.inputValue();
}

test('an empty project travels as a link, text and bytes', async ({ page, browser }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await page.evaluate(() => window.playground.files.mkdir('/work/demo'));
  await writeText(page, '/work/demo/hello.exs', 'IO.puts("hello from a link")\n');
  await page.evaluate(() =>
    window.playground.files.write('/work/logo.bin', new Uint8Array([0, 255, 1, 128])),
  );
  const link = await share(page);
  await expect(page.locator('.share-summary')).toContainText('2 files');

  // Elsewhere: a browser that has never seen the project.
  const other = await (await browser.newContext()).newPage();
  await other.goto(link);
  await expect(other.locator('.import-files')).toContainText('demo/hello.exs');
  await other.getByRole('button', { name: 'Open as a new project' }).click();
  await other.waitForURL(/\/[a-z0-9]{10}\/$/);
  await prompted(other, 1);
  expect(await readText(other, '/work/demo/hello.exs')).toBe('IO.puts("hello from a link")\n');
  const bytes = await other.evaluate(() =>
    window.playground.files.read('/work/logo.bin').then((b: Uint8Array) => [...b]),
  );
  expect(bytes).toEqual([0, 255, 1, 128]);
  await other.context().close();
});

test('a Phoenix project travels as its changes over the template', async ({ page, browser }) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  await markHome(page, 'Shared by link');
  await page.evaluate((p) => window.playground.files.remove(p), `${APP}/README.md`);
  const link = await share(page);
  await expect(page.locator('.share-summary')).toContainText('1 file, 1 removed');
  // The changes, not the builds or dependencies.
  expect(link.length).toBeLessThan(20_000);

  const other = await (await browser.newContext()).newPage();
  await other.goto(link);
  await other.getByRole('button', { name: 'Open as a new project' }).click();
  await serverRunning(other);
  expect(await readText(other, HOME_HEEX)).toMatch(/^<h1 id="marker">Shared by link/);
  expect(await exists(other, `${APP}/README.md`)).toBe(false);
  await seesInPreview(other, 'Shared by link', 90_000);
  await other.context().close();
});

test('a damaged link says so', async ({ page }) => {
  await page.goto('/import#not-a-project');
  await expect(page.getByText('This link is damaged.')).toBeVisible();
});
