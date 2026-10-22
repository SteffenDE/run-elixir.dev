// node: Node.js scripts on the browser's own JavaScript engine, each
// process in a worker of its own (runtime/nodejs, nodejs.js) with a
// channel to the shared files, as a node has. Its output is the process's,
// and its exit status; closing the port (Ctrl+C) stops the worker.
//
// A port the process listens on is the exec frame's to route (`ports`),
// as a node's is: the preview and the project's nodes connect to it here,
// and the connection's bytes go to the process as messages
// (nodejs/net.ts). A connection the process makes goes where a node's
// would: to the services (Postgres), another process's port, a node's, or
// another host through the tailnet; its DNS messages to the node's DNS.
// Its UDP ports are the exec frame's too (`ports.udp()`), as a node's are.
// What changes in the files goes to it too, for fs.watch. Its children
// (child_process) are command lines the page program sh runs.
//
// Its worker starts from nodejs.js's own URL, not a blob (host/worker.ts):
// a worker from a URL keeps the Content-Security-Policy its script was
// served with (serve.py, Caddy), which reaches only the site's files, and
// the threads it starts from blobs inherit it. So the process's code has
// no network but this one's messages, whatever browser API it calls
// (docs/nodejs.md, The worker's policy).
import type { Files } from '@/runtime/host/files';
import type { CloseReason, Link, Served } from '@/runtime/host/node';
import type { Context, Process } from './tailwind';
import { watchers, type Watcher } from './watch';

// What listens on a port: connections to it.
export interface Listener {
  connect(port: number): Link;
}

// The project's ports (exec/host.ts): listen takes `port`, or (0) a free
// one, and answers it, or null when it is taken; route answers what takes
// a connection to `port` (with `host`: HTTPS carried there by fetch), or
// null when nothing listens there; dial connects `connection` to another
// host's `address` (through the tailnet), answering this end's address
// there, or failing with the error's `code` (ENETUNREACH, …), and resets
// it if it breaks off; resolve
// answers a DNS message; udp gives a process its UDP ports.
export interface Ports {
  listen(port: number, listener: Listener): number | null;
  unlisten(port: number, listener: Listener): void;
  route(port: number, host?: string): ((connection: Served) => void) | null;
  dial(
    connection: Served & { reset(): void },
    address: string,
    port: number,
  ): Promise<string | undefined>;
  resolve(query: Uint8Array): Promise<Uint8Array>;
  udp(): UdpPorts;
}

// A datagram for a process's UDP port, from `address`:`port`.
export type Deliver = (address: string, port: number, bytes: Uint8Array) => void;

// A process's UDP ports: bind takes `port`, or (0) a free one, and
// answers it, or null when it is taken; send goes from a bound port to
// `address` (an address, not a name); close lets them all go.
export interface UdpPorts {
  bind(port: number, deliver: Deliver): number | null;
  unbind(port: number): void;
  send(datagram: { from: number; address: string; port: number; bytes: Uint8Array }): void;
  close(): void;
}

// The page's end of a connection with a process: to its listener, or one
// it made (`node`: the process, for the page's services).
class ScriptConnection implements Served {
  ondata: (bytes: Uint8Array) => void = () => {};
  onend: () => void = () => {};
  onclose: (why?: CloseReason) => void = () => {};
  closed = false;

  constructor(
    private thread: Worker,
    public id: number,
    private forget: (id: number) => void,
    public node: object,
  ) {}
  write(bytes: Uint8Array): void {
    if (!this.closed) this.thread.postMessage({ kind: 'net', op: 'data', id: this.id, bytes });
  }
  end(): void {
    if (!this.closed) this.thread.postMessage({ kind: 'net', op: 'end', id: this.id });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.forget(this.id);
    this.thread.postMessage({ kind: 'net', op: 'close', id: this.id });
  }
  // It broke off on the way (a dialed one's tunnel): the process's
  // socket fails with ECONNRESET.
  reset(): void {
    if (this.closed) return;
    this.closed = true;
    this.forget(this.id);
    this.thread.postMessage({ kind: 'net', op: 'reset', id: this.id });
  }
  // The process closed it, or ended.
  closedBy(why: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.forget(this.id);
    this.onclose(why);
  }
}

