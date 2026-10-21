import { describe, expect, test } from 'vitest';
import { graphParts, readGraph } from '@/project/lib/programs/claude/bungraph';

const encoder = new TextEncoder();

// An executable as bun build --compile lays one out: some bytes, then the
// graph (the modules' bytes, their names, the list of 52-byte records),
// its offsets and the trailer.
function executable(
  modules: { name: string; contents: Uint8Array; encoding: number; loader: number }[],
  entry: number,
): Uint8Array {
  const blob: number[] = [];
  const put = (bytes: Uint8Array) => {
    const at = blob.length;
    blob.push(...bytes);
    return [at, bytes.length];
  };
  const placed = modules.map((m) => ({
    name: put(encoder.encode(`/$bunfs/root/${m.name}`)),
    contents: put(m.contents),
    encoding: m.encoding,
    loader: m.loader,
  }));
  const list = blob.length;
  for (const m of placed) {
    const record = new DataView(new ArrayBuffer(52));
    [...m.name, ...m.contents].forEach((word, i) => record.setUint32(4 * i, word, true));
    record.setUint8(48, m.encoding);
    record.setUint8(49, m.loader);
    blob.push(...new Uint8Array(record.buffer));
  }
  const offsets = new DataView(new ArrayBuffer(32));
  offsets.setBigUint64(0, BigInt(blob.length), true);
  offsets.setUint32(8, list, true);
  offsets.setUint32(12, blob.length - list, true);
  offsets.setUint32(16, entry, true);
  return new Uint8Array([
    ...encoder.encode('\x7fELF the runtime'),
    ...blob,
    ...new Uint8Array(offsets.buffer),
    ...encoder.encode('\n---- Bun! ----\n'),
  ]);
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('a Bun executable’s module graph', () => {
  const binary = executable(
    [
      {
        name: 'chunk-a.js',
        contents: encoder.encode('export const a = import.meta.require("./note.txt");'),
        encoding: 1,
        loader: 1,
      },
      {
        name: 'cli',
        contents: encoder.encode(
          'import{a}from"/$bunfs/root/chunk-a.js";console.log(a, import.meta.dir, import.meta.dirname);',
        ),
        encoding: 1,
        loader: 1,
      },
      {
        name: 'sub/worker.js',
        contents: encoder.encode('import"/$bunfs/root/chunk-a.js";'),
        encoding: 2,
        loader: 1,
      },
      { name: 'note.txt', contents: encoder.encode('hello'), encoding: 0, loader: 13 },
      { name: 'lib.min.js', contents: encoder.encode('!function(){}()'), encoding: 0, loader: 5 },
      { name: 'addon.node', contents: new Uint8Array([1, 2, 3]), encoding: 0, loader: 10 },
    ],
    1,
  );

  test('reads its modules and entry', () => {
    const { modules, entry } = readGraph(binary);
    expect(modules.map((m) => m.name)).toEqual([
      'chunk-a.js',
      'cli',
      'sub/worker.js',
      'note.txt',
      'lib.min.js',
      'addon.node',
    ]);
    expect(entry).toBe(1);
  });

  test('gives Node its modules: relative imports, Bun’s import.meta as Node has it', () => {
    const { modules, assets } = graphParts(binary);
    expect([...modules.keys()].sort()).toEqual(['chunk-a.js', 'cli.js', 'sub/worker.js']);
    expect(modules.get('cli.js')).toContain('import{a}from"./chunk-a.js"');
    expect(modules.get('cli.js')).toContain('import.meta.dirname, import.meta.dirname');
    expect(modules.get('chunk-a.js')).toBe('export const a = require("./note.txt");');
    expect(modules.get('sub/worker.js')).toBe('import"../chunk-a.js";');
    const files = Object.fromEntries(assets.map((f) => [f.name, text(f.data)]));
    expect(files).toEqual({ 'note.txt': 'hello', 'lib.min.js': '!function(){}()' });
  });

  test('says what it is not', () => {
    expect(() => readGraph(encoder.encode('just a program'))).toThrow(/no module graph/);
  });
});
