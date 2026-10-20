// HTTPS for the node by the page's fetch(): what a host offers at
// /.net/https/NAME/PORT (crates/rotp/src/host/wasm_net.rs), and the
// gateway of the Emscripten BEAM's ssl (patch 0020), which waits for the
// page's first line: "fetch", then the node writes plain HTTP/1.1 on the
// connection, and each request is answered with a fetch() of
// https://NAME[:PORT]/path; the browser does TLS and checks the
// certificate. It reads only what CORS lets it: a site that sends no CORS
// headers answers 502, with why. The browser leaves out request headers it
// sets itself (Host, User-Agent, Cookie, Accept-Encoding) and response
// headers the site does not expose, follows redirects itself, and
// decompresses: the answer is chunked, without Content-Encoding. A
// connection carries one request after another (keep-alive, as a server's),
// and closes after an answer when the request said so (Connection: close),
// when the node ends it, or after an error's answer.
//
// Or "tcp" through a tunnel (Tailscale, docs/tailscale.md): a TCP
// connection to NAME:PORT, over which the node does TLS itself (its own
// ssl, with the options it was given), both ways, for as long as it keeps
// it; or "error REASON" (a POSIX name) when the tunnel did not open.
import type { Served, Https } from './host/node';

const HEAD_END = [13, 10, 13, 10];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// What fetch() must not be given, or sets itself.
// Hosts whose API lets a browser in only when it says so: what the
// gateway's fetch() adds for them (a tunnel's TLS is the node's own, and
// carries what it sends as it is).
const BROWSER_HEADERS: Record<string, [string, string][]> = {
  'api.anthropic.com': [['anthropic-dangerous-direct-browser-access', 'true']],
};

const SKIP_REQUEST = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'accept-encoding',
  'user-agent',
  'cookie',
  'proxy-connection',
  'expect',
]);
const SKIP_RESPONSE = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

// A status's reason, for an answer that gives none (HTTP/2's).
const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  205: 'Reset Content',
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
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  418: "I'm a Teapot",
  422: 'Unprocessable Entity',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
};

