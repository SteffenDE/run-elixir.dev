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
import type { Files } from '@/runtime/host/files';
import type { CloseReason, Link, Served } from '@/runtime/host/node';
import { worker } from '@/runtime/host/worker';
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
// there, or failing with the error's `code` (ENETUNREACH, …); resolve
// answers a DNS message; udp gives a process its UDP ports.
export interface Ports {
  listen(port: number, listener: Listener): number | null;
  unlisten(port: number, listener: Listener): void;
  route(port: number, host?: string): ((connection: Served) => void) | null;
  dial(connection: Served, address: string, port: number): Promise<string | undefined>;
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
    const thread = worker('nodejs.js', base);
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
    const children = new Map<number, Process>();
    const spawned = (message: {
      id: number;
      line: string;
      cwd: string;
      env: Record<string, string>;
    }) => {
      const { id } = message;
      let ended = false;
      const child: Process = {
        write: (data) =>
          thread.postMessage({
            kind: 'child',
            op: 'out',
            id,
            bytes: typeof data === 'string' ? new TextEncoder().encode(data) : data,
          }),
        exit: (code = 0) => {
          if (ended) return;
          ended = true;
          children.delete(id);
          thread.postMessage({ kind: 'child', op: 'exit', id, code });
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
      else if (data.kind === 'child' && data.op === 'spawn') spawned(data);
      else if (data.kind === 'child' && data.op === 'kill') children.get(data.id)?.onkill?.();
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
    });
  };
