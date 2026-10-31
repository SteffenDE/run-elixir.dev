// The service worker's bridge (swBridge.ts): what is below /_bridge/KEY/
// comes from the port that bridge's pages gave, and from nothing else.
import { describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_POLICY,
  bridgeConfig,
  bridgeRouter,
  workerPolicy,
  type BridgeClient,
} from '../../src/swBridge';
import { belowBridge, bridgePath, isOwnFrame } from '../../src/swProtocol';
import type { LinkRequest, LinkResponse } from '../../src/lib/apexLink';

const ORIGIN = 'https://e-abcdefghij.bridge.test';
const KEY = 'k'.repeat(32);
const OTHER = 'o'.repeat(32);

// A page of the origin, at `path`, that keeps what the worker says to it.
function page(path: string): BridgeClient & { said: unknown[] } {
  const said: unknown[] = [];
  return { url: `${ORIGIN}${path}`, said, postMessage: (message) => said.push(message) };
}

// The apex's worker's end of a port: answers each request with `answer`,
// and keeps the requests.
function apex(answer: (request: LinkRequest) => LinkResponse) {
  const channel = new MessageChannel();
  const asked: LinkRequest[] = [];
  channel.port1.onmessage = ({ data, ports }) => {
    asked.push(data);
    const response = answer(data);
    ports[0].postMessage(response, response.body ? [response.body] : []);
  };
  return { port: channel.port2, asked, close: () => channel.port1.close() };
}

const ok = (text: string, headers: [string, string][] = [['content-type', 'text/html']]) => ({
  status: 200,
  headers,
  body: new TextEncoder().encode(text).buffer as ArrayBuffer,
});

const router = (clients: BridgeClient[] = [], reconnect = 50, bridgeable = true) =>
  bridgeRouter({
    origin: ORIGIN,
    clients: async () => clients,
    bridgeable: async () => bridgeable,
    reconnect,
    answer: 200,
  });

describe('the bridge paths', () => {
  it('names a bridge by its key, and leaves other paths alone', () => {
    expect(bridgePath(`/_bridge/${KEY}/npm/@elixir-playground/runtime@1.1.0/exec.html`)).toEqual({
      key: KEY,
      rest: 'npm/@elixir-playground/runtime@1.1.0/exec.html',
    });
    expect(bridgePath('/_bridge/short/exec.html')).toBeNull();
    expect(bridgePath('/bridge/x/y')).toBeNull();
    expect(isOwnFrame('/bridge.html')).toBe(true);
    expect(isOwnFrame(`/_bridge/${KEY}/x`)).toBe(true);
    expect(isOwnFrame('/_bridge/')).toBe(false);
  });
});

