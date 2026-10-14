// esbuild on the page (esbuild-wasm), in place of the binary the Hex esbuild
// package runs: its command line as Phoenix passes it (entry points,
// --bundle, --target, --outdir, --external:, --alias:, --sourcemap,
// --watch and the rest below), over the node's files. Imports resolve as
// esbuild's would: relative paths, aliases, and packages in node_modules
// or NODE_PATH (Phoenix's deps and _build) by their package.json. In watch
// mode it rebuilds when a file it read changes.
import type { BuildOptions, Loader, Message, Plugin } from 'esbuild-wasm';
import wasmURL from 'esbuild-wasm/esbuild.wasm?url';
import { path } from './modules';
import type { Context, Process } from './tailwind';
import { type Watcher, watchers } from './watch';

export const ESBUILD_VERSION = '0.25.4';

// Called after each build in watch mode (the preview reloads).
export const bundled = new Set<() => void>();

// esbuild-wasm, loaded and started once, on first use.
let loading: Promise<typeof import('esbuild-wasm')> | null = null;
function load() {
  loading ??= import('esbuild-wasm').then(async (module) => {
    await module.initialize({ wasmURL, worker: true });
    return module;
  });
  return loading;
}

const LOADERS: Record<string, Loader> = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.json': 'json',
  '.css': 'css',
  '.txt': 'text',
};
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.css', '.json'];
// Package conditions, in the order a browser bundle takes them.
const CONDITIONS = ['browser', 'import', 'module', 'default'];

interface Command {
  options: BuildOptions;
  aliases: [string, string][];
  watch: boolean;
  ignored: string[];
}

// esbuild's flags: --name, --name=value, --name:key=value. Anything else
// is reported and left out.
function parse(args: string[], cwd: string): Command {
  const options: BuildOptions = { entryPoints: [], external: [], loader: {}, define: {} };
  const aliases: [string, string][] = [];
  const ignored: string[] = [];
  let watch = false;
  const list = (value: string) => value.split(',').filter(Boolean);
  for (const arg of args) {
    if (!arg.startsWith('--')) {
      (options.entryPoints as string[]).push(path.resolve(cwd, arg));
      continue;
    }
    const colon = arg.match(/^--([a-z-]+):([^=]*)(?:=(.*))?$/);
    if (colon) {
      const [, name, key, value = ''] = colon;
      if (name === 'external') options.external!.push(key);
      else if (name === 'alias') aliases.push([key, value]);
      else if (name === 'loader') options.loader![key] = value as Loader;
      else if (name === 'define') options.define![key] = value;
      else ignored.push(arg);
      continue;
    }
    const [, name, value] = arg.match(/^--([a-z-]+)(?:=(.*))?$/) ?? [];
    switch (name) {
      case 'bundle':
      case 'minify':
      case 'splitting':
        options[name] = true;
        break;
      case 'sourcemap':
        options.sourcemap = value ? (value as BuildOptions['sourcemap']) : true;
        break;
      case 'target':
        options.target = list(value ?? '');
        break;
      case 'outdir':
      case 'outfile':
      case 'outbase':
        options[name] = path.resolve(cwd, value ?? '');
        break;
      case 'format':
      case 'platform':
      case 'jsx':
        (options as Record<string, unknown>)[name] = value;
        break;
      case 'public-path':
        options.publicPath = value;
        break;
      case 'entry-names':
        options.entryNames = value;
        break;
      case 'chunk-names':
        options.chunkNames = value;
        break;
      case 'asset-names':
        options.assetNames = value;
        break;
      case 'main-fields':
        options.mainFields = list(value ?? '');
        break;
      case 'resolve-extensions':
        options.resolveExtensions = list(value ?? '');
        break;
      case 'watch':
        watch = true;
        break;
      case 'log-level':
      case 'color':
        break;
      default:
        ignored.push(arg);
    }
  }
  return { options, aliases, watch, ignored };
}

// An external pattern (one * at most) matching an import path.
function matches(pattern: string, id: string): boolean {
  const star = pattern.indexOf('*');
  if (star < 0) return id === pattern || id.startsWith(`${pattern}/`);
  return (
    id.length >= pattern.length - 1 &&
    id.startsWith(pattern.slice(0, star)) &&
    id.endsWith(pattern.slice(star + 1))
  );
}

