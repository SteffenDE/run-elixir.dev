// The page's side of a playground node (worker.js): start it, type into it,
// interrupt it, and connect to it or let it connect out.
//
// The page writes to the worker through frames in a SharedArrayBuffer ring
// (the worker sleeps on its write count, so a frame wakes it):
// [kind u8][id u32][length u32][payload]. The worker answers with
// messages.
export const FRAME = {
  INPUT: 0,
  OPEN: 1,
  DATA: 2,
  END: 3,
  CLOSE: 4,
  INTERRUPT: 5,
  OUTPUT: 7,
  EXIT: 8,
  RESIZE: 9,
} as const;
const CHANNEL = 1 << 20;

// A module worker from a blob that imports the runtime's script: Firefox
// does not start a worker from a page its service worker controls; a blob
// worker takes the page's cross-origin isolation in both.
function worker(name: string, base: string): Worker {
  const script = new URL(name, new URL(base, location.href)).href;
  const blob = new Blob([`import ${JSON.stringify(script)};`], { type: 'text/javascript' });
  return new Worker(URL.createObjectURL(blob), { type: 'module' });
}

// A path below a directory, and whether it is one (Files.list).
export interface Entry {
  path: string;
  dir: boolean;
}

export interface Stat {
  type: 'file' | 'dir';
  size: number;
  mtime: number;
  ino: number;
}

// The shared filesystem's operations (files.js through Files).
export interface FileSystem {
  list(path: string, skip?: string[]): Promise<Entry[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(path: string, to: string): Promise<void>;
  stat(path: string): Promise<'file' | 'dir' | null>;
  lstat(path: string): Promise<Stat>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

// A node's way to the shared files (wasi/shared.ts sharedClient).
export interface FilesChannel {
  doorbell: SharedArrayBuffer;
  channel: SharedArrayBuffer;
}

// What files.js answers a request with: its fields, by request.
// oxlint-disable-next-line typescript/no-explicit-any -- each op's own.
type Reply = Record<string, any>;

// The shared filesystem (files.js): /work and /tmp, which every node and
// the page see. onchange(paths): what changed in it.
export class Files implements FileSystem {
  doorbell: SharedArrayBuffer;
  requests: Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>;
  next: number;
  worker: Worker;
  ready: Promise<void>;

  // boots, template, store: what files.js starts with (its 'start').
  // onwarning(message): a change that was not kept.
  constructor({
    base = './',
    boots = ['boot'],
    template = [] as string[],
    store = null as string | null,
    onchange = (_paths: string[]) => {},
    onwarning = (_message: string) => {},
  } = {}) {
    this.doorbell = new SharedArrayBuffer(4);
    this.requests = new Map();
    this.next = 0;
    this.worker = worker('files.js', base);
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }) => {
        if (data.kind === 'ready') resolve();
        else if (data.kind === 'failed') reject(new Error(data.message));
        else if (data.kind === 'changed') onchange(data.paths);
        else if (data.kind === 'warning') onwarning(data.message);
        else if (data.kind === 'reply') {
          const request = this.requests.get(data.id);
          this.requests.delete(data.id);
          if (data.error)
            request?.reject(Object.assign(new Error(data.error), { code: data.code }));
          else request?.resolve(data);
        }
      };
    });
    this.worker.postMessage({
      kind: 'start',
      base: new URL(base, location.href).href,
      doorbell: this.doorbell,
      boots,
      template,
      store,
    });
  }

  // A node's channel (wasi/shared.ts sharedClient).
  connect(): FilesChannel {
    const channel = new SharedArrayBuffer(8 + CHANNEL);
    this.worker.postMessage({ kind: 'connect', channel });
    return { doorbell: this.doorbell, channel };
  }
  disconnect({ channel }: FilesChannel): void {
    this.worker.postMessage({ kind: 'disconnect', channel });
  }

  ask(request: { op: string } & Record<string, unknown>): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.requests.set(id, { resolve, reject });
      this.worker.postMessage({ kind: 'request', id, ...request });
    });
  }
  list(path: string, skip: string[] = []): Promise<Entry[]> {
    return this.ask({ op: 'list', path, skip }).then((r) => r.entries);
  }
  // 'file', 'dir', or null when there is nothing at `path`.
  stat(path: string): Promise<'file' | 'dir' | null> {
    return this.ask({ op: 'stat', path }).then((r) => r.type);
  }
  // In POSIX's shape, failing with its codes (ENOENT, ENOTDIR, ENOTEMPTY):
  // { type, size, mtime (ms), ino }; the names in a directory; removing a
  // file, an empty directory.
  lstat(path: string): Promise<Stat> {
    return this.ask({ op: 'lstat', path }) as Promise<Stat>;
  }
  readdir(path: string): Promise<string[]> {
    return this.ask({ op: 'readdir', path }).then((r) => r.names);
  }
  unlink(path: string): Promise<void> {
    return this.ask({ op: 'unlink', path }).then(() => {});
  }
  rmdir(path: string): Promise<void> {
    return this.ask({ op: 'rmdir', path }).then(() => {});
  }
  read(path: string): Promise<Uint8Array> {
    return this.ask({ op: 'read', path }).then((r) => r.data);
  }
  write(path: string, data: string | Uint8Array): Promise<void> {
    return this.ask({
      op: 'write',
      path,
      data: typeof data === 'string' ? new TextEncoder().encode(data) : data,
    }).then(() => {});
  }
  mkdir(path: string): Promise<void> {
    return this.ask({ op: 'mkdir', path }).then(() => {});
  }
  remove(path: string): Promise<void> {
    return this.ask({ op: 'remove', path }).then(() => {});
  }
  rename(path: string, to: string): Promise<void> {
    return this.ask({ op: 'rename', path, to }).then(() => {});
  }
  // What the project changed below /work over its template, but in
  // directories named in `skip`: { changed: [{ path, data }], removed }.
  changes(
    skip: string[] = [],
  ): Promise<{ changed: { path: string; data: Uint8Array }[]; removed: string[] }> {
    return this.ask({ op: 'changes', skip }).then(({ changed, removed }) => ({ changed, removed }));
  }
  // Keep everything changed so far (a store's).
  flush(): Promise<void> {
    return this.ask({ op: 'flush' }).then(() => {});
  }
}
export const RING = 1 << 20;
const CHUNK = 1 << 16;

