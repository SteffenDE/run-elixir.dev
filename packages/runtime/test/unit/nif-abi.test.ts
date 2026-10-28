import { describe, expect, it } from 'vitest';
import { Nifs } from '../../src/nif';
import type { WASI } from '../../src/wasi/index';

// A module that exports its memory and, with `layer`, beamos_nif_abi()
// answering it: what the loader looks at before a library runs.
function library(layer: number | null): Uint8Array<ArrayBuffer> {
  const name = (text: string) => [text.length, ...new TextEncoder().encode(text)];
  const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
  const exports = [[...name('memory'), 2, 0]];
  if (layer !== null) exports.push([...name('beamos_nif_abi'), 0, 0]);
  const body = [0, 0x41, layer ?? 0, 0x0b];
  return new Uint8Array([
    ...[0, 0x61, 0x73, 0x6d, 1, 0, 0, 0],
    ...section(1, [1, 0x60, 0, 1, 0x7f]),
    ...section(3, [1, 0]),
    ...section(5, [1, 0, 1]),
    ...section(7, [exports.length, ...exports.flat()]),
    ...section(10, [1, body.length, ...body]),
  ]);
}

const nifs = () =>
  new Nifs({ imports: { wasi_snapshot_preview1: {} }, memory: null } as unknown as WASI);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('the NIF loader', () => {
  it('loads a library of its erl_nif layer', () => {
    expect(text(nifs().create(library(1)))).toBe('1');
  });

  it('refuses one of another layer before it runs', () => {
    expect(text(nifs().create(library(2)))).toBe(
      'error built for erl_nif layer 2, not 1: build it again',
    );
  });

  it('refuses one from before the layer was numbered', () => {
    expect(text(nifs().create(library(null)))).toBe(
      'error built for an unnumbered erl_nif layer, not 1: build it again',
    );
  });
});
