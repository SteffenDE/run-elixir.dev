// node:http's server over net.ts: HTTP/1.1 requests on a connection (a
// body by its length or in chunks, one after another while the connection
// is kept), 'upgrade' for a WebSocket, and responses with Node's header
// calls, sent with their length or in chunks. No client yet.
import { Buffer } from './buffer';
import type { Net } from './net';
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
  setTimeout(ms: number, callback?: () => void) {
    this.socket.setTimeout(ms, callback);
    return this;
  }
}

// What a response has in common with a request a client makes: headers
// kept by their lowercase name.
class ServerResponse extends Writable {
  declare req: IncomingMessage;
  declare socket: Socket | null;
  declare connection: Socket | null;
  declare statusCode: number;
  declare statusMessage: string;
  declare sendDate: boolean;
  declare headersSent: boolean;
  declare finished: boolean;
  declare chunkedEncoding: boolean;
  declare shouldKeepAlive: boolean;
  declare fields: Map<string, [string, HeaderValue]>;
  declare chunked: boolean;
  declare bodiless: boolean;

  constructor(req: IncomingMessage, keepAlive: boolean) {
    super({ decodeStrings: true });
    this.req = req;
    this.socket = req.socket;
    this.connection = req.socket;
    this.statusCode = 200;
    this.statusMessage = '';
    this.sendDate = true;
    this.headersSent = false;
    this.finished = false;
    this.chunkedEncoding = false;
    this.shouldKeepAlive = keepAlive;
    this.fields = new Map();
    this.chunked = false;
    this.bodiless = req.method === 'HEAD';
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
  flushHeaders() {
    this.head(false);
  }
  setTimeout(ms: number, callback?: () => void) {
    this.socket?.setTimeout(ms, callback);
    return this;
  }
  // The status line and headers, before the first of the body (`ending`:
  // all of the body is in this write, so its length is known).
  head(ending: boolean, length = 0) {
    if (this.headersSent) return;
    this.headersSent = true;
    const put = (name: string, value: HeaderValue) =>
      this.fields.set(name.toLowerCase(), [name, value]);
    const status = this.statusCode;
    this.bodiless ||= status === 204 || status === 304 || (status >= 100 && status < 200);
    if (status === 101) this.shouldKeepAlive = true;
    if (!this.fields.has('content-length') && !this.fields.has('transfer-encoding')) {
      if (ending && !this.bodiless) put('Content-Length', length);
      else if (!this.bodiless && this.req.httpVersion === '1.1') {
        put('Transfer-Encoding', 'chunked');
        this.chunked = this.chunkedEncoding = true;
      } else if (!this.bodiless) this.shouldKeepAlive = false;
    } else
      this.chunked = this.chunkedEncoding = /chunked/i.test(
        String(this.fields.get('transfer-encoding')?.[1] ?? ''),
      );
    if (this.sendDate && !this.fields.has('date')) put('Date', new Date().toUTCString());
    if (!this.fields.has('connection') && status !== 101)
      put('Connection', this.shouldKeepAlive ? 'keep-alive' : 'close');
    else if (/close/i.test(String(this.fields.get('connection')?.[1] ?? '')))
      this.shouldKeepAlive = false;
    const reason = this.statusMessage || STATUS_CODES[status] || 'unknown';
    const lines = [`HTTP/1.1 ${status} ${reason}`];
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

// Where a request's head ends (\r\n\r\n), or -1.
function headEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++)
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10)
      return i;
  return -1;
}

