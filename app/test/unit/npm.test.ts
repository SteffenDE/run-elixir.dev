import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  forgetPackuments,
  npmProgram,
  npxProgram,
  splitRequest,
  unpackBatches,
} from '@/project/lib/programs/npm';

afterEach(() => vi.unstubAllGlobals());

const at = (...locations: string[]) => locations.map((location) => ({ location }));
const names = (batches: { location: string }[][]) =>
  batches.map((batch) => batch.map((p) => p.location));

describe('unpackBatches', () => {
  test('a package and one nested in it are never unpacked together', () => {
    const batches = unpackBatches(
      at('node_modules/a', 'node_modules/b', 'node_modules/a/node_modules/c'),
      6,
    );
    expect(names(batches)).toEqual([
      ['node_modules/a', 'node_modules/b'],
      ['node_modules/a/node_modules/c'],
    ]);
  });

  test('scoped packages are a level, as their names hold a slash', () => {
    const batches = unpackBatches(
      at('node_modules/@s/a', 'node_modules/b', 'node_modules/@s/a/node_modules/@t/c'),
      6,
    );
    expect(names(batches)).toEqual([
      ['node_modules/@s/a', 'node_modules/b'],
      ['node_modules/@s/a/node_modules/@t/c'],
    ]);
  });

  test('a level goes in batches of the size', () => {
    const batches = unpackBatches(at('node_modules/a', 'node_modules/b', 'node_modules/c'), 2);
    expect(names(batches)).toEqual([['node_modules/a', 'node_modules/b'], ['node_modules/c']]);
  });
});

// npm install against packages a stubbed registry serves (each test's
// names its own: the registry's metadata is kept per page), into files
// kept in memory.
interface Pkg {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  cpu?: string[];
  bin?: Record<string, string>;
}

function tarOf(files: [string, string][]): Uint8Array<ArrayBuffer> {
  const blocks: Buffer[] = [];
  for (const [name, text] of files) {
    const header = Buffer.alloc(512);
    const body = Buffer.from(text);
    header.write(name, 0);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('0', 156);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return new Uint8Array(gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
}

function registry(pkgs: Pkg[]) {
  const docs: Record<string, { 'dist-tags': Record<string, string>; versions: object }> = {};
  const tars: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const p of pkgs) {
    const url = `https://t/${p.name}-${p.version}.tgz`;
    const doc = (docs[p.name] ??= { 'dist-tags': {}, versions: {} });
    doc['dist-tags'].latest = p.version;
    const files: [string, string][] = [['package/package.json', JSON.stringify(p)]];
    for (const file of Object.values(p.bin ?? {})) files.push([`package/${file}`, '']);
    tars[url] = tarOf(files);
    const integrity = `sha512-${createHash('sha512').update(tars[url]).digest('base64')}`;
    Object.assign(doc.versions, { [p.version]: { ...p, dist: { tarball: url, integrity } } });
  }
  // Cache Storage, which a reload keeps.
  const cached = new Map<string, Response>();
  const cache = {
    match: async (url: string) => cached.get(url)?.clone(),
    put: async (url: string, response: Response) => void cached.set(url, response),
  };
  vi.stubGlobal('caches', { open: async () => cache });
  // Every request, the registry's metadata and tarballs both.
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    if (!url.startsWith('https://registry.npmjs.org/')) return new Response(tars[url]);
    const doc = docs[decodeURIComponent(url.slice(27))];
    return doc ? new Response(JSON.stringify(doc)) : new Response('', { status: 404 });
  });
  const files = new Map<string, Uint8Array>();
  const links = new Map<string, string>();
  const dirs = new Set<string>(['/p']);
  const fs = {
    read: async (path: string) => {
      const file = files.get(path);
      if (!file) throw new Error(`ENOENT ${path}`);
      return file;
    },
    write: async (path: string, data: string | Uint8Array) =>
      void files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data),
    // (A link as what it names.)
    stat: async (path: string) => {
      const target = links.get(path);
      if (target) path = new URL(target, `file://${path}`).pathname;
      return files.has(path) ? 'file' : dirs.has(path) ? 'dir' : null;
    },
    mkdir: async (path: string) => void dirs.add(path),
    remove: async (path: string) => {
      for (const key of [...files.keys()])
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
    },
    unlink: async (path: string) => void links.delete(path),
    symlink: async (target: string, path: string) => void links.set(path, target),
  };
  return { fs, links, requests };
}

type Fs = ReturnType<typeof registry>['fs'];

