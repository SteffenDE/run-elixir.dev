// node:net on the page's TCP: a process's listeners are the page's to
// route (programs/nodejs.ts), as a node's are, so the preview and the
// project's other processes reach a port a script listens on.
//
// The process tells the page { kind: 'net', op: 'listen', ref, port } and
// hears { op: 'listening', ref, port } (null when the port is taken);
// a connection comes as { op: 'open', id, port }; then { op: 'data', id,
// bytes }, { op: 'end', id } and { op: 'close', id } go both ways, and
// { op: 'unlisten', port } stops a listener.
import { Buffer } from './buffer';
import { EventEmitter } from 'events';
import * as streams from 'readable-stream';

const { Duplex } = streams as typeof import('node:stream');

export type NetMessage =
  | { kind: 'net'; op: 'listening'; ref: number; port: number | null }
  | { kind: 'net'; op: 'open'; id: number; port: number }
  | { kind: 'net'; op: 'data'; id: number; bytes: Uint8Array }
  | { kind: 'net'; op: 'end' | 'close'; id: number };

type Hold = () => () => void;

interface Address {
  address: string;
  family: string;
  port: number;
}

const isIPv4 = (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s);
const isIPv6 = (s: string) => s.includes(':');

const netError = (code: string, syscall: string, port: number, message: string) =>
  Object.assign(new Error(`${syscall} ${code}: ${message}`), {
    code,
    errno: code === 'EADDRINUSE' ? -98 : -111,
    syscall,
    address: '127.0.0.1',
    port,
  });

export function createNet(post: (message: unknown) => void, hold: Hold) {
  const sockets = new Map<number, Socket>();
  const servers = new Map<number, Server>();
  const asked = new Map<number, (port: number | null) => void>();
  let ref = 0;

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
      if (this.id) sockets.set(this.id, this);
      this.on('close', () => {
        sockets.delete(this.id);
        this.release?.();
        this.release = null;
        if (this.timer) clearTimeout(this.timer);
      });
    }
    // From the page.
    receive(bytes: Uint8Array) {
      this.bytesRead += bytes.length;
      this.touch();
      this.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    }
    _read() {}
    _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
      this.bytesWritten += chunk.length;
      this.touch();
      post({ kind: 'net', op: 'data', id: this.id, bytes: new Uint8Array(chunk) });
      callback();
    }
    _final(callback: (error?: Error | null) => void) {
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
      return false;
    }
    get bufferSize() {
      return this.writableLength;
    }
    address(): Address {
      return { address: this.localAddress, family: 'IPv4', port: this.localPort };
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

  // What the page says.
  const receive = (message: NetMessage) => {
    if (message.op === 'listening') {
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
      if (message.op === 'data') socket.receive(message.bytes);
      else if (message.op === 'end') socket.push(null);
      else {
        sockets.delete(message.id);
        socket.push(null);
        socket.destroy();
      }
    }
  };

  const unavailable = (name: string) => () => {
    const error = new Error(`net.${name} is not available in the playground yet`) as Error & {
      code: string;
    };
    error.code = 'ERR_NOT_AVAILABLE';
    throw error;
  };

  const module = {
    Server,
    Socket,
    Stream: Socket,
    createServer: (
      options?: { allowHalfOpen?: boolean } | ((socket: Socket) => void),
      listener?: (socket: Socket) => void,
    ) => new Server(options, listener),
    createConnection: unavailable('createConnection'),
    connect: unavailable('connect'),
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
  return { module, receive, Server, Socket };
}

export type Net = ReturnType<typeof createNet>;
