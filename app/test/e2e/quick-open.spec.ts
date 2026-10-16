import { expect, test } from './fixtures';
import { newProject } from './helpers';

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
});
