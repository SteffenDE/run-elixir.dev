import { expect, test } from './fixtures';
import {
  NO_FRAME_IN_FIREFOX,
  newProject,
  preview,
  previewFrame,
  reachesPreview,
  seesInPreview,
  serverRunning,
  syncLV,
  syncPreviewLV,
} from './helpers';

test('the preview reaches Phoenix over a WebSocket', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', NO_FRAME_IN_FIREFOX);
  await newProject(page, 'phoenix');
  await serverRunning(page);
  await seesInPreview(page, 'Peace of mind', 60_000);
  const frame = await previewFrame(page);
  // Phoenix's channel protocol (V2 JSON): a heartbeat gets its reply.
  const reply = await frame.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const socket = new WebSocket('/live/websocket?vsn=2.0.0');
        socket.onopen = () => socket.send(JSON.stringify([null, '1', 'phoenix', 'heartbeat', {}]));
        socket.onmessage = (event) => {
          resolve(String(event.data));
          socket.close();
        };
        socket.onerror = () => reject(new Error('websocket error'));
        setTimeout(() => reject(new Error('no reply')), 30_000);
      }),
  );
  expect(JSON.parse(reply)).toEqual([
    null,
    '1',
    'phoenix',
    'phx_reply',
    { status: 'ok', response: {} },
  ]);
});

test('LiveDashboard connects over the WebSocket', async ({ page }) => {
  await newProject(page, 'phoenix');
  await seesInPreview(page, 'Peace of mind', 180_000);
  await page.locator('.preview-bar input').fill('/dev/dashboard');
  await page.locator('.preview-bar input').press('Enter');
  await syncPreviewLV(page);
  // Its home page: the system information and limits.
  // The banner names the runtime: erts.
  await seesInPreview(page, /\[erts-[\d.]+\]/);
  await seesInPreview(page, 'System limits');
  await expect
    .poll(() => page.evaluate(() => /Transport: :websocket/.test(window.playground.output)))
    .toBe(true);
  if (!reachesPreview(page)) return;
  // A process's details (process_info with its monitors) open over the socket.
  await preview(page).getByRole('link', { name: 'Processes' }).click();
  await syncLV(preview(page));
  await preview(page).locator('tr[phx-click="show_info"]').first().click();
  await seesInPreview(page, 'Monitored by', 30_000);
});
