import { expect, test } from './fixtures';
import { newProject, preview, serverRunning } from './helpers';

test('an edit saved in the editor shows in the preview, with Tailwind', async ({ page }) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  for (const name of ['playground_web', 'controllers', 'page_html', 'home.html.heex']) {
    await page.getByRole('treeitem', { name, exact: true }).first().click();
    await page.waitForTimeout(300);
  }
  await expect(page.locator('.tab', { hasText: 'home.html.heex' })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.locator('.editor-scroll').click({ position: { x: 120, y: 12 } });
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('<h1 class="text-4xl font-bold">Hello from the browser IDE!</h1>\n');
  await expect(page.locator('.tab-close.dirty')).toHaveCount(1);
  await page.keyboard.press('Control+s');
  await expect(page.locator('.tab-close.dirty')).toHaveCount(0);
  const heading = preview(page).getByText('Hello from the browser IDE!');
  await expect(heading).toBeVisible({ timeout: 120_000 });
  // Tailwind's watcher on the page builds the new class.
  await expect
    .poll(() => heading.evaluate((e) => getComputedStyle(e).fontSize), { timeout: 60_000 })
    .toBe('36px');
});
