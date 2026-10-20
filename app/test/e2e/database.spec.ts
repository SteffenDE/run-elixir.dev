import { expect, test } from './fixtures';
import { newProject, serverRunning } from './helpers';

const databases = (page: import('@playwright/test').Page) =>
  page.evaluate(() => indexedDB.databases().then((list) => list.map((d) => d.name ?? '')));

test("a Phoenix project's database is kept, and deleted with it", async ({ page }) => {
  const id = await newProject(page, 'phoenix');
  await serverRunning(page);
  await page.evaluate(() =>
    window.playground
      .database()
      .then((db: { exec(sql: string): Promise<unknown> }) =>
        db.exec("create table notes (body text); insert into notes values ('kept')"),
      ),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await serverRunning(page);
  const rows = await page.evaluate(() =>
    window.playground
      .database()
      .then((db: { query(sql: string): Promise<{ rows: unknown[] }> }) =>
        db.query('select body from notes'),
      )
      .then((result: { rows: unknown[] }) => result.rows),
  );
  expect(rows).toEqual([{ body: 'kept' }]);
  expect(await databases(page)).toEqual(
    expect.arrayContaining([`/pglite/playground-pg-${id}`, `playground-files-${id}`]),
  );

  await page.goto('/');
  await page.locator('.project-row button[title^="Delete"]').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('None yet.')).toBeVisible();
  expect((await databases(page)).filter((name) => name.includes(id))).toEqual([]);
});
