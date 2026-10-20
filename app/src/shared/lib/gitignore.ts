// .gitignore's patterns, simply (gitignore(5)): comments, `!` to take a
// pattern back, a trailing `/` for directories only, a `/` at the start or
// in the middle to anchor a pattern to its file's directory, and `*`, `?`,
// `[…]` and `**`. A file below an ignored directory is not taken back by a
// later `!`, as in git: the walk does not go into that directory.

interface Rule {
  negated: boolean;
  dirOnly: boolean;
  pattern: RegExp;
}

// One .gitignore's rules, in its order.
export function parseGitignore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (let line of text.split(/\r?\n/)) {
    // Trailing spaces go, unless escaped.
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    // A slash at the start or in the middle: relative to the file's directory;
    // else the name at any depth below it.
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = globSource(line);
    rules.push({
      negated,
      dirOnly,
      pattern: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`),
    });
  }
  return rules;
}

function globSource(glob: string): string {
  let out = '';
  for (let at = 0; at < glob.length; at++) {
    const c = glob[at];
    if (c === '*') {
      if (glob[at + 1] === '*') {
        const before = at === 0 || glob[at - 1] === '/';
        const after = at + 2 === glob.length || glob[at + 2] === '/';
        if (before && after) {
          at++;
          if (at + 1 === glob.length) {
            // `x/**`: everything inside.
            out += '.*';
          } else {
            // `**/x`, `x/**/y`: no directories or any.
            out += '(?:.*/)?';
            at++;
          }
          continue;
        }
      }
      out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', at + 2);
      if (end < 0) out += '\\[';
      else {
        let set = glob.slice(at + 1, end).replace(/\\/g, '\\\\');
        if (set.startsWith('!')) set = `^${set.slice(1)}`;
        out += `[${set}]`;
        at = end;
      }
    } else if (c === '\\' && at + 1 < glob.length) out += escape(glob[++at]);
    else out += escape(c);
  }
  return out;
}

const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// The .gitignore files of a tree, each at its directory (a path below the
// tree's root, '' for the root itself).
export class Ignores {
  private rules = new Map<string, Rule[]>();

  add(dir: string, text: string): void {
    this.rules.set(dir, parseGitignore(text));
  }

  // Is the path (below the root) ignored? The deepest .gitignore that has a
  // say decides; in it, the last pattern that matches. Its directories are
  // to be asked about first (the walk does).
  ignored(path: string, isDir: boolean): boolean {
    const parts = path.split('/');
    for (let depth = parts.length - 1; depth >= 0; depth--) {
      const rules = this.rules.get(parts.slice(0, depth).join('/'));
      if (!rules) continue;
      const below = parts.slice(depth).join('/');
      for (let at = rules.length - 1; at >= 0; at--) {
        const rule = rules[at];
        if (rule.dirOnly && !isDir) continue;
        if (rule.pattern.test(below)) return !rule.negated;
      }
    }
    return false;
  }
}
