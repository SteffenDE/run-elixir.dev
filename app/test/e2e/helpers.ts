// What the tests do to a playground page, mostly through
// window.playground (src/project/lib/playground.ts).
import {
  expect,
  type BrowserContext,
  type Frame,
  type FrameLocator,
  type Page,
} from '@playwright/test';

export const APP = '/work/playground';

// The site's two domains (serve.py --domain and --usercontent, the
// config's webServer): the apex has every page, the usercontent domain
// what a project's code runs (docs/frames.md).
export const PORT = Number(process.env.PORT || 8081);
export const APEX = `http://playground.localhost:${PORT}`;
export const USERCONTENT = `usercontent.localhost:${PORT}`;
// Where project `id`'s preview shows `port`.
export const previewAt = (id: string, port: number) => `http://v-${id}-${port}.${USERCONTENT}`;
export const HOME_HEEX = `${APP}/lib/playground_web/controllers/page_html/home.html.heex`;

// oxlint-disable-next-line no-control-regex -- terminal colours.

declare global {
  interface Window {
    // oxlint-disable-next-line typescript/no-explicit-any -- the page's test hook.
    playground: any;
  }
}

// A new project of `kind` from its shortcut (/phoenix, /empty); its id.
export async function newProject(page: Page, kind: 'phoenix' | 'empty'): Promise<string> {
  await page.goto(`/${kind}`);
  await page.waitForURL(/\/[a-z0-9]{10}\/$/);
  return new URL(page.url()).pathname.slice(1, -1);
}

export async function serverRunning(page: Page): Promise<void> {
  await page.waitForFunction(
    () => /Running PlaygroundWeb.Endpoint/.test(window.playground?.output ?? ''),
    null,
    { timeout: 240_000 },
  );
}

// A shell's output as its screen shows it (the first shell's by default):
// its lines, scrollback and all, a wrapped one joined, without trailing
// blanks but up to the cursor (a prompt's last space).
export function output(page: Page, session = 1): Promise<string> {
  return (
    page
      .evaluate((id) => {
        const screen = window.playground?.sessions.get(id)?.screen;
        if (!screen) return '';
        const buffer = screen.buffer.active;
        const cursor = buffer.baseY + buffer.cursorY;
        let text = '';
        for (let row = 0; row <= cursor; row++) {
          const line = buffer.getLine(row);
          if (!line) continue;
          let part = line.translateToString(true);
          if (row === cursor) {
            const upTo = line.translateToString(false, 0, buffer.cursorX);
            if (upTo.length > part.length) part = upTo;
          }
          text += (row && !line.isWrapped ? '\n' : '') + part;
        }
        return text;
      }, session)
      // Navigating: nothing yet.
      .catch(() => '')
  );
}

// A prompt: the directory (~ for home), then $.
export const prompts = (text: string) => (text.match(/(?:~|\/)\S* \$ /g) ?? []).length;

// Until shell `session` has shown `count` prompts.
export async function prompted(page: Page, count: number, session = 1): Promise<void> {
  await expect
    .poll(async () => prompts(await output(page, session)), { timeout: 240_000 })
    .toBeGreaterThanOrEqual(count);
}

// Run a command line in a shell and wait for its next prompt; its output.
export async function run(page: Page, line: string, session = 1): Promise<string> {
  const before = await output(page, session);
  await page.evaluate(([id, text]) => window.playground.sessions.get(id).node.input(`${text}\n`), [
    session,
    line,
  ] as const);
  await prompted(page, prompts(before) + 1, session);
  return (await output(page, session)).slice(before.length);
}

// A new shell tab, ready; its session id.
export async function newShell(page: Page): Promise<number> {
  await page.locator('button[title="New shell"]').click();
  const id = await page.evaluate(() => Math.max(...window.playground.sessions.keys()));
  await prompted(page, 1, id);
  return id;
}

export const exists = (page: Page, path: string) =>
  page.evaluate(
    (p) => window.playground.files.stat(p).then((kind: string | null) => kind !== null),
    path,
  );

export const readText = (page: Page, path: string) =>
  page.evaluate(
    (p) => window.playground.files.read(p).then((b: Uint8Array) => new TextDecoder().decode(b)),
    path,
  );

export const writeText = (page: Page, path: string, text: string) =>
  page.evaluate(([p, t]) => window.playground.files.write(p, t), [path, text] as const);

// Put `marker` as a heading with id "marker" at the top of the app's home
// page.
export async function markHome(page: Page, marker: string): Promise<void> {
  const text = await readText(page, HOME_HEEX);
  await writeText(page, HOME_HEEX, `<h1 id="marker">${marker}</h1>\n${text}`);
}

export const preview = (page: Page) => page.frameLocator('.preview iframe');

// The preview's frame (not the hidden relay frames beside it).
export async function previewFrame(page: Page): Promise<Frame> {
  const frame = await (await page.locator('.preview iframe').elementHandle())?.contentFrame();
  if (!frame) throw new Error('no preview frame');
  return frame;
}

// Playwright reaches no frame of another site in Firefox (the preview is
// the usercontent domain's): there, what the preview shows comes from its
// page's own report to the IDE (window.playground.previewSnapshot).
export const reachesPreview = (page: Page) =>
  page.context().browser()?.browserType().name() !== 'firefox';
export const NO_FRAME_IN_FIREFOX = 'Playwright reaches no frame of another site in Firefox';

export const previewText = (page: Page) =>
  page
    .evaluate(() =>
      window.playground?.previewSnapshot?.().then((s: { text: string } | null) => s?.text ?? ''),
    )
    .catch(() => '');

