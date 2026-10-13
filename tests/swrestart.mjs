// swrestart.mjs URL: stop the service worker, then reload the preview.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)); });
await page.goto(process.argv[2]);
await page.waitForFunction(() => /Running PlaygroundWeb.Endpoint/.test(window.playground?.output ?? ''), null, { timeout: 180000 });
const frame = page.frameLocator('.preview iframe');
await frame.getByText('Peace of mind').waitFor({ timeout: 60000 });
console.log('preview loaded');
const cdp = await context.newCDPSession(page);
await cdp.send('ServiceWorker.enable');
await cdp.send('ServiceWorker.stopAllWorkers');
console.log('service worker stopped');
await page.waitForTimeout(1000);
await page.locator('.preview-bar button[title=Reload]').click();
await frame.getByText('Peace of mind').waitFor({ timeout: 60000 }).then(() => console.log('preview reloaded after the restart'), () => console.log('preview did NOT reload'));
await browser.close();
