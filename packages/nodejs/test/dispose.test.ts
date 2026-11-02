import { expect, test } from 'vitest';
import { installDispose } from '../src/dispose';

test("the symbols are esbuild's fallbacks where the browser has none", () => {
  const symbols: Record<string, unknown> = {};
  installDispose(symbols);
  expect(symbols.dispose).toBe(Symbol.for('Symbol.dispose'));
  expect(symbols.asyncDispose).toBe(Symbol.for('Symbol.asyncDispose'));
});

test("a browser's own symbols stay", () => {
  const own = Symbol('own');
  const symbols: Record<string, unknown> = { dispose: own };
  installDispose(symbols);
  expect(symbols.dispose).toBe(own);
});
