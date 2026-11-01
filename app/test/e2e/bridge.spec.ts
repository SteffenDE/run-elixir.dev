// Bridge mode (docs/frames.md): the test embedder runs projects on a shared
// usercontent domain (serve.py --bridge bridge.localhost:PORT) that serves
// only /bridge.html and /sw.js. The embedder serves the packages itself, at
// their published paths, and its worker answers the frames; the backend's
// services are the apex's (serve.py's apex host, which names the embedder).
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { EMBEDDER, embedded, get, previewText, run } from './embedder';
import { gitHttp, sh } from '../fake-github';
import { ESCAPES } from './escapes';
import { PORT } from './helpers';

const BRIDGE = `bridge.localhost:${PORT}`;

test('an embedder without a usercontent domain runs a Phoenix project and its preview', async ({
  page,
  browserName,
}) => {
  const took = await embedded(page, { template: 'phoenix' }, { bridged: true });
  console.log(`${browserName}: bridged create() in ${Math.round(took)} ms`);
  const frame = await page.evaluate(() =>
    document.querySelector('#frames iframe')?.getAttribute('src'),
  );
  expect(frame).toMatch(
    new RegExp(`^http://e-[a-z0-9]{10}\\.${BRIDGE.replace(/\./g, '\\.')}/bridge\\.html$`),
  );

  await page.evaluate(() => window.sandbox.fs.write('/work/playground/hello.txt', 'bridged'));
  const echoed = await run(page, 'cat hello.txt && elixir -e "IO.puts(6 * 7)"');
  expect(echoed).toEqual({ stdout: 'bridged42\n', stderr: '', code: 0 });

  // The runtime's seam counted its fs bundles' reads (lib/apexLink.ts).
  const reads = await page.evaluate(() =>
    window.sandbox.exec.call('debug').then((d: { reads: unknown }) => d.reads),
  );
  expect(reads.bundles.count).toBeGreaterThan(10);

  await page.evaluate(() => {
    const server = window.sandbox.sh('mix phx.server');
    window.embed.server = '';
    const keep = (bytes: Uint8Array) => (window.embed.server += new TextDecoder().decode(bytes));
    server.onStdout(keep);
    server.onStderr(keep);
  });
  await page.waitForFunction(
    () => /Running PlaygroundWeb.Endpoint/.test(window.embed.server),
    null,
    {
      timeout: 240_000,
    },
  );
  expect(await get(page, 4000, '/')).toContain('Phoenix Framework');

  // The preview's relay comes through the bridge too; the preview is the
  // app's, through the same service worker.
  const url = await page.evaluate(() => window.sandbox.previewUrl(4000));
  expect(url).toMatch(
    new RegExp(`^http://v-[a-z0-9]{10}-4000\\.${BRIDGE.replace(/\./g, '\\.')}/$`),
  );
  await page.evaluate((at) => {
    const preview = document.createElement('iframe');
    preview.src = at;
    preview.id = 'preview';
    preview.style.width = '800px';
    preview.style.height = '600px';
    document.body.append(preview);
  }, url);
  await expect.poll(() => previewText(page), { timeout: 60_000 }).toContain('Phoenix Framework');
  if (browserName !== 'firefox')
    await expect(page.frameLocator('#preview').getByText('Peace of mind').first()).toBeVisible();
});

test('git reaches its proxy through the apex’s worker, with the embedder’s Origin', async ({
  page,
  context,
}) => {
  // A repository on the apex's git proxy, as GitHub's would be.
  const dir = mkdtempSync(join(tmpdir(), 'bridge-git-'));
  sh(dir, ['init', '-q', '-b', 'main', 'work']);
  const work = join(dir, 'work');
  sh(work, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'bridged',
  ]);
  sh(dir, ['clone', '-q', '--bare', work, 'bare']);
  const origins: (string | null)[] = [];
  await context.route(/\/git\/github\.com\/bridge\/demo(\.git)?\//, async (route) => {
    const request = route.request();
    origins.push(await request.headerValue('origin'));
    const answer = gitHttp(
      join(dir, 'bare'),
      request.url(),
      request.method(),
      request.postDataBuffer(),
    );
    await route.fulfill({
      status: answer.status,
      headers: {
        'content-type': answer.contentType,
        'access-control-allow-origin': new URL(EMBEDDER).origin,
      },
      body: answer.body,
    });
  });
  await embedded(page, { template: 'empty' }, { bridged: true });
  const cloned = await run(
    page,
    'git clone -q https://github.com/bridge/demo.git /work/demo && git -C /work/demo log --format=%s',
  );
  expect(cloned.stdout).toBe('bridged\n');
  expect(origins.length).toBeGreaterThan(0);
  expect(new Set(origins)).toEqual(new Set([new URL(EMBEDDER).origin]));
});

