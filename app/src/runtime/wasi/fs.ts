// The node's in-memory filesystem: directories, files, symbolic links and
// devices under one root, files listed now and fetched when opened, and
// the tars boot images and bundles come in.
import { E, FILETYPE } from './abi';

let inodes = 1;
export const now = () => BigInt(Date.now()) * 1000000n;

// A file; `written` once the node has written it (node.ts's SNAPSHOT).
export class File {
  declare ino: bigint;
  declare data: Uint8Array;
  declare size: number;
  declare mtime: bigint;
  // Mounted: where its bytes are fetched from, until they are.
  declare source?: string | null;
  declare bundle?: number;
  declare written?: boolean;

  constructor(data: Uint8Array = new Uint8Array(0)) {
    this.ino = BigInt(inodes++);
    this.data = data;
    this.size = data.length;
    this.mtime = now();
  }
  // Room for `size` bytes, keeping what is there.
  reserve(size: number): void {
    if (size > this.data.length) {
      const grown = new Uint8Array(Math.max(size, this.data.length * 2, 4096));
      grown.set(this.data.subarray(0, this.size));
      this.data = grown;
    }
  }
  truncate(size: number): void {
    this.reserve(size);
    if (size > this.size) this.data.fill(0, this.size, size);
    this.size = size;
    this.mtime = now();
  }
  get bytes(): Uint8Array {
    return this.data.subarray(0, this.size);
  }
}

// Files that are only listed (a site's fs/manifest.json): `size` bytes,
// fetched by WASI's fetch(source, bundle) when first opened; `bundle`
// names the tar in the site's fs/bundles/ that holds the file. mtime:
// seconds since the epoch (Mix compares sources and manifests).
// A host's own files (node.ts MOUNT) have no mtime or bundle.
export type Manifest = [path: string, size: number, mtime?: number, bundle?: number][];
export type Fetch = (source: string, bundle: number) => Uint8Array;

export function mount(manifest: Manifest, root: Dir): void {
  for (const [path, size, mtime, bundle] of manifest) {
    const file = root.put(path, new File());
    file.size = size;
    file.source = path;
    file.bundle = bundle;
    if (mtime) file.mtime = BigInt(mtime) * 1000000000n;
  }
}

// A mounted file's bytes, fetched once (any node: only a mounted file
// has a source).
export function load(node: Partial<File>, fetch: Fetch): void {
  if (node.source) {
    node.data = fetch(node.source, node.bundle!);
    node.size = node.data.length;
    node.source = null;
  }
}

// fetch(source, bundle) over bundles: get(bundle) is the bundle's tar,
// synchronously. Each bundle is fetched once; its other files wait in
// memory until they are opened.
// A bundle from the site, synchronously (a worker's node waits for its
// files). The network may fail now and then: three more tries, 0.5, 1 and
// 2 s apart, before the file is an I/O error.
export function fetchBundle(url: URL): Uint8Array {
  for (let tries = 0; ; tries++) {
    let status = 0;
    try {
      const request = new XMLHttpRequest();
      request.open('GET', url, false);
      request.responseType = 'arraybuffer';
      request.send();
      status = request.status;
      if (status === 200) return new Uint8Array(request.response);
    } catch {
      // A network error: as a failed status.
    }
    if (tries === 3 || (status >= 400 && status < 500))
      throw new Error(`${url.pathname}: ${status || 'network error'}`);
    pause(500 * 2 ** tries);
  }
}

