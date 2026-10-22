// A public repository opened as a new project (/github/OWNER/REPO), and a
// project's commits pushed to GitHub from the Changes panel. Nothing goes
// to GitHub: this test's process answers the site's git proxy
// (/git/github.com/…) with git's own smart HTTP and GitHub's REST API with
// a stand-in (../fake-github.ts), both over a bare repository of its own.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { fakeGitHub, gitHttp, sh } from '../fake-github';
import { expect, test } from './fixtures';
import { newProject, prompted, readText, run, writeText } from './helpers';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-github-api-version',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT',
};

// github.com/me/demo for every page of the context: its git (through the
// site's proxy, from the exec frame's workers) and its REST API.
async function routeGitHub(context: BrowserContext, bare: string): Promise<void> {
  const api = fakeGitHub(bare);
  await context.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const answer = await api(request.url(), {
      method: request.method(),
      body: request.postData() ?? undefined,
    });
    await route.fulfill({
      status: answer.status,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: await answer.text(),
    });
  });
  await context.route(/\/git\/github\.com\/me\/demo(\.git)?\//, async (route) => {
    const request = route.request();
    const answer = gitHttp(bare, request.url(), request.method(), request.postDataBuffer());
    await route.fulfill({
      status: answer.status,
      headers: { 'content-type': answer.contentType },
      body: answer.body,
    });
  });
}

// A repository on "GitHub": main, with a script (100755), and a branch.
function demo(dir: string): string {
  const bare = join(dir, 'demo.git');
  const seed = join(dir, 'seed');
  sh(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  sh(dir, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'mix.exs'), 'defmodule Demo.MixProject do\n  # app: :demo\nend\n');
  sh(seed, ['add', 'mix.exs']);
  sh(seed, ['commit', '-q', '-m', 'First']);
  writeFileSync(join(seed, 'server'), '#!/bin/sh\nexec mix phx.server\n');
  sh(seed, ['add', 'server']);
  sh(seed, ['update-index', '--chmod=+x', 'server']);
  sh(seed, ['mv', 'server', 'run.sh']);
  sh(seed, ['commit', '-q', '-m', 'A script']);
  sh(seed, ['switch', '-q', '-c', 'topic']);
  writeFileSync(join(seed, 'topic.txt'), 'on a branch\n');
  sh(seed, ['add', 'topic.txt']);
  sh(seed, ['commit', '-q', '-m', 'Topic']);
  sh(seed, ['push', '-q', bare, 'main', 'topic']);
  return bare;
}

let dir = '';
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'github-'));
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (page: Page, args: string[]) =>
  page.evaluate(
    (a) =>
      window.playground
        .git(a)
        .then((out: { stdout: Uint8Array }) => new TextDecoder().decode(out.stdout).trim()),
    args,
  );

test('a repository from the home page opens as a new project, cloned', async ({
  page,
  context,
}) => {
  await routeGitHub(context, demo(dir));
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Repository address' }).fill('me/demo');
  await page.screenshot({ path: '../target/tests/repository-home.png' });
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(/\/github\/me\/demo$/);
  await expect(page.getByText('me/demo')).toBeVisible();
  await page.screenshot({ path: '../target/tests/repository-page.png' });
  await page.getByRole('button', { name: 'Open as a new project' }).click();
  await page.waitForURL(/\/[a-z0-9]{10}\/$/);
  await prompted(page, 1);
  expect(await readText(page, '/work/mix.exs')).toContain('app: :demo');
  // The latest commit only, as the baseline.
  expect(await git(page, ['rev-list', '--count', 'HEAD'])).toBe('1');
  expect(await git(page, ['rev-parse', 'refs/playground/baseline'])).toBe(
    await git(page, ['rev-parse', 'HEAD']),
  );
  await expect(page.locator('.project-name')).toHaveText('demo');

  // No token yet: the push says where to add one.
  await page.getByRole('tab', { name: /Changes/ }).click();
  await page.locator('.changes-panel').getByRole('button', { name: 'Push' }).click();
  const dialog = page.getByRole('dialog', { name: /Push to me\/demo/ });
  await expect(dialog).toContainText('main goes to me/demo');
  await expect(dialog).toContainText('Pushing needs a GitHub token');
  await expect(dialog.getByRole('button', { name: 'Push' })).toBeDisabled();

  // Not a repository's address.
  await page.goto('/github/me');
  await expect(page.getByText('There is nothing at this address.')).toBeVisible();
});

