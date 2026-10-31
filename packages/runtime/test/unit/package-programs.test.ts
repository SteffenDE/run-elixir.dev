// Packages' page programs, worker programs and shared frames
// (docs/packages.md): the site manifest names them, the api
// names a frame's origin (salted, one per package and frame), and the
// frame's page takes ports from its parent alone.
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Site } from '../../src/packages/manifest';
import type { SiteManifest } from '../../src/packages/types';

const manifest = (packages: SiteManifest['packages']): Site =>
  new Site({
    url: 'https://e-x.bridge.test/_bridge/k/',
    manifest: { manifest: 2, packages, boot: null },
  });
const entry = (playground: object) => ({
  version: '2.0.0',
  base: 'https://apex.test/npm/x/',
  files: {},
  playground,
});

it('lists the packages’ page programs, the first package’s for a name', () => {
  const site = manifest({
    '@elixir-playground/claude': entry({ pagePrograms: { claude: 'program.js' } }),
    'other-tool': entry({ pagePrograms: { claude: 'theirs.js', other: './other.js' } }),
    '@elixir-playground/git': entry({ programs: { git: { module: 'git.wasm' } } }),
  });
  expect([...site.pagePrograms()]).toEqual([
    ['claude', { name: '@elixir-playground/claude', version: '2.0.0', module: 'program.js' }],
    ['other', { name: 'other-tool', version: '2.0.0', module: './other.js' }],
  ]);
});

it('lists the packages’ worker programs, by their packages, for their paths below the bridge', () => {
  const site = manifest({
    '@elixir-playground/nodejs': entry({
      workerPrograms: { node: 'workers/nodejs.js' },
      pagePrograms: { npm: 'npm.js', npx: 'npx.js' },
    }),
    'other-tool': entry({ workerPrograms: { node: 'workers/theirs.js', python: 'workers/py.js' } }),
  });
  expect([...site.workerPrograms()]).toEqual([
    ['node', { name: '@elixir-playground/nodejs', version: '2.0.0', script: 'workers/nodejs.js' }],
    ['python', { name: 'other-tool', version: '2.0.0', script: 'workers/py.js' }],
  ]);
  expect([...site.pagePrograms().keys()]).toEqual(['npm', 'npx']);
  expect([...manifest({}).workerPrograms()]).toEqual([]);
});

let api: typeof import('../../../api/src/sharedFrame');
let usercontent: typeof import('../../../api/src/usercontent');
beforeAll(async () => {
  vi.stubGlobal('location', new URL('https://apex.test/'));
  vi.stubGlobal('document', { querySelector: () => null });
  const kept = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  });
  api = await import('../../../api/src/sharedFrame');
  usercontent = await import('../../../api/src/usercontent');
});

it('names a shared frame’s origin by its name and a salted hash of its package', async () => {
  const bridge = { domain: 'bridge.test' } as Parameters<typeof api.frameOrigin>[0];
  const claude = await api.frameOrigin(bridge, '@elixir-playground/claude', 'claude');
  expect(claude).toMatch(/^https:\/\/claude-[a-z0-9]{10}\.bridge\.test$/);
  // Another package's frame of the same name: another origin.
  expect(await api.frameOrigin(bridge, 'other-tool', 'claude')).not.toBe(claude);
  // Another page's secret: another origin.
  usercontent.forgetBridgeSalt();
  localStorage.setItem('playground-bridge-salt', 'another');
  expect(await api.frameOrigin(bridge, '@elixir-playground/claude', 'claude')).not.toBe(claude);
  // Names that would be a project's (e-KEY, v-KEY-PORT) or no label.
  for (const name of ['e', 'v', 'Claude', 'a-b', '1abc', 'x'.repeat(17)])
    await expect(api.frameOrigin(bridge, 'p', name)).rejects.toThrow('not a frame');
});

afterEach(() => vi.restoreAllMocks());

it('takes ports from its parent alone, after saying it loaded', async () => {
  const parent = { postMessage: vi.fn() };
  const handlers: ((event: unknown) => void)[] = [];
  vi.stubGlobal('window', { parent, top: {} });
  vi.stubGlobal('addEventListener', (type: string, handler: (event: unknown) => void) => {
    if (type === 'message') handlers.push(handler);
  });
  const { serveFrame, FRAME_LOADED, FRAME_PORT } = await import('../../src/lib/sharedFrame');
  const taken: MessagePort[] = [];
  serveFrame((port) => taken.push(port));
  expect(parent.postMessage).toHaveBeenCalledWith({ kind: FRAME_LOADED }, '*');
  const port = new MessageChannel().port1;
  for (const handler of handlers) {
    handler({ source: {}, data: { kind: FRAME_PORT }, ports: [port] });
    handler({ source: parent, data: { kind: 'other' }, ports: [port] });
    handler({ source: parent, data: { kind: FRAME_PORT }, ports: [] });
    handler({ source: parent, data: { kind: FRAME_PORT }, ports: [port] });
  }
  expect(taken).toEqual([port]);
  port.close();
});