async function npm(fs: Fs, pkg: object, ...args: string[]) {
  await fs.write('/p/package.json', JSON.stringify(pkg));
  return runIn(
    fs,
    npmProgram(() => ({})),
    args,
  );
}

// npx, with a node that says what it would run.
function npx(fs: Fs, ...args: string[]) {
  const node = (
    process: { write(text: string): void; exit(code: number): void },
    context: { args: string[] },
  ) => {
    process.write(`node ${context.args.join(' ')}\n`);
    process.exit(0);
  };
  return runIn(
    fs,
    npxProgram(() => ({ node }) as never),
    args,
  );
}

async function runIn(fs: Fs, program: (process: never, context: never) => unknown, args: string[]) {
  let out = '';
  const code = await new Promise<number>((resolve) => {
    const process = {
      write: (text: string | Uint8Array) =>
        (out += typeof text === 'string' ? text : new TextDecoder().decode(text)),
      exit: (status = 0) => resolve(status),
      onkill: null,
    };
    void program(process as never, { args, cwd: '/p', env: { HOME: '/h' }, fs } as never);
  });
  return { out, code };
}

// The lock's packages: location → version (and dev).
async function installed(fs: Fs) {
  const lock = JSON.parse(new TextDecoder().decode(await fs.read('/p/package-lock.json')));
  const packages = lock.packages as Record<string, { version: string; dev?: boolean }>;
  return Object.fromEntries(
    Object.entries(packages)
      .filter(([location]) => location)
      .map(([location, p]) => [location, `${p.version}${p.dev ? ' dev' : ''}`]),
  );
}

describe('npm install', () => {
  test("a peer that conflicts with the project's dependency leaves it, with a warning", async () => {
    const { fs } = registry([
      { name: 'p1-react', version: '17.0.0' },
      { name: 'p1-react', version: '18.0.0' },
      { name: 'p1-lib', version: '1.0.0', peerDependencies: { 'p1-react': '^18' } },
    ]);
    const { out, code } = await npm(
      fs,
      { dependencies: { 'p1-react': '^17.0.0', 'p1-lib': '1.0.0' } },
      'install',
    );
    expect(code).toBe(0);
    expect(out).toContain('ERESOLVE');
    expect(await installed(fs)).toEqual({
      'node_modules/p1-lib': '1.0.0',
      'node_modules/p1-react': '17.0.0',
    });
  });

  // Rolldown's WebAssembly binding pins @emnapi/core and wants
  // @napi-rs/wasm-runtime ~1.2.5, whose 1.2.6 peers on another one.
  test('a version whose peers take what its package pins beside it is preferred', async () => {
    const { fs } = registry([
      { name: 'p9-core', version: '2.0.0-alpha.5' },
      { name: 'p9-core', version: '2.0.0-beta.2' },
      { name: 'p9-runtime', version: '1.2.5', peerDependencies: { 'p9-core': '^2.0.0-alpha.4' } },
      { name: 'p9-runtime', version: '1.2.6', peerDependencies: { 'p9-core': '2.0.0-beta.2' } },
      {
        name: 'p9-binding',
        version: '1.0.0',
        dependencies: { 'p9-core': '2.0.0-alpha.5', 'p9-runtime': '~1.2.5' },
      },
    ]);
    const { code } = await npm(fs, { dependencies: { 'p9-binding': '1.0.0' } }, 'install');
    expect(code).toBe(0);
    expect(await installed(fs)).toEqual({
      'node_modules/p9-binding': '1.0.0',
      'node_modules/p9-core': '2.0.0-alpha.5',
      'node_modules/p9-runtime': '1.2.5',
    });
  });

  test('a package goes no higher than where it would hide the copy another one uses', async () => {
    const { fs } = registry([
      { name: 'p2-x', version: '1.0.0' },
      { name: 'p2-x', version: '2.0.0' },
      { name: 'p2-d', version: '1.0.0' },
      { name: 'p2-d', version: '2.0.0', dependencies: { 'p2-x': '^1' } },
      { name: 'p2-e', version: '1.0.0' },
      { name: 'p2-e', version: '2.0.0', dependencies: { 'p2-x': '^2' } },
      { name: 'p2-a', version: '1.0.0', dependencies: { 'p2-d': '^2', 'p2-e': '^2' } },
    ]);
    const deps = { 'p2-x': '^1', 'p2-d': '^1', 'p2-e': '^1', 'p2-a': '1.0.0' };
    await npm(fs, { dependencies: deps }, 'install');
    expect(await installed(fs)).toEqual({
      'node_modules/p2-a': '1.0.0',
      'node_modules/p2-a/node_modules/p2-d': '2.0.0',
      'node_modules/p2-a/node_modules/p2-e': '2.0.0',
      'node_modules/p2-a/node_modules/p2-e/node_modules/p2-x': '2.0.0',
      'node_modules/p2-d': '1.0.0',
      'node_modules/p2-e': '1.0.0',
      'node_modules/p2-x': '1.0.0',
    });
  });

  test("an alias's bins link into its folder", async () => {
    const { fs, links } = registry([
      { name: 'p3-typescript', version: '5.0.0', bin: { tsc: 'bin/tsc' } },
    ]);
    await npm(fs, { dependencies: { 'p3-ts5': 'npm:p3-typescript@^5' } }, 'install');
    expect(Object.fromEntries(links)).toEqual({
      '/p/node_modules/.bin/tsc': '../p3-ts5/bin/tsc',
    });
  });

  test('an alias installs by name@npm:package@range', async () => {
    const { fs } = registry([{ name: 'p4-typescript', version: '5.1.0' }]);
    const { code } = await npm(fs, {}, 'install', 'p4-ts5@npm:p4-typescript@~5.1');
    expect(code).toBe(0);
    const pkg = JSON.parse(new TextDecoder().decode(await fs.read('/p/package.json')));
    expect(pkg.dependencies).toEqual({ 'p4-ts5': 'npm:p4-typescript@~5.1' });
    expect(await installed(fs)).toEqual({ 'node_modules/p4-ts5': '5.1.0' });
  });

  test('what a dependency leads to is not dev, however it was found first', async () => {
    const { fs } = registry([
      { name: 'p5-c', version: '1.0.0', dependencies: { 'p5-e': '1' } },
      { name: 'p5-e', version: '1.0.0' },
      { name: 'p5-b', version: '1.0.0', dependencies: { 'p5-c': '1' } },
      { name: 'p5-a', version: '1.0.0', dependencies: { 'p5-d': '1' } },
      { name: 'p5-d', version: '1.0.0', dependencies: { 'p5-c': '1' } },
    ]);
    const pkg = { dependencies: { 'p5-a': '1.0.0' }, devDependencies: { 'p5-b': '1.0.0' } };
    await npm(fs, pkg, 'install');
    expect(await installed(fs)).toEqual({
      'node_modules/p5-a': '1.0.0',
      'node_modules/p5-b': '1.0.0 dev',
      'node_modules/p5-c': '1.0.0',
      'node_modules/p5-d': '1.0.0',
      'node_modules/p5-e': '1.0.0',
    });
  });

  test('a request splits at the @ after its name', () => {
    expect(splitRequest('@s/a@1.2')).toEqual(['@s/a', '1.2']);
    expect(splitRequest('@s/a')).toEqual(['@s/a', 'latest']);
    expect(splitRequest('ts5@npm:@s/ts@5')).toEqual(['ts5', 'npm:@s/ts@5']);
  });
});