// A package.json `exports` entry for a subpath ('.' or './x'), by condition.
function exported(exports: unknown, subpath: string): string | null {
  const pick = (entry: unknown): string | null => {
    if (typeof entry === 'string') return entry;
    if (Array.isArray(entry)) {
      for (const item of entry) {
        const found = pick(item);
        if (found) return found;
      }
      return null;
    }
    if (entry && typeof entry === 'object') {
      for (const condition of CONDITIONS)
        if (condition in entry) {
          const found = pick((entry as Record<string, unknown>)[condition]);
          if (found) return found;
        }
    }
    return null;
  };
  if (typeof exports === 'string' || Array.isArray(exports))
    return subpath === '.' ? pick(exports) : null;
  if (!exports || typeof exports !== 'object') return null;
  const keys = Object.keys(exports);
  if (!keys.some((key) => key.startsWith('.'))) return subpath === '.' ? pick(exports) : null;
  const map = exports as Record<string, unknown>;
  if (subpath in map) return pick(map[subpath]);
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const [before, after] = [key.slice(0, star), key.slice(star + 1)];
    if (subpath.startsWith(before) && subpath.endsWith(after)) {
      const target = pick(map[key]);
      const middle = subpath.slice(before.length, subpath.length - after.length);
      return target?.replace('*', middle) ?? null;
    }
  }
  return null;
}

