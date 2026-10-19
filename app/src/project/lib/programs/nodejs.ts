// node: Node.js scripts on the page's own JavaScript engine, each process
// in a worker of its own (runtime/nodejs, nodejs.js) with a channel to the
// shared files, as a node has. Its output is the process's, and its exit
// status; closing the port (Ctrl+C) stops the worker.
//
// A port the process listens on is the page's to route (`ports`), as a
// node's is: the preview and the project's nodes connect to it here, and
// the connection's bytes go to the process as messages (nodejs/net.ts).
import type { Files } from '@/runtime/host/files';
import type { CloseReason, Link } from '@/runtime/host/node';
import { worker } from '@/runtime/host/worker';
import type { Context, Process } from './tailwind';

// What listens on a port: connections to it.
export interface Listener {
  connect(port: number): Link;
}

// The project's ports (playground.ts): listen takes `port`, or (0) a free
// one, and answers it, or null when it is taken.
export interface Ports {
  listen(port: number, listener: Listener): number | null;
  unlisten(port: number, listener: Listener): void;
}

// The page's end of a connection to a process's listener.
class ScriptConnection implements Link {
  ondata: (bytes: Uint8Array) => void = () => {};
  onend: () => void = () => {};
  onclose: (why?: CloseReason) => void = () => {};
  closed = false;

  constructor(
    private thread: Worker,
    public id: number,
    private forget: (id: number) => void,
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
  | { kind: 'net'; op: 'data'; id: number; bytes: Uint8Array }
  | { kind: 'net'; op: 'end' | 'close'; id: number };

export const nodeProgram =
  (base: string, files: () => Files | null, ports?: Ports) =>
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
        const connection = new ScriptConnection(thread, (next += 2), forget);
        connections.set(connection.id, connection);
        thread.postMessage({ kind: 'net', op: 'open', id: connection.id, port });
        return connection;
      },
    };
    const listening = new Set<number>();
    const network = (message: NetMessage) => {
      if (message.op === 'listen') {
        const port = ports?.listen(message.port, listener) ?? null;
        if (port !== null) listening.add(port);
        thread.postMessage({ kind: 'net', op: 'listening', ref: message.ref, port });
      } else if (message.op === 'unlisten') {
        listening.delete(message.port);
        ports?.unlisten(message.port, listener);
      } else {
        const connection = connections.get(message.id);
        if (!connection) return;
        if (message.op === 'data') connection.ondata(message.bytes);
        else if (message.op === 'end') connection.onend();
        else connection.closedBy('close');
      }
    };
    let done = false;
    const stop = (code: number) => {
      if (done) return;
      done = true;
      thread.terminate();
      shared.disconnect(channel);
      for (const port of listening) ports?.unlisten(port, listener);
      for (const connection of [...connections.values()]) connection.closedBy('close');
      process.exit(code);
    };
    thread.onmessage = ({ data }) => {
      if (data.kind === 'out') process.write(data.bytes);
      else if (data.kind === 'net') network(data);
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
    });
  };