// The preview shows `text` (visible, where Playwright reaches the frame).
export async function seesInPreview(
  page: Page,
  text: string | RegExp,
  timeout = 30_000,
): Promise<void> {
  if (reachesPreview(page)) {
    await expect(preview(page).getByText(text).first()).toBeVisible({ timeout });
    return;
  }
  const pattern =
    typeof text === 'string' ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : text;
  await expect.poll(() => previewText(page), { timeout }).toMatch(pattern);
}

// The preview's LiveView connected (not seen in Firefox: reachesPreview).
export async function syncPreviewLV(page: Page): Promise<void> {
  if (reachesPreview(page)) await syncLV(preview(page));
}

// The path the preview's frame shows (another origin's: read through
// Playwright, not the page).
export async function previewPath(page: Page): Promise<string> {
  if (!reachesPreview(page)) {
    // The path bar follows the frame (its page tells the IDE where it is).
    const shown = await page.locator('.preview-bar input').inputValue();
    return shown.replace(/^localhost:\d+/, '') || '/';
  }
  const frame = await (await page.locator('.preview iframe').elementHandle())?.contentFrame();
  return frame ? new URL(frame.url()).pathname : '';
}

export const reloadPreview = (page: Page) =>
  page.locator('.preview-bar button[title=Reload]').click();

// Click where the visible terminal shows `text`.
export async function clickTerminalText(page: Page, text: string): Promise<void> {
  const point = await page.evaluate((t) => {
    for (const row of document.querySelectorAll('.terminal-host:not([hidden]) .xterm-rows > div')) {
      let at = row.textContent?.indexOf(t) ?? -1;
      if (at < 0) continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        if (at < node.length) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, Math.min(node.length, at + 3));
          const box = range.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        }
        at -= node.length;
      }
    }
    return null;
  }, text);
  expect(point, `${text} on screen`).not.toBeNull();
  await page.mouse.move(point!.x, point!.y);
  await page.waitForTimeout(400);
  await page.mouse.click(point!.x, point!.y);
}

// Until a LiveView (in `scope`: a page or the preview's frame) is connected
// and has no event pending; before and after clicks and submits.
export async function syncLV(scope: Page | FrameLocator): Promise<void> {
  await Promise.all([
    expect(scope.locator('.phx-connected').first()).toBeVisible({ timeout: 120_000 }),
    expect(scope.locator('.phx-change-loading')).toHaveCount(0),
    expect(scope.locator('.phx-click-loading')).toHaveCount(0),
    expect(scope.locator('.phx-submit-loading')).toHaveCount(0),
  ]);
}

// Sign this browser's device in to the Headscale (HEADSCALE_URL,
// HEADSCALE_API_KEY, HEADSCALE_USER: tests/headscale.sh) on `apex`'s Tailscale page
// (the test registers it through Headscale's API, as an admin would) and
// pick exit-box: its MagicDNS name.
export async function signIn(page: Page, context: BrowserContext, apex: string): Promise<string> {
  await page.goto(`${apex}/tailscale`);
  const control = page.getByLabel('Control server URL');
  await page.getByText('Another control server').click();
  await control.fill(process.env.HEADSCALE_URL!);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(control).toHaveValue(process.env.HEADSCALE_URL!);

  // Signing in opens a tab for the control server's page; Headscale's
  // registers the node by its id, as an admin would.
  const popup = context.waitForEvent('page');
  await page
    .locator('.tailscale-device')
    .getByRole('button', { name: 'Sign in with Tailscale' })
    .click();
  await popup.then((tab) => tab.close());
  const link = page.getByRole('link', { name: "Tailscale's sign-in page" });
  await expect(link).toBeVisible({ timeout: 120_000 });
  const authId = new URL((await link.getAttribute('href'))!).pathname.split('/').pop()!;
  const registered = await fetch(`${process.env.HEADSCALE_URL}/api/v1/auth/register`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.HEADSCALE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ user: process.env.HEADSCALE_USER ?? 'alice', authId }),
  });
  expect(registered.status, await registered.text()).toBe(200);

  const state = page.locator('.tailscale-state');
  await expect(state).toContainText('connected, no exit node', { timeout: 60_000 });
  await expect(page.locator('.tailscale-facts')).toContainText('tag:elixir-playground');
  const exit = page.locator('.tailscale-device select');
  const box = exit.locator('option', { hasText: 'exit-box' });
  await expect(box).toHaveCount(1, { timeout: 60_000 });
  const name = (await box.textContent())!.replace(/ \(offline\)$/, '');
  await exit.selectOption({ label: name });
  await expect(state).toContainText('connected through exit-box');

  return name;
}

// The user's settings (shared/lib/settings.ts), written into the apex's
// IndexedDB as the settings page would.
export async function userSettings(page: Page, value: object): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible();
  await page.evaluate(
    (settings) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open('playground');
        opening.onsuccess = () => {
          const db = opening.result;
          const put = db
            .transaction('settings', 'readwrite')
            .objectStore('settings')
            .put({ key: 'user', value: settings });
          put.onsuccess = () => (db.close(), resolve());
          put.onerror = () => reject(put.error);
        };
        opening.onerror = () => reject(opening.error);
      }),
    value,
  );
}

// A command whose connection to one of the relay's hosts the project's
// question holds (RelayDialog, docs/relay.md): `answer` given, then its
// output.
export async function runAnswering(
  page: Page,
  command: string,
  answer: 'Enable relay' | "Don't allow",
) {
  const ran = run(page, command);
  const dialog = page.getByRole('dialog', { name: /^Let .* connect to / });
  await dialog.getByRole('button', { name: answer }).click();
  await expect(dialog).toBeHidden();
  return ran;
}
