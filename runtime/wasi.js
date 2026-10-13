// WASI preview 1 for rotp.wasm, over an in-memory filesystem: the imports
// Rust std (wasm32-wasip1) makes, for a Web Worker and for Node alike.
// One preopen, "/", holds everything; there are no links or owners.
// Standard input is a callback that answers bytes, null when none is
// waiting (EAGAIN: the node polls again) or an empty array at its end.

const E = {
  SUCCESS: 0, ACCES: 2, ADDRINUSE: 3, AGAIN: 6, CONNREFUSED: 14, BADF: 8, EXIST: 20, INVAL: 28, IO: 29,
  ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58,
  PERM: 63, SPIPE: 70,
};
const FILETYPE = { CHAR: 2, DIR: 3, REG: 4 };
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const FDFLAGS = { APPEND: 1 };

export class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

let inodes = 1;
const now = () => BigInt(Date.now()) * 1000000n;

// A file; `written` once the node has written it (node.mjs's SNAPSHOT).
export class File {
  constructor(data = new Uint8Array(0)) {
    this.ino = BigInt(inodes++);
    this.data = data;
    this.size = data.length;
    this.mtime = now();
  }
  // Room for `size` bytes, keeping what is there.
  reserve(size) {
    if (size > this.data.length) {
      const grown = new Uint8Array(Math.max(size, this.data.length * 2, 4096));
      grown.set(this.data.subarray(0, this.size));
      this.data = grown;
    }
  }
  truncate(size) {
    this.reserve(size);
    if (size > this.size) this.data.fill(0, this.size, size);
    this.size = size;
    this.mtime = now();
  }
  get bytes() {
    return this.data.subarray(0, this.size);
  }
}

// Files that are only listed (a site's fs/manifest.json): `size` bytes,
// fetched by WASI's fetch(source, bundle) when first opened; `bundle`
// names the tar in the site's fs/bundles/ that holds the file. mtime:
// seconds since the epoch (Mix compares sources and manifests).
export function mount(manifest, root) {
  for (const [path, size, mtime, bundle] of manifest) {
    const file = root.put(path, new File());
    file.size = size;
    file.source = path;
    file.bundle = bundle;
    if (mtime) file.mtime = BigInt(mtime) * 1000000000n;
  }
}

// A mounted file's bytes, fetched once.
export function load(node, fetch) {
  if (node.source) {
    node.data = fetch(node.source, node.bundle);
    node.size = node.data.length;
    node.source = null;
  }
}

