// The apex's worker (packages/api/src/apexWorker.ts): a bridge's paths
// mapped to the page's packages, and the services to the backend the page
// names; nothing else.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BridgeTable } from '../../../api/src/apexWorker';
import { portSocket } from '../../src/lib/apexLink';

let answer: typeof import('../../../api/src/apexWorker').answer;
beforeAll(async () => {
  // It listens on its scope as it loads.
  (globalThis as { self?: unknown }).self ??= {};
  ({ answer } = await import('../../../api/src/apexWorker'));
});
afterEach(() => vi.unstubAllGlobals());

const table: BridgeTable = {
  sources: [
    [
      'npm/@elixir-playground/runtime@1.1.0/',
      'https://apex.test/npm/@elixir-playground/runtime@1.1.0/',
    ],
    ['npm/@elixir-playground/git@1.0.0/', 'https://cdn.test/git/1.0.0/'],
    ['boot/', 'https://apex.test/boot/abc/'],
  ],
  config: { domain: 'apex.test', usercontent: 'bridge.test', embedders: [] },
  services: {
    relay: 'wss://backend.test/relay',
    nif: 'https://backend.test/api/v1/nif/',
    git: null,
  },
};

// fetch(), answering `body`, and what it was asked.
function stubFetch(
  body = 'bytes',
  headers: Record<string, string> = { 'content-type': 'application/wasm' },
) {
  const asked: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: URL | string, init?: RequestInit) => {
    asked.push({ url: String(url), init });
    return new Response(body, { status: 200, headers });
  });
  return asked;
}

describe('the apex worker', () => {
  it('answers a package’s file from where the page serves it', async () => {
    const asked = stubFetch();
    const response = await answer(table, {
      kind: 'get',
      path: 'npm/@elixir-playground/git@1.0.0/git.wasm',
    });
    expect(asked[0].url).toBe('https://cdn.test/git/1.0.0/git.wasm');
    expect(response.status).toBe(200);
    expect(response.headers).toEqual([['content-type', 'application/wasm']]);
    expect(new TextDecoder().decode(response.body!)).toBe('bytes');
    await answer(table, { kind: 'get', path: 'boot/boot.tar.gz' });
    expect(asked[1].url).toBe('https://apex.test/boot/abc/boot.tar.gz');
  });

  it('answers the frame’s site configuration: this page is its apex', async () => {
    stubFetch();
    const response = await answer(table, { kind: 'get', path: 'playground.json' });
    expect(JSON.parse(new TextDecoder().decode(response.body!))).toEqual(table.config);
  });

  it('answers nothing but the page’s packages, and no climbing out of them', async () => {
    const asked = stubFetch();
    expect(
      (await answer(table, { kind: 'get', path: 'npm/@elixir-playground/otp@1.0.0/x' })).status,
    ).toBe(404);
    expect(
      (await answer(table, { kind: 'get', path: 'npm/@elixir-playground/git@1.0.0/../../secret' }))
        .status,
    ).toBe(404);
    expect((await answer(table, { kind: 'get', path: 'index.html' })).status).toBe(404);
    expect(
      (
        await answer(table, {
          kind: 'get',
          path: 'npm/@elixir-playground/git@1.0.0/x',
          method: 'POST',
        })
      ).status,
    ).toBe(405);
    expect(asked).toEqual([]);
  });

  it('reaches the services the page names, and only for a table that has them', async () => {
    const asked = stubFetch('{}', { 'content-type': 'application/json', 'set-cookie': 'a=b' });
    const response = await answer(table, {
      kind: 'get',
      path: '_services/nif/jason/1.4.4?abi=1-2.18',
    });
    expect(asked[0].url).toBe('https://backend.test/api/v1/nif/jason/1.4.4?abi=1-2.18');
    expect(asked[0].init?.credentials).toBe('omit');
    expect(response.headers).toEqual([['content-type', 'application/json']]);
    // git: none named.
    expect(
      (await answer(table, { kind: 'get', path: '_services/git/github.com/a/b/info/refs' })).status,
    ).toBe(404);
    expect(
      (
        await answer(
          { ...table, services: null },
          { kind: 'get', path: '_services/nif/jason/1.4.4' },
        )
      ).status,
    ).toBe(404);
    expect(asked).toHaveLength(1);
  });
});

