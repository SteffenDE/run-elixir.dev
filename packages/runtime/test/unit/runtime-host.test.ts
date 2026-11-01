// create()'s load-time check (packages/api/src/usercontent.ts runtimeHost):
// against the runtime the page serves, its own package.json, not the
// api's build of the runtime, which may be an older minor.
import { beforeAll, expect, it, vi } from 'vitest';
import { checkSite, HOST } from '../../src/packages/check';
import type { SiteManifest } from '../../src/packages/types';

let api: typeof import('../../../api/src/usercontent');
const served = new Map<string, unknown>();
beforeAll(async () => {
  vi.stubGlobal('location', new URL('https://apex.test/'));
  vi.stubGlobal('localStorage', new Map());
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('fetch', async (url: URL) => {
    const body = served.get(String(url));
    return body === undefined
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  });
  api = await import('../../../api/src/usercontent');
});

const site = (range: string): SiteManifest => ({
  manifest: 2,
  boot: null,
  packages: {
    '@elixir-playground/git': {
      version: '1.1.0',
      base: '../git/',
      files: {},
      peerDependencies: { [HOST.name]: range },
      playground: {},
    },
  },
});

it('takes the version and seams of the runtime the page serves', async () => {
  const at = 'https://apex.test/npm/@elixir-playground/runtime@1.3.0/';
  served.set(`${at}package.json`, {
    name: HOST.name,
    version: '1.3.0',
    playground: { provides: { ...HOST.provides, manifest: [2] } },
  });
  const host = await api.runtimeHost(at);
  expect(host.version).toBe('1.3.0');
  // A package that needs the newer minor fits it, not this build's.
  expect(checkSite(site('^1.3.0'), host)).toEqual([]);
  expect(checkSite(site('^9.0.0'), host)).toHaveLength(1);
});

it('has this build’s seams for a package.json without them, and fails for none', async () => {
  const at = 'https://apex.test/node_modules/@elixir-playground/runtime/';
  served.set(`${at}package.json`, { name: HOST.name, version: '1.2.5' });
  expect(await api.runtimeHost(at)).toEqual({
    name: HOST.name,
    version: '1.2.5',
    provides: HOST.provides,
  });
  await expect(api.runtimeHost('https://apex.test/nothing/')).rejects.toThrow('404');
  served.set('https://apex.test/other/package.json', { name: 'left-pad', version: '1.0.0' });
  await expect(api.runtimeHost('https://apex.test/other/')).rejects.toThrow('no @elixir');
});
