// popout.mjs URL: the Phoenix playground's bars line up; the preview pops
// out into its own window, which shows the app, and docks again.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(process.argv[2]);
await page.frameLocator('.preview iframe').getByText('Peace of mind').waitFor({ timeout: 120000 });
// Bars: open a file so the tab bar shows.
await page.getByRole('treeitem', { name: 'mix.exs', exact: true }).click();
await page.locator('.tab').first().waitFor();
const heights = await page.evaluate(() => ['.tab-bar', '.preview-bar'].map((s) => document.querySelector(s).getBoundingClientRect().height));
console.log('bar heights', heights);
const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('.preview-bar button[title^="Pop out"]').click()]);
await popup.frameLocator('.preview iframe').getByText('Peace of mind').waitFor({ timeout: 60000 }).then(() => console.log('popup shows the app'), () => console.log('popup does NOT show the app'));
await page.waitForTimeout(500);
console.log('first line visible:', await page.locator('.editor-scroll').getByText('defmodule Playground.MixProject').count());
console.log('docked preview present:', await page.locator('.preview').count(), 'dock button:', await page.getByRole('button', { name: 'Dock preview' }).count());
await page.screenshot({ path: '/out/popped.png' });
await popup.screenshot({ path: '/out/popup.png' });
await page.getByRole('button', { name: 'Dock preview' }).click();
await page.locator('.preview iframe').waitFor({ timeout: 10000 }).then(() => console.log('docked again'), () => console.log('NOT docked again'));
await browser.close();
