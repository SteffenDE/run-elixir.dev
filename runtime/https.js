// HTTPS for the node by the page's fetch(): what a host offers at
// /.net/https/NAME/PORT (crates/rotp/src/host/wasm_net.rs). The node writes
// plain HTTP/1.1 on the connection, and each request is answered with a
// fetch() of https://NAME[:PORT]/path; the browser does TLS and checks the
// certificate. It reads only what CORS lets it: a site that sends no CORS
// headers answers 502, with why. The browser leaves out request headers it
// sets itself (Host, User-Agent, Cookie, Accept-Encoding) and response
// headers the site does not expose, follows redirects itself, and
// decompresses: the answer is chunked, without Content-Encoding. A
// connection carries one request and closes after its answer.
const HEAD_END = [13, 10, 13, 10];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// What fetch() must not be given, or sets itself.
const SKIP_REQUEST = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive',
  'upgrade', 'te', 'trailer', 'accept-encoding', 'user-agent', 'cookie', 'proxy-connection', 'expect']);
const SKIP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive']);

function indexOf(bytes, pattern, from = 0) {
  outer: for (let i = from; i + pattern.length <= bytes.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// A chunked body's bytes, or null until it is all there.
function dechunk(bytes) {
  const parts = [];
  let at = 0;
  for (;;) {
    const line = indexOf(bytes, [13, 10], at);
    if (line < 0) return null;
    const size = parseInt(decoder.decode(bytes.subarray(at, line)).split(';')[0], 16);
    if (Number.isNaN(size)) throw new Error('bad chunk size');
    at = line + 2;
    if (size === 0) return parts.reduce(concat, new Uint8Array(0));
    if (at + size + 2 > bytes.length) return null;
    parts.push(bytes.subarray(at, at + size));
    at += size + 2;
  }
}

function head(connection, status, reason, headers, chunked) {
  const lines = [`HTTP/1.1 ${status} ${reason}`, 'connection: close'];
  if (chunked) lines.push('transfer-encoding: chunked');
  else lines.push('content-length: 0');
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  connection.write(encoder.encode(lines.join('\r\n') + '\r\n\r\n'));
}

function chunk(connection, bytes) {
  if (!bytes.length) return;
  connection.write(encoder.encode(`${bytes.length.toString(16)}\r\n`));
  connection.write(bytes);
  connection.write(encoder.encode('\r\n'));
}

function failed(connection, status, reason, text) {
  head(connection, status, reason, [['content-type', 'text/plain']], true);
  chunk(connection, encoder.encode(text));
  connection.write(encoder.encode('0\r\n\r\n'));
  connection.end();
}

// (connection, { host, port }): a handler for host.js's `https` option.
export function httpsByFetch({ onrequest = () => {} } = {}) {
  return (connection, { host, port }) => {
    let buffer = new Uint8Array(0);
    let answered = false;
    connection.ondata = async (bytes) => {
      if (answered) return;
      buffer = concat(buffer, bytes);
      const end = indexOf(buffer, HEAD_END);
      if (end < 0) return;
      const lines = decoder.decode(buffer.subarray(0, end)).split('\r\n');
      const [method, target] = lines[0].split(' ');
      const headers = [];
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
      }
      const header = (name) => headers.find(([key]) => key === name)?.[1];
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
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: headers.filter(([name]) => !SKIP_REQUEST.has(name)),
          body: ['GET', 'HEAD'].includes(method) ? undefined : body,
          credentials: 'omit',
          redirect: 'follow',
        });
      } catch (error) {
        return failed(connection, 502, 'Bad Gateway',
          `playground: ${method} ${url} failed in the browser (${error.message}); ` +
          'the site may not allow cross-origin requests\n');
      }
      const kept = [];
      response.headers.forEach((value, name) => {
        if (!SKIP_RESPONSE.has(name)) kept.push([name, value]);
      });
      const empty = method === 'HEAD' || [204, 304].includes(response.status) || !response.body;
      head(connection, response.status, response.statusText || 'OK', kept, !empty);
      if (!empty) {
        try {
          const reader = response.body.getReader();
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