export function createHttp(net: Net) {
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
      // The body still to come: its length, or (chunked) -1.
      let remaining = 0;
      let chunked = false;
      let chunkLeft = -1;
      let upgraded = false;
      const state = socket as Socket & { busy?: boolean };

      const finishBody = () => {
        request!.complete = true;
        request!.push(null);
        request = null;
      };

      const parse = () => {
        while (!upgraded) {
          if (request) {
            if (!chunked) {
              if (!buffer.length) return;
              const part = buffer.subarray(0, remaining);
              buffer = buffer.subarray(part.length);
              remaining -= part.length;
              request.push(Buffer.from(part));
              if (remaining === 0) finishBody();
              continue;
            }
            if (chunkLeft < 0) {
              const line = buffer.indexOf('\r\n');
              if (line < 0) return;
              chunkLeft = parseInt(buffer.subarray(0, line).toString('latin1'), 16) || 0;
              buffer = buffer.subarray(line + 2);
              if (chunkLeft === 0) {
                // Trailers, up to the blank line.
                const end = buffer.indexOf('\r\n\r\n');
                const blank = buffer.subarray(0, 2).toString('latin1') === '\r\n';
                if (!blank && end < 0) {
                  chunkLeft = -1;
                  buffer = Buffer.concat([Buffer.from('0\r\n'), buffer]);
                  return;
                }
                buffer = buffer.subarray(blank ? 2 : end + 4);
                chunkLeft = -1;
                finishBody();
              }
              continue;
            }
            if (buffer.length < chunkLeft + 2) {
              if (buffer.length > chunkLeft) return;
              request.push(Buffer.from(buffer));
              chunkLeft -= buffer.length;
              buffer = Buffer.alloc(0);
              return;
            }
            request.push(Buffer.from(buffer.subarray(0, chunkLeft)));
            buffer = buffer.subarray(chunkLeft + 2);
            chunkLeft = -1;
            continue;
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
          for (const line of lines.slice(1)) {
            const at = line.indexOf(':');
            if (at <= 0) continue;
            const name = line.slice(0, at).trim();
            const value = line.slice(at + 1).trim();
            req.rawHeaders.push(name, value);
            const key = name.toLowerCase();
            (req.headersDistinct[key] ??= []).push(value);
            const had = req.headers[key];
            if (key === 'set-cookie') req.headers[key] = [...((had as string[]) ?? []), value];
            else if (had === undefined) req.headers[key] = value;
            else if (key !== 'host' && key !== 'content-type' && key !== 'content-length')
              req.headers[key] = `${had}${key === 'cookie' ? '; ' : ', '}${value}`;
          }
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
          chunked = /chunked/i.test(String(req.headers['transfer-encoding'] ?? ''));
          remaining = chunked ? 0 : Number(req.headers['content-length'] ?? 0) || 0;
          request = req;
          if (!chunked && remaining === 0) finishBody();
          const res = new ServerResponse(req, keepAlive);
          state.busy = true;
          res.on('finish', () => {
            state.busy = false;
            if (!res.shouldKeepAlive || ended) socket.end();
            else parse();
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
      });
      socket.on('error', (error: Error) => {
        if (this.listenerCount('clientError')) this.emit('clientError', error, socket);
      });
      if (this.timeout) socket.setTimeout(this.timeout, () => socket.destroy());
    }
  }

  const unavailable = (name: string) => () => {
    const error = new Error(`http.${name} is not available in the playground yet`) as Error & {
      code: string;
    };
    error.code = 'ERR_NOT_AVAILABLE';
    throw error;
  };

  // http's and https's Agent: its options kept, as nothing connects yet.
  class Agent {
    constructor(public options: Record<string, unknown> = {}) {}
    destroy() {}
  }

  return {
    Server,
    IncomingMessage,
    ServerResponse,
    OutgoingMessage: ServerResponse,
    Agent,
    globalAgent: new Agent(),
    STATUS_CODES,
    METHODS,
    maxHeaderSize: 16384,
    createServer: (
      options?: Record<string, unknown> | ((req: IncomingMessage, res: ServerResponse) => void),
      listener?: (req: IncomingMessage, res: ServerResponse) => void,
    ) => new Server(options, listener),
    request: unavailable('request'),
    get: unavailable('get'),
    validateHeaderName() {},
    validateHeaderValue() {},
    setMaxIdleHTTPParsers() {},
  };
}
