import { expect, test } from './fixtures';
import { exists, newProject, output, prompted, readText, run } from './helpers';

test('the home page offers new projects and lists none at first', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('None yet.')).toBeVisible();
  await expect(page.getByText('Drop its folder anywhere on this page')).toBeVisible();
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

test('a project running here is closed and deleted at once', async ({ page }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  const name = (await page.locator('.project-name').textContent())!;
  await page.getByTitle('All projects').click();
  const row = page.locator('.project-row', { hasText: name });
  await expect(row.getByText('running here')).toBeVisible();
  await row.locator('button[title^="Delete"]').click();
  await page.getByRole('button', { name: 'Close and delete', exact: true }).click();
  await expect(page.getByText('None yet.')).toBeVisible();
  await expect(page.locator('.project-error')).toHaveCount(0);
});

test('a project is renamed in place', async ({ page }) => {
  await newProject(page, 'empty');
  await page.locator('.project-name').click();
  await page.getByLabel('Project name').fill('my experiment');
  await page.getByLabel('Project name').press('Enter');
  await expect(page.locator('.project-name')).toHaveText('my experiment');
  // Kept (IndexedDB) before the page goes: a write left in flight goes
  // with it.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<string[]>((resolve) => {
            const opening = indexedDB.open('playground');
            opening.onsuccess = () => {
              const all = opening.result.transaction('projects').objectStore('projects').getAll();
              all.onsuccess = () => resolve(all.result.map((project) => project.name));
            };
          }),
      ),
    )
    .toContain('my experiment');
  await page.goto('/');
  await expect(page.locator('.project-row', { hasText: 'my experiment' })).toBeVisible();
});

test('an unknown project is not found', async ({ page }) => {
  await page.goto('/abcdefghij/');
  await expect(page.getByText('There is no such project in this browser.')).toBeVisible();
});

