// What the tests do to a playground page, mostly through
// window.playground (src/project/lib/playground.ts).
import { expect, type FrameLocator, type Page } from '@playwright/test';

export const APP = '/work/playground';
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
