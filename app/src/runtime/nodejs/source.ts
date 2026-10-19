// JavaScript source as code and literals: the loader's rewrites (import.meta,
// require(, import(, exports."…") apply to code alone, never to what a
// string, template, comment or regular expression holds. A scan, not a
// parse: a / is a regular expression where an operand may start (after an
// operator, an opening bracket, a keyword such as return), else division.

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
  // Where a / starts a regular expression: after what can end no operand.
  const regexAllowed = () => {
    const trimmed = code.replace(/\s+$/, '');
    const last = trimmed[trimmed.length - 1];
    if (last === undefined) {
      const previous = out[out.length - 1];
      return !previous || !previous.code
        ? !previous || previous.text.startsWith('//') || previous.text.startsWith('/*')
        : true;
    }
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
      code += c;
      i++;
    }
  }
  if (code) out.push({ code: true, text: code });
  return out;
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
