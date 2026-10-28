import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createLoader } from '../../src/nodejs/loader';
import { createPath } from '../../src/nodejs/path';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

// A directory of `files` (by their path in it), and a loader whose
// builtin module is node:module's createRequire, the loader's own.
function project(files: Record<string, string>) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'loader-')));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(join(root, name, '..'), { recursive: true });
    fs.writeFileSync(join(root, name), text);
  }
  const loader = createLoader({
    fs: fs as never,
    path: createPath(() => root),
    builtin: (name) => (name === 'module' ? { createRequire: loader.createRequire } : undefined),
    builtins: ['module'],
    env: {},
  });
  return { root, loader };
}

// A package whose require and import entries say which they are.
const DUAL = {
  'node_modules/dual/package.json': JSON.stringify({
    name: 'dual',
    exports: { import: './esm.mjs', require: './cjs.cjs' },
  }),
  'node_modules/dual/esm.mjs': "export const kind = 'import';",
  'node_modules/dual/cjs.cjs': "exports.kind = 'require';",
};

describe("an ES module's require", () => {
  test("createRequire's takes the package's require entry", async () => {
    const { root, loader } = project({
      ...DUAL,
      'main.mjs': `import { createRequire } from 'module';
        import { kind as imported } from 'dual';
        const require = createRequire(import.meta.url);
        export const kinds = [imported, require('dual').kind];`,
    });
    await loader.runMain(`${root}/main.mjs`);
    expect((loader.cache[`${root}/main.mjs`].exports as { kinds: string[] }).kinds).toEqual([
      'import',
      'require',
    ]);
  });

  test("createRequire's resolves from its own directory", async () => {
    const { root, loader } = project({
      'other/node_modules/there/index.js': "module.exports = 'there';",
      'main.mjs': `import { createRequire } from 'module';
        const require = createRequire(new URL('./other/x.js', import.meta.url));
        export const there = require('there');`,
    });
    await loader.runMain(`${root}/main.mjs`);
    expect((loader.cache[`${root}/main.mjs`].exports as { there: string }).there).toBe('there');
  });

  test('is not there unless it declares one, as in Node', async () => {
    const { root, loader } = project({
      ...DUAL,
      'main.mjs': `export const kind = typeof require;
        export const call = () => require('dual');`,
    });
    await loader.runMain(`${root}/main.mjs`);
    const exports = loader.cache[`${root}/main.mjs`].exports as { kind: string; call(): unknown };
    expect(exports.kind).toBe('undefined');
    expect(() => exports.call()).toThrow(ReferenceError);
  });

  test("TypeScript's import x = require() is the loader's", async () => {
    const { root, loader } = project({
      'plain.cjs': "exports.kind = 'plain';",
      'main.mts': `import plain = require('./plain.cjs');
        export const kind: string = plain.kind;`,
    });
    await loader.runMain(`${root}/main.mts`);
    expect((loader.cache[`${root}/main.mts`].exports as { kind: string }).kind).toBe('plain');
  });
});

describe('an import of a module that awaits at its top level', () => {
  const AWAITS = {
    'awaits.mjs': 'export const value = await Promise.resolve(42);',
    'between.mjs': "export { value } from './awaits.mjs';",
  };
  const exportsOf = (loader: ReturnType<typeof project>['loader'], file: string) =>
    loader.cache[file].exports as Record<string, unknown>;

  test('runs its importer once it has its value', async () => {
    const { root, loader } = project({
      ...AWAITS,
      'main.mjs': "import { value } from './awaits.mjs'; export const seen = value;",
    });
    await loader.runMain(`${root}/main.mjs`);
    expect(exportsOf(loader, `${root}/main.mjs`).seen).toBe(42);
  });

  test('holds the importers of its importer too', async () => {
    const { root, loader } = project({
      ...AWAITS,
      'main.mjs': "import { value } from './between.mjs'; export const seen = value;",
    });
    await loader.runMain(`${root}/main.mjs`);
    expect(exportsOf(loader, `${root}/main.mjs`).seen).toBe(42);
  });

  test('by import() too', async () => {
    const { root, loader } = project({
      ...AWAITS,
      'main.mjs': "export const seen = (await import('./between.mjs')).value;",
    });
    await loader.runMain(`${root}/main.mjs`);
    expect(exportsOf(loader, `${root}/main.mjs`).seen).toBe(42);
  });

  test('once it has run, holds no importer', async () => {
    const { root, loader } = project({
      ...AWAITS,
      'main.mjs': `import { createRequire } from 'module';
        await import('./awaits.mjs');
        export const seen = createRequire(import.meta.url)('./between.mjs').value;`,
    });
    await loader.runMain(`${root}/main.mjs`);
    expect(exportsOf(loader, `${root}/main.mjs`).seen).toBe(42);
  });

  test('that fails fails its importer', async () => {
    const { root, loader } = project({
      'fails.mjs': "await null; throw new Error('no');",
      'main.mjs': "import './fails.mjs';",
    });
    await expect(loader.runMain(`${root}/main.mjs`)).rejects.toThrow('no');
  });
});

