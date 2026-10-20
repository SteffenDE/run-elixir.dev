import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { npmProgram, splitRequest, unpackBatches } from '../../src/project/lib/programs/npm';

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
    Object.assign(doc.versions, { [p.version]: { ...p, dist: { tarball: url } } });
    const files: [string, string][] = [['package/package.json', JSON.stringify(p)]];
    for (const file of Object.values(p.bin ?? {})) files.push([`package/${file}`, '']);
    tars[url] = tarOf(files);
  }
  vi.stubGlobal('caches', { open: () => Promise.reject(new Error('none')) });
  vi.stubGlobal('fetch', async (url: string) => {
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
    stat: async (path: string) => (files.has(path) ? 'file' : dirs.has(path) ? 'dir' : null),
    mkdir: async (path: string) => void dirs.add(path),
    remove: async (path: string) => {
      for (const key of [...files.keys()])
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
    },
    unlink: async (path: string) => void links.delete(path),
    symlink: async (target: string, path: string) => void links.set(path, target),
  };
  return { fs, links };
}

type Fs = ReturnType<typeof registry>['fs'];

async function npm(fs: Fs, pkg: object, ...args: string[]) {
  await fs.write('/p/package.json', JSON.stringify(pkg));
  let out = '';
  const code = await new Promise<number>((resolve) => {
    const process = {
      write: (text: string | Uint8Array) =>
        (out += typeof text === 'string' ? text : new TextDecoder().decode(text)),
      exit: (status = 0) => resolve(status),
      onkill: null,
    };
    void npmProgram(() => ({}))(process, { args, cwd: '/p', env: {}, fs } as never);
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
