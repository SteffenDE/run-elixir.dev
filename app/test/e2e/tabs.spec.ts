import { expect, test } from './fixtures';
import { markHome, newProject, preview, reloadPreview, serverRunning } from './helpers';

test('projects run in parallel tabs, one tab per project', async ({
  context,
  page: a,
  browserName,
}) => {
  const b = await context.newPage();
  for (const [page, marker] of [
    [a, 'Project A'],
    [b, 'Project B'],
  ] as const) {
    await newProject(page, 'phoenix');
    await serverRunning(page);
    await markHome(page, marker);
    await reloadPreview(page);
  }
  await expect(preview(a).locator('#marker')).toHaveText('Project A', { timeout: 90_000 });
  await expect(preview(b).locator('#marker')).toHaveText('Project B', { timeout: 90_000 });

  if (browserName === 'chromium') {
    // The routes outlive the service worker.
    const cdp = await context.newCDPSession(a);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await a.waitForTimeout(1000);
    for (const [page, marker] of [
      [b, 'Project B'],
      [a, 'Project A'],
    ] as const) {
      await reloadPreview(page);
      await expect(preview(page).locator('#marker')).toHaveText(marker, { timeout: 90_000 });
    }
  }

  const c = await context.newPage();
  await c.goto(a.url());
  await expect(c.getByText('This project is open in another tab.')).toBeVisible();
  await c.getByRole('button', { name: 'Open it here' }).click();
  await serverRunning(c);
  await expect(a.getByText('it stopped here')).toBeVisible();
  await reloadPreview(c);
  await expect(preview(c).locator('#marker')).toHaveText('Project A', { timeout: 90_000 });
});