type NetMessage =
  | { kind: 'net'; op: 'listen'; ref: number; port: number }
  | { kind: 'net'; op: 'unlisten'; port: number }
  | { kind: 'net'; op: 'connect'; id: number; port: number; host?: string; via?: 'tcp' | 'https' }
  | { kind: 'net'; op: 'dns'; ref: number; query: Uint8Array }
  | { kind: 'net'; op: 'data'; id: number; bytes: Uint8Array }
  | { kind: 'net'; op: 'end' | 'close'; id: number }
  | { kind: 'net'; op: 'udp-bind'; ref: number; port: number }
  | { kind: 'net'; op: 'udp-send'; from: number; address: string; port: number; bytes: Uint8Array }
  | { kind: 'net'; op: 'udp-close'; port: number };

// A page program, as programs() answers them (npm.ts's Program).
type PageProgram = (process: Process, context: Context) => void | Promise<void>;

export const nodeProgram =
  (
    base: string,
    files: () => Files | null,
    ports?: Ports,
    runtime = base,
    programs: () => Record<string, PageProgram> = () => ({}),
  ) =>
  (process: Process, context: Context): void => {
    const shared = files();
    if (!shared) {
      process.write('node: no files\n');
      return process.exit(1);
    }
    const channel = shared.connect();
    const thread = new Worker(new URL('nodejs.js', new URL(base, location.href)), {
      type: 'module',
    });
    const connections = new Map<number, ScriptConnection>();
    const forget = (id: number) => connections.delete(id);
    let next = 1;
    const listener: Listener = {
      connect(port) {
        const connection = new ScriptConnection(thread, (next += 2), forget, listener);
        connections.set(connection.id, connection);
        thread.postMessage({ kind: 'net', op: 'open', id: connection.id, port });
        return connection;
      },
    };
    const listening = new Set<number>();
    let udp: UdpPorts | null = null;
    const network = (message: NetMessage) => {
      if (message.op === 'udp-bind') {
        udp ??= ports?.udp() ?? null;
        const port =
          udp?.bind(message.port, (address, from, bytes) =>
            thread.postMessage({ kind: 'net', op: 'udp', to: port, address, port: from, bytes }),
          ) ?? null;
        thread.postMessage({ kind: 'net', op: 'udp-bound', ref: message.ref, port });
      } else if (message.op === 'udp-send') {
        udp?.send(message);
      } else if (message.op === 'udp-close') {
        udp?.unbind(message.port);
      } else if (message.op === 'listen') {
        const port = ports?.listen(message.port, listener) ?? null;
        if (port !== null) listening.add(port);
        thread.postMessage({ kind: 'net', op: 'listening', ref: message.ref, port });
      } else if (message.op === 'unlisten') {
        listening.delete(message.port);
        ports?.unlisten(message.port, listener);
      } else if (message.op === 'dns') {
        const answer = (bytes: Uint8Array) =>
          thread.postMessage({ kind: 'net', op: 'dns', ref: message.ref, answer: bytes });
        if (!ports) return answer(new Uint8Array(0));
        void ports.resolve(message.query).then(answer, () => answer(new Uint8Array(0)));
      } else if (message.op === 'connect' && message.via === 'tcp' && message.host) {
        const connection = new ScriptConnection(thread, message.id, forget, listener);
        connections.set(message.id, connection);
        const refused = (code: string) => {
          forget(message.id);
          thread.postMessage({ kind: 'net', op: 'refused', id: message.id, code });
        };
        if (!ports) return refused('ENETUNREACH');
        ports.dial(connection, message.host, message.port).then(
          (local) => thread.postMessage({ kind: 'net', op: 'connected', id: message.id, local }),
          (error: Error & { code?: string }) => refused(error.code ?? 'EHOSTUNREACH'),
        );
      } else if (message.op === 'connect') {
        const take = ports?.route(message.port, message.host) ?? null;
        thread.postMessage({ kind: 'net', op: take ? 'connected' : 'refused', id: message.id });
        if (!take) return;
        const connection = new ScriptConnection(thread, message.id, forget, listener);
        connections.set(message.id, connection);
        take(connection);
      } else {
        const connection = connections.get(message.id);
        if (!connection) return;
        if (message.op === 'data') connection.ondata(message.bytes);
        else if (message.op === 'end') connection.onend();
        else connection.closedBy('close');
      }
    };
    const changed: Watcher = (paths) => thread.postMessage({ kind: 'changed', paths });
    watchers.add(changed);
    let done = false;
    // The process's children: each a sh -c line, its output and status
    // back to the process.
    // A synchronous one (spawnSync, execSync) writes into `shared`, whose
    // first three ints are [done, status, length] (length -1: more than
    // it holds, ENOBUFS), the bytes after; the process waits on done. With
    // `inherit`, its output is the process's own, as it comes.
    const children = new Map<number, Process>();
    const spawned = (message: {
      id: number;
      line: string;
      cwd: string;
      env: Record<string, string>;
      input?: Uint8Array;
      shared?: SharedArrayBuffer;
      inherit?: boolean;
    }) => {
      const { id, shared: result } = message;
      const header = result ? new Int32Array(result, 0, 3) : null;
      const room = result ? new Uint8Array(result, 12) : null;
      let length = 0;
      let ended = false;
      const encode = (data: string | Uint8Array) =>
        typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const child: Process = {
        write: (data) => {
          const bytes = encode(data);
          if (message.inherit) process.write(bytes);
          else if (room) {
            if (length < 0 || length + bytes.length > room.length) length = -1;
            else {
              room.set(bytes, length);
              length += bytes.length;
            }
          } else thread.postMessage({ kind: 'child', op: 'out', id, bytes });
        },
        exit: (code = 0) => {
          if (ended) return;
          ended = true;
          children.delete(id);
          if (header) {
            Atomics.store(header, 1, code);
            Atomics.store(header, 2, length);
            Atomics.store(header, 0, 1);
            Atomics.notify(header, 0);
          } else thread.postMessage({ kind: 'child', op: 'exit', id, code });
        },
        onkill: null,
        onowner: null,
      };
      children.set(id, child);
      const sh = programs().sh;
      if (!sh) {
        child.write('sh: not in this playground\n');
        return child.exit(127);
      }
      Promise.resolve(
        sh(child, { args: ['-c', message.line], cwd: message.cwd, env: message.env, fs: shared }),
      ).catch((error: Error) => {
        child.write(`${error.message}\n`);
        child.exit(1);
      });
      // What it reads, given whole (spawnSync's input), then its end.
      if (message.input) {
        if (message.input.length) child.oninput?.(message.input);
        child.oninput?.(null);
      }
    };
    // child.kill(): its node stops (sh's outlives a closed port, as a
    // node's port's program does), its status a SIGTERM's.
    const killed = (id: number) => {
      const child = children.get(id);
      if (!child) return;
      child.onowner?.();
      child.exit(143);
    };
    const stop = (code: number) => {
      if (done) return;
      done = true;
      for (const child of [...children.values()]) child.onowner?.();
      watchers.delete(changed);
      thread.terminate();
      shared.disconnect(channel);
      for (const port of listening) ports?.unlisten(port, listener);
      udp?.close();
      for (const connection of [...connections.values()]) connection.closedBy('close');
      process.exit(code);
    };
    thread.onmessage = ({ data }) => {
      if (data.kind === 'out') process.write(data.bytes);
      else if (data.kind === 'net') network(data);
      // setRawMode: keys as typed, Ctrl+C one of them.
      else if (data.kind === 'tty') process.raw?.(data.raw, !data.raw);
      else if (data.kind === 'child' && data.op === 'spawn') spawned(data);
      else if (data.kind === 'child' && data.op === 'kill') killed(data.id);
      // What it writes to the child's stdin (null: its end).
      else if (data.kind === 'child' && data.op === 'stdin')
        children.get(data.id)?.oninput?.(data.end ? null : data.bytes);
      else if (data.kind === 'exit') stop(data.code);
    };
    thread.onerror = (event) => {
      event.preventDefault();
      process.write(`node: ${event.message || 'the worker failed to start'}\n`);
      stop(1);
    };
    process.onkill = () => stop(130);
    process.onowner = () => stop(130);
    thread.postMessage({
      kind: 'start',
      args: context.args,
      cwd: context.cwd,
      env: context.env,
      doorbell: channel.doorbell,
      channel: channel.channel,
      runtime: new URL(runtime, location.href).href,
      tty: context.tty?.stdout ?? false,
      stdinTty: context.tty?.stdin ?? false,
      bun: context.bun ?? false,
      columns: process.size?.()[0] ?? 80,
      rows: process.size?.()[1] ?? 24,
    });
    // What it reads, and the terminal's size as it changes.
    process.oninput = (bytes) =>
      thread.postMessage(bytes === null ? { kind: 'stdin', end: true } : { kind: 'stdin', bytes });
    process.onresize = (columns, rows) => thread.postMessage({ kind: 'resize', columns, rows });
  };
