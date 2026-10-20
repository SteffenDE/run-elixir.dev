// node:net on the project's TCP: a process's listeners and connections
// are the exec frame's to route (programs/nodejs.ts), as a node's are, so
// the preview and the project's other processes reach a port a script
// listens on, and a script reaches theirs and the services (Postgres);
// other hosts through the user's tailnet (docs/tailscale.md).
//
// The process tells the host { kind: 'net', op: 'listen', ref, port } and
// hears { op: 'listening', ref, port } (null when the port is taken);
// a connection comes as { op: 'open', id, port } (odd ids). The process
// connects with { op: 'connect', id, port } (even ids); { op: 'connect',
// id, port, host, via: 'tcp' } to another host's address, through the
// tailnet; or { ..., via: 'https' } for HTTPS carried to a host by fetch
// (http.ts's https: the gateway's line, then plain HTTP on the
// connection, as a node's goes). It hears { op: 'connected', id, local? }
// or { op: 'refused', id, code? }. Then { op: 'data', id, bytes },
// { op: 'end', id } and { op: 'close', id } go both ways, and { op:
// 'unlisten', port } stops a listener. A DNS message goes as { op: 'dns',
// ref, query } and its answer comes as { op: 'dns', ref, answer }.
import { Buffer } from './buffer';
import { createDns } from './dns';
import { EventEmitter } from 'events';
import * as streams from 'readable-stream';

const { Duplex } = streams as typeof import('node:stream');

export type NetMessage =
  | { kind: 'net'; op: 'listening'; ref: number; port: number | null }
  | { kind: 'net'; op: 'open'; id: number; port: number }
  | { kind: 'net'; op: 'data'; id: number; bytes: Uint8Array }
  | { kind: 'net'; op: 'connected'; id: number; local?: string }
  | { kind: 'net'; op: 'refused'; id: number; code?: string }
  | { kind: 'net'; op: 'dns'; ref: number; answer: Uint8Array }
  | { kind: 'net'; op: 'end' | 'close'; id: number };

type Hold = () => () => void;

interface Address {
  address: string;
  family: string;
  port: number;
}