describe('a method named import', () => {
  const METHODS = `class R { import(x) { return x * 2; } static import(x) { return x * 3; }
      async import2() {} }
    class G { get import() { return 1; } }
    class S { async import(x) { return x; } *[Symbol.iterator]() {} }
    const o = { import(x) { return x + 1; }, async *import2() {} };
    const p = { async import (x) /* (a) */ { return x; } };
    const values = [new R().import(2), R.import(2), new G().import, typeof new S().import, o.import(2), typeof p.import];`;

  test('stays a method in CommonJS', async () => {
    const { root, loader } = project({
      'main.js': `${METHODS} module.exports = { values, loaded: import('./other.js') };`,
      'other.js': 'exports.other = true;',
    });
    await loader.runMain(`${root}/main.js`);
    const exports = loader.cache[`${root}/main.js`].exports as Record<string, unknown>;
    expect(exports.values).toEqual([4, 6, 1, 'function', 3, 'function']);
    expect(((await exports.loaded) as { other: boolean }).other).toBe(true);
  });

  test('stays a method in an ES module', async () => {
    const { root, loader } = project({
      'main.mjs': `${METHODS} export { values }; export const loaded = await import('./other.mjs');`,
      'other.mjs': 'export const other = true;',
    });
    await loader.runMain(`${root}/main.mjs`);
    const exports = loader.cache[`${root}/main.mjs`].exports as Record<string, unknown>;
    expect(exports.values).toEqual([4, 6, 1, 'function', 3, 'function']);
    expect((exports.loaded as { other: boolean }).other).toBe(true);
  });
});

describe('an import of CommonJS', () => {
  // Babel's or TypeScript's output: an ES module's exports, as CommonJS.
  const COMPILED = {
    'compiled.cjs': `Object.defineProperty(exports, '__esModule', { value: true });
      exports.default = function f() {}; exports.x = 1;`,
    'plain.cjs': 'module.exports = function g() {}; module.exports.y = 2;',
  };

  test('has its module.exports as the default, __esModule or not, as Node', async () => {
    const { root, loader } = project({
      ...COMPILED,
      'main.mjs': `import d, { x } from './compiled.cjs';
        import * as ns from './compiled.cjs';
        import g, { y } from './plain.cjs';
        const dynamic = await import('./compiled.cjs');
        export const seen = [typeof d, d.x, x, typeof ns.default, dynamic === ns, d === ns.default,
          typeof g, y, typeof (await import('./plain.cjs')).default];`,
    });
    await loader.runMain(`${root}/main.mjs`);
    expect((loader.cache[`${root}/main.mjs`].exports as { seen: unknown[] }).seen).toEqual([
      'object',
      1,
      1,
      'object',
      true,
      true,
      'function',
      2,
      'function',
    ]);
  });

  test('re-exports its names', async () => {
    const { root, loader } = project({
      ...COMPILED,
      'main.mjs': "export * from './compiled.cjs';",
    });
    await loader.runMain(`${root}/main.mjs`);
    const exports = loader.cache[`${root}/main.mjs`].exports as Record<string, unknown>;
    expect(exports.x).toBe(1);
    expect(Object.keys(exports)).toEqual(['x']);
  });

  test("by an ES module's import() keeps an ES module's exports", async () => {
    const { root, loader } = project({
      'esm.mjs': 'export default 1; export const z = 3;',
      'main.mjs': `import d, * as ns from './esm.mjs';
        export const seen = [d, ns.z, (await import('./esm.mjs')).default];`,
    });
    await loader.runMain(`${root}/main.mjs`);
    expect((loader.cache[`${root}/main.mjs`].exports as { seen: unknown[] }).seen).toEqual([
      1, 3, 1,
    ]);
  });
});

describe("require.resolve's paths", () => {
  test('resolve a relative request against each, as Node does', async () => {
    const { root, loader } = project({
      'a/x.js': '',
      'b/y.js': '',
      'main.js': `const paths = [__dirname + '/a', 'b'];
        module.exports = [require.resolve('./x', { paths }), require.resolve('./y.js', { paths })];
        try { require.resolve('./z', { paths }); } catch (e) { module.exports.push(e.code); }`,
    });
    await loader.runMain(`${root}/main.js`);
    expect(loader.cache[`${root}/main.js`].exports).toEqual([
      `${root}/a/x.js`,
      `${root}/b/y.js`,
      'MODULE_NOT_FOUND',
    ]);
  });
});

describe("an ES module's private names", () => {
  test('are not its exports of the same name', async () => {
    const { root, loader } = project({
      'a.mjs': `class Flag { #t = false; set() { this.#t = true; return #t in this && this.#t; } }
        export function t() { return 'the export'; }
        export const set = new Flag().set();`,
    });
    expect(loader.createRequire(`${root}/`)('./a.mjs')).toMatchObject({ set: true });
    expect((loader.createRequire(`${root}/`)('./a.mjs') as { t(): string }).t()).toBe('the export');
  });
});
