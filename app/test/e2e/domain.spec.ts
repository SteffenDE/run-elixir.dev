import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { preview, prompted, readText, run, syncLV, writeText } from './helpers';

// With a project domain (serve.py --domain playground.localhost:8082),
// each project runs on its own origin, and the apex keeps the list
// (src/shared/lib/site.ts). Two labels: Chromium takes localhost for a
// top-level domain, so ID.localhost would be a site of its own.
const APEX = 'http://playground.localhost:8082';
const ORIGIN = /^http:\/\/p-([a-z0-9]{10})\.playground\.localhost:8082\/$/;
const origin = (id: string) => `http://p-${id}.playground.localhost:8082/`;

// Written through the page, and kept now (not a second later).
async function keep(page: Page, path: string, text: string) {
  await writeText(page, path, text);
  await page.evaluate(() => window.playground.files.flush());
}

test('a project runs on its own origin, and the apex lists, renames and deletes it', async ({
  page,
  context,
}) => {
  await page.goto(`${APEX}/empty`);
  await page.waitForURL(ORIGIN);
  const id = ORIGIN.exec(page.url())![1];
  await prompted(page, 1);
  await keep(page, '/work/note.txt', 'kept\n');
  expect(await run(page, 'cat note.txt')).toContain('kept');

  // Renamed on its page: the apex's list has the name, and shows it open.
  await page.getByTitle('Rename').click();
  const input = page.getByLabel('Project name');
  await input.fill('Domain Test');
  await input.press('Enter');
  const home = await context.newPage();
  await home.goto(`${APEX}/`);
  const row = home.locator('.project-row', { hasText: 'Domain Test' });
  await expect(row).toBeVisible();
  await expect(row.getByText('open in a tab')).toBeVisible();
  await expect(row.locator('.project-link')).toHaveAttribute('href', origin(id));

  // Open, it is not deleted; closed, it is, files and all.
  const remove = async () => {
    await row.getByRole('button', { name: /^Delete Domain Test/ }).click();
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
  };
  await remove();
  await expect(row.getByText('open in another tab')).toBeVisible();
  await page.close();
  await remove();
  await expect(row).toHaveCount(0);
  await home.goto(origin(id));
  await expect(home.getByText('There is no such project in this browser')).toBeVisible();
});

test('an old /ID/ link on the apex and a share link reach a project’s origin', async ({
  page,
  browser,
}) => {
  await page.goto(`${APEX}/empty`);
  await page.waitForURL(ORIGIN);
  const id = ORIGIN.exec(page.url())![1];
  await prompted(page, 1);
  await keep(page, '/work/hello.txt', 'shared over origins\n');
  await page.goto(`${APEX}/${id}/`);
  await page.waitForURL(origin(id));
  await prompted(page, 1);
  expect(await readText(page, '/work/hello.txt')).toBe('shared over origins\n');

  // The link is the apex's; it opens as a project on an origin of its own.
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByRole('button', { name: /^Link/ }).click();
  const field = page.getByLabel('Link to this project');
  await expect(field).toHaveValue(new RegExp(`^${APEX}/import#`));
  const link = await field.inputValue();
  const other = await (await browser.newContext()).newPage();
  await other.goto(link);
  await other.getByRole('button', { name: 'Open as a new project' }).click();
  await other.waitForURL(ORIGIN);
  expect(ORIGIN.exec(other.url())![1]).not.toBe(id);
  await prompted(other, 1);
  expect(await readText(other, '/work/hello.txt')).toBe('shared over origins\n');
  await other.context().close();
});

test('a Phoenix project’s preview is its own origin’s, LiveDashboard and its redirect too', async ({
  page,
}) => {
  await page.goto(`${APEX}/phoenix`);
  await page.waitForURL(ORIGIN);
  await expect(preview(page).getByText('Peace of mind')).toBeVisible({ timeout: 180_000 });
  // /dev/dashboard redirects to /dev/dashboard/home: the service worker
  // has only this project to send it to.
  await page.locator('.preview-bar input').fill('/dev/dashboard');
  await page.locator('.preview-bar input').press('Enter');
  await syncLV(preview(page));
  await expect(preview(page).getByText('System limits')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => /Transport: :websocket/.test(window.playground.output)))
    .toBe(true);
});

test('a name under the domain that is no project’s is not found, with the way back', async ({
  page,
}) => {
  for (const name of ['random-foo', 'phoenix', 'p-zzzzzzzzzz']) {
    await page.goto(`http://${name}.playground.localhost:8082/`);
    await expect(
      page.getByText(/There is (nothing at this address|no such project)/),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to your projects' })).toHaveAttribute(
      'href',
      `${APEX}/`,
    );
  }
});

test('what a project left on its origin, its entry gone, can be deleted there', async ({
  page,
}) => {
  await page.goto(`${APEX}/empty`);
  await page.waitForURL(ORIGIN);
  const id = ORIGIN.exec(page.url())![1];
  await prompted(page, 1);
  await keep(page, '/work/left.txt', 'left behind\n');
  // The apex's list loses the entry (as if deleted elsewhere).
  await page.goto(`${APEX}/`);
  await page.evaluate(
    (gone) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open('playground');
        opening.onsuccess = () => {
          const removing = opening.result
            .transaction('projects', 'readwrite')
            .objectStore('projects')
            .delete(gone);
          removing.onsuccess = () => resolve();
          removing.onerror = () => reject(removing.error);
        };
      }),
    id,
  );
  await page.goto(origin(id));
  await expect(page.getByText('There is no such project in this browser')).toBeVisible();
  await page.getByRole('button', { name: 'Delete what is left here' }).click();
  await expect(page.getByText('Deleted.')).toBeVisible();
  const left = await page.evaluate(async () =>
    (await indexedDB.databases()).map((database) => database.name),
  );
  expect(left.filter((name) => name?.includes(id))).toEqual([]);
});
