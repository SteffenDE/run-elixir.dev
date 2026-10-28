// The JavaScript a Bun-compiled executable carries (bun build --compile):
// its module graph, appended to the binary and ended by a trailer, read
// out as files that the playground's Node runs (programs/claude/claude.ts).
//
// The graph's layout is Bun's own (StandaloneModuleGraph.zig), not
// documented, and changes between Bun's versions: the reader checks what
// it finds, so a binary built differently fails here, saying so, rather
// than giving files that are not its modules.
//
//   [... the modules' bytes, their names, the list ...][Offsets][trailer]
//   Offsets: byte_count u64, modules (offset u32, length u32),
//            entry_point_id u32, compile_exec_argv (offset, length), flags u32
//   a module: 10 u32s (name, contents, sourcemap, bytecode, module info:
//             offset and length each), 8 more bytes, then encoding u8
//             (latin1 1, utf-8 2, binary 0), loader u8 (Bun's Loader: js 1,
//             jsx 0, ts 2, tsx 3; file 5, napi 10, text 13), format, side.
import { decompress } from 'fzstd';

const TRAILER = new TextEncoder().encode('\n---- Bun! ----\n');
const OFFSETS = 32;
const RECORD = 52;
const ROOT = '/$bunfs/root/';
const ZSTD = [0x28, 0xb5, 0x2f, 0xfd];
// Bun's loaders: its modules' (jsx, js, ts, tsx), and native addons'.
const SCRIPTS = new Set([0, 1, 2, 3]);
const NAPI = 10;

// A file of the graph: its path below the graph's root (`cli`, the
// entry, as `cli.js`).
export type { GraphFile } from '@elixir-playground/runtime/programs/claude/protocol';
import type { GraphFile } from '@elixir-playground/runtime/programs/claude/protocol';

function lastIndexOf(bytes: Uint8Array, needle: Uint8Array): number {
  outer: for (let at = bytes.length - needle.length; at >= 0; at--) {
    for (let i = 0; i < needle.length; i++) if (bytes[at + i] !== needle[i]) continue outer;
    return at;
  }
  return -1;
}

// The modules, as Bun keeps them: name, bytes, encoding; and the entry's
// index.
export function readGraph(binary: Uint8Array): {
  modules: { name: string; contents: Uint8Array; encoding: number; loader: number }[];
  entry: number;
} {
  const fail = (why: string): never => {
    throw new Error(`not a Bun executable this playground can read: ${why}`);
  };
  // The trailer is at the end, or a little before (a signature after it).
  const tail = binary.subarray(Math.max(0, binary.length - (1 << 20)));
  const found = lastIndexOf(tail, TRAILER);
  if (found < 0) fail('no module graph');
  const trailer = binary.length - tail.length + found;
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const offsets = trailer - OFFSETS;
  const byteCount = Number(view.getBigUint64(offsets, true));
  const modulesAt = view.getUint32(offsets + 8, true);
  const modulesLength = view.getUint32(offsets + 12, true);
  const entry = view.getUint32(offsets + 16, true);
  const start = offsets - byteCount;
  if (start < 0 || modulesAt + modulesLength > byteCount) fail('its offsets are out of range');
  if (modulesLength % RECORD) fail(`its module list is not of ${RECORD}-byte records`);
  const blob = binary.subarray(start, offsets);
  const at = (offset: number, length: number) => {
    if (offset + length > blob.length) fail('a module is out of range');
    return blob.subarray(offset, offset + length);
  };
  const blobView = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const latin1 = new TextDecoder('latin1');
  const modules = [];
  for (let record = modulesAt; record < modulesAt + modulesLength; record += RECORD) {
    const word = (i: number) => blobView.getUint32(record + 4 * i, true);
    const name = latin1.decode(at(word(0), word(1)));
    if (!name.startsWith(ROOT)) fail(`a module named ${JSON.stringify(name.slice(0, 40))}`);
    modules.push({
      name: name.slice(ROOT.length),
      contents: at(word(2), word(3)),
      encoding: blob[record + 48],
      loader: blob[record + 49],
    });
  }
  if (entry >= modules.length) fail('no entry point');
  return { modules, entry };
}

// The graph for Node: its modules' sources (the entry as cli.js), whose
// imports of each other are relative, with Bun's import.meta.require and
// import.meta.dir as Node has them (require: a CommonJS module's, which
// programs/claude/claude.ts compiles them to); its assets,
// zstd-compressed ones decompressed (what reads them takes either); native
// addons left out.
export function graphParts(binary: Uint8Array): {
  modules: Map<string, string>;
  assets: GraphFile[];
} {
  const { modules, entry } = readGraph(binary);
  const decoders: Record<number, TextDecoder> = {
    1: new TextDecoder('latin1'),
    2: new TextDecoder('utf-8'),
  };
  const sources = new Map<string, string>();
  const assets: GraphFile[] = [];
  modules.forEach(({ name, contents, encoding, loader }, index) => {
    if (loader === NAPI) return;
    // A module (an asset named .js, such as a library a page loads, is a
    // file).
    if (!SCRIPTS.has(loader)) {
      const zstd = ZSTD.every((byte, i) => contents[i] === byte);
      assets.push({ name, data: zstd ? decompress(contents) : contents.slice() });
      return;
    }
    const source = (decoders[encoding] ?? decoders[1]).decode(contents);
    sources.set(
      index === entry ? 'cli.js' : name,
      source
        .replaceAll(`"${ROOT}`, `"${relativeRoot(name)}`)
        .replaceAll('import.meta.require', 'require')
        .replace(/import\.meta\.dir\b(?!name)/g, 'import.meta.dirname'),
    );
  });
  return { modules: sources, assets };
}

// The graph's root, relative to a module's directory.
function relativeRoot(name: string): string {
  const depth = name.split('/').length - 1;
  return depth ? '../'.repeat(depth) : './';
}
