import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  exists,
  newProject,
  newShell,
  prompted,
  readText,
  run,
  serverRunning,
  userSettings,
} from './helpers';

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

test('Back cancels a pending trust request before another project starts', async ({ page }) => {
  await userSettings(page, { env: { GREETING: 'mine' }, shared: true, setup: '' });
  await page.goto(await LINK(page));
  await page.getByRole('button', { name: 'Open as a new project' }).click();
  const dialog = page.getByRole('dialog', { name: /Use your settings/ });
  await expect(dialog).toBeVisible();
  const abandoned = new URL(page.url()).pathname;

  await page.goBack();
  await page.getByRole('link', { name: 'All projects', exact: true }).click();
  await page.getByRole('link', { name: 'Empty project' }).click();
  await expect(dialog).toHaveCount(0);
  await prompted(page, 1);
  await expect(page.locator('.exec-frame')).toHaveCount(1);
  await run(page, 'echo current > /work/current.txt');

  // The cancelled request did not save a trust answer or start its shell.
  await page.getByTitle('All projects').click();
  await page.locator(`.project-row a[href$="${abandoned}"]`).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Use my settings' }).click();
  await prompted(page, 1);
  await expect(page.locator('.exec-frame')).toHaveCount(1);
  expect(await exists(page, '/work/current.txt')).toBe(false);
});

test('a project first started without setup never runs a later setup script', async ({ page }) => {
  await userSettings(page, { env: {}, shared: true, setup: '' });
  const id = await newProject(page, 'empty');
  await prompted(page, 1);
  await userSettings(page, { setup: 'echo unexpected > /work/late-setup.txt' });
  await page.goto(`/${id}/`);
  await prompted(page, 1);
  expect(await exists(page, '/work/late-setup.txt')).toBe(false);
});

test('playground environment defaults take precedence over user and project settings', async ({
  page,
}) => {
  const overrides = {
    HOME: '/custom/home',
    PATH: '/custom/bin',
    MIX_HOME: '/custom/mix',
    TARGET_ARCH: 'custom',
    GREETING: 'from the user',
  };
  await userSettings(page, { env: overrides, shared: false, setup: '' });
  const id = await newProject(page, 'empty');
  await prompted(page, 1);
  const check = async (greeting: string) => {
    const result = await run(page, 'echo "[$HOME][$PATH][$MIX_HOME][$TARGET_ARCH][$GREETING]"');
    expect(result).toContain(
      `[/home/user][/usr/bin:/home/user/.mix/escripts][/home/user/.mix][wasm32][${greeting}]`,
    );
    expect(await run(page, 'node -p "process.env.TARGET_ARCH"')).toContain('wasm32');
  };
  await check('from the user');
  await projectSettings(page, id, { env: { ...overrides, GREETING: 'from the project' } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await prompted(page, 1);
  await check('from the project');
});

test('leaving broadcasts the final shared-folder changes to other open projects', async ({
  page,
  context,
}) => {
  await userSettings(page, { env: {}, shared: true, setup: '' });
  await newProject(page, 'empty');
  await prompted(page, 1);
  const other = await context.newPage();
  await newProject(other, 'empty');
  await prompted(other, 1);

  await run(page, 'echo final > /shared/final.txt');
  await page.getByTitle('All projects').click();
  await expect(page.locator('.project-row')).toHaveCount(2);
  await expect.poll(() => readText(other, '/shared/final.txt')).toBe('final\n');
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

test('Phoenix startup is an editable saved command that can be rerun or cleared', async ({
  page,
}) => {
  await newProject(page, 'phoenix');
  await serverRunning(page);
  const shell = await newShell(page);
  expect(await run(page, 'pwd', shell)).toMatch(/^\/work$/m);
  await page.getByRole('button', { name: 'Restart server' }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window.playground.output.match(/Running PlaygroundWeb.Endpoint/g) ?? []).length,
        ),
      { timeout: 60_000 },
    )
    .toBe(2);
  await page.getByRole('button', { name: 'Project settings' }).click();
  const startup = page.getByLabel('Startup lines');
  await expect(startup).toHaveValue('cd playground && iex -S mix phx.server');
  const command = 'cd playground && echo custom-startup >> /work/startup.log';
  await startup.fill(command);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved. Environment changes apply to new shells.')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^(Start|Restart) server$/ }).click();
  await expect
    .poll(() => readText(page, '/work/startup.log').catch(() => ''))
    .toBe('custom-startup\n');

  // Reload uses the same saved command, without starting Phoenix again.
  await page.evaluate(() => window.playground.files.flush());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await prompted(page, 2);
  expect(await readText(page, '/work/startup.log')).toBe('custom-startup\ncustom-startup\n');
  await page.getByRole('button', { name: 'Project settings' }).click();
  await expect(startup).toHaveValue(command);
  await startup.fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved. Environment changes apply to new shells.')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^(Start|Restart) server$/ }).click();
  await expect.poll(() => run(page, 'pwd'), { timeout: 10_000 }).toMatch(/^\/work$/m);

  // Empty is a stored choice, rather than a fallback to the Phoenix preset.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await prompted(page, 1);
  expect(await run(page, 'echo shell-ready')).toContain('shell-ready');
  expect(await run(page, 'pwd')).toMatch(/^\/work$/m);
  expect(await page.evaluate(() => window.playground.sessions.get(1).node.serving.size)).toBe(0);
  await page.getByRole('button', { name: 'Project settings' }).click();
  await expect(startup).toHaveValue('');
});

test('existing projects receive startup defaults and preserve custom command directories or empty commands', async ({
  page,
}) => {
  // The prior Dexie schema (version 3) before the app opens its database.
  await page.route('**/legacy-projects.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Legacy projects</title>',
    }),
  );
  await page.goto('/legacy-projects.html');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open('playground', 30);
        opening.onupgradeneeded = () => {
          const db = opening.result;
          db.createObjectStore('projects', { keyPath: 'id' }).createIndex('openedAt', 'openedAt');
          db.createObjectStore('seeds', { keyPath: 'id' });
          db.createObjectStore('settings', { keyPath: 'key' });
        };
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result;
          const tx = db.transaction('projects', 'readwrite');
          const store = tx.objectStore('projects');
          const base = { name: 'legacy', createdAt: Date.now(), openedAt: Date.now() };
          store.put({ ...base, id: 'legacy0001', kind: 'phoenix' });
          store.put({ ...base, id: 'legacy0002', kind: 'empty' });
          store.put({ ...base, id: 'legacy0003', kind: 'phoenix', startup: 'echo custom' });
          store.put({ ...base, id: 'legacy0004', kind: 'phoenix', startup: '' });
          store.put({
            ...base,
            id: 'legacy0005',
            kind: 'phoenix',
            startup: '# A custom script\necho custom',
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.goto('/');
  await expect(page.locator('.project-row')).toHaveCount(5);
  const commands = await page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const opening = indexedDB.open('playground');
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result;
          const got = db.transaction('projects').objectStore('projects').getAll();
          got.onsuccess = () => {
            db.close();
            resolve(got.result.map((project) => project.startup));
          };
          got.onerror = () => reject(got.error);
        };
      }),
  );
  expect(commands).toEqual([
    'cd playground && iex -S mix phx.server',
    '',
    'cd playground\necho custom',
    '',
    'cd playground\n# A custom script\necho custom',
  ]);
});
