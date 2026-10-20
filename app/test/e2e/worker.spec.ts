import { expect, test } from './fixtures';
import { newProject, seesInPreview, serverRunning } from './helpers';

// A node's worker loads the modules a new path needs with a synchronous
// request for a bundle, which the service worker sees. Firefox answers the
// service worker's clients.get() for that worker on its thread, blocked in
// the request: once the service worker had stopped (idle 30 s) and asked,
// neither went on for minutes, and the whole node with them. The service
// worker no longer asks (sw.ts).
test('a new path is answered after the service worker idled @slow', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'firefox', 'only Firefox answers clients.get() on the client thread');
  await newProject(page, 'phoenix');
  await serverRunning(page);
  await seesInPreview(page, 'Peace of mind', 120_000);
  await page.waitForTimeout(45_000);
  const status = await page.evaluate(() =>
    Promise.race([
      window.playground.bridge
        .request({ method: 'GET', path: '/not-here', headers: [], body: null })
        .then((response: { status: number }) => response.status),
      new Promise((resolve) => setTimeout(() => resolve('no answer in 20 s'), 20_000)),
    ]),
  );
  expect(status).toBe(404);
});
