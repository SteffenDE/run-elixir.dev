// node:dgram on the project's UDP: a process's ports are the exec frame's
// to route (programs/nodejs.ts), as a node's are, so datagrams go between
// processes and the project's nodes as between processes on one machine,
// to the node's DNS on 53, and to other hosts through the user's tailnet
// (docs/tailscale.md; dropped without it).
//
// The process tells the host { kind: 'net', op: 'udp-bind', ref, port }
// and hears { op: 'udp-bound', ref, port } (null when it is taken); it
// sends { op: 'udp-send', from, address, port, bytes } (an address: a name
// is looked up first) and closes with { op: 'udp-close', port }. A
// datagram for it comes as { op: 'udp', to, address, port, bytes }.
import { Buffer } from './buffer';
import { EventEmitter } from 'events';
import type { Dns } from './dns';

type Hold = () => () => void;
type Bytes = Buffer | Uint8Array | string | DataView;

export type DgramMessage =
  | { kind: 'net'; op: 'udp-bound'; ref: number; port: number | null }
  | { kind: 'net'; op: 'udp'; to: number; address: string; port: number; bytes: Uint8Array };

const LOOPBACK = (family: 4 | 6) => (family === 6 ? '::1' : '127.0.0.1');

const error = (code: string, syscall: string, message: string) =>
  Object.assign(new Error(`${syscall} ${code}${message ? ` ${message}` : ''}`), {
    code,
    syscall,
  });

const bytesOf = (data: Bytes | Bytes[]): Uint8Array => {
  if (Array.isArray(data)) {
    const parts = data.map(bytesOf);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof DataView)
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
};

