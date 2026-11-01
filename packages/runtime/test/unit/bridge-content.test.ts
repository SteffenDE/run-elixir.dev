// Bridge mode's `content` (packages/api/src/usercontent.ts): a directory
// that the packages' bases, the boot recordings' and the runtime's path
// resolve below, by default what the page's <meta name="playground-content">
// names, else its origin root.
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

let meta: string | null = null;
let api: typeof import('../../../api/src/usercontent');
beforeAll(async () => {
  vi.stubGlobal('location', new URL('https://apex.test/web/projects/123?x=1'));
  vi.stubGlobal('localStorage', new Map());
  vi.stubGlobal('document', {
    querySelector: (selector: string) =>
      selector.includes('playground-content') && meta !== null ? { content: meta } : null,
  });
  // The runtime's package.json, wherever the page serves it: its version
  // is the one its path names (latest: 2.1.3).
  vi.stubGlobal('fetch', async (url: URL) => {
    const path = new URL(url).pathname;
    const named = path.match(/\/runtime@([^/+]+)[^/]*\/package\.json$/);
    if (!named) return new Response('', { status: 404 });
    const version = named[1] === 'latest' ? '2.1.3' : named[1];
    return new Response(JSON.stringify({ name: '@elixir-playground/runtime', version }));
  });
  api = await import('../../../api/src/usercontent');
});
afterEach(() => {
  meta = null;
});

const otp = {
  name: '@elixir-playground/otp-29.1.2',
  version: '1.0.1',
  base: '/npm/@elixir-playground/otp-29.1.2@1.0.1/',
} as Parameters<typeof api.useBridge>[2][number];
const boot = { base: '/boot/abc/' } as Parameters<typeof api.useBridge>[3] & object;
const runtime = '/npm/@elixir-playground/runtime@1.1.0/';

async function bridged(content?: string) {
  const {
    packages,
    boot: recordings,
    bridge,
  } = await api.useBridge({ domain: 'bridge.test', content }, runtime, [otp], boot, {
    relay: null,
    nif: null,
    git: null,
  });
  return { base: packages[0].base, boot: recordings!.base, sources: bridge.table.sources };
}

it('resolves the bases below a content prefix, not at its origin root', async () => {
  const {
    base,
    boot: recordings,
    sources,
  } = await bridged('https://tidewave.test/web/elixir-playground/');
  expect(base).toBe(
    'https://tidewave.test/web/elixir-playground/npm/@elixir-playground/otp-29.1.2@1.0.1/',
  );
  expect(recordings).toBe('https://tidewave.test/web/elixir-playground/boot/abc/');
  expect(sources).toContainEqual([
    'npm/@elixir-playground/runtime@1.1.0/',
    'https://tidewave.test/web/elixir-playground/npm/@elixir-playground/runtime@1.1.0/',
  ]);
});

it('takes a page-relative content, with or without its trailing slash', async () => {
  expect((await bridged('/web/elixir-playground')).base).toBe(
    'https://apex.test/web/elixir-playground/npm/@elixir-playground/otp-29.1.2@1.0.1/',
  );
});

it("defaults to the page's origin root, not its URL", async () => {
  expect((await bridged()).base).toBe('https://apex.test/npm/@elixir-playground/otp-29.1.2@1.0.1/');
});

it('defaults to the directory <meta name="playground-content"> names', async () => {
  meta = '/web/';
  expect((await bridged()).base).toBe(
    'https://apex.test/web/npm/@elixir-playground/otp-29.1.2@1.0.1/',
  );
});

it('keeps a base that is a URL of its own', async () => {
  const { packages } = await api.useBridge(
    { domain: 'bridge.test', content: 'https://apex.test/web/' },
    runtime,
    [{ ...otp, base: 'https://cdn.test/otp/' }],
    null,
    { relay: null, nif: null, git: null },
  );
  expect(packages[0].base).toBe('https://cdn.test/otp/');
});

it('names the runtime below the bridge by its package.json, wherever the page serves it', async () => {
  // unpkg's layout, the package at the CDN's root (no /npm/).
  const { bridge } = await api.useBridge(
    { domain: 'bridge.test', content: 'https://unpkg.test/' },
    '/@elixir-playground/runtime@latest/',
    [otp],
    null,
    { relay: null, nif: null, git: null },
  );
  expect(bridge.runtime).toBe('npm/@elixir-playground/runtime@2.1.3/');
  expect(bridge.host.version).toBe('2.1.3');
  expect(bridge.table.sources).toContainEqual([
    'npm/@elixir-playground/runtime@2.1.3/',
    'https://unpkg.test/@elixir-playground/runtime@latest/',
  ]);
  // A site build's directory (NAME@VERSION+ID): the version alone.
  const built = await api.useBridge(
    { domain: 'bridge.test', content: 'https://apex.test/' },
    '/npm/@elixir-playground/runtime@2.0.0+e5a3e7140012/',
    [],
    null,
    { relay: null, nif: null, git: null },
  );
  expect(built.bridge.runtime).toBe('npm/@elixir-playground/runtime@2.0.0/');
});

it('fails with ERUNTIME when the page serves no runtime there', async () => {
  await expect(
    api.useBridge({ domain: 'bridge.test' }, '/nothing/', [otp], null, {
      relay: null,
      nif: null,
      git: null,
    }),
  ).rejects.toMatchObject({ code: 'ERUNTIME' });
});