describe('what a frame may name', () => {
  const runtime = 'npm/@elixir-playground/runtime@1.1.0/';
  const ESCAPES = [
    // The review's: an absolute path on the page's origin.
    `${runtime}/api/private`,
    // Another origin.
    `${runtime}//evil.test/x`,
    `${runtime}https://evil.test/x`,
    `${runtime}http:evil.test/x`,
    `${runtime}javascript:alert(1)`,
    // Climbing out, plain and encoded.
    `${runtime}../../../api/private`,
    `${runtime}chunks/../../../api/private`,
    `${runtime}%2e%2e/%2e%2e/api/private`,
    `${runtime}%2E%2E%2F%2E%2E%2Fapi`,
    `${runtime}chunks%2f..%2f..%2fapi`,
    `${runtime}..\\..\\api`,
    `${runtime}chunks%5c..%5capi`,
    `${runtime}./worker.js`,
    `${runtime}chunks//worker.js`,
    runtime,
  ];

  for (const path of ESCAPES)
    it(`refuses ${JSON.stringify(path)}`, async () => {
      const asked = stubFetch();
      expect((await answer(table, { kind: 'get', path })).status).toBe(404);
      expect(asked).toEqual([]);
    });

  it('keeps the services to their own paths', async () => {
    const asked = stubFetch();
    for (const path of [
      '_services/nif//evil.test/x',
      '_services/nif/../../admin',
      '_services/nif/%2e%2e/%2e%2e/admin',
      '_services/nif/https://evil.test/x',
      '_services/nif',
      '_services/nif/',
    ])
      expect((await answer(table, { kind: 'get', path })).status, path).toBe(404);
    expect(asked).toEqual([]);
  });

  it('fetches a package’s file with no credentials, and keeps a service’s query', async () => {
    const asked = stubFetch();
    await answer(table, { kind: 'get', path: `${runtime}chunks/a-1.js` });
    expect(asked[0].url).toBe(
      'https://apex.test/npm/@elixir-playground/runtime@1.1.0/chunks/a-1.js',
    );
    expect(asked[0].init?.credentials).toBe('omit');
    await answer(table, { kind: 'get', path: '_services/nif/jason/1.4.4/library.tar?abi=1-2.18' });
    expect(asked[1].url).toBe('https://backend.test/api/v1/nif/jason/1.4.4/library.tar?abi=1-2.18');
    expect(asked[1].init?.credentials).toBe('omit');
  });
});

describe('a WebSocket over a port', () => {
  it('opens, carries bytes both ways, and closes', async () => {
    const channel = new MessageChannel();
    const socket = portSocket(channel.port1);
    const events: string[] = [];
    socket.onopen = () => events.push('open');
    socket.onmessage = ({ data }) => events.push(`message ${new Uint8Array(data).join(',')}`);
    socket.onclose = () => events.push('close');
    const sent: unknown[] = [];
    channel.port2.onmessage = ({ data }) => sent.push(data);
    channel.port2.postMessage({ open: true });
    channel.port2.postMessage({ message: new Uint8Array([1, 2]).buffer });
    await vi.waitFor(() => expect(events).toEqual(['open', 'message 1,2']));
    expect(socket.readyState).toBe(1);
    socket.send(new Uint8Array([3, 4]));
    socket.close();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(new Uint8Array((sent[0] as { send: ArrayBuffer }).send)).toEqual(new Uint8Array([3, 4]));
    expect(sent[1]).toEqual({ close: true });
    channel.port2.postMessage({ close: { error: false } });
    await vi.waitFor(() => expect(events).toEqual(['open', 'message 1,2', 'close']));
    expect(socket.readyState).toBe(3);
  });
});
