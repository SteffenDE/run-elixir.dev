// What is clickable in a terminal besides web links: a source location
// (lib/foo.ex:12, /work/x/mix.exs:3:5) opens in the editor at that line;
// a server's address (localhost:4000/posts) opens in the preview.
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { openFile, searchPath, showInPreview, stat } from '@/project/lib/playground';

const EXTENSIONS =
  'exs?|heex|eex|leex|erl|hrl|js|mjs|ts|tsx|css|json|md|lock|html|txt|toml|ya?ml|sh';
const FILE = new RegExp(
  `(?<![\\w/.@-])((?:/|\\.{1,2}/)?(?:[\\w.@+-]+/)*[\\w.@+-]+\\.(?:${EXTENSIONS})):(\\d+)(?::\\d+)?`,
  'g',
);
// host:port with an optional path, not the tail of a scheme's URL (those
// are web links).
const ADDRESS = /(?<!:\/\/)\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})(\/[^\s'")\]]*)?/g;

// Where a printed path is: as it is when absolute, else below the first
// directory of the search path that has it.
const found = new Map<string, Promise<string | null>>();
function locate(path: string): Promise<string | null> {
  const candidates = path.startsWith('/')
    ? [path]
    : searchPath().map((dir) => `${dir}/${path.replace(/^\.\//, '')}`);
  const key = candidates.join('\n');
  let result = found.get(key);
  if (!result) {
    result = (async () => {
      for (const candidate of candidates) if ((await stat(candidate)) === 'file') return candidate;
      return null;
    })();
    found.set(key, result);
    // A file may appear later (a generator ran): ask again then.
    setTimeout(() => found.delete(key), 5000);
  }
  return result;
}

function range(y: number, start: number, length: number): ILink['range'] {
  return { start: { x: start + 1, y }, end: { x: start + length, y } };
}

export function linkProvider(terminal: Terminal): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = terminal.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
      const links: Promise<ILink | null>[] = [];
      for (const match of line.matchAll(FILE)) {
        const [text, path, lineNumber] = match;
        links.push(
          locate(path).then((absolute) =>
            absolute
              ? {
                  range: range(y, match.index, text.length),
                  text,
                  decorations: { underline: true, pointerCursor: true },
                  activate: () => void openFile(absolute, Number(lineNumber)),
                }
              : null,
          ),
        );
      }
      for (const match of line.matchAll(ADDRESS)) {
        const [text, , path] = match;
        links.push(
          Promise.resolve({
            range: range(y, match.index, text.length),
            text,
            decorations: { underline: true, pointerCursor: true },
            activate: () => showInPreview(path || '/'),
          }),
        );
      }
      if (!links.length) return callback(undefined);
      void Promise.all(links).then((all) => {
        const shown = all.filter((link): link is ILink => link !== null);
        callback(shown.length ? shown : undefined);
      });
    },
  };
}

// A web link: the app's own address goes to the preview, others to a new
// tab.
export function openWebLink(uri: string): void {
  const url = new URL(uri);
  if (['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) {
    showInPreview(url.pathname + url.search);
  } else {
    window.open(uri, '_blank', 'noopener,noreferrer');
  }
}
