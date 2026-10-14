import { expect, test } from './fixtures';
import { newProject, preview, serverRunning, syncLV } from './helpers';

test('the preview reaches Phoenix over a WebSocket', async ({ page }) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 60_000 });
  const frame = page.frames().find((f) => f.parentFrame() === page.mainFrame())!;
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

test('LiveDashboard connects over the WebSocket', async ({ page, browserName }) => {
  // Firefox encodes its first render (25 kB of JSON) past LiveView's 10 s
  // join timeout (docs/status.md, Rust-OTP's binary clause dispatch).
  test.skip(browserName !== 'chromium', 'too slow to join in Firefox');
  await newProject(page, 'phoenix');
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 180_000 });
  await page.locator('.preview-bar input').fill('/dev/dashboard');
  await page.locator('.preview-bar input').press('Enter');
  await syncLV(preview(page));
  // Its home page: the system information and limits.
  await expect(preview(page).getByText('[rust-otp]')).toBeVisible();
  await expect(preview(page).getByText('System limits')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => /Transport: :websocket/.test(window.playground.output)))
    .toBe(true);
  // A process's details (process_info with its monitors) open over the socket.
  await preview(page).getByRole('link', { name: 'Processes' }).click();
  await syncLV(preview(page));
  await preview(page).locator('tr[phx-click="show_info"]').first().click();
  await expect(preview(page).getByText('Monitored by')).toBeVisible({ timeout: 30_000 });
});
