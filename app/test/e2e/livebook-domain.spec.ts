import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { output, prompted, reloadPreview } from './helpers';

const input = (page: Page, text: string) =>
  page.evaluate((line) => window.playground.sessions.get(1).node.input(`${line}\n`), text);

// Livebook as a user gets it, on a project domain: mix escript.install
// builds it in the tab, `livebook` is a command (an escript on PATH), and
// a notebook's Kino output shows in Livebook's iframe endpoint, its port
// (8081) on an origin of its own (LIVEBOOK_IFRAME_URL from the page).
const APEX = 'http://playground.localhost:8082';
const ORIGIN = /^http:\/\/p-([a-z0-9]{10})\.playground\.localhost:8082\/$/;

test('Livebook installed with mix escript.install, a Kino output in its iframe @slow', async ({
  page,
}) => {
  test.setTimeout(3_600_000);
  await page.goto(`${APEX}/empty`);
  await page.waitForURL(ORIGIN);
  await prompted(page, 1);
  try {
    await input(page, 'mix escript.install hex livebook 0.19.10 --force');
    await prompted(page, 2);
    expect(await output(page)).toContain('creating /work/.mix/escripts/livebook');
    await input(page, 'LIVEBOOK_TOKEN_ENABLED=false livebook server');
    await expect
      .poll(() => output(page), { timeout: 600_000 })
      .toMatch(/\[Livebook\] Application running at/);
  } finally {
    console.log((await output(page)).slice(-4000));
  }
  await expect(page.locator('.preview-bar input')).toHaveValue(/^localhost:8080\//, {
    timeout: 60_000,
  });
  await reloadPreview(page);
  const frame = page.frameLocator('.preview iframe');
  await expect(frame.locator('body')).toContainText('Livebook', { timeout: 120_000 });
  await page.locator('.preview-bar input').fill('/new');
  await page.locator('.preview-bar input').press('Enter');

  const cell = (setup: boolean) =>
    frame
      .locator(`[data-el-cell][data-type="code"]${setup ? '[data-setup]' : ':not([data-setup])'}`)
      .first();
  const evaluate = async (setup: boolean, code: string) => {
    const editor = cell(setup).locator('.cm-content');
    await expect(editor).toBeVisible({ timeout: 120_000 });
    await editor.click();
    await page.keyboard.type(code);
    await page.keyboard.press('Control+Enter');
  };
  // The setup cell is folded until it is clicked, once the page is live.
  await expect(async () => {
    await frame.getByText('Notebook dependencies and setup').click();
    await expect(cell(true).locator('.cm-content')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  await evaluate(true, 'Mix.install([:kino])');
  await expect(cell(true).getByText('Evaluated')).toBeVisible({ timeout: 1_800_000 });
  await evaluate(false, 'Kino.HTML.new(~s(<p id="kino">from Kino</p>))');
  try {
    await expect
      .poll(
        async () => {
          for (const each of page.frames()) {
            if (
              await each
                .locator('#kino')
                .count()
                .catch(() => 0)
            )
              return each.url();
          }
          return null;
        },
        { timeout: 300_000 },
      )
      .toMatch(/^http:\/\/v-[a-z0-9]{10}-8081\.playground\.localhost:8082\//);
  } finally {
    await page.screenshot({ path: '/repo/target/tests/livebook-kino.png' });
  }
});
