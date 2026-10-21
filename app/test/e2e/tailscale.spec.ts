import { expect, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { newShell, output, prompted, run, signIn, writeText } from './helpers';

// Tailscale (docs/tailscale.md): the setup hint a project shows once, and
// (with a Headscale, below) a node's HTTPS through the tailnet and an exit
// node. In Chromium: the node's sockets and the tailnet do not depend on
// the browser past the apex's shared worker.
const PORT = Number(process.env.PORT || 8081);
const APEX = `http://playground.localhost:${PORT}`;
const TAG = 'tag:elixir-playground';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');

const GET = (url: string) =>
  `elixir -e ':inets.start(); :ssl.start(); {:ok, {{_, status, _}, _, body}} = :httpc.request(:get, {~c"${url}", []}, [], body_format: :binary); IO.inspect status; IO.puts binary_part(body, 0, min(byte_size(body), 200))'`;

async function emptyProject(page: Page, apex = APEX): Promise<void> {
  await page.goto(`${apex}/empty`);
  await page.waitForURL(/\/[a-z0-9]{10}\/$/);
  await prompted(page, 1);
}

test('without Tailscale set up, a site the browser would not reach shows the setup once', async ({
  page,
  context,
}) => {
  await emptyProject(page);
  // The top bar's Tailscale menu: the device's state, the way to its page.
  await page.getByRole('button', { name: 'Tailscale: not set up' }).click();
  await expect(page.getByRole('link', { name: 'Tailscale settings' })).toHaveAttribute(
    'href',
    `${APEX}/tailscale`,
  );
  await page.keyboard.press('Escape');

  // www.example.com sends no CORS headers: 502, and the dialog says why
  // and how to set Tailscale up.
  expect(await run(page, GET('https://www.example.com/'))).toContain('502');
  const dialog = page.getByRole('dialog', { name: /www\.example\.com can't be reached/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('pre')).toContainText(`"${TAG}": ["autogroup:member"]`);
  await expect(dialog.locator('pre')).toContainText('"dst": ["autogroup:internet"]');
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(dialog).toBeHidden();

  // Not again: in this project, nor in another (the apex keeps it).
  expect(await run(page, GET('https://www.example.com/'))).toContain('502');
  await emptyProject(page);
  expect(await run(page, GET('https://www.example.com/'))).toContain('502');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The apex's Tailscale page: the steps, and signing in.
  const home = await context.newPage();
  await home.goto(`${APEX}/tailscale`);
  await expect(home.getByRole('heading', { name: 'Tailscale' })).toBeVisible();
  await expect(home.locator('.tailscale-state')).toContainText('not set up');
  await expect(home.locator('.tailscale-policy pre')).toContainText(TAG);
  await expect(home.getByRole('button', { name: 'Sign in with Tailscale' }).first()).toBeEnabled();
});

test('a temporary IEx has the Tailscale menu too', async ({ page }) => {
  await page.goto(`${APEX}/iex`);
  await expect.poll(() => output(page), { timeout: 120_000 }).toMatch(/iex\(1\)> $/);
  await expect(page.getByRole('button', { name: 'Tailscale: not set up' })).toBeVisible();
});

// A server on port 4000 in a second shell of `project`, answering `text`.
async function serve(project: Page, text: string): Promise<void> {
  const shell = await newShell(project);
  void run(
    project,
    `elixir -e '{:ok, l} = :gen_tcp.listen(4000, [:binary, active: false, reuseaddr: true]); serve = fn serve -> {:ok, c} = :gen_tcp.accept(l); {:ok, _} = :gen_tcp.recv(c, 0); :ok = :gen_tcp.send(c, "HTTP/1.0 200 OK\\r\\n\\r\\n${text}"); :gen_tcp.close(c); serve.(serve) end; serve.(serve)'`,
    shell,
  );
}

// What exit-box gets from the device's `port` (the probe's tailscale nc).
async function probe(address: string, port: number): Promise<string> {
  const answer = await fetch(`http://localhost:8093/nc?host=${address}&port=${port}`, {
    method: 'POST',
    body: 'GET / HTTP/1.0\r\n\r\n',
  });
  return answer.text();
}

// With a Headscale (HEADSCALE_URL, HEADSCALE_API_KEY, HEADSCALE_USER) whose
// policy is the setup's and which has an exit node: docs/tailscale.md,
// Testing.
const HEADSCALE = process.env.HEADSCALE_URL;

test('signed in to a tailnet with an exit node, a node reaches any site', async ({
  page,
  context,
}) => {
  test.skip(!HEADSCALE, 'needs HEADSCALE_URL and HEADSCALE_API_KEY');
  test.setTimeout(300_000);
  const name = await signIn(page, context, APEX);
  const state = page.locator('.tailscale-state');

  // A project's node, through the tailnet once the project may (it asks,
  // its request waiting): a site without CORS headers answers, its own
  // TLS over a TCP connection out of the exit node.
  const project = await context.newPage();
  await emptyProject(project);
  await expect(
    project.getByRole('button', { name: /^Tailscale: connected through exit-box/ }),
  ).toBeVisible();
  const answering = run(project, GET('https://www.example.com/'));
  const consent = project.getByRole('dialog', { name: /use your tailnet\?$/ });
  await expect(consent).toContainText('www.example.com');
  await consent.getByRole('button', { name: 'Allow' }).click();
  const answer = await answering;
  expect(answer).toContain('200');
  expect(answer).toContain('Example Domain');
  await expect(project.getByRole('dialog')).toHaveCount(0);

  // The node's own sockets through the tailnet: names from Tailscale's
  // resolver (the exit node's DNS, and MagicDNS), plain TCP (HTTP/1.0 by
  // hand) and UDP (a DNS query to 1.1.1.1 itself) out of the exit node.
  const sockets = await run(
    project,
    `elixir -e '${[
      'IO.inspect(:inet.gethostbyname(~c"www.example.com") |> elem(0), label: "dns")',
      `{:ok, {:hostent, _, _, _, _, [box | _]}} = :inet.gethostbyname(~c"${name}"); IO.inspect(box, label: "magicdns")`,
      '{:ok, {:hostent, _, _, _, _, [short | _]}} = :inet.gethostbyname(~c"exit-box"); IO.inspect(short, label: "short")',
      '{:ok, s} = :gen_tcp.connect(~c"www.example.com", 80, [:binary, active: false], 30_000)',
      '{:ok, {local, _}} = :inet.sockname(s); IO.inspect(local, label: "local")',
      ':ok = :gen_tcp.send(s, "GET / HTTP/1.0\\r\\nHost: www.example.com\\r\\n\\r\\n")',
      '{:ok, head} = :gen_tcp.recv(s, 0, 30_000); IO.inspect(binary_part(head, 0, 12), label: "tcp")',
      '{:ok, msg} = :inet_res.nnslookup(~c"example.com", :in, :a, [{{1, 1, 1, 1}, 53}], 10_000)',
      'IO.inspect(length(:inet_dns.msg(msg, :anlist)) > 0, label: "udp")',
      ':ssl.start(); {:ok, t} = :ssl.connect(~c"www.example.com", 443, [verify: :verify_peer, cacerts: :public_key.cacerts_get(), alpn_advertised_protocols: ["h2", "http/1.1"], customize_hostname_check: [match_fun: :public_key.pkix_verify_hostname_match_fun(:https)]], 30_000)',
      'IO.inspect(:ssl.connection_information(t, [:protocol]), label: "tls")',
      'IO.inspect(:ssl.negotiated_protocol(t), label: "alpn")',
    ].join('; ')}'`,
  );
  expect(sockets).toContain('dns: :ok');
  expect(sockets).toMatch(/magicdns: \{100, \d+, \d+, \d+\}/);
  expect(sockets).toMatch(/tcp: "HTTP\/1\.[01] 200/);
  expect(sockets).toContain('udp: true');
  expect(sockets).toMatch(/short: \{100, \d+, \d+, \d+\}/);
  // Its own end is the device's tailnet address.
  expect(sockets).toMatch(/local: \{100, \d+, \d+, \d+\}/);
  // The node's own TLS: a TLS 1.x session, ALPN as it asked.
  expect(sockets).toMatch(/tls: \{:ok, \[protocol: :"tlsv1\.\d"\]\}/);
  expect(sockets).toMatch(/alpn: \{:ok, "(h2|http\/1\.1)"\}/);

  // A Node.js process's the same ways (nodejs.md): its names, TCP by hand,
  // http.get by name and a DNS query over UDP, out of the exit node.
  await writeText(
    project,
    '/work/away.cjs',
    [
      "const [dns, net, http, dgram] = ['dns', 'net', 'http', 'dgram'].map(require);",
      '(async () => {',
      "  console.log('lookup', (await dns.promises.lookup('www.example.com')).family);",
      "  console.log('short', (await dns.promises.lookup('exit-box')).address);",
      "  const s = net.connect(80, 'www.example.com', () => {",
      "    console.log('local', s.localAddress);",
      "    s.write('GET / HTTP/1.0\\r\\nHost: www.example.com\\r\\n\\r\\n');",
      '  });',
      // Ended once answered: a half-close first, some edges answer none.
      "  s.once('data', (d) => {",
      "    console.log('tcp', d.toString().slice(0, 12));",
      '    s.end();',
      '  });',
      "  await new Promise((done) => s.on('close', done));",
      "  await new Promise((done) => http.get('http://www.example.com/', (r) => {",
      "    console.log('http', r.statusCode);",
      "    r.resume().on('end', done);",
      '  }));',
      "  const u = dgram.createSocket('udp4');",
      '  const q = Buffer.from([0xab, 0xcd, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 7, ...Buffer.from("example"), 3, ...Buffer.from("com"), 0, 0, 1, 0, 1]);',
      "  u.on('message', (m) => { console.log('udp', m.readUInt16BE(6) > 0); u.close(); });",
      "  u.send(q, 53, '1.1.1.1');",
      '})();',
    ].join('\n'),
  );
  const node = await run(project, 'node away.cjs');
  expect(node).toContain('lookup 4');
  expect(node).toMatch(/short 100\.\d+\.\d+\.\d+/);
  expect(node).toMatch(/local 100\.\d+\.\d+\.\d+/);
  expect(node).toMatch(/tcp HTTP\/1\.[01] 200/);
  expect(node).toContain('http 200');
  expect(node).toContain('udp true');

  // Its TLS, its own (rustls, tls.wasm) over the tailnet's TCP: https.get of
  // a site without CORS headers, tls.connect with ALPN, and a certificate
  // the roots refuse, refused or (rejectUnauthorized: false) let through.
  await writeText(
    project,
    '/work/tls.cjs',
    [
      "const [https, tls] = ['https', 'tls'].map(require);",
      '(async () => {',
      "  await new Promise((done) => https.get('https://www.example.com/', (r) => {",
      "    let body = '';",
      "    r.on('data', (c) => (body += c)).on('end', () => {",
      "      console.log('https', r.statusCode, /Example Domain/.test(body));",
      '      done();',
      '    });',
      '  }));',
      '  await new Promise((done) => {',
      "    const s = tls.connect(443, 'www.example.com', { ALPNProtocols: ['h2', 'http/1.1'] }, () => {",
      "      console.log('tls', s.authorized, s.getProtocol(), s.alpnProtocol, s.getPeerCertificate().raw.length > 0);",
      '      s.end();',
      "      s.on('close', done);",
      '    });',
      '  });',
      '  await new Promise((done) =>',
      "    tls.connect(443, 'expired.badssl.com').on('error', (e) => {",
      "      console.log('expired', e.code);",
      '      done();',
      '    }),',
      '  );',
      '  await new Promise((done) => {',
      "    const s = tls.connect(443, 'expired.badssl.com', { rejectUnauthorized: false }, () => {",
      "      console.log('allowed', s.authorized, s.authorizationError);",
      '      s.destroy();',
      '      done();',
      '    });',
      '  });',
      '})();',
    ].join('\n'),
  );
  const secure = await run(project, 'node tls.cjs');
  expect(secure).toContain('https 200 true');
  expect(secure).toMatch(/tls true TLSv1\.[23] (h2|http\/1\.1) true/);
  expect(secure).toContain('expired CERT_HAS_EXPIRED');
  expect(secure).toContain('allowed false CERT_HAS_EXPIRED');

  // A coding agent on Node.js (Pi): its requests are Node's fetch (by the
  // process's https, fetch.ts), so through the tailnet with its own TLS; a
  // key that is none, which Anthropic's API refuses (its answer is what the
  // test needs, not a model's).
  const pi = await run(
    project,
    'npx -y @earendil-works/pi-coding-agent@1.3.0 -p --provider anthropic --model sonnet --api-key sk-ant-none "Say hi"',
  );
  expect(pi).toContain('authentication_error');

  // Erlang distribution to a node in the tailnet, on exit-box's machine:
  // its name through MagicDNS, its epmd and its distribution port (which
  // the test's policy lets the tag reach).
  const remote = await run(
    project,
    `elixir --name pg@127.0.0.1 --cookie playground -e 'IO.inspect(:erpc.call(:"probe@${name}", :erlang, :system_info, [:otp_release]), label: "remote")'`,
  );
  expect(remote).toMatch(/remote: ~c"\d+"/);

  // Inbound: a server on port 4000 in a second shell, shared in the
  // tailnet from the Tailscale menu; exit-box reaches it at the device's
  // address (the probe asks it, with tailscale nc).
  // (The preview asks it too: it answers every connection.)
  const b = await newShell(project);
  void run(
    project,
    `elixir -e '{:ok, l} = :gen_tcp.listen(4000, [:binary, active: false, reuseaddr: true]); serve = fn serve -> {:ok, c} = :gen_tcp.accept(l); {:ok, _} = :gen_tcp.recv(c, 0); :ok = :gen_tcp.send(c, "HTTP/1.0 200 OK\\r\\n\\r\\nfrom the playground"); :gen_tcp.close(c); serve.(serve) end; serve.(serve)'`,
    b,
  );
  await project.getByRole('button', { name: /^Tailscale:/ }).click();
  const menu = project.locator('.tailscale-menu');
  const row = menu.locator('li', { hasText: 'Port 4000' });
  await row.getByRole('button', { name: 'Share' }).click();
  const url = menu.getByRole('link', { name: /:4000\/$/ });
  await expect(url).toBeVisible();
  const address = /100\.\d+\.\d+\.\d+/.exec(await page.locator('.tailscale-facts').innerText())![0];
  expect(await probe(address, 4000)).toContain('from the playground');
  await project.keyboard.press('Escape');

  // The tag may use exit nodes, not reach the tailnet's devices: the exit
  // node's own name (MagicDNS) does not answer (the dial times out).
  const inside = await run(project, GET(`https://${name}/`));
  expect(inside).toContain('etimedout');

  // Another project, refused: no tailnet for its code; the apex's page
  // lists both.
  const other = await context.newPage();
  await emptyProject(other);
  const refusing = run(
    other,
    `elixir -e 'IO.inspect(:gen_tcp.connect({1, 1, 1, 1}, 53, [], 30_000))'`,
  );
  await other
    .getByRole('dialog', { name: /use your tailnet\?$/ })
    .getByRole('button', { name: 'Not this project' })
    .click();
  expect(await refusing).toContain('{:error, :enetunreach}');
  await page.reload();
  const projects = page.locator('.tailscale-projects');
  await expect(projects.locator('li', { hasText: 'may use it' })).toHaveCount(1);
  await expect(projects.locator('li', { hasText: 'may not use it' })).toHaveCount(1);

  await page.locator('.tailscale-device').getByRole('button', { name: 'Sign out' }).click();
  await expect(state).toContainText('signed out', { timeout: 30_000 });
});

test('two projects share their port 4000: at another port, or one takes it; a closed tab frees it', async ({
  page,
  context,
}) => {
  test.skip(!HEADSCALE, 'needs HEADSCALE_URL and HEADSCALE_API_KEY');
  test.setTimeout(300_000);
  await signIn(page, context, APEX);
  const address = /100\.\d+\.\d+\.\d+/.exec(await page.locator('.tailscale-facts').innerText())![0];
  const menuOf = async (project: Page) => {
    await project.getByRole('button', { name: /^Tailscale:/ }).click();
    return project.locator('.tailscale-menu');
  };
  const portRow = (menu: Locator) => menu.locator('li', { hasText: /Port 4000|:4000\/|:4001\// });

  // A shares its 4000.
  const a = await context.newPage();
  await emptyProject(a);
  await serve(a, 'from A');
  const menuA = await menuOf(a);
  await portRow(menuA).getByRole('button', { name: 'Share' }).click();
  await expect(menuA.getByRole('link', { name: /:4000\/$/ })).toBeVisible();
  await expect.poll(() => probe(address, 4000)).toContain('from A');

  // B's 4000: the device's is A's; B's at 4001 instead.
  const b = await context.newPage();
  await emptyProject(b);
  await serve(b, 'from B');
  const menuB = await menuOf(b);
  await portRow(menuB).getByRole('button', { name: 'Share', exact: true }).click();
  await expect(menuB).toContainText('port 4000 is shared already, by another project');
  await portRow(menuB).getByRole('button', { name: 'Share as port 4001' }).click();
  await expect(menuB.getByRole('link', { name: /:4001\/ \(port 4000\)$/ })).toBeVisible();
  expect(await probe(address, 4001)).toContain('from B');
  expect(await probe(address, 4000)).toContain('from A');

  // B takes 4000 from A, which says so.
  await portRow(menuB).getByRole('button', { name: 'Stop' }).click();
  await portRow(menuB).getByRole('button', { name: 'Share', exact: true }).click();
  await portRow(menuB).getByRole('button', { name: 'Share here instead' }).click();
  await expect(menuB.getByRole('link', { name: /:4000\/$/ })).toBeVisible();
  await expect.poll(() => probe(address, 4000)).toContain('from B');
  await expect(menuA).toContainText('another project shares port 4000 now');

  // B's tab closes: the port is free at once, a third project shares it
  // with a plain Share.
  await b.close();
  const c = await context.newPage();
  await emptyProject(c);
  await serve(c, 'from C');
  const menuC = await menuOf(c);
  await portRow(menuC).getByRole('button', { name: 'Share', exact: true }).click();
  await expect(menuC.getByRole('link', { name: /:4000\/$/ })).toBeVisible();
  await expect.poll(() => probe(address, 4000)).toContain('from C');
});

// The same site with the backend's relay (live sessions), as live.spec.
const LIVE_APEX = `http://playground.localhost:${PORT + 2}`;

test('a live session keeps the tailnet, or keeps it off while a guest may type if the host says', async ({
  page,
  context,
  browser,
  request,
}) => {
  test.skip(!HEADSCALE, 'needs HEADSCALE_URL and HEADSCALE_API_KEY');
  const backend = await request.get('http://localhost:4000/socket/websocket').catch(() => null);
  test.skip(!backend, 'no backend at localhost:4000 (mix phx.server in backend/)');
  test.setTimeout(300_000);
  await signIn(page, context, LIVE_APEX);
  const project = await context.newPage();
  await emptyProject(project, LIVE_APEX);
  const connect = `elixir -e 'IO.inspect(:gen_tcp.connect(~c"www.example.com", 80, [], 30_000) |> elem(0), label: "tcp")'`;
  const first = run(project, connect);
  await project
    .getByRole('dialog', { name: /use your tailnet\?$/ })
    .getByRole('button', { name: 'Allow' })
    .click();
  expect(await first).toContain('tcp: :ok');

  // A live session whose guests may use the terminals, and a guest in.
  await project.getByRole('button', { name: 'Share' }).click();
  await project.getByRole('button', { name: /^Live session/ }).click();
  await project.getByRole('button', { name: 'Start live session' }).click();
  const field = project.getByLabel('Link to this live session');
  await expect(field).toHaveValue(new RegExp(`^${LIVE_APEX}/live/`));
  await project.locator('.live-switches').getByLabel('Terminals').check();
  const link = await field.inputValue();
  const guests = await browser.newContext();
  const guest = await guests.newPage();
  await guest.goto(link);
  await guest.getByRole('button', { name: 'Join' }).click();
  await expect(guest.locator('.terminal-panel, .xterm').first()).toBeVisible();
  await project.keyboard.press('Escape');

  // By default the project keeps the tailnet with a guest in.
  expect(await run(project, connect)).toContain('tcp: :ok');

  // The host's choice: no tailnet while a guest may type or edit; the
  // menu says why.
  await project.getByRole('button', { name: 'Live' }).click();
  await project.getByLabel('No tailnet for this project while a guest may type or edit').check();
  await project.keyboard.press('Escape');
  expect(await run(project, connect)).toContain('tcp: :error');
  await project.getByRole('button', { name: /^Tailscale:/ }).click();
  await expect(project.locator('.tailscale-menu')).toContainText(
    'Off while a guest of the live session may type or edit',
  );
  await project.keyboard.press('Escape');

  // Once the guest has gone, the tailnet again.
  await guests.close();
  await expect
    .poll(async () => (await run(project, connect)).includes('tcp: :ok'), { timeout: 60_000 })
    .toBe(true);
});
