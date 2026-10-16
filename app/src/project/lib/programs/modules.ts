// Node-style modules for tools that run on the page (Tailwind's plugins):
// a POSIX `path`, an `fs` over the node's files, and CommonJS evaluation.
//
// Plugins call fs synchronously, but the node's files come asynchronously
// from its worker. So `fs` answers from what it holds and throws a Fault
// for anything else; the caller fetches what the fault names (a file's
// whole directory) and runs again (`withFaults`).
import type { FileSystem as Files } from '@runtime/host/files';

export const path = {
  sep: '/',
  normalize(p: string): string {
    const absolute = p.startsWith('/');
    const out: string[] = [];
    for (const part of p.split('/')) {
      if (part === '..') {
        if (out.length && out[out.length - 1] !== '..') out.pop();
        else if (!absolute) out.push('..');
      } else if (part && part !== '.') out.push(part);
    }
    return (absolute ? '/' : '') + out.join('/') || (absolute ? '/' : '.');
  },
  join: (...parts: string[]): string => path.normalize(parts.filter(Boolean).join('/')),
  resolve: (...parts: string[]): string => {
    let out = '';
    for (const part of parts) out = part.startsWith('/') ? part : `${out}/${part}`;
    return path.normalize(out.startsWith('/') ? out : `/${out}`);
  },
  dirname: (p: string): string => {
    const at = p.replace(/\/+$/, '').lastIndexOf('/');
    return at <= 0 ? (p.startsWith('/') ? '/' : '.') : p.slice(0, at);
  },
  basename: (p: string, ext?: string): string => {
    const base = p.replace(/\/+$/, '').split('/').pop() ?? '';
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
  },
  extname: (p: string): string => {
    const base = path.basename(p);
    const at = base.lastIndexOf('.');
    return at > 0 ? base.slice(at) : '';
  },
  isAbsolute: (p: string): boolean => p.startsWith('/'),
  relative: (from: string, to: string): string => {
    const a = path.resolve(from).split('/').filter(Boolean);
    const b = path.resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  },
};

export class Fault extends Error {
  constructor(public readonly dir: string) {
    super(`not fetched yet: ${dir}`);
  }
}

const decoder = new TextDecoder();

// The node's files as far as fetched: directories (with their entries)
// and files (with their bytes).
export class SyncFiles {
  private dirs = new Map<string, string[]>();
  private files = new Map<string, Uint8Array>();
  constructor(private node: Files) {}

  // A directory and every file in it.
  async fetch(dir: string): Promise<void> {
    const entries = await this.node.list(dir).catch(() => []);
    const direct = entries.filter((e) => path.dirname(e.path) === dir);
    this.dirs.set(
      dir,
      direct.map((e) => path.basename(e.path)),
    );
    await Promise.all(
      direct
        .filter((e) => !e.dir)
        .map(async (e) => this.files.set(e.path, await this.node.read(e.path))),
    );
    for (const sub of direct.filter((entry) => entry.dir))
      if (!this.dirs.has(sub.path)) this.dirs.set(sub.path, []);
  }

  forget(): void {
    this.dirs.clear();
    this.files.clear();
  }

  readdir(dir: string): string[] {
    const entries = this.dirs.get(path.normalize(dir));
    if (!entries) throw new Fault(path.normalize(dir));
    return entries;
  }

  read(file: string): Uint8Array {
    const name = path.normalize(file);
    const bytes = this.files.get(name);
    if (bytes) return bytes;
    const dir = path.dirname(name);
    if (this.dirs.has(dir)) {
      const error = new Error(`ENOENT: no such file, open '${name}'`) as Error & { code: string };
      error.code = 'ENOENT';
      throw error;
    }
    throw new Fault(dir);
  }

  exists(p: string): boolean {
    const name = path.normalize(p);
    if (this.files.has(name) || this.dirs.has(name)) return true;
    if (this.dirs.has(path.dirname(name))) return false;
    throw new Fault(path.dirname(name));
  }

  // Node's fs, as far as plugins use it.
  get fs() {
    const toBuffer = (bytes: Uint8Array) =>
      Object.assign(bytes, { toString: () => decoder.decode(bytes) });
    return {
      readdirSync: (dir: string) => this.readdir(dir),
      readFileSync: (file: string, options?: string | { encoding?: string }) => {
        const bytes = this.read(file);
        const encoding = typeof options === 'string' ? options : options?.encoding;
        return encoding ? decoder.decode(bytes) : toBuffer(bytes);
      },
      existsSync: (p: string) => this.exists(p),
      statSync: (p: string) => {
        const name = path.normalize(p);
        if (!this.exists(name)) throw new Error(`ENOENT: ${name}`);
        const dir = this.dirs.has(name);
        return { isDirectory: () => dir, isFile: () => !dir };
      },
    };
  }
}

// A directory and those above it, made where missing (as a tool's output
// path needs: `mkdir -p`).
export async function made(fs: Files, dir: string): Promise<void> {
  if ((await fs.stat(dir)) === 'dir') return;
  await made(fs, path.dirname(dir));
  await fs.mkdir(dir);
}

// Run `work` until it needs nothing the files have not fetched.
export async function withFaults<T>(files: SyncFiles, work: () => Promise<T> | T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const fault = error instanceof Fault ? error : (error as { cause?: unknown })?.cause;
      if (!(fault instanceof Fault) || attempt > 200) throw error;
      await files.fetch(fault.dir);
    }
  }
}

// A CommonJS module's exports. `require` takes the given built-ins first,
// then files relative to the module.
export function evaluate(
  source: string,
  filename: string,
  builtins: Record<string, unknown>,
  files: SyncFiles,
): unknown {
  const cache = new Map<string, { exports: unknown }>();
  const load = (code: string, file: string): unknown => {
    const module = { exports: {} as unknown };
    cache.set(file, module);
    const require = (id: string): unknown => {
      if (id in builtins) return builtins[id];
      if (id.startsWith('node:') && id.slice(5) in builtins) return builtins[id.slice(5)];
      const base = path.join(path.dirname(file), id);
      for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}/index.js`]) {
        const hit = cache.get(candidate);
        if (hit) return hit.exports;
        let bytes: Uint8Array | null = null;
        try {
          bytes = files.read(candidate);
        } catch (error) {
          if (error instanceof Fault) throw error;
        }
        if (bytes) return load(decoder.decode(bytes), candidate);
      }
      throw new Error(`Cannot find module '${id}' from ${file}`);
    };
    // oxlint-disable-next-line no-new-func -- evaluating the app's own plugin code is the point.
    new Function('module', 'exports', 'require', '__filename', '__dirname', code)(
      module,
      module.exports,
      require,
      file,
      path.dirname(file),
    );
    return module.exports;
  };
  return load(source, filename);
}
