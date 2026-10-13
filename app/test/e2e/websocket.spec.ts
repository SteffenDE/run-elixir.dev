import { expect, test } from './fixtures';
import { newProject, preview, serverRunning } from './helpers';

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
