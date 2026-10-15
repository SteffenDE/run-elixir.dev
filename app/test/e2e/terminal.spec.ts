import { expect, test } from './fixtures';
import { clickTerminalText, newProject, newShell, prompted, serverRunning } from './helpers';

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
  await expect(page.locator('.preview-bar input')).toHaveValue('/missing');
});

test('the first terminal keeps the server command in its history', async ({ page }) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  await page.locator('.terminal-host:not([hidden]) .xterm').click();
  await page.keyboard.press('Control+c');
  await prompted(page, 2);
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll('.terminal-host:not([hidden]) .xterm-rows > div')]
          .map((row) => row.textContent?.trimEnd() ?? '')
          .filter(Boolean)
          .at(-1),
      ),
    )
    .toMatch(/\$ iex -S mix phx\.server$/);
});
