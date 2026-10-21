// Bun's globals, as far as Claude Code's JavaScript uses them (Bun's own
// build of it, which programs/claude/claude.ts reads out of its executable): a
// process started with `bun` (that program's) has them; others are
// Node's, without. What has no stand-in is missing, as it is under Node,
// which Claude Code checks for where it can do without (Bun.Terminal,
// Bun.serve, bun:ffi).
//
// globalThis.__bunRequire(require) makes a module's require Bun's (the
// bundle's, programs/claude/claude.ts, for import.meta.require): a text file's
// contents for a file required by its relative path.
import { sha256 } from '@noble/hashes/sha2.js';
import { cellSegmenter } from './cellsegmenter';
import { isDeepStrictEqual } from '../util';

type Require = ((id: string) => unknown) & { resolve(id: string): string; cache: unknown };

const TEXT = /^\.\.?\/.*\.(txt|md|html|css|sh|py|svg)$/;

interface Deps {
  readFile(path: string): string;
  crc32(data: Uint8Array): number;
  // A command's path on PATH, or null.
  which(command: string): string | null;
  stdin(): ReadableStream<Uint8Array>;
}

const bytes = (data: unknown): Uint8Array =>
  typeof data === 'string'
    ? new TextEncoder().encode(data)
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data as ArrayBuffer);

// Bun's hash is wyhash, a 64-bit number; what Claude Code keys by it
// takes any stable one.
const hash64 = (data: unknown): bigint =>
  new DataView(sha256(bytes(data)).buffer).getBigUint64(0, true);

export async function installBun(deps: Deps): Promise<void> {
  // Their packages load only for such a process.
  const [
    { default: stringWidth },
    { default: wrapAnsi },
    { default: sliceAnsi },
    { default: stripAnsi },
    YAML,
    TOML,
    { compare, satisfies },
  ] = await Promise.all([
    import('string-width'),
    import('wrap-ansi'),
    import('slice-ansi'),
    import('strip-ansi'),
    import('yaml'),
    import('smol-toml'),
    import('semver'),
  ]);
  const hash = Object.assign(hash64, {
    crc32: (data: unknown) => deps.crc32(bytes(data)),
    xxHash64: hash64,
    wyhash: hash64,
  });
  const zstd = () => {
    throw new Error('Bun.zstdDecompress: not in the playground');
  };
  Object.assign(globalThis, {
    Bun: {
      version: '1.3.0',
      isStandaloneExecutable: false,
      hash,
      SHA256: { hash: (data: unknown) => sha256(bytes(data)) },
      stringWidth: (text: string, options?: object) => stringWidth(text, options),
      wrapAnsi: (text: string, columns: number, options?: object) =>
        wrapAnsi(text, columns, options),
      sliceAnsi: (text: string, start = 0, end?: number) => sliceAnsi(text, start, end),
      stripANSI: (text: string) => stripAnsi(text),
      deepEquals: (a: unknown, b: unknown) => isDeepStrictEqual(a, b),
      semver: {
        order: (a: string, b: string) => compare(a, b),
        satisfies: (version: string, range: string) => satisfies(version, range),
      },
      YAML: {
        parse: (text: string) => YAML.parse(text),
        stringify: (v: unknown) => YAML.stringify(v),
      },
      TOML: { parse: (text: string) => TOML.parse(text) },
      which: (command: string) => deps.which(command),
      sleepSync: (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
      gc: () => {},
      // The bundle's assets are decompressed when they are read out
      // (bungraph.ts), so nothing compressed reaches these.
      zstdDecompressSync: zstd,
      zstdDecompress: zstd,
      stdin: { stream: () => deps.stdin() },
      unsafe: { setJITPolicy: () => {} },
      // The Bun Anthropic builds Claude Code with: its terminal renderer's
      // cells (the rest of it, which Claude Code can do without, missing).
      ant: { CellSegmenter: cellSegmenter(stringWidth) },
    },
    __bunRequire: (require: Require) =>
      Object.assign(
        (id: string) => (TEXT.test(id) ? deps.readFile(require.resolve(id)) : require(id)),
        { resolve: require.resolve, cache: require.cache },
      ),
  });
  // A library that sees XMLHttpRequest takes itself to be in a browser
  // (axios would, and so be held to CORS where Node's https has the
  // gateway): Node has none.
  delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
}
