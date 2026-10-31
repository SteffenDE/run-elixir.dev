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