test('the shared domain hosts nothing top-level', async ({ context }) => {
  // Its bootstrap refuses to run outside a frame: no service worker. (A
  // page of its own: the fixture's fails on the error it throws.)
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://e-abcdefghij.${BRIDGE}/bridge.html`);
  await expect.poll(() => errors.join()).toContain('only in a frame');
  expect(
    await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)),
  ).toBe(0);
  // And nothing else is there: a bridge's paths are its service worker's.
  for (const path of [
    '/npm/@elixir-playground/runtime@1.1.0/exec.html',
    '/_bridge/abcdefghijklmnopqrstuv/x.html',
    '/relay',
    '/api/v1/nif/x/1',
    '/git/github.com/a/b/info/refs',
  ])
    expect((await page.request.get(`http://e-abcdefghij.${BRIDGE}${path}`)).status(), path).toBe(
      404,
    );
});

test('the services answer the apex and the origins on the list, never a usercontent domain', async ({
  request,
}) => {
  const apex = `http://playground.localhost:${PORT}`;
  const nif = '/api/v1/nif/nif_fixture/0.1.0?abi=1-2.18';
  const from = (origin: string) => ({ headers: { origin, 'sec-fetch-site': 'cross-site' } });
  const embedder = await request.get(`${apex}${nif}`, from(new URL(EMBEDDER).origin));
  expect(embedder.status()).not.toBe(403);
  expect(embedder.headers()['access-control-allow-origin']).toBe(new URL(EMBEDDER).origin);
  expect((await request.get(`${apex}${nif}`, from('https://stranger.example'))).status()).toBe(403);
  // The usercontent domains' hosts serve their bridge's files and nothing
  // else (the apex's worker asks for the services).
  for (const domain of [`usercontent.localhost:${PORT}`, BRIDGE])
    expect((await request.get(`http://e-abcdefghij.${domain}${nif}`)).status(), domain).toBe(404);
});

// The Node.js worker's policy comes from the service worker in bridge mode
// (swBridge.ts workerPolicy): each browser applies a policy a service worker
// made to the worker it answered (docs/frames.md). Its TLS roots come from
// the embedder directly, which the policy names.
test('a Node.js process reaches no network but its own, bridged', async ({ page }) => {
  await embedded(page, { template: 'empty' }, { bridged: true });
  await page.evaluate((script) => window.sandbox.fs.write('/work/escape.js', script), ESCAPES);
  const { stdout } = await run(page, 'node /work/escape.js');
  for (const name of [
    'fetch',
    'xhr',
    'import',
    'websocket',
    'eventsource',
    'worker',
    'cache',
    'thread',
  ])
    expect(stdout, name).toContain(`escape ${name}: blocked`);
  expect(stdout).toContain('escape roots: loaded');
});

