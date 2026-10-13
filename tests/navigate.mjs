// navigate.mjs URL: go to /dev/dashboard through the preview's path bar (it
// redirects to /dev/dashboard/home), and reload there. The dashboard page
// itself fails on Rust-OTP for now (docs/status.md); this checks where the
// preview goes.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);
await page.goto(process.argv[2]);
const frame = page.frameLocator('.preview iframe');
await frame.getByText('Peace of mind').waitFor({ timeout: 120000 });
log('home shown');
await page.locator('.preview-bar input').fill('/dev/dashboard');
await page.locator('.preview-bar input').press('Enter');
await page.waitForFunction(() => document.querySelector('.preview iframe')?.contentWindow?.location.pathname.startsWith('/dev/dashboard'), null, { timeout: 60000 }).catch(() => log('did not get there'));
await page.waitForTimeout(3000);
const at = await page.evaluate(() => document.querySelector('.preview iframe').contentWindow.location.pathname);
log(`iframe at ${at}; path bar: ${await page.locator('.preview-bar input').inputValue()}`);
await page.locator('.preview-bar button[title=Reload]').click();
await page.waitForTimeout(4000);
log(`after reload: ${await page.evaluate(() => document.querySelector('.preview iframe').contentWindow.location.pathname)}`);
const out = await page.evaluate(() => window.playground.output);
console.log(out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /GET|POST|Sent|error/i.test(l)).slice(-10).join('\n'));
await page.screenshot({ path: '/out/nav.png' });
await browser.close();