// Why a connection closed: the peer closed it, or (connecting) nothing
// listened.
export type CloseReason = 'close' | 'refused';

// A connection between the page and the node.
export class Connection {
  node: Node;
  id: number;
  ondata: (bytes: Uint8Array) => void;
  onend: () => void;
  onclose: (why?: CloseReason) => void;

  constructor(node: Node, id: number) {
    this.node = node;
    this.id = id;
    this.ondata = () => {};
    this.onend = () => {};
    this.onclose = () => {};
  }
  write(bytes: Uint8Array): void {
    for (let at = 0; at < bytes.length; at += CHUNK) {
      this.node.frame(FRAME.DATA, this.id, bytes.subarray(at, at + CHUNK));
    }
  }
  end(): void {
    this.node.frame(FRAME.END, this.id);
  }
  close(): void {
    this.node.frame(FRAME.CLOSE, this.id);
    this.node.connections.delete(this.id);
  }
}

// A program the node started that runs on the page.
export interface PageProcess {
  write(data: string | Uint8Array): void;
  exit(code?: number): void;
  onkill: (() => void) | null;
}

export type PageProgram = (
  process: PageProcess,
  context: { args: string[]; cwd: string; env: Record<string, string>; fs: FileSystem },
) => void | Promise<void>;

// make waiting for the backend to build a package's NIF library (onnif).
export interface NifBuild {
  name: string;
  version: string;
  status:
    | 'queued'
    | 'running'
    | 'setting_up'
    | 'succeeded'
    | 'failed'
    | 'unsupported'
    | 'interrupted';
  error: string | null;
}

export type Https = (connection: Connection, target: { host: string; port: number }) => void;

// What the node's worker tells the page (worker.js).
type NetMessage = {
  kind: 'net';
  op: 'open' | 'data' | 'end' | 'close' | 'refused';
  id: number;
  port?: number;
  host?: string;
  payload?: Uint8Array;
};
type SpawnMessage = {
  kind: 'spawn';
  id: number;
  name: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};
type NodeMessage =
  | { kind: 'out'; payload: Uint8Array }
  | { kind: 'status'; payload: string }
  | { kind: 'exit'; payload: number }
  | { kind: 'tty'; raw: boolean }
  | ({ kind: 'nif' } & NifBuild)
  | NetMessage
  | { kind: 'listening'; port: number; on: boolean; ephemeral: boolean }
  | SpawnMessage
  | { kind: 'thread'; node: number; start: unknown }
  | { kind: 'threads-end'; node: number }
  | { kind: 'kill'; id: number };

