import stringWidth from 'string-width';
import { describe, expect, test } from 'vitest';
import { cellSegmenter } from '../../../src/runtime/nodejs/claude/cellsegmenter';

// The screen as Claude Code's renderer lays it out: a cell's word is
// style << 17 | link << 2 | its width's kind.
const SCREEN = {
  widthMask: 3,
  narrow: 0,
  wide: 1,
  spacerTail: 2,
  spacerHead: 3,
  emptyCharIndex: 0,
  spacerCharIndex: 1,
  emptyWord: 0,
  tabWidth: 8,
};
const CellSegmenter = cellSegmenter(stringWidth);

describe('Bun.ant.CellSegmenter', () => {
  test('segments a styled, linked line into cells and runs', () => {
    const s = new CellSegmenter({ ambiguousIsNarrow: true, screen: SCREEN });
    const cells = new Int32Array(64);
    const runs = new Int32Array(64);
    const text =
      'a\u001b[1;31mb界\u001b[39m\u001b]8;;https://x.dev\u0007c\u001b]8;;\u0007\u001b[0m\td';
    const count = s.segment(text, cells, runs, false);
    expect(count).toBe(6);
    const graphemes = Array.from({ length: count }, (_, i) => s.graphemes[cells[2 * i]]);
    expect(graphemes).toEqual(['a', 'b', '界', 'c', ' ', 'd']);
    const widths = Array.from({ length: count }, (_, i) => cells[2 * i + 1] & 255);
    expect(widths.slice(0, 4)).toEqual([1, 1, 2, 1]);
    expect(cells[2 * 4 + 1] & 256).toBe(256);
    const run = (i: number) => cells[2 * i + 1] >>> 10;
    expect([0, 1, 2, 3, 4, 5].map(run)).toEqual([0, 1, 1, 2, 3, 3]);
    expect(s.sgrKeys[runs[2]].split('\u0000')).toEqual(['\u001b[1m', '\u001b[31m']);
    expect(s.sgrCloseKeys[runs[2]].split('\u0000')).toEqual(['\u001b[22m', '\u001b[39m']);
    expect(s.sgrKeys[runs[4]]).toBe('\u001b[1m');
    expect(s.uris[runs[5]]).toBe('https://x.dev');
    expect(runs[6]).toBe(0);
    expect(runs[7]).toBe(0);
  });

  test('asks for more room', () => {
    const s = new CellSegmenter({ screen: SCREEN });
    expect(s.segment('abcdef', new Int32Array(4), new Int32Array(4), false)).toBeLessThanOrEqual(
      -6,
    );
  });

  test('paints a row: a wide character and its spacer, a tab, what changed', () => {
    const s = new CellSegmenter({ screen: SCREEN });
    const cells = new Int32Array(64);
    const runs = new Int32Array(64);
    const count = s.segment('a界\tz', cells, runs, false);
    const chars = Int32Array.from(s.graphemes.map((_, i) => 10 + i));
    const words = Int32Array.from([5 << 17]);
    const screen = new Int32Array(2 * 12 * 2);
    const result = s.paint(screen, 12, 1, 1, cells, count, undefined, chars, words);
    expect(result % 2 ** 20).toBe(9);
    expect(Math.floor(result / 2 ** 20) % 2 ** 16).toBe(1);
    expect(Math.floor(result / 2 ** 36)).toBe(9);
    const at = (x: number) => [screen[(12 + x) * 2], screen[(12 + x) * 2 + 1]];
    expect(at(1)).toEqual([10, 5 << 17]);
    expect(at(2)).toEqual([11, (5 << 17) | 1]);
    expect(at(3)).toEqual([1, (5 << 17) | 2]);
    expect(at(4)).toEqual([0, 5 << 17]);
    expect(at(8)).toEqual([13, 5 << 17]);
    // Its second half written over: the wide character goes.
    s.setCell(screen, 12, 3, 1, 20, 0);
    expect(at(2)).toEqual([0, 0]);
  });
});
