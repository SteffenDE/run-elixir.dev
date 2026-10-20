import { describe, expect, test } from 'vitest';
import { createUtil } from '../../src/runtime/nodejs/util';

const util = createUtil(() => {});

describe('inspect', () => {
  test('shows what inspect.custom returns, a value inspected', () => {
    const custom = util.inspect.custom;
    expect(util.inspect({ x: { [custom]: () => ({ y: [1, 2] }) } })).toBe('{ x: { y: [ 1, 2 ] } }');
    expect(util.inspect({ x: { [custom]: () => 42 } })).toBe('{ x: 42 }');
    expect(util.inspect({ [custom]: () => 'text' })).toBe('text');
  });

  test("an array's holes", () => {
    // oxlint-disable-next-line no-sparse-arrays -- the holes.
    expect(util.inspect([1, , 3])).toBe('[ 1, <1 empty item>, 3 ]');
    // oxlint-disable-next-line no-sparse-arrays -- the holes.
    expect(util.inspect([, , , 1])).toBe('[ <3 empty items>, 1 ]');
    expect(util.inspect(new Array(5))).toBe('[ <5 empty items> ]');
    expect(util.inspect(Array.from({ length: 101 }, (_, i) => i))).toMatch(
      / 99,\s+\.\.\. 1 more item\n/,
    );
  });
});

test('isDeepStrictEqual as Node', () => {
  const equal = (a: unknown, b: unknown) => util.isDeepStrictEqual(a, b);
  const c1: Record<string, unknown> = { a: 1 };
  c1.self = c1;
  const c2: Record<string, unknown> = { a: 1 };
  c2.self = c2;
  const pairs: [unknown, unknown, boolean][] = [
    [/a/, /b/, false],
    [/a/g, /a/g, true],
    [/a/g, /a/i, false],
    [new Error('a'), new Error('b'), false],
    [new Error('a'), new Error('a'), true],
    [new Error('a'), new TypeError('a'), false],
    [new Error('a', { cause: 1 }), new Error('a', { cause: 2 }), false],
    [new Set([{ a: 1 }]), new Set([{ a: 1 }]), true],
    [new Set([{ a: 1 }]), new Set([{ a: 2 }]), false],
    [new Set([1, { a: 1 }]), new Set([1, { a: 1 }]), true],
    [new Map([[{ k: 1 }, 1]]), new Map([[{ k: 1 }, 1]]), true],
    [new Map([[{ k: 1 }, 1]]), new Map([[{ k: 1 }, 2]]), false],
    [new Number(1), new Number(2), false],
    [new Uint8Array([1, 2]), new Uint8Array([1, 3]), false],
    [new Uint8Array([1, 2]), new Uint8Array([1, 2]), true],
    [{ [Symbol.for('s')]: 1 }, { [Symbol.for('s')]: 2 }, false],
    [c1, c2, true],
    // oxlint-disable-next-line no-sparse-arrays -- a hole.
    [[1, , 3], [1, undefined, 3], false],
  ];
  for (const [a, b, expected] of pairs) expect([a, b, equal(a, b)]).toEqual([a, b, expected]);
});

test('format as Node', () => {
  class Named {
    toString() {
      return 'T';
    }
  }
  class Plain {
    a = 1;
  }
  const cases: [string, unknown, string][] = [
    ['%s', { a: { b: { c: 1 } } }, '{ a: [Object] }'],
    ['%s', [1, [2, [3]]], '[ 1, [Array] ]'],
    ['%s', -0, '-0'],
    ['%s', { toString: () => 'T' }, 'T'],
    ['%s', new Named(), 'T'],
    ['%s', new Plain(), 'Plain { a: 1 }'],
    ['%s', { [Symbol.toPrimitive]: () => 'P' }, 'P'],
    ['%s', new Date(0), '1970-01-01T00:00:00.000Z'],
    ['%s', Symbol('x'), 'Symbol(x)'],
    ['%d', Symbol('x'), 'NaN'],
    ['%i', Symbol('x'), 'NaN'],
    ['%f', Symbol('x'), 'NaN'],
    ['%d', -0, '-0'],
    ['%d', '0x10', '16'],
    ['%i', -0, '0'],
  ];
  for (const [pattern, value, expected] of cases)
    expect([pattern, util.format(pattern, value)]).toEqual([pattern, expected]);
});

describe('promisify', () => {
  test('resolves the first value a callback is given', async () => {
    const f = (_a: unknown, done: (e: unknown, ...v: unknown[]) => void) => done(null, 1, 2);
    expect(await util.promisify(f as never)(0)).toBe(1);
  });
});
