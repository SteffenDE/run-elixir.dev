import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { newProject, newShell, output, prompted, run, seesInPreview, writeText } from './helpers';

// A Node.js process's connections: to the page's services, to other
// processes' servers and to a node's, and a node's to a process's.

// Starts `line` in a new shell, and waits for `ready` in its output.
async function background(page: Page, line: string, ready: string | RegExp): Promise<number> {
  const shell = await newShell(page);
  await page.evaluate(([id, text]) => window.playground.sessions.get(id).node.input(`${text}\n`), [
    shell,
    line,
  ] as const);
  await expect.poll(() => output(page, shell), { timeout: 120_000 }).toMatch(ready);
  return shell;
}

test('a Node.js process queries the project’s Postgres with pg', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(page, '/work/package.json', JSON.stringify({ name: 'app', private: true }));
  expect(await run(page, 'npm install pg')).toMatch(/added \d+ packages/);
  await writeText(
    page,
    '/work/db.cjs',
    [
      "const { Client } = require('pg');",
      "const client = new Client({ host: 'localhost', port: 5432, user: 'postgres', password: 'postgres', database: 'postgres' });",
      '(async () => {',
      '  await client.connect();',
      "  await client.query('CREATE TABLE notes (id serial PRIMARY KEY, body text)');",
      "  await client.query('INSERT INTO notes (body) VALUES ($1)', ['from Node']);",
      "  const { rows } = await client.query('SELECT id, body FROM notes');",
      '  console.log(JSON.stringify(rows));',
      '  await client.end();',
      '})();',
    ].join('\n'),
  );
  const ran = await run(page, 'node db.cjs; echo "status $?"');
  expect(ran).toContain('[{"id":1,"body":"from Node"}]');
  expect(ran).toContain('status 0');
  // Nothing listens on 4999.
  expect(
    await run(
      page,
      `node -e "require('net').connect(4999).on('error', (e) => console.log(e.code))"`,
    ),
  ).toContain('ECONNREFUSED');
});

test('Node.js processes talk HTTP, and Vite proxies to a backend', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(
    page,
    '/work/package.json',
    JSON.stringify({ name: 'app', private: true, type: 'module', scripts: { dev: 'vite' } }),
  );
  await writeText(
    page,
    '/work/server.cjs',
    [
      "require('http').createServer((req, res) => {",
      "  let body = '';",
      "  req.on('data', (c) => (body += c));",
      "  req.on('end', () => {",
      "    res.setHeader('content-type', 'application/json');",
      '    res.end(JSON.stringify({ method: req.method, url: req.url, body }));',
      '  });',
      "}).listen(3000, () => console.log('backend up'));",
    ].join('\n'),
  );
  await writeText(
    page,
    '/work/client.cjs',
    [
      "const http = require('http');",
      "http.get('http://localhost:3000/api/hello?x=1', (res) => {",
      "  let text = '';",
      "  res.on('data', (c) => (text += c));",
      "  res.on('end', () => {",
      "    console.log('get', res.statusCode, res.headers['content-type'], text);",
      "    const req = http.request({ port: 3000, path: '/api/post', method: 'POST' }, (r) => {",
      "      let t = '';",
      "      r.on('data', (c) => (t += c));",
      "      r.on('end', () => console.log('post', r.statusCode, t));",
      '    });',
      "    req.write('one,');",
      "    req.end('two');",
      '  });',
      '});',
    ].join('\n'),
  );
  await writeText(
    page,
    '/work/vite.config.js',
    "export default { server: { proxy: { '/api': 'http://localhost:3000' } } };\n",
  );
  await writeText(
    page,
    '/work/index.html',
    '<!doctype html>\n<h1 id="answer"></h1>\n<script type="module">\nconst answer = await (await fetch("/api/hello")).json();\ndocument.getElementById("answer").textContent = `${answer.method} ${answer.url}`;\n</script>\n',
  );
  expect(await run(page, 'npm install vite')).toMatch(/added \d+ packages/);
  await background(page, 'node server.cjs', /^backend up$/m);

  const client = await run(page, 'node client.cjs');
  expect(client).toContain(
    'get 200 application/json {"method":"GET","url":"/api/hello?x=1","body":""}',
  );
  expect(client).toContain('post 200 {"method":"POST","url":"/api/post","body":"one,two"}');

  // The page Vite serves asks /api, which Vite's proxy takes to the backend.
  // The frame goes from the backend's origin to Vite's as Vite starts.
  await page.evaluate(() => window.playground.sessions.get(1).node.input('npm run dev\n'));
  await seesInPreview(page, 'GET /api/hello', 120_000);
});

