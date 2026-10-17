import { expect, test } from './fixtures';
import {
  newProject,
  newShell,
  preview,
  prompted,
  reloadPreview,
  serverRunning,
  writeText,
} from './helpers';

test('the path bar navigates the preview, and a reload stays there', async ({ page }) => {
  await newProject(page, 'phoenix');
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 180_000 });
  // /dev/dashboard redirects to /dev/dashboard/home.
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

test("the server's HttpOnly Set-Cookie replaces or expires one the app's JavaScript set", async ({
  page,
}) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  // LiveView sets its reload status in document.cookie; Plug's
  // delete_resp_cookie expires it as HttpOnly, as a browser's jar takes it.
  const cookie = () => page.evaluate(() => document.cookie);
  await page.evaluate(
    () => (document.cookie = '__phoenix_reload_status__=401; max-age=60; path=/'),
  );
  expect(await cookie()).toContain('__phoenix_reload_status__=401');
  await page.evaluate(() =>
    window.playground.bridge.remember(
      '__phoenix_reload_status__=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; HttpOnly',
    ),
  );
  expect(await cookie()).not.toContain('__phoenix_reload_status__');
  // Set anew as HttpOnly, it is the bridge's alone.
  await page.evaluate(() => (document.cookie = 'kept=js; path=/'));
  await page.evaluate(() => window.playground.bridge.remember('kept=server; path=/; HttpOnly'));
  expect(await cookie()).not.toContain('kept=');
  expect(await page.evaluate(() => window.playground.bridge.cookieHeader())).toContain(
    'kept=server',
  );
});

test("the app's absolute links and the path bar go to its paths, in the preview", async ({
  page,
}) => {
  await newProject(page, 'phoenix');
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 180_000 });
  const frame = () => page.frames().find((f) => f.parentFrame() === page.mainFrame())!;
  const at = () =>
    page.evaluate(
      () =>
        document.querySelector<HTMLIFrameElement>('.preview iframe')!.contentWindow!.location
          .pathname,
    );
  const ide = page.url();

  // A link to http://localhost:4000/… (a magic link in a mail) goes to its path.
  await frame().evaluate(() => {
    const link = document.createElement('a');
    link.href = 'http://localhost:4000/dev/dashboard';
    link.id = 'absolute';
    link.textContent = 'absolute';
    document.body.prepend(link);
  });
  await preview(page).locator('#absolute').click();
  await expect.poll(at, { timeout: 60_000 }).toMatch(/^\/dev\/dashboard/);

  // In a frame of the app, _top is the preview, not the IDE (Swoosh's
  // mailbox opens a mail's links so).
  await page.locator('.preview-bar input').fill('/');
  await page.locator('.preview-bar input').press('Enter');
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 60_000 });
  await frame().evaluate(
    () =>
      new Promise<void>((resolve) => {
        const inner = document.createElement('iframe');
        inner.id = 'mail';
        inner.src = '/';
        inner.onload = () => {
          const link = inner.contentDocument!.createElement('a');
          link.href = 'http://localhost:4000/dev/dashboard';
          link.target = '_top';
          link.id = 'magic';
          link.textContent = 'magic';
          inner.contentDocument!.body.prepend(link);
          resolve();
        };
        document.body.prepend(inner);
      }),
  );
  await preview(page).frameLocator('#mail').locator('#magic').click();
  await expect.poll(at, { timeout: 60_000 }).toMatch(/^\/dev\/dashboard/);
  expect(page.url()).toBe(ide);

  // The app's URL pasted into the path bar is its path.
  await page.locator('.preview-bar input').fill('http://localhost:4000/');
  await page.locator('.preview-bar input').press('Enter');
  await expect.poll(at, { timeout: 60_000 }).toBe('/');
});

test("the path bar shows the app's port, and switches to another endpoint's", async ({ page }) => {
  await newProject(page, 'phoenix');
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 180_000 });
  const bar = page.locator('.preview-bar input');
  await expect(bar).toHaveValue('localhost:4000/');

  // A second endpoint on 4001 (as an umbrella's admin app), linking back.
  await writeText(
    page,
    '/work/second.exs',
    `{:ok, l} = :gen_tcp.listen(4001, [:binary, active: false, reuseaddr: true])
body = ~s(<p id="second">second endpoint</p><a id="back" href="http://localhost:4000/">back</a>)
serve = fn serve ->
  {:ok, s} = :gen_tcp.accept(l)
  {:ok, _} = :gen_tcp.recv(s, 0)
  :gen_tcp.send(s, "HTTP/1.1 200 OK\\r\\ncontent-type: text/html\\r\\ncontent-length: #{byte_size(body)}\\r\\nconnection: close\\r\\n\\r\\n" <> body)
  :gen_tcp.close(s)
  serve.(serve)
end
serve.(serve)
`,
  );
  const shell = await newShell(page);
  await page.evaluate(
    (id) => window.playground.sessions.get(id).node.input('elixir /work/second.exs\n'),
    shell,
  );
  await expect
    .poll(
      () => page.evaluate((id) => [...window.playground.sessions.get(id).node.serving], shell),
      {
        timeout: 60_000,
      },
    )
    .toContain(4001);

  await bar.fill('localhost:4001/admin');
  // Playwright's Firefox (Juggler) misses an iframe's navigation when the
  // XPConnect wrapper of the frame's docShell was collected since it last
  // looked at the frame (its navigation-started observer does not
  // QueryInterface the subject): resolving the frame just before refreshes
  // it. On the OTP site a few seconds without a look at the frame lose its
  // next navigation (Rust-OTP's kept it over 30 s).
  await expect(preview(page).locator('body')).toBeVisible();
  await bar.press('Enter');
  await expect(preview(page).locator('#second')).toHaveText('second endpoint', {
    timeout: 60_000,
  });
  await expect(bar).toHaveValue('localhost:4001/admin');
  // A path alone stays on that port.
  await bar.fill('/other');
  await bar.press('Enter');
  await expect(bar).toHaveValue('localhost:4001/other');
  await expect(preview(page).locator('#second')).toBeVisible();

  // Its link to the first endpoint switches back.
  await preview(page).locator('#back').click();
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 60_000 });
  await expect(bar).toHaveValue('localhost:4000/');
});
