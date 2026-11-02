// An http page (the test embedder, as Tidewave's dev server on
// http://localhost:9000) on an https shared usercontent domain (serve.py
// --https-bridge bridge.localhost:PORT+3, self-signed): create() names its
// frames' origins https, not by the page's scheme (site.ts domainScheme),
// and the frames take the http page as their parent.
import { expect, test } from './fixtures';
import { embedded, previewText, run } from './embedder';
import { PORT } from './helpers';

const HTTPS_BRIDGE = `bridge.localhost:${PORT + 3}`;

// serve.py's certificate is self-signed. Chromium registers no service
// worker over it without the flag, whatever the context ignores.
test.use({
  ignoreHTTPSErrors: true,
  launchOptions: async ({ browserName }, use) =>
    use(browserName === 'chromium' ? { args: ['--ignore-certificate-errors'] } : {}),
});

test('an http page frames its https origins and their previews', async ({ page }) => {
  // The page's scheme is not the frames': create() names them https.
  await embedded(
    page,
    { template: 'empty' },
    { bridged: true, usercontent: `https://${HTTPS_BRIDGE}` },
  );
  const host = HTTPS_BRIDGE.replace(/\./g, '\\.');
  const frame = await page.evaluate(() =>
    document.querySelector('#frames iframe')?.getAttribute('src'),
  );
  expect(frame).toMatch(new RegExp(`^https://e-[a-z0-9]{10}\\.${host}/bridge\\.html$`));
  expect(await run(page, 'echo $((6 * 7))')).toEqual({ stdout: '42\n', stderr: '', code: 0 });

  // A server on 4000, and its preview through an https relay, which
  // takes the http page as its parent.
  await page.evaluate(() => {
    const server = window.sandbox.sh(
      `elixir -e '{:ok, l} = :gen_tcp.listen(4000, [:binary, active: false, reuseaddr: true]); IO.puts("beam up"); serve = fn serve -> {:ok, s} = :gen_tcp.accept(l); {:ok, _} = :gen_tcp.recv(s, 0); :gen_tcp.send(s, "HTTP/1.1 200 OK\\r\\ncontent-type: text/html\\r\\ncontent-length: 24\\r\\nconnection: close\\r\\n\\r\\n<p>from beam, over https"); :gen_tcp.close(s); serve.(serve) end; serve.(serve)'`,
    );
    window.embed.server = '';
    server.onStdout(
      (bytes: Uint8Array) => (window.embed.server += new TextDecoder().decode(bytes)),
    );
  });
  await page.waitForFunction(() => /beam up/.test(window.embed.server), null, {
    timeout: 120_000,
  });
  const url = await page.evaluate(() => window.sandbox.previewUrl(4000));
  expect(url).toMatch(new RegExp(`^https://v-[a-z0-9]{10}-4000\\.${host}/$`));
  await page.evaluate((at) => {
    const preview = document.createElement('iframe');
    preview.src = at;
    preview.id = 'preview';
    document.body.append(preview);
  }, url);
  await expect
    .poll(() => previewText(page), { timeout: 60_000 })
    .toContain('from beam, over https');
  await page.evaluate(() => window.sandbox.shutdown());
});
