import { expect, test } from './fixtures';
import {
  clickTerminalText,
  newProject,
  newShell,
  output,
  prompted,
  serverRunning,
} from './helpers';

// The visible terminal's last line with anything on it.
const lastLine = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.terminal-host:not([hidden]) .xterm-rows > div')]
      .map((row) => row.textContent?.trimEnd() ?? '')
      .filter(Boolean)
      .at(-1),
  );

// How far the visible terminal's screen stays inside its panel (both
// non-negative when it fits).
const slack = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const host = document.querySelector('.terminal-host:not([hidden])')!.getBoundingClientRect();
    const screen = document
      .querySelector('.terminal-host:not([hidden]) .xterm-screen')!
      .getBoundingClientRect();
    return Math.min(host.bottom - screen.bottom, host.right - screen.right);
  });

test('terminals fit their panel, also after resizing', async ({ page }) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  expect(await slack(page)).toBeGreaterThanOrEqual(-0.5);
  for (const [selector, dx, dy] of [
    ['.separator.horizontal', 0, -150],
    ['.separator:not(.horizontal)', 120, 0],
  ] as const) {
    const box = (await page.locator(selector).first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await slack(page), `after dragging ${selector}`).toBeGreaterThanOrEqual(-0.5);
  }
});

test('source locations open in the editor, addresses in the preview', async ({ page }) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  const shell = await newShell(page);
  await page.evaluate(
    (id) =>
      window.playground.sessions
        .get(id)
        .node.input('echo see lib/playground_web/router.ex:17\necho at localhost:4000/missing\n'),
    shell,
  );
  await page.waitForTimeout(500);
  await clickTerminalText(page, 'router.ex:17');
  await expect(page.locator('.tab', { hasText: 'router.ex' })).toBeVisible();
  await expect(page.locator('.editor-scroll')).toContainText('scope "/", PlaygroundWeb do');
  await clickTerminalText(page, 'localhost:4000/missing');
  await expect(page.locator('.preview-bar input')).toHaveValue('localhost:4000/missing');
});

test('the first terminal keeps the server command in its history', async ({ page }) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  await page.locator('.terminal-host:not([hidden]) .xterm').click();
  // Ctrl+C: erts' break menu, as on a terminal; a aborts.
  await page.keyboard.press('Control+c');
  await expect.poll(() => output(page)).toMatch(/BREAK: \(a\)bort/);
  await page.keyboard.press('a');
  await prompted(page, 2);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => lastLine(page)).toMatch(/\$ cd playground && iex -S mix phx\.server$/);
});

test('IEx edits its own lines: tab completes, up recalls, Ctrl+C breaks', async ({ page }) => {
  await page.goto('/iex');
  await expect.poll(() => output(page), { timeout: 120_000 }).toMatch(/iex\(1\)> $/);
  await page.locator('.terminal-host:not([hidden]) .xterm').click();
  await page.keyboard.type('String.upc');
  await page.keyboard.press('Tab');
  await expect.poll(() => lastLine(page)).toBe('iex(1)> String.upcase');
  await page.keyboard.type('("tab")');
  await page.keyboard.press('Enter');
  await expect.poll(() => output(page)).toMatch(/"TAB"\s+iex\(2\)> $/);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => lastLine(page)).toBe('iex(2)> String.upcase("tab")');
  await page.keyboard.press('Enter');
  // The terminal's width, also after it changes.
  const columns = async (prompt: number) => {
    await page.keyboard.type(':io.columns');
    await page.keyboard.press('Enter');
    const pattern = new RegExp(`\\{:ok, (\\d+)\\}\\s+iex\\(${prompt + 1}\\)> $`);
    await expect.poll(() => output(page)).toMatch(pattern);
    return Number((await output(page)).match(pattern)![1]);
  };
  const wide = await columns(3);
  expect(wide).toBeGreaterThan(80);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(1000);
  expect(await columns(4)).toBeLessThan(wide);
  // Ctrl+C: erts' break menu; c continues, and IEx answers again.
  await page.keyboard.press('Control+c');
  await expect.poll(() => output(page)).toMatch(/BREAK: \(a\)bort[\s\S]*\(c\)ontinue/);
  await page.keyboard.press('c');
  // A moment before typing, as a person takes: what comes while erts
  // leaves the menu, it drops (the keys reach the node through the exec
  // frame's worker, docs/frames.md), and it shows nothing to wait for.
  await page.waitForTimeout(500);
  await page.keyboard.type('6 * 7');
  await page.keyboard.press('Enter');
  await expect.poll(() => output(page)).toMatch(/42\s+iex\(6\)> $/);
  // Ctrl+C and a: the shell's prompt (it ran `iex` at the first), and
  // lines again.
  await page.keyboard.press('Control+c');
  await expect.poll(() => output(page).then((text) => text.split('BREAK:').length)).toBe(3);
  await page.keyboard.press('a');
  await prompted(page, 2);
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await prompted(page, 3);
  // The output has what was typed too: the shell's line discipline echoes.
  expect(await output(page)).toMatch(/\n\/work \$ pwd\r?\n\/work\n\/work \$ $/);
});
