import { describe, expect, test } from 'vitest';
import { pieces } from '../../src/nodejs/source';

// The literals (strings, comments, regular expressions) the scan finds.
const literals = (source: string) =>
  pieces(source)
    .filter((piece) => !piece.code)
    .map((piece) => piece.text);

describe('a / ', () => {
  test('after a comment is what it is after the code before', () => {
    expect(literals("a = b // c\n  / d; s = 'it'")).toEqual(['// c', "'it'"]);
    expect(literals("a = b /* c */ / d; s = 'it'")).toEqual(['/* c */', "'it'"]);
    expect(literals("x = /* c */ /'/.test(s)")).toEqual(['/* c */', "/'/"]);
    expect(literals("// c\n/'/.test(s)")).toEqual(['// c', "/'/"]);
  });

  test('after ++ or -- is division', () => {
    expect(literals("x = a++ / 2; y = '/'")).toEqual(["'/'"]);
    expect(literals("x = a-- / 2; y = '/'")).toEqual(["'/'"]);
  });

  test("after an if's, while's or for's condition is a regular expression", () => {
    expect(literals("if (ok) /'/.test(s); z = 1")).toEqual(["/'/"]);
    expect(literals("while (f(a)) /'/.exec(s)")).toEqual(["/'/"]);
    expect(literals("x = (a) / 2; y = '/'")).toEqual(["'/'"]);
    expect(literals("x = f(a) / g(b) / 2; y = '/'")).toEqual(["'/'"]);
  });

  test("after a string or a template's ${ is what it is there", () => {
    expect(literals("x = 'a'.length / 2; y = '/'")).toEqual(["'a'", "'/'"]);
    expect(literals('x = `${/a/.source}`')).toEqual(['`${', '/a/', '}`']);
  });
});
