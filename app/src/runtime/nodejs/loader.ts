// Node's modules in the worker: require with Node's resolution (paths,
// node_modules and NODE_PATH, package.json's main, exports and imports),
// CommonJS evaluated in a function as Node wraps it, and ES modules (and
// TypeScript, whose types Node strips) turned into CommonJS by sucrase, so
// that a module loads synchronously however it is required or imported
// (one that awaits at its top level, or imports one that does, runs once
// those imports have).
// An import answers a namespace as Node's does: an ES module's exports, a
// CommonJS module's module.exports as its default, and its names.
import { transform } from 'sucrase';
import { pieces, renameImportCalls, rewriteCode } from './source';
import type { createPath } from './path';

type Path = ReturnType<typeof createPath>;

export interface LoaderFs {
  statSync(
    p: string,
    options: { throwIfNoEntry: false },
  ): { isFile(): boolean; isDirectory(): boolean } | undefined;
  readFileSync(p: string, encoding: 'utf8'): string;
  realpathSync(p: string): string;
}

// A package's entries for require and for import, as Node picks them. ES
// modules load through require here, so a require that finds no entry of
// its own takes the import one (a package with ES modules alone).
const REQUIRE = ['node', 'require', 'module-sync', 'default'];
const IMPORT = ['node', 'import', 'module-sync', 'default'];
const EXTENSIONS = ['.js', '.json', '.cjs', '.mjs', '.ts', '.mts', '.cts'];
const TYPESCRIPT = new Set(['.ts', '.mts', '.cts', '.tsx']);
// An ES module's require, its own, while sucrase compiles it.
const OWN_REQUIRE = '__ownRequire__';

export class Module {
  id: string;
  filename: string;
  path: string;
  exports: unknown = {};
  loaded = false;
  children: Module[] = [];
  paths: string[] = [];
  parent: Module | null;
  // An ES module with top-level await: its evaluation.
  evaluation: Promise<void> | null = null;
  // An ES module (turned into CommonJS by sucrase).
  esm = false;
  declare require: NodeRequire;
  constructor(filename: string, parent: Module | null) {
    this.id = filename;
    this.filename = filename;
    this.path = filename.slice(0, filename.lastIndexOf('/')) || '/';
    this.parent = parent;
  }
}

export interface NodeRequire {
  (request: string): unknown;
  resolve: ((request: string, options?: { paths?: string[] }) => string) & {
    paths: (request: string) => string[] | null;
  };
  cache: Record<string, Module>;
  main: Module | undefined;
  extensions: Record<string, unknown>;
}

class ModuleError extends Error {
  code: string;
  requireStack?: string[];
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export function createLoader(options: {
  fs: LoaderFs;
  path: Path;
  builtin: (name: string) => unknown;
  builtins: string[];
  env: Record<string, string>;
  // Keeps the process alive until the returned release: a pending
  // import(), as Node's loading is I/O that holds its loop.
  hold?: () => () => void;
}) {
  const { fs, path, builtin, builtins } = options;
  const cache: Record<string, Module> = Object.create(null);
  const packageJsons = new Map<string, Record<string, unknown> | null>();
  let main: Module | undefined;

  const isFile = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

  const readPackage = (dir: string): Record<string, unknown> | null => {
    if (!packageJsons.has(dir)) {
      const file = `${dir}/package.json`;
      let json: Record<string, unknown> | null = null;
      if (isFile(file)) {
        try {
          json = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
          throw new ModuleError(
            `Invalid package config ${file}: ${(error as Error).message}`,
            'ERR_INVALID_PACKAGE_CONFIG',
          );
        }
      }
      packageJsons.set(dir, json);
    }
    return packageJsons.get(dir)!;
  };

  // The package.json that holds `file`, and its directory.
  const packageScope = (file: string): [string, Record<string, unknown>] | null => {
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      if (dir.endsWith('/node_modules')) return null;
      const json = readPackage(dir);
      if (json) return [dir, json];
      if (dir === '/') return null;
    }
  };

