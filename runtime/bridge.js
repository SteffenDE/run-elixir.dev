// The page's side of sw.js: an HTTP request from the preview iframe, sent
// to the node's listener as HTTP/1.1 on a connection of its own, and the
// response read back. Synthetic responses cannot set cookies, so the
// bridge keeps the app's cookies and sends them itself. HTML gets
// window.WebSocket removed, so that Phoenix sockets (LiveView) use long
// polling, which goes through the service worker.
const NO_WEBSOCKET = '<script>window.WebSocket = undefined;</script>';

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function dechunk(body) {
  const parts = [];
  let at = 0;
  const text = new TextDecoder('latin1');
  for (;;) {
    const end = body.indexOf(13, at);
    if (end < 0) break;
    const size = parseInt(text.decode(body.subarray(at, end)), 16);
    if (!size) break;
    parts.push(body.subarray(end + 2, end + 2 + size));
    at = end + 2 + size + 2;
  }
  return concat(parts);
}

export class Bridge {
  constructor(node, port = 4000) {
    this.node = node;
    this.port = port;
    this.cookies = new Map();
    navigator.serviceWorker.addEventListener('message', async (event) => {
      if (event.data?.kind !== 'http') return;
      const response = await this.request(event.data);
      event.ports[0].postMessage(response, response.body ? [response.body.buffer] : []);
    });
  }

  // Announce this page to the service worker as the host of `key` (sw.js
  // routes a preview's requests by it), once it controls the page, and
  // again when another worker takes over.
  static async register(url = 'sw.js', scope = './', key = 'default') {
    await navigator.serviceWorker.register(url, { scope });
    await Bridge.announce({ kind: 'host', key });
  }

  // Tell the service worker who this page is: { kind: 'host' | 'preview', key }.
  static async announce(message) {
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
    navigator.serviceWorker.controller.postMessage(message);
    navigator.serviceWorker.addEventListener('controllerchange', () => navigator.serviceWorker.controller?.postMessage(message));
  }

  request({ method, path, headers, body }) {
    return new Promise((resolve) => {
      const lines = [`${method} ${path} HTTP/1.1`, `host: localhost:${this.port}`, 'connection: close'];
      for (const [name, value] of headers) {
        if (!['host', 'connection', 'cookie', 'accept-encoding', 'content-length'].includes(name)) lines.push(`${name}: ${value}`);
      }
      if (this.cookies.size) lines.push(`cookie: ${[...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')}`);
      const payload = body ? new Uint8Array(body) : null;
      if (payload) lines.push(`content-length: ${payload.length}`);
      const chunks = [];
      const connection = this.node.connect(this.port);
      let done = false;
      const finish = (refused) => {
        if (done) return;
        done = true;
        if (refused || !chunks.length) {
          resolve({ status: 502, reason: 'Bad Gateway', headers: [['content-type', 'text/html']],
            body: new TextEncoder().encode('<meta http-equiv="refresh" content="2"><p style="font-family:system-ui">Waiting for the Phoenix server to start…</p>') });
          return;
        }
        resolve(this.parse(concat(chunks)));
      };
      connection.ondata = (bytes) => chunks.push(bytes);
      connection.onend = () => {
        finish(false);
        connection.close();
      };
      connection.onclose = (why) => finish(why === 'refused');
      connection.write(new TextEncoder().encode(lines.join('\r\n') + '\r\n\r\n'));
      if (payload) connection.write(payload);
    });
  }

  parse(raw) {
    let split = -1;
    for (let i = 0; i + 3 < raw.length; i++) {
      if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
        split = i;
        break;
      }
    }
    const head = new TextDecoder('latin1').decode(raw.subarray(0, split < 0 ? raw.length : split)).split('\r\n');
    let body = split < 0 ? new Uint8Array(0) : raw.slice(split + 4);
    const [, status, reason] = head[0].match(/^HTTP\/1\.[01] (\d+) ?(.*)$/) || [null, '502', 'Bad Gateway'];
    const headers = [];
    for (const line of head.slice(1)) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      const name = line.slice(0, at).trim().toLowerCase();
      const value = line.slice(at + 1).trim();
      if (name === 'set-cookie') this.remember(value);
      headers.push([name, value]);
    }
    if (headers.some(([n, v]) => n === 'transfer-encoding' && /chunked/i.test(v))) body = dechunk(body);
    const type = headers.find(([n]) => n === 'content-type')?.[1] ?? '';
    if (type.startsWith('text/html')) {
      const html = new TextDecoder().decode(body);
      const at = html.search(/<head[^>]*>/i);
      const injected = at < 0 ? NO_WEBSOCKET + html : html.replace(/<head[^>]*>/i, (m) => m + NO_WEBSOCKET);
      body = new TextEncoder().encode(injected);
    }
    return { status: Number(status), reason, headers, body };
  }

  remember(cookie) {
    const [pair, ...attributes] = cookie.split(';');
    const at = pair.indexOf('=');
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const expired = attributes.some((a) => {
      const [key, v] = a.trim().split('=');
      return (key.toLowerCase() === 'max-age' && Number(v) <= 0)
        || (key.toLowerCase() === 'expires' && Date.parse(v) < Date.now());
    });
    if (expired) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
}
