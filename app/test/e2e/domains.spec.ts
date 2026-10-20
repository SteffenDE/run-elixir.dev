import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import {
  APEX,
  PORT,
  previewAt,
  prompted,
  readText,
  run,
  seesInPreview,
  syncPreviewLV,
  writeText,
} from './helpers';

// Every page is the apex's (playground.localhost); what a project's code
// runs is the usercontent domain's, another site (usercontent.localhost):
// src/shared/lib/site.ts, docs/frames.md. Two labels each: Chromium takes
// localhost for a top-level domain, so the apex's own name is a site.
const PROJECT = new RegExp(`^${APEX}/([a-z0-9]{10})/$`);

// Written through the page, and kept now (not a second later).
async function keep(page: Page, path: string, text: string) {
  await writeText(page, path, text);
  await page.evaluate(() => window.playground.files.flush());
}

test('a Phoenix project’s page is the apex’s, its preview a usercontent origin’s', async ({
  page,
}) => {
  await page.goto(`${APEX}/phoenix`);
  await page.waitForURL(PROJECT);
  const id = PROJECT.exec(page.url())![1];
  await seesInPreview(page, 'Peace of mind', 180_000);
  expect(await page.locator('.preview iframe').getAttribute('src')).toMatch(
    new RegExp(`^${previewAt(id, 4000).replace(/[.]/g, '\\.')}/`),
  );
  // /dev/dashboard redirects to /dev/dashboard/home on the port's origin.
  await page.locator('.preview-bar input').fill('/dev/dashboard');
  await page.locator('.preview-bar input').press('Enter');
  await syncPreviewLV(page);
  await seesInPreview(page, 'System limits');
  await expect
    .poll(() => page.evaluate(() => /Transport: :websocket/.test(window.playground.output)))
    .toBe(true);
});

test('the apex lists, renames and deletes a project', async ({ page, context }) => {
  await page.goto(`${APEX}/empty`);
  await page.waitForURL(PROJECT);
  const id = PROJECT.exec(page.url())![1];
  await prompted(page, 1);
  await keep(page, '/work/note.txt', 'kept\n');
  expect(await run(page, 'cat note.txt')).toContain('kept');

  // Renamed on its page: the list has the name, and shows it open.
  await page.getByTitle('Rename').click();
  const input = page.getByLabel('Project name');
  await input.fill('Domain Test');
  await input.press('Enter');
  const home = await context.newPage();
  await home.goto(`${APEX}/`);
  const row = home.locator('.project-row', { hasText: 'Domain Test' });
  await expect(row).toBeVisible();
  await expect(row.getByText('open in a tab')).toBeVisible();
  await expect(row.locator('.project-link')).toHaveAttribute('href', `${APEX}/${id}/`);

  // Open, it is not deleted; closed, it is, files and all.
  const remove = async () => {
    await row.getByRole('button', { name: /^Delete Domain Test/ }).click();
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
  };
  await remove();
  await expect(row.getByText('open in another tab')).toBeVisible();
  await page.close();
  await remove();
  await expect(row).toHaveCount(0);
  const left = await home.evaluate(async () =>
    (await indexedDB.databases()).map((database) => database.name),
  );
  expect(left.filter((name) => name?.includes(id))).toEqual([]);
  await home.goto(`${APEX}/${id}/`);
  await expect(home.getByText('There is no such project in this browser')).toBeVisible();
});

test('a share link opens as a new project on the apex', async ({ page, browser }) => {
  await page.goto(`${APEX}/empty`);
  await page.waitForURL(PROJECT);
  const id = PROJECT.exec(page.url())![1];
  await prompted(page, 1);
  await keep(page, '/work/hello.txt', 'shared\n');
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByRole('button', { name: /^Link/ }).click();
  const field = page.getByLabel('Link to this project');
  await expect(field).toHaveValue(new RegExp(`^${APEX}/import#`));
  const link = await field.inputValue();
  const other = await (await browser.newContext()).newPage();
  await other.goto(link);
  await other.getByRole('button', { name: 'Open as a new project' }).click();
  await other.waitForURL(PROJECT);
  expect(PROJECT.exec(other.url())![1]).not.toBe(id);
  await prompted(other, 1);
  expect(await readText(other, '/work/hello.txt')).toBe('shared\n');
  await other.context().close();
});

test('the former addresses go to the apex’s; other names are not found', async ({ page }) => {
  // A project's former origin, and a guest's: the apex's address.
  await page.goto(`http://p-zzzzzzzzzz.playground.localhost:${PORT}/`);
  await page.waitForURL(`${APEX}/zzzzzzzzzz/`);
  await expect(page.getByText('There is no such project in this browser')).toBeVisible();
  const session = 'AAAAAAAAAAAAAAAAAAAAAA';
  await page.goto(
    `http://l-${session.toLowerCase()}.playground.localhost:${PORT}/live/${session}#x`,
  );
  await page.waitForURL(`${APEX}/live/${session}#x`);
  // Any other name, under either domain.
  for (const host of [
    `random-foo.playground.localhost:${PORT}`,
    `phoenix.playground.localhost:${PORT}`,
    `e-zzzzzzzzzz.usercontent.localhost:${PORT}`,
    `v-zzzzzzzzzz-4000.usercontent.localhost:${PORT}`,
  ]) {
    await page.goto(`http://${host}/`);
    await expect(page.getByText('There is nothing at this address')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to your projects' })).toHaveAttribute(
      'href',
      `${APEX}/`,
    );
  }
});
