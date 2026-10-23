// node:http over net.ts. A server: HTTP/1.1 requests on a connection (a
// body by its length or in chunks, one after another while the connection
// is kept), 'upgrade' for a WebSocket, and responses with Node's header
// calls, sent with their length or in chunks. A client: request and get,
// each on a connection of its own, and 'upgrade' (a proxied WebSocket).
// https's client is the same over a connection the page carries to the
// host by its fetch (https.ts, as a node's HTTPS goes): the browser does
// TLS, and reads only what the site's CORS lets it. No HTTPS server.
import { Buffer } from './buffer';
import type { Net } from './net';
import type { TlsOptions } from './tls';
import { fetchable } from '../relayList';
import * as streams from 'readable-stream';

const { Readable, Writable } = streams as typeof import('node:stream');

type Socket = InstanceType<Net['Socket']>;
type Headers = Record<string, string | string[]>;
type HeaderValue = string | number | readonly string[];

export const STATUS_CODES: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export const METHODS = [
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
];

// A request's head: its line and headers, as Node gives them.
class IncomingMessage extends Readable {
  declare socket: Socket;
  declare connection: Socket;
  declare method: string;
  declare url: string;
  declare httpVersion: string;
  declare httpVersionMajor: number;
  declare httpVersionMinor: number;
  declare headers: Headers;
  declare headersDistinct: Record<string, string[]>;
  declare rawHeaders: string[];
  declare trailers: Headers;
  declare rawTrailers: string[];
  declare complete: boolean;
  declare aborted: boolean;
  declare statusCode: number | null;
  declare statusMessage: string | null;

  constructor(socket: Socket) {
    super();
    this.socket = socket;
    this.connection = socket;
    this.method = 'GET';
    this.url = '/';
    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.headers = {};
    this.headersDistinct = {};
    this.rawHeaders = [];
    this.trailers = {};
    this.rawTrailers = [];
    this.complete = false;
    this.aborted = false;
    this.statusCode = null;
    this.statusMessage = null;
  }
  _read() {}
  // Destroyed before it is complete, as Node's: its connection with it.
  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    if (!this.complete && this.socket && !this.socket.destroyed) this.socket.destroy();
    callback(error);
  }
  setTimeout(ms: number, callback?: () => void) {
    this.socket.setTimeout(ms, callback);
    return this;
  }
}

// What a response and a request a client makes have in common: headers
// kept by their lowercase name, then a body sent with its length or in
// chunks.
abstract class OutgoingMessage extends Writable {
  declare socket: Socket | null;
  declare connection: Socket | null;
  declare headersSent: boolean;
  declare finished: boolean;
  declare chunkedEncoding: boolean;
  declare shouldKeepAlive: boolean;
  declare fields: Map<string, [string, HeaderValue]>;
  declare chunked: boolean;
  declare bodiless: boolean;

