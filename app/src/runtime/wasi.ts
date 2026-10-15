// WASI preview 1 for rotp.wasm, over an in-memory filesystem: the imports
// Rust std (wasm32-wasip1) makes, for a Web Worker and for Node alike.
// One preopen, "/", holds everything; there are no links or owners.
// Standard input is a callback that answers bytes, null when none is
// waiting (EAGAIN: the node polls again) or an empty array at its end.

import { Nifs } from './nif';

// WASI preview 1's integers: i32 (unsigned, see `unsigned`) and i64.
type I32 = number;
type I64 = bigint;
// An import as the instance calls it.
export type Syscall = (...args: (number | bigint)[]) => number;
export type Imports = { wasi_snapshot_preview1: Record<string, Syscall> };

const E = {
  SUCCESS: 0,
  ACCES: 2,
  ADDRINUSE: 3,
  AGAIN: 6,
  CONNREFUSED: 14,
  BADF: 8,
  EXIST: 20,
  INVAL: 28,
  IO: 29,
  ISDIR: 31,
  LOOP: 32,
  NOENT: 44,
  NOSYS: 52,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTSUP: 58,
  PERM: 63,
  SPIPE: 70,
};
const FILETYPE = { CHAR: 2, DIR: 3, REG: 4, SYMLINK: 7 };
// path_open's and path_filestat_get's dirflags: follow a last symbolic link.
const LOOKUP_SYMLINKS = 1;
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const FDFLAGS = { APPEND: 1 };

// WebAssembly passes an i32 to JavaScript signed, so a pointer into a
// memory past 2 GiB arrives negative. Every i32 of WASI preview 1 is
// unsigned (fds, flags, pointers, lengths): take them as such.
const unsigned = (functions: object): Record<string, Syscall> =>
  Object.fromEntries(
    Object.entries(functions as Record<string, Syscall>).map(([name, f]) => [
      name,
      (...args: (number | bigint)[]) =>
        f(...args.map((a) => (typeof a === 'number' ? a >>> 0 : a))),
    ]),
  );

