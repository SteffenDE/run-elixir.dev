// The plugin over a fixture site: a page, and node_modules with a runtime
// package and a descriptor package as npm installs them (plus one that is
// no playground package, and a template of the site's own).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { expect, test } from 'vitest';
import { elixirPlayground, findPackages } from '../src/index';

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'playground-vite-'));
  write(join(root, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  const scope = join(root, 'node_modules', '@elixir-playground');
  write(
    join(scope, 'runtime', 'package.json'),
    JSON.stringify({
      name: '@elixir-playground/runtime',
      version: '1.2.0',
      playground: { provides: {} },
    }),
  );
  write(join(scope, 'runtime', 'exec.html'), '<!doctype html>');
  write(join(scope, 'runtime', 'root', 'sw.js'), '// sw');
  write(join(scope, 'runtime', 'root', 'relay.html'), '<!doctype html>');
  write(join(scope, 'runtime', 'root', 'bridge.html'), '<!doctype html><title>bridge</title>');
  write(
    join(scope, 'git', 'package.json'),
    JSON.stringify({
      name: '@elixir-playground/git',
      version: '1.0.3',
      playground: { programs: {} },
    }),
  );
  write(join(scope, 'git', 'git.wasm'), 'wasm');
  write(join(scope, 'git', 'fs', 'manifest.json'), '[]');
  write(
    join(scope, 'api', 'package.json'),
    JSON.stringify({ name: '@elixir-playground/api', version: '1.0.0' }),
  );
  // Another scope's playground package, one of none, and a package whose
  // `playground` is no object.
  write(
    join(root, 'node_modules', '@acme', 'python', 'package.json'),
    JSON.stringify({ name: '@acme/python', version: '0.2.0', playground: { workerPrograms: {} } }),
  );
  write(
    join(root, 'node_modules', 'ruby-shell', 'package.json'),
    JSON.stringify({ name: 'ruby-shell', version: '3.0.0', playground: { pagePrograms: {} } }),
  );
  write(
    join(root, 'node_modules', 'left-pad', 'package.json'),
    JSON.stringify({ name: 'left-pad', version: '1.3.0', playground: 'yes' }),
  );
  write(
    join(root, 'template', 'package.json'),
    JSON.stringify({ name: 'my-template', version: '0.1.0', playground: { template: {} } }),
  );
  return root;
}

test('finds the runtime and the packages with a playground field, of any scope', () => {
  const root = fixture();
  expect(findPackages(root, ['template']).map(({ name }) => name)).toEqual([
    'my-template',
    '@acme/python',
    '@elixir-playground/git',
    '@elixir-playground/runtime',
    'ruby-shell',
  ]);
});

test('vite build lays the packages out in the apex’s own output, and names them in its pages', async () => {
  const root = fixture();
  await build({
    root,
    logLevel: 'silent',
    plugins: [
      elixirPlayground({ usercontent: 'run-elixir-usercontent.org', packages: ['template'] }),
    ],
  });
  const dist = join(root, 'dist');
  const page = readFileSync(join(dist, 'index.html'), 'utf8');
  expect(page).toContain(
    '<meta name="playground-runtime" content="/npm/@elixir-playground/runtime@1.2.0/">',
  );
  expect(page).toContain('<meta name="playground-content" content="/">');
  expect(page).toContain(
    '<meta name="playground-usercontent" content="run-elixir-usercontent.org">',
  );
  expect(readFileSync(join(dist, 'npm/@elixir-playground/git@1.0.3/git.wasm'), 'utf8')).toBe(
    'wasm',
  );
  for (const file of [
    'npm/@elixir-playground/runtime@1.2.0/exec.html',
    'npm/@elixir-playground/runtime@1.2.0/root/sw.js',
    'npm/@elixir-playground/git@1.0.3/fs/manifest.json',
    'npm/my-template@0.1.0/package.json',
  ])
    expect(existsSync(join(dist, file)), file).toBe(true);
  expect(existsSync(join(dist, 'npm/@elixir-playground/api@1.0.0'))).toBe(false);
  expect(existsSync(join(dist, 'npm/@acme/python@0.2.0/package.json'))).toBe(true);
  expect(existsSync(join(dist, 'npm/ruby-shell@3.0.0/package.json'))).toBe(true);
  expect(existsSync(join(dist, 'npm/left-pad@1.3.0'))).toBe(false);
  // The bootstrap is the shared domain's alone: any site could frame it
  // and run its code on the apex.
  for (const file of ['bridge.html', 'npm/@elixir-playground/runtime@1.2.0/root/bridge.html'])
    expect(existsSync(join(dist, file)), file).toBe(false);
  // No usercontent domain of its own: no folder for one, no playground.json.
  expect(existsSync(join(root, 'dist-usercontent'))).toBe(false);
  expect(existsSync(join(dist, 'playground.json'))).toBe(false);
});

test('without a usercontent domain, the pages name none (create() takes run-elixir.dev’s)', async () => {
  const root = fixture();
  await build({ root, logLevel: 'silent', plugins: [elixirPlayground()] });
  expect(readFileSync(join(root, 'dist', 'index.html'), 'utf8')).not.toContain(
    'playground-usercontent',
  );
});

test("the packages follow Vite's base", async () => {
  const root = fixture();
  await build({ root, base: '/web/', logLevel: 'silent', plugins: [elixirPlayground()] });
  const dist = join(root, 'dist');
  const page = readFileSync(join(dist, 'index.html'), 'utf8');
  expect(page).toContain('<meta name="playground-content" content="/web/">');
  expect(page).toContain(
    '<meta name="playground-runtime" content="/npm/@elixir-playground/runtime@1.2.0/">',
  );
  // dist/ is served at /web/: the packages at /web/npm/….
  expect(existsSync(join(dist, 'npm/@elixir-playground/git@1.0.3/git.wasm'))).toBe(true);
});

test('a *.localhost usercontent domain written with its scheme is answered locally', () => {
  for (const usercontent of ['usercontent.localhost:5173', 'https://usercontent.localhost:5173']) {
    const config = (elixirPlayground({ usercontent }).config as () => Record<string, any>)();
    expect(config.server.allowedHosts).toEqual(['.usercontent.localhost']);
  }
  const shared = (
    elixirPlayground({ usercontent: 'https://run-elixir-usercontent.org' }).config as () => Record<
      string,
      any
    >
  )();
  expect(shared.server).toBeUndefined();
});

// An elixir package whose prepare writes a stand-in layer (and says what
// it was asked), and the otp packages it may run on.
function withElixir(root: string): void {
  const scope = join(root, 'node_modules', '@elixir-playground');
  write(
    join(scope, 'elixir', 'package.json'),
    JSON.stringify({
      name: '@elixir-playground/elixir',
      version: '3.0.0',
      playground: { bin: {} },
    }),
  );
  write(join(scope, 'elixir', 'builds.js'), "export const DEFAULT = '1.20.4-otp-29';\n");
  write(
    join(scope, 'elixir', 'prepare.js'),
    `import { mkdirSync, writeFileSync } from 'node:fs';
     import { join } from 'node:path';
     export async function prepare({ build, archives, otp, into }) {
       const at = join(into, 'versions', build);
       mkdirSync(at, { recursive: true });
       writeFileSync(join(at, 'fs.json'), JSON.stringify({ otp, archives }));
     }\n`,
  );
  for (const otp of ['28.3', '29.1.2'])
    write(
      join(scope, `otp-${otp}`, 'package.json'),
      JSON.stringify({
        name: `@elixir-playground/otp-${otp}`,
        version: '1.1.0',
        playground: { otp },
      }),
    );
}

test('vite build prepares the Elixir builds below the elixir package, each on its OTP', async () => {
  const root = fixture();
  withElixir(root);
  await build({
    root,
    logLevel: 'silent',
    plugins: [
      elixirPlayground({
        elixir: { builds: ['1.20.4-otp-29', '1.19.5-otp-28'], archives: { phx_new: '1.8.16' } },
      }),
    ],
  });
  const elixir = join(root, 'dist', 'npm/@elixir-playground/elixir@3.0.0');
  expect(existsSync(join(elixir, 'prepare.js'))).toBe(true);
  for (const [build, otp] of [
    ['1.20.4-otp-29', 'otp-29.1.2'],
    ['1.19.5-otp-28', 'otp-28.3'],
  ])
    expect(JSON.parse(readFileSync(join(elixir, 'versions', build, 'fs.json'), 'utf8'))).toEqual({
      otp: join(root, 'node_modules', '@elixir-playground', otp),
      archives: { phx_new: '1.8.16' },
    });
  // Kept for the next build, below node_modules/.cache.
  expect(
    existsSync(
      join(root, 'node_modules/.cache/elixir-playground/elixir@3.0.0/versions/1.20.4-otp-29'),
    ),
  ).toBe(true);
});

test("by default the elixir package's default build; one without its OTP fails", async () => {
  const root = fixture();
  withElixir(root);
  await build({ root, logLevel: 'silent', plugins: [elixirPlayground()] });
  expect(readdirSync(join(root, 'dist', 'npm/@elixir-playground/elixir@3.0.0/versions'))).toEqual([
    '1.20.4-otp-29',
  ]);
  await expect(
    build({
      root,
      logLevel: 'silent',
      plugins: [elixirPlayground({ elixir: { builds: ['1.18.4-otp-27'] } })],
    }),
  ).rejects.toThrow(/needs an otp package of OTP 27/);
});

test("the site's package.json names its Elixir builds and archives", async () => {
  const root = fixture();
  withElixir(root);
  write(
    join(root, 'package.json'),
    JSON.stringify({
      private: true,
      elixirPlayground: {
        elixir: { builds: ['1.19.5-otp-28'], archives: { phx_new: '1.8.16' } },
      },
    }),
  );
  await build({ root, logLevel: 'silent', plugins: [elixirPlayground()] });
  const versions = join(root, 'dist', 'npm/@elixir-playground/elixir@3.0.0/versions');
  expect(readdirSync(versions)).toEqual(['1.19.5-otp-28']);
  expect(
    JSON.parse(readFileSync(join(versions, '1.19.5-otp-28', 'fs.json'), 'utf8')).archives,
  ).toEqual({ phx_new: '1.8.16' });
});
