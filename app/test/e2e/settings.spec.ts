import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { exists, newProject, newShell, prompted, readText, run, userSettings } from './helpers';

// A project's own settings, on its record.
async function projectSettings(page: Page, id: string, changes: object): Promise<void> {
  await page.evaluate(
    ([key, more]) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open('playground');
        opening.onsuccess = () => {
          const db = opening.result;
          const store = db.transaction('projects', 'readwrite').objectStore('projects');
          const got = store.get(key);
          got.onsuccess = () => {
            const put = store.put({ ...got.result, ...more });
            put.onsuccess = () => (db.close(), resolve());
            put.onerror = () => reject(put.error);
          };
        };
        opening.onerror = () => reject(opening.error);
      }),
    [id, changes] as const,
  );
}

// A link to an empty project with one file (share.ts's format).
const LINK = async (page: Page) =>
  page.evaluate(async () => {
    const shared = {
      v: 1,
      kind: 'empty',
      name: 'from a link',
      site: '',
      removed: [],
      files: { 'README.md': 'hi\n' },
    };
    const out = new Blob([JSON.stringify(shared)])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(out).arrayBuffer());
    return `/import#${btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}`;
  });

test('the user’s environment, setup script once, and a project’s startup lines', async ({
  page,
}) => {
  await userSettings(page, {
    env: { GREETING: 'hello from settings' },
    shared: true,
    setup: 'echo setup-ran >> /work/setup.log\necho "$GREETING" > /work/greeting.txt',
  });
  const id = await newProject(page, 'empty');
  await prompted(page, 1);
  await expect.poll(() => exists(page, '/work/greeting.txt'), { timeout: 60_000 }).toBe(true);
  expect(await readText(page, '/work/greeting.txt')).toBe('hello from settings\n');
  await prompted(page, 2);
  expect(await run(page, 'echo "[$GREETING]"')).toContain('[hello from settings]');
  expect(await run(page, `node -e "console.log('node', process.env.GREETING)"`)).toContain(
    'node hello from settings',
  );

  // Its own startup lines, at each start; the setup script not again.
  await projectSettings(page, id, { startup: 'echo "started $GREETING" > /work/started.txt' });
  await page.evaluate(() => window.playground.files.flush());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await prompted(page, 1);
  await expect.poll(() => exists(page, '/work/started.txt'), { timeout: 60_000 }).toBe(true);
  expect(await readText(page, '/work/started.txt')).toBe('started hello from settings\n');
  expect(await readText(page, '/work/setup.log')).toBe('setup-ran\n');
});

