// The site embedded by a page of another site (docs/embed.md): the test
// embedder (test/embed/index.html, serve.py --embedder-host) imports
// embed.js from the apex, which frames embed.html, which runs a project
// in its exec frame; the embedder frames the project's preview itself.
import { existsSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { PORT } from './helpers';

const EMBEDDER = `http://embedder.localhost:${PORT}/`;
// What the tests' code needs of the site's runtime (create()'s requires).
const REQUIRES = { otp: '^29.1', elixir: '~1.20.4' };

declare global {
  interface Window {
    // oxlint-disable-next-line typescript/no-explicit-any -- the page's test hooks.
    embed: any;
    // oxlint-disable-next-line typescript/no-explicit-any
    sandbox: any;
  }
}

// The embedder's page, and a sandbox of `project` in it (window.sandbox);
// how long create() took.
async function embedded(
  page: Page,
  project: object = { template: 'phoenix' },
  extra: object = {},
): Promise<number> {
  await page.goto(EMBEDDER);
  return page.evaluate(
    async (given) => {
      const { create } = await window.embed.module;
      const started = performance.now();
      window.sandbox = await create({
        requires: given.requires,
        project: given.project,
        container: document.getElementById('frames'),
        onProgress: (event: unknown) => window.embed.progress.push(event),
        ...given.extra,
      });
      return performance.now() - started;
    },
    { requires: REQUIRES, project, extra },
  );
}

// A command's stdout, stderr and exit code, run without a tty: a shell
// line (sh) or its words (spawn).
function run(page: Page, command: string | string[], options: object = {}) {
  return page.evaluate(
    async (given) => {
      const process =
        typeof given.command === 'string'
          ? window.sandbox.sh(given.command, given.options)
          : window.sandbox.spawn(given.command, given.options);
      const out: Uint8Array[] = [];
      const err: Uint8Array[] = [];
      process.onStdout((bytes: Uint8Array) => out.push(bytes));
      process.onStderr((bytes: Uint8Array) => err.push(bytes));
      const { code } = await process.exited;
      const text = (parts: Uint8Array[]) =>
        parts.map((part) => new TextDecoder().decode(part)).join('');
      return { stdout: text(out), stderr: text(err), code };
    },
    { command, options },
  );
}

// A raw HTTP/1.1 GET over connect(port): the response's text.
function get(page: Page, port: number, path: string, headers = '') {
  return page.evaluate(
    async ({ to, at, more }) => {
      const stream = await window.sandbox.connect(to);
      const parts: Uint8Array[] = [];
      const done = new Promise<void>((resolve) => {
        stream.onData((bytes: Uint8Array) => parts.push(bytes));
        stream.onEnd(resolve);
        stream.onClose(resolve);
      });
      stream.write(
        `GET ${at} HTTP/1.1\r\nhost: localhost:${to}\r\n${more}connection: close\r\n\r\n`,
      );
      await done;
      return parts.map((part) => new TextDecoder().decode(part)).join('');
    },
    { to: port, at: path, more: headers },
  );
}

// The text of the preview the embedder frames (#preview), as it answers.
function previewText(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const frame = document.getElementById('preview') as HTMLIFrameElement | null;
        if (!frame?.contentWindow) return resolve('');
        const id = Math.random();
        const heard = (event: MessageEvent) => {
          if (event.data?.kind !== 'playground-snapshot' || event.data.id !== id) return;
          removeEventListener('message', heard);
          resolve(event.data.text);
        };
        addEventListener('message', heard);
        frame.contentWindow.postMessage({ kind: 'playground-snapshot', id }, '*');
        setTimeout(() => resolve(''), 2000);
      }),
  );
}