describe('the bridge router', () => {
  it('takes a new key from the bootstrap, and answers below it from its port', async () => {
    const bridges = router();
    const bootstrap = page('/bridge.html');
    const served = apex(() => ok('<p>exec</p>'));
    expect(
      await bridges.accept({ kind: 'bridge', protocol: 1, bridge: KEY }, bootstrap, [served.port]),
    ).toBe(true);
    expect(bootstrap.said).toEqual([{ kind: 'bridged', bridge: KEY, protocol: 1, protocols: [1] }]);
    const url = `${ORIGIN}/_bridge/${KEY}/npm/@elixir-playground/runtime@1.1.0/exec.html?x=1`;
    expect(bridges.handles(new URL(url))).toBe(true);
    const response = await bridges.respond(new Request(url));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<p>exec</p>');
    expect(served.asked[0]).toMatchObject({
      kind: 'get',
      path: 'npm/@elixir-playground/runtime@1.1.0/exec.html?x=1',
      method: 'GET',
    });
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('refuses a key that is taken, a page of another key, and a protocol it does not speak', async () => {
    const bridges = router();
    expect(
      await bridges.accept({ kind: 'bridge', protocol: 1, bridge: KEY }, page('/bridge.html'), [
        apex(() => ok('')).port,
      ]),
    ).toBe(true);
    // Another bootstrap in the same partition, for the same key.
    const second = page('/bridge.html');
    expect(
      await bridges.accept({ kind: 'bridge', protocol: 1, bridge: KEY }, second, [
        apex(() => ok('')).port,
      ]),
    ).toBe(false);
    expect(second.said[0]).toMatchObject({ kind: 'bridged', protocol: null });
    // A bridged page of another key asking for this one's.
    expect(
      await bridges.accept(
        { kind: 'bridge', protocol: 1, bridge: KEY },
        page(`/_bridge/${OTHER}/x.html`),
        [apex(() => ok('')).port],
      ),
    ).toBe(false);
    // A preview's document, the app's.
    expect(
      await bridges.accept({ kind: 'bridge', protocol: 1, bridge: OTHER }, page('/users'), [
        apex(() => ok('')).port,
      ]),
    ).toBe(false);
    expect(
      await bridges.accept({ kind: 'bridge', protocol: 2, bridge: OTHER }, page('/bridge.html'), [
        apex(() => ok('')).port,
      ]),
    ).toBe(false);
    expect(
      await bridges.accept({ kind: 'bridge', protocol: 1, bridge: 'short' }, page('/bridge.html'), [
        apex(() => ok('')).port,
      ]),
    ).toBe(false);
    expect(
      await bridges.accept(
        { kind: 'bridge', protocol: 1, bridge: OTHER },
        page('/bridge.html'),
        [],
      ),
    ).toBe(false);
  });

  it('keeps each bridge’s files to its own key', async () => {
    const bridges = router();
    const mine = apex(() => ok('mine'));
    const theirs = apex(() => ok('theirs'));
    await bridges.accept({ kind: 'bridge', protocol: 1, bridge: KEY }, page('/bridge.html'), [
      mine.port,
    ]);
    await bridges.accept({ kind: 'bridge', protocol: 1, bridge: OTHER }, page('/bridge.html'), [
      theirs.port,
    ]);
    expect(await (await bridges.respond(new Request(`${ORIGIN}/_bridge/${KEY}/a.js`))).text()).toBe(
      'mine',
    );
    expect(
      await (await bridges.respond(new Request(`${ORIGIN}/_bridge/${OTHER}/a.js`))).text(),
    ).toBe('theirs');
  });

  it('asks the bridge’s own pages for a port after a restart, and no others', async () => {
    const own = page(`/_bridge/${KEY}/npm/@elixir-playground/runtime@1.1.0/exec.html`);
    const stranger = page(`/_bridge/${OTHER}/npm/@elixir-playground/runtime@1.1.0/exec.html`);
    const bootstrap = page('/bridge.html');
    const bridges = router([own, stranger, bootstrap], 1000);
    const served = apex(() => ok('again'));
    const answered = bridges.respond(new Request(`${ORIGIN}/_bridge/${KEY}/a.js`));
    await vi.waitFor(() =>
      expect(own.said).toContainEqual({ kind: 'bridge-lost', protocol: 1, bridge: KEY }),
    );
    expect(stranger.said).toEqual([]);
    expect(bootstrap.said).toEqual([]);
    expect(
      await bridges.accept({ kind: 'bridge', protocol: 1, bridge: KEY }, own, [served.port]),
    ).toBe(true);
    expect(await (await answered).text()).toBe('again');
  });

  it('answers 503 when no page of the bridge gives a port', async () => {
    const response = await router([], 20).respond(new Request(`${ORIGIN}/_bridge/${KEY}/a.js`));
    expect(response.status).toBe(503);
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('answers 504 when the apex does not, and asks for a new port next time', async () => {
    const bridges = router([], 20);
    const gone = new MessageChannel();
    await bridges.accept({ kind: 'bridge', protocol: 1, bridge: KEY }, page('/bridge.html'), [
      gone.port2,
    ]);
    expect((await bridges.respond(new Request(`${ORIGIN}/_bridge/${KEY}/a.js`))).status).toBe(504);
    expect(bridges.ports.has(KEY)).toBe(false);
  });

  it('serves no downloads, and no services', async () => {
    const bridges = router();
    const served = apex(({ path }) =>
      path.startsWith('file')
        ? ok('data', [['content-disposition', 'attachment; filename="x.exe"']])
        : ok('inline', [['content-disposition', 'inline']]),
    );
    await bridges.accept({ kind: 'bridge', protocol: 1, bridge: KEY }, page('/bridge.html'), [
      served.port,
    ]);
    expect((await bridges.respond(new Request(`${ORIGIN}/_bridge/${KEY}/file.bin`))).status).toBe(
      403,
    );
    const inline = await bridges.respond(new Request(`${ORIGIN}/_bridge/${KEY}/page.txt`));
    expect(inline.status).toBe(200);
    expect(inline.headers.get('content-disposition')).toBeNull();
    expect(
      (await bridges.respond(new Request(`${ORIGIN}/_bridge/${KEY}/_services/nif/x/1`))).status,
    ).toBe(404);
    expect(served.asked.map(({ path }) => path)).toEqual(['file.bin', 'page.txt']);
  });

  it('sends the worker programs’ policy with their scripts, and drops the apex’s own headers', async () => {
    const bridges = router();
    const served = apex(() =>
      ok('js', [
        ['content-type', 'text/javascript'],
        ['set-cookie', 'a=b'],
        ['cache-control', 'max-age=1'],
        ['content-security-policy', 'default-src *'],
      ]),
    );
    await bridges.accept({ kind: 'bridge', protocol: 1, bridge: KEY }, page('/bridge.html'), [
      served.port,
    ]);
    const nodejs = 'npm/@elixir-playground/nodejs@1.0.0';
    const script = await bridges.respond(
      new Request(`${ORIGIN}/_bridge/${KEY}/${nodejs}/workers/nodejs.js`),
    );
    expect(script.headers.get('content-security-policy')).toBe(workerPolicy(ORIGIN, KEY, nodejs));
    expect(script.headers.get('set-cookie')).toBeNull();
    expect(script.headers.get('content-type')).toBe('text/javascript');
    const chunk = await bridges.respond(
      new Request(`${ORIGIN}/_bridge/${KEY}/${nodejs}/workers/chunks/a-1.js`),
    );
    expect(chunk.headers.get('content-security-policy')).toBe(workerPolicy(ORIGIN, KEY, nodejs));
    // Any package's workers/, an unscoped one's too, with its own path.
    const other = 'npm/pyodide-shell@0.3.1';
    const theirs = await bridges.respond(
      new Request(`${ORIGIN}/_bridge/${KEY}/${other}/workers/python.js`),
    );
    expect(theirs.headers.get('content-security-policy')).toBe(workerPolicy(ORIGIN, KEY, other));
    // Not a package's page programs (the exec frame's worker imports
    // them), nor the runtime's scripts, nor a workers/ that is no
    // package's.
    for (const path of [
      `${nodejs}/npm.js`,
      'npm/@elixir-playground/runtime@1.2.0/worker.js',
      'workers/x.js',
      `${nodejs}/workers/page.html`,
    ]) {
      const response = await bridges.respond(new Request(`${ORIGIN}/_bridge/${KEY}/${path}`));
      expect(response.headers.get('content-security-policy'), path).toBeNull();
    }
    const policy = workerPolicy(ORIGIN, KEY, nodejs);
    const base = `${ORIGIN}/_bridge/${KEY}/`;
    expect(policy).toContain(`script-src ${base}${nodejs}/workers/ ${ORIGIN}/sw.js `);
    expect(policy).toContain(
      `connect-src ${base}${nodejs}/ ${base}npm/@elixir-playground/ ${ORIGIN}/sw.js `,
    );
  });

  it('sandboxes the bridged documents without downloads', async () => {
    const bridges = router();
    await bridges.accept({ kind: 'bridge', protocol: 1, bridge: KEY }, page('/bridge.html'), [
      apex(() => ok('<p>')).port,
    ]);
    // Node's Request has no navigate mode to give: as the worker sees one.
    const request = new Request(`${ORIGIN}/_bridge/${KEY}/x.html`);
    Object.defineProperty(request, 'mode', { value: 'navigate' });
    const response = await bridges.respond(request);
    expect(response.headers.get('content-security-policy')).toBe(DOCUMENT_POLICY);
    expect(DOCUMENT_POLICY).not.toContain('allow-downloads');
    expect(DOCUMENT_POLICY).not.toContain('allow-top-navigation');
  });

  it('carries a POST’s body to the apex', async () => {
    const bridges = router();
    const served = apex(() => ok('posted'));
    await bridges.accept({ kind: 'bridge', protocol: 1, bridge: KEY }, page('/bridge.html'), [
      served.port,
    ]);
    await bridges.respond(
      new Request(`${ORIGIN}/_bridge/${KEY}/form`, { method: 'POST', body: 'a=1' }),
    );
    expect(served.asked[0].method).toBe('POST');
    expect(new TextDecoder().decode(served.asked[0].body!)).toBe('a=1');
  });

  it('lets a Node.js worker read where the apex serves the packages, from the apex’s hint', async () => {
    const bridges = router();
    const served = apex(() =>
      ok('js', [
        ['content-type', 'text/javascript'],
        [
          'x-playground-connect',
          "https://apex.test/npm/@elixir-playground/tls@1.0.0/ https://evil.test/;script-src 'unsafe-inline' javascript:x",
        ],
      ]),
    );
    await bridges.accept({ kind: 'bridge', protocol: 1, bridge: KEY }, page('/bridge.html'), [
      served.port,
    ]);
    const nodejs = 'npm/@elixir-playground/nodejs@1.0.0';
    const script = await bridges.respond(
      new Request(`${ORIGIN}/_bridge/${KEY}/${nodejs}/workers/nodejs.js`),
    );
    const policy = script.headers.get('content-security-policy')!;
    expect(policy).toContain('https://apex.test/npm/@elixir-playground/tls@1.0.0/ data: blob:');
    expect(policy).not.toContain('evil');
    expect(policy).not.toContain('javascript:');
    expect(script.headers.get('x-playground-connect')).toBeNull();
  });
});

describe('who may bridge', () => {
  it('takes no new key on an origin outside a shared domain', async () => {
    const bridges = router([], 50, false);
    const bootstrap = page('/bridge.html');
    expect(
      await bridges.accept({ kind: 'bridge', protocol: 1, bridge: KEY }, bootstrap, [
        apex(() => ok('evil')).port,
      ]),
    ).toBe(false);
    expect(bootstrap.said).toEqual([
      { kind: 'bridged', bridge: KEY, protocol: null, protocols: [1] },
    ]);
    expect((await bridges.respond(new Request(`${ORIGIN}/_bridge/${KEY}/x.html`))).status).toBe(
      503,
    );
  });

  it('is below the domain /bridge.json names, and nothing else', () => {
    expect(belowBridge('e-abcdefghij.bridge.test', { bridge: 'bridge.test' })).toBe(true);
    expect(belowBridge('E-X.Bridge.Test:8081', { bridge: 'bridge.test:8081' })).toBe(true);
    expect(belowBridge('bridge.test', { bridge: 'bridge.test' })).toBe(false);
    expect(belowBridge('e-x.evilbridge.test', { bridge: 'bridge.test' })).toBe(false);
    expect(belowBridge('e-x.bridge.test:8081', { bridge: 'bridge.test' })).toBe(false);
    expect(belowBridge('e-x.bridge.test', { bridge: '' })).toBe(false);
    expect(belowBridge('e-x.bridge.test', null)).toBe(false);
    expect(belowBridge('e-x.bridge.test', 'bridge.test')).toBe(false);
  });

  it('reads /bridge.json of its own origin, and asks again after a no', async () => {
    const answers = [
      new Response('<!doctype html>', { status: 200 }),
      Response.json({ bridge: 'bridge.test' }),
    ];
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: URL) => {
      asked.push(String(url));
      return answers.shift()!;
    });
    try {
      const bridgeable = bridgeConfig(ORIGIN);
      // The apex's answer for a path that is no file: its page, no JSON.
      expect(await bridgeable()).toBe(false);
      await Promise.resolve();
      expect(await bridgeable()).toBe(true);
      expect(await bridgeable()).toBe(true);
      expect(asked).toEqual([`${ORIGIN}/bridge.json`, `${ORIGIN}/bridge.json`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
