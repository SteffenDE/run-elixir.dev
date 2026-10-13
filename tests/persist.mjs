// persist.mjs URL: what a project changes is there after a reload.
// An empty project: a file the page writes, one Elixir writes, one the
// shell removes. A Phoenix project: an edited template file, a removed
// one, and a moved directory; the server comes back without recompiling
// the dependencies.
import { chromium, firefox } from 'playwright';
const base = process.argv[2] || 'http://localhost:8081/';
const browser = await (process.env.BROWSER === 'firefox' ? firefox : chromium).launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 300)); });
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);
const check = (ok, what) => { if (!ok) { console.log(`FAIL: ${what}`); process.exitCode = 1; } else log(what); };
const plain = () => page.evaluate(() => window.playground.output.replace(/\x1b\[[0-9;]*m/g, ''));
const prompt = (count) => page.waitForFunction((n) => (window.playground?.output.replace(/\x1b\[[0-9;]*m/g, '').match(/~\S* \$ /g) ?? []).length >= n, count, { timeout: 180000 });
const run = async (line) => {
  const count = ((await plain()).match(/~\S* \$ /g) ?? []).length;
  await page.evaluate((l) => window.playground.node.input(l + '\n'), line);
  await prompt(count + 1);
};
const exists = (path) => page.evaluate((p) => window.playground.files.read(p).then(() => true, () => false), path);
const text = (path) => page.evaluate((p) => window.playground.files.read(p).then((b) => new TextDecoder().decode(b)), path);

// Empty project.
await page.goto(new URL('/empty', base).href);
await page.waitForURL(/\/[a-z0-9]{10}\/$/);
await prompt(1);
await page.evaluate(() => window.playground.files.write('/work/hello.exs', 'IO.puts("kept: " <> File.read!("made.txt"))\n'));
await run(`elixir -e 'File.write!("made.txt", "by elixir"); File.write!("doomed.txt", "x")'`);
await run('rm doomed.txt');
await page.evaluate(() => window.playground.files.flush());
await page.reload();
await prompt(1);
check(!(await exists('/work/doomed.txt')), 'removed file stays removed');
await run('elixir hello.exs');
check((await plain()).includes('kept: by elixir'), 'written files are back after a reload');

// Phoenix project.
await page.goto(new URL('/phoenix', base).href);
await page.waitForURL(/\/[a-z0-9]{10}\/$/);
await page.waitForFunction(() => /Running PlaygroundWeb.Endpoint/.test(window.playground?.output ?? ''), null, { timeout: 180000 });
log('server running');
const app = '/work/playground';
const home = `${app}/lib/playground_web/controllers/page_html/home.html.heex`;
await page.evaluate(([p]) => window.playground.files.read(p).then((b) =>
  window.playground.files.write(p, '<h1 id="kept">Kept across reloads</h1>\n' + new TextDecoder().decode(b))), [home]);
await page.evaluate((p) => window.playground.files.remove(p), `${app}/README.md`);
await page.evaluate(([a, b]) => window.playground.files.rename(a, b), [`${app}/priv/static/images`, `${app}/priv/static/pictures`]);
await page.evaluate(() => window.playground.files.flush());
const reloaded = Date.now();
await page.reload();
await page.waitForFunction(() => /Running PlaygroundWeb.Endpoint/.test(window.playground?.output ?? ''), null, { timeout: 180000 });
const output = await plain();
check(!/Compiling \d+ files? \(\.ex\)\n.*Generated (phoenix|ecto|bandit)/.test(output), `server back in ${((Date.now() - reloaded) / 1000).toFixed(1)} s without recompiling deps`);
check((await text(home)).startsWith('<h1 id="kept">'), 'edited template file is back');
check(!(await exists(`${app}/README.md`)), 'removed template file stays removed');
check(!(await exists(`${app}/priv/static/images/logo.svg`)) && (await exists(`${app}/priv/static/pictures/logo.svg`)), 'moved directory stays moved');
await page.frameLocator('.preview iframe').locator('#kept').waitFor({ timeout: 60000 }).then(() => log('preview shows the kept edit'), () => check(false, 'preview shows the kept edit'));
await page.screenshot({ path: '/out/persist.png' });
await browser.close();