  const real = (file: string) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return file;
    }
  };

  const asFile = (p: string): string | null => {
    if (isFile(p)) return p;
    for (const ext of EXTENSIONS) if (isFile(p + ext)) return p + ext;
    return null;
  };

  const asDirectory = (p: string): string | null => {
    const json = readPackage(p);
    const entry = typeof json?.main === 'string' ? json.main : null;
    if (entry) {
      const found = asFile(path.resolve(p, entry)) ?? asIndex(path.resolve(p, entry));
      if (found) return found;
    }
    return asIndex(p);
  };

  const asIndex = (p: string): string | null => {
    for (const ext of EXTENSIONS) if (isFile(`${p}/index${ext}`)) return `${p}/index${ext}`;
    return null;
  };

  // A package's exports or imports target for `subpath` ('.', './x', '#x').
  const resolveMap = (
    dir: string,
    map: unknown,
    subpath: string,
    conditions: string[],
  ): string | null | undefined => {
    if (map === null || map === undefined) return undefined;
    let entries: Record<string, unknown>;
    if (typeof map === 'string' || Array.isArray(map)) entries = { '.': map };
    else {
      const keys = Object.keys(map as object);
      entries =
        keys.length && !keys[0].startsWith('.') && !keys[0].startsWith('#')
          ? { '.': map }
          : (map as Record<string, unknown>);
    }
    if (subpath in entries && !subpath.includes('*'))
      return target(dir, entries[subpath], '', conditions);
    let best: string | null = null;
    for (const key of Object.keys(entries)) {
      const star = key.indexOf('*');
      if (star === -1) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix) &&
        subpath.length >= key.length - 1
      )
        if (!best || prefix.length > best.indexOf('*')) best = key;
    }
    if (best) {
      const star = best.indexOf('*');
      const match = subpath.slice(star, subpath.length - (best.length - star - 1));
      return target(dir, entries[best], match, conditions);
    }
    // Folder mappings ("./": "./"), as older packages have them.
    for (const key of Object.keys(entries))
      if (key.endsWith('/') && subpath.startsWith(key)) {
        const t = entries[key];
        if (typeof t === 'string') return path.resolve(dir, t + subpath.slice(key.length));
      }
    return null;
  };

  const target = (dir: string, t: unknown, match: string, conditions: string[]): string | null => {
    if (typeof t === 'string') {
      if (!t.startsWith('./')) return t.startsWith('#') ? null : `\0${t.replaceAll('*', match)}`;
      return path.resolve(dir, t.replaceAll('*', match));
    }
    if (Array.isArray(t)) {
      for (const each of t) {
        const found = target(dir, each, match, conditions);
        if (found) return found;
      }
      return null;
    }
    if (t && typeof t === 'object') {
      for (const [condition, next] of Object.entries(t))
        if (conditions.includes(condition)) {
          const found = target(dir, next, match, conditions);
          if (found !== null) return found;
        }
    }
    return null;
  };

  const nodeModulesPaths = (from: string): string[] => {
    const out: string[] = [];
    for (let dir = from; ; dir = path.dirname(dir)) {
      if (!dir.endsWith('/node_modules')) out.push(`${dir === '/' ? '' : dir}/node_modules`);
      if (dir === '/') break;
    }
    for (const extra of (options.env.NODE_PATH ?? '').split(':').filter(Boolean)) out.push(extra);
    return out;
  };

  const notFound = (request: string, parent: Module | null) => {
    const stack: string[] = [];
    for (let m = parent; m; m = m.parent) stack.push(m.filename);
    const error = new ModuleError(
      `Cannot find module '${request}'${stack.length ? `\nRequire stack:\n- ${stack.join('\n- ')}` : ''}`,
      'MODULE_NOT_FOUND',
    );
    error.requireStack = stack;
    return error;
  };

  // `request` from a module in `dir`: a builtin's name (node:fs) or a file.
  // `imported`: by an ES module's import (or import()), not require.
  const resolve = (
    request: string,
    dir: string,
    parent: Module | null,
    paths?: string[],
    imported = false,
  ): string => {
    // A package's entry by its map: require's, else import's.
    const mapped = (pkg: string, map: unknown, subpath: string) =>
      imported
        ? resolveMap(pkg, map, subpath, IMPORT)
        : (resolveMap(pkg, map, subpath, REQUIRE) ?? resolveMap(pkg, map, subpath, IMPORT));
    if (request.startsWith('file://')) request = decodeURIComponent(new URL(request).pathname);
    const bare = request.startsWith('node:') ? request.slice(5) : request;
    if (builtins.includes(bare)) return `node:${bare}`;
    if (request.startsWith('node:')) throw notFound(request, parent);
    if (
      request.startsWith('/') ||
      request.startsWith('./') ||
      request.startsWith('../') ||
      request === '.' ||
      request === '..'
    ) {
      const absolute = path.resolve(dir, request);
      const found = asFile(absolute) ?? asDirectory(absolute);
      if (found) return real(found);
      throw notFound(request, parent);
    }
    if (request.startsWith('#')) {
      const scope = packageScope(`${dir}/x`);
      const found = scope && mapped(scope[0], scope[1].imports, request);
      if (found?.startsWith('\0')) return resolve(found.slice(1), dir, parent, undefined, imported);
      if (found && isFile(found)) return real(found);
      throw notFound(request, parent);
    }
    const parts = request.split('/');
    const name = request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const subpath = `.${request.slice(name.length)}`;
    // A package may require itself by its name.
    const self = packageScope(`${dir}/x`);
    if (self && self[1].name === name && self[1].exports) {
      const found = mapped(self[0], self[1].exports, subpath);
      if (found && isFile(found)) return real(found);
    }
    for (const base of paths ?? nodeModulesPaths(dir)) {
      const pkg = `${base}/${name}`;
      if (!isDir(pkg)) continue;
      const json = readPackage(pkg);
      if (json?.exports !== undefined) {
        const found = mapped(pkg, json.exports, subpath);
        if (found && !found.startsWith('\0')) {
          const file = asFile(found);
          if (file) return real(file);
        }
        const error = new ModuleError(
          `Package subpath '${subpath}' is not defined by "exports" in ${pkg}/package.json`,
          'ERR_PACKAGE_PATH_NOT_EXPORTED',
        );
        throw error;
      }
      const absolute = path.resolve(base, request);
      const found = asFile(absolute) ?? asDirectory(absolute);
      if (found) return real(found);
    }
    throw notFound(request, parent);
  };

  const isEsm = (file: string, source: string): boolean => {
    const ext = path.extname(file);
    if (ext === '.mjs' || ext === '.mts') return true;
    if (ext === '.cjs' || ext === '.cts') return false;
    if (packageScope(file)?.[1].type === 'module') return true;
    // Node's syntax detection, as far as a glance goes: import or export
    // statements at a line's start (import x, import {, import "…", not a
    // name such as importName), in the code (not a string's or a
    // template's lines, as TypeScript's compiler has both).
    const statement =
      /^\s*(import(?:\s+[\w$]|\s*[{*'"])|export\s+(?:\{|\*|default|const|let|var|function|class|async))/m;
    if (!statement.test(source)) return false;
    const code = pieces(source)
      .map((piece) => (piece.code ? piece.text : piece.text.replace(/[^\n]/g, ' ')))
      .join('');
    return statement.test(code);
  };

  const compile = (module: Module, source: string): void => {
    const file = module.filename;
    const ext = path.extname(file);
    if (source.startsWith('#!')) source = `//${source.slice(2)}`;
    const esm = isEsm(file, source);
    const transforms: ('typescript' | 'imports')[] = [];
    if (TYPESCRIPT.has(ext)) transforms.push('typescript');
    if (esm) transforms.push('imports');
    // An ES module's own require (createRequire's) under another name while
    // sucrase turns its imports into require calls, and as itself after
    // (TypeScript's import x = require(…) is sucrase's to turn).
    let code = esm
      ? rewriteCode(source, (text) =>
          text.replace(/(?<![\w$]|import\s+[\w$]+\s*=\s*)require(?![\w$])/g, OWN_REQUIRE),
        )
      : source;
    if (transforms.length) {
      code = transform(code, {
        transforms,
        filePath: file,
        disableESTransforms: true,
        production: true,
        keepUnusedImports: !TYPESCRIPT.has(ext),
        // import() is the loader's (held, and awaiting a module's top-level await).
        preserveDynamicImport: true,
      }).code;
    }
    // An ES module may declare require (createRequire's) or module as
    // its own: the imports sucrase made are the loader's require, under a
    // name of its own, which resolves as createRequire(import.meta.url).
    // A module's import() is the loader's. Only code changes, not what its
    // strings and comments say (source.ts).
    code = rewriteCode(renameImportCalls(code, '__dynamicImport'), (text) =>
      esm
        ? text
            .replace(/\bimport\s*\.\s*meta\b/g, '__importMeta')
            .replace(/(^|[^\w$.])require(\s*\()/g, '$1__nodeRequire$2')
            .replaceAll(OWN_REQUIRE, 'require')
        : text,
    );
    module.esm = esm;
    const meta = {
      url: `file://${file}`,
      filename: file,
      dirname: module.path,
      resolve: (specifier: string) => {
        const found = resolve(specifier, module.path, module, undefined, true);
        return found.startsWith('node:') ? found : `file://${found}`;
      },
    };
    // An ES module has no __filename, __dirname, require or module (it may
    // declare its own); CommonJS has them as Node's wrapper passes them.
    const names = esm
      ? 'exports, __nodeRequire, __nodeModule, __importMeta, __dynamicImport'
      : 'exports, require, module, __filename, __dirname, __importMeta, __dynamicImport';
    const run = (prefix: string) =>
      // oxlint-disable-next-line no-eval -- modules are code to run.
      (0, eval)(`(${prefix}function (${names}) {${code}\n})\n//# sourceURL=file://${file}`);
    let fn: (...args: unknown[]) => unknown;
    let async = false;
    // A syntax error names its file, as Node's does.
    const named = (error: unknown) => {
      if (error instanceof SyntaxError) error.message = `${file}: ${error.message}`;
      return error;
    };
    try {
      fn = run('');
    } catch (error) {
      // Top-level await: the module's body, asynchronously. (Engines word
      // the error differently; an ES module that awaits gets the retry.)
      if (!(error instanceof SyntaxError) || !esm || !/\bawait\b/.test(code)) throw named(error);
      try {
        fn = run('async ');
      } catch {
        throw named(error);
      }
      async = true;
    }
    const load = (specifier: string) => dynamicImport(specifier, module);
    const nodeRequire = makeRequire(module, module.path, true);
    // An ES module's imports (the loader's require calls sucrase made),
    // loaded in their order before its body, as Node links them; those
    // still awaiting at their top level, which its body waits for. (Its
    // exports say they are an ES module's already, for an import back.)
    const awaiting: Promise<void>[] = [];
    if (esm) {
      Object.defineProperty(module.exports, '__esModule', { value: true });
      for (const [, , specifier] of code.matchAll(/__nodeRequire\((['"])([^'"\\]*)\1\)/g)) {
        nodeRequire(specifier);
        const evaluation =
          cache[resolve(specifier, module.path, module, undefined, true)]?.evaluation;
        if (evaluation) awaiting.push(evaluation);
      }
    }
    const body = () =>
      esm
        ? fn.call(undefined, module.exports, nodeRequire, module, meta, load)
        : fn.call(
            module.exports,
            module.exports,
            module.require,
            module,
            file,
            module.path,
            meta,
            load,
          );
    // A module that awaits, or waits for an import that does: its
    // evaluation, until it has run.
    const done = () => {
      module.loaded = true;
      module.evaluation = null;
    };
    if (awaiting.length) module.evaluation = Promise.all(awaiting).then(body).then(done);
    else {
      const result = body();
      if (async) module.evaluation = (result as Promise<void>).then(done);
    }
  };

  // A namespace for an import of CommonJS (or a builtin), as Node's: its
  // module.exports as the default whatever its __esModule says, and its own
  // names; marked __esModule for sucrase's interop to take as it is. One
  // for each exports, once they have loaded.
  const namespaces = new WeakMap<object, Record<string, unknown>>();
  const commonNamespace = (exports: unknown, loaded = true): Record<string, unknown> => {
    const object =
      exports !== null && (typeof exports === 'object' || typeof exports === 'function');
    const known = object ? namespaces.get(exports) : undefined;
    if (known) return known;
    const out: Record<string, unknown> = Object.create(null);
    if (object)
      for (const key of Object.keys(exports)) out[key] = (exports as Record<string, unknown>)[key];
    out.default = exports;
    if (!('__esModule' in out)) Object.defineProperty(out, '__esModule', { value: true });
    if (object && loaded) namespaces.set(exports, out);
    return out;
  };

  // What require answers for a module: an ES module's namespace, but for
  // CommonJS its "module.exports" export if it has one (Node's
  // require(esm)); `namespace`: for an ES module's own imports, which take
  // CommonJS as a namespace.
  const value = (module: Module, namespace: boolean) => {
    if (namespace)
      return module.esm ? module.exports : commonNamespace(module.exports, module.loaded);
    return module.esm && Object.prototype.hasOwnProperty.call(module.exports, 'module.exports')
      ? (module.exports as Record<string, unknown>)['module.exports']
      : module.exports;
  };

  const load = (file: string, parent: Module | null, namespace = false): unknown => {
    if (file.startsWith('node:')) return builtin(file.slice(5));
    const cached = cache[file];
    if (cached) {
      if (parent && !parent.children.includes(cached)) parent.children.push(cached);
      return value(cached, namespace);
    }
    const module = new Module(file, parent);
    module.paths = nodeModulesPaths(module.path);
    module.require = makeRequire(module);
    cache[file] = module;
    parent?.children.push(module);
    try {
      const source = fs.readFileSync(file, 'utf8');
      if (path.extname(file) === '.json') {
        try {
          module.exports = JSON.parse(source.replace(/^﻿/, ''));
        } catch (error) {
          (error as Error).message = `${file}: ${(error as Error).message}`;
          throw error;
        }
      } else if (path.extname(file) === '.node') {
        throw new ModuleError(
          `${file}: a native addon, which the playground cannot load (look for a WebAssembly build of the package)`,
          'ERR_DLOPEN_FAILED',
        );
      } else compile(module, source);
      if (!module.evaluation) module.loaded = true;
    } catch (error) {
      delete cache[file];
      throw error;
    }
    return value(module, namespace);
  };

  const makeRequire = (
    module: Module | null,
    dir = module?.path ?? '/',
    namespace = false,
  ): NodeRequire => {
    const require = ((request: string) => {
      if (typeof request !== 'string')
        throw new TypeError('The "id" argument must be of type string');
      return load(resolve(request, dir, module, undefined, namespace), module, namespace);
    }) as NodeRequire;
    // With paths, a relative request resolves against each (the first
    // that has it), another in their node_modules.
    const relative = (request: string, paths: string[]) => {
      for (const p of paths)
        try {
          return resolve(request, path.resolve(p), module);
        } catch (error) {
          if ((error as ModuleError).code !== 'MODULE_NOT_FOUND') throw error;
        }
      throw notFound(request, module);
    };
    const resolveFn = ((request: string, opts?: { paths?: string[] }) => {
      const found = !opts?.paths
        ? resolve(request, dir, module)
        : /^\.\.?(\/|$)/.test(request)
          ? relative(request, opts.paths)
          : resolve(
              request,
              dir,
              module,
              opts.paths.flatMap((p) => nodeModulesPaths(path.resolve(p))),
            );
      return found.startsWith('node:') && !request.startsWith('node:') ? found.slice(5) : found;
    }) as NodeRequire['resolve'];
    resolveFn.paths = (request: string) =>
      builtins.includes(request) ? null : nodeModulesPaths(dir);
    require.resolve = resolveFn;
    require.cache = cache;
    require.extensions = { '.js': () => {}, '.json': () => {}, '.node': () => {} };
    Object.defineProperty(require, 'main', { get: () => main });
    return require;
  };

  const importFrom = async (specifier: string, parent: Module | null): Promise<unknown> => {
    const dir = parent?.path ?? process().cwd();
    const file = resolve(String(specifier), dir, parent, undefined, true);
    const exports = load(file, parent, true);
    const module = cache[file];
    if (module?.evaluation) await module.evaluation;
    return module ? value(module, true) : commonNamespace(exports);
  };

  // import() in a module: held until it settles.
  const dynamicImport = (specifier: string, parent: Module | null): Promise<unknown> => {
    const release = options.hold?.() ?? (() => {});
    const loading = importFrom(specifier, parent);
    loading.then(release, release);
    return loading;
  };

  let process: () => { cwd(): string } = () => ({ cwd: () => '/' });

  const createRequire = (filename: string | URL) => {
    const file = String(filename).startsWith('file://')
      ? decodeURIComponent(new URL(String(filename)).pathname)
      : String(filename);
    const dir = file.endsWith('/') ? file.slice(0, -1) : path.dirname(file);
    return makeRequire(null, dir);
  };

  return {
    cache,
    createRequire,
    // `node FILE`: the main module, and its evaluation if it awaits.
    async runMain(file: string): Promise<void> {
      const found = resolve(path.resolve(file), '/', null);
      const module = new Module(found, null);
      module.id = '.';
      module.paths = nodeModulesPaths(module.path);
      module.require = makeRequire(module);
      main = module;
      cache[found] = module;
      compile(module, fs.readFileSync(found, 'utf8'));
      if (module.evaluation) await module.evaluation;
      module.loaded = true;
    },
    // `node -e CODE`: CommonJS in the directory, as [eval].
    evaluate(code: string, cwd: string): unknown {
      const module = new Module(`${cwd}/[eval]`, null);
      module.id = '[eval]';
      module.paths = nodeModulesPaths(cwd);
      module.require = makeRequire(module, cwd);
      const fn = new Function(
        'exports',
        'require',
        'module',
        '__filename',
        '__dirname',
        '__dynamicImport',
        `return eval(${JSON.stringify(rewriteCode(renameImportCalls(code, '__dynamicImport'), (text) => text))});`,
      );
      return fn(module.exports, module.require, module, '[eval]', cwd, (s: string) =>
        dynamicImport(s, module),
      );
    },
    importFrom,
    setProcess(p: () => { cwd(): string }) {
      process = p;
    },
    moduleBuiltin(): Record<string, unknown> {
      const ModuleClass = Module as unknown as Record<string, unknown>;
      return Object.assign(ModuleClass, {
        Module,
        createRequire,
        builtinModules: builtins,
        isBuiltin: (name: string) => builtins.includes(name.replace(/^node:/, '')),
        _cache: cache,
        _extensions: { '.js': () => {}, '.json': () => {}, '.node': () => {} },
        _resolveFilename: (request: string, parent: Module | null) =>
          resolve(request, parent?.path ?? process().cwd(), parent),
        _load: (request: string, parent: Module | null) =>
          load(resolve(request, parent?.path ?? process().cwd(), parent), parent),
        _nodeModulePaths: nodeModulesPaths,
        wrap: (code: string) =>
          `(function (exports, require, module, __filename, __dirname) { ${code}\n});`,
        register: () => {},
        syncBuiltinESMExports: () => {},
        findPackageJSON: undefined,
        enableCompileCache: () => ({ status: 3 }),
        constants: {
          compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 },
        },
      });
    },
  };
}