function indexOf(bytes: Uint8Array, pattern: number[], from = 0): number {
  outer: for (let i = from; i + pattern.length <= bytes.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// A chunked body's bytes and how many it took (through the last chunk
// and its trailer), or null until it is all there.
function dechunk(bytes: Uint8Array): { body: Uint8Array<ArrayBuffer>; used: number } | null {
  const parts: Uint8Array[] = [];
  let at = 0;
  for (;;) {
    const line = indexOf(bytes, [13, 10], at);
    if (line < 0) return null;
    const field = decoder.decode(bytes.subarray(at, line)).split(';')[0].trim();
    if (!/^[0-9a-f]+$/i.test(field)) throw new Error('a malformed chunked body');
    const size = parseInt(field, 16);
    at = line + 2;
    if (size === 0) {
      // No trailer: its empty line; else the trailer's end.
      const end = bytes[at] === 13 && bytes[at + 1] === 10 ? at + 2 : indexOf(bytes, HEAD_END, at);
      if (end < 0) return null;
      const used = end === at + 2 ? end : end + 4;
      return { body: parts.reduce<Uint8Array<ArrayBuffer>>(concat, new Uint8Array(0)), used };
    }
    if (at + size + 2 > bytes.length) return null;
    parts.push(bytes.subarray(at, at + size));
    at += size + 2;
  }
}

function head(
  connection: Served,
  status: number,
  reason: string,
  headers: [string, string][],
  chunked: boolean,
  close = true,
): void {
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    close ? 'connection: close' : 'connection: keep-alive',
  ];
  // Without a body: its length 0, unless the site's is kept (the length a
  // HEAD's or a 304's answer has no body of).
  if (chunked) lines.push('transfer-encoding: chunked');
  else if (!headers.some(([name]) => name === 'content-length')) lines.push('content-length: 0');
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  connection.write(encoder.encode(lines.join('\r\n') + '\r\n\r\n'));
}

function chunk(connection: Served, bytes: Uint8Array): void {
  if (!bytes.length) return;
  connection.write(encoder.encode(`${bytes.length.toString(16)}\r\n`));
  connection.write(bytes);
  connection.write(encoder.encode('\r\n'));
}

function failed(connection: Served, status: number, reason: string, text: string): void {
  head(connection, status, reason, [['content-type', 'text/plain']], true);
  chunk(connection, encoder.encode(text));
  connection.write(encoder.encode('0\r\n\r\n'));
  connection.end();
}

// A connection to a host by other means than fetch(): its bytes as they
// are, and (`local`) this side's address and port there.
export interface Tunnel {
  write(bytes: Uint8Array): void;
  end(): void;
  close(): void;
  ondata: (bytes: Uint8Array) => void;
  onend: (error: string | null) => void;
  local?: string;
}

const say = (connection: Served, text: string) => connection.write(encoder.encode(`${text}\n`));

// (connection, { host, port }): a handler for host/node.ts's `https` option.
// `tunnel(host, port)` gives a tunnel there (or, resolving null, fetch()
// after all), or null for fetch(); one that fails says why in its error's
// `code` (a POSIX name). onblocked(url) hears of a fetch() the browser
// would not make.
export function httpsByFetch({
  onrequest = (_method: string, _url: string) => {},
  tunnel = (_host: string, _port: number): Promise<Tunnel | null> | null => null,
  onblocked = (_url: string) => {},
} = {}): Https {
  const fetched = byFetch(onrequest, onblocked);
  return (connection, target) => {
    const tunneled = tunnel(target.host, target.port);
    if (!tunneled) return fetched(connection, target);
    // The node writes nothing before the page's line.
    let closed = false;
    connection.onclose = () => (closed = true);
    tunneled.then(
      (open) => {
        if (!open) return closed || fetched(connection, target);
        if (closed) return open.close();
        say(connection, 'tcp');
        connection.ondata = (bytes) => open.write(bytes);
        connection.onend = () => open.end();
        connection.onclose = () => open.close();
        open.ondata = (bytes) => connection.write(bytes);
        open.onend = () => connection.end();
      },
      (error: Error & { code?: string }) => {
        if (closed) return;
        say(connection, `error ${error.code ?? 'ehostunreach'}`);
        connection.end();
      },
    );
  };
}

// The gateway's fetch(): each request on the connection, answered, one
// after another; what comes while one is answered waits its turn.
function byFetch(
  onrequest: (method: string, url: string) => void,
  onblocked: (url: string) => void,
): Https {
  return (connection, { host, port }) => {
    say(connection, 'fetch');
    let buffer = new Uint8Array(0);
    let busy = false;
    let ended = false;
    let done = false;
    // The next request, if it has come whole: its parts, and where it ends.
    const parse = () => {
      const end = indexOf(buffer, HEAD_END);
      if (end < 0) return null;
      const lines = decoder.decode(buffer.subarray(0, end)).split('\r\n');
      const [method, target] = lines[0].split(' ');
      const headers: [string, string][] = [];
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0)
          headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
      }
      const header = (name: string) => headers.find(([key]) => key === name)?.[1];
      const rest = buffer.subarray(end + 4);
      let body: Uint8Array<ArrayBuffer>;
      let used: number;
      if (header('transfer-encoding')?.toLowerCase().includes('chunked')) {
        const whole = dechunk(rest);
        if (!whole) return null;
        body = whole.body;
        used = end + 4 + whole.used;
      } else {
        const field = header('content-length') ?? '0';
        if (!/^\d+$/.test(field)) throw new Error('a malformed Content-Length');
        const length = Number(field);
        if (rest.length < length) return null;
        body = rest.slice(0, length);
        used = end + 4 + length;
      }
      return { method, target, headers, header, body, used };
    };
    const next = async () => {
      if (busy || done) return;
      let request;
      try {
        request = parse();
      } catch (error) {
        done = true;
        return failed(connection, 400, 'Bad Request', `playground: ${(error as Error).message}\n`);
      }
      if (!request) {
        if (ended) {
          done = true;
          connection.end();
        }
        return;
      }
      busy = true;
      buffer = buffer.slice(request.used);
      const { method, target, headers, header, body } = request;
      const close = header('connection')?.toLowerCase() === 'close';
      const path = target.replace(/^https?:\/\/[^/]+/, '');
      const url = `https://${host}${port === 443 ? '' : `:${port}`}${path}`;
      onrequest(method, url);
      for (const [name, value] of BROWSER_HEADERS[host.toLowerCase()] ?? [])
        if (!header(name)) headers.push([name, value]);
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: headers.filter(([name]) => !SKIP_REQUEST.has(name)),
          body: ['GET', 'HEAD'].includes(method) ? undefined : body,
          credentials: 'omit',
          redirect: 'follow',
        });
      } catch (error) {
        onblocked(url);
        done = true;
        return failed(
          connection,
          502,
          'Bad Gateway',
          `playground: ${method} ${url} failed in the browser (${(error as Error).message}); ` +
            'the site may not allow cross-origin requests\n',
        );
      }
      const bodiless = method === 'HEAD' || [204, 304].includes(response.status);
      const kept: [string, string][] = [];
      response.headers.forEach((value, name) => {
        if (!SKIP_RESPONSE.has(name) || (bodiless && name === 'content-length'))
          kept.push([name, value]);
      });
      const empty = bodiless || !response.body;
      head(
        connection,
        response.status,
        response.statusText || REASONS[response.status] || 'unknown',
        kept,
        !empty,
        close,
      );
      if (!empty) {
        try {
          const reader = response.body!.getReader();
          for (;;) {
            const { done: read, value } = await reader.read();
            if (read) break;
            chunk(connection, value);
          }
        } catch {
          // The body broke off: the node sees the connection end early.
          done = true;
          return connection.end();
        }
        connection.write(encoder.encode('0\r\n\r\n'));
      }
      busy = false;
      if (close) {
        done = true;
        return connection.end();
      }
      void next();
    };
    connection.ondata = (bytes) => {
      if (done) return;
      buffer = concat(buffer, bytes);
      void next();
    };
    // The node ended its side: after what it asked is answered, this one.
    connection.onend = () => {
      ended = true;
      void next();
    };
  };
}