const decoder = new TextDecoder();
const SCRIPTS = new Set<Loader | undefined>(['js', 'jsx', 'ts', 'tsx']);

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export async function esbuild(process: Process, { args, cwd, env, fs }: Context): Promise<void> {
  if (args.includes('--version')) {
    process.write(`${ESBUILD_VERSION}\n`);
    process.exit(0);
    return;
  }
  const command = parse(args, cwd);
  if (command.ignored.length)
    process.write(`esbuild (playground): ignoring ${command.ignored.join(' ')}\n`);
  const nodePath = (env.NODE_PATH ?? '').split(':').filter(Boolean);
  const kinds = new Map<string, 'file' | 'dir' | null>();
  const kind = async (file: string) => {
    if (!kinds.has(file)) kinds.set(file, await fs.stat(file));
    return kinds.get(file) ?? null;
  };
  const json = async (file: string): Promise<Record<string, unknown> | null> => {
    if ((await kind(file)) !== 'file') return null;
    try {
      return JSON.parse(decoder.decode(await fs.read(file))) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  // A file, with the extensions and index files esbuild tries.
  const file = async (candidate: string): Promise<string | null> => {
    if ((await kind(candidate)) === 'file') return candidate;
    for (const extension of EXTENSIONS)
      if ((await kind(candidate + extension)) === 'file') return candidate + extension;
    if ((await kind(candidate)) === 'dir') {
      const manifest = await json(`${candidate}/package.json`);
      for (const field of ['browser', 'module', 'main']) {
        const entry = manifest?.[field];
        if (typeof entry === 'string') {
          const found = await file(path.resolve(candidate, entry));
          if (found) return found;
        }
      }
      for (const extension of EXTENSIONS)
        if ((await kind(`${candidate}/index${extension}`)) === 'file')
          return `${candidate}/index${extension}`;
    }
    return null;
  };

  // A package import ('phoenix', '@scope/name/sub'): from node_modules
  // up from `from`, then NODE_PATH.
  const bare = async (id: string, from: string): Promise<string | null> => {
    const parts = id.split('/');
    const length = id.startsWith('@') ? 2 : 1;
    const name = parts.slice(0, length).join('/');
    const subpath = parts.length > length ? `./${parts.slice(length).join('/')}` : '.';
    const roots: string[] = [];
    for (let dir = from; ; dir = path.dirname(dir)) {
      roots.push(`${dir}/node_modules`);
      if (dir === '/') break;
    }
    roots.push(...nodePath);
    for (const root of roots) {
      const dir = path.resolve(root, name);
      if ((await kind(dir)) !== 'dir') continue;
      const manifest = await json(`${dir}/package.json`);
      if (manifest?.exports !== undefined) {
        const target = exported(manifest.exports, subpath);
        if (target) return file(path.resolve(dir, target));
      }
      const found = await file(subpath === '.' ? dir : path.resolve(dir, subpath));
      if (found) return found;
    }
    return null;
  };

  // A script's linked source map (deps ship them), inlined: esbuild-wasm
  // reads no files itself. One that is not there is left out.
  const linkedMap = async (source: string, bytes: Uint8Array): Promise<string | Uint8Array> => {
    const text = decoder.decode(bytes);
    const link = text.match(/\/\/# sourceMappingURL=(?!data:)(\S+)\s*$/);
    if (!link) return bytes;
    const map = await fs.read(path.resolve(path.dirname(source), link[1])).catch(() => null);
    const inline = map ? `data:application/json;base64,${base64(map)}` : '';
    return text.slice(0, link.index) + (inline ? `//# sourceMappingURL=${inline}\n` : '');
  };

  let loaded = new Set<string>();
  const external = command.options.external ?? [];
  const nodeFiles: Plugin = {
    name: 'playground-files',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async ({ path: id, resolveDir, kind: how }) => {
        if (how === 'entry-point') return { path: id };
        // As esbuild does itself: data: URLs are its own (they need no
        // file), and remote URLs stay external.
        if (id.startsWith('data:')) return undefined;
        if (/^(https?:)?\/\//.test(id)) return { path: id, external: true };
        if (external.some((pattern) => matches(pattern, id))) return { path: id, external: true };
        let target = id;
        let from = resolveDir || cwd;
        for (const [key, value] of command.aliases)
          if (id === key || id.startsWith(`${key}/`)) {
            target = value + id.slice(key.length);
            from = cwd;
            break;
          }
        const found =
          target.startsWith('.') || target.startsWith('/')
            ? await file(path.resolve(from, target))
            : await bare(target, from);
        if (!found) return { errors: [{ text: `Could not resolve "${id}"` }] };
        return { path: found };
      });
      build.onLoad({ filter: /.*/ }, async ({ path: source }) => {
        loaded.add(source);
        const bytes = await fs.read(source);
        const loader =
          command.options.loader?.[path.extname(source)] ?? LOADERS[path.extname(source)];
        const contents = SCRIPTS.has(loader) ? await linkedMap(source, bytes) : bytes;
        return { contents, loader: loader ?? 'file', resolveDir: path.dirname(source) };
      });
    },
  };

  // Changes while a build runs (the first one too) count once it is done.
  let pending: ReturnType<typeof setTimeout> | null = null;
  // From before esbuild-wasm loads: a change then counts for the first build.
  let building = true;
  let during: string[] = [];
  const relevant = (paths: string[]) => paths.some((changed) => loaded.has(changed));
  const rebuild = async (first: boolean) => {
    building = true;
    const built = await build();
    building = false;
    if (first) process.write('[watch] build finished, watching for changes...\n');
    else if (built) for (const listener of bundled) listener();
    const again = relevant(during);
    during = [];
    if (again) schedule();
  };
  const schedule = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      process.write('[watch] build started (change detected)\n');
      void rebuild(false);
    }, 50);
  };
  const watcher: Watcher = (paths) => {
    if (building) during.push(...paths);
    else if (relevant(paths)) schedule();
  };
  if (command.watch) watchers.add(watcher);
  process.onkill = () => {
    watchers.delete(watcher);
    if (pending) clearTimeout(pending);
  };

  const engine = await load();
  const report = async (messages: Message[], severity: 'error' | 'warning') => {
    if (!messages.length) return;
    const text = await engine.formatMessages(messages, { kind: severity, color: false });
    process.write(text.join(''));
  };
  const made = async (dir: string): Promise<void> => {
    if ((await fs.stat(dir)) === 'dir') return;
    await made(path.dirname(dir));
    await fs.mkdir(dir);
  };

  const build = async (): Promise<boolean> => {
    const started = performance.now();
    const reading = new Set<string>();
    loaded = reading;
    kinds.clear();
    try {
      const result = await engine.build({
        ...command.options,
        absWorkingDir: cwd,
        write: false,
        logLevel: 'silent',
        plugins: [nodeFiles],
      });
      await report(result.warnings, 'warning');
      const sizes: string[] = [];
      for (const output of result.outputFiles ?? []) {
        await made(path.dirname(output.path));
        await fs.write(output.path, output.contents);
        const relative = path.relative(cwd, output.path);
        const kb = (output.contents.length / 1024).toFixed(1);
        sizes.push(`  ${relative}  ${kb}kb`);
      }
      process.write(
        `\n${sizes.join('\n')}\n\n⚡ Done in ${Math.round(performance.now() - started)}ms\n`,
      );
      return true;
    } catch (error) {
      const failure = error as { errors?: Message[]; warnings?: Message[]; message: string };
      if (failure.errors) {
        await report(failure.warnings ?? [], 'warning');
        await report(failure.errors, 'error');
      } else process.write(`esbuild: ${failure.message}\n`);
      return false;
    }
  };

  if (!command.watch) {
    process.exit((await build()) ? 0 : 1);
    return;
  }
  await rebuild(true);
}
