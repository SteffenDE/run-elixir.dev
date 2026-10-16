// Live sessions (src/live, docs/collaboration.md): a host and a guest, in
// two browser contexts, through the backend's relay. The site for these
// tests is served with the backend at http://localhost:4000
// (playwright.config.ts: the `live` server); without one running, they
// are skipped.
import type { Browser, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { newProject, output, prompted, readText, writeText } from './helpers';

const LIVE = `http://localhost:${Number(process.env.PORT || 8081) + 2}`;

test.use({ baseURL: LIVE });

test.beforeAll(async ({ request }) => {
  const backend = await request.get('http://localhost:4000/socket/websocket').catch(() => null);
  test.skip(!backend, 'no backend at localhost:4000 (mix phx.server in playground/backend)');
});

// The host starts a live session of its project; its link.
async function startLive(page: Page, options: { ask?: boolean } = {}): Promise<string> {
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByRole('button', { name: /^Live session/ }).click();
  await page.getByLabel('Your name').fill('Ada');
  if (options.ask) await page.getByLabel('Ask me before letting each person in').check();
  await page.getByRole('button', { name: 'Start live session' }).click();
  const field = page.getByLabel('Link to this live session');
  await expect(field).toHaveValue(/\/live\/[\w-]{22}#k=[\w-]{43}&h=[\w-]{43}$/);
  await expect(page.locator('.share-summary')).toContainText('Live');
  return field.inputValue();
}

// A guest joins from another browser.
async function join(browser: Browser, link: string, name = 'Bob'): Promise<Page> {
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(link);
  await guest.getByLabel('Your name').fill(name);
  await guest.getByRole('button', { name: 'Join' }).click();
  return guest;
}

const editorText = (page: Page) =>
  page.locator('.tab-panel:not([hidden]) [contenteditable]').first().innerText();

// The host's switch for everyone (Edit, Terminals, Fork).
async function allow(page: Page, what: string) {
  await livePanel(page);
  await page.locator('.live-switches').getByLabel(what).check();
}

// The host's live session panel, opened unless it is.
async function livePanel(page: Page) {
  if (!(await page.locator('.live-panel').isVisible()))
    await page.getByRole('button', { name: /^Live/ }).click();
}

test('a guest watches, then edits and types when the host allows it', async ({ page, browser }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(page, '/work/notes.txt', 'hello\n');
  await page.evaluate(() => window.playground.files.flush());
  const link = await startLive(page);

  const guest = await join(browser, link);
  // The host's project: its tree, and its terminal's output.
  await expect(guest.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible();
  await expect(guest.locator('.terminal-host:not([hidden])')).toContainText('$');
  await expect(guest.locator('.guest-status')).toHaveText('You are watching');
  await expect(page.locator('.live-people')).toContainText('Bob');

  // Watching: the file opens, and typing changes nothing.
  await guest.getByRole('treeitem', { name: 'notes.txt', exact: true }).click();
  await expect.poll(() => editorText(guest)).toContain('hello');
  await guest.locator('.editor-scroll').click({ position: { x: 120, y: 12 } });
  await guest.keyboard.press('Control+Home');
  await guest.keyboard.type('nope ');
  await guest.waitForTimeout(500);
  expect(await editorText(guest)).not.toContain('nope');
  await expect(guest.getByTitle('New file')).toHaveCount(0);

  // Allowed to edit: the guest's typing reaches the host's editor, and the
  // host's the guest's.
  await allow(page, 'Edit');
  await expect(guest.locator('.guest-status')).toHaveText('You may edit');
  await expect(guest.getByTitle('New file')).toBeVisible();
  await guest.locator('.editor-scroll').click({ position: { x: 120, y: 12 } });
  await guest.keyboard.press('Control+Home');
  await guest.keyboard.type('from Bob ');
  await page.keyboard.press('Escape');
  await page.getByRole('treeitem', { name: 'notes.txt', exact: true }).click();
  await expect.poll(() => editorText(page)).toContain('from Bob hello');
  await page.locator('.editor-scroll').click({ position: { x: 300, y: 12 } });
  await page.keyboard.press('Control+End');
  await page.keyboard.type('from Ada');
  await expect.poll(() => editorText(guest)).toContain('from Ada');
  // Each sees the other's caret.
  await expect(guest.locator('[data-remote-caret]')).toContainText('Ada');
  await expect(page.locator('[data-remote-caret]')).toContainText('Bob');

  // The guest's undo takes back only the guest's typing.
  await guest.locator('.editor-scroll').click({ position: { x: 300, y: 12 } });
  await guest.keyboard.press('Control+z');
  await expect.poll(() => editorText(page)).not.toContain('from Bob');
  expect(await editorText(page)).toContain('from Ada');

  // The guest saves: the host's file has it.
  await guest.keyboard.press('Control+s');
  await expect.poll(() => readText(page, '/work/notes.txt')).toContain('from Ada');
  await expect(guest.locator('.tab-close.dirty')).toHaveCount(0);
  await expect(page.locator('.tab-close.dirty')).toHaveCount(0);

  // A file the host's shell changes changes for the guest.
  await page.evaluate(() =>
    window.playground.files.write('/work/notes.txt', new TextEncoder().encode('rewritten\n')),
  );
  await expect.poll(() => editorText(guest)).toContain('rewritten');

  // Terminals: the guest types once allowed.
  await allow(page, 'Terminals');
  await expect(guest.locator('.guest-status')).toHaveText('You may edit and use the terminals');
  await guest.locator('.terminal-host:not([hidden])').click();
  await guest.keyboard.type('echo typed-by-bob\n');
  await expect.poll(() => output(page)).toContain('typed-by-bob');
  await expect(guest.locator('.terminal-host:not([hidden])')).toContainText('typed-by-bob');

  // The host ends it.
  await livePanel(page);
  await page.getByRole('button', { name: 'End live session' }).click();
  await expect(guest.locator('.live-ended')).toContainText('ended');
  await guest.context().close();
});

test('with asking on, a guest waits until let in; a removed one is out', async ({
  page,
  browser,
}) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  const link = await startLive(page, { ask: true });
  const guest = await join(browser, link, 'Cleo');
  await expect(guest.getByText('Waiting for the host to let you in')).toBeVisible();
  await expect(page.locator('.live-people')).toContainText('Cleo wants to join');
  await page.getByRole('button', { name: 'Let in' }).click();
  await expect(guest.locator('.guest-status')).toHaveText('You are watching');

  await page.getByRole('button', { name: 'Remove Cleo' }).click();
  await expect(guest.locator('.project-error')).toContainText('removed you');
  await guest.context().close();
});

test('a guest forks the project with its unsaved text', async ({ page, browser }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(page, '/work/fork.txt', 'saved\n');
  const link = await startLive(page);
  await allow(page, 'Fork');
  await allow(page, 'Edit');
  const guest = await join(browser, link);
  await guest.getByRole('treeitem', { name: 'fork.txt', exact: true }).click();
  await expect.poll(() => editorText(guest)).toContain('saved');
  await guest.locator('.editor-scroll').click({ position: { x: 120, y: 12 } });
  await guest.keyboard.press('Control+End');
  await guest.keyboard.type('unsaved');
  const opened = guest.context().waitForEvent('page');
  await guest.getByRole('button', { name: 'Fork', exact: true }).click();
  const forked = await opened;
  await forked.waitForURL(/\/[a-z0-9]{10}\/$/);
  await prompted(forked, 1);
  expect(await readText(forked, '/work/fork.txt')).toBe('saved\nunsaved');
  await guest.context().close();
});

test('the host reloads its page; the session and its guests carry on', async ({
  page,
  browser,
}) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(page, '/work/again.txt', 'one\n');
  const link = await startLive(page);
  await allow(page, 'Edit');
  const guest = await join(browser, link);
  await guest.getByRole('treeitem', { name: 'again.txt', exact: true }).click();
  await expect.poll(() => editorText(guest)).toContain('one');

  await page.reload();
  await expect(guest.locator('.guest-status')).toHaveText('The host is away…');
  await prompted(page, 1);
  await expect(page.getByRole('button', { name: /^Live/ })).toBeVisible();
  await expect(guest.locator('.guest-status')).toHaveText('You may edit');
  // The guest's tab came back from the host, and edits go through again.
  await expect.poll(() => editorText(guest)).toContain('one');
  await guest.locator('.editor-scroll').click({ position: { x: 120, y: 12 } });
  await guest.keyboard.press('Control+End');
  await guest.keyboard.type('two');
  await guest.keyboard.press('Control+s');
  await expect.poll(() => readText(page, '/work/again.txt')).toBe('one\ntwo');
  await guest.context().close();
});