test('a project from a link asks first, and takes the user’s settings only if allowed', async ({
  page,
}) => {
  await userSettings(page, {
    env: { GREETING: 'hello from settings' },
    shared: true,
    setup: 'echo setup-ran >> /work/setup.log',
  });
  // Not this project: none of them, and it does not ask again.
  await page.goto(await LINK(page));
  await page.getByRole('button', { name: 'Open as a new project' }).click();
  const dialog = page.getByRole('dialog', { name: /Use your settings in from a link\?/ });
  await expect(dialog).toContainText('GREETING');
  await expect(dialog).not.toContainText('hello from settings');
  await expect(dialog).toContainText('echo setup-ran');
  await dialog.getByRole('button', { name: 'Not this project' }).click();
  await prompted(page, 1);
  expect(await run(page, 'echo "[$GREETING]"')).toContain('[]');
  expect(await exists(page, '/work/setup.log')).toBe(false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await prompted(page, 1);
  await expect(page.getByRole('dialog', { name: /Use your settings/ })).toHaveCount(0);

  // Allowed: the environment and the setup script.
  await page.goto(await LINK(page));
  await page.getByRole('button', { name: 'Open as a new project' }).click();
  await page.getByRole('button', { name: 'Use my settings' }).click();
  await prompted(page, 1);
  await expect.poll(() => exists(page, '/work/setup.log'), { timeout: 30_000 }).toBe(true);
  expect(await run(page, 'echo "[$GREETING]"')).toContain('[hello from settings]');
});

// /shared: the same in every project of the user's, kept on the apex, and
// what one changes the others open hear at once.
test('/shared is every project’s, live, and kept', async ({ page, context }) => {
  await userSettings(page, { env: {}, shared: true, setup: '' });
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(
    page,
    'echo one > /shared/notes.txt; mkdir -p /shared/claude; ln -s /shared/claude /home/user/.claude',
  );
  await run(page, 'echo token > /home/user/.claude/credentials.txt');

  const other = await context.newPage();
  await newProject(other, 'empty');
  await prompted(other, 1);
  // Kept within a moment, so a project opened at once may hear it after it starts.
  await expect
    .poll(() => run(other, 'cat /shared/notes.txt /shared/claude/credentials.txt'), {
      timeout: 30_000,
    })
    .toMatch(/one\s+token/);

  // While both run: a change in one, the other reads (a Node.js process's too).
  await run(page, 'echo two > /shared/notes.txt');
  await expect
    .poll(() => run(other, 'cat /shared/notes.txt'), { timeout: 30_000 })
    .toContain('two');
  await run(other, `node -e "require('fs').writeFileSync('/shared/from-node.txt', 'node wrote')"`);
  await expect
    .poll(() => run(page, 'cat /shared/from-node.txt'), { timeout: 30_000 })
    .toContain('node wrote');

  // Kept: after a reload.
  await page.evaluate(() => window.playground.files.flush());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await prompted(page, 1);
  expect(await run(page, 'cat /shared/notes.txt /shared/from-node.txt')).toMatch(
    /two\s+node wrote/,
  );
});

test('/shared is empty, and kept nowhere, where the user turned it off or a link’s project', async ({
  page,
}) => {
  await userSettings(page, { env: {}, shared: true, setup: '' });
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'echo mine > /shared/notes.txt');
  await page.evaluate(() => window.playground.files.flush());

  await page.goto(await LINK(page));
  await page.getByRole('button', { name: 'Open as a new project' }).click();
  await page.getByRole('button', { name: 'Not this project' }).click();
  await page.waitForURL(/\/[a-z0-9]{10}\/$/);
  await prompted(page, 1);
  expect(await exists(page, '/shared/notes.txt')).toBe(false);

  await userSettings(page, { env: {}, shared: false, setup: '' });
  await newProject(page, 'empty');
  await prompted(page, 1);
  expect(await exists(page, '/shared/notes.txt')).toBe(false);
});

test('the settings page, and a project’s settings in its top bar', async ({ page, context }) => {
  // A project open meanwhile: its new shells take what is saved.
  await newProject(page, 'empty');
  await prompted(page, 1);

  const settingsPage = await context.newPage();
  await settingsPage.goto('/');
  await settingsPage.getByRole('link', { name: 'Settings' }).click();
  await expect(settingsPage.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await settingsPage.getByRole('button', { name: 'Add a variable' }).click();
  await settingsPage.getByLabel('Name').fill('GREETING');
  await settingsPage.getByLabel('Value of GREETING').fill('from the page');
  await settingsPage.getByLabel('Setup script').fill('echo set-up > /work/setup.txt');
  await settingsPage.getByRole('button', { name: 'Save' }).click();
  await expect(settingsPage.getByText('Saved.')).toBeVisible();
  await settingsPage.screenshot({ path: '../target/tests/settings-page.png' });

  const shell = await newShell(page);
  await expect
    .poll(() => run(page, 'echo "[$GREETING]"', shell), { timeout: 10_000 })
    .toContain('[from the page]');

  // A new project: the setup script, the environment.
  const id = await newProject(page, 'empty');
  await prompted(page, 1);
  await expect.poll(() => exists(page, '/work/setup.txt'), { timeout: 30_000 }).toBe(true);

  // Its own: startup lines and environment over the user's.
  await page.getByRole('button', { name: 'Project settings' }).click();
  await page.getByLabel('Startup lines').fill('echo "started $GREETING" > /work/started.txt');
  await page.getByRole('button', { name: 'Add a variable' }).click();
  await page.getByLabel('Name').fill('GREETING');
  await page.getByLabel('Value of GREETING').fill('the project’s own');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved. Environment changes apply to new shells.')).toBeVisible();
  await page.screenshot({ path: '../target/tests/project-settings.png' });
  await page.keyboard.press('Escape');
  const own = await newShell(page);
  expect(await run(page, 'echo "[$GREETING]"', own)).toContain('[the project’s own]');
  await page.evaluate(() => window.playground.files.flush());
  expect(id).toBeTruthy();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await prompted(page, 1);
  await expect.poll(() => exists(page, '/work/started.txt'), { timeout: 30_000 }).toBe(true);
  expect(await readText(page, '/work/started.txt')).toBe('started the project’s own\n');
});
