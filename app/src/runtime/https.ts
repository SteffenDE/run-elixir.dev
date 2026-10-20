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
// connection carries one request and closes after its answer.
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

// A chunked body's bytes, or null until it is all there.
function dechunk(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const parts: Uint8Array[] = [];
  let at = 0;
  for (;;) {
    const line = indexOf(bytes, [13, 10], at);
    if (line < 0) return null;
    const size = parseInt(decoder.decode(bytes.subarray(at, line)).split(';')[0], 16);
    if (Number.isNaN(size)) throw new Error('bad chunk size');
    at = line + 2;
    if (size === 0) return parts.reduce<Uint8Array<ArrayBuffer>>(concat, new Uint8Array(0));
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
): void {
  const lines = [`HTTP/1.1 ${status} ${reason}`, 'connection: close'];
  if (chunked) lines.push('transfer-encoding: chunked');
  else lines.push('content-length: 0');
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

// The gateway's fetch(): each request on the connection, answered.
function byFetch(
  onrequest: (method: string, url: string) => void,
  onblocked: (url: string) => void,
): Https {
  return (connection, { host, port }) => {
    say(connection, 'fetch');
    let buffer = new Uint8Array(0);
    let answered = false;
    connection.ondata = async (bytes) => {
      if (answered) return;
      buffer = concat(buffer, bytes);
      const end = indexOf(buffer, HEAD_END);
      if (end < 0) return;
      const lines = decoder.decode(buffer.subarray(0, end)).split('\r\n');
      const [method, target] = lines[0].split(' ');
      const headers: [string, string][] = [];
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0)
          headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
      }
      const header = (name: string) => headers.find(([key]) => key === name)?.[1];
      let body = buffer.subarray(end + 4);
      if (header('transfer-encoding')?.toLowerCase().includes('chunked')) {
        let whole;
        try {
          whole = dechunk(body);
        } catch {
          answered = true;
          return failed(connection, 400, 'Bad Request', 'playground: a malformed chunked body\n');
        }
        if (!whole) return;
        body = whole;
      } else {
        const length = Number(header('content-length') ?? 0);
        if (body.length < length) return;
        body = body.subarray(0, length);
      }
      answered = true;
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
        return failed(
          connection,
          502,
          'Bad Gateway',
          `playground: ${method} ${url} failed in the browser (${(error as Error).message}); ` +
            'the site may not allow cross-origin requests\n',
        );
      }
      const kept: [string, string][] = [];
      response.headers.forEach((value, name) => {
        if (!SKIP_RESPONSE.has(name)) kept.push([name, value]);
      });
      const empty = method === 'HEAD' || [204, 304].includes(response.status) || !response.body;
      head(connection, response.status, response.statusText || 'OK', kept, !empty);
      if (!empty) {
        try {
          const reader = response.body!.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunk(connection, value);
          }
        } catch {
          // The body broke off: the node sees the connection end early.
          return connection.end();
        }
        connection.write(encoder.encode('0\r\n\r\n'));
      }
      connection.end();
    };
  };
}
