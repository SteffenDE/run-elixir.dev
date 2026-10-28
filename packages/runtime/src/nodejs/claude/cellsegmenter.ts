// Bun.ant.CellSegmenter: what Claude Code's terminal renderer asks of the
// Bun Anthropic builds it with (bun.ts), here in JavaScript. Its contract,
// as the renderer uses it:
//
// - segment(text, cells, runs, reordered): the text (with its SGR and OSC
//   8 sequences) as grapheme cells, pairs [grapheme, info] in `cells`
//   (info: its width in the low 8 bits, TAB for a tab, its run << 10),
//   and its runs, pairs [style, link] in `runs` (indices into sgrKeys and
//   sgrCloseKeys, and uris; 0: none); the number of cells, or minus the
//   number it needs when `cells` holds fewer.
// - graphemes, sgrKeys, sgrCloseKeys, uris: what those indices name (a
//   style: its SGR codes, one each, joined by NUL, and their closing codes
//   so).
// - paint(screen, width, x, y, cells, count, _, chars, words): the cells
//   on the screen's row y from column x (the screen: pairs [char, word] a
//   cell; chars: the screen's index of each grapheme; words: each run's
//   word, style << 17 | link << 2), a wide one with a spacer after it;
//   setCell(screen, width, x, y, char, word): one. Both answer the column
//   after, and what changed: from + to * 2^16, above 2^20.

const TAB = 256;
// SGR's closing codes.
const CLOSES = new Set([22, 23, 24, 25, 27, 28, 29, 39, 49, 55, 59]);
const RUN_SHIFT = 10;

interface Screen {
  widthMask: number;
  narrow: number;
  wide: number;
  spacerTail: number;
  spacerHead: number;
  emptyCharIndex: number;
  spacerCharIndex: number;
  emptyWord: number;
  tabWidth: number;
}

interface Options {
  ambiguousIsNarrow?: boolean;
  // Code point ranges left out (bidirectional controls).
  substitute?: [number, number][];
  screen: Screen;
}

type Width = (text: string, options: { ambiguousIsNarrow?: boolean }) => number;

// A code's closing code (SGR); null for a reset.
function closing(code: number): number | null {
  if (code === 0) return null;
  if (code === 1 || code === 2) return 22;
  if (code === 3) return 23;
  if (code === 4 || code === 21) return 24;
  if (code === 5 || code === 6) return 25;
  if (code === 7) return 27;
  if (code === 8) return 28;
  if (code === 9) return 29;
  if (code === 53) return 55;
  if ((code >= 30 && code <= 38) || (code >= 90 && code <= 97)) return 39;
  if ((code >= 40 && code <= 48) || (code >= 100 && code <= 107)) return 49;
  if (code === 58) return 59;
  return -1;
}

