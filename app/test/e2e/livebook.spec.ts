import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { newProject, output, preview, prompted, reloadPreview } from './helpers';

const input = (page: Page, session: number, text: string) =>
  page.evaluate(([id, line]) => window.playground.sessions.get(id).node.input(`${line}\n`), [
    session,
    text,
  ] as const);

// Livebook in an empty project: its escript runs the server, the preview
// shows it, and a notebook's cell is evaluated on its standalone runtime,
// a node of its own that connects back by distribution
// (docs/distribution.md). The escript is built natively
// (`mix escript.install hex livebook 0.19.10`, the same OTP and Elixir)
// and put in the site as /livebook-escript; without it, the test skips.
test('Livebook runs a notebook on its standalone runtime @slow', async ({ page }) => {
  test.setTimeout(900_000);
  await page.goto('/');
  const escript = await page.evaluate(async () =>
    (await fetch('/livebook-escript')).headers.get('content-type'),
  );
  test.skip(!escript || escript.startsWith('text/html'), 'no /livebook-escript in the site');
  await newProject(page, 'empty');
  await prompted(page, 1);
  await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/livebook-escript')).arrayBuffer());
    await window.playground.files.write('/work/livebook', bytes);
  });
  await input(page, 1, 'LIVEBOOK_TOKEN_ENABLED=false escript livebook server');
  await expect
    .poll(() => output(page), { timeout: 600_000 })
    .toMatch(/\[Livebook\] Application running at/);
  // The iframe endpoint (8081) listens first; the preview switches to 8080
  // (the lowest port) once it listens, and loads it again.
  await expect(page.locator('.preview-bar input')).toHaveValue(/^localhost:8080\//, {
    timeout: 60_000,
  });
  await reloadPreview(page);
  const frame = preview(page);
  await expect(frame.locator('body')).toContainText('Livebook', { timeout: 120_000 });
  await page.screenshot({ path: '/repo/target/tests/livebook-home.png' });
  // A new notebook, its first code cell evaluated: the standalone runtime,
  // a node of its own that connects back by distribution.
  await page.locator('.preview-bar input').fill('/new');
  await page.locator('.preview-bar input').press('Enter');
  const cell = frame.locator('[data-el-cell][data-type="code"]:not([data-setup])').first();
  const editor = cell.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: 120_000 });
  await editor.click();
  await page.keyboard.type('Enum.sum(1..100) * 3');
  await page.keyboard.press('Control+Enter');
  await expect(cell).toContainText('15150', { timeout: 300_000 });
  await page.screenshot({ path: '/repo/target/tests/livebook-notebook.png' });
});
