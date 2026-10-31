// JavaScript source as code and literals: the loader's rewrites (import.meta,
// require(, import(, exports."…") apply to code alone, never to what a
// string, template, comment or regular expression holds. A scan, not a
// parse: a / is a regular expression where an operand may start (after an
// operator, an opening bracket, a keyword such as return, an if's
// condition), else division.

export interface Piece {
  code: boolean;
  text: string;
}

const KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

export function pieces(source: string): Piece[] {
  const out: Piece[] = [];
  let code = '';
  // Template literals open: the brace depth at each ${ in them.
  const templates: number[] = [];
  let depth = 0;
  let i = 0;
  const literal = (text: string) => {
    if (code) out.push({ code: true, text: code });
    code = '';
    out.push({ code: false, text });
  };
  // Parentheses open: whether each is an if's, while's, for's or with's;
  // the last such one closed (its piece, and its place in that code).
  const parens: boolean[] = [];
  let control = { piece: -1, at: -1 };
  // Where a / starts a regular expression: after what can end no operand
  // (what a comment follows, past it), but not after a ++ or --, and after
  // an if's condition.
  const regexAllowed = () => {
    let piece = out.length;
    let trimmed = code.replace(/\s+$/, '');
    while (!trimmed) {
      const previous = out[--piece];
      if (!previous) return true;
      if (previous.code) trimmed = previous.text.replace(/\s+$/, '');
      else if (!previous.text.startsWith('//') && !previous.text.startsWith('/*'))
        return previous.text.endsWith('${');
    }
    const last = trimmed[trimmed.length - 1];
    if (last === ')') return control.piece === piece && control.at === trimmed.length - 1;
    if (/(\+\+|--)$/.test(trimmed)) return false;
    if (/[(,=:[!&|?{};+\-*%<>~^]/.test(last)) return true;
    const word = /([A-Za-z_$][\w$]*)$/.exec(trimmed)?.[1];
    return word !== undefined && KEYWORDS.has(word) && !/\.\s*[A-Za-z_$][\w$]*$/.test(trimmed);
  };
  // A template's text from `start` (after ` or }), up to ` or ${.
  const templateText = (start: number): number => {
    let j = start;
    while (j < source.length) {
      const c = source[j];
      if (c === '\\') j += 2;
      else if (c === '`') return j + 1;
      else if (c === '$' && source[j + 1] === '{') return j + 2;
      else j++;
    }
    return j;
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n')
        j += source[j] === '\\' ? 2 : 1;
      literal(source.slice(i, j + 1));
      i = j + 1;
    } else if (c === '`') {
      const end = templateText(i + 1);
      literal(source.slice(i, end));
      if (source[end - 1] === '{' && source[end - 2] === '$') templates.push(depth);
      i = end;
    } else if (c === '}' && templates.length && depth === templates[templates.length - 1]) {
      templates.pop();
      const end = templateText(i + 1);
      literal(source.slice(i, end));
      if (source[end - 1] === '{' && source[end - 2] === '$') templates.push(depth);
      i = end;
    } else if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      literal(source.slice(i, end === -1 ? source.length : end));
      i = end === -1 ? source.length : end;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      literal(source.slice(i, end === -1 ? source.length : end + 2));
      i = end === -1 ? source.length : end + 2;
    } else if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n') {
        const d = source[j];
        if (d === '\\') j++;
        else if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < source.length && /[a-z]/.test(source[j])) j++;
      literal(source.slice(i, j));
      i = j;
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '(') parens.push(/(?<![\w$.])(if|while|for(\s+await)?|with)\s*$/.test(code));
      else if (c === ')' && parens.pop()) control = { piece: out.length, at: code.length };
      code += c;
      i++;
    }
  }
  if (code) out.push({ code: true, text: code });
  return out;
}

// `source` with its import() calls as `name`( calls: an import( in its code
// (not obj.import( ), unless what it opens is followed by { (a method
// named import, as in a class or an object literal).
export function renameImportCalls(source: string, name: string): string {
  const code = pieces(source)
    .map((piece) => (piece.code ? piece.text : piece.text.replace(/[^\n]/g, ' ')))
    .join('');
  const brace = /\s*\{/y;
  let out = '';
  let from = 0;
  for (const match of code.matchAll(/(?<![\w$.])import(\s*)\(/g)) {
    let depth = 0;
    let j = match.index + match[0].length - 1;
    for (; j < code.length; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')' && --depth === 0) break;
    }
    brace.lastIndex = j + 1;
    if (brace.test(code)) continue;
    out += `${source.slice(from, match.index)}${name}`;
    from = match.index + 'import'.length;
  }
  return out + source.slice(from);
}

// `source` with `rewrite` applied to its code, and a string written right
// after `exports.` (sucrase's for an export named by a string) indexed.
export function rewriteCode(source: string, rewrite: (code: string) => string): string {
  const parts = pieces(source);
  let out = '';
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (!part.code) {
      out += part.text;
      continue;
    }
    let text = rewrite(part.text);
    const next = parts[k + 1];
    if (next && !next.code && /^["']/.test(next.text) && /\bexports\.\s*$/.test(text)) {
      text = text.replace(/\.\s*$/, '[');
      out += `${text}${next.text}]`;
      k++;
      continue;
    }
    out += text;
  }
  return out;
}