export class Node {
  https: Https | null;
  files: Files | null;
  listening: Set<number>;
  serving: Set<number>;
  programs: Record<string, PageProgram>;
  running: Map<number, PageProcess>;
  shared: SharedArrayBuffer;
  control: Int32Array;
  ring: Uint8Array;
  pending: Uint8Array[];
  connections: Map<number, Connection>;
  next: number;
  serve: Record<number, (connection: Connection) => void>;
  threads: Map<number, Worker[]>;
  worker: Worker;
  channel: FilesChannel | null = null;
  retry: ReturnType<typeof setTimeout> | null = null;

  // base: where the site's runtime files are; onoutput(bytes),
  // onstatus(text), onexit(code); serve: { port: (connection) => ... } for
  // ports the node may connect to on the page; https: (connection,
  // { host, port }) => ..., HTTPS the page carries for the node
  // (/.net/https, https.ts), or null; files: a Files the node
  // shares /work and /tmp with; onlistening(port, on): the node started or
  // stopped listening on a port. `listening` holds every port it listens
  // on; `serving` only those it named (a server's, not an ephemeral port
  // it asked for with 0, as Mix's lock does).
  // programs: { name: (process, { args, cwd, env, fs }) => ... }, programs
  // the node may spawn that run on the page (they may be async):
  // process.write(text | bytes), process.exit(code), process.onkill.
  // onterminal(raw): the node set its terminal to raw input (keys go to
  // it as typed) or back to lines. onnif({ name, version, status, error }):
  // make waits for the backend to build a package's NIF library (status
  // queued, running or setting_up), or stopped waiting (succeeded, failed,
  // unsupported, interrupted).
  constructor({
    base = './',
    onoutput = (_bytes: Uint8Array) => {},
    onstatus = (_text: string) => {},
    onexit = (_code: number) => {},
    serve = {} as Record<number, (connection: Connection) => void>,
    https = null as Https | null,
    programs = {} as Record<string, PageProgram>,
    files = null as Files | null,
    onlistening = (_port: number, _on: boolean) => {},
    onterminal = (_raw: boolean) => {},
    onnif = (_build: NifBuild) => {},
  }) {
    this.https = https;
    this.files = files;
    this.listening = new Set();
    this.serving = new Set();
    this.programs = programs;
    this.running = new Map();
    this.shared = new SharedArrayBuffer(8 + RING);
    this.control = new Int32Array(this.shared, 0, 2);
    this.ring = new Uint8Array(this.shared, 8, RING);
    this.pending = [];
    this.connections = new Map();
    this.next = 1;
    this.serve = serve;
    // A threaded node's threads (worker/threaded.ts runThreaded), by node: workers
    // the page starts, since a worker busy serving them could not.
    this.threads = new Map();
    this.worker = worker('worker.js', base);
    this.worker.onmessage = ({ data }: MessageEvent<NodeMessage>) => {
      if (data.kind === 'out') onoutput(data.payload);
      else if (data.kind === 'status') onstatus(data.payload);
      else if (data.kind === 'exit') onexit(data.payload);
      else if (data.kind === 'tty') onterminal(data.raw);
      else if (data.kind === 'nif') onnif(data);
      else if (data.kind === 'net') this.network(data);
      else if (data.kind === 'listening') {
        if (data.on) this.listening.add(data.port);
        else this.listening.delete(data.port);
        if (data.on && !data.ephemeral) this.serving.add(data.port);
        else this.serving.delete(data.port);
        onlistening(data.port, data.on);
      } else if (data.kind === 'spawn') this.spawn(data);
      else if (data.kind === 'thread') {
        const thread = worker('thread.js', base);
        thread.onerror = (event) =>
          onstatus(`failed: ${event.message || 'a thread did not start'}`);
        thread.postMessage(data.start);
        if (!this.threads.has(data.node)) this.threads.set(data.node, []);
        this.threads.get(data.node)!.push(thread);
      } else if (data.kind === 'threads-end') this.stopThreads(data.node);
      else if (data.kind === 'kill') {
        this.running.get(data.id)?.onkill?.();
        this.running.delete(data.id);
      }
    };
    // A worker that does not load (or throws outside its own handler).
    this.worker.onerror = (event) =>
      onstatus(`failed: ${event.message || 'the worker did not start'}`);
  }

