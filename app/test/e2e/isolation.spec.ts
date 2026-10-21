import { expect, test } from './fixtures';
import {
  APEX,
  newProject,
  output,
  prompted,
  readText,
  serverRunning,
  USERCONTENT,
  writeText,
  run,
} from './helpers';

// What a project's code runs, runs on the usercontent domain, another site
// than the apex (docs/frames.md): its worker in the project's exec frame,
// which holds none of the apex's stores.
const APP_CSS = '/work/playground/assets/css/app.css';
const BUILT_CSS = '/work/playground/priv/static/assets/css/app.css';

test("the project runs in an exec frame of the usercontent domain's", async ({
  page,
  browserName,
}) => {
  const id = await newProject(page, 'empty');
  await prompted(page, 1);
  const src = await page.locator('iframe[src*="/exec.html"]').getAttribute('src');
  expect(src).toBe(`http://e-${id}.${USERCONTENT}/exec.html`);
  // Playwright reaches no frame of another site in Firefox.
  if (browserName === 'firefox') return;
  const exec = page.frames().find((frame) => frame.url().includes('/exec.html'))!;
  const inside = await exec.evaluate(async () => ({
    isolated: crossOriginIsolated,
    databases: indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [],
    cookie: document.cookie,
  }));
  expect(inside.isolated).toBe(true);
  // The apex's projects' list, and this project's stores, are not here.
  expect(inside.databases).not.toContain('playground');
  expect(inside.databases.filter((name) => name?.includes(id))).toEqual([]);
  expect(APEX).not.toContain(USERCONTENT);
});

test('a Tailwind plugin of the project runs in its exec frame, not on the apex', async ({
  page,
  context,
}) => {
  const id = await newProject(page, 'phoenix');
  await serverRunning(page);
  // Tailwind's watcher built once (and watches).
  await expect.poll(() => output(page), { timeout: 120_000 }).toMatch(/Done in \d+/);
  const other = await context.newPage();
  await newProject(other, 'empty');
  await prompted(other, 1);
  await run(other, 'ln -s /work /shared/to-work');
  // A plugin that writes where it ran into the CSS it adds.
  await writeText(
    page,
    '/work/playground/assets/vendor/probe.js',
    `const original = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function(message, ...args) {
  if (message?.event === 'css') {
    const record = path => ({path, kind: 'file', data: new TextEncoder().encode('from plugin'), mtime: '0'});
    for (const path of ['/work/foreign.txt', '/shared/../work/foreign.txt', '/shared/to-work/foreign.txt', '/shared/valid-probe'])
      original.call(this, {event: 'kept', data: [record(path)]});
  }
  return original.call(this, message, ...args);
};
module.exports = require("tailwindcss/plugin")(function ({ addBase }) {
  addBase({ ":root": { "--probe-origin": JSON.stringify(self.location.origin) } });
});
`,
  );
  const css = await readText(page, APP_CSS);
  await writeText(page, APP_CSS, `${css}\n@plugin "../vendor/probe.js";\n`);
  await expect
    .poll(() => readText(page, BUILT_CSS).catch(() => ''), { timeout: 120_000 })
    .toContain(`e-${id}.${USERCONTENT}`);
  // A permitted shared update proves the forged messages reached the
  // receiver; foreign paths and traversal through its links stay out.
  await expect.poll(() => readText(other, '/shared/valid-probe')).toBe('from plugin');
  expect(await other.evaluate(() => window.playground.files.stat('/work/foreign.txt'))).toBeNull();
});
