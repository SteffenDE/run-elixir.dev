import { describe, expect, test } from 'vitest';
import { Dir, File, Symlink, entries, untarInto } from '@/runtime/wasi/fs';

const encoder = new TextEncoder();

// A tar entry: its header (name, size, type) and its body, in blocks.
function entry(name: string, type: string, body: Uint8Array, link = ''): Uint8Array {
  const header = new Uint8Array(512);
  header.set(encoder.encode(name), 0);
  header.set(encoder.encode(link), 157);
  header.set(encoder.encode(`${body.length.toString(8).padStart(11, '0')}\0`), 124);
  header[156] = type.charCodeAt(0);
  const blocks = new Uint8Array(512 + Math.ceil(body.length / 512) * 512);
  blocks.set(header);
  blocks.set(body, 512);
  return blocks;
}

// A pax record: "LENGTH key=value\n", its length in bytes, itself included.
function record(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  const bytes = encoder.encode(rest).length;
  let length = bytes;
  while (length !== bytes + String(length).length) length = bytes + String(length).length;
  return `${length}${rest}`;
}

function tar(...parts: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0) + 1024);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

describe("a tar's entries", () => {
  test.each(['package/naïve.js', 'package/日本語/ファイル.js'])(
    'take the path of a pax header: %s',
    (path) => {
      const pax = encoder.encode(record('path', path) + record('mtime', '1700000000'));
      const files = [
        ...entries(
          tar(
            entry('PaxHeader', 'x', pax),
            entry('package/truncated', '0', encoder.encode('a')),
            entry('package/next.js', '0', encoder.encode('b')),
          ),
        ),
      ];
      expect(files.map(({ name }) => name)).toEqual([path, 'package/next.js']);
    },
  );
});

describe('a tar laid into a tree', () => {
  test('keeps its symbolic links, and its hard links as the same file', () => {
    const root = new Dir();
    untarInto(
      tar(
        entry('app/deps/x/priv/a.txt', '0', encoder.encode('a')),
        entry('app/_build/dev/lib/x/priv', '2', new Uint8Array(0), '../../../../deps/x/priv'),
        entry('app/b.txt', '1', new Uint8Array(0), 'app/deps/x/priv/a.txt'),
      ),
      root,
    );
    const at = (path: string) =>
      path.split('/').reduce<unknown>((node, part) => (node as Dir).entries.get(part), root);
    const link = at('app/_build/dev/lib/x/priv');
    expect(link).toBeInstanceOf(Symlink);
    expect((link as Symlink).target).toBe('../../../../deps/x/priv');
    expect(at('app/b.txt')).toBeInstanceOf(File);
    expect(at('app/b.txt')).toBe(at('app/deps/x/priv/a.txt'));
  });
});