describe('npx', () => {
  test('an exact version it installed before runs again without the registry', async () => {
    const { fs, requests } = registry([
      { name: '@n1/tool', version: '1.2.3', bin: { tool: 'bin/tool.js' } },
    ]);
    const first = await npx(fs, '-y', '@n1/tool@1.2.3', 'hi');
    expect(first.out).toBe('node /h/.npm/_npx/@n1+tool@1.2.3/node_modules/.bin/tool hi\n');
    expect(requests.length).toBe(2);
    requests.length = 0;
    forgetPackuments();
    const again = await npx(fs, '-y', '@n1/tool@1.2.3', 'again');
    expect(again.out).toBe('node /h/.npm/_npx/@n1+tool@1.2.3/node_modules/.bin/tool again\n');
    expect(requests).toEqual([]);
  });
});

// What of the registry an install fetched: the packages whose metadata
// it asked for, and the tarballs.
const asked = (requests: string[]) => ({
  metadata: requests
    .filter((url) => url.startsWith('https://registry.npmjs.org/'))
    .map((url) => decodeURIComponent(url.slice(27)))
    .sort(),
  tarballs: requests.filter((url) => !url.startsWith('https://registry.npmjs.org/')).length,
});

describe('npm install with a lock', () => {
  const tree = (prefix: string): Pkg[] => [
    { name: `${prefix}-a`, version: '1.0.0', dependencies: { [`${prefix}-b`]: '^1' } },
    { name: `${prefix}-b`, version: '1.0.0', peerDependencies: { [`${prefix}-c`]: '*' } },
    { name: `${prefix}-c`, version: '1.0.0' },
    { name: `${prefix}-new`, version: '1.0.0', dependencies: { [`${prefix}-c`]: '^1' } },
  ];

  test('after a reload, an unchanged package.json installs without the registry', async () => {
    const { fs, requests } = registry(tree('l1'));
    const pkg = { dependencies: { 'l1-a': '^1' } };
    await npm(fs, pkg, 'install');
    const before = await installed(fs);
    expect(Object.keys(before)).toHaveLength(3);
    forgetPackuments();
    requests.length = 0;
    const again = await npm(fs, pkg, 'install');
    expect(again.out).toContain('up to date, 3 packages');
    expect(asked(requests)).toEqual({ metadata: [], tarballs: 0 });
    // And without node_modules (npm ci): the tarballs alone, by the lock's URLs.
    forgetPackuments();
    requests.length = 0;
    const ci = await npm(fs, pkg, 'ci');
    expect(ci.out).toContain('added 3 packages');
    expect(asked(requests)).toEqual({ metadata: [], tarballs: 0 });
    expect(await installed(fs)).toEqual(before);
  });

  test("another platform's build, and a WebAssembly build the registry has not, are known after a reload", async () => {
    const { fs, requests } = registry([
      {
        name: 'l5-native',
        version: '1.0.0',
        optionalDependencies: { 'l5-native-linux-x64-gnu': '1.0.0' },
      },
      { name: 'l5-native-linux-x64-gnu', version: '1.0.0', cpu: ['x64'] },
    ]);
    const pkg = { dependencies: { 'l5-native': '1.0.0' } };
    await npm(fs, pkg, 'install');
    expect(asked(requests).metadata).toEqual([
      'l5-native',
      'l5-native-linux-x64-gnu',
      'l5-native-wasm32-wasi',
    ]);
    expect(await installed(fs)).toEqual({
      'node_modules/l5-native': '1.0.0',
      'node_modules/l5-native-linux-x64-gnu': '1.0.0',
    });
    forgetPackuments();
    requests.length = 0;
    expect((await npm(fs, pkg, 'install')).out).toContain('up to date, 1 packages');
    expect(asked(requests)).toEqual({ metadata: [], tarballs: 0 });
  });

  test('npm install NAME fetches the metadata of what is new alone', async () => {
    const { fs, requests } = registry(tree('l2'));
    await npm(fs, { dependencies: { 'l2-a': '^1' } }, 'install');
    forgetPackuments();
    requests.length = 0;
    const pkg = JSON.parse(new TextDecoder().decode(await fs.read('/p/package.json')));
    await npm(fs, pkg, 'install', 'l2-new');
    // l2-c, its dependency, is the lock's already.
    expect(asked(requests)).toEqual({ metadata: ['l2-new'], tarballs: 1 });
    expect(await installed(fs)).toMatchObject({ 'node_modules/l2-new': '1.0.0' });
  });

  test("a locked version the package.json no longer allows is the registry's again", async () => {
    const { fs, requests } = registry([
      ...tree('l3'),
      { name: 'l3-a', version: '2.0.0', dependencies: { 'l3-b': '^1' } },
    ]);
    // (The lock's l3-a@1 kept while ^1 allows it, though 2.0.0 is latest.)
    await npm(fs, { dependencies: { 'l3-a': '1.0.0' } }, 'install');
    forgetPackuments();
    requests.length = 0;
    await npm(fs, { dependencies: { 'l3-a': '^1' } }, 'install');
    expect(asked(requests)).toEqual({ metadata: [], tarballs: 0 });
    forgetPackuments();
    requests.length = 0;
    await npm(fs, { dependencies: { 'l3-a': '^2' } }, 'install');
    expect(asked(requests)).toEqual({ metadata: ['l3-a'], tarballs: 1 });
    expect(await installed(fs)).toMatchObject({ 'node_modules/l3-a': '2.0.0' });
  });

  test('npx of a range fetches its own metadata alone after a reload', async () => {
    const { fs, requests } = registry([
      ...tree('l4'),
      {
        name: 'l4-tool',
        version: '1.0.0',
        dependencies: { 'l4-a': '^1' },
        bin: { 'l4-tool': 'cli.js' },
      },
    ]);
    await npx(fs, 'l4-tool@^1');
    forgetPackuments();
    requests.length = 0;
    const again = await npx(fs, 'l4-tool@^1', 'x');
    expect(again.out).toBe('node /h/.npm/_npx/l4-tool@^1/node_modules/.bin/l4-tool x\n');
    expect(asked(requests)).toEqual({ metadata: ['l4-tool'], tarballs: 0 });
  });
});
