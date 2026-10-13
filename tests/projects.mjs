// projects.mjs URL: the home page lists no projects; /iex runs IEx in a
// temporary project; /empty makes a project with a shell, which the home
// page then lists; it is deleted from there.
import { chromium, firefox } from 'playwright';
const base = process.argv[2] || 'http://localhost:8081/';
const browser = await (process.env.BROWSER === 'firefox' ? firefox : chromium).launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 }, colorScheme: process.env.SCHEME || 'light' });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 300)); });
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);
const check = (ok, what) => { if (!ok) { console.log(`FAIL: ${what}`); process.exitCode = 1; } else log(what); };

await page.goto(base);
await page.getByText('None yet.').waitFor();
check(true, 'home lists no projects');
await page.screenshot({ path: '/out/projects-home-empty.png' });

await page.goto(new URL('/iex', base).href);
await page.waitForFunction(() => /iex\(1\)> $/.test(window.playground?.output ?? ''), null, { timeout: 120000 });
await page.evaluate(() => window.playground.node.input('Enum.sum(1..10)\n'));
await page.waitForFunction(() => /55\S*\s+iex\(2\)> $/.test(window.playground.output.replace(/\x1b\[[0-9;]*m/g, '')), null, { timeout: 60000 })
  .catch(async () => console.log(JSON.stringify(await page.evaluate(() => window.playground.output))));
check(await page.locator('.chip.ephemeral').isVisible(), 'temporary IEx answers, marked ephemeral');
check(!(await page.locator('.preview').count()), 'no preview without a listener');
await page.screenshot({ path: '/out/projects-iex.png' });

await page.goto(new URL('/empty', base).href);
await page.waitForURL(/\/[a-z0-9]{10}\/$/);
const id = new URL(page.url()).pathname.slice(1, -1);
await page.waitForFunction(() => /~\S* \$ $/.test((window.playground?.output ?? '').replace(/\x1b\[[0-9;]*m/g, '')), null, { timeout: 120000 });
check(true, `empty project ${id} has a shell`);
const name = await page.locator('.project-name').textContent();

await page.goto(base);
await page.locator('.project-row', { hasText: name }).waitFor();
check((await page.locator('.project-row').count()) === 1, `home lists ${name}`);
await page.screenshot({ path: '/out/projects-home.png' });
await page.locator('.project-row button[title^="Delete"]').click();
await page.getByRole('button', { name: 'Delete', exact: true }).click();
await page.getByText('None yet.').waitFor();
check(true, 'deleted');
await browser.close();