  // shell: a shell (true), or one command: erl's { args, env }, or
  // { command, env }, a command by name as the shell runs it.
  // initial: command lines the shell runs first, as if typed.
  // cwd: where the shell starts.
  // boots: the boot images to unpack (worker.js).
  start({
    shell = false,
    args,
    command,
    env = {},
    initial = [],
    cwd,
    boots,
  }: {
    shell?: boolean;
    args?: string[];
    command?: string[];
    env?: Record<string, string>;
    initial?: string[];
    cwd?: string;
    boots?: string[];
  } = {}): void {
    this.channel = this.files?.connect() ?? null;
    this.worker.postMessage({
      shared: this.shared,
      files: this.channel,
      shell,
      args,
      command,
      env,
      initial,
      cwd,
      boots,
      ports: Object.keys(this.serve).map(Number),
      https: Boolean(this.https),
      pagePrograms: Object.keys(this.programs),
    });
  }

  // The node's files: its Files.
  get fs(): Files | null {
    return this.files;
  }

  // Stop a threaded node's threads.
  stopThreads(node: number): void {
    for (const thread of this.threads.get(node) ?? []) thread.terminate();
    this.threads.delete(node);
  }

  // Stop the node and its worker.
  stop(): void {
    for (const node of [...this.threads.keys()]) this.stopThreads(node);
    this.worker.terminate();
    if (this.channel) this.files!.disconnect(this.channel);
  }

  // A program the node started (worker/channel.ts onPage).
  spawn({ id, name, args, cwd, env }: SpawnMessage): void {
    let exited = false;
    const process: PageProcess = {
      onkill: null,
      write: (data) => {
        if (exited) return;
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        for (let at = 0; at < bytes.length; at += CHUNK)
          this.frame(FRAME.OUTPUT, id, bytes.subarray(at, at + CHUNK));
      },
      exit: (code = 0) => {
        if (exited) return;
        exited = true;
        this.running.delete(id);
        this.frame(FRAME.EXIT, id, new Uint8Array([code & 255]));
      },
    };
    this.running.set(id, process);
    Promise.resolve()
      // Page programs come with shared files.
      .then(() => this.programs[name](process, { args, cwd, env, fs: this.fs! }))
      .catch((error) => {
        process.write(`${name}: ${error.message}\n`);
        process.exit(1);
      });
  }

  input(text: string): void {
    this.frame(FRAME.INPUT, 0, new TextEncoder().encode(text));
  }
  interrupt(): void {
    this.frame(FRAME.INTERRUPT, 0);
  }
  // The terminal's size, which the node reads from /.tty/size.
  resize(columns: number, rows: number): void {
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint16(0, columns, true);
    view.setUint16(2, rows, true);
    this.frame(FRAME.RESIZE, 0, payload);
  }

  // A connection to the node's listener on `port`.
  connect(port: number): Connection {
    const id = (this.next += 2);
    const connection = new Connection(this, id);
    this.connections.set(id, connection);
    this.frame(FRAME.OPEN, id, new Uint8Array([port >> 8, port & 255]));
    return connection;
  }

  network({ op, id, port, host, payload }: NetMessage): void {
    let connection = this.connections.get(id);
    if (op === 'open') {
      connection = new Connection(this, id);
      this.connections.set(id, connection);
      if (host !== undefined) {
        if (this.https) this.https(connection, { host, port: port! });
        else connection.close();
        return;
      }
      const handler = this.serve[port!];
      if (handler) handler(connection);
      else connection.close();
    } else if (!connection) {
      return;
    } else if (op === 'data') connection.ondata(payload!);
    else if (op === 'end') connection.onend();
    else if (op === 'close' || op === 'refused') {
      this.connections.delete(id);
      connection.onclose(op);
    }
  }

  frame(kind: number, id: number, payload: Uint8Array = new Uint8Array(0)): void {
    const frame = new Uint8Array(9 + payload.length);
    const view = new DataView(frame.buffer);
    view.setUint8(0, kind);
    view.setUint32(1, id, true);
    view.setUint32(5, payload.length, true);
    frame.set(payload, 9);
    this.pending.push(frame);
    this.flush();
  }

  // Frames go in whole, in order, as the ring has room.
  flush(): void {
    let written = Atomics.load(this.control, 0);
    while (this.pending.length) {
      const frame = this.pending[0];
      if (RING - (written - Atomics.load(this.control, 1)) < frame.length) {
        this.retry ??= setTimeout(() => {
          this.retry = null;
          this.flush();
        }, 2);
        break;
      }
      for (const byte of frame) this.ring[written++ % RING] = byte;
      this.pending.shift();
    }
    Atomics.store(this.control, 0, written);
    Atomics.notify(this.control, 0);
  }
}
