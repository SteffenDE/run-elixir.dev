import { expect, test } from './fixtures';
import {
  newProject,
  output,
  preview,
  prompted,
  reachesPreview,
  readText,
  seesInPreview,
  serverRunning,
  writeText,
} from './helpers';

const APP_JS = '/work/playground/assets/js/app.js';
const BUNDLE = '/work/playground/priv/static/assets/js/app.js';

test('an edit saved in the editor shows in the preview, with Tailwind', async ({ page }) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  for (const name of ['playground_web', 'controllers', 'page_html', 'home.html.heex']) {
    await page.getByRole('treeitem', { name, exact: true }).first().click();
    await page.waitForTimeout(300);
  }
  await expect(page.locator('.tab', { hasText: 'home.html.heex' })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.locator('.editor-scroll').click({ position: { x: 120, y: 12 } });
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('<h1 class="text-4xl font-bold">Hello from the browser IDE!</h1>\n');
  await expect(page.locator('.tab-close.dirty')).toHaveCount(1);
  await page.keyboard.press('Control+s');
  await expect(page.locator('.tab-close.dirty')).toHaveCount(0);
  await seesInPreview(page, 'Hello from the browser IDE!', 120_000);
  if (!reachesPreview(page)) return;
  const heading = preview(page).getByText('Hello from the browser IDE!');
  // Tailwind's watcher on the page builds the new class.
  await expect
    .poll(
      // The preview may reload meanwhile (the save's reload, then the CSS's).
      () => heading.evaluate((e) => getComputedStyle(e).fontSize).catch(() => ''),
      { timeout: 60_000 },
    )
    .toBe('36px');
});

test('a change to the app’s JavaScript is bundled by esbuild on the page', async ({ page }) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  await expect.poll(() => output(page), { timeout: 120_000 }).toContain('[watch] build finished');
  // The preview first, and with it Phoenix's live reload socket: an edit
  // before that joins reloads nothing (WebKit's often joined later).
  await seesInPreview(page, 'Peace of mind', 120_000);
  const app = await readText(page, APP_JS);
  await writeText(page, APP_JS, `${app}\nwindow.playgroundMarker = "bundled on the page"\n`);
  // The watcher rebuilds the bundle, and the preview reloads with it.
  await expect
    .poll(() => readText(page, BUNDLE), { timeout: 60_000 })
    .toContain('bundled on the page');
  if (!reachesPreview(page)) return;
  await expect
    .poll(
      () =>
        preview(page)
          .locator('body')
          .evaluate(() => (window as { playgroundMarker?: string }).playgroundMarker)
          .catch(() => undefined),
      { timeout: 60_000 },
    )
    .toBe('bundled on the page');
});

test('a tab opened again, here or in another project, shows the file, and unsaved edits hold the page', async ({
  page,
}) => {
  const NOTES = '/work/notes.txt';
  const editor = page.locator('.editor-scroll');
  const openNotes = async () => {
    await page.getByRole('treeitem', { name: 'notes.txt', exact: true }).click();
    await expect(editor).toContainText('from the file');
  };
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(page, NOTES, 'from the file\n');
  await openNotes();
  await editor.click({ position: { x: 120, y: 12 } });
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('unsaved draft ');
  await expect(page.locator('.tab-close.dirty')).toHaveCount(1);

  // The browser asks before the page goes; staying keeps the draft.
  const asked = page.waitForEvent('dialog');
  void page.evaluate(() => location.reload());
  const dialog = await asked;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  await expect(editor).toContainText('unsaved draft');

  // Closed without saving, then opened again: the file's text.
  await page.getByRole('button', { name: 'Close notes.txt' }).click();
  await openNotes();
  await expect(editor).not.toContainText('unsaved draft');

  // Another project with the same path: its own file, not the edits here.
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('first project ');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.tab-close.dirty')).toHaveCount(0);
  await page.getByRole('link', { name: 'Elixir Playground' }).click();
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(page, NOTES, 'from the file\n');
  await openNotes();
  await expect(editor).not.toContainText('first project');
  // Saved: the page goes without asking.
  let held = false;
  page.on('dialog', (other) => {
    held = true;
    void other.dismiss();
  });
  await page.reload();
  expect(held).toBe(false);
});
