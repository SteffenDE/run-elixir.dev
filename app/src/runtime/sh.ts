// Command lines as the playground's shells split them: the terminal's
// (worker/index.ts) and a node's sh -c (coreutils.ts, the page's
// programs/node.ts).

// Words, with '' and "" quoting.
export function words(line: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? '') + c;
  }
  if (word !== null) out.push(word);
  return out;
}

// A command line's commands, as far as the playground runs them: words
// joined by &&, without the ( ) and </dev/null that System.shell and
// os:cmd wrap them in.
export function commands(line: string): string[][] {
  let text = line.trim();
  for (;;) {
    const unwrapped = text
      .replace(/\s*<\s*\/dev\/null\s*$/, '')
      .replace(/^\(([\s\S]*)\)$/, '$1')
      .trim();
    if (unwrapped === text) break;
    text = unwrapped;
  }
  const out: string[][] = [[]];
  for (const word of words(text)) {
    if (word === '&&') out.push([]);
    else out[out.length - 1].push(word);
  }
  return out;
}

// A word as sh reads it back: quoted unless it needs nothing.
export const quote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
