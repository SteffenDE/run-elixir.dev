// Node's modules in the worker: require with Node's resolution (paths,
// node_modules and NODE_PATH, package.json's main, exports and imports),
// CommonJS evaluated in a function as Node wraps it, and ES modules (and
// TypeScript, whose types Node strips) turned into CommonJS by sucrase, so
// that a module loads synchronously however it is required or imported.
// import() answers a namespace as Node's does: an ES module's exports, a
// CommonJS module's as its default and its names.
import { transform } from 'sucrase';
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

// One condition set for require and import: ES modules load through
// require here, so a package's import entry serves both.
const CONDITIONS = ['node', 'import', 'require', 'module-sync', 'default'];
const EXTENSIONS = ['.js', '.json', '.cjs', '.mjs', '.ts', '.mts', '.cts'];
const TYPESCRIPT = new Set(['.ts', '.mts', '.cts', '.tsx']);

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
  const resolveMap = (dir: string, map: unknown, subpath: string): string | null | undefined => {
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
    if (subpath in entries && !subpath.includes('*')) return target(dir, entries[subpath], '');
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
      return target(dir, entries[best], match);
    }
    // Folder mappings ("./": "./"), as older packages have them.
    for (const key of Object.keys(entries))
      if (key.endsWith('/') && subpath.startsWith(key)) {
        const t = entries[key];
        if (typeof t === 'string') return path.resolve(dir, t + subpath.slice(key.length));
      }
    return null;
  };

  const target = (dir: string, t: unknown, match: string): string | null => {
    if (typeof t === 'string') {
      if (!t.startsWith('./')) return t.startsWith('#') ? null : `\0${t.replaceAll('*', match)}`;
      return path.resolve(dir, t.replaceAll('*', match));
    }
    if (Array.isArray(t)) {
      for (const each of t) {
        const found = target(dir, each, match);
        if (found) return found;
      }
      return null;
    }
    if (t && typeof t === 'object') {
      for (const [condition, next] of Object.entries(t))
        if (CONDITIONS.includes(condition)) {
          const found = target(dir, next, match);
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
  const resolve = (
    request: string,
    dir: string,
    parent: Module | null,
    paths?: string[],
  ): string => {
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
      const found = scope && resolveMap(scope[0], scope[1].imports, request);
      if (found?.startsWith('\0')) return resolve(found.slice(1), dir, parent);
      if (found && isFile(found)) return real(found);
      throw notFound(request, parent);
    }
    const parts = request.split('/');
    const name = request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const subpath = `.${request.slice(name.length)}`;
    // A package may require itself by its name.
    const self = packageScope(`${dir}/x`);
    if (self && self[1].name === name && self[1].exports) {
      const found = resolveMap(self[0], self[1].exports, subpath);
      if (found && isFile(found)) return real(found);
    }
    for (const base of paths ?? nodeModulesPaths(dir)) {
      const pkg = `${base}/${name}`;
      if (!isDir(pkg)) continue;
      const json = readPackage(pkg);
      if (json?.exports !== undefined) {
        const found = resolveMap(pkg, json.exports, subpath);
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
    // statements at a line's start.
    return /^\s*(import\s*[\w{*'"]|export\s+(?:\{|\*|default|const|let|var|function|class|async))/m.test(
      source,
    );
  };

  const compile = (module: Module, source: string): void => {
    const file = module.filename;
    const ext = path.extname(file);
    if (source.startsWith('#!')) source = `//${source.slice(2)}`;
    const esm = isEsm(file, source);
    const transforms: ('typescript' | 'imports')[] = [];
    if (TYPESCRIPT.has(ext)) transforms.push('typescript');
    if (esm) transforms.push('imports');
    let code = source;
    if (transforms.length) {
      code = transform(source, {
        transforms,
        filePath: file,
        disableESTransforms: true,
        production: true,
        keepUnusedImports: !TYPESCRIPT.has(ext),
      }).code;
    }
    if (esm) code = code.replace(/\bimport\.meta\b/g, '__importMeta');
    // A CommonJS module's import(): the loader's.
    code = code.replace(/(^|[^\w$.])import(\s*\()/g, '$1__dynamicImport$2');
    const meta = {
      url: `file://${file}`,
      filename: file,
      dirname: module.path,
      resolve: (specifier: string) => {
        const found = resolve(specifier, module.path, module);
        return found.startsWith('node:') ? found : `file://${found}`;
      },
    };
    const run = (prefix: string) =>
      // oxlint-disable-next-line no-eval -- modules are code to run.
      (0, eval)(
        `(${prefix}function (exports, require, module, __filename, __dirname, __importMeta, __dynamicImport) {${code}\n})\n//# sourceURL=file://${file}`,
      );
    let fn: (...args: unknown[]) => unknown;
    let async = false;
    try {
      fn = run('');
    } catch (error) {
      // Top-level await: the module's body, asynchronously. (Engines word
      // the error differently; an ES module that awaits gets the retry.)
      if (!(error instanceof SyntaxError) || !esm || !/\bawait\b/.test(code)) throw error;
      try {
        fn = run('async ');
      } catch {
        throw error;
      }
      async = true;
    }
    const result = fn.call(
      module.exports,
      module.exports,
      module.require,
      module,
      file,
      module.path,
      meta,
      (specifier: string) => importFrom(specifier, module),
    );
    if (async) {
      module.evaluation = (result as Promise<void>).then(() => {
        module.loaded = true;
      });
    }
  };

  const load = (file: string, parent: Module | null): unknown => {
    if (file.startsWith('node:')) return builtin(file.slice(5));
    const cached = cache[file];
    if (cached) {
      if (parent && !parent.children.includes(cached)) parent.children.push(cached);
      return cached.exports;
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
    return module.exports;
  };

  const makeRequire = (module: Module | null, dir = module?.path ?? '/'): NodeRequire => {
    const require = ((request: string) => {
      if (typeof request !== 'string')
        throw new TypeError('The "id" argument must be of type string');
      return load(resolve(request, dir, module), module);
    }) as NodeRequire;
    const resolveFn = ((request: string, opts?: { paths?: string[] }) => {
      const found = opts?.paths
        ? resolve(
            request,
            dir,
            module,
            opts.paths.flatMap((p) => nodeModulesPaths(path.resolve(dir, p))),
          )
        : resolve(request, dir, module);
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

  // A namespace for import(): an ES module's exports as they are, a
  // CommonJS module's as its default and its own names.
  const namespace = (exports: unknown): Record<string, unknown> => {
    // oxlint-disable-next-line no-underscore-dangle -- the interop's marker.
    if (exports && typeof exports === 'object' && (exports as { __esModule?: boolean }).__esModule)
      return exports as Record<string, unknown>;
    const out: Record<string, unknown> = Object.create(null);
    if (exports && (typeof exports === 'object' || typeof exports === 'function'))
      for (const key of Object.keys(exports)) out[key] = (exports as Record<string, unknown>)[key];
    out.default = exports;
    return out;
  };

  const importFrom = async (specifier: string, parent: Module | null): Promise<unknown> => {
    const dir = parent?.path ?? process().cwd();
    const file = resolve(String(specifier), dir, parent);
    const exports = load(file, parent);
    const module = cache[file];
    if (module?.evaluation) await module.evaluation;
    return namespace(module ? module.exports : exports);
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
        `return eval(${JSON.stringify(code.replace(/(^|[^\w$.])import(\s*\()/g, '$1__dynamicImport$2'))});`,
      );
      return fn(module.exports, module.require, module, '[eval]', cwd, (s: string) =>
        importFrom(s, module),
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