test('a cloned project keeps its scripts executable and switches branches', async ({
  page,
  context,
}) => {
  await routeGitHub(context, demo(dir));
  await page.goto('/github/me/demo');
  await page.getByRole('button', { name: 'Open as a new project' }).click();
  await page.waitForURL(/\/[a-z0-9]{10}\/$/);
  await prompted(page, 1);
  // run.sh is 100755: no change for want of an executable bit.
  expect(await git(page, ['ls-files', '-s', 'run.sh'])).toMatch(/^100755 /);
  await page.getByRole('tab', { name: /Changes/ }).click();
  const panel = page.locator('.changes-panel');
  await expect(panel.getByText('No changes')).toBeVisible();
  expect(await run(page, 'git status --porcelain')).not.toContain('run.sh');

  // Another branch, fetched by name, then switched to.
  await run(page, 'git fetch -q origin topic');
  const switched = await run(page, 'git switch topic');
  expect(switched).toContain("branch 'topic' set up to track 'origin/topic'");
  expect(await run(page, 'git status -sb')).toContain('## topic...origin/topic');
  expect(await readText(page, '/work/topic.txt')).toBe('on a branch\n');
  await panel.getByRole('button', { name: 'Uncommitted' }).click();
  await expect(panel.getByText('No changes')).toBeVisible();
});

test('a cloned project commits and pushes a change of its branch', async ({ page, context }) => {
  const bare = demo(dir);
  await routeGitHub(context, bare);
  await page.goto('/settings');
  await page.getByRole('textbox', { name: 'GitHub token' }).fill('github_pat_test');
  await page.getByRole('button', { name: 'Add token' }).click();
  await expect(page.getByText('Pushing as octo')).toBeVisible();
  await page.goto('/github/me/demo');
  await page.getByRole('button', { name: 'Open as a new project' }).click();
  await page.waitForURL(/\/[a-z0-9]{10}\/$/);
  await prompted(page, 1);
  await writeText(page, '/work/mix.exs', 'defmodule Demo.MixProject do\n  # changed\nend\n');

  await page.getByRole('tab', { name: /Changes/ }).click();
  await page.locator('.changes-panel').getByRole('button', { name: 'Push' }).click();
  const dialog = page.getByRole('dialog', { name: 'Push to me/demo' });
  await expect(dialog).toContainText('0 commits to push, and a new one');
  await dialog.getByRole('textbox', { name: 'Commit message' }).fill('Change mix.exs');
  await dialog.getByRole('button', { name: 'Commit and push' }).click();
  await expect(dialog).toContainText('Pushed 1 commit to main.');
  // Fast-forward, the same commit; the script still 100755 there.
  expect(sh(bare, ['rev-parse', 'main'])).toBe(await git(page, ['rev-parse', 'HEAD']));
  expect(sh(bare, ['log', '--format=%s', 'main'])).toBe('Change mix.exs\nA script\nFirst');
  expect(sh(bare, ['ls-tree', 'main', 'run.sh'])).toMatch(/^100755 /);
});

test('a project commits and pushes to an empty repository on GitHub', async ({ page, context }) => {
  const bare = join(dir, 'repo.git');
  sh(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  await routeGitHub(context, bare);
  await page.goto('/settings');
  await page.getByRole('textbox', { name: 'GitHub token' }).fill('github_pat_test');
  await page.getByRole('button', { name: 'Add token' }).click();
  await expect(page.getByText('Pushing as octo')).toBeVisible();
  await page.screenshot({ path: '../target/tests/github-settings.png', fullPage: true });

  await newProject(page, 'empty');
  await prompted(page, 1);
  // The token is the page's: no shell has it.
  expect(await run(page, 'env')).not.toContain('github_pat_test');
  await writeText(page, '/work/mix.exs', 'defmodule Demo.MixProject do\nend\n');
  await page.getByRole('tab', { name: /Changes/ }).click();
  const panel = page.locator('.changes-panel');
  await page.getByRole('button', { name: 'Initialize repository' }).click();
  await expect(panel.getByText('No changes')).toBeVisible();
  await git(page, ['remote', 'add', 'origin', 'https://github.com/me/repo']);
  await writeText(page, '/work/demo.ex', 'defmodule Demo do\nend\n');

  await panel.getByRole('button', { name: 'Push' }).click();
  const dialog = page.getByRole('dialog', { name: 'Push to me/repo' });
  await expect(dialog).toContainText('1 file has changed since the last commit');
  await dialog.getByRole('textbox', { name: 'Commit message' }).fill('Add Demo');
  await page.screenshot({ path: '../target/tests/push-dialog.png' });
  await dialog.getByRole('button', { name: 'Commit and push' }).click();
  await expect(dialog).toContainText('Pushed 2 commits to main.');
  await page.screenshot({ path: '../target/tests/push-done.png' });
  const head = await git(page, ['rev-parse', 'HEAD']);
  // The same commits on GitHub, by the token's user.
  expect(sh(bare, ['rev-parse', 'main'])).toBe(head);
  expect(sh(bare, ['log', '--format=%an: %s', 'main'])).toBe(
    'Octo Cat: Add Demo\nPlayground: Baseline',
  );
  await dialog.getByRole('button', { name: 'Close' }).click();

  // Up to date; the shell's own git status knows the upstream.
  expect(await run(page, 'git status -sb')).toContain('## main...origin/main');
  await panel.getByRole('button', { name: 'Push' }).click();
  await expect(page.getByRole('dialog')).toContainText('0 commits to push');
});