test('an embedder runs a Phoenix project: files, commands, its server raw, its preview', async ({
  page,
  browserName,
}) => {
  const took = await embedded(page);
  console.log(`${browserName}: create() in ${Math.round(took)} ms`);
  const created = await page.evaluate(() => window.sandbox.created);
  expect(created.root).toBe('/work/playground');

  // Files.
  await page.evaluate(() => window.sandbox.fs.write('/work/playground/hello.txt', 'hi there'));
  expect(
    await page.evaluate(async () =>
      new TextDecoder().decode(await window.sandbox.fs.read('/work/playground/hello.txt')),
    ),
  ).toBe('hi there');
  const stat = await page.evaluate(() => window.sandbox.fs.stat('/work/playground/hello.txt'));
  expect(stat).toMatchObject({ type: 'file', size: 8 });
  expect(await page.evaluate(() => window.sandbox.fs.stat('/work/nothing'))).toBeNull();

  // A command, without a tty.
  const echoed = await run(page, 'echo hello from $PWD && cat hello.txt');
  expect(echoed).toMatchObject({ code: 0 });
  expect(echoed.stdout).toContain('hello from /work/playground');
  expect(echoed.stdout).toContain('hi there');
  expect((await run(page, 'exit 3')).code).toBe(3);

  // The server, then a raw GET to it, and its preview framed here.
  const startedAt = Date.now();
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
  console.log(`${browserName}: Phoenix running ${Date.now() - startedAt} ms after spawn`);
  const response = await get(page, 4000, '/');
  expect(response).toMatch(/^HTTP\/1\.1 200/);
  expect(response).toContain('Phoenix Framework');

  const url = await page.evaluate(() => window.sandbox.previewUrl(4000));
  expect(url).toMatch(/^http:\/\/v-[a-z0-9]{10}-4000\.usercontent\.localhost:\d+\/$/);
  await page.evaluate((at) => {
    const frame = document.createElement('iframe');
    frame.src = at;
    frame.id = 'preview';
    frame.style.width = '800px';
    frame.style.height = '600px';
    document.body.append(frame);
  }, url);
  // What the preview shows, as its page tells its framer (bridge.ts's
  // snapshot: Playwright's Firefox reaches no frame of another site).
  await expect.poll(() => previewText(page), { timeout: 60_000 }).toContain('Phoenix Framework');
  if (browserName !== 'firefox')
    await expect(page.frameLocator('#preview').getByText('Peace of mind').first()).toBeVisible();
});

