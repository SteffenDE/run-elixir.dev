import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { APEX, PORT, newProject, prompted, readText } from './helpers';

// A project's stores from the former layout, on its own origin
// (p-ID.playground.localhost), move to the apex when it opens
// (shared/lib/migrate.ts, frames/storage.ts). That origin is the apex's
// site, so a frame of it sees its own storage: in Chromium and Firefox.
// WebKit keys a frame's storage by the page's origin (Safari ran
// projects on the apex itself, so has nothing there to move).
const FILES = (id: string) => `playground-files-${id}`;
const PG = (id: string) => `/pglite/playground-pg-${id}`;

const databases = (page: Page) =>
  page.evaluate(async () => (await indexedDB.databases()).map((database) => database.name ?? ''));

test('a project’s stores on its former origin move to the apex, and go from there', async ({
  page,
  browserName,
}) => {
  test.skip(browserName === 'webkit', 'WebKit partitions a same-site frame’s storage');
  const id = await newProject(page, 'empty');
  await prompted(page, 1);
  await page.goto(`${APEX}/`);
  // As the apex never had it: its stores gone, not marked moved.
  await page.evaluate(
    async ([files, pg]) => {
      for (const name of [files, pg])
        await new Promise((done) => {
          const deleting = indexedDB.deleteDatabase(name);
          deleting.onsuccess = deleting.onerror = deleting.onblocked = done;
        });
      localStorage.removeItem('playground-moved');
    },
    [FILES(id), PG(id)],
  );

  // The former origin, as the former layout left it: a changed file, and
  // a database standing in for PGlite's.
  const former = `http://p-${id}.playground.localhost:${PORT}/storage.html`;
  await page.goto(former);
  await page.evaluate(
    async ([files, pg]) => {
      const open = (name: string, upgrade: (db: IDBDatabase) => void) =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const opening = indexedDB.open(name, 1);
          opening.onupgradeneeded = () => upgrade(opening.result);
          opening.onsuccess = () => resolve(opening.result);
          opening.onerror = () => reject(opening.error);
        });
      const put = (db: IDBDatabase, store: string, value: unknown, key?: IDBValidKey) =>
        new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(store, 'readwrite');
          transaction.objectStore(store).put(value, key);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      const overlay = await open(files, (db) => {
        db.createObjectStore('files', { keyPath: 'path' });
        db.createObjectStore('meta');
      });
      await put(overlay, 'files', {
        path: '/work/moved.txt',
        kind: 'file',
        data: new TextEncoder().encode('kept on p-ID\n'),
        mtime: '1700000000000000000',
      });
      overlay.close();
      const postgres = await open(pg, (db) =>
        db.createObjectStore('FILE_DATA').createIndex('timestamp', 'timestamp'),
      );
      await put(
        postgres,
        'FILE_DATA',
        { timestamp: 1, contents: new Uint8Array([1, 2, 3]) },
        'base/1',
      );
      postgres.close();
    },
    [FILES(id), PG(id)],
  );
  expect(await databases(page)).toEqual(expect.arrayContaining([FILES(id), PG(id)]));

  // Opened on the apex: the file is there, the database too.
  await page.goto(`${APEX}/${id}/`);
  await prompted(page, 1);
  expect(await readText(page, '/work/moved.txt')).toBe('kept on p-ID\n');
  const contents = await page.evaluate(
    (pg) =>
      new Promise<number[]>((resolve) => {
        const opening = indexedDB.open(pg);
        opening.onsuccess = () => {
          const reading = opening.result
            .transaction('FILE_DATA')
            .objectStore('FILE_DATA')
            .get('base/1');
          reading.onsuccess = () => resolve([...reading.result.contents]);
        };
      }),
    PG(id),
  );
  expect(contents).toEqual([1, 2, 3]);

  // And gone from the former origin.
  await page.goto(former);
  const left = await databases(page);
  expect(left.filter((name) => name.includes(id))).toEqual([]);
});
