// An fs layer (fs format 3, docs/packages.md), as runtime/build.py's
// write_layer makes one: fs/bundles/N.tar (uncompressed USTAR, one
// directory's files in tars of up to BUNDLE bytes) and fs/manifest.json
// (each file's path below the layer's root, its size, mtime and bundle).
// Every header has the same mtime and no owner, so the same files make the
// same bytes.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

// build.py's MTIME (2000-01-01) and BUNDLE.
export const MTIME = 946684800;
const BUNDLE = 512 * 1024;

export interface LayerFile {
  // The path below the layer's root.
  path: string;
  data: Uint8Array;
  executable?: boolean;
}

// The `fs` field of a layer whose files are in `directory` (types.ts
// FsLayer), its paths relative to `directory`.
export interface WrittenLayer {
  format: 3;
  root: string;
  manifest: string;
  bundles: string;
  count: number;
  version: string;
}

const encoder = new TextEncoder();

function field(block: Uint8Array, at: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error(`${value}: too long for a tar header`);
  block.set(bytes, at);
}

const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0';

// A USTAR header: a name longer than 100 bytes is split at a slash into
// the prefix and the name.
function header(name: string, size: number, executable: boolean): Uint8Array {
  let prefix = '';
  if (encoder.encode(name).length > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || encoder.encode(name.slice(cut + 1)).length > 100)
      throw new Error(`${name}: too long for a USTAR name`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  const block = new Uint8Array(512);
  field(block, 0, 100, name);
  field(block, 100, 8, octal(executable ? 0o755 : 0o644, 8));
  field(block, 108, 8, octal(0, 8));
  field(block, 116, 8, octal(0, 8));
  field(block, 124, 12, octal(size, 12));
  field(block, 136, 12, octal(MTIME, 12));
  field(block, 148, 8, '        ');
  field(block, 156, 1, '0');
  field(block, 257, 8, 'ustar\x0000');
  field(block, 329, 8, octal(0, 8));
  field(block, 337, 8, octal(0, 8));
  field(block, 345, 155, prefix);
  const sum = block.reduce((total, byte) => total + byte, 0);
  field(block, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return block;
}

function tar(entries: { name: string; file: LayerFile }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const { name, file } of entries) {
    parts.push(header(name, file.data.length, !!file.executable), file.data);
    const pad = (512 - (file.data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// A digest of the files' paths and bytes (build.py layer_version).
export function layerVersion(files: LayerFile[]): string {
  const hashed = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hashed.update(file.path + '\0');
    hashed.update(createHash('sha256').update(file.data).digest());
  }
  return hashed.digest('hex').slice(0, 16);
}

// The layer of `files` below `root` in the nodes' tree, written into
// `directory` (fs/), and its fs field.
export function writeLayer(directory: string, files: LayerFile[], root: string): WrittenLayer {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  const groups: { dir: string; size: number; files: LayerFile[] }[] = [];
  for (const file of sorted) {
    const dir = posix.dirname(file.path);
    let group = groups[groups.length - 1];
    if (!group || group.dir !== dir || group.size + file.data.length > BUNDLE) {
      group = { dir, size: 0, files: [] };
      groups.push(group);
    }
    group.size += file.data.length;
    group.files.push(file);
  }
  const top = root.replace(/^\/+|\/+$/g, '');
  mkdirSync(join(directory, 'fs', 'bundles'), { recursive: true });
  const manifest: [string, number, number, number][] = [];
  groups.forEach((group, number) => {
    writeFileSync(
      join(directory, 'fs', 'bundles', `${number}.tar`),
      tar(group.files.map((file) => ({ name: `${top}/${file.path}`, file }))),
    );
    for (const file of group.files) manifest.push([file.path, file.data.length, MTIME, number]);
  });
  writeFileSync(join(directory, 'fs', 'manifest.json'), JSON.stringify(manifest));
  return {
    format: 3,
    root,
    manifest: 'fs/manifest.json',
    bundles: 'fs/bundles/',
    count: groups.length,
    version: layerVersion(files),
  };
}