// fetch(source, bundle) over bundles: get(bundle) is the bundle's tar,
// synchronously. Each bundle is fetched once; its other files wait in
// memory until they are opened.
export function bundled(get) {
  const waiting = new Map();
  const loaded = new Set();
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

export class Dir {
  constructor() {
    this.ino = BigInt(inodes++);
    this.entries = new Map();
    this.mtime = now();
  }
  // The directory at a slash-separated path below this one, made as needed.
  mkdirs(path) {
    let dir = this;
    for (const name of path.split('/').filter(Boolean)) {
      let next = dir.entries.get(name);
      if (!next) {
        next = new Dir();
        next.parent = dir;
        dir.entries.set(name, next);
      }
      dir = next;
    }
    return dir;
  }
  put(path, node) {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    const dir = this.mkdirs(parts.join('/'));
    if (node instanceof Dir) node.parent = dir;
    dir.entries.set(name, node);
    return node;
  }
}

// A file whose reads are made as they happen (/dev/urandom).
export class Device {
  constructor(read) {
    this.ino = BigInt(inodes++);
    this.read = read;
    this.size = 0;
    this.mtime = now();
  }
}
export const urandom = () =>
  new Device((count) => {
    const bytes = new Uint8Array(count);
    for (let at = 0; at < count; at += 65536) crypto.getRandomValues(bytes.subarray(at, at + 65536));
    return bytes;
  });

// One end of a connection, as the node sees it: what the peer sent
// (inbox), whether the peer has ended, and how to reach the peer.
class Endpoint {
  constructor(peer) {
    this.inbox = [];
    this.eof = false;
    this.peer = peer; // { send(bytes), end(), close() }
  }
  take(max) {
    const out = new Uint8Array(Math.min(max, this.inbox.reduce((n, c) => n + c.length, 0)));
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

// TCP for the node (crates/rotp/src/host/wasm_net.rs): listeners and
// connections inside it, and connections to and from the page (`remote`:
// remote.open(id, port) for a connection the node makes to a port in
// remote.ports; send/end/close by id). Ids the node makes are even; the
// page's are odd.
export class Network {
  constructor(remote = { ports: [], open() {}, send() {}, end() {}, close() {} }) {
    this.remote = remote;
    this.listeners = new Map(); // port -> [{ id, ip, port }]
    this.waiting = new Map(); // id -> Endpoint, until accepted
    this.endpoints = new Map(); // id -> Endpoint, for the page's
    this.next = 2;
    this.ephemeral = 50000;
  }
  // A listener's queue, on `port` or (0) a free one: { queue, port }.
  listen(port) {
    if (port === 0) do port = this.ephemeral++; while (this.listeners.has(port));
    if (this.listeners.has(port)) return null;
    const queue = [];
    this.listeners.set(port, queue);
    return { queue, port };
  }
  // A connection to the node's listener on `port` from the page.
  accepted(id, port) {
    const queue = this.listeners.get(port);
    if (!queue) return false;
    const r = this.remote;
    const endpoint = new Endpoint({
      send: (bytes) => r.send(id, bytes),
      end: () => r.end(id),
      close: () => { this.endpoints.delete(id); r.close(id); },
    });
    this.endpoints.set(id, endpoint);
    this.waiting.set(id, endpoint);
    queue.push({ id, ip: '127.0.0.1', port: this.ephemeral++ });
    return true;
  }
  // The node connects: to itself, or to the page.
  connect(port) {
    const queue = this.listeners.get(port);
    if (queue) {
      const id = (this.next += 2);
      let mine;
      const theirs = new Endpoint({
        send: (bytes) => mine.inbox.push(bytes),
        end: () => { mine.eof = true; },
        close: () => { mine.eof = true; },
      });
      mine = new Endpoint({
        send: (bytes) => theirs.inbox.push(bytes),
        end: () => { theirs.eof = true; },
        close: () => { theirs.eof = true; },
      });
      this.waiting.set(id, theirs);
      queue.push({ id, ip: '127.0.0.1', port: this.ephemeral++ });
      return mine;
    }
    if (!this.remote.ports.includes(port)) return null;
    const id = (this.next += 2);
    const r = this.remote;
    const endpoint = new Endpoint({
      send: (bytes) => r.send(id, bytes),
      end: () => r.end(id),
      close: () => { this.endpoints.delete(id); r.close(id); },
    });
    this.endpoints.set(id, endpoint);
    r.open(id, port);
    return endpoint;
  }
  // From the page: data for, or the end of, connection `id`.
  data(id, bytes) {
    this.endpoints.get(id)?.inbox.push(bytes);
  }
  ended(id) {
    const endpoint = this.endpoints.get(id);
    if (endpoint) endpoint.eof = true;
  }
}

// A program the host runs for the node (crates/rotp/src/host/wasm_proc.rs):
// what it wrote, whether its output has ended, its exit status, and its
// input.
export class Process {
  constructor() {
    this.output = [];
    this.ended = false;
    this.status = null;
    this.input = [];
    this.closed = false;
  }
  write(bytes) {
    this.output.push(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  }
  exit(status) {
    this.ended = true;
    this.status = status;
  }
}

// The entries of a tar (ustar, as Python's tarfile writes it): name,
// type ('0' file, '5' directory), body and mtime (ns).
export function* entries(tar) {
  const text = (from, length) => {
    let end = from;
    while (end < from + length && tar[end] !== 0) end++;
    return new TextDecoder().decode(tar.subarray(from, end));
  };
  let longName = null;
  for (let at = 0; at + 512 <= tar.length; ) {
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
export async function untar(gzipped, root) {
  const stream = new Blob([gzipped]).stream().pipeThrough(new DecompressionStream('gzip'));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  let count = 0;
  for (const { name, type, body, mtime } of entries(tar)) {
    if (type === '5') root.mkdirs(name);
    else if (type === '0') {
      root.put(name, new File(body)).mtime = mtime;
      count++;
    }
  }
  return count;
}

export class WASI {
  // { args, env, root: Dir, stdin(), stdout(bytes), stderr(bytes),
  // sleep(ms), tty }: with tty, the standard streams are terminals.
  // network: a Network; pump(): take in what the page sent, before reads.
  // fetch(source, bundle): a mounted file's bytes, synchronously.
  // programs: { name: (process, { args, cwd, env, root }) => ... }, the
  // programs the node may spawn, by base name; a program writes to and
  // exits its Process.
  // onchange(path): the node created, wrote (reported when the file is
  // closed), renamed or removed what is at the absolute `path`.
  constructor({ args, env, root, stdin, stdout, stderr, sleep, tty = false, network = new Network(), pump = () => {}, fetch, programs = {}, onchange = () => {} }) {
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
    this.fds = new Map([
      [0, { stream: true }],
      [1, { stream: true }],
      [2, { stream: true }],
      [3, { node: root, preopen: '/', path: '' }],
    ]);
    this.next = 4;
    this.memory = null;
    this.imports = { wasi_snapshot_preview1: this.functions() };
  }

  start(instance) {
    this.memory = instance.exports.memory;
    try {
      instance.exports._start();
      return 0;
    } catch (error) {
      if (error instanceof Exit) return error.code;
      throw error;
    }
  }

  view() {
    return new DataView(this.memory.buffer);
  }
  bytes(ptr, len) {
    return new Uint8Array(this.memory.buffer, ptr, len);
  }
  string(ptr, len) {
    return new TextDecoder().decode(this.bytes(ptr, len));
  }

  // The absolute path of `path` below directory fd `fd`.
  absolute(fd, path) {
    const base = path.startsWith('/') ? '' : (this.fds.get(fd)?.path ?? '');
    const out = [];
    for (const part of `${base}/${path}`.split('/')) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return '/' + out.join('/');
  }

  // The node at `path` below directory fd `fd`: { node } or { error },
  // with the parent and last name for creating or removing it.
  resolve(fd, path) {
    const base = this.fds.get(fd);
    if (!base || !(base.node instanceof Dir)) return { error: E.BADF };
    let dir = path.startsWith('/') ? this.root : base.node;
    const parts = path.split('/').filter((p) => p && p !== '.');
    let name = null;
    let parent = null;
    for (let i = 0; i < parts.length; i++) {
      if (!(dir instanceof Dir)) return { error: E.NOTDIR };
      const part = parts[i];
      if (part === '..') {
        dir = dir.parent || dir;
        if (i === parts.length - 1) return { node: dir };
        continue;
      }
      if (i === parts.length - 1) {
        parent = dir;
        name = part;
        const node = dir.entries.get(part);
        return node ? { node, parent, name } : { error: E.NOENT, parent, name };
      }
      const next = dir.entries.get(part);
      if (!next) return { error: E.NOENT };
      dir = next;
    }
    return { node: dir };
  }

  filestat(ptr, node) {
    const v = this.view();
    const dir = node instanceof Dir;
    v.setBigUint64(ptr, 1n, true);
    v.setBigUint64(ptr + 8, node ? node.ino : 0n, true);
    v.setUint8(ptr + 16, node ? (dir ? FILETYPE.DIR : FILETYPE.REG) : FILETYPE.CHAR);
    v.setBigUint64(ptr + 24, 1n, true);
    v.setBigUint64(ptr + 32, BigInt(node && !dir ? node.size : 0), true);
    const time = node ? node.mtime : now();
    v.setBigUint64(ptr + 40, time, true);
    v.setBigUint64(ptr + 48, time, true);
    v.setBigUint64(ptr + 56, time, true);
  }

  iovecs(iovs, count) {
    const v = this.view();
    const list = [];
    for (let i = 0; i < count; i++) {
      list.push([v.getUint32(iovs + 8 * i, true), v.getUint32(iovs + 8 * i + 4, true)]);
    }
    return list;
  }

  // A spawn request (wasm_proc.rs): run the program it names.
  spawn(entry, bytes) {
    const fields = new TextDecoder().decode(bytes).split('\0');
    const [program, cwd] = fields;
    const argc = Number(fields[2]);
    const args = fields.slice(3, 3 + argc);
    const envc = Number(fields[3 + argc]);
    const env = Object.fromEntries(fields.slice(4 + argc, 4 + argc + envc).map((v) => {
      const at = v.indexOf('=');
      return [v.slice(0, at), v.slice(at + 1)];
    }));
    // By base name, or its first part: _build/esbuild-linux-x64 is esbuild.
    const base = program.split('/').pop();
    const run = this.programs[base] ?? this.programs[base.split('-')[0]] ?? this.programs['*']?.(base);
    if (!run) return E.NOENT;
    const process = new Process();
    entry.process = process;
    try {
      run(process, { args, cwd: cwd || env.PWD || '/', env, root: this.root });
    } catch (error) {
      process.write(`${program}: ${error.message}\n`);
      process.exit(1);
    }
    return null;
  }

  functions() {
    const self = this;
    const ok = E.SUCCESS;
    const list = (items) => ({
      sizes(countPtr, sizePtr) {
        const v = self.view();
        v.setUint32(countPtr, items.length, true);
        v.setUint32(sizePtr, items.reduce((n, s) => n + new TextEncoder().encode(s).length + 1, 0), true);
        return ok;
      },
      get(ptrs, buf) {
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
      clock_time_get(id, _precision, ptr) {
        // The scheduler reads the clock between slices: interrupts land.
        self.pump();
        const time = id === 0 ? now() : BigInt(Math.round(performance.now() * 1e6));
        self.view().setBigUint64(ptr, time, true);
        return ok;
      },
      random_get(ptr, len) {
        for (let at = 0; at < len; at += 65536) {
          crypto.getRandomValues(self.bytes(ptr + at, Math.min(65536, len - at)));
        }
        return ok;
      },
      proc_exit(code) {
        throw new Exit(code);
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
        const type = entry.stream ? FILETYPE.CHAR : entry.node instanceof Dir ? FILETYPE.DIR : FILETYPE.REG;
        v.setUint8(ptr, type);
        v.setUint16(ptr + 2, entry.append ? FDFLAGS.APPEND : 0, true);
        // wasi-libc's isatty: a character device that cannot seek or tell.
        const rights = entry.stream && self.tty ? ~(4n | 32n) & 0xffffffffffffffffn : 0xffffffffffffffffn;
        v.setBigUint64(ptr + 8, rights, true);
        v.setBigUint64(ptr + 16, rights, true);
        return ok;
      },
      fd_fdstat_set_flags: () => ok,
      fd_close(fd) {
        if (!self.fds.has(fd) || fd < 3) return fd < 3 ? ok : E.BADF;
        const entry = self.fds.get(fd);
        if (entry.endpoint) entry.endpoint.peer.close();
        if (entry.listener) self.network.listeners.delete(entry.port);
        if (entry.changed) self.onchange(entry.path);
        // The port closed: a program still running is told (onclose).
        if (entry.process) {
          entry.process.closed = true;
          entry.process.onclose?.();
        }
        self.fds.delete(fd);
        return ok;
      },
      fd_sync: () => ok,
      fd_filestat_get(fd, ptr) {
        const entry = self.fds.get(fd);
        if (!entry) return E.BADF;
        // A process's size is its exit status + 1 once it has exited.
        if (entry.spawn) {
          const status = entry.process?.status;
          self.filestat(ptr, { ino: 0n, size: status === null || status === undefined ? 0 : status + 1, mtime: now() });
          return ok;
        }
        // A listener's size is its port (wasm_net.rs).
        if (entry.listener) {
          self.filestat(ptr, { ino: 0n, size: entry.port, mtime: now() });
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
      fd_filestat_set_times: () => ok,
      fd_read(fd, iovs, count, nreadPtr) {
        const entry = self.fds.get(fd);
        if (!entry) return E.BADF;
        self.pump();
        let total = 0;
        const net = entry.endpoint || entry.listener;
        if (entry.spawn) {
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
          let bytes;
          if (entry.listener) {
            const next = entry.listener.shift();
            if (!next) return E.AGAIN;
            bytes = new TextEncoder().encode(`${next.id} ${next.ip} ${next.port}`);
          } else {
            if (!entry.endpoint.inbox.length) {
              if (entry.endpoint.eof) bytes = new Uint8Array(0);
              else return E.AGAIN;
            } else bytes = entry.endpoint.take(len);
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
            const part = file.bytes.subarray(entry.position, entry.position + len);
            self.bytes(ptr, part.length).set(part);
            entry.position += part.length;
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
          if (entry.spawn && !entry.process) {
            const error = self.spawn(entry, bytes);
            if (error) return error;
          } else if (entry.spawn) {
            entry.process.input.push(bytes.slice());
          } else if (entry.endpoint) {
            entry.endpoint.peer.send(bytes.slice());
          } else if (entry.stream) {
            const sink = self.out[fd];
            if (sink) sink(bytes.slice());
          } else {
            const file = entry.node;
            if (!(file instanceof File)) return E.ISDIR;
            if (entry.append) entry.position = file.size;
            const end = entry.position + len;
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
          h.setUint8(20, node instanceof Dir ? FILETYPE.DIR : FILETYPE.REG);
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
      path_open(fd, _dirflags, pathPtr, pathLen, oflags, _base, _inheriting, fdflags, fdPtr) {
        const path = self.string(pathPtr, pathLen).replace(/^\/+/, '');
        if (path === '.proc/spawn') {
          const opened = self.next++;
          self.fds.set(opened, { spawn: true, process: null });
          self.view().setUint32(fdPtr, opened, true);
          return ok;
        }
        if (path.startsWith('.net/')) {
          const [, op, a, b] = path.split('/');
          const net = self.network;
          let entry;
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
          } else return E.NOENT;
          const opened = self.next++;
          self.fds.set(opened, entry);
          self.view().setUint32(fdPtr, opened, true);
          return ok;
        }
        const found = self.resolve(fd, self.string(pathPtr, pathLen));
        let node = found.node;
        let changed = false;
        if (node && oflags & OFLAGS.CREAT && oflags & OFLAGS.EXCL) return E.EXIST;
        if (!node) {
          if (!(oflags & OFLAGS.CREAT) || !found.parent) return found.error;
          node = new File();
          node.written = true;
          changed = true;
          found.parent.entries.set(found.name, node);
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
        self.fds.set(opened, { node, position: 0, append: !!(fdflags & FDFLAGS.APPEND),
          path: self.absolute(fd, self.string(pathPtr, pathLen)), changed });
        self.view().setUint32(fdPtr, opened, true);
        return ok;
      },
      path_filestat_get(fd, _flags, pathPtr, pathLen, ptr) {
        const found = self.resolve(fd, self.string(pathPtr, pathLen));
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
        found.parent.entries.set(found.name, dir);
        self.onchange(self.absolute(fd, self.string(pathPtr, pathLen)));
        return ok;
      },
      path_remove_directory(fd, pathPtr, pathLen) {
        const found = self.resolve(fd, self.string(pathPtr, pathLen));
        if (!found.node) return found.error;
        if (!(found.node instanceof Dir)) return E.NOTDIR;
        if (found.node.entries.size) return E.NOTEMPTY;
        found.parent.entries.delete(found.name);
        self.onchange(self.absolute(fd, self.string(pathPtr, pathLen)));
        return ok;
      },
      path_unlink_file(fd, pathPtr, pathLen) {
        const found = self.resolve(fd, self.string(pathPtr, pathLen));
        if (!found.node) return found.error;
        if (found.node instanceof Dir) return E.ISDIR;
        found.parent.entries.delete(found.name);
        self.onchange(self.absolute(fd, self.string(pathPtr, pathLen)));
        return ok;
      },
      path_rename(fd, oldPtr, oldLen, fd2, newPtr, newLen) {
        const from = self.resolve(fd, self.string(oldPtr, oldLen));
        if (!from.node) return from.error;
        const to = self.resolve(fd2, self.string(newPtr, newLen));
        if (!to.parent) return to.error;
        if (to.node instanceof Dir && to.node.entries.size) return E.NOTEMPTY;
        from.parent.entries.delete(from.name);
        to.parent.entries.set(to.name, from.node);
        if (from.node instanceof Dir) from.node.parent = to.parent;
        self.onchange(self.absolute(fd, self.string(oldPtr, oldLen)));
        self.onchange(self.absolute(fd2, self.string(newPtr, newLen)));
        return ok;
      },
      // A hard link: the same file under a second name.
      path_link(fd, _flags, oldPtr, oldLen, fd2, newPtr, newLen) {
        const from = self.resolve(fd, self.string(oldPtr, oldLen));
        if (!from.node) return from.error;
        if (from.node instanceof Dir) return E.PERM;
        const to = self.resolve(fd2, self.string(newPtr, newLen));
        if (to.node) return E.EXIST;
        if (!to.parent) return to.error;
        to.parent.entries.set(to.name, from.node);
        self.onchange(self.absolute(fd2, self.string(newPtr, newLen)));
        return ok;
      },
      path_readlink: () => E.INVAL,
      sock_accept: () => E.NOSYS,
      sock_shutdown: () => E.NOSYS,
    };
  }
}
