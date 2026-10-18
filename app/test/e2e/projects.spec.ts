import { expect, test } from './fixtures';
import { newProject, output, prompted, run } from './helpers';

test('the home page offers new projects and lists none at first', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('None yet.')).toBeVisible();
  for (const name of ['Phoenix project', 'Empty project', 'Temporary IEx'])
    await expect(page.getByRole('link', { name })).toBeVisible();
});

test('a temporary IEx answers and is marked ephemeral', async ({ page }) => {
  await page.goto('/iex');
  await expect.poll(() => output(page), { timeout: 120_000 }).toMatch(/iex\(1\)> $/);
  await page.evaluate(() => window.playground.node.input('Enum.sum(1..10)\n'));
  await expect.poll(() => output(page)).toMatch(/55\s+iex\(2\)> $/);
  await expect(page.locator('.chip.ephemeral')).toBeVisible();
  await expect(page.locator('.preview')).toHaveCount(0);
  // Just the shell, until asked for the files: the tree's and the editor's
  // panels have no room.
  const room = async () => {
    const tree = await page.locator('.panel', { has: page.locator('.file-tree') }).boundingBox();
    const editor = await page
      .locator('.panel', { has: page.locator('.editor-empty') })
      .last()
      .boundingBox();
    return Math.round(Math.min(tree!.width, editor!.height));
  };
  await expect.poll(room).toBe(0);
  await page.getByRole('button', { name: 'Show the files and the editor' }).click();
  await expect.poll(room).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Maximize the terminals' }).click();
  await expect.poll(room).toBe(0);
  await page.goto('/');
  await expect(page.getByText('None yet.')).toBeVisible();
});

test('an empty project has a shell, is listed, and is deleted', async ({ page }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await expect(page.locator('.file-tree')).toBeVisible();
  expect(await run(page, 'pwd')).toContain('/work');
  const name = (await page.locator('.project-name').textContent())!;
  await page.goto('/');
  const row = page.locator('.project-row', { hasText: name });
  await expect(row).toBeVisible();
  await row.locator('button[title^="Delete"]').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('None yet.')).toBeVisible();
});

test('a project is renamed in place', async ({ page }) => {
  await newProject(page, 'empty');
  await page.locator('.project-name').click();
  await page.getByLabel('Project name').fill('my experiment');
  await page.getByLabel('Project name').press('Enter');
  await expect(page.locator('.project-name')).toHaveText('my experiment');
  await page.goto('/');
  await expect(page.locator('.project-row', { hasText: 'my experiment' })).toBeVisible();
});

test('an unknown project is not found', async ({ page }) => {
  await page.goto('/abcdefghij/');
  await expect(page.getByText('There is no such project in this browser.')).toBeVisible();
});

test('a project that cannot start says why in a modal dialog', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.serviceWorker.register = () => Promise.reject(new Error('no service worker here'));
  });
  await newProject(page, 'empty');
  const dialog = page.getByRole('dialog', { name: 'The project could not start' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('no service worker here');
  await expect(page.locator('.status-text')).toHaveText('Could not start');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

test('a project starts again after a forced reload', async ({ page, browserName }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  // Firefox's reload here loads the page without its service worker, as a
  // forced reload does; Chromium's needs asking.
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await Promise.all([
      page.waitForEvent('framenavigated'),
      cdp.send('Page.reload', { ignoreCache: true }),
    ]);
  } else await page.reload();
  await prompted(page, 1);
});

test('the preview opens for a server, not for Mix or an ephemeral port', async ({ page }) => {
  test.setTimeout(600_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mix new demo');
  await run(page, 'cd demo');
  // Compiling takes Mix's lock, which listens on an ephemeral port.
  await page.evaluate(() => window.playground.node.input('iex -S mix\n'));
  await expect.poll(() => output(page), { timeout: 300_000 }).toMatch(/iex\(1\)> $/);
  await page.evaluate(() => window.playground.node.input(':gen_tcp.listen(0, [])\n'));
  // gen_tcp_socket's tuple (the socket backend: beam/socket).
  await expect
    .poll(() => output(page))
    .toMatch(/\{:ok,\s+\{:"\$inet", :gen_tcp_socket,[^]*?\}\}\s+iex\(2\)> $/);
  await page.waitForTimeout(1000);
  await expect(page.locator('.preview')).toHaveCount(0);
  await page.evaluate(() => window.playground.node.input(':gen_tcp.listen(4001, [])\n'));
  await expect(page.locator('.preview')).toBeVisible();
});
