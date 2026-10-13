// tabs.mjs URL: two Phoenix projects run in two tabs, and each preview
// shows its own app, also after the service worker restarts. A third tab
// opening the first project finds it open elsewhere, and takes it over.
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:8081/';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);
const check = (ok, what) => { if (!ok) { console.log(`FAIL: ${what}`); process.exitCode = 1; } else log(what); };
const running = (page) => page.waitForFunction(() => /Running PlaygroundWeb.Endpoint/.test(window.playground?.output ?? ''), null, { timeout: 240000 });
const home = '/work/playground/lib/playground_web/controllers/page_html/home.html.heex';

async function project(marker) {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(new URL('/phoenix', base).href);
  await page.waitForURL(/\/[a-z0-9]{10}\/$/);
  await running(page);
  await page.evaluate(([p, m]) => window.playground.files.read(p).then((b) =>
    window.playground.files.write(p, `<h1 id="marker">${m}</h1>\n` + new TextDecoder().decode(b))), [home, marker]);
  return page;
}
const shows = (page, marker) => page.frameLocator('.preview iframe').locator('#marker', { hasText: marker })
  .waitFor({ timeout: 90000 }).then(() => true, () => false);
const reload = (page) => page.locator('.preview-bar button[title=Reload]').click();

const a = await project('Project A');
const b = await project('Project B');
log('both servers running');
await reload(a);
await reload(b);
check(await shows(a, 'Project A'), 'tab A shows project A');
check(await shows(b, 'Project B'), 'tab B shows project B');

const cdp = await context.newCDPSession(a);
await cdp.send('ServiceWorker.enable');
await cdp.send('ServiceWorker.stopAllWorkers');
await a.waitForTimeout(1000);
await reload(b);
check(await shows(b, 'Project B'), 'after a service worker restart, tab B still shows project B');
await reload(a);
check(await shows(a, 'Project A'), 'and tab A project A');

const c = await context.newPage();
await c.goto(a.url());
await c.getByText('This project is open in another tab.').waitFor();
check(true, 'a third tab finds project A open elsewhere');
await c.getByRole('button', { name: 'Open it here' }).click();
await running(c);
await a.getByText('it stopped here').waitFor({ timeout: 30000 }).then(() => check(true, 'tab A stopped'), () => check(false, 'tab A stopped'));
await reload(c);
check(await shows(c, 'Project A'), 'tab C runs project A, with its change');
await c.screenshot({ path: '/out/tabs.png' });
await browser.close();