// A NIF library from the backend (serve.py --nif answers as the backend
// would: tests/nif/build.py), which the apex's worker asks for with the
// embedder's Origin.
test('a NIF package builds from the backend, through the apex’s worker', async ({ page }) => {
  test.skip(
    !existsSync('../target/test-nif/libraries'),
    'no NIF fixtures (python3 -I tests/nif/build.py)',
  );
  test.setTimeout(900_000);
  await embedded(page, { template: 'empty' }, { bridged: true });
  const fixture = '../tests/nif/nif_fixture';
  for (const file of [
    'mix.exs',
    'Makefile',
    'hex_metadata.config',
    'lib/nif_fixture.ex',
    'c_src/nif_fixture.cpp',
  ])
    await page.evaluate(
      ([path, text]) => window.sandbox.fs.write(path, text),
      [`/work/nif_fixture/${file}`, readFileSync(`${fixture}/${file}`, 'utf8')],
    );
  expect((await run(page, 'cd /work && mix new demo')).code).toBe(0);
  const mix = await page.evaluate(async () =>
    new TextDecoder().decode(await window.sandbox.fs.read('/work/demo/mix.exs')),
  );
  await page.evaluate(
    (text) => window.sandbox.fs.write('/work/demo/mix.exs', text),
    mix.replace(
      /defp deps do\n\s*\[/,
      'defp deps do\n    [{:nif_fixture, path: "../nif_fixture"},',
    ),
  );
  expect((await run(page, 'cd /work/demo && mix deps.get')).stdout).toMatch(/elixir_make/);
  const used = await run(page, `cd /work/demo && mix run -e 'IO.inspect(NifFixture.add(2, 40))'`);
  expect(used.stdout + used.stderr).toContain(
    "make: nif_fixture 0.1.0's native code, built to WebAssembly",
  );
  expect(used.stdout).toContain('42');
});

// The claude frame comes through the bridge too (its own salted origin),
// and prepares Claude Code from the npm registry as in today's mode.
test('Claude Code runs in bridge mode', async ({ page }) => {
  test.setTimeout(600_000);
  await embedded(page, { template: 'empty' }, { bridged: true });
  const frame = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('iframe')]
        .map((each) => each.src)
        .find((src) => /\/\/claude-/.test(src)),
    );
  const { stdout, code } = await run(page, 'claude --version');
  expect(code).toBe(0);
  expect(stdout).toMatch(/\(Claude Code\)/);
  expect(await frame()).toMatch(
    new RegExp(`^http://claude-[a-z0-9]{10}\\.${BRIDGE.replace(/\./g, '\\.')}/bridge\\.html$`),
  );
});

test('two sandboxes on one page keep their own usercontent domains and bridges', async ({
  page,
}) => {
  await page.goto(EMBEDDER);
  await page.waitForFunction(() => window.embed);
  const result = await page.evaluate(async () => {
    const container = document.getElementById('frames');
    const project = { template: 'empty' };
    const first = await window.embed.create({ ...window.embed.bridged(), project, container });
    const second = await window.embed.create({ ...window.embed.options, project, container });
    // The first one's preview, asked for after the second create(): on its
    // own domain, through its own bridge.
    const urls = [await first.previewUrl(4000), await second.previewUrl(4000)];
    const relays = () =>
      [...document.querySelectorAll('iframe[aria-hidden="true"]')]
        .map((frame) => (frame as HTMLIFrameElement).src)
        .filter((src) => /\/\/v-/.test(src))
        .sort();
    const before = relays();
    const echo = async (sandbox: typeof first) => {
      const process = sandbox.sh('echo $((6 * 7))');
      let out = '';
      process.onStdout((bytes: Uint8Array) => (out += new TextDecoder().decode(bytes)));
      await process.exited;
      return out;
    };
    const outputs = [await echo(first), await echo(second)];
    // Each sandbox's relays go with it, and only its own.
    await first.shutdown();
    const after = relays();
    await second.shutdown();
    return { urls, before, after, outputs };
  });
  const host = (domain: string) => domain.replace(/\./g, '\\.');
  expect(result.urls[0]).toMatch(new RegExp(`^http://v-[a-z0-9]{10}-4000\\.${host(BRIDGE)}/$`));
  expect(result.urls[1]).toMatch(
    new RegExp(`^http://v-[a-z0-9]{10}-4000\\.usercontent\\.localhost:${PORT}/$`),
  );
  // Each relay is its own domain's bootstrap.
  expect(result.before.sort()).toEqual(
    result.urls.map((url: string) => `${url}bridge.html`).sort(),
  );
  expect(result.after).toEqual([`${result.urls[1]}bridge.html`]);
  expect(result.outputs).toEqual(['42\n', '42\n']);
});

test('a kept project keeps its files when the page loses its salt', async ({ page }) => {
  const project = { id: 'kept-project', template: 'empty', persist: true };
  await embedded(page, project);
  await page.evaluate(() => window.sandbox.fs.write('/work/playground/kept.txt', 'kept'));
  const before = await page.evaluate(() => window.sandbox.projectId);
  await page.evaluate(() => window.sandbox.shutdown());
  // A new salt (local storage cleared of it): the project's origins have
  // another name; its files, kept on this page's origin without the salt,
  // are where they were.
  await page.evaluate(() => localStorage.removeItem('playground-bridge-salt'));
  await embedded(page, project);
  expect(await page.evaluate(() => window.sandbox.projectId)).not.toBe(before);
  expect(await run(page, 'cat /work/playground/kept.txt')).toEqual({
    stdout: 'kept',
    stderr: '',
    code: 0,
  });
});
