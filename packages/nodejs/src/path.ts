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

// A name's extension, as Node's: from its last dot, not its first
// character, nor the second of '..'.
function extension(base: string): string {
  const dot = base.lastIndexOf('.');
  return dot <= 0 || base === '..' ? '' : base.slice(dot);
}

// A glob's {a,b} alternatives, each spelled out.
function braces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  const options: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}' && --depth === 0) {
      options.push(pattern.slice(from, i));
      if (options.length === 1)
        return braces(pattern.slice(i + 1)).map((rest) => `${pattern.slice(0, i + 1)}${rest}`);
      const rest = braces(pattern.slice(i + 1));
      return options.flatMap((option) =>
        braces(pattern.slice(0, open) + option).flatMap((head) => rest.map((r) => head + r)),
      );
    } else if (pattern[i] === ',' && depth === 1) {
      options.push(pattern.slice(from, i));
      from = i + 1;
    }
  }
  return [pattern];
}

// A segment's name, without a leading dot.
const SEGMENT = '(?!\\.)[^/]+';

// A glob (no braces) as a regular expression's source.
function globSource(glob: string): string {
  const parts = glob.split('/').map((part) => {
    if (part === '**') return null;
    let out = part.startsWith('.') ? '' : '(?!\\.)';
    for (let i = 0; i < part.length; i++) {
      const c = part[i];
      const close = c === '[' ? part.indexOf(']', i + 2) : -1;
      if (c === '*') out += '[^/]*';
      else if (c === '?') out += '[^/]';
      else if (close !== -1) {
        let inside = part.slice(i + 1, close).replace(/\\/g, '\\\\');
        if (inside[0] === '!' || inside[0] === '^') inside = `^/${inside.slice(1)}`;
        out += `[${inside}]`;
        i = close;
      } else out += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
    return out;
  });
  let source = '';
  parts.forEach((part, i) => {
    const first = i === 0;
    const last = i === parts.length - 1;
    // ** is any segments: none, or names each.
    if (part === null)
      source += last
        ? `${first ? '' : '/'}(?:${SEGMENT}(?:/${SEGMENT})*)?`
        : `${first ? '' : '/'}(?:${SEGMENT}/)*`;
    else source += (first || parts[i - 1] === null ? '' : '/') + part;
  });
  return source;
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
    // As Node's: up to the slash before the last name ('/a//b' is '/a/').
    dirname(p: string): string {
      if (!p) return '.';
      let end = -1;
      let slashes = true;
      for (let i = p.length - 1; i >= 1; i--) {
        if (p[i] !== '/') slashes = false;
        else if (!slashes) {
          end = i;
          break;
        }
      }
      if (end === -1) return p[0] === '/' ? '/' : '.';
      if (p[0] === '/' && end === 1) return '//';
      return p.slice(0, end);
    },
    // As Node's: the suffix is cut where it ends the name, or is the path.
    basename(p: string, suffix?: string): string {
      const base = p.replace(/\/+$/, '').split('/').pop() ?? '';
      if (!suffix || suffix.length > p.length) return base;
      if (suffix === p) return '';
      return base !== suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
    },
    extname(p: string): string {
      return extension(p.replace(/\/+$/, '').split('/').pop()!);
    },
    parse(p: string) {
      const root = p.startsWith('/') ? '/' : '';
      const trimmed = p.replace(/(?<=.)\/+$/, '');
      const at = trimmed.lastIndexOf('/');
      const base = trimmed.slice(at + 1);
      // Node's parse('/..') has '.' for its extension.
      const ext = base === '..' && at === 0 ? '.' : extension(base);
      const dir = at <= 0 ? root : trimmed.slice(0, at);
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
        parts.base ||
        `${parts.name ?? ''}${parts.ext ? (parts.ext.startsWith('.') ? '' : '.') + parts.ext : ''}`;
      const dir = parts.dir || parts.root || '';
      if (!dir) return base;
      return dir === parts.root ? `${dir}${base}` : `${dir}/${base}`;
    },
    toNamespacedPath: (p: string): string => p,
    // As Node's (minimatch's): {a,b}, [classes], ** for any segments, and
    // no wildcard matching a name's leading dot.
    matchesGlob(p: string, pattern: string): boolean {
      const source = braces(pattern).map(globSource).join('|');
      return new RegExp(`^(?:${source})/?$`).test(p);
    },
    posix: null as unknown,
    win32: null as unknown,
  };
  path.posix = path;
  path.win32 = path;
  return path;
}