export function cellSegmenter(measure: Width) {
  const graphemer = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return class CellSegmenter {
    graphemes: string[] = [];
    sgrKeys: string[] = [''];
    sgrCloseKeys: string[] = [''];
    uris: string[] = [''];
    #graphemeIds = new Map<string, number>();
    #styleIds = new Map<string, number>([['', 0]]);
    #uriIds = new Map<string, number>([['', 0]]);
    #widths = new Map<string, number>();
    #narrow: boolean;
    #substitute: RegExp | null;
    #screen: Screen;

    constructor(options: Options) {
      this.#narrow = options.ambiguousIsNarrow ?? true;
      this.#screen = options.screen;
      const ranges = options.substitute ?? [];
      this.#substitute = ranges.length
        ? new RegExp(
            `[${ranges.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')}]`,
            'gu',
          )
        : null;
    }

    #grapheme(text: string): number {
      let id = this.#graphemeIds.get(text);
      if (id === undefined) {
        id = this.graphemes.push(text) - 1;
        this.#graphemeIds.set(text, id);
      }
      return id;
    }

    #width(text: string): number {
      let w = this.#widths.get(text);
      if (w === undefined) {
        w = Math.min(2, measure(text, { ambiguousIsNarrow: this.#narrow }));
        this.#widths.set(text, w);
      }
      return w;
    }

    #style(active: { code: string; end: string }[]): number {
      const opens = active.map((a) => a.code).join('\0');
      const closes = active.map((a) => a.end).join('\0');
      const key = `${opens}\u0001${closes}`;
      let id = this.#styleIds.get(active.length ? key : '');
      if (id === undefined) {
        id = this.sgrKeys.push(opens) - 1;
        this.sgrCloseKeys.push(closes);
        this.#styleIds.set(key, id);
      }
      return id;
    }

    #uri(uri: string): number {
      let id = this.#uriIds.get(uri);
      if (id === undefined) {
        id = this.uris.push(uri) - 1;
        this.#uriIds.set(uri, id);
      }
      return id;
    }

    segment(text: string, cells: Int32Array, runs: Int32Array, _reordered?: boolean): number {
      const active: { code: string; end: string }[] = [];
      let style = 0;
      let uri = 0;
      let count = 0;
      let run = -1;
      let runStyle = -1;
      let runUri = -1;
      const cell = (grapheme: number, info: number) => {
        if (style !== runStyle || uri !== runUri) {
          run++;
          runStyle = style;
          runUri = uri;
          if (2 * run + 1 < runs.length) {
            runs[2 * run] = style;
            runs[2 * run + 1] = uri;
          }
        }
        if (2 * count + 1 < cells.length) {
          cells[2 * count] = grapheme;
          cells[2 * count + 1] = info | (run << RUN_SHIFT);
        }
        count++;
      };
      const sgr = (sequence: string) => {
        const parts = sequence === '' ? ['0'] : sequence.split(/[;:]/);
        for (let i = 0; i < parts.length; i++) {
          const code = Number(parts[i]) || 0;
          let params = String(code);
          if ((code === 38 || code === 48 || code === 58) && parts[i + 1] === '5') {
            params = `${code};5;${parts[i + 2] ?? 0}`;
            i += 2;
          } else if ((code === 38 || code === 48 || code === 58) && parts[i + 1] === '2') {
            params = `${code};2;${parts[i + 2] ?? 0};${parts[i + 3] ?? 0};${parts[i + 4] ?? 0}`;
            i += 4;
          }
          const end = closing(code);
          if (end === null) active.length = 0;
          else if (CLOSES.has(code)) {
            for (let k = active.length - 1; k >= 0; k--)
              if (active[k].end === `\u001b[${code}m`) active.splice(k, 1);
          } else if (end !== -1) {
            const entry = { code: `\u001b[${params}m`, end: `\u001b[${end}m` };
            const same =
              end === 39 || end === 49 || end === 59
                ? active.findIndex((a) => a.end === entry.end)
                : active.findIndex((a) => a.code === entry.code);
            if (same >= 0) active[same] = entry;
            else active.push(entry);
          }
        }
        style = this.#style(active);
      };
      const plain = (chunk: string) => {
        if (this.#substitute) chunk = chunk.replace(this.#substitute, '');
        for (const { segment } of graphemer.segment(chunk)) {
          if (segment === '\t') cell(this.#grapheme(' '), TAB);
          else if (segment === '\n' || segment === '\r') continue;
          else cell(this.#grapheme(segment), this.#width(segment));
        }
      };
      // SGR, OSC 8 (a link, or its end), and any other escape left out.
      const escapes =
        // oxlint-disable-next-line no-control-regex -- the terminal's escapes.
        /\u001b\[([\d;:]*)m|\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)|\u001b\[[\d;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
      let at = 0;
      for (const match of text.matchAll(escapes)) {
        if (match.index > at) plain(text.slice(at, match.index));
        at = match.index + match[0].length;
        if (match[1] !== undefined) sgr(match[1]);
        else if (match[2] !== undefined) uri = match[2] ? this.#uri(match[2]) : 0;
      }
      if (at < text.length) plain(text.slice(at));
      return 2 * count <= cells.length && 2 * (run + 1) <= runs.length ? count : -count - 1;
    }

    // Writes on one row, and what changed.
    #painter(screen: Int32Array, width: number, y: number) {
      const s = this.#screen;
      const row = y * width;
      let from = Infinity;
      let to = -1;
      const blank = (x: number) => {
        const i = (row + x) << 1;
        if (screen[i] === s.emptyCharIndex && screen[i + 1] === s.emptyWord) return;
        screen[i] = s.emptyCharIndex;
        screen[i + 1] = s.emptyWord;
        from = Math.min(from, x);
        to = Math.max(to, x + 1);
      };
      const put = (x: number, char: number, word: number) => {
        if (x < 0 || x >= width) return;
        const i = (row + x) << 1;
        const old = screen[i + 1] & s.widthMask;
        const kind = word & s.widthMask;
        // Half of a wide character written over: the other half goes.
        if (old === s.spacerTail && kind !== s.spacerTail && x > 0) {
          const head = (row + x - 1) << 1;
          if ((screen[head + 1] & s.widthMask) === s.wide) blank(x - 1);
        }
        if (old === s.wide && kind !== s.wide && x + 1 < width) {
          const tail = (row + x + 1) << 1;
          if ((screen[tail + 1] & s.widthMask) === s.spacerTail) blank(x + 1);
        }
        if (screen[i] === char && screen[i + 1] === word) return;
        screen[i] = char;
        screen[i + 1] = word;
        from = Math.min(from, x);
        to = Math.max(to, x + 1);
      };
      const glyph = (x: number, char: number, word: number, wide: boolean): number => {
        const base = word & ~s.widthMask;
        if (!wide) {
          put(x, char, base | s.narrow);
          return x + 1;
        }
        if (x + 1 >= width) {
          put(x, s.emptyCharIndex, base | s.spacerHead);
          return x + 2;
        }
        put(x, char, base | s.wide);
        put(x + 1, s.spacerCharIndex, base | s.spacerTail);
        return x + 2;
      };
      const changed = (x: number) => (from > to ? x : x + from * 2 ** 20 + to * 2 ** 36);
      return { glyph, put, changed };
    }

    paint(
      screen: Int32Array,
      width: number,
      x: number,
      y: number,
      cells: Int32Array,
      count: number,
      _unused: unknown,
      chars: Int32Array,
      words: Int32Array,
    ): number {
      const { glyph, put, changed } = this.#painter(screen, width, y);
      const tab = this.#screen.tabWidth;
      let col = x;
      for (let i = 0; i < count; i++) {
        const info = cells[2 * i + 1];
        const word = words[info >>> RUN_SHIFT] ?? 0;
        if (info & TAB) {
          const next = col + (tab - (col % tab));
          for (; col < next; col++)
            put(
              col,
              this.#screen.emptyCharIndex,
              (word & ~this.#screen.widthMask) | this.#screen.narrow,
            );
          continue;
        }
        const w = info & 255;
        if (w === 0) continue;
        col = glyph(col, chars[cells[2 * i]], word, w === 2);
      }
      return changed(col);
    }

    setCell(
      screen: Int32Array,
      width: number,
      x: number,
      y: number,
      char: number,
      word: number,
    ): number {
      const { glyph, put, changed } = this.#painter(screen, width, y);
      const kind = word & this.#screen.widthMask;
      if (kind === this.#screen.wide) return changed(glyph(x, char, word, true));
      put(x, char, word);
      return changed(x + 1);
    }
  };
}