test('a Node.js process and a node reach each other’s servers', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  // A node's server on 4100, the same answer to each connection (the
  // preview's too, which shows it).
  await background(
    page,
    `elixir -e '{:ok, l} = :gen_tcp.listen(4100, [:binary, active: false, reuseaddr: true]); IO.puts("beam up"); serve = fn serve -> {:ok, s} = :gen_tcp.accept(l); {:ok, _} = :gen_tcp.recv(s, 0); :gen_tcp.send(s, "HTTP/1.1 200 OK\\r\\ncontent-length: 9\\r\\nconnection: close\\r\\n\\r\\nfrom beam"); :gen_tcp.close(s); serve.(serve) end; serve.(serve)'`,
    /^beam up$/m,
  );
  expect(
    await run(
      page,
      `node -e "require('http').get('http://localhost:4100/', (r) => r.on('data', (d) => console.log(r.statusCode, String(d))))"`,
    ),
  ).toContain('200 from beam');

  // A process's server, which a node asks.
  await writeText(
    page,
    '/work/server.cjs',
    "require('http').createServer((req, res) => res.end('from node ' + req.url)).listen(3001, () => console.log('node up'));\n",
  );
  await background(page, 'node server.cjs', /^node up$/m);
  expect(
    await run(
      page,
      `elixir -e ':inets.start(); {:ok, {{_, status, _}, _, body}} = :httpc.request(~c"http://localhost:3001/asked"); IO.puts("#{status} #{body}")'`,
    ),
  ).toContain('200 from node /asked');
});

// HTTPS goes by the page's fetch, as a node's does (https.ts).
test('a Node.js process’s https.get goes by the page’s fetch', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(
    page,
    '/work/get.cjs',
    [
      "const https = require('https');",
      'https',
      "  .get(process.argv[2], { headers: { accept: 'application/json' } }, (res) => {",
      "    let body = '';",
      "    res.on('data', (c) => (body += c));",
      "    res.on('end', () => console.log(res.statusCode, res.headers['content-type'], body.slice(0, 200)));",
      '  })',
      "  .on('error', (e) => console.log('error', e.message));",
    ].join('\n'),
  );
  // hex.pm's API sends CORS headers: its JSON.
  const hex = await run(page, 'node get.cjs https://hex.pm/api/packages/jason');
  expect(hex).toContain('200 application/json');
  expect(hex).toContain('"name":"jason"');
  // A site without them: the page answers why.
  const plain = await run(page, 'node get.cjs https://www.example.com/');
  expect(plain).toContain('502 text/plain');
  expect(plain).toContain('failed in the browser');
});

// Other hosts go through the user's tailnet, as a node's do
// (docs/tailscale.md): without Tailscale, an address is out of reach and a
// name not found, each at once; an http.get by name fails as its lookup.
test('a Node.js process’s other hosts and names, without Tailscale', async ({ page }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(
    page,
    '/work/away.cjs',
    [
      "const net = require('net');",
      "const dns = require('dns');",
      "const http = require('http');",
      'const t = Date.now();',
      'const said = (what, e) => console.log(what, e.code, e.syscall);',
      "net.connect(80, '93.184.215.14').on('error', (e) => {",
      "  said('connect', e);",
      "  dns.lookup('www.example.com', (e) => {",
      "    said('lookup', e);",
      "    dns.promises.resolve4('www.example.com').catch((e) => {",
      "      said('resolve4', e);",
      "      dns.lookup('localhost', (_, address) => {",
      "        console.log('localhost', address);",
      "        http.get('http://www.example.com/').on('error', (e) => {",
      "          said('http', e);",
      '          console.log(`took ${Date.now() - t} ms`);',
      '        });',
      '      });',
      '    });',
      '  });',
      '});',
    ].join('\n'),
  );
  const away = await run(page, 'node away.cjs');
  expect(away).toContain('connect ENETUNREACH connect');
  expect(away).toContain('lookup ENOTFOUND getaddrinfo');
  expect(away).toContain('resolve4 ENOTFOUND queryA');
  expect(away).toContain('localhost 127.0.0.1');
  expect(away).toContain('http ENOTFOUND getaddrinfo');
  expect(Number(/took (\d+) ms/.exec(away)?.[1])).toBeLessThan(1500);
});

