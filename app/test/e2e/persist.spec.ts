import { expect, test } from './fixtures';
import {
  APP,
  HOME_HEEX,
  exists,
  markHome,
  newProject,
  output,
  preview,
  prompted,
  readText,
  run,
  serverRunning,
  writeText,
} from './helpers';

test('an empty project keeps its files across reloads', async ({ page }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(page, '/work/hello.exs', 'IO.puts("kept: " <> File.read!("made.txt"))\n');
  await run(
    page,
    `elixir -e 'File.write!("made.txt", "by elixir"); File.write!("doomed.txt", "x")'`,
  );
  await run(page, 'rm doomed.txt');
  await page.evaluate(() => window.playground.files.flush());
  await page.reload();
  await prompted(page, 1);
  expect(await exists(page, '/work/doomed.txt')).toBe(false);
  expect(await run(page, 'elixir hello.exs')).toContain('kept: by elixir');
});

// Home (/home/user: Mix's, Hex's and the tools' caches, escripts) is kept
// with the project, but is not one of its files: the tree has /work only.
test("an empty project keeps its home's files across reloads, out of its tree", async ({
  page,
}) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  expect(await run(page, 'echo kept > ~/note.txt && cat ~/note.txt && pwd')).toMatch(
    /kept\s+\/work/,
  );
  await page.evaluate(() => window.playground.files.flush());
  await page.reload();
  await prompted(page, 1);
  expect(await readText(page, '/home/user/note.txt')).toBe('kept\n');
  await expect(page.locator('.file-tree')).not.toContainText('note.txt');
});

test('a Phoenix project keeps edits, removals and moves over its template', async ({ page }) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  await markHome(page, 'Kept across reloads');
  await page.evaluate((p) => window.playground.files.remove(p), `${APP}/README.md`);
  await page.evaluate(
    ([from, to]) => window.playground.files.rename(from, to),
    [`${APP}/priv/static/images`, `${APP}/priv/static/pictures`],
  );
  await page.evaluate(() => window.playground.files.flush());
  await page.reload();
  await serverRunning(page);
  // The dependencies come from the template's build, not recompiled.
  expect(await output(page)).not.toMatch(/==> (phoenix|ecto|bandit)\nCompiling/);
  expect(await readText(page, HOME_HEEX)).toMatch(/^<h1 id="marker">Kept across reloads/);
  expect(await exists(page, `${APP}/README.md`)).toBe(false);
  expect(await exists(page, `${APP}/priv/static/images/logo.svg`)).toBe(false);
  expect(await exists(page, `${APP}/priv/static/pictures/logo.svg`)).toBe(true);
  await expect(preview(page).locator('#marker')).toHaveText('Kept across reloads', {
    timeout: 60_000,
  });
});
