// terminal.mjs URL: a terminal's rows and columns fit its panel, also
// after the panel is resized; a printed source location opens the file
// in the editor; a printed address opens in the preview.
import { chromium, firefox } from 'playwright';
const base = process.argv[2] || 'http://localhost:8081/';
const browser = await (process.env.BROWSER === 'firefox' ? firefox : chromium).launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);
const check = (ok, what) => { if (!ok) { console.log(`FAIL: ${what}`); process.exitCode = 1; } else log(what); };

// Whether the visible terminal's screen lies inside its panel.
const fits = () => page.evaluate(() => {
  const host = document.querySelector('.terminal-host:not([hidden])').getBoundingClientRect();
  const screen = document.querySelector('.terminal-host:not([hidden]) .xterm-screen').getBoundingClientRect();
  return { fits: screen.bottom <= host.bottom + 0.5 && screen.right <= host.right + 0.5, slack: [host.bottom - screen.bottom, host.right - screen.right] };
});
// Click `text` where the visible terminal shows it.
async function click(text) {
  const point = await page.evaluate((t) => {
    for (const row of document.querySelectorAll('.terminal-host:not([hidden]) .xterm-rows > div')) {
      let at = row.textContent.indexOf(t);
      if (at < 0) continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (at < node.length) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, Math.min(node.length, at + 3));
          const box = range.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        }
        at -= node.length;
      }
    }
    return null;
  }, text);
  if (!point) {
    await page.screenshot({ path: '/out/terminal-missing.png' });
    throw new Error(`${text}: not on screen`);
  }
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(400);
  await page.mouse.click(point.x, point.y);
}

await page.goto(new URL('/phoenix', base).href);
await page.waitForFunction(() => /Running PlaygroundWeb.Endpoint/.test(window.playground?.output ?? ''), null, { timeout: 180000 });
let fit = await fits();
check(fit.fits, `the server's terminal fits (slack ${fit.slack.map(Math.round)})`);
// Drag the editor/terminal separator up, then the tree/work separator.
for (const [selector, dx, dy] of [['.separator.horizontal', 0, -150], ['.separator:not(.horizontal)', 120, 0]]) {
  const box = await page.locator(selector).first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  fit = await fits();
  check(fit.fits, `fits after dragging ${selector} (slack ${fit.slack.map(Math.round)})`);
}

await page.locator('button[title="New shell"]').click();
const shell = await page.evaluate(() => Math.max(...window.playground.sessions.keys()));
await page.waitForFunction((i) => /\$ $/.test(window.playground.sessions.get(i).backlog), shell, { timeout: 60000 });
await page.evaluate((i) => window.playground.sessions.get(i).node.input('echo see lib/playground_web/router.ex:17\necho at localhost:4000/missing\n'), shell);
await page.waitForTimeout(500);
await click('router.ex:17');
await page.locator('.tab', { hasText: 'router.ex' }).waitFor({ timeout: 10000 }).then(() => check(true, 'the file link opens router.ex'), () => check(false, 'the file link opens router.ex'));
await click('localhost:4000/missing');
await page.waitForFunction(() => document.querySelector('.preview-bar input')?.value === '/missing', null, { timeout: 10000 })
  .then(() => check(true, 'the address opens in the preview'), () => check(false, 'the address opens in the preview'));
await page.screenshot({ path: '/out/terminal.png' });
await browser.close();
