import { expect, test } from './fixtures';
import { newProject, writeText } from './helpers';

const ENDPOINT = 'playground/lib/playground_web/endpoint.ex';

test('quick open finds a file by a fuzzy match of its path and opens it', async ({ page }) => {
  await newProject(page, 'phoenix');
  const dialog = page.getByRole('dialog', { name: 'Open file' });
  const options = dialog.getByRole('option');

  // Also from a terminal, where the focus starts.
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
  await page.keyboard.press('ControlOrMeta+p');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox')).toBeFocused();
  // Without a query, the tree's files.
  await expect(options.filter({ hasText: 'mix.exs' }).first()).toBeVisible({ timeout: 60_000 });

  await page.keyboard.type('pwendp');
  await expect(options.first()).toHaveAttribute('title', ENDPOINT);
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.tab', { hasText: 'endpoint.ex' })).toBeVisible();

  // Open tabs come first; arrows move, Escape closes.
  await page.keyboard.press('ControlOrMeta+p');
  await expect(options.first()).toHaveAttribute('title', ENDPOINT);
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.type('zzqqxx');
  await expect(dialog.getByText('No matching files')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // A long name is cut, in the dialog's width: nothing scrolls sideways.
  const long = `${'very_long_module_name_'.repeat(8)}test.exs`;
  await writeText(page, `/work/playground/test/${long}`, '');
  await page.keyboard.press('ControlOrMeta+p');
  await page.keyboard.type('veryverytest');
  await expect(options.first()).toHaveAttribute('title', `playground/test/${long}`);
  const results = dialog.locator('.quick-open-results');
  expect(await results.evaluate((list) => list.scrollWidth - list.clientWidth)).toBeLessThanOrEqual(
    0,
  );
  expect(await dialog.evaluate((box) => box.scrollWidth - box.clientWidth)).toBeLessThanOrEqual(0);
  const name = options.first().locator('.quick-open-name');
  expect(await name.evaluate((span) => span.scrollWidth > span.clientWidth)).toBe(true);
});