export function createDgram(post: (message: unknown) => void, hold: Hold, dns: Dns) {
  const sockets = new Map<number, Socket>();
  const asked = new Map<number, (port: number | null) => void>();
  let ref = 0;

  class Socket extends EventEmitter {
    declare family: 4 | 6;
    declare port: number | null;
    declare binding: Promise<number | null> | null;
    declare peer: { address: string; port: number } | null;
    declare release: (() => void) | null;
    declare referenced: boolean;
    declare closed: boolean;

    constructor(type: string | { type?: string }, listener?: (...a: unknown[]) => void) {
      super();
      const kind = typeof type === 'string' ? type : type?.type;
      if (kind !== 'udp4' && kind !== 'udp6')
        throw Object.assign(
          new TypeError(`Bad socket type specified. Valid types are: udp4, udp6`),
          {
            code: 'ERR_SOCKET_BAD_TYPE',
          },
        );
      this.family = kind === 'udp6' ? 6 : 4;
      this.port = null;
      this.binding = null;
      this.peer = null;
      this.release = null;
      this.referenced = true;
      this.closed = false;
      if (listener) this.on('message', listener);
    }

    // bind(port?, address?, callback?) or bind({ port }, callback?).
    bind(...args: unknown[]) {
      const callback = typeof args.at(-1) === 'function' ? (args.pop() as () => void) : null;
      if (this.binding) throw error('ERR_SOCKET_ALREADY_BOUND', 'bind', 'Socket is already bound');
      const port = Number(
        (args[0] && typeof args[0] === 'object' ? (args[0] as { port?: number }).port : args[0]) ??
          0,
      );
      if (callback) this.once('listening', callback);
      this.binding = new Promise((resolve) => {
        const id = ++ref;
        const release = hold();
        asked.set(id, (bound) => {
          release();
          resolve(bound);
        });
        post({ kind: 'net', op: 'udp-bind', ref: id, port });
      });
      void this.binding.then((bound) => {
        if (this.closed) {
          if (bound !== null) post({ kind: 'net', op: 'udp-close', port: bound });
          return;
        }
        if (bound === null) {
          this.emit('error', Object.assign(error('EADDRINUSE', 'bind', ''), { port }));
          return;
        }
        this.port = bound;
        sockets.set(bound, this);
        if (this.referenced) this.release = hold();
        this.emit('listening');
      });
      return this;
    }

    // A port to send from: bound now, if it was not (as Node binds a
    // socket that sends first).
    bound(): Promise<number | null> {
      if (!this.binding) this.bind(0);
      return this.binding!;
    }

    // The address of a name, or the loopback for none.
    async addressOf(address: string | undefined): Promise<string> {
      if (!address) return LOOPBACK(this.family);
      const found = (await dns.promises.lookup(address, { family: this.family })) as {
        address: string;
      };
      return found.address;
    }

    // send(msg, [offset, length,] [port, address,] callback?).
    send(message: Bytes | Bytes[], ...args: unknown[]) {
      const callback =
        typeof args.at(-1) === 'function'
          ? (args.pop() as (error: Error | null, bytes?: number) => void)
          : null;
      let bytes = bytesOf(message);
      if (typeof args[0] === 'number' && typeof args[1] === 'number' && args.length >= 2) {
        if (args.length > 2 || this.peer) {
          bytes = bytes.subarray(args[0], args[0] + (args[1] as number));
          args = args.slice(2);
        }
      }
      if (this.closed) throw error('ERR_SOCKET_DGRAM_NOT_RUNNING', 'send', 'Not running');
      const to = this.peer
        ? Promise.resolve(this.peer)
        : this.addressOf(args[1] as string | undefined).then((address) => ({
            address,
            port: Number(args[0]),
          }));
      const release = hold();
      void Promise.all([this.bound(), to]).then(
        ([from, { address, port }]) => {
          release();
          if (from === null || this.closed) return;
          post({ kind: 'net', op: 'udp-send', from, address, port, bytes });
          callback?.(null, bytes.length);
        },
        (failed: Error) => {
          release();
          if (callback) callback(failed);
          else this.emit('error', failed);
        },
      );
    }

    connect(port: number, ...args: unknown[]) {
      const callback = typeof args.at(-1) === 'function' ? (args.pop() as () => void) : null;
      if (this.peer) throw error('ERR_SOCKET_DGRAM_IS_CONNECTED', 'connect', 'Already connected');
      if (callback) this.once('connect', callback);
      void Promise.all([this.bound(), this.addressOf(args[0] as string | undefined)]).then(
        ([, address]) => {
          this.peer = { address, port };
          this.emit('connect');
        },
        (failed: Error) => this.emit('error', failed),
      );
    }

    disconnect() {
      if (!this.peer) throw error('ERR_SOCKET_DGRAM_NOT_CONNECTED', 'disconnect', 'Not connected');
      this.peer = null;
    }

    remoteAddress() {
      if (!this.peer) throw error('ERR_SOCKET_DGRAM_NOT_CONNECTED', 'getpeername', 'Not connected');
      return { ...this.peer, family: this.peer.address.includes(':') ? 'IPv6' : 'IPv4' };
    }

    address() {
      if (this.port === null) throw error('EBADF', 'getsockname', '');
      const address = this.family === 6 ? '::' : '0.0.0.0';
      return { address, family: this.family === 6 ? 'IPv6' : 'IPv4', port: this.port };
    }

    // A datagram for the socket's port.
    receive(address: string, port: number, bytes: Uint8Array) {
      if (this.peer && (this.peer.port !== port || this.peer.address !== address)) return;
      const family = address.includes(':') ? 'IPv6' : 'IPv4';
      this.emit('message', Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length), {
        address,
        family,
        port,
        size: bytes.length,
      });
    }

    close(callback?: () => void) {
      if (this.closed) throw error('ERR_SOCKET_DGRAM_NOT_RUNNING', 'close', 'Not running');
      this.closed = true;
      if (callback) this.once('close', callback);
      if (this.port !== null) {
        post({ kind: 'net', op: 'udp-close', port: this.port });
        sockets.delete(this.port);
      }
      this.release?.();
      this.release = null;
      queueMicrotask(() => this.emit('close'));
      return this;
    }

    ref() {
      this.referenced = true;
      if (this.port !== null && !this.closed) this.release ??= hold();
      return this;
    }

    unref() {
      this.referenced = false;
      this.release?.();
      this.release = null;
      return this;
    }

    setBroadcast() {}
    setTTL(ttl: number) {
      return ttl;
    }
    setMulticastTTL(ttl: number) {
      return ttl;
    }
    setMulticastLoopback(on: boolean) {
      return on;
    }
    setMulticastInterface() {}
    addMembership() {}
    dropMembership() {}
    setRecvBufferSize() {}
    setSendBufferSize() {}
    getRecvBufferSize() {
      return 212992;
    }
    getSendBufferSize() {
      return 212992;
    }
    [Symbol.asyncDispose]() {
      return new Promise<void>((resolve) => (this.closed ? resolve() : this.close(resolve)));
    }
  }

  // What the exec frame says.
  const receive = (message: DgramMessage) => {
    if (message.op === 'udp-bound') {
      const answer = asked.get(message.ref);
      asked.delete(message.ref);
      answer?.(message.port);
    } else sockets.get(message.to)?.receive(message.address, message.port, message.bytes);
  };

  const module = {
    Socket,
    createSocket: (type: string | { type?: string }, listener?: (...a: unknown[]) => void) =>
      new Socket(type, listener),
  };
  return { module, receive };
}

export type Dgram = ReturnType<typeof createDgram>;