  // autoDestroy: a response is done once it is sent; a request is not
  // (its response comes on its connection after).
  constructor(socket: Socket | null, autoDestroy = true) {
    super({ decodeStrings: true, autoDestroy });
    this.socket = this.connection = socket;
    this.headersSent = false;
    this.finished = false;
    this.chunkedEncoding = false;
    this.shouldKeepAlive = true;
    this.fields = new Map();
    this.chunked = false;
    this.bodiless = false;
  }
  setHeader(name: string, value: HeaderValue) {
    if (this.headersSent) throw headersSentError('set');
    this.fields.set(name.toLowerCase(), [name, value]);
    return this;
  }
  appendHeader(name: string, value: HeaderValue) {
    const had = this.fields.get(name.toLowerCase());
    if (!had) return this.setHeader(name, value);
    const values = ([] as string[]).concat(had[1] as string, value as string);
    this.fields.set(name.toLowerCase(), [had[0], values.map(String)]);
    return this;
  }
  setHeaders(headers: Map<string, HeaderValue> | Headers) {
    for (const [name, value] of headers instanceof Map ? headers : Object.entries(headers))
      this.setHeader(name, value);
    return this;
  }
  getHeader(name: string) {
    return this.fields.get(name.toLowerCase())?.[1];
  }
  getHeaders() {
    const out: Record<string, HeaderValue> = Object.create(null);
    for (const [key, [, value]] of this.fields) out[key] = value;
    return out;
  }
  getHeaderNames() {
    return [...this.fields.keys()];
  }
  getRawHeaderNames() {
    return [...this.fields.values()].map(([name]) => name);
  }
  hasHeader(name: string) {
    return this.fields.has(name.toLowerCase());
  }
  removeHeader(name: string) {
    if (this.headersSent) throw headersSentError('remove');
    this.fields.delete(name.toLowerCase());
  }
  flushHeaders() {
    this.head(false);
  }
  setTimeout(ms: number, callback?: () => void) {
    this.socket?.setTimeout(ms, callback);
    return this;
  }
  // The first line, and the headers the message adds itself (`ending`:
  // all of the body is in this write, `length` long).
  abstract startLine(): string;
  abstract prepare(ending: boolean, length: number): void;
  // A header the message adds itself, after the caller's are sent.
  put(name: string, value: HeaderValue) {
    this.fields.set(name.toLowerCase(), [name, value]);
  }
  // How the body goes: its length when it is known, else in chunks (when
  // `chunks` may), else until the connection closes.
  frame(ending: boolean, length: number, chunks: boolean) {
    if (this.fields.has('content-length') || this.fields.has('transfer-encoding')) {
      this.chunked = this.chunkedEncoding = /chunked/i.test(
        String(this.fields.get('transfer-encoding')?.[1] ?? ''),
      );
      return;
    }
    if (this.bodiless) return;
    if (ending) this.put('Content-Length', length);
    else if (chunks) {
      this.put('Transfer-Encoding', 'chunked');
      this.chunked = this.chunkedEncoding = true;
    } else this.shouldKeepAlive = false;
  }
  // The first line and headers, before the first of the body.
  head(ending: boolean, length = 0) {
    if (this.headersSent) return;
    this.headersSent = true;
    this.prepare(ending, length);
    const lines = [this.startLine()];
    for (const [name, value] of this.fields.values())
      for (const each of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${each}`);
    this.socket?.write(Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'));
  }
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
    this.head(false);
    if (!this.bodiless && chunk.length && this.socket && !this.socket.destroyed) {
      if (this.chunked) this.socket.write(`${chunk.length.toString(16)}\r\n`);
      this.socket.write(chunk);
      if (this.chunked) this.socket.write('\r\n');
    }
    callback();
  }
  _final(callback: (error?: Error | null) => void) {
    this.head(true);
    if (this.chunked && this.socket && !this.socket.destroyed) this.socket.write('0\r\n\r\n');
    this.finished = true;
    callback();
  }
  // end(chunk) with nothing written before: the whole body, so its length
  // goes in the head.
  end(chunk?: unknown, encoding?: unknown, callback?: unknown) {
    if (typeof chunk === 'function') [callback, chunk] = [chunk, undefined];
    if (typeof encoding === 'function') [callback, encoding] = [encoding, undefined];
    if (!this.headersSent && this.writableLength === 0 && !this.chunked) {
      const body =
        chunk == null
          ? Buffer.alloc(0)
          : typeof chunk === 'string'
            ? Buffer.from(chunk, (encoding as BufferEncoding) ?? 'utf8')
            : Buffer.from(chunk as Uint8Array);
      this.head(true, body.length);
      if (body.length) super.write(body);
      return super.end(callback as () => void);
    }
    return super.end(chunk as never, encoding as never, callback as never);
  }
}

class ServerResponse extends OutgoingMessage {
  declare req: IncomingMessage;
  declare statusCode: number;
  declare statusMessage: string;
  declare sendDate: boolean;

  constructor(req: IncomingMessage, keepAlive: boolean) {
    super(req.socket);
    this.req = req;
    this.statusCode = 200;
    this.statusMessage = '';
    this.sendDate = true;
    this.shouldKeepAlive = keepAlive;
    this.bodiless = req.method === 'HEAD';
  }
  // writeHead(status, [message], [headers]): headers as an object or
  // Node's flat [name, value, ...] list.
  writeHead(
    status: number,
    message?: string | Headers | HeaderValue[],
    headers?: Headers | HeaderValue[],
  ) {
    if (this.headersSent) throw headersSentError('write');
    if (typeof message !== 'string') [headers, message] = [message, undefined];
    this.statusCode = status;
    if (message) this.statusMessage = message;
    if (Array.isArray(headers)) {
      if (Array.isArray(headers[0]))
        for (const [name, value] of headers as unknown as [string, HeaderValue][])
          this.appendHeader(name, value);
      else
        for (let i = 0; i < headers.length; i += 2)
          this.appendHeader(String(headers[i]), headers[i + 1]);
    } else if (headers)
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }
  writeContinue() {
    this.socket?.write('HTTP/1.1 100 Continue\r\n\r\n');
  }
  writeEarlyHints() {}
  startLine() {
    const status = this.statusCode;
    return `HTTP/1.1 ${status} ${this.statusMessage || STATUS_CODES[status] || 'unknown'}`;
  }
  prepare(ending: boolean, length: number) {
    const status = this.statusCode;
    this.bodiless ||= status === 204 || status === 304 || (status >= 100 && status < 200);
    if (status === 101) this.shouldKeepAlive = true;
    this.frame(ending, length, this.req.httpVersion === '1.1');
    if (this.sendDate && !this.fields.has('date')) this.put('Date', new Date().toUTCString());
    if (!this.fields.has('connection') && status !== 101)
      this.put('Connection', this.shouldKeepAlive ? 'keep-alive' : 'close');
    else if (/close/i.test(String(this.fields.get('connection')?.[1] ?? '')))
      this.shouldKeepAlive = false;
  }
  assignSocket(socket: Socket) {
    this.socket = this.connection = socket;
  }
  detachSocket() {
    this.socket = this.connection = null;
  }
}

const headersSentError = (what: string) =>
  Object.assign(new Error(`Cannot ${what} headers after they are sent to the client`), {
    code: 'ERR_HTTP_HEADERS_SENT',
  });

// Where a message's head ends (\r\n\r\n), or -1.
function headEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++)
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10)
      return i;
  return -1;
}

// A message's headers, as Node keeps them (repeated ones joined, but
// set-cookie's, a list).
function readHeaders(message: IncomingMessage, lines: string[]) {
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    message.rawHeaders.push(name, value);
    const key = name.toLowerCase();
    (message.headersDistinct[key] ??= []).push(value);
    const had = message.headers[key];
    if (key === 'set-cookie') message.headers[key] = [...((had as string[]) ?? []), value];
    else if (had === undefined) message.headers[key] = value;
    else if (key !== 'host' && key !== 'content-type' && key !== 'content-length')
      message.headers[key] = `${had}${key === 'cookie' ? '; ' : ', '}${value}`;
  }
}

// A message's body as it comes: by its length, in chunks, or (a response
// with neither) until the connection ends.
class Body {
  declare remaining: number;
  declare chunked: boolean;
  declare untilEnd: boolean;
  declare chunkLeft: number;
  declare done: boolean;

  constructor(
    private message: IncomingMessage,
    headers: Headers,
    untilEnd = false,
  ) {
    this.chunked = /chunked/i.test(String(headers['transfer-encoding'] ?? ''));
    const length = headers['content-length'];
    this.untilEnd = untilEnd && !this.chunked && length === undefined;
    this.remaining = this.chunked ? 0 : Number(length ?? 0) || 0;
    this.chunkLeft = -1;
    this.done = false;
    if (!this.chunked && !this.untilEnd && this.remaining === 0) this.finish();
  }
  finish() {
    if (this.done) return;
    this.done = true;
    this.message.complete = true;
    this.message.push(null);
  }
  // Takes what is the body's of `buffer`; what follows it.
  feed(buffer: Buffer): Buffer {
    while (!this.done && buffer.length) {
      if (this.untilEnd) {
        this.message.push(Buffer.from(buffer));
        return Buffer.alloc(0);
      }
      if (!this.chunked) {
        const part = buffer.subarray(0, this.remaining);
        buffer = buffer.subarray(part.length);
        this.remaining -= part.length;
        this.message.push(Buffer.from(part));
        if (this.remaining === 0) this.finish();
        continue;
      }
      if (this.chunkLeft < 0) {
        const line = buffer.indexOf('\r\n');
        if (line < 0) return buffer;
        const size = parseInt(buffer.subarray(0, line).toString('latin1'), 16) || 0;
        if (size === 0) {
          // Trailers, up to the blank line.
          const rest = buffer.subarray(line + 2);
          const blank = rest.subarray(0, 2).toString('latin1') === '\r\n';
          const end = rest.indexOf('\r\n\r\n');
          if (!blank && end < 0) return buffer;
          this.finish();
          return rest.subarray(blank ? 2 : end + 4);
        }
        this.chunkLeft = size;
        buffer = buffer.subarray(line + 2);
        continue;
      }
      if (buffer.length < this.chunkLeft + 2) {
        if (buffer.length > this.chunkLeft) return buffer;
        this.message.push(Buffer.from(buffer));
        this.chunkLeft -= buffer.length;
        return Buffer.alloc(0);
      }
      this.message.push(Buffer.from(buffer.subarray(0, this.chunkLeft)));
      buffer = buffer.subarray(this.chunkLeft + 2);
      this.chunkLeft = -1;
    }
    return buffer;
  }
}

// Methods whose request has no body unless one is written.
const BODILESS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);

interface RequestOptions {
  protocol?: string;
  host?: string;
  hostname?: string;
  port?: number | string;
  path?: string;
  method?: string;
  headers?: Headers | HeaderValue[];
  auth?: string;
  timeout?: number;
  signal?: AbortSignal;
  setHost?: boolean;
  createConnection?: (options: object, callback?: () => void) => Socket;
  // https's TLS, when it goes through the tailnet (tls.ts).
  servername?: string;
  ca?: TlsOptions['ca'];
  cert?: TlsOptions['cert'];
  key?: TlsOptions['key'];
  rejectUnauthorized?: boolean;
  checkServerIdentity?: TlsOptions['checkServerIdentity'];
  agent?: { options?: TlsOptions } | false;
}

// The TLS options of a request (or its agent's).
const tlsOf = (options: RequestOptions): TlsOptions => {
  const agent = (options.agent || undefined)?.options ?? {};
  const pick = <K extends keyof TlsOptions>(key: K) => (options as TlsOptions)[key] ?? agent[key];
  return {
    servername: pick('servername'),
    ca: pick('ca'),
    cert: pick('cert'),
    key: pick('key'),
    rejectUnauthorized: pick('rejectUnauthorized'),
    checkServerIdentity: pick('checkServerIdentity'),
  };
};

export function createHttp(net: Net) {
  // A request a client makes, on a connection of its own (no pooling: it
  // asks the server to close once it has answered).
  class ClientRequest extends OutgoingMessage {
    declare method: string;
    declare path: string;
    declare host: string;
    declare protocol: string;
    declare aborted: boolean;
    declare reusedSocket: boolean;
    declare res: IncomingMessage | null;

    constructor(options: RequestOptions, callback?: (res: IncomingMessage) => void) {
      const host = options.hostname ?? options.host?.replace(/:\d+$/, '') ?? 'localhost';
      const https = options.protocol === 'https:';
      const standard = https ? 443 : 80;
      const port = Number(options.port ?? standard);
      const socket = options.createConnection
        ? options.createConnection({ host, port })
        : (new net.Socket().connect({
            port,
            host,
            https,
            tls: tlsOf(options),
            // A path of a relayed host's that sends CORS headers: the
            // gateway's fetch(), sparing the relay (docs/relay.md).
            fetch: https && fetchable(host, options.path ?? '/'),
          }) as Socket);
      super(socket, false);
      this.method = (options.method ?? 'GET').toUpperCase();
      this.path = options.path ?? '/';
      this.host = host;
      this.protocol = options.protocol ?? 'http:';
      this.aborted = false;
      this.reusedSocket = false;
      this.res = null;
      const headers = options.headers;
      if (Array.isArray(headers))
        for (let i = 0; i < headers.length; i += 2)
          this.appendHeader(String(headers[i]), headers[i + 1]);
      else if (headers)
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      if (options.setHost !== false && !this.fields.has('host'))
        this.setHeader('Host', port === standard ? host : `${host}:${port}`);
      if (options.auth && !this.fields.has('authorization'))
        this.setHeader('Authorization', `Basic ${Buffer.from(options.auth).toString('base64')}`);
      if (callback) this.once('response', callback);
      if (options.timeout) this.setTimeout(options.timeout);
      options.signal?.addEventListener('abort', () => this.destroy(abortError()), { once: true });
      queueMicrotask(() => this.emit('socket', socket));
      this.read(socket);
    }
    startLine() {
      return `${this.method} ${this.path} HTTP/1.1`;
    }
    prepare(ending: boolean, length: number) {
      // A GET with nothing written says nothing of a body.
      if (!(ending && length === 0 && BODILESS.has(this.method))) this.frame(ending, length, true);
      if (!this.fields.has('connection')) this.put('Connection', 'close');
    }
    // The response, from the connection.
    read(socket: Socket) {
      let buffer: Buffer = Buffer.alloc(0);
      let body: Body | null = null;
      const fail = (error: Error) => {
        if (this.res && !this.res.complete) this.res.destroy(error);
        else if (!this.res) this.emit('error', error);
      };
      const ondata = (bytes: Buffer) => {
        buffer = buffer.length ? Buffer.concat([buffer, bytes]) : bytes;
        while (!body) {
          const end = headEnd(buffer);
          if (end < 0) return;
          const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
          buffer = buffer.subarray(end + 4);
          const match = /^HTTP\/(\d)\.(\d) (\d{3}) ?(.*)$/.exec(lines[0]);
          if (!match) {
            socket.destroy();
            fail(Object.assign(new Error('Parse Error'), { code: 'HPE_INVALID_CONSTANT' }));
            return;
          }
          const res = new IncomingMessage(socket);
          res.httpVersionMajor = Number(match[1]);
          res.httpVersionMinor = Number(match[2]);
          res.httpVersion = `${match[1]}.${match[2]}`;
          res.statusCode = Number(match[3]);
          res.statusMessage = match[4];
          readHeaders(res, lines.slice(1));
          const status = res.statusCode;
          if (status === 101) {
            socket.removeListener('data', ondata);
            this.res = res;
            if (!this.listenerCount('upgrade')) return void socket.destroy();
            // The connection is the upgrade's owner's now, as Node hands it.
            for (const [event, listener] of Object.entries(listeners))
              socket.removeListener(event, listener);
            this.emit('upgrade', res, socket, buffer);
            this.emit('close');
            return;
          }
          if (status >= 100 && status < 200) {
            this.emit(status === 100 ? 'continue' : 'information', res);
            continue;
          }
          this.res = res;
          (res as IncomingMessage & { req: ClientRequest }).req = this;
          // A response with neither length nor chunks ends with the
          // connection; one to HEAD, a 204 and a 304 have no body.
          body =
            this.method === 'HEAD' || status === 204 || status === 304
              ? new Body(res, {})
              : new Body(res, res.headers, true);
          res.on('end', () => {
            if (!socket.destroyed) socket.end();
          });
          this.emit('response', res);
        }
        buffer = body.feed(buffer);
      };
      socket.on('data', ondata);
      // The connection's end (`peer`: by the server) ends a body that lasts
      // until it; one short of its length or its last chunk, or cut off by
      // our own destroy, is aborted, as Node's is.
      const ended = (peer: boolean) => {
        if (!body || body.done) return;
        if (body.untilEnd && peer) return body.finish();
        this.res!.aborted = true;
        this.res!.emit('aborted');
        fail(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
      };
      // What the request hears of its connection, until an upgrade.
      const listeners = {
        end: () => {
          if (body) ended(true);
          else if (!this.res)
            fail(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
        },
        error: fail,
        close: () => {
          ended(false);
          this.emit('close');
        },
        timeout: () => this.emit('timeout'),
      };
      for (const [event, listener] of Object.entries(listeners)) socket.on(event, listener);
    }
    abort() {
      if (this.aborted) return;
      this.aborted = true;
      this.emit('abort');
      this.destroy();
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void) {
      this.socket?.destroy();
      callback(error);
    }
    setNoDelay() {}
    setSocketKeepAlive() {}
  }

  const abortError = () =>
    Object.assign(new Error('The operation was aborted'), {
      code: 'ABORT_ERR',
      name: 'AbortError',
    });

  // request(url, [options], [callback]) or request(options, [callback]).
  // protocol: http's or https's.
  const makeRequest = (protocol: 'http:' | 'https:', ...args: unknown[]) => {
    const callback =
      typeof args.at(-1) === 'function'
        ? (args.pop() as (res: IncomingMessage) => void)
        : undefined;
    let options: RequestOptions = {};
    if (typeof args[0] === 'string' || args[0] instanceof URL) {
      const url = new URL(String(args[0]));
      if (url.protocol !== protocol)
        throw Object.assign(
          new TypeError(`Protocol "${url.protocol}" not supported. Expected "${protocol}"`),
          {
            code: 'ERR_INVALID_PROTOCOL',
          },
        );
      options = {
        protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        ...(url.username
          ? { auth: `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` }
          : {}),
        ...((args[1] as RequestOptions) ?? {}),
      };
    } else options = { ...((args[0] as RequestOptions) ?? {}), protocol };
    return new ClientRequest(options, callback);
  };

  // A server: net's, whose connections speak HTTP.
  class Server extends net.Server {
    declare timeout: number;
    declare keepAliveTimeout: number;
    declare headersTimeout: number;
    declare requestTimeout: number;
    declare maxHeadersCount: number | null;
    declare maxRequestsPerSocket: number;

    constructor(
      options?: Record<string, unknown> | ((req: IncomingMessage, res: ServerResponse) => void),
      listener?: (req: IncomingMessage, res: ServerResponse) => void,
    ) {
      if (typeof options === 'function') [listener, options] = [options, {}];
      // A client that ends its side still hears the answer.
      super({ allowHalfOpen: true });
      this.timeout = 0;
      this.keepAliveTimeout = 5000;
      this.headersTimeout = 60000;
      this.requestTimeout = 300000;
      this.maxHeadersCount = null;
      this.maxRequestsPerSocket = 0;
      if (listener) this.on('request', listener);
      this.on('connection', (socket: Socket) => this.serve(socket));
    }
    setTimeout(ms: number, callback?: () => void) {
      this.timeout = ms;
      if (callback) this.on('timeout', callback);
      return this;
    }
    closeAllConnections() {
      for (const socket of this.connections) socket.destroy();
    }
    closeIdleConnections() {
      for (const socket of this.connections)
        if (!(socket as Socket & { busy?: boolean }).busy) socket.destroy();
    }

    // Requests on a connection, one after another.
    serve(socket: Socket) {
      let buffer: Buffer = Buffer.alloc(0);
      let request: IncomingMessage | null = null;
      let response: ServerResponse | null = null;
      let body: Body | null = null;
      let upgraded = false;
      const state = socket as Socket & { busy?: boolean };

      const parse = () => {
        while (!upgraded) {
          if (body && !body.done) {
            buffer = body.feed(buffer);
            if (!body.done) return;
          }
          // The next request is read once this one is answered.
          if (state.busy) return;
          const end = headEnd(buffer);
          if (end < 0) return;
          const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
          buffer = buffer.subarray(end + 4);
          const match = /^(\S+) (\S+) HTTP\/(\d)\.(\d)$/.exec(lines[0]);
          if (!match) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            return;
          }
          const req = new IncomingMessage(socket);
          [, req.method, req.url] = match;
          req.httpVersionMajor = Number(match[3]);
          req.httpVersionMinor = Number(match[4]);
          req.httpVersion = `${match[3]}.${match[4]}`;
          readHeaders(req, lines.slice(1));
          const connection = String(req.headers.connection ?? '').toLowerCase();
          if (req.headers.upgrade && /upgrade/.test(connection) && this.listenerCount('upgrade')) {
            upgraded = true;
            req.complete = true;
            req.push(null);
            socket.removeListener('data', ondata);
            const head = Buffer.from(buffer);
            buffer = Buffer.alloc(0);
            this.emit('upgrade', req, socket, head);
            return;
          }
          const keepAlive =
            req.httpVersion === '1.1' ? !/close/.test(connection) : /keep-alive/.test(connection);
          request = req;
          body = new Body(req, req.headers);
          const res = new ServerResponse(req, keepAlive);
          response = res;
          state.busy = true;
          res.on('finish', () => {
            state.busy = false;
            if (!res.shouldKeepAlive) return void socket.end();
            // A client that ended its side is answered what it asked before.
            parse();
            if (ended && !state.busy && !upgraded) socket.end();
          });
          if (/100-continue/i.test(String(req.headers.expect ?? '')))
            if (this.listenerCount('checkContinue')) {
              this.emit('checkContinue', req, res);
              continue;
            } else res.writeContinue();
          this.emit('request', req, res);
        }
      };
      const ondata = (bytes: Buffer) => {
        buffer = buffer.length ? Buffer.concat([buffer, bytes]) : bytes;
        parse();
      };
      socket.on('data', ondata);
      let ended = false;
      socket.on('end', () => {
        ended = true;
        if (request && !request.complete) {
          request.aborted = true;
          request.destroy();
        }
        if (!state.busy) socket.end();
      });
      socket.on('close', () => {
        if (request && !request.complete) request.emit('aborted');
        // A request still answered closes, and its response, as Node's
        // (what is written to it after goes nowhere).
        if (request && response && !response.writableFinished) {
          request.destroy();
          response.destroy();
        }
      });
      socket.on('error', (error: Error) => {
        if (this.listenerCount('clientError')) this.emit('clientError', error, socket);
      });
      if (this.timeout) socket.setTimeout(this.timeout, () => socket.destroy());
    }
  }

  // http's Agent: its options kept; every request has a connection of its
  // own.
  class Agent {
    constructor(public options: Record<string, unknown> = {}) {}
    destroy() {}
  }

  const client = (protocol: 'http:' | 'https:') => ({
    request: (...args: unknown[]) => makeRequest(protocol, ...args),
    get: (...args: unknown[]) => {
      const req = makeRequest(protocol, ...args);
      req.end();
      return req;
    },
  });

  const http = {
    Server,
    IncomingMessage,
    ServerResponse,
    OutgoingMessage,
    ClientRequest,
    Agent,
    globalAgent: new Agent(),
    STATUS_CODES,
    METHODS,
    maxHeaderSize: 16384,
    createServer: (
      options?: Record<string, unknown> | ((req: IncomingMessage, res: ServerResponse) => void),
      listener?: (req: IncomingMessage, res: ServerResponse) => void,
    ) => new Server(options, listener),
    ...client('http:'),
    validateHeaderName() {},
    validateHeaderValue() {},
    setMaxIdleHTTPParsers() {},
  };
  const unavailable = (name: string) => () => {
    throw Object.assign(new Error(`https.${name} is not available in the playground yet`), {
      code: 'ERR_NOT_AVAILABLE',
    });
  };
  const https = {
    Agent,
    globalAgent: new Agent({ defaultPort: 443 }),
    ...client('https:'),
    createServer: unavailable('createServer'),
    Server: unavailable('Server'),
  };
  return { http, https };
}
