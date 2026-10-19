// Node's path module, POSIX only (path.posix is itself; path.win32 too).

function normalizeParts(path: string, absolute: boolean): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else out.push(part);
  }
  return out.join('/');
}

export function createPath(cwd: () => string) {
  const path = {
    sep: '/',
    delimiter: ':',
    resolve(...parts: string[]): string {
      let resolved = '';
      for (let i = parts.length - 1; i >= -1 && !resolved.startsWith('/'); i--) {
        const part = i >= 0 ? parts[i] : cwd();
        if (!part) continue;
        resolved = resolved ? `${part}/${resolved}` : part;
      }
      return `/${normalizeParts(resolved, true)}`;
    },
    normalize(p: string): string {
      if (!p) return '.';
      const absolute = p.startsWith('/');
      const trailing = p.endsWith('/');
      let out = normalizeParts(p, absolute);
      if (!out && !absolute) out = '.';
      if (out && trailing) out += '/';
      return absolute ? `/${out}` : out;
    },
    isAbsolute: (p: string): boolean => p.startsWith('/'),
    join(...parts: string[]): string {
      const joined = parts.filter((p) => p !== '').join('/');
      return joined ? path.normalize(joined) : '.';
    },
    relative(from: string, to: string): string {
      if (from === to) return '';
      const a = path.resolve(from).split('/').filter(Boolean);
      const b = path.resolve(to).split('/').filter(Boolean);
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
    },
    dirname(p: string): string {
      if (!p) return '.';
      const trimmed = p.replace(/\/+$/, '') || '/';
      if (trimmed === '/') return '/';
      const at = trimmed.lastIndexOf('/');
      if (at === -1) return '.';
      return at === 0 ? '/' : trimmed.slice(0, at).replace(/\/+$/, '') || '/';
    },
    basename(p: string, ext?: string): string {
      const base = p.replace(/\/+$/, '').split('/').pop() ?? '';
      return ext && base !== ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
    },
    extname(p: string): string {
      const base = path.basename(p);
      const at = base.lastIndexOf('.');
      return at <= 0 ? '' : base.slice(at);
    },
    parse(p: string) {
      const root = p.startsWith('/') ? '/' : '';
      const base = path.basename(p);
      const ext = path.extname(p);
      const dir = p.includes('/') ? path.dirname(p) : '';
      return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
    },
    format(parts: {
      root?: string;
      dir?: string;
      base?: string;
      name?: string;
      ext?: string;
    }): string {
      const base =
        parts.base ??
        `${parts.name ?? ''}${parts.ext ? (parts.ext.startsWith('.') ? '' : '.') + parts.ext : ''}`;
      const dir = parts.dir ?? parts.root ?? '';
      if (!dir) return base;
      return dir === parts.root ? `${dir}${base}` : `${dir}/${base}`;
    },
    toNamespacedPath: (p: string): string => p,
    matchesGlob(p: string, pattern: string): boolean {
      const source = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        // oxlint-disable-next-line no-control-regex -- the placeholder for **/ above.
        .replace(/\u0000/g, '(?:.*/)?');
      return new RegExp(`^${source}$`).test(p);
    },
    posix: null as unknown,
    win32: null as unknown,
  };
  path.posix = path;
  path.win32 = path;
  return path;
}
