// WASI preview 1 for rotp.wasm, over an in-memory filesystem: the imports
// Rust std (wasm32-wasip1) makes, for a Web Worker and for Node alike.
// One preopen, "/", holds everything; there are no links or owners.
// Standard input is a callback that answers bytes, null when none is
// waiting (EAGAIN: the node polls again) or an empty array at its end.
//
// Here: the shim's state and the calls on the process (arguments,
// environment, clocks, randomness, polling, exit). The others are by
// concern: descriptors.ts (the node's own files and the host's), shared.ts
// (the shared files), positioned.ts (pread, pwrite, tell); over fs.ts (the
// tree), net.ts (TCP) and process.ts (programs, the terminal).
import { Nifs } from '../nif';
import { E, FILETYPE, type Imports, type Local, type Syscall } from './abi';
import { descriptors, type Descriptor } from './descriptors';
import { Dir, fileType, lookup, now, type Fetch, type Found } from './fs';
import { Network } from './net';
import { positioned } from './positioned';
import type { Programs, Terminal } from './process';
import { sharedCalls, type Shared } from './shared';

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

// What filestat writes: a node, or the like of one.
type Stat = { ino: bigint; size?: number; mtime: bigint };

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
    const io = shared ? { ...functions, ...sharedCalls(this, functions) } : functions;
    this.imports = { wasi_snapshot_preview1: unsigned({ ...io, ...positioned(this, io) }) };
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
      ...descriptors(this),
    };
  }
}
