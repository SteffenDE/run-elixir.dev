// edit.mjs URL: open home.html.heex from the tree, change it, save, and
// see the preview change.
import { chromium, firefox } from 'playwright';
const browser = await (process.env.BROWSER === 'firefox' ? firefox : chromium).launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, colorScheme: process.env.SCHEME || 'light' });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 300)); });
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);
await page.goto(process.argv[2]);
await page.waitForFunction(() => /Running PlaygroundWeb.Endpoint/.test(window.playground?.output ?? ''), null, { timeout: 180000 });
log('endpoint running');
for (const name of ['playground_web', 'controllers', 'page_html', 'home.html.heex']) {
  await page.getByRole('treeitem', { name, exact: true }).first().click();
  await page.waitForTimeout(300);
}
await page.locator('.tab', { hasText: 'home.html.heex' }).waitFor({ timeout: 20000 });
log('tab open');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/out/edit-open.png' });
// Type at the start of the document.
const editor = page.locator('.editor-scroll');
await editor.click({ position: { x: 120, y: 12 } });
await page.keyboard.press('Control+Home');
await page.keyboard.type('<h1 class="text-4xl font-bold">Hello from the browser IDE!</h1>\n');
await page.waitForTimeout(500);
const dirty = await page.locator('.tab-close.dirty').count();
log(`dirty tabs: ${dirty}`);
await page.keyboard.press('Control+s');
await page.waitForFunction(() => document.querySelectorAll('.tab-close.dirty').length === 0, null, { timeout: 10000 }).then(() => log('saved'), () => log('not saved'));
const frame = page.frameLocator('.preview iframe');
await frame.getByText('Hello from the browser IDE!').waitFor({ timeout: 120000 }).then(() => log('preview shows the change'), () => log('preview did not change'));
const size = async () => frame.getByText('Hello from the browser IDE!').evaluate((e) => getComputedStyle(e).fontSize).catch(() => '?');
for (let i = 0; i < 60 && (await size()) !== '36px'; i++) await page.waitForTimeout(500);
log(`heading font size: ${await size()}`);
const out = await page.evaluate(() => window.playground.output);
console.log(out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /tailwind|Done in|Error/i.test(l)).slice(-6).join('\n'));
await page.screenshot({ path: '/out/edit-saved.png' });
await browser.close();
