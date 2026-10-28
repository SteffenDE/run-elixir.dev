// Open the fixture's page and wait for its project's answer (main.js).
import { chromium } from '../../node_modules/playwright/index.mjs';

const port = process.env.PORT || 8099;
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1'] });
try {
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`console: ${message.text()}`);
  });
  const started = Date.now();
  await page.goto(`http://apex.localhost:${port}/`);
  const result = await page.evaluate(() => window.result);
  console.log(`${JSON.stringify(result)} in ${Date.now() - started} ms`);
  if (result.out !== '42\n/work\n' || result.exit?.code !== 0) process.exitCode = 1;
} finally {
  await browser.close();
}