const isIPv4 = (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s);
// The machine's own names: what a connection reaches.
const LOCAL = new Set(['', 'localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
const isLocal = (host: string) => LOCAL.has(host) || host.endsWith('.localhost');
const isIPv6 = (s: string) => s.includes(':');

const ERRNOS: Record<string, number> = {
  EADDRINUSE: -98,
  ECONNREFUSED: -111,
  ENETUNREACH: -101,
  EHOSTUNREACH: -113,
  ETIMEDOUT: -110,
};
const MESSAGES: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ENETUNREACH: 'network is unreachable',
  EHOSTUNREACH: 'no route to host',
  ETIMEDOUT: 'connection timed out',
};

const netError = (
  code: string,
  syscall: string,
  port: number,
  message: string,
  address = '127.0.0.1',
) =>
  Object.assign(new Error(`${syscall} ${code}: ${message}`), {
    code,
    errno: ERRNOS[code] ?? -111,
    syscall,
    address,
    port,
  });

export function createNet(post: (message: unknown) => void, hold: Hold) {
  const sockets = new Map<number, Socket>();
  const servers = new Map<number, Server>();
  const asked = new Map<number, (port: number | null) => void>();
  const queries = new Map<number, (answer: Uint8Array) => void>();
  let ref = 0;
  // The node's DNS (runtime/dns.ts), a message at a time; the wait holds
  // the loop, as a lookup under way does.
  const query = (message: Uint8Array) =>
    new Promise<Uint8Array>((resolve) => {
      const id = ++ref;
      const release = hold();
      queries.set(id, (answer) => {
        release();
        resolve(answer);
      });
      post({ kind: 'net', op: 'dns', ref: id, query: message });
    });
  const dns = createDns(query);
  // The ids of connections the process makes.
  let nextId = 0;

  // A connection: the page's end of it is `id`.
  class Socket extends Duplex {
    declare id: number;
    declare localPort: number;
    declare remotePort: number;
    declare remoteAddress: string;
    declare remoteFamily: string;
    declare localAddress: string;
    declare server: Server | null;
    declare connecting: boolean;
    declare bytesRead: number;
    declare bytesWritten: number;
    declare release: (() => void) | null;
    declare timer: ReturnType<typeof setTimeout> | null;
    declare timeout: number;
    // HTTPS by the gateway: its first line still to come (what of it came).
    declare gateway: string | null;

    constructor(options: { id?: number; port?: number; allowHalfOpen?: boolean } = {}) {
      super({ allowHalfOpen: options.allowHalfOpen ?? false, decodeStrings: true });
      this.id = options.id ?? 0;
      this.localPort = options.port ?? 0;
      this.remotePort = 49152 + Math.floor(Math.random() * 16384);
      this.remoteAddress = '127.0.0.1';
      this.remoteFamily = 'IPv4';
      this.localAddress = '127.0.0.1';
      this.server = null;
      this.connecting = false;
      this.bytesRead = 0;
      this.bytesWritten = 0;
      this.release = this.id ? hold() : null;
      this.timer = null;
      this.timeout = 0;
      this.gateway = null;
      if (this.id) sockets.set(this.id, this);
      this.on('close', () => {
        sockets.delete(this.id);
        this.release?.();
        this.release = null;
        if (this.timer) clearTimeout(this.timer);
      });
    }
    // connect(port, host?, listener?) or connect({ port, host }, listener?).
    connect(...args: unknown[]) {
      const listener = typeof args.at(-1) === 'function' ? (args.pop() as () => void) : null;
      const options = (
        args[0] && typeof args[0] === 'object'
          ? args[0]
          : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined }
      ) as { port?: unknown; host?: string; path?: string; timeout?: number; https?: boolean };
      if (listener) this.once('connect', listener);
      if (options.timeout) this.setTimeout(options.timeout);
      const port = Number(options.port);
      const host = options.host ?? 'localhost';
      this.connecting = true;
      // https: HTTPS to any host, which the exec frame carries (not a
      // socket's own bytes to the host: http.ts's https alone asks for it).
      const https = Boolean(options.https);
      if (options.path !== undefined || !(port > 0 && port < 65536)) {
        const error =
          options.path !== undefined
            ? netError('ENOENT', 'connect', 0, 'no Unix sockets in the playground')
            : Object.assign(new RangeError(`Port should be > 0 and < 65536. Received ${port}.`), {
                code: 'ERR_SOCKET_BAD_PORT',
              });
        queueMicrotask(() => this.destroy(error));
        return this;
      }
      this.id = nextId += 2;
      this.remotePort = port;
      this.localPort = 49152 + Math.floor(Math.random() * 16384);
      this.release ??= hold();
      sockets.set(this.id, this);
      if (https) {
        this.gateway = '';
        post({ kind: 'net', op: 'connect', id: this.id, port, host, via: 'https' });
      } else if (isLocal(host)) post({ kind: 'net', op: 'connect', id: this.id, port });
      else {
        // Another host: its address first (as Node looks a name up), then
        // a connection there through the tailnet.
        const id = this.id;
        (dns.promises.lookup(host) as Promise<{ address: string; family: number }>).then(
          ({ address, family }) => {
            if (this.destroyed) return;
            this.remoteAddress = address;
            this.remoteFamily = family === 6 ? 'IPv6' : 'IPv4';
            this.emit('lookup', null, address, family, host);
            if (isLocal(address)) post({ kind: 'net', op: 'connect', id, port });
            else post({ kind: 'net', op: 'connect', id, port, host: address, via: 'tcp' });
          },
          (error: Error) => {
            sockets.delete(id);
            this.emit('lookup', error);
            this.destroy(error);
          },
        );
      }
      return this;
    }
    // The answer to connect: this end's address there (`local`), or why
    // not (`code`).
    connected(ok: boolean, local?: string, code = 'ECONNREFUSED') {
      this.connecting = false;
      if (!ok) {
        sockets.delete(this.id);
        this.destroy(
          netError(
            code,
            'connect',
            this.remotePort,
            MESSAGES[code] ?? code.toLowerCase(),
            this.remoteAddress,
          ),
        );
        return;
      }
      if (local) {
        const at = local.lastIndexOf(':');
        this.localAddress = local.slice(0, at).replace(/^\[|\]$/g, '');
        this.localPort = Number(local.slice(at + 1));
      }
      if (this.gateway === null) {
        this.emit('connect');
        this.emit('ready');
      }
    }
    // From the other end; for HTTPS by the gateway, its first line
    // ("fetch", or "error REASON") before.
    receive(bytes: Uint8Array) {
      if (this.gateway !== null) {
        const text = this.gateway + new TextDecoder().decode(bytes);
        const end = text.indexOf('\n');
        if (end < 0) {
          this.gateway = text;
          return;
        }
        this.gateway = null;
        const line = text.slice(0, end);
        if (line !== 'fetch') {
          const code = (line.match(/^error (\w+)/)?.[1] ?? 'ehostunreach').toUpperCase();
          this.destroy(
            netError(code, 'connect', this.remotePort, MESSAGES[code] ?? code.toLowerCase()),
          );
          return;
        }
        this.emit('connect');
        this.emit('ready');
        const rest = new TextEncoder().encode(text.slice(end + 1));
        if (!rest.length) return;
        bytes = rest;
      }
      this.bytesRead += bytes.length;
      this.touch();
      this.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    }
    _read() {}
    // Written, or ended, before the page answered: once it has.
    _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
      if (this.pending) this.once('connect', () => this.send(chunk, callback));
      else this.send(chunk, callback);
    }
    _final(callback: (error?: Error | null) => void) {
      if (this.pending) this.once('connect', () => this.finish(callback));
      else this.finish(callback);
    }
    send(chunk: Buffer, callback: (error?: Error | null) => void) {
      this.bytesWritten += chunk.length;
      this.touch();
      post({ kind: 'net', op: 'data', id: this.id, bytes: new Uint8Array(chunk) });
      callback();
    }
    finish(callback: (error?: Error | null) => void) {
      post({ kind: 'net', op: 'end', id: this.id });
      callback();
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void) {
      if (sockets.has(this.id)) post({ kind: 'net', op: 'close', id: this.id });
      sockets.delete(this.id);
      callback(error);
    }
    get readyState() {
      return this.destroyed ? 'closed' : 'open';
    }
    get pending() {
      return this.connecting || this.gateway !== null || !this.id;
    }
    get bufferSize() {
      return this.writableLength;
    }
    address(): Address {
      const family = this.localAddress.includes(':') ? 'IPv6' : 'IPv4';
      return { address: this.localAddress, family, port: this.localPort };
    }
    setNoDelay() {
      return this;
    }
    setKeepAlive() {
      return this;
    }
    setEncoding(encoding: BufferEncoding) {
      super.setEncoding(encoding);
      return this;
    }
    // Node's idle timeout: 'timeout' after `ms` without traffic.
    setTimeout(ms: number, callback?: () => void) {
      this.timeout = ms;
      if (callback) this.once('timeout', callback);
      this.touch();
      return this;
    }
    touch() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (this.timeout > 0 && !this.destroyed) {
        this.timer = setTimeout(() => this.emit('timeout'), this.timeout);
        (this.timer as unknown as { unref?: () => void }).unref?.();
      }
    }
    ref() {
      if (!this.destroyed) this.release ??= hold();
      return this;
    }
    unref() {
      this.release?.();
      this.release = null;
      return this;
    }
    resetAndDestroy() {
      return this.destroy();
    }
  }

  // A listener: the page takes its port, and hands it connections.
  class Server extends EventEmitter {
    declare port: number | null;
    declare connections: Set<Socket>;
    declare release: (() => void) | null;
    declare referenced: boolean;
    declare maxConnections: number;
    declare allowHalfOpen: boolean;

    constructor(
      options?: { allowHalfOpen?: boolean } | ((socket: Socket) => void),
      listener?: (socket: Socket) => void,
    ) {
      super();
      if (typeof options === 'function') [listener, options] = [options, {}];
      this.allowHalfOpen = options?.allowHalfOpen ?? false;
      this.port = null;
      this.connections = new Set();
      this.release = null;
      this.referenced = true;
      this.maxConnections = Infinity;
      if (listener) this.on('connection', listener);
    }
    get listening() {
      return this.port !== null;
    }
    // listen(port?, host?, backlog?, callback?) or listen({ port, host },
    // callback?).
    listen(...args: unknown[]) {
      const callback = typeof args.at(-1) === 'function' ? (args.pop() as () => void) : null;
      let port: unknown = args[0];
      if (port && typeof port === 'object') port = (port as { port?: unknown }).port;
      if (typeof port === 'string' && !/^\d+$/.test(port)) {
        queueMicrotask(() =>
          this.emit('error', netError('EACCES', 'listen', 0, 'no Unix sockets in the playground')),
        );
        return this;
      }
      const asking = Number(port ?? 0);
      if (callback) this.once('listening', callback);
      const id = ++ref;
      // The answer's wait holds the loop, as a listen under way does.
      const release = hold();
      asked.set(id, (bound) => {
        release();
        if (bound === null) {
          this.emit('error', netError('EADDRINUSE', 'listen', asking, 'address already in use'));
          return;
        }
        this.port = bound;
        servers.set(bound, this);
        if (this.referenced) this.release = hold();
        this.emit('listening');
      });
      post({ kind: 'net', op: 'listen', ref: id, port: asking });
      return this;
    }
    address(): Address | null {
      return this.port === null ? null : { address: '127.0.0.1', family: 'IPv4', port: this.port };
    }
    close(callback?: (error?: Error) => void) {
      if (this.port === null) {
        const error = Object.assign(new Error('Server is not running.'), {
          code: 'ERR_SERVER_NOT_RUNNING',
        });
        if (callback) queueMicrotask(() => callback(error));
        return this;
      }
      post({ kind: 'net', op: 'unlisten', port: this.port });
      servers.delete(this.port);
      this.port = null;
      this.release?.();
      this.release = null;
      // Node waits for the connections to end before 'close'.
      const done = () => {
        if (this.connections.size) return;
        this.emit('close');
        callback?.();
      };
      for (const socket of this.connections) socket.once('close', done);
      queueMicrotask(done);
      return this;
    }
    getConnections(callback: (error: Error | null, count: number) => void) {
      queueMicrotask(() => callback(null, this.connections.size));
      return this;
    }
    ref() {
      this.referenced = true;
      if (this.port !== null) this.release ??= hold();
      return this;
    }
    unref() {
      this.referenced = false;
      this.release?.();
      this.release = null;
      return this;
    }
    // A connection the page opened to the port.
    accept(id: number) {
      const socket = new Socket({ id, port: this.port!, allowHalfOpen: this.allowHalfOpen });
      socket.server = this;
      this.connections.add(socket);
      socket.on('close', () => this.connections.delete(socket));
      this.emit('connection', socket);
    }
    [Symbol.asyncDispose]() {
      return new Promise<void>((resolve) => this.close(() => resolve()));
    }
  }

  // What the exec frame says.
  const receive = (message: NetMessage) => {
    if (message.op === 'dns') {
      const answer = queries.get(message.ref);
      queries.delete(message.ref);
      answer?.(message.answer);
    } else if (message.op === 'listening') {
      const answer = asked.get(message.ref);
      asked.delete(message.ref);
      answer?.(message.port);
    } else if (message.op === 'open') {
      const server = servers.get(message.port);
      if (server) server.accept(message.id);
      else post({ kind: 'net', op: 'close', id: message.id });
    } else {
      const socket = sockets.get(message.id);
      if (!socket) return;
      if (message.op === 'connected') socket.connected(true, message.local);
      else if (message.op === 'refused') socket.connected(false, undefined, message.code);
      else if (message.op === 'data') socket.receive(message.bytes);
      else if (message.op === 'end') socket.push(null);
      else {
        sockets.delete(message.id);
        socket.push(null);
        socket.destroy();
      }
    }
  };

  const module = {
    Server,
    Socket,
    Stream: Socket,
    createServer: (
      options?: { allowHalfOpen?: boolean } | ((socket: Socket) => void),
      listener?: (socket: Socket) => void,
    ) => new Server(options, listener),
    createConnection: (...args: unknown[]) => new Socket().connect(...args),
    connect: (...args: unknown[]) => new Socket().connect(...args),
    isIP: (s: string) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0),
    isIPv4,
    isIPv6,
    getDefaultAutoSelectFamily: () => true,
    setDefaultAutoSelectFamily() {},
    getDefaultAutoSelectFamilyAttemptTimeout: () => 250,
    setDefaultAutoSelectFamilyAttemptTimeout() {},
    BlockList: class BlockList {
      check() {
        return false;
      }
      addAddress() {}
      addRange() {}
      addSubnet() {}
    },
  };
  return { module, receive, Server, Socket, dns };
}

export type Net = ReturnType<typeof createNet>;
