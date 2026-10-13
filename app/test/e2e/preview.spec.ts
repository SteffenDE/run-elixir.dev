import { expect, test } from './fixtures';
import { newProject, preview, reloadPreview, serverRunning } from './helpers';

test('the path bar navigates the preview, and a reload stays there', async ({ page }) => {
  await newProject(page, 'phoenix');
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 180_000 });
  // LiveDashboard fails on Rust-OTP for now (docs/status.md); this checks
  // where the preview goes (it redirects to /dev/dashboard/home).
  await page.locator('.preview-bar input').fill('/dev/dashboard');
  await page.locator('.preview-bar input').press('Enter');
  const at = () =>
    page.evaluate(
      () =>
        document.querySelector<HTMLIFrameElement>('.preview iframe')!.contentWindow!.location
          .pathname,
    );
  await expect.poll(at, { timeout: 60_000 }).toMatch(/^\/dev\/dashboard/);
  await page.waitForTimeout(2000);
  const where = await at();
  await reloadPreview(page);
  await page.waitForTimeout(3000);
  expect(await at()).toBe(where);
});

test('the preview pops out and docks again', async ({ page }) => {
  await newProject(page, 'phoenix');
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 180_000 });
  await page.getByRole('treeitem', { name: 'mix.exs', exact: true }).click();
  await expect(page.locator('.tab').first()).toBeVisible();
  const heights = await page.evaluate(() =>
    ['.tab-bar', '.preview-bar'].map(
      (s) => document.querySelector(s)!.getBoundingClientRect().height,
    ),
  );
  expect(heights[0]).toBe(heights[1]);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('.preview-bar button[title^="Pop out"]').click(),
  ]);
  await expect(popup.frameLocator('.preview iframe').getByText('Peace of mind')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('.preview')).toHaveCount(0);
  await page.getByRole('button', { name: 'Dock preview' }).click();
  await expect(page.locator('.preview iframe')).toBeVisible();
});

test('the preview comes back after the service worker restarts', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'stops the service worker through CDP');
  await newProject(page, 'phoenix');
  await serverRunning(page);
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 60_000 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.waitForTimeout(1000);
  await reloadPreview(page);
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 60_000 });
});
