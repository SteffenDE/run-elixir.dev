// database.mjs URL: a Phoenix project's PGlite is kept across reloads,
// and deleting the project from the home page deletes it and the files'
// store.
import { chromium, firefox } from 'playwright';
const base = process.argv[2] || 'http://localhost:8081/';
const browser = await (process.env.BROWSER === 'firefox' ? firefox : chromium).launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);
const check = (ok, what) => { if (!ok) { console.log(`FAIL: ${what}`); process.exitCode = 1; } else log(what); };
const running = () => page.waitForFunction(() => /Running PlaygroundWeb.Endpoint/.test(window.playground?.output ?? ''), null, { timeout: 180000 });
const databases = () => page.evaluate(() => indexedDB.databases().then((list) => list.map((d) => d.name)));

await page.goto(new URL('/phoenix', base).href);
await page.waitForURL(/\/[a-z0-9]{10}\/$/);
const id = new URL(page.url()).pathname.slice(1, -1);
await running();
await page.evaluate(() => window.playground.database().then((db) =>
  db.exec("create table notes (body text); insert into notes values ('kept')")));
log('a row inserted');
await page.reload();
await running();
const rows = await page.evaluate(() => window.playground.database().then((db) => db.query('select body from notes')).then((r) => r.rows));
check(rows.length === 1 && rows[0].body === 'kept', 'the row is there after a reload');
const before = await databases();
check(before.includes(`/pglite/playground-pg-${id}`) && before.includes(`playground-files-${id}`), 'the project has its two stores');

await page.goto(base);
await page.locator('.project-row button[title^="Delete"]').first().click();
await page.getByRole('button', { name: 'Delete', exact: true }).click();
await page.getByText('None yet.').waitFor();
const after = await databases();
check(!after.some((name) => name.includes(id)), `deleting removes both (left: ${after.join(', ')})`);
await browser.close();