test('a project that cannot start says why in a modal dialog', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'crossOriginIsolated', { value: false });
  });
  await newProject(page, 'empty');
  const dialog = page.getByRole('dialog', { name: 'The project could not start' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This page needs cross-origin isolation');
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
  } else await page.reload({ waitUntil: 'domcontentloaded' });
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

test('a project another tab lets go is no longer marked open, and opens where it was asked for', async ({
  page,
  context,
}) => {
  const id = await newProject(page, 'empty');
  await prompted(page, 1);
  const name = (await page.locator('.project-name').textContent())!;

  // The projects' list marks it open while the tab runs it: still on its
  // way home (which marks it running there), no longer once the tab goes on
  // to another project.
  const home = await context.newPage();
  await home.goto('/');
  const row = home.locator('.project-row', { hasText: name });
  await expect(row.getByText('open in a tab')).toBeVisible();
  await page.getByTitle('All projects').click();
  await expect(
    page.locator('.project-row', { hasText: name }).getByText('running here'),
  ).toBeVisible();
  await expect(row.getByText('open in a tab')).toBeVisible();
  await page.getByRole('link', { name: 'Empty project' }).click();
  await page.waitForURL(
    (url) => /^\/[a-z0-9]{10}\/$/.test(url.pathname) && !url.pathname.includes(id),
  );
  await prompted(page, 1);
  await expect(row.getByText('open in a tab')).toHaveCount(0);

  // Open again there; a third tab asks for it, and has it once that tab
  // closes.
  await page.goBack();
  await page.goBack();
  await prompted(page, 1);
  const other = await context.newPage();
  await other.goto(`/${id}/`);
  await expect(other.getByText('This project is open in another tab.')).toBeVisible();
  await page.close();
  await prompted(other, 1);
  await expect(other.locator('.project-name')).toHaveText(name);
});

test('a folder from this computer opens as a new project, without its builds or what .gitignore ignores', async ({
  page,
  browserName,
}, info) => {
  const fs = await import('node:fs/promises');
  const root = info.outputPath('greeter');
  await fs.mkdir(`${root}/lib`, { recursive: true });
  await fs.mkdir(`${root}/_build/dev`, { recursive: true });
  await fs.mkdir(`${root}/deps/jason`, { recursive: true });
  await fs.writeFile(
    `${root}/mix.exs`,
    'defmodule Greeter.MixProject do\n  use Mix.Project\n  def project, do: [app: :greeter, version: "0.1.0"]\nend\n',
  );
  await fs.writeFile(`${root}/lib/greeter.ex`, 'defmodule Greeter do\n  def hi, do: :hi\nend\n');
  await fs.writeFile(`${root}/logo.bin`, new Uint8Array([0, 255, 1, 128]));
  await fs.writeFile(`${root}/_build/dev/stale`, 'x');
  await fs.writeFile(`${root}/deps/jason/mix.exs`, 'x');
  // More files than a folder may hold, all skipped.
  await fs.mkdir(`${root}/assets/node_modules/big`, { recursive: true });
  for (let n = 0; n < 6000; n++) await fs.writeFile(`${root}/assets/node_modules/big/${n}.js`, '');
  await fs.writeFile(
    `${root}/.gitignore`,
    '# made by mix\n*.log\n!keep.log\n/priv/static/assets/\n',
  );
  await fs.mkdir(`${root}/priv/static/assets`, { recursive: true });
  await fs.writeFile(`${root}/priv/static/assets/app.js`, 'built');
  await fs.writeFile(`${root}/priv/static/robots.txt`, 'kept');
  await fs.writeFile(`${root}/debug.log`, 'x');
  await fs.writeFile(`${root}/keep.log`, 'kept');
  await fs.writeFile(`${root}/lib/.gitignore`, 'scratch/\n');
  await fs.mkdir(`${root}/lib/scratch`, { recursive: true });
  await fs.writeFile(`${root}/lib/scratch/notes.ex`, 'defmodule Notes, do: nil\n');
  // An editor's cache, offered but left out.
  await fs.mkdir(`${root}/.expert`, { recursive: true });
  await fs.writeFile(`${root}/.expert/index`, 'x');

  await page.goto('/');
  await page.getByLabel('Open a folder').setInputFiles(root);
  const review = page.getByRole('region', { name: 'New project from a folder' });
  await expect(review.getByText('lib/', { exact: true })).toBeVisible();
  // WebKit's picker leaves out dotfiles and symlinks, and says so.
  await expect(
    review.getByText('leaves out files and folders whose names start with a dot'),
  ).toHaveCount(browserName === 'webkit' ? 1 : 0);
  await review.getByRole('button', { name: 'Open as a new project' }).click();
  await page.waitForURL(/\/[a-z0-9]{10}\/$/);
  await prompted(page, 1);
  await expect(page.locator('.project-name')).toHaveText('greeter');
  expect(await readText(page, '/work/lib/greeter.ex')).toContain('def hi');
  const bytes = await page.evaluate(() =>
    window.playground.files.read('/work/logo.bin').then((b: Uint8Array) => [...b]),
  );
  expect(bytes).toEqual([0, 255, 1, 128]);
  expect(await exists(page, '/work/_build')).toBe(false);
  expect(await exists(page, '/work/deps')).toBe(false);
  expect(await exists(page, '/work/assets/node_modules')).toBe(false);
  expect(await exists(page, '/work/.expert')).toBe(false);
  expect(await run(page, 'mix compile')).toMatch(/Generated greeter app/);
  // WebKit's picker leaves out dotfiles: no .gitignore.
  if (browserName === 'webkit') return;
  expect(await exists(page, '/work/priv/static/assets')).toBe(false);
  expect(await exists(page, '/work/debug.log')).toBe(false);
  expect(await exists(page, '/work/lib/scratch')).toBe(false);
  for (const kept of ['.gitignore', 'keep.log', 'priv/static/robots.txt', 'lib/.gitignore'])
    expect(await exists(page, `/work/${kept}`)).toBe(true);
});

test('a folder too large to open is opened once enough of it is left out', async ({
  page,
}, info) => {
  const fs = await import('node:fs/promises');
  const root = info.outputPath('vendored');
  await fs.mkdir(`${root}/vendor/blobs`, { recursive: true });
  await fs.mkdir(`${root}/lib`, { recursive: true });
  await fs.writeFile(`${root}/mix.exs`, 'defmodule Vendored.MixProject do\nend\n');
  await fs.writeFile(`${root}/lib/vendored.ex`, 'defmodule Vendored do\nend\n');
  for (let n = 0; n < 5001; n++) await fs.writeFile(`${root}/vendor/blobs/${n}`, '');

  await page.goto('/');
  await page.getByLabel('Open a folder').setInputFiles(root);
  const review = page.getByRole('region', { name: 'New project from a folder' });
  await expect(review.getByRole('alert')).toContainText('more than 5000 files');
  const open = review.getByRole('button', { name: 'Open as a new project' });
  await expect(open).toBeDisabled();
  // Below vendor/: left out with it.
  await review.getByRole('button', { name: 'Show what is in vendor' }).click();
  await review.getByRole('checkbox', { name: 'vendor/' }).uncheck();
  await expect(review.getByRole('checkbox', { name: 'blobs/' })).toBeDisabled();
  await expect(review.getByRole('alert')).toHaveCount(0);
  await open.click();
  await page.waitForURL(/\/[a-z0-9]{10}\/$/);
  await prompted(page, 1);
  expect(await exists(page, '/work/lib/vendored.ex')).toBe(true);
  expect(await exists(page, '/work/vendor')).toBe(false);
});
