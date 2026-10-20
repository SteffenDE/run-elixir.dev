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
}) => {
  const id = await newProject(page, 'phoenix');
  await serverRunning(page);
  // Tailwind's watcher built once (and watches).
  await expect.poll(() => output(page), { timeout: 120_000 }).toMatch(/Done in \d+/);
  // A plugin that writes where it ran into the CSS it adds.
  await writeText(
    page,
    '/work/playground/assets/vendor/probe.js',
    `module.exports = require("tailwindcss/plugin")(function ({ addBase }) {
  addBase({ ":root": { "--probe-origin": JSON.stringify(self.location.origin) } });
});
`,
  );
  const css = await readText(page, APP_CSS);
  await writeText(page, APP_CSS, `${css}\n@plugin "../vendor/probe.js";\n`);
  await expect
    .poll(() => readText(page, BUILT_CSS).catch(() => ''), { timeout: 120_000 })
    .toContain(`e-${id}.${USERCONTENT}`);
});