export class Exit extends Error {
  declare code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

let inodes = 1;
const now = () => BigInt(Date.now()) * 1000000n;

// A file; `written` once the node has written it (node.mjs's SNAPSHOT).
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
export type Manifest = [path: string, size: number, mtime: number, bundle: number][];
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
export function bundled(get: (bundle: number) => Uint8Array): Fetch {
  const waiting = new Map<string, Uint8Array>();
  const loaded = new Set<number>();
  return (source, bundle) => {
    if (!waiting.has(source) && !loaded.has(bundle)) {
      loaded.add(bundle);
      for (const { name, type, body } of entries(get(bundle))) {
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

// A file whose reads are made as they happen (/dev/urandom).
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

// One end of a connection, as the node sees it: what the peer sent
// (inbox), whether the peer has ended, and how to reach the peer.
interface Peer {
  send(bytes: Uint8Array): void;
  end(): void;
  close(): void;
}

class Endpoint {
  declare inbox: Uint8Array[];
  declare eof: boolean;
  declare peer: Peer;

  constructor(peer: Peer) {
    this.inbox = [];
    this.eof = false;
    this.peer = peer; // { send(bytes), end(), close() }
  }
  take(max: number): Uint8Array {
    const out = new Uint8Array(
      Math.min(
        max,
        this.inbox.reduce((n, c) => n + c.length, 0),
      ),
    );
    let at = 0;
    while (at < out.length) {
      const chunk = this.inbox[0];
      const part = chunk.subarray(0, out.length - at);
      out.set(part, at);
      at += part.length;
      if (part.length === chunk.length) this.inbox.shift();
      else this.inbox[0] = chunk.subarray(part.length);
    }
    return out;
  }
}

// Ephemeral ports (49152-65535), as an OS hands them out: one sequence for
// every node this worker runs, from a random start, so that a node does
// not get the port an earlier one had (Mix's lock files name the port of
// their holder, and a node that finds its own port there waits on itself).
let ephemeralPort = 49152 + Math.floor(Math.random() * 16384);
function nextEphemeral(): number {
  const port = ephemeralPort;
  ephemeralPort = ephemeralPort >= 65535 ? 49152 : ephemeralPort + 1;
  return port;
}

// TCP for the node (crates/rotp/src/host/wasm_net.rs): listeners and
// connections inside it, and connections to and from the page (`remote`:
// remote.open(id, port) for a connection the node makes to a port in
// remote.ports; send/end/close by id; listening(port, bool) as the node
// starts and stops listening). Ids the node makes are even; the
// page's are odd.
export interface Remote {
  ports: number[];
  https?: boolean;
  open(id: number, port: number, host?: string): void;
  send(id: number, bytes: Uint8Array): void;
  end(id: number): void;
  close(id: number): void;
  listening?(port: number, on: boolean, ephemeral?: boolean): void;
}

// A connection waiting on a listener: its id and the peer's address.
interface Waiting {
  id: number;
  ip: string;
  port: number;
}

export class Network {
  declare remote: Remote;
  declare listeners: Map<number, Waiting[]>;
  declare waiting: Map<number, Endpoint>;
  declare endpoints: Map<number, Endpoint>;
  declare next: number;

  constructor(remote: Remote = { ports: [], open() {}, send() {}, end() {}, close() {} }) {
    this.remote = remote;
    this.listeners = new Map(); // port -> [{ id, ip, port }]
    this.waiting = new Map(); // id -> Endpoint, until accepted
    this.endpoints = new Map(); // id -> Endpoint, for the page's
    this.next = 2;
  }
  // A listener's queue, on `port` or (0) a free one: { queue, port }.
  // listening(port, true, ephemeral): ephemeral when the port was given,
  // not asked for (Mix's lock listens so; a web server names its port).
  listen(port: number): { queue: Waiting[]; port: number } | null {
    const ephemeral = port === 0;
    if (ephemeral)
      do port = nextEphemeral();
      while (this.listeners.has(port));
    if (this.listeners.has(port)) return null;
    const queue: Waiting[] = [];
    this.listeners.set(port, queue);
    this.remote.listening?.(port, true, ephemeral);
    return { queue, port };
  }
  // A connection to the node's listener on `port` from the page.
  accepted(id: number, port: number): boolean {
    const queue = this.listeners.get(port);
    if (!queue) return false;
    const r = this.remote;
    const endpoint = new Endpoint({
      send: (bytes) => r.send(id, bytes),
      end: () => r.end(id),
      close: () => {
        this.endpoints.delete(id);
        r.close(id);
      },
    });
    this.endpoints.set(id, endpoint);
    this.waiting.set(id, endpoint);
    queue.push({ id, ip: '127.0.0.1', port: nextEphemeral() });
    return true;
  }
  // The node connects: to itself, or to the page.
  connect(port: number): Endpoint | null {
    const queue = this.listeners.get(port);
    if (queue) {
      const id = (this.next += 2);
      let mine: Endpoint;
      const theirs = new Endpoint({
        send: (bytes) => mine.inbox.push(bytes),
        end: () => {
          mine.eof = true;
        },
        close: () => {
          mine.eof = true;
        },
      });
      mine = new Endpoint({
        send: (bytes) => theirs.inbox.push(bytes),
        end: () => {
          theirs.eof = true;
        },
        close: () => {
          theirs.eof = true;
        },
      });
      this.waiting.set(id, theirs);
      queue.push({ id, ip: '127.0.0.1', port: nextEphemeral() });
      return mine;
    }
    if (!this.remote.ports.includes(port)) return null;
    const id = (this.next += 2);
    const r = this.remote;
    const endpoint = new Endpoint({
      send: (bytes) => r.send(id, bytes),
      end: () => r.end(id),
      close: () => {
        this.endpoints.delete(id);
        r.close(id);
      },
    });
    this.endpoints.set(id, endpoint);
    r.open(id, port);
    return endpoint;
  }
  // HTTPS to `host` the page carries (/.net/https/NAME/PORT): a connection
  // to the page, if it offers it (remote.https).
  https(host: string, port: number): Endpoint | null {
    if (!this.remote.https) return null;
    const id = (this.next += 2);
    const r = this.remote;
    const endpoint = new Endpoint({
      send: (bytes) => r.send(id, bytes),
      end: () => r.end(id),
      close: () => {
        this.endpoints.delete(id);
        r.close(id);
      },
    });
    this.endpoints.set(id, endpoint);
    r.open(id, port, host);
    return endpoint;
  }
  // From the page: data for, or the end of, connection `id`.
  data(id: number, bytes: Uint8Array): void {
    this.endpoints.get(id)?.inbox.push(bytes);
  }
  ended(id: number): void {
    const endpoint = this.endpoints.get(id);
    if (endpoint) endpoint.eof = true;
  }
}

// A program the host runs for the node (crates/rotp/src/host/wasm_proc.rs):
// what it wrote, whether its output has ended, its exit status, and its
// input.
export class Process {
  declare output: Uint8Array[];
  declare ended: boolean;
  declare status: number | null;
  declare input: Uint8Array[];
  declare closed: boolean;
  // The node closed its port.
  declare onclose?: () => void;

  constructor() {
    this.output = [];
    this.ended = false;
    this.status = null;
    this.input = [];
    this.closed = false;
  }
  write(bytes: string | Uint8Array): void {
    this.output.push(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  }
  exit(status: number): void {
    this.ended = true;
    this.status = status;
  }
}

// The entries of a tar (ustar, as Python's tarfile writes it): name,
// type ('0' file, '5' directory), body and mtime (ns).
export interface TarEntry {
  name: string;
  type: string;
  body: Uint8Array;
  mtime: bigint;
}

export function* entries(tar: Uint8Array): Generator<TarEntry> {
  const text = (from: number, length: number) => {
    let end = from;
    while (end < from + length && tar[end] !== 0) end++;
    return new TextDecoder().decode(tar.subarray(from, end));
  };
  let longName: string | null = null;
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
    const body = at + 512;
    if (type === 'L') longName = text(body, size);
    else yield { name, type, body: tar.slice(body, body + size), mtime };
    at = body + Math.ceil(size / 512) * 512;
  }
}

// A gzipped tar into `root`: the number of files.
// keep(name): whether a file or directory belongs in `root`.
export async function untar(
  gzipped: Uint8Array<ArrayBuffer>,
  root: Dir,
  keep: (name: string) => boolean = () => true,
): Promise<number> {
  const stream = new Blob([gzipped]).stream().pipeThrough(new DecompressionStream('gzip'));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  let count = 0;
  for (const { name, type, body, mtime } of entries(tar)) {
    if (!keep(name)) continue;
    if (type === '5') root.mkdirs(name);
    else if (type === '0') {
      root.put(name, new File(body)).mtime = mtime;
      count++;
    }
  }
  return count;
}

// A node's synchronous channel to the shared filesystem (files.js): send a
// request and its bytes, wait for the answer.
// files.js's answer: an errno in `error`, or what the request asked for.
// oxlint-disable-next-line typescript/no-explicit-any -- each op's own.
export type SharedAnswer = { error?: number; [field: string]: any };
export type SharedCall = (
  request: Record<string, unknown>,
  bytes?: Uint8Array,
) => { answer: SharedAnswer; bytes: Uint8Array };
// Paths another worker holds (files.js), and the way to it.
export interface Shared {
  prefixes: string[];
  call: SharedCall;
}

export function sharedClient(doorbell: SharedArrayBuffer, channel: SharedArrayBuffer): SharedCall {
  const bell = new Int32Array(doorbell);
  const control = new Int32Array(channel, 0, 2);
  const data = new Uint8Array(channel, 8);
  const view = new DataView(channel, 8);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return (request, bytes = new Uint8Array(0)) => {
    const header = encoder.encode(JSON.stringify(request));
    view.setUint32(0, header.length, true);
    data.set(header, 4);
    data.set(bytes, 4 + header.length);
    Atomics.store(control, 1, 4 + header.length + bytes.length);
    Atomics.store(control, 0, 1);
    Atomics.add(bell, 0, 1);
    Atomics.notify(bell, 0);
    while (Atomics.load(control, 0) === 1) Atomics.wait(control, 0, 1, 1000);
    const length = view.getUint32(0, true);
    const total = Atomics.load(control, 1);
    const answer = JSON.parse(decoder.decode(data.slice(4, 4 + length)));
    const out = data.slice(4 + length, total);
    Atomics.store(control, 0, 0);
    return { answer, bytes: out };
  };
}

// The most a shared read or write moves at once (the channel's size, less
// room for headers).
const SHARED_CHUNK = 512 * 1024;

// A node's WASI file type, and a shared node's by files.js's name for it.
function fileType(node: object): number {
  return node instanceof Dir
    ? FILETYPE.DIR
    : node instanceof Symlink
      ? FILETYPE.SYMLINK
      : FILETYPE.REG;
}
function sharedType(type: string): number {
  return type === 'dir' ? FILETYPE.DIR : type === 'link' ? FILETYPE.SYMLINK : FILETYPE.REG;
}

// What filestat writes: a node, or the like of one.
type Stat = { ino: bigint; size?: number; mtime: bigint };

// A shared file open in the node (files.js's handle).
interface SharedFile {
  handle: number;
  position: number;
  append: boolean;
  dir: boolean;
  listing: [name: string, type: string, ino: number][] | null;
}

// An open descriptor: a node of the tree, a standard stream, a shared file,
// or one of the host's files (/.proc/spawn, /.tty, /.nif, /.net), by what
// it holds.
interface Descriptor {
  node?: FsNode;
  position?: number;
  append?: boolean;
  preopen?: string;
  path?: string;
  changed?: boolean;
  stream?: boolean;
  remote?: SharedFile;
  spawn?: boolean;
  process?: Process | null;
  terminal?: boolean;
  nif?: string;
  request?: Uint8Array[];
  answer?: Uint8Array | null;
  listener?: Waiting[];
  port?: number;
  endpoint?: Endpoint;
}

// A program the node may spawn (wasm_proc.rs).
export interface ProgramContext {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  root: Dir;
}
export type Program = (process: Process, context: ProgramContext) => void;
// '*': a program for any other name, or none.
export type Programs = Record<string, Program> & { '*'?: (name: string) => Program | undefined };

// The terminal the node may set to raw input (/.tty).
export interface Terminal {
  mode(mode: string): void;
  size(): number[];
}

export interface WasiOptions {
  args: string[];
  env: Record<string, string>;
  root: Dir;
  stdin(max: number): Uint8Array | null;
  stdout(bytes: Uint8Array): void;
  stderr(bytes: Uint8Array): void;
  sleep(ms: number): void;
  tty?: boolean;
  terminal?: Terminal | null;
  network?: Network;
  pump?: () => void;
  fetch: Fetch;
  programs?: Programs;
  onchange?: (path: string) => void;
  shared?: Shared | null;
}

// The calls of WASI preview 1 this shim has, as the instance makes them.
interface Preview1 {
  args_sizes_get(countPtr: I32, sizePtr: I32): number;
  args_get(ptrs: I32, buf: I32): number;
  environ_sizes_get(countPtr: I32, sizePtr: I32): number;
  environ_get(ptrs: I32, buf: I32): number;
  clock_res_get(id: I32, ptr: I32): number;
  clock_time_get(id: I32, precision: I64, ptr: I32): number;
  random_get(ptr: I32, len: I32): number;
  proc_exit(code: I32): never;
  proc_raise(signal: I32): never;
  sched_yield(): number;
  poll_oneoff(inPtr: I32, outPtr: I32, count: I32, eventsPtr: I32): number;
  fd_prestat_get(fd: I32, ptr: I32): number;
  fd_prestat_dir_name(fd: I32, ptr: I32, len: I32): number;
  fd_fdstat_get(fd: I32, ptr: I32): number;
  fd_fdstat_set_flags(fd: I32, flags: I32): number;
  fd_close(fd: I32): number;
  fd_sync(fd: I32): number;
  fd_datasync(fd: I32): number;
  fd_advise(fd: I32, offset: I64, len: I64, advice: I32): number;
  fd_fdstat_set_rights(fd: I32, base: I64, inheriting: I64): number;
  fd_filestat_get(fd: I32, ptr: I32): number;
  fd_filestat_set_size(fd: I32, size: I64): number;
  fd_allocate(fd: I32, offset: I64, length: I64): number;
  fd_filestat_set_times(fd: I32, atim: I64, mtim: I64, flags: I32): number;
  path_filestat_set_times(
    fd: I32,
    flags: I32,
    pathPtr: I32,
    pathLen: I32,
    atim: I64,
    mtim: I64,
    fstflags: I32,
  ): number;
  fd_read(fd: I32, iovs: I32, count: I32, nreadPtr: I32): number;
  fd_write(fd: I32, iovs: I32, count: I32, nwrittenPtr: I32): number;
  fd_pread(fd: I32, iovs: I32, count: I32, offset: I64, nreadPtr: I32): number;
  fd_pwrite(fd: I32, iovs: I32, count: I32, offset: I64, nwrittenPtr: I32): number;
  fd_tell(fd: I32, ptr: I32): number;
  fd_seek(fd: I32, offset: I64, whence: I32, ptr: I32): number;
  fd_readdir(fd: I32, buf: I32, len: I32, cookie: I64, usedPtr: I32): number;
  path_open(
    fd: I32,
    dirflags: I32,
    pathPtr: I32,
    pathLen: I32,
    oflags: I32,
    base: I64,
    inheriting: I64,
    fdflags: I32,
    fdPtr: I32,
  ): number;
  path_filestat_get(fd: I32, flags: I32, pathPtr: I32, pathLen: I32, ptr: I32): number;
  path_create_directory(fd: I32, pathPtr: I32, pathLen: I32): number;
  path_remove_directory(fd: I32, pathPtr: I32, pathLen: I32): number;
  path_unlink_file(fd: I32, pathPtr: I32, pathLen: I32): number;
  path_rename(fd: I32, oldPtr: I32, oldLen: I32, fd2: I32, newPtr: I32, newLen: I32): number;
  path_link(
    fd: I32,
    flags: I32,
    oldPtr: I32,
    oldLen: I32,
    fd2: I32,
    newPtr: I32,
    newLen: I32,
  ): number;
  path_symlink(targetPtr: I32, targetLen: I32, fd: I32, pathPtr: I32, pathLen: I32): number;
  path_readlink(fd: I32, pathPtr: I32, pathLen: I32, buf: I32, bufLen: I32, usedPtr: I32): number;
  sock_accept(fd: I32, flags: I32, fdPtr: I32): number;
  sock_shutdown(fd: I32, how: I32): number;
}
type Local = Omit<Preview1, 'fd_pread' | 'fd_pwrite' | 'fd_tell'>;

export class WASI {
  declare shared: Shared | null;
  declare terminal: Terminal | null;
  declare onchange: (path: string) => void;
  declare fetch: Fetch;
  declare programs: Programs;
  declare tty: boolean;
  declare network: Network;
  declare pump: () => void;
  declare args: string[];
  declare env: string[];
  declare root: Dir;
  declare stdin: (max: number) => Uint8Array | null;
  declare out: Record<number, (bytes: Uint8Array) => void>;
  declare sleep: (ms: number) => void;
  declare fds: Map<number, Descriptor>;
  declare next: number;
  // The memory the calls work on: the node's, or a NIF library's (nif.ts).
  declare memory: WebAssembly.Memory | null;
  declare nifs: Nifs;
  declare imports: Imports;

  // { args, env, root: Dir, stdin(), stdout(bytes), stderr(bytes),
  // sleep(ms), tty }: with tty, the standard streams are terminals.
  // network: a Network; pump(): take in what the page sent, before reads.
  // fetch(source, bundle): a mounted file's bytes, synchronously.
  // programs: { name: (process, { args, cwd, env, root }) => ... }, the
  // programs the node may spawn, by base name; a program writes to and
  // exits its Process.
  // onchange(path): the node created, wrote (reported when the file is
  // closed), renamed or removed what is at the absolute `path`.
  // shared: { prefixes, call }: directories (as /work) another worker
  // holds, reached with call(request, bytes) (sharedClient).
  // terminal: { mode('raw' | 'cooked'), size(): [columns, rows] }, the
  // terminal the node may set to raw input (/.tty, tty.rs).
  constructor({
    args,
    env,
    root,
    stdin,
    stdout,
    stderr,
    sleep,
    tty = false,
    terminal = null,
    network = new Network(),
    pump = () => {},
    fetch,
    programs = {},
    onchange = () => {},
    shared = null,
  }: WasiOptions) {
    this.shared = shared;
    this.terminal = terminal;
    this.onchange = onchange;
    this.fetch = fetch;
    this.programs = programs;
    this.tty = tty;
    this.network = network;
    this.pump = pump;
    this.args = args;
    this.env = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    this.root = root;
    this.stdin = stdin;
    this.out = { 1: stdout, 2: stderr };
    this.sleep = sleep;
    // fd -> { node, position, append, preopen }
    this.fds = new Map<number, Descriptor>([
      [0, { stream: true }],
      [1, { stream: true }],
      [2, { stream: true }],
      [3, { node: root, preopen: '/', path: '' }],
    ]);
    this.next = 4;
    this.memory = null;
    this.nifs = new Nifs(this);
    const functions = this.functions();
    const io = shared ? { ...functions, ...this.remote(functions) } : functions;
    this.imports = { wasi_snapshot_preview1: unsigned({ ...io, ...this.positioned(io) }) };
  }

  start(instance: WebAssembly.Instance): number {
    this.memory = instance.exports.memory as WebAssembly.Memory;
    try {
      // oxlint-disable-next-line no-underscore-dangle -- WASI's name for a program's start.
      (instance.exports._start as () => void)();
      return 0;
    } catch (error) {
      if (error instanceof Exit) return error.code;
      throw error;
    }
  }

  view(): DataView {
    return new DataView(this.memory!.buffer);
  }
  bytes(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.memory!.buffer, ptr, len);
  }
  string(ptr: number, len: number): string {
    // A copy: TextDecoder takes no view of a shared memory (threads.ts).
    return new TextDecoder().decode(this.bytes(ptr, len).slice());
  }

  // The absolute path of `path` below directory fd `fd`.
  absolute(fd: number, path: string): string {
    const base = path.startsWith('/') ? '' : (this.fds.get(fd)?.path ?? '');
    const out: string[] = [];
    for (const part of `${base}/${path}`.split('/')) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return '/' + out.join('/');
  }

  // The node at `path` below directory fd `fd`: { node } or { error },
  // with the parent and last name for creating or removing it. A last
  // symbolic link is followed only when `follow`.
  resolve(fd: number, path: string, follow = false): Found {
    const base = this.fds.get(fd);
    if (!base || !(base.node instanceof Dir)) return { error: E.BADF };
    return lookup(this.root, base.node, path, follow);
  }

  filestat(ptr: number, node: Stat | null | undefined): void {
    const v = this.view();
    const dir = node instanceof Dir;
    v.setBigUint64(ptr, 1n, true);
    v.setBigUint64(ptr + 8, node ? node.ino : 0n, true);
    v.setUint8(ptr + 16, node ? fileType(node) : FILETYPE.CHAR);
    v.setBigUint64(ptr + 24, 1n, true);
    v.setBigUint64(ptr + 32, BigInt(node && !dir ? node.size! : 0), true);
    const time = node ? node.mtime : now();
    v.setBigUint64(ptr + 40, time, true);
    v.setBigUint64(ptr + 48, time, true);
    v.setBigUint64(ptr + 56, time, true);
  }

  iovecs(iovs: number, count: number): [ptr: number, len: number][] {
    const v = this.view();
    const list: [number, number][] = [];
    for (let i = 0; i < count; i++) {
      list.push([v.getUint32(iovs + 8 * i, true), v.getUint32(iovs + 8 * i + 4, true)]);
    }
    return list;
  }

  // A spawn request (wasm_proc.rs): run the program it names.
  spawn(entry: Descriptor, bytes: Uint8Array): number | null {
    const fields = new TextDecoder().decode(bytes.slice()).split('\0');
    const [program, cwd] = fields;
    const argc = Number(fields[2]);
    const args = fields.slice(3, 3 + argc);
    const envc = Number(fields[3 + argc]);
    const env = Object.fromEntries(
      fields.slice(4 + argc, 4 + argc + envc).map((v) => {
        const at = v.indexOf('=');
        return [v.slice(0, at), v.slice(at + 1)];
      }),
    );
    // By base name, or its first part: _build/esbuild-linux-x64 is esbuild.
    const base = program.split('/').pop()!;
    const run =
      this.programs[base] ?? this.programs[base.split('-')[0]] ?? this.programs['*']?.(base);
    if (!run) return E.NOENT;
    const process = new Process();
    entry.process = process;
    try {
      run(process, { args, cwd: cwd || env.PWD || '/', env, root: this.root });
    } catch (error) {
      process.write(`${program}: ${(error as Error).message}\n`);
      process.exit(1);
    }
    return null;
  }

  isShared(path: string): boolean {
    return this.shared!.prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  }

  // A filestat for a shared node (files.js status).
  sharedFilestat(ptr: number, { type, size, ino, mtime }: SharedAnswer): void {
    const v = this.view();
    v.setBigUint64(ptr, 2n, true);
    v.setBigUint64(ptr + 8, BigInt(ino), true);
    v.setUint8(ptr + 16, sharedType(type));
    v.setBigUint64(ptr + 24, 1n, true);
    v.setBigUint64(ptr + 32, BigInt(size), true);
    v.setBigUint64(ptr + 40, BigInt(mtime), true);
    v.setBigUint64(ptr + 48, BigInt(mtime), true);
    v.setBigUint64(ptr + 56, BigInt(mtime), true);
  }

  // Reads and writes at an offset (pread, pwrite) and the position
  // (fd_tell), on top of `io`'s fd_read and fd_write, so local and shared
  // files take them alike: the descriptor's position is set for the call
  // and kept (a write at an offset does not append). Streams, ports and
  // the like have no position (ESPIPE).
  positioned(io: Local): Pick<Preview1, 'fd_pread' | 'fd_pwrite' | 'fd_tell'> {
    // oxlint-disable-next-line typescript/no-this-alias -- the calls' own `this` is not the shim.
    const self = this;
    const holder = (fd: number) => {
      const entry = self.fds.get(fd);
      if (!entry) return E.BADF;
      const file = entry.remote ?? (entry.node instanceof File ? entry : null);
      return file && !entry.nif ? file : E.SPIPE;
    };
    const at = (fd: number, offset: bigint, run: () => number) => {
      const file = holder(fd);
      if (typeof file === 'number') return file;
      const [position, append] = [file.position, file.append];
      Object.assign(file, { position: Number(offset), append: false });
      try {
        return run();
      } finally {
        Object.assign(file, { position, append });
      }
    };
    return {
      fd_pread: (fd, iovs, count, offset, ptr) =>
        at(fd, offset, () => io.fd_read(fd, iovs, count, ptr)),
      fd_pwrite: (fd, iovs, count, offset, ptr) =>
        at(fd, offset, () => io.fd_write(fd, iovs, count, ptr)),
      fd_tell(fd, ptr) {
        const file = holder(fd);
        if (typeof file === 'number') return file;
        self.view().setBigUint64(ptr, BigInt(file.position!), true);
        return E.SUCCESS;
      },
    };
  }

  // The WASI calls on shared paths and their descriptors, in front of the
  // local ones (`local`), which take everything else.
  remote(local: Local): Partial<Local> {
    // oxlint-disable-next-line typescript/no-this-alias -- the calls' own `this` is not the shim.
    const self = this;
    const call: SharedCall = (request, bytes) => self.shared!.call(request, bytes);
    const ask = (request: Record<string, unknown>, bytes?: Uint8Array) =>
      call(request, bytes).answer;
    const path = (fd: number, ptr: number, len: number) => self.absolute(fd, self.string(ptr, len));
    const remoteOf = (fd: number) => self.fds.get(fd)?.remote;
    const simple =
      (op: string, name: 'path_create_directory' | 'path_remove_directory' | 'path_unlink_file') =>
      (fd: number, ptr: number, len: number) => {
        const target = path(fd, ptr, len);
        if (!self.isShared(target)) return local[name](fd, ptr, len);
        return ask({ op, path: target }).error ?? E.SUCCESS;
      };
    return {
      path_open(fd, dirflags, pathPtr, pathLen, oflags, base, inheriting, fdflags, fdPtr) {
        const target = path(fd, pathPtr, pathLen);
        if (!self.isShared(target))
          return local.path_open(
            fd,
            dirflags,
            pathPtr,
            pathLen,
            oflags,
            base,
            inheriting,
            fdflags,
            fdPtr,
          );
        const opened = ask({
          op: 'open',
          path: target,
          oflags,
          follow: !!(dirflags & LOOKUP_SYMLINKS),
        });
        if (opened.error) return opened.error;
        const id = self.next++;
        self.fds.set(id, {
          path: target,
          remote: {
            handle: opened.handle,
            position: 0,
            append: !!(fdflags & FDFLAGS.APPEND),
            dir: opened.type === 'dir',
            listing: null,
          },
        });
        self.view().setUint32(fdPtr, id, true);
        return E.SUCCESS;
      },
      path_filestat_get(fd, flags, pathPtr, pathLen, ptr) {
        const target = path(fd, pathPtr, pathLen);
        if (!self.isShared(target))
          return local.path_filestat_get(fd, flags, pathPtr, pathLen, ptr);
        const status = ask({ op: 'stat', path: target, follow: !!(flags & LOOKUP_SYMLINKS) });
        if (status.error) return status.error;
        self.sharedFilestat(ptr, status);
        return E.SUCCESS;
      },
      path_symlink(targetPtr, targetLen, fd, pathPtr, pathLen) {
        const at = path(fd, pathPtr, pathLen);
        if (!self.isShared(at))
          return local.path_symlink(targetPtr, targetLen, fd, pathPtr, pathLen);
        return (
          ask({ op: 'symlink', path: at, target: self.string(targetPtr, targetLen) }).error ??
          E.SUCCESS
        );
      },
      path_readlink(fd, pathPtr, pathLen, buf, bufLen, usedPtr) {
        const at = path(fd, pathPtr, pathLen);
        if (!self.isShared(at))
          return local.path_readlink(fd, pathPtr, pathLen, buf, bufLen, usedPtr);
        const answer = ask({ op: 'readlink', path: at });
        if (answer.error) return answer.error;
        const target = new TextEncoder().encode(answer.target).subarray(0, bufLen);
        self.bytes(buf, target.length).set(target);
        self.view().setUint32(usedPtr, target.length, true);
        return E.SUCCESS;
      },
      path_create_directory: simple('mkdir', 'path_create_directory'),
      path_remove_directory: simple('rmdir', 'path_remove_directory'),
      path_unlink_file: simple('unlink', 'path_unlink_file'),
      path_rename(fd, oldPtr, oldLen, fd2, newPtr, newLen) {
        const from = path(fd, oldPtr, oldLen);
        const to = path(fd2, newPtr, newLen);
        if (!self.isShared(from) && !self.isShared(to))
          return local.path_rename(fd, oldPtr, oldLen, fd2, newPtr, newLen);
        if (self.isShared(from) !== self.isShared(to)) return 75; // EXDEV
        return ask({ op: 'rename', path: from, to }).error ?? E.SUCCESS;
      },
      path_link(fd, flags, oldPtr, oldLen, fd2, newPtr, newLen) {
        const from = path(fd, oldPtr, oldLen);
        const to = path(fd2, newPtr, newLen);
        if (!self.isShared(from) && !self.isShared(to))
          return local.path_link(fd, flags, oldPtr, oldLen, fd2, newPtr, newLen);
        if (self.isShared(from) !== self.isShared(to)) return 75; // EXDEV
        return (
          ask({ op: 'link', path: from, to, follow: !!(flags & LOOKUP_SYMLINKS) }).error ??
          E.SUCCESS
        );
      },
      fd_read(fd, iovs, count, nreadPtr) {
        const remote = remoteOf(fd);
        if (!remote) return local.fd_read(fd, iovs, count, nreadPtr);
        if (remote.dir) return E.ISDIR;
        let total = 0;
        for (const [ptr, len] of self.iovecs(iovs, count)) {
          let filled = 0;
          while (filled < len) {
            const want = Math.min(len - filled, SHARED_CHUNK);
            const { answer, bytes } = call({
              op: 'read',
              handle: remote.handle,
              offset: remote.position,
              length: want,
            });
            if (answer.error) return answer.error;
            self.bytes(ptr + filled, bytes.length).set(bytes);
            filled += bytes.length;
            remote.position += bytes.length;
            if (bytes.length < want) break;
          }
          total += filled;
          if (filled < len) break;
        }
        self.view().setUint32(nreadPtr, total, true);
        return E.SUCCESS;
      },
      fd_write(fd, iovs, count, nwrittenPtr) {
        const remote = remoteOf(fd);
        if (!remote) return local.fd_write(fd, iovs, count, nwrittenPtr);
        let total = 0;
        for (const [ptr, len] of self.iovecs(iovs, count)) {
          for (let at = 0; at < len; at += SHARED_CHUNK) {
            const bytes = self.bytes(ptr + at, Math.min(SHARED_CHUNK, len - at)).slice();
            const answer = ask(
              {
                op: 'write',
                handle: remote.handle,
                offset: remote.position,
                append: remote.append,
              },
              bytes,
            );
            if (answer.error) return answer.error;
            remote.position = answer.position;
          }
          total += len;
        }
        self.view().setUint32(nwrittenPtr, total, true);
        return E.SUCCESS;
      },
      fd_seek(fd, offset, whence, ptr) {
        const remote = remoteOf(fd);
        if (!remote) return local.fd_seek(fd, offset, whence, ptr);
        const size = whence === 2 ? ask({ op: 'fstat', handle: remote.handle }).size : 0;
        const base = [0, remote.position, size][whence];
        if (base === undefined) return E.INVAL;
        const position = base + Number(offset);
        if (position < 0) return E.INVAL;
        remote.position = position;
        self.view().setBigUint64(ptr, BigInt(position), true);
        return E.SUCCESS;
      },
      fd_filestat_get(fd, ptr) {
        const remote = remoteOf(fd);
        if (!remote) return local.fd_filestat_get(fd, ptr);
        const status = ask({ op: 'fstat', handle: remote.handle });
        if (status.error) return status.error;
        self.sharedFilestat(ptr, status);
        return E.SUCCESS;
      },
      fd_filestat_set_size(fd, size) {
        const remote = remoteOf(fd);
        if (!remote) return local.fd_filestat_set_size(fd, size);
        return (
          ask({ op: 'truncate', handle: remote.handle, size: Number(size) }).error ?? E.SUCCESS
        );
      },
      fd_allocate(fd, offset, length) {
        const remote = remoteOf(fd);
        if (!remote) return local.fd_allocate(fd, offset, length);
        const status = ask({ op: 'fstat', handle: remote.handle });
        if (status.error) return status.error;
        const end = Number(offset + length);
        if (end <= status.size) return E.SUCCESS;
        return ask({ op: 'truncate', handle: remote.handle, size: end }).error ?? E.SUCCESS;
      },
      fd_fdstat_get(fd, ptr) {
        const remote = remoteOf(fd);
        if (!remote) return local.fd_fdstat_get(fd, ptr);
        const v = self.view();
        v.setUint8(ptr, remote.dir ? FILETYPE.DIR : FILETYPE.REG);
        v.setUint16(ptr + 2, remote.append ? FDFLAGS.APPEND : 0, true);
        v.setBigUint64(ptr + 8, 0xffffffffffffffffn, true);
        v.setBigUint64(ptr + 16, 0xffffffffffffffffn, true);
        return E.SUCCESS;
      },
      fd_readdir(fd, buf, len, cookie, usedPtr) {
        const remote = remoteOf(fd);
        if (!remote) return local.fd_readdir(fd, buf, len, cookie, usedPtr);
        if (!remote.dir) return E.NOTDIR;
        if (!remote.listing || cookie === 0n) {
          const answer = ask({ op: 'readdir', handle: remote.handle });
          if (answer.error) return answer.error;
          remote.listing = answer.entries;
        }
        let used = 0;
        for (let i = Number(cookie); i < remote.listing!.length && used < len; i++) {
          const [name, type, ino] = remote.listing![i];
          const encoded = new TextEncoder().encode(name);
          const record = new Uint8Array(24 + encoded.length);
          const h = new DataView(record.buffer);
          h.setBigUint64(0, BigInt(i + 1), true);
          h.setBigUint64(8, BigInt(ino), true);
          h.setUint32(16, encoded.length, true);
          h.setUint8(20, sharedType(type));
          record.set(encoded, 24);
          const room = Math.min(record.length, len - used);
          self.bytes(buf + used, room).set(record.subarray(0, room));
          used += room;
        }
        self.view().setUint32(usedPtr, used, true);
        return E.SUCCESS;
      },
      fd_close(fd) {
        const remote = remoteOf(fd);
        if (!remote) return local.fd_close(fd);
        self.fds.delete(fd);
        return ask({ op: 'close', handle: remote.handle }).error ?? E.SUCCESS;
      },
    };
  }

  functions(): Local {
    // oxlint-disable-next-line typescript/no-this-alias -- the calls' own `this` is not the shim.
    const self = this;
    const ok = E.SUCCESS;
    const list = (items: string[]) => ({
      sizes(countPtr: number, sizePtr: number) {
        const v = self.view();
        v.setUint32(countPtr, items.length, true);
        v.setUint32(
          sizePtr,
          items.reduce((n, s) => n + new TextEncoder().encode(s).length + 1, 0),
          true,
        );
        return ok;
      },
      get(ptrs: number, buf: number) {
        const v = self.view();
        let at = buf;
        items.forEach((item, i) => {
          const bytes = new TextEncoder().encode(item);
          v.setUint32(ptrs + 4 * i, at, true);
          self.bytes(at, bytes.length).set(bytes);
          v.setUint8(at + bytes.length, 0);
          at += bytes.length + 1;
        });
        return ok;
      },
    });
    const args = list(this.args);
    const env = list(this.env);
    return {
      args_sizes_get: (c, s) => args.sizes(c, s),
      args_get: (p, b) => args.get(p, b),
      environ_sizes_get: (c, s) => env.sizes(c, s),
      environ_get: (p, b) => env.get(p, b),
      // Every clock counts in nanoseconds; performance.now() is coarser in
      // browsers, so 1 µs is the honest resolution.
      clock_res_get(_id, ptr) {
        self.view().setBigUint64(ptr, 1000n, true);
        return ok;
      },
      clock_time_get(id, _precision, ptr) {
        // The scheduler reads the clock between slices: interrupts land.
        self.pump();
        const time = id === 0 ? now() : BigInt(Math.round(performance.now() * 1e6));
        self.view().setBigUint64(ptr, time, true);
        return ok;
      },
      random_get(ptr, len) {
        // Into a copy: getRandomValues takes no view of a shared memory.
        for (let at = 0; at < len; at += 65536) {
          const part = new Uint8Array(Math.min(65536, len - at));
          crypto.getRandomValues(part);
          self.bytes(ptr + at, part.length).set(part);
        }
        return ok;
      },
      proc_exit(code) {
        throw new Exit(code);
      },
      // raise() (wasi-libc's emulated signals): the program ends as an
      // uncaught signal ends it, 128 + its number.
      proc_raise(signal) {
        throw new Exit(128 + signal);
      },
      sched_yield: () => ok,
      poll_oneoff(inPtr, outPtr, count, eventsPtr) {
        const v = self.view();
        let wait = Infinity;
        let events = 0;
        for (let i = 0; i < count; i++) {
          const sub = inPtr + 48 * i;
          const tag = v.getUint8(sub + 8);
          const out = outPtr + 32 * events;
          if (tag === 0) {
            const timeout = v.getBigUint64(sub + 24, true);
            const absolute = v.getUint16(sub + 40, true) & 1;
            const ms = Number(absolute ? timeout - now() : timeout) / 1e6;
            wait = Math.min(wait, Math.max(0, ms));
          }
          v.setBigUint64(out, v.getBigUint64(sub, true), true);
          v.setUint16(out + 8, 0, true);
          v.setUint8(out + 10, tag);
          events++;
        }
        if (wait !== Infinity && wait > 0) self.sleep(wait);
        self.pump();
        v.setUint32(eventsPtr, events, true);
        return ok;
      },
      fd_prestat_get(fd, ptr) {
        const entry = self.fds.get(fd);
        if (!entry || !entry.preopen) return E.BADF;
        const v = self.view();
        v.setUint8(ptr, 0);
        v.setUint32(ptr + 4, new TextEncoder().encode(entry.preopen).length, true);
        return ok;
      },
      fd_prestat_dir_name(fd, ptr, len) {
        const entry = self.fds.get(fd);
        if (!entry || !entry.preopen) return E.BADF;
        self.bytes(ptr, len).set(new TextEncoder().encode(entry.preopen).subarray(0, len));
        return ok;
      },
      fd_fdstat_get(fd, ptr) {
        const entry = self.fds.get(fd);
        if (!entry) return E.BADF;
        const v = self.view();
        const type = entry.stream
          ? FILETYPE.CHAR
          : entry.node instanceof Dir
            ? FILETYPE.DIR
            : FILETYPE.REG;
        v.setUint8(ptr, type);
        v.setUint16(ptr + 2, entry.append ? FDFLAGS.APPEND : 0, true);
        // wasi-libc's isatty: a character device that cannot seek or tell.
        const rights =
          entry.stream && self.tty ? ~(4n | 32n) & 0xffffffffffffffffn : 0xffffffffffffffffn;
        v.setBigUint64(ptr + 8, rights, true);
        v.setBigUint64(ptr + 16, rights, true);
        return ok;
      },
      fd_fdstat_set_flags: () => ok,
      fd_close(fd) {
        if (!self.fds.has(fd) || fd < 3) return fd < 3 ? ok : E.BADF;
        const entry = self.fds.get(fd)!;
        if (entry.endpoint) entry.endpoint.peer.close();
        if (entry.listener) {
          self.network.listeners.delete(entry.port!);
          self.network.remote.listening?.(entry.port!, false);
        }
        if (entry.changed) self.onchange(entry.path!);
        // The port closed: a program still running is told (onclose).
        if (entry.process) {
          entry.process.closed = true;
          entry.process.onclose?.();
        }
        self.fds.delete(fd);
        return ok;
      },
      fd_sync: () => ok,
      fd_datasync: () => ok,
      // Hints and rights: nothing to do.
      fd_advise: () => ok,
      fd_fdstat_set_rights: () => ok,
      fd_filestat_get(fd, ptr) {
        const entry = self.fds.get(fd);
        if (!entry) return E.BADF;
        // A process's size is its exit status + 1 once it has exited.
        if (entry.spawn) {
          const status = entry.process?.status;
          self.filestat(ptr, {
            ino: 0n,
            size: status === null || status === undefined ? 0 : status + 1,
            mtime: now(),
          });
          return ok;
        }
        // A listener's size is its port (wasm_net.rs).
        if (entry.listener) {
          self.filestat(ptr, { ino: 0n, size: entry.port!, mtime: now() });
          return ok;
        }
        self.filestat(ptr, entry.stream ? null : entry.node);
        return ok;
      },
      fd_filestat_set_size(fd, size) {
        const entry = self.fds.get(fd);
        if (entry?.endpoint) {
          entry.endpoint.peer.end();
          return ok;
        }
        if (entry?.process) {
          entry.process.closed = true;
          return ok;
        }
        if (!entry || !(entry.node instanceof File)) return E.BADF;
        entry.node.truncate(Number(size));
        entry.changed = true;
        return ok;
      },
      // posix_fallocate: the file at least offset + length long.
      fd_allocate(fd, offset, length) {
        const entry = self.fds.get(fd);
        if (!entry || !(entry.node instanceof File)) return entry ? E.SPIPE : E.BADF;
        const end = Number(offset + length);
        if (end > entry.node.size) {
          entry.node.truncate(end);
          entry.changed = true;
        }
        return ok;
      },
      // Files keep their own times (written ones are now): setting them
      // does nothing, by descriptor or by path (SQLite asks for both).
      fd_filestat_set_times: () => ok,
      path_filestat_set_times: () => ok,
      fd_read(fd, iovs, count, nreadPtr) {
        const entry = self.fds.get(fd);
        if (!entry) return E.BADF;
        self.pump();
        let total = 0;
        const net = entry.endpoint || entry.listener;
        if (entry.nif) {
          // A NIF library's answer (nif.ts), once the request is in.
          if (!entry.answer) {
            const request = new Uint8Array(entry.request!.reduce((n, part) => n + part.length, 0));
            let at = 0;
            for (const part of entry.request!) {
              request.set(part, at);
              at += part.length;
            }
            entry.answer = self.nifs.answer(entry.nif, request);
          }
          for (const [ptr, len] of self.iovecs(iovs, count)) {
            const part = entry.answer.subarray(entry.position!, entry.position! + len);
            self.bytes(ptr, part.length).set(part);
            entry.position! += part.length;
            total += part.length;
            if (part.length < len) break;
          }
        } else if (entry.spawn) {
          const process = entry.process;
          if (!process) return E.BADF;
          const [ptr, len] = self.iovecs(iovs, count)[0] || [0, 0];
          if (!process.output.length) {
            if (!process.ended) return E.AGAIN;
          } else {
            const chunk = process.output[0];
            const part = chunk.subarray(0, len);
            self.bytes(ptr, part.length).set(part);
            if (part.length === chunk.length) process.output.shift();
            else process.output[0] = chunk.subarray(part.length);
            total = part.length;
          }
        } else if (net) {
          const [ptr, len] = self.iovecs(iovs, count)[0] || [0, 0];
          let bytes: Uint8Array;
          if (entry.listener) {
            const next = entry.listener.shift();
            if (!next) return E.AGAIN;
            bytes = new TextEncoder().encode(`${next.id} ${next.ip} ${next.port}`);
          } else {
            if (!entry.endpoint!.inbox.length) {
              if (entry.endpoint!.eof) bytes = new Uint8Array(0);
              else return E.AGAIN;
            } else bytes = entry.endpoint!.take(len);
          }
          self.bytes(ptr, bytes.length).set(bytes.subarray(0, len));
          total = Math.min(len, bytes.length);
        } else if (entry.node instanceof Device) {
          for (const [ptr, len] of self.iovecs(iovs, count)) {
            self.bytes(ptr, len).set(entry.node.read(len));
            total += len;
          }
        } else if (fd === 0) {
          const want = self.iovecs(iovs, count).reduce((n, [, len]) => n + len, 0);
          const input = self.stdin(want);
          if (input === null) return E.AGAIN;
          let at = 0;
          for (const [ptr, len] of self.iovecs(iovs, count)) {
            const part = input.subarray(at, at + len);
            self.bytes(ptr, part.length).set(part);
            at += part.length;
          }
          total = at;
        } else {
          const file = entry.node;
          if (!(file instanceof File)) return E.ISDIR;
          for (const [ptr, len] of self.iovecs(iovs, count)) {
            const part = file.bytes.subarray(entry.position!, entry.position! + len);
            self.bytes(ptr, part.length).set(part);
            entry.position! += part.length;
            total += part.length;
            if (part.length < len) break;
          }
        }
        self.view().setUint32(nreadPtr, total, true);
        return ok;
      },
      fd_write(fd, iovs, count, nwrittenPtr) {
        const entry = self.fds.get(fd);
        if (!entry) return E.BADF;
        let total = 0;
        for (const [ptr, len] of self.iovecs(iovs, count)) {
          const bytes = self.bytes(ptr, len);
          if (entry.nif) {
            entry.request!.push(bytes.slice());
          } else if (entry.terminal) {
            self.terminal!.mode(new TextDecoder().decode(bytes.slice()).trim());
          } else if (entry.spawn && !entry.process) {
            const error = self.spawn(entry, bytes);
            if (error) return error;
          } else if (entry.spawn) {
            entry.process!.input.push(bytes.slice());
          } else if (entry.endpoint) {
            entry.endpoint.peer.send(bytes.slice());
          } else if (entry.stream) {
            const sink = self.out[fd];
            if (sink) sink(bytes.slice());
          } else {
            const file = entry.node;
            if (!(file instanceof File)) return E.ISDIR;
            if (entry.append) entry.position = file.size;
            const end = entry.position! + len;
            file.reserve(end);
            file.data.set(bytes, entry.position);
            if (end > file.size) file.size = end;
            file.mtime = now();
            file.written = true;
            entry.changed = true;
            entry.position = end;
          }
          total += len;
        }
        self.view().setUint32(nwrittenPtr, total, true);
        return ok;
      },
      fd_seek(fd, offset, whence, ptr) {
        const entry = self.fds.get(fd);
        if (!entry) return E.BADF;
        if (entry.stream) return E.SPIPE;
        const size = entry.node instanceof File ? entry.node.size : 0;
        const base = [0, entry.position, size][whence];
        if (base === undefined) return E.INVAL;
        const position = base + Number(offset);
        if (position < 0) return E.INVAL;
        entry.position = position;
        self.view().setBigUint64(ptr, BigInt(position), true);
        return ok;
      },
      fd_readdir(fd, buf, len, cookie, usedPtr) {
        const entry = self.fds.get(fd);
        if (!entry || !(entry.node instanceof Dir)) return E.NOTDIR;
        const v = self.view();
        const names = [...entry.node.entries.entries()];
        let used = 0;
        for (let i = Number(cookie); i < names.length && used < len; i++) {
          const [name, node] = names[i];
          const encoded = new TextEncoder().encode(name);
          const header = new Uint8Array(24);
          const h = new DataView(header.buffer);
          h.setBigUint64(0, BigInt(i + 1), true);
          h.setBigUint64(8, node.ino, true);
          h.setUint32(16, encoded.length, true);
          h.setUint8(20, fileType(node));
          const record = new Uint8Array(24 + encoded.length);
          record.set(header);
          record.set(encoded, 24);
          const room = Math.min(record.length, len - used);
          self.bytes(buf + used, room).set(record.subarray(0, room));
          used += room;
        }
        v.setUint32(usedPtr, used, true);
        return ok;
      },
      path_open(fd, dirflags, pathPtr, pathLen, oflags, _base, _inheriting, fdflags, fdPtr) {
        const path = self.string(pathPtr, pathLen).replace(/^\/+/, '');
        if (path === '.proc/spawn') {
          const opened = self.next++;
          self.fds.set(opened, { spawn: true, process: null });
          self.view().setUint32(fdPtr, opened, true);
          return ok;
        }
        // The terminal: writing `raw` or `cooked` to /.tty/mode sets its
        // input mode; /.tty/size reads as `COLUMNS ROWS`.
        if (path.startsWith('.tty/')) {
          let entry: Descriptor;
          if (!self.terminal) return E.NOENT;
          if (path === '.tty/mode') entry = { terminal: true, node: new File() };
          else if (path === '.tty/size') {
            entry = {
              node: new File(new TextEncoder().encode(self.terminal.size().join(' '))),
              position: 0,
            };
          } else return E.NOENT;
          const opened = self.next++;
          self.fds.set(opened, entry);
          self.view().setUint32(fdPtr, opened, true);
          return ok;
        }
        // A NIF library: /.nif/new loads one, /.nif/ID calls it (nif.ts).
        if (path.startsWith('.nif/')) {
          const opened = self.next++;
          self.fds.set(opened, { nif: path.slice(5), request: [], answer: null, position: 0 });
          self.view().setUint32(fdPtr, opened, true);
          return ok;
        }
        if (path.startsWith('.net/')) {
          const [, op, a, b] = path.split('/');
          const net = self.network;
          let entry: Descriptor;
          if (op === 'listen') {
            const listening = net.listen(Number(b));
            if (!listening) return E.ADDRINUSE;
            entry = { listener: listening.queue, port: listening.port };
          } else if (op === 'conn') {
            const endpoint = net.waiting.get(Number(a));
            if (!endpoint) return E.NOENT;
            net.waiting.delete(Number(a));
            entry = { endpoint };
          } else if (op === 'connect') {
            const endpoint = net.connect(Number(b));
            if (!endpoint) return E.CONNREFUSED;
            entry = { endpoint };
          } else if (op === 'https') {
            const endpoint = net.https(a, Number(b));
            if (!endpoint) return E.NOENT;
            entry = { endpoint };
          } else return E.NOENT;
          const opened = self.next++;
          self.fds.set(opened, entry);
          self.view().setUint32(fdPtr, opened, true);
          return ok;
        }
        const found = self.resolve(
          fd,
          self.string(pathPtr, pathLen),
          !!(dirflags & LOOKUP_SYMLINKS),
        );
        let node = found.node;
        let changed = false;
        if (node && oflags & OFLAGS.CREAT && oflags & OFLAGS.EXCL) return E.EXIST;
        // O_NOFOLLOW on a symbolic link.
        if (node instanceof Symlink) return E.LOOP;
        if (!node) {
          if (!(oflags & OFLAGS.CREAT) || !found.parent) return found.error!;
          node = new File();
          node.written = true;
          changed = true;
          found.parent.entries.set(found.name!, node);
          found.parent.mtime = now();
        }
        if (oflags & OFLAGS.DIRECTORY && !(node instanceof Dir)) return E.NOTDIR;
        try {
          load(node, self.fetch);
        } catch {
          return E.IO;
        }
        if (node instanceof File && oflags & OFLAGS.TRUNC) {
          node.truncate(0);
          node.written = true;
          changed = true;
        }
        const opened = self.next++;
        self.fds.set(opened, {
          node,
          position: 0,
          append: !!(fdflags & FDFLAGS.APPEND),
          path: self.absolute(fd, self.string(pathPtr, pathLen)),
          changed,
        });
        self.view().setUint32(fdPtr, opened, true);
        return ok;
      },
      path_filestat_get(fd, flags, pathPtr, pathLen, ptr) {
        const found = self.resolve(fd, self.string(pathPtr, pathLen), !!(flags & LOOKUP_SYMLINKS));
        if (!found.node) return found.error;
        self.filestat(ptr, found.node);
        return ok;
      },
      path_create_directory(fd, pathPtr, pathLen) {
        const found = self.resolve(fd, self.string(pathPtr, pathLen));
        if (found.node) return E.EXIST;
        if (!found.parent) return found.error;
        const dir = new Dir();
        dir.parent = found.parent;
        found.parent.entries.set(found.name!, dir);
        self.onchange(self.absolute(fd, self.string(pathPtr, pathLen)));
        return ok;
      },
      path_remove_directory(fd, pathPtr, pathLen) {
        const found = self.resolve(fd, self.string(pathPtr, pathLen));
        if (!found.node) return found.error;
        if (!(found.node instanceof Dir)) return E.NOTDIR;
        if (found.node.entries.size) return E.NOTEMPTY;
        found.parent!.entries.delete(found.name!);
        self.onchange(self.absolute(fd, self.string(pathPtr, pathLen)));
        return ok;
      },
      path_unlink_file(fd, pathPtr, pathLen) {
        const found = self.resolve(fd, self.string(pathPtr, pathLen));
        if (!found.node) return found.error;
        if (found.node instanceof Dir) return E.ISDIR;
        found.parent!.entries.delete(found.name!);
        self.onchange(self.absolute(fd, self.string(pathPtr, pathLen)));
        return ok;
      },
      path_rename(fd, oldPtr, oldLen, fd2, newPtr, newLen) {
        const from = self.resolve(fd, self.string(oldPtr, oldLen));
        if (!from.node) return from.error;
        const to = self.resolve(fd2, self.string(newPtr, newLen));
        if (!to.parent) return to.error!;
        if (to.node instanceof Dir && to.node.entries.size) return E.NOTEMPTY;
        from.parent!.entries.delete(from.name!);
        to.parent.entries.set(to.name!, from.node);
        if (from.node instanceof Dir) from.node.parent = to.parent;
        self.onchange(self.absolute(fd, self.string(oldPtr, oldLen)));
        self.onchange(self.absolute(fd2, self.string(newPtr, newLen)));
        return ok;
      },
      // A hard link: the same file under a second name.
      path_link(fd, flags, oldPtr, oldLen, fd2, newPtr, newLen) {
        const from = self.resolve(fd, self.string(oldPtr, oldLen), !!(flags & LOOKUP_SYMLINKS));
        if (!from.node) return from.error;
        if (from.node instanceof Dir) return E.PERM;
        const to = self.resolve(fd2, self.string(newPtr, newLen));
        if (to.node) return E.EXIST;
        if (!to.parent) return to.error;
        to.parent.entries.set(to.name!, from.node);
        self.onchange(self.absolute(fd2, self.string(newPtr, newLen)));
        return ok;
      },
      path_symlink(targetPtr, targetLen, fd, pathPtr, pathLen) {
        const found = self.resolve(fd, self.string(pathPtr, pathLen));
        if (found.node) return E.EXIST;
        if (!found.parent) return found.error;
        found.parent.entries.set(found.name!, new Symlink(self.string(targetPtr, targetLen)));
        found.parent.mtime = now();
        self.onchange(self.absolute(fd, self.string(pathPtr, pathLen)));
        return ok;
      },
      path_readlink(fd, pathPtr, pathLen, buf, bufLen, usedPtr) {
        const found = self.resolve(fd, self.string(pathPtr, pathLen));
        if (!found.node) return found.error;
        if (!(found.node instanceof Symlink)) return E.INVAL;
        const target = new TextEncoder().encode(found.node.target).subarray(0, bufLen);
        self.bytes(buf, target.length).set(target);
        self.view().setUint32(usedPtr, target.length, true);
        return ok;
      },
      sock_accept: () => E.NOSYS,
      sock_shutdown: () => E.NOSYS,
    };
  }
}
