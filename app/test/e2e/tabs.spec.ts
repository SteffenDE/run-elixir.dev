import { expect, test } from './fixtures';
import { markHome, newProject, reloadPreview, seesInPreview, serverRunning } from './helpers';

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
  await seesInPreview(a, 'Project A', 90_000);
  await seesInPreview(b, 'Project B', 90_000);

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
      await seesInPreview(page, marker, 90_000);
    }
  }

  const c = await context.newPage();
  await c.goto(a.url());
  await expect(c.getByText('This project is open in another tab.')).toBeVisible();
  await c.getByRole('button', { name: 'Open it here' }).click();
  await serverRunning(c);
  await expect(
    a.getByText('This project stopped here because it was opened in another tab.'),
  ).toBeVisible();
  await reloadPreview(c);
  await seesInPreview(c, 'Project A', 90_000);
});
