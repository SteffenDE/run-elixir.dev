// iex.mjs URL [LINES-JSON]: the Elixir playground until its IEx prompt, then
// each line typed into IEx; prints what IEx wrote.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:8080/';
const lines = JSON.parse(process.argv[3] || '[]');
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.log('console:', m.text()));
page.on('pageerror', (e) => console.log('pageerror:', e.message));
const t0 = Date.now();
await page.goto(url);
await page.waitForFunction(() => window.playground && /iex\(1\)> $/.test(window.playground.output), null, { timeout: 120000 });
console.log(`iex prompt after ${Date.now() - t0} ms`);
for (const [i, line] of lines.entries()) {
  await page.evaluate((l) => window.playground.node.input(l + "\n"), line);
  await page.waitForFunction((n) => (window.playground.output.match(/iex\(\d+\)> /g) || []).length >= n, i + 2, { timeout: 120000 }).catch(() => console.log('timeout on', line));
}
console.log(await page.evaluate(() => window.playground.output));
await page.screenshot({ path: '/out/shot.png' });
await browser.close();