test("commands: stderr apart, input as it comes, signals, a terminal, the embedder's port", async ({
  page,
}) => {
  await embedded(page, { template: 'empty' });

  // stderr apart from stdout, through brush, Node.js and its children, and a node.
  expect(await run(page, 'echo out; echo err >&2')).toEqual({
    stdout: 'out\n',
    stderr: 'err\n',
    code: 0,
  });
  expect(await run(page, ['node', '-e', "console.log('o'); console.error('e')"])).toEqual({
    stdout: 'o\n',
    stderr: 'e\n',
    code: 0,
  });
  const child = await run(page, [
    'node',
    '-e',
    "const r = require('child_process').spawnSync('sh', ['-c', 'echo a; echo b >&2'], { encoding: 'utf8' }); console.log(JSON.stringify([r.stdout, r.stderr]))",
  ]);
  expect(child.stdout).toBe('["a\\n","b\\n"]\n');
  const elixir = await run(page, ['elixir', '-e', 'IO.puts("o"); IO.puts(:stderr, "e")']);
  expect(elixir).toEqual({ stdout: 'o\n', stderr: 'e\n', code: 0 });
  const missing = await run(page, 'no-such-program');
  expect(missing.code).toBe(127);
  expect(missing.stdout).toBe('');
  expect(missing.stderr).toContain('no-such-program');

  // Input as it comes, each line answered before the next is written, then its end.
  const echoed = await page.evaluate(async () => {
    const process = window.sandbox.spawn([
      'node',
      '-e',
      "process.stdin.on('data', (d) => process.stdout.write(d.toString().toUpperCase())); process.stdin.on('end', () => console.log('END'))",
    ]);
    let out = '';
    const seen = (text: string) =>
      new Promise<void>((resolve) => {
        const check = () => (out.includes(text) ? resolve() : setTimeout(check, 20));
        check();
      });
    process.onStdout((bytes: Uint8Array) => (out += new TextDecoder().decode(bytes)));
    process.write('abc\n');
    await seen('ABC');
    process.write('def\n');
    await seen('DEF');
    process.end();
    const exit = await process.exited;
    return { out, exit };
  });
  expect(echoed).toEqual({ out: 'ABC\nDEF\nEND\n', exit: { code: 0, signal: null } });

  // A signal: SIGTERM ends it, and says so.
  const killed = await page.evaluate(async () => {
    const process = window.sandbox.spawn(['node', '-e', 'setInterval(() => {}, 1000)']);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    process.kill('SIGTERM');
    return process.exited;
  });
  expect(killed).toEqual({ code: null, signal: 'SIGTERM' });

  // A terminal: an interactive shell, its echo and output as a tty's (CR LF).
  const terminal = await page.evaluate(async () => {
    const process = window.sandbox.terminal({ cols: 100, rows: 30 });
    let out = '';
    // As a terminal (xterm.js) does: the cursor's position when asked,
    // which brush's line editor asks for.
    process.onStdout((bytes: Uint8Array) => {
      const text = new TextDecoder().decode(bytes);
      out += text;
      for (const _ of text.split('\x1b[6n').slice(1)) process.write('\x1b[1;1R');
    });
    const seen = (pattern: RegExp) =>
      new Promise<void>((resolve, reject) => {
        const until = Date.now() + 60_000;
        const check = () =>
          pattern.test(out)
            ? resolve()
            : Date.now() > until
              ? reject(new Error(`not seen: ${pattern} in ${JSON.stringify(out)}`))
              : setTimeout(check, 50);
        check();
      });
    // oxlint-disable-next-line no-control-regex -- the prompt's colours.
    await seen(/\/work\x1b\[0m \$ /);
    for (const key of 'echo $((6*7))') process.write(key);
    process.write('\r');
    // oxlint-disable-next-line no-control-regex -- bracketed paste off, then its output.
    await seen(/\r\n\x1b\[\?2004l42\r\n/);
    process.kill('SIGKILL');
    const exit = await process.exited;
    return { out, exit };
  });
  expect(terminal.out).toContain('\x1b[94m$((6*7))');
  expect(terminal.exit).toEqual({ code: null, signal: 'SIGKILL' });

  // A port the embedder answers (as Tidewave's MCP bridge on 9832): from a
  // Node.js process and from a node.
  await page.evaluate(() =>
    window.sandbox.serve(
      9832,
      (stream: {
        onData(listener: (bytes: Uint8Array) => void): void;
        write(s: string): void;
        end(): void;
      }) => {
        let request = '';
        stream.onData((bytes: Uint8Array) => {
          request += new TextDecoder().decode(bytes);
          if (!request.includes('\r\n\r\n')) return;
          const path = request.split(' ')[1];
          const body = `answered ${path}`;
          stream.write(
            `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
          );
          stream.end();
        });
      },
    ),
  );
  const fetched = await run(page, [
    'node',
    '-e',
    "fetch('http://127.0.0.1:9832/socket/mcp-remote-client?sessionId=1', { method: 'POST', body: '{}' }).then((r) => r.text()).then(console.log)",
  ]);
  expect(fetched).toMatchObject({ stdout: 'answered /socket/mcp-remote-client?sessionId=1\n' });
  const fromNode = await run(page, [
    'elixir',
    '-e',
    ':inets.start(); {:ok, {_, _, body}} = :httpc.request(~c"http://127.0.0.1:9832/from-elixir"); IO.puts(body)',
  ]);
  expect(fromNode).toMatchObject({ stdout: 'answered /from-elixir\n', code: 0 });
});

// A scripted Messages API on the sandbox's port 3456: a Bash tool call,
// then a text saying what it answered (no tools asked for: a title).
const MOCK_API = `const http = require('http');
let n = 0;
http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    const body = JSON.parse(data || '{}');
    const results = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result');
    const content = !body.tools?.length
      ? [{ type: 'text', text: 'title' }]
      : results.length
        ? [{ type: 'text', text: 'BASH SAID: ' + JSON.stringify(results[0].content) }]
        : [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo from-acp $((6*7)) | tee /work/acp.txt', description: 'test' } }];
    const stop = content[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
    const message = { id: 'msg_' + ++n, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(message));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, d) => res.write('event: ' + type + '\\ndata: ' + JSON.stringify({ type, ...d }) + '\\n\\n');
    ev('message_start', { message: { ...message, content: [], stop_reason: null } });
    content.forEach((b, index) => {
      if (b.type === 'text') {
        ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
      } else {
        ev('content_block_start', { index, content_block: { ...b, input: {} } });
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      ev('content_block_stop', { index });
    });
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
    ev('message_stop', {});
    res.end();
  });
}).listen(3456, () => console.log('mock listening'));
`;

// Tidewave's agent: claude-agent-acp over pipes, newline-delimited
// JSON-RPC on its stdin and stdout (stderr apart), which runs the
// playground's claude through the Agent SDK (CLAUDE_CODE_EXECUTABLE).
test('the ACP agent runs Claude Code through the Agent SDK, over pipes', async ({ page }) => {
  test.setTimeout(900_000);
  await embedded(page, { template: 'empty' });
  await page.evaluate((mock) => window.sandbox.fs.write('/work/mock.cjs', mock), MOCK_API);
  await page.evaluate(async () => {
    const mock = window.sandbox.spawn(['node', '/work/mock.cjs']);
    await new Promise<void>((resolve) =>
      mock.onStdout((bytes: Uint8Array) => {
        if (new TextDecoder().decode(bytes).includes('mock listening')) resolve();
      }),
    );
  });
  const result = await page.evaluate(async () => {
    const agent = window.sandbox.sh('npx -y @agentclientprotocol/claude-agent-acp@0.85.1', {
      cwd: '/work',
      env: { ANTHROPIC_BASE_URL: 'http://localhost:3456', ANTHROPIC_API_KEY: 'sk-ant-none' },
    });
    const log: string[] = [];
    let stderr = '';
    agent.onStderr((bytes: Uint8Array) => (stderr += new TextDecoder().decode(bytes)));
    const waiting = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
    const updates: unknown[] = [];
    const nonJson: string[] = [];
    let buffer = '';
    const send = (message: object) => agent.write(`${JSON.stringify(message)}\n`);
    agent.onStdout((bytes: Uint8Array) => {
      buffer += new TextDecoder().decode(bytes);
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          nonJson.push(line);
          continue;
        }
        log.push(line.slice(0, 300));
        if (message.id !== undefined && !message.method) waiting.get(message.id)?.(message);
        else if (message.method === 'session/update') updates.push(message.params);
        else if (message.method === 'session/request_permission') {
          const allow = message.params.options.find((o: { kind: string }) =>
            o.kind.startsWith('allow'),
          );
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: { outcome: { outcome: 'selected', optionId: allow.optionId } },
          });
        } else if (message.id !== undefined)
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } });
      }
    });
    let next = 0;
    const call = (method: string, params: object, ms = 600_000) =>
      new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => {
        const id = ++next;
        waiting.set(id, resolve);
        send({ jsonrpc: '2.0', id, method, params });
        setTimeout(
          () => reject(new Error(`${method}: no answer; stderr: ${stderr.slice(-2000)}`)),
          ms,
        );
      });
    const started = performance.now();
    const initialized = await call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const session = (await call('session/new', { cwd: '/work', mcpServers: [] })) as {
      result: { sessionId: string };
    };
    const ready = performance.now();
    const prompted = await call('session/prompt', {
      sessionId: session.result.sessionId,
      prompt: [{ type: 'text', text: 'run it' }],
    });
    const done = performance.now();
    agent.kill('SIGTERM');
    return {
      initialized,
      session,
      prompted,
      text: JSON.stringify(updates),
      nonJson,
      took: { ready: Math.round(ready - started), prompt: Math.round(done - ready) },
      stderr: stderr.slice(-2000),
    };
  });
  console.log('acp:', JSON.stringify(result.took), result.stderr);
  expect(result.nonJson).toEqual([]);
  expect(result.initialized).toHaveProperty('result.protocolVersion', 1);
  expect(result.session.result.sessionId).toBeTruthy();
  expect(result.prompted).toHaveProperty('result.stopReason', 'end_turn');
  expect(result.text).toContain('BASH SAID');
  expect(result.text).toContain('from-acp 42');
  const written = await page.evaluate(async () =>
    new TextDecoder().decode(await window.sandbox.fs.read('/work/acp.txt')),
  );
  expect(written).toBe('from-acp 42\n');
});

// An app the embedder built natively (tests/embed-archive.sh: phx.new with
// Tidewave, deps and _build), booted from its archive without the
// playground's template; Tidewave's MCP over a raw connection.
test('a Phoenix app from an archive boots, and Tidewave answers on it', async ({
  page,
  browserName,
}) => {
  test.skip(
    !existsSync(new URL('../embed/archives/demo.tar.gz', import.meta.url)),
    'needs tests/embed-archive.sh',
  );
  const took = await embedded(page, { archive: '/archives/demo.tar.gz' });
  console.log(`${browserName}: create() from the archive in ${Math.round(took)} ms`);
  expect(await page.evaluate(() => window.sandbox.root)).toBe('/work/demo');
  const startedAt = Date.now();
  await page.evaluate(() => {
    const server = window.sandbox.sh('mix phx.server');
    window.embed.server = '';
    const keep = (bytes: Uint8Array) => (window.embed.server += new TextDecoder().decode(bytes));
    server.onStdout(keep);
    server.onStderr(keep);
  });
  await page.waitForFunction(() => /Running DemoWeb.Endpoint/.test(window.embed.server), null, {
    timeout: 240_000,
  });
  const log = await page.evaluate(() => window.embed.server as string);
  console.log(
    `${browserName}: the archive's Phoenix running ${Date.now() - startedAt} ms after spawn`,
  );
  // Compiled natively: nothing compiles again.
  expect(log).not.toMatch(/Compiling \d+ files? \(\.ex\)/);
  expect(await get(page, 4000, '/')).toMatch(/^HTTP\/1\.1 200/);
  const config = await get(page, 4000, '/tidewave/config');
  expect(config).toMatch(/^HTTP\/1\.1 200/);
  expect(config).toContain('"project_name":"demo"');
  // Tidewave's MCP: a raw POST (it refuses a request with an Origin).
  const tools = await page.evaluate(async () => {
    const stream = await window.sandbox.connect(4000);
    const parts: Uint8Array[] = [];
    const done = new Promise<void>((resolve) => {
      stream.onData((bytes: Uint8Array) => parts.push(bytes));
      stream.onClose(resolve);
      stream.onEnd(resolve);
    });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    stream.write(
      `POST /tidewave/mcp HTTP/1.1\r\nhost: localhost:4000\r\ncontent-type: application/json\r\n` +
        `accept: application/json, text/event-stream\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
    );
    await done;
    return parts.map((part) => new TextDecoder().decode(part)).join('');
  });
  expect(tools).toMatch(/^HTTP\/1\.1 200/);
  expect(tools).toContain('project_eval');
});

test('only the sites the playground names may embed it, at its OTP and Elixir', async ({
  page,
  browserName,
}) => {
  // Another site: embed.html's frame-ancestors keeps it out (it never says
  // it loaded).
  await page.goto(`http://other.localhost:${PORT}/favicon.ico`);
  const loaded = await page.evaluate(
    (apex) =>
      new Promise<boolean>((resolve) => {
        const frame = document.createElement('iframe');
        frame.src = `${apex}/embed.html`;
        addEventListener('message', (event) => {
          if (event.data?.kind === 'run-elixir-embed-loaded') resolve(true);
        });
        document.body.append(frame);
        setTimeout(() => resolve(false), 5000);
      }),
    `http://playground.localhost:${PORT}`,
  );
  expect(loaded).toBe(false);

  // A runtime other than the site's.
  await page.goto(EMBEDDER);
  const refused = await page.evaluate(async () => {
    const { create } = await window.embed.module;
    return create({ requires: { otp: '^28.0', elixir: '~1.18.0' }, project: { template: 'empty' } })
      .then(() => 'created')
      .catch((error: Error & { code?: string }) => `${error.code}: ${error.message}`);
  });
  expect(refused).toBe(
    'ERUNTIME: run-elixir.dev runs OTP 29.1.2 and Elixir 1.20.4, not OTP ^28.0 and Elixir ~1.18.0 as asked for',
  );
  // The API's version, as embed.html answers it.
  await embedded(page, { template: 'empty' });
  expect(await page.evaluate(() => window.sandbox.hello)).toMatchObject({
    apiVersion: 2,
    runtime: { otp: '29.1.2', elixir: '1.20.4' },
  });
  console.log(`${browserName}: refused as it should`);
});

test("a kept project's files, and ~/.claude, are there again after a reload", async ({
  page,
  browserName,
}) => {
  const project = { id: 'tidewave-test-app', template: 'phoenix', persist: true };
  const cold = await embedded(page, project);
  await page.evaluate(async () => {
    await window.sandbox.fs.write('/work/playground/kept.txt', 'kept');
    await window.sandbox.fs.write('/home/user/.claude/.credentials.json', '{"token":"x"}');
    await window.sandbox.shutdown();
  });
  const warm = await embedded(page, project);
  console.log(`${browserName}: create() cold ${Math.round(cold)} ms, warm ${Math.round(warm)} ms`);
  const read = (path: string) =>
    page.evaluate(async (at) => new TextDecoder().decode(await window.sandbox.fs.read(at)), path);
  expect(await read('/work/playground/kept.txt')).toBe('kept');
  expect(await read('/home/user/.claude/.credentials.json')).toBe('{"token":"x"}');
  const startedAt = Date.now();
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
  console.log(`${browserName}: warm Phoenix running ${Date.now() - startedAt} ms after spawn`);
});

// npx's package and a project's lock after a reload: npm's tree from the
// lock and the kept tarballs, the registry asked only for what is new.
test("after a reload, npx and npm install take a kept project's packages without the registry", async ({
  page,
  context,
  browserName,
}) => {
  test.setTimeout(600_000);
  const registry: string[] = [];
  await context.route('https://registry.npmjs.org/**', (route) => {
    registry.push(route.request().url());
    return route.continue();
  });
  const metadata = () => registry.filter((url) => !url.includes('/-/'));
  const project = { id: 'npm-kept', template: 'empty', persist: true };
  const acp = 'npx -y @agentclientprotocol/claude-agent-acp@0.85.1 --version';
  const npm = (command: string) => run(page, command, { cwd: '/work/app' });

  await embedded(page, project);
  expect(await run(page, acp)).toMatchObject({ stdout: '0.85.1\n', code: 0 });
  await page.evaluate(() => window.sandbox.fs.write('/work/app/package.json', '{}\n'));
  expect((await npm('npm install ms@2.1.3 cowsay@1.6.0')).code).toBe(0);
  console.log(
    `${browserName}: cold, ${metadata().length} metadata and ${registry.length - metadata().length} tarball requests`,
  );
  await page.evaluate(() => window.sandbox.shutdown());

  await embedded(page, project);
  registry.length = 0;
  expect(await run(page, acp)).toMatchObject({ stdout: '0.85.1\n', code: 0 });
  console.log(`${browserName}: npx after a reload, ${registry.length} registry requests`);
  expect(registry).toEqual([]);
  expect(await npm('npm install')).toMatchObject({ code: 0 });
  expect(registry).toEqual([]);
  expect((await npm('npm install picocolors@1.1.1')).code).toBe(0);
  expect(metadata().map((url) => url.slice(27))).toEqual(['picocolors']);
  expect(
    (await npm("node -p \"require('ms')('1h') + require('picocolors').red('!')\"")).stdout,
  ).toContain('3600000');
});

// A child that inherits a terminal's stdio has the terminal: isTTY, its
// size and SIGWINCH, raw keys straight to it (claude-agent-acp --cli runs
// Claude Code so).
test('a child with stdio inherit has the terminal', async ({ page }) => {
  await embedded(page, { template: 'empty' });
  const child = [
    "const s = process.stdout; console.log('tty', process.stdin.isTTY, s.isTTY, process.stderr.isTTY, s.columns, s.rows)",
    "s.on('resize', () => console.log('resized', s.columns, s.rows))",
    'process.stdin.setRawMode(true)',
    "process.stdin.once('data', (d) => { console.log('key', JSON.stringify(String(d))); process.exit(3) })",
    "console.log('raw')",
  ].join('; ');
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'inherit' }).on('exit', (c) => console.log('child exited', c, process.stdin.isRaw))`;
  const result = await page.evaluate(async (script) => {
    const process = window.sandbox.terminal({
      cols: 100,
      rows: 30,
      command: ['node', '-e', script],
    });
    let out = '';
    process.onStdout((bytes: Uint8Array) => (out += new TextDecoder().decode(bytes)));
    const seen = (text: string) =>
      new Promise<void>((resolve, reject) => {
        const until = Date.now() + 60_000;
        const check = () =>
          out.includes(text)
            ? resolve()
            : Date.now() > until
              ? reject(new Error(`not seen: ${text} in ${JSON.stringify(out)}`))
              : setTimeout(check, 20);
        check();
      });
    await seen('raw');
    process.resize(120, 40);
    await seen('resized');
    // One key, no Enter: raw, so it reaches the child as it is.
    process.write('q');
    await seen('child exited');
    const { code } = await process.exited;
    return { out, code };
  }, parent);
  // (console.log colours its values on a tty.)
  // oxlint-disable-next-line no-control-regex
  const out = result.out.replace(/\x1b\[\d+m/g, '');
  expect(out).toContain('tty true true true 100 30\r\n');
  expect(out).toContain('resized 120 40\r\n');
  expect(out).toContain('key "q"\r\n');
  expect(out).toContain('child exited 3 false\r\n');
  expect(result.code).toBe(0);
});