// dgram on the project's UDP, as a node's: between processes and nodes as
// on one machine, the node's DNS on 127.0.0.53, and (without Tailscale)
// another host's datagrams dropped.
test('a Node.js process’s UDP: processes, nodes and the DNS', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(
    page,
    '/work/echo.cjs',
    [
      "const s = require('dgram').createSocket('udp4');",
      "s.on('message', (m, r) => {",
      '  console.log(`served ${m} from ${r.address}`);',
      "  s.send(`re:${m}`, r.port, r.address, () => m.toString() === 'last' && s.close());",
      '});',
      "s.bind(41300, () => console.log('echo on', s.address().port));",
    ].join('\n'),
  );
  // Sends `text` to `port` until it is answered; prints the answer.
  await writeText(
    page,
    '/work/ask.cjs',
    [
      "const dgram = require('dgram');",
      'const [port, text] = [Number(process.argv[2]), process.argv[3]];',
      "const s = dgram.createSocket('udp4');",
      "const timer = setInterval(() => s.send(text, port, '127.0.0.1'), 300);",
      "s.on('message', (m, r) => {",
      '  console.log(`answer ${m} from ${r.address}:${r.port}`);',
      '  clearInterval(timer);',
      '  s.close();',
      '});',
      "s.send(text, port, 'localhost');",
    ].join('\n'),
  );
  await writeText(
    page,
    '/work/dns.cjs',
    [
      "const s = require('dgram').createSocket('udp4');",
      // A query for www.example.com's A records.
      'const q = Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 3, ...Buffer.from("www"), 7, ...Buffer.from("example"), 3, ...Buffer.from("com"), 0, 0, 1, 0, 1]);',
      "s.connect(53, '127.0.0.53', () => s.send(q));",
      "s.on('message', (m) => {",
      "  console.log('dns id', m.readUInt16BE(0).toString(16), 'rcode', m[3] & 15);",
      "  const away = require('dgram').createSocket('udp4');",
      "  away.on('message', () => console.log('away answered'));",
      "  away.send(q, 53, '1.1.1.1', () => setTimeout(() => {",
      "    console.log('away dropped');",
      '    away.close();',
      '    s.close();',
      '  }, 500));',
      '});',
    ].join('\n'),
  );
  await background(page, 'node echo.cjs', /^echo on 41300$/m);

  // Process to process.
  expect(await run(page, 'node ask.cjs 41300 hi')).toMatch(/answer re:hi from 127\.0\.0\.1:41300/);
  // A node to a process.
  expect(
    await run(
      page,
      `elixir -e '{:ok, s} = :gen_udp.open(0, [:binary, active: false]); :ok = :gen_udp.send(s, {127, 0, 0, 1}, 41300, "node"); IO.inspect(:gen_udp.recv(s, 0, 5000))'`,
    ),
  ).toContain('{:ok, {{127, 0, 0, 1}, 41300, "re:node"}}');
  // A process to a node.
  const shell = await newShell(page);
  const served = run(
    page,
    `elixir -e '{:ok, s} = :gen_udp.open(41301, [:binary, active: false]); {:ok, {ip, port, data}} = :gen_udp.recv(s, 0, 60_000); :ok = :gen_udp.send(s, ip, port, "re:" <> data); IO.puts("served #{data}")'`,
    shell,
  );
  expect(await run(page, 'node ask.cjs 41301 process')).toContain(
    'answer re:process from 127.0.0.1:41301',
  );
  expect(await served).toContain('served process');
  // The node's DNS, without Tailscale: no such name; another host's
  // datagrams go nowhere.
  const dns = await run(page, 'node dns.cjs');
  expect(dns).toContain('dns id 1234 rcode 3');
  expect(dns).toContain('away dropped');
  expect(dns).not.toContain('away answered');
  expect(await run(page, 'node ask.cjs 41300 last')).toContain('answer re:last');
});

// Node's fetch, by the process's own http and https (fetch.ts): another
// process's server on localhost (which the browser's fetch cannot reach), a
// POST, a redirect followed, a gzip answer decompressed; HTTPS by the
// exec frame's fetch() without Tailscale.
test('a Node.js process’s fetch: the project’s ports, redirects, gzip, HTTPS', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(
    page,
    '/work/server.cjs',
    [
      "const zlib = require('zlib');",
      "require('http').createServer((req, res) => {",
      "  let body = '';",
      "  req.on('data', (c) => (body += c));",
      "  req.on('end', () => {",
      "    if (req.url === '/old') { res.writeHead(302, { location: '/new' }); return res.end(); }",
      "    if (req.url === '/zipped') {",
      "      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });",
      "      return res.end(zlib.gzipSync('unzipped text'));",
      '    }',
      "    res.setHeader('content-type', 'application/json');",
      '    res.end(JSON.stringify({ method: req.method, url: req.url, body }));',
      '  });',
      "}).listen(3000, () => console.log('up'));",
    ].join('\n'),
  );
  await writeText(
    page,
    '/work/client.mjs',
    [
      "const base = 'http://localhost:3000';",
      "const post = await fetch(`${base}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }) });",
      "console.log('post', post.status, JSON.stringify(await post.json()));",
      'const moved = await fetch(`${base}/old`);',
      "console.log('moved', moved.redirected, new URL(moved.url).pathname, (await moved.json()).url);",
      "console.log('zipped', await (await fetch(`${base}/zipped`)).text());",
      "const hex = await fetch('https://hex.pm/api/packages/jason', { headers: { accept: 'application/json' } });",
      "console.log('hex', hex.status, (await hex.json()).name);",
    ].join('\n'),
  );
  await background(page, 'node server.cjs', /^up$/m);
  const out = await run(page, 'node client.mjs');
  expect(out).toContain('post 200 {"method":"POST","url":"/api","body":"{\\"a\\":1}"}');
  expect(out).toContain('moved true /new /new');
  expect(out).toContain('zipped unzipped text');
  expect(out).toContain('hex 200 jason');
});
