// The plugin over a fixture site: a page, and node_modules with a runtime
// package and a descriptor package as npm installs them (plus one that is
// no playground package, and a template of the site's own).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { expect, test } from 'vitest';
import { elixirPlayground, findPackages, headers } from '../src/index';

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
  write(
    join(root, 'template', 'package.json'),
    JSON.stringify({ name: 'my-template', version: '0.1.0', playground: { template: {} } }),
  );
  return root;
}

test('finds the runtime and the packages with a playground field', () => {
  const root = fixture();
  expect(findPackages(root, ['template']).map(({ name }) => name)).toEqual([
    'my-template',
    '@elixir-playground/git',
    '@elixir-playground/runtime',
  ]);
});

test('vite build lays out the usercontent domain and tells the apex where the runtime is', async () => {
  const root = fixture();
  await build({
    root,
    logLevel: 'silent',
    plugins: [
      elixirPlayground({
        apex: 'example.com',
        usercontent: 'example-usercontent.com',
        embedders: ['https://other.example'],
        packages: ['template'],
      }),
    ],
  });
  // The apex's page and configuration.
  const page = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
  expect(page).toContain(
    '<meta name="playground-runtime" content="/npm/@elixir-playground/runtime@1.2.0/">',
  );
  const site = {
    domain: 'example.com',
    usercontent: 'example-usercontent.com',
    embedders: ['https://other.example'],
  };
  expect(JSON.parse(readFileSync(join(root, 'dist', 'playground.json'), 'utf8'))).toEqual(site);
  // The usercontent domain's.
  const out = join(root, 'dist-usercontent');
  expect(JSON.parse(readFileSync(join(out, 'playground.json'), 'utf8'))).toEqual(site);
  for (const file of [
    'sw.js',
    'relay.html',
    '_headers',
    'npm/@elixir-playground/runtime@1.2.0/exec.html',
    'npm/@elixir-playground/git@1.0.3/git.wasm',
    'npm/@elixir-playground/git@1.0.3/fs/manifest.json',
    'npm/my-template@0.1.0/package.json',
  ])
    expect(existsSync(join(out, file)), file).toBe(true);
  expect(existsSync(join(out, 'npm/@elixir-playground/api@1.0.0'))).toBe(false);
});

test("the headers: isolation everywhere, the packages immutable, the Node.js worker's policy", () => {
  const text = headers({ usercontent: 'u.example' }, '/npm/@elixir-playground/runtime@1.2.0/');
  expect(text).toContain('/*\n  Cross-Origin-Embedder-Policy: require-corp\n');
  expect(text).toContain('/npm/*\n  Cache-Control: public, max-age=31536000, immutable\n');
  expect(text).toContain(
    '/npm/@elixir-playground/runtime@1.2.0/nodejs.js\n  Content-Security-Policy: ' +
      "default-src 'none'; script-src https://*.u.example/npm/@elixir-playground/runtime@1.2.0/nodejs.js " +
      "https://*.u.example/npm/@elixir-playground/runtime@1.2.0/chunks/ 'unsafe-eval' 'wasm-unsafe-eval';",
  );
});

test('a build without the apex fails', async () => {
  const root = fixture();
  await expect(
    build({ root, logLevel: 'silent', plugins: [elixirPlayground({ usercontent: 'u.example' })] }),
  ).rejects.toThrow(/name the site's host \(apex\)/);
});
