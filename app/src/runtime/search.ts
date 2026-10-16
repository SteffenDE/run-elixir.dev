// Searching file contents (files.ts's 'search'): every match of a text or
// a regular expression, line by line, in files that are text.
import type { SearchHit, SearchQuery } from './host/files';

// Files larger than this, or with a NUL in their first 8 KiB (binary), are
// not searched.
export const LARGEST = 1 << 20;
// What a hit shows of its line: from a little before the match, this long.
const BEFORE = 16;
const SHOWN = 200;

const decoder = new TextDecoder();

// The query as a global regular expression, or the reason it is none.
export function pattern({ text, regex, matchCase }: SearchQuery): RegExp | string {
  const source = regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(source, matchCase ? 'g' : 'gi');
  } catch (error) {
    return (error as Error).message;
  }
}

// The hits in one file, at most `room` of them.
export function searchFile(
  path: string,
  bytes: Uint8Array,
  expression: RegExp,
  room: number,
): SearchHit[] {
  if (bytes.length > LARGEST || bytes.subarray(0, 8192).includes(0)) return [];
  const hits: SearchHit[] = [];
  const lines = decoder.decode(bytes).split('\n');
  for (let index = 0; index < lines.length && hits.length < room; index++) {
    const line = lines[index].replace(/\r$/, '');
    expression.lastIndex = 0;
    for (let found = expression.exec(line); found; found = expression.exec(line)) {
      // An empty match would find itself again.
      if (!found[0].length) {
        expression.lastIndex++;
        continue;
      }
      const column = found.index;
      const indent = line.length - line.trimStart().length;
      const start = Math.max(Math.min(indent, column), column - BEFORE);
      hits.push({
        path,
        line: index + 1,
        column: column + 1,
        text: line.slice(start, start + SHOWN),
        at: column - start,
        length: Math.min(found[0].length, SHOWN - (column - start)),
        cut: start > indent,
      });
      if (hits.length >= room) break;
    }
  }
  return hits;
}