// Waiting in a worker, which may block.
function pause(ms: number): void {
  if (typeof SharedArrayBuffer !== 'undefined')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function bundled(get: (bundle: number) => Uint8Array): Fetch {
  const waiting = new Map<string, Uint8Array>();
  const loaded = new Set<number>();
  return (source, bundle) => {
    if (!waiting.has(source) && !loaded.has(bundle)) {
      // Loaded once it came: a bundle that did not is asked for again by
      // the next file in it.
      const tar = get(bundle);
      loaded.add(bundle);
      for (const { name, type, body } of entries(tar)) {
        if (type === '0') waiting.set(name, body);
      }
    }
    const bytes = waiting.get(source);
    if (!bytes) throw new Error(`${source}: not in bundle ${bundle}`);
    waiting.delete(source);
    return bytes;
  };
}

// What a tree holds.
export type FsNode = File | Dir | Symlink | Device;

export class Dir {
  declare ino: bigint;
  declare entries: Map<string, FsNode>;
  declare mtime: bigint;
  declare parent?: Dir;

  constructor() {
    this.ino = BigInt(inodes++);
    this.entries = new Map();
    this.mtime = now();
  }
  // The directory at a slash-separated path from this one, made as needed.
  // Symbolic links on the way are followed, and what a dangling one names
  // is made too: kept changes are laid back in path order, so a link can
  // come before its target, and older kept files were recorded by the path
  // written through one.
  mkdirs(path: string, hops = 0): Dir {
    // oxlint-disable-next-line typescript/no-this-alias -- the walk starts here.
    let dir: Dir = this;
    for (const name of path.split('/').filter((p) => p && p !== '.')) {
      if (name === '..') {
        dir = dir.parent || dir;
        continue;
      }
      let next = dir.entries.get(name);
      if (next instanceof Symlink) {
        if (hops >= 40) throw new Error(`${path}: too many symbolic links`);
        let top = dir;
        while (top.parent) top = top.parent;
        next = (next.target.startsWith('/') ? top : dir).mkdirs(next.target, hops + 1);
      } else if (next && !(next instanceof Dir)) {
        throw new Error(`${path}: ${name} names no directory`);
      }
      if (!next) {
        next = new Dir();
        next.parent = dir;
        dir.entries.set(name, next);
      }
      dir = next as Dir;
    }
    return dir;
  }
  put<T extends FsNode>(path: string, node: T): T {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop()!;
    const dir = this.mkdirs(parts.join('/'));
    if (node instanceof Dir) node.parent = dir;
    dir.entries.set(name, node);
    return node;
  }
}

// A symbolic link: its target, a path read when a lookup passes it
// (relative to the link's directory).
export class Symlink {
  declare ino: bigint;
  declare target: string;
  declare mtime: bigint;

  constructor(target: string) {
    this.ino = BigInt(inodes++);
    this.target = target;
    this.mtime = now();
  }
  get size(): number {
    return new TextEncoder().encode(this.target).length;
  }
}

// The node at `path` from directory `start` (from `root` when absolute):
// { node, parent, name }, or { error, parent?, name? } with where it would
// go. Symbolic links met on the way are followed, a last one only when
// `follow`; `..` is the physical parent, as POSIX resolves it.
export type Found =
  | { node: FsNode; parent?: Dir; name?: string; error?: undefined }
  | { node?: undefined; error: number; parent?: Dir; name?: string };

export function lookup(root: Dir, start: Dir, path: string, follow = true, hops = 0): Found {
  let dir: FsNode = path.startsWith('/') ? root : start;
  const parts = path.split('/').filter((p) => p && p !== '.');
  for (let i = 0; i < parts.length; i++) {
    if (!(dir instanceof Dir)) return { error: E.NOTDIR };
    const part = parts[i];
    const last = i === parts.length - 1;
    if (part === '..') {
      dir = dir.parent || dir;
      if (last) return { node: dir };
      continue;
    }
    const node = dir.entries.get(part);
    if (node instanceof Symlink && (!last || follow)) {
      if (hops >= 40) return { error: E.LOOP };
      const found = lookup(root, dir, node.target, true, hops + 1);
      // The last one: what it names, or where that would go (a file
      // created through a dangling link is made at its target).
      if (last) return found;
      if (!found.node) return { error: found.error };
      dir = found.node;
      continue;
    }
    if (last)
      return node ? { node, parent: dir, name: part } : { error: E.NOENT, parent: dir, name: part };
    if (!node) return { error: E.NOENT };
    dir = node;
  }
  return { node: dir };
}

// A file whose reads are made as they happen (/dev/urandom, /dev/null);
// what is written to it is dropped.
export class Device {
  declare ino: bigint;
  declare read: (count: number) => Uint8Array;
  declare size: number;
  declare mtime: bigint;

  constructor(read: (count: number) => Uint8Array) {
    this.ino = BigInt(inodes++);
    this.read = read;
    this.size = 0;
    this.mtime = now();
  }
}
export const urandom = () =>
  new Device((count) => {
    const bytes = new Uint8Array(count);
    for (let at = 0; at < count; at += 65536)
      crypto.getRandomValues(bytes.subarray(at, at + 65536));
    return bytes;
  });

export const devnull = () => new Device(() => new Uint8Array(0));

// The entries of a tar (ustar, as Python's tarfile writes it): name,
// type ('0' file, '5' directory), body and mtime (ns).
export interface TarEntry {
  name: string;
  type: string;
  body: Uint8Array;
  mtime: bigint;
  // What a link ('1' hard, '2' symbolic) names.
  link: string;
}

export function* entries(tar: Uint8Array): Generator<TarEntry> {
  const text = (from: number, length: number) => {
    let end = from;
    while (end < from + length && tar[end] !== 0) end++;
    return new TextDecoder().decode(tar.subarray(from, end));
  };
  // A GNU long name ('L') or a pax header's path ('x', as npm's tarballs
  // have them): the next entry's name; a GNU long link name ('K') or a pax
  // linkpath, its link's. A global pax header ('g') says nothing a file
  // needs.
  let longName: string | null = null;
  let longLink: string | null = null;
  for (let at = 0; at + 512 <= tar.length;) {
    if (tar[at] === 0) break;
    let name = text(at, 100);
    const prefix = text(at + 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    if (longName !== null) {
      name = longName;
      longName = null;
    }
    const size = parseInt(text(at + 124, 12).trim() || '0', 8);
    const mtime = BigInt(parseInt(text(at + 136, 12).trim() || '0', 8)) * 1000000000n;
    const type = String.fromCharCode(tar[at + 156] || 48);
    let link = text(at + 157, 100);
    if (longLink !== null && type !== 'K' && type !== 'L' && type !== 'x') {
      link = longLink;
      longLink = null;
    }
    const body = at + 512;
    if (type === 'L') longName = text(body, size);
    else if (type === 'K') longLink = text(body, size);
    else if (type === 'x') {
      const records = tar.subarray(body, body + size);
      longName = paxRecord(records, 'path');
      longLink = paxRecord(records, 'linkpath');
    } else if (type !== 'g') yield { name, type, body: tar.slice(body, body + size), mtime, link };
    at = body + Math.ceil(size / 512) * 512;
  }
}

// A pax header's record `key` ("LENGTH key=VALUE\n", LENGTH in bytes), or
// null.
function paxRecord(records: Uint8Array, key: string): string | null {
  const decoder = new TextDecoder();
  for (let at = 0; at < records.length;) {
    const space = records.indexOf(32, at);
    if (space < 0) break;
    const length = parseInt(decoder.decode(records.subarray(at, space)), 10);
    if (!(length > 0)) break;
    const record = decoder.decode(records.subarray(space + 1, at + length - 1));
    if (record.startsWith(`${key}=`)) return record.slice(key.length + 1);
    at += length;
  }
  return null;
}

// A gzipped tar into `root`: the number of files.
// keep(name): whether a file or directory belongs in `root`.
export async function untar(
  gzipped: Uint8Array<ArrayBuffer>,
  root: Dir,
  keep: (name: string) => boolean = () => true,
): Promise<number> {
  return untarInto(await gunzip(gzipped), root, keep);
}

export async function gunzip(gzipped: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([gzipped]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A tar (gunzipped) into `root`, as untar; its files are copies of their
// bytes, so the tar is not kept.
export function untarInto(
  tar: Uint8Array,
  root: Dir,
  keep: (name: string) => boolean = () => true,
): number {
  let count = 0;
  for (const { name, type, body, mtime, link } of entries(tar)) {
    if (!keep(name)) continue;
    if (type === '5') root.mkdirs(name);
    else if (type === '0') {
      root.put(name, new File(body)).mtime = mtime;
      count++;
    } else if (type === '2') root.put(name, new Symlink(link)).mtime = mtime;
    else if (type === '1') {
      // A hard link: the same file under a second name (an earlier entry's).
      const [, ...parts] = `/${link}`.split('/');
      let node: FsNode | undefined = root;
      for (const part of parts.filter(Boolean))
        node = node instanceof Dir ? node.entries.get(part) : undefined;
      if (node instanceof File) root.put(name, node);
    }
  }
  return count;
}

// A node's WASI file type, and a shared node's by files.js's name for it.
export function fileType(node: object): number {
  return node instanceof Dir
    ? FILETYPE.DIR
    : node instanceof Symlink
      ? FILETYPE.SYMLINK
      : FILETYPE.REG;
}
