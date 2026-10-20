import { expect, test } from './fixtures';
import {
  newProject,
  output,
  preview,
  reachesPreview,
  readText,
  seesInPreview,
  serverRunning,
  writeText,
} from './helpers';

const APP_JS = '/work/playground/assets/js/app.js';
const BUNDLE = '/work/playground/priv/static/assets/js/app.js';

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
  await seesInPreview(page, 'Hello from the browser IDE!', 120_000);
  if (!reachesPreview(page)) return;
  const heading = preview(page).getByText('Hello from the browser IDE!');
  // Tailwind's watcher on the page builds the new class.
  await expect
    .poll(
      // The preview may reload meanwhile (the save's reload, then the CSS's).
      () => heading.evaluate((e) => getComputedStyle(e).fontSize).catch(() => ''),
      { timeout: 60_000 },
    )
    .toBe('36px');
});

test('a change to the app’s JavaScript is bundled by esbuild on the page', async ({ page }) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  await expect.poll(() => output(page), { timeout: 120_000 }).toContain('[watch] build finished');
  const app = await readText(page, APP_JS);
  await writeText(page, APP_JS, `${app}\nwindow.playgroundMarker = "bundled on the page"\n`);
  // The watcher rebuilds the bundle, and the preview reloads with it.
  await expect
    .poll(() => readText(page, BUNDLE), { timeout: 60_000 })
    .toContain('bundled on the page');
  if (!reachesPreview(page)) return;
  await expect
    .poll(
      () =>
        preview(page)
          .locator('body')
          .evaluate(() => (window as { playgroundMarker?: string }).playgroundMarker)
          .catch(() => undefined),
      { timeout: 60_000 },
    )
    .toBe('bundled on the page');
});
