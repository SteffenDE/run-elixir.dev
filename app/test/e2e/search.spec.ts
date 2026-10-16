import { expect, test } from './fixtures';
import { newProject, readText, writeText } from './helpers';

const NEEDLES = '/work/playground/lib/needles.ex';

test('the search finds text in the files and opens a hit at its line', async ({ page }) => {
  await newProject(page, 'phoenix');
  await expect.poll(() => page.evaluate(() => !!window.playground?.files)).toBe(true);
  const lines = Array.from({ length: 200 }, (_, index) => `# line ${index + 1}`);
  lines[149] = '# A needle, and a NEEDLE.';
  await writeText(page, NEEDLES, `${lines.join('\n')}\n`);

  // From a terminal, where the focus starts.
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
  await page.keyboard.press('ControlOrMeta+Shift+f');
  await expect(page.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
  const field = page.getByRole('textbox', { name: 'Search the files' });
  await expect(field).toBeFocused();
  const summary = page.locator('.search-summary');

  await page.keyboard.type('needle');
  await expect(summary).toHaveText('2 results in 1 file', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Match case' }).click();
  await expect(summary).toHaveText('1 result in 1 file');
  await page.getByRole('button', { name: 'Regular expression' }).click();
  await field.fill('N[E]+DLE');
  await expect(summary).toHaveText('1 result in 1 file');
  await field.fill('(');
  // Each browser says why in its own words.
  await expect(summary).toHaveClass(/search-error/);
  // Dependencies and builds are not searched.
  await page.getByRole('button', { name: 'Regular expression' }).click();
  await field.fill('defmodule Phoenix.Endpoint do');
  await expect(summary).toHaveText('No results');

  await field.fill('NEEDLE');
  await expect(summary).toHaveText('1 result in 1 file');
  const hit = page.locator('.search-hit');
  await expect(hit).toHaveAttribute('title', 'playground/lib/needles.ex:150:19');
  await expect(hit.locator('mark')).toHaveText('NEEDLE');
  await hit.click();
  await expect(page.locator('.tab', { hasText: 'needles.ex' })).toBeVisible();
  // The caret is on the hit's line.
  await page.waitForTimeout(300);
  await page.keyboard.type('X');
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(async () => (await readText(page, NEEDLES)).split('\n')[149])
    .toBe('X# A needle, and a NEEDLE.');

  // The tree is the other tab, as it was.
  await page.getByRole('tab', { name: 'Files' }).click();
  await expect(page.getByRole('treeitem', { name: 'mix.exs' })).toBeVisible();
});
