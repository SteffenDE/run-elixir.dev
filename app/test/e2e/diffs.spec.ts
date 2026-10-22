import { expect, test } from './fixtures';
import { newProject, prompted, writeText } from './helpers';

// The IDE's own git (runtime/git.ts), not the shell's.
const git = (page: import('@playwright/test').Page, args: string[], stdin?: string) =>
  page.evaluate(
    async ([a, s]) => {
      const { code, stdout, stderr } = await window.playground.git(a, { stdin: s ?? undefined });
      return {
        code,
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
      };
    },
    [args, stdin ?? null] as const,
  );

test('the IDE runs git over the project without a node', async ({ page }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  expect(await git(page, ['init', '-q'])).toMatchObject({ code: 0 });
  await writeText(page, '/work/a.txt', 'one\n');
  const status = await git(page, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  expect(status).toMatchObject({ code: 0, stdout: '? a.txt\0' });
  const hashed = await git(page, ['hash-object', '--stdin'], 'one\n');
  expect(hashed.stdout).toMatch(/^[0-9a-f]{40}\n$/);
  expect((await git(page, ['no-such-command'])).code).not.toBe(0);
});

test('a Phoenix project starts as a repository: the template, its baseline', async ({ page }) => {
  await newProject(page, 'phoenix');
  await prompted(page, 1);
  const log = await git(page, ['log', '--format=%s', 'refs/playground/baseline']);
  expect(log).toMatchObject({ code: 0, stdout: 'Baseline\n' });
  // deps and _build are the app's .gitignore's.
  const status = await git(page, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  expect(status).toMatchObject({ code: 0, stdout: '' });
  const tracked = await git(page, ['ls-files']);
  expect(tracked.stdout).toContain('playground/mix.exs');
  expect(tracked.stdout).not.toContain('playground/deps/');
});

test('an empty project has no repository until it asks for one', async ({ page }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  expect(await page.evaluate(() => window.playground.files.stat('/work/.git'))).toBeNull();
});

test('a folder opened as a project is its baseline', async ({ page }, info) => {
  const fs = await import('node:fs/promises');
  const root = info.outputPath('greeter');
  await fs.mkdir(`${root}/lib`, { recursive: true });
  await fs.writeFile(`${root}/mix.exs`, 'defmodule Greeter.MixProject do\nend\n');
  await fs.writeFile(`${root}/lib/greeter.ex`, 'defmodule Greeter do\nend\n');
  await page.goto('/');
  await page.getByLabel('Open a folder').setInputFiles(root);
  const review = page.getByRole('region', { name: 'New project from a folder' });
  await review.getByRole('button', { name: 'Open as a new project' }).click();
  await page.waitForURL(/\/[a-z0-9]{10}\/$/);
  await prompted(page, 1);
  expect(
    (await git(page, ['ls-tree', '-r', '--name-only', 'refs/playground/baseline'])).stdout,
  ).toBe('lib/greeter.ex\nmix.exs\n');
  expect((await git(page, ['status', '--porcelain'])).stdout).toBe('');
});

test('the changes view lists what changed and shows its diff', async ({ page }) => {
  await newProject(page, 'phoenix');
  await prompted(page, 1);
  const home = '/work/playground/lib/playground_web/controllers/page_html/home.html.heex';
  const before = await page.evaluate(
    (p) => window.playground.files.read(p).then((b: Uint8Array) => new TextDecoder().decode(b)),
    home,
  );
  await writeText(page, home, before.replace(/<p class=/, '<p data-changed class='));
  await writeText(page, '/work/playground/lib/notes.ex', 'defmodule Notes do\nend\n');

  await page.getByRole('tab', { name: /Changes/ }).click();
  const panel = page.locator('.changes-panel');
  await expect(panel.getByText('2 files changed')).toBeVisible();
  await expect(panel.locator('.search-file', { hasText: 'notes.ex' })).toContainText('+2');
  await panel.locator('.search-file', { hasText: 'home.html.heex' }).click();
  const view = page.locator('.changes-view');
  await expect(view).toBeVisible();
  await expect(view.locator('diffs-container').first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('changes.png') });

  // Committed at the shell: nothing uncommitted, all changes still there.
  await page.evaluate(() =>
    window.playground.git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'x']),
  );
  await panel.getByRole('button', { name: 'Uncommitted' }).click();
  await expect(panel.getByText('1 file changed')).toBeVisible();
});
