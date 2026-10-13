// shells.mjs URL: a second shell generates a LiveView while the server runs.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);
await page.goto(process.argv[2]);
await page.waitForFunction(() => /Running PlaygroundWeb.Endpoint/.test(window.playground?.output ?? ''), null, { timeout: 120000 });
log('server running');
await page.locator('button[title^="New shell"]').click();
const shell = await page.evaluate(() => Math.max(...window.playground.sessions.keys()));
const out = (id) => page.evaluate((i) => window.playground.sessions.get(i).backlog, id);
const prompted = (id, from) => page.waitForFunction(([i, n]) => /~\/playground \$ $/.test(window.playground.sessions.get(i).backlog.slice(n)), [id, from], { timeout: 900000, polling: 300 });
await prompted(shell, 0);
log(`shell ${shell} ready`);
async function run(cmd) {
  const from = (await out(shell)).length;
  await page.evaluate(([i, c]) => window.playground.sessions.get(i).node.input(c + '\n'), [shell, cmd]);
  await prompted(shell, from).catch(() => log('TIMEOUT'));
  log(`done: ${cmd.slice(0, 70)}`);
  console.log((await out(shell)).slice(from).replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => !/creating|injecting/.test(l)).slice(-12).join('\n'));
}
await run('mix phx.gen.live Blog Post posts title:string body:text');
await run(`elixir -e 'p = "lib/playground_web/router.ex"; File.write!(p, String.replace(File.read!(p), ~s(get "/", PageController, :home), ~s(get "/", PageController, :home\\n    live "/posts", PostLive.Index, :index\\n    live "/posts/new", PostLive.Form, :new\\n    live "/posts/:id", PostLive.Show, :show\\n    live "/posts/:id/edit", PostLive.Form, :edit), global: false))'`);
await run('mix ecto.migrate');
log(`tree has post_live: ${await page.evaluate(() => window.playground && document.querySelector('.file-tree') !== null)}`);
await page.locator('.preview-bar input').fill('/posts/new');
await page.locator('.preview-bar input').press('Enter');
const frame = page.frameLocator('.preview iframe');
await frame.locator('#post-form').waitFor({ timeout: 600000 }).then(() => log('form shown'), () => log('form NOT shown'));
await page.waitForTimeout(3000);
await frame.locator('#post_title').fill('Hello from a second shell');
await frame.locator('#post_body').fill('Generated while the server ran.');
await frame.locator('#post-form button').last().click();
await frame.getByText('Hello from a second shell').first().waitFor({ timeout: 120000 }).then(() => log('post saved and listed'), () => log('post NOT shown'));
await page.screenshot({ path: '/out/shells.png' });
console.log((await page.evaluate(() => window.playground.output)).replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /error|Error|Compiling|POST|live|Sent 5/.test(l)).slice(-15).join('\n'));
await browser.close();
