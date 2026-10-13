// The page's side of sw.js: an HTTP request from the preview iframe, sent
// to the node's listener as HTTP/1.1 on a connection of its own, and the
// response read back. Synthetic responses cannot set cookies, and a service
// worker does not see a request's Cookie header, so the bridge keeps the
// app's HttpOnly cookies itself and puts the others in document.cookie (the
// preview's origin is this page's), where the app's JavaScript reads and
// sets them too (LiveView's flash across a reload); it sends both.
//
// A service worker does not see WebSocket connections, so HTML gets a
// WebSocket of its own (webSocketShim): it asks the service worker, which
// passes a MessagePort to the page running the project, where websocket()
// connects to the node and speaks the protocol (RFC 6455) for it.

// The preview's WebSocket: the browser's API over a MessagePort.
function webSocketShim() {
  const states = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
  class PlaygroundWebSocket extends EventTarget {
    constructor(url, protocols = []) {
      super();
      this.url = new URL(url, location.href).href;
      this.readyState = 0;
      this.protocol = '';
      this.extensions = '';
      this.bufferedAmount = 0;
      this.binaryType = 'blob';
      for (const name of ['open', 'message', 'close', 'error']) this['on' + name] = null;
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = ({ data }) => this.receive(data);
      const target = new URL(this.url);
      navigator.serviceWorker.controller.postMessage(
        { kind: 'websocket', path: target.pathname + target.search, protocols: [].concat(protocols) },
        [channel.port2],
      );
    }
    emit(event) {
      this.dispatchEvent(event);
      const handler = this['on' + event.type];
      if (handler) handler.call(this, event);
    }
    receive(data) {
      if (data.open !== undefined) {
        this.readyState = 1;
        this.protocol = data.open;
        this.emit(new Event('open'));
      } else if (data.message !== undefined) {
        let message = data.message;
        if (typeof message !== 'string' && this.binaryType === 'blob') message = new Blob([message]);
        this.emit(new MessageEvent('message', { data: message, origin: new URL(this.url).origin }));
      } else if (data.close) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        if (!data.close.clean) this.emit(new Event('error'));
        this.emit(new CloseEvent('close', { code: data.close.code, reason: data.close.reason, wasClean: data.close.clean }));
        this.port.close();
      }
    }
    send(data) {
      if (this.readyState === 0) throw new DOMException('Still in CONNECTING state.', 'InvalidStateError');
      if (this.readyState !== 1) return;
      if (data instanceof Blob) data.arrayBuffer().then((buffer) => this.port.postMessage({ send: buffer }));
      else if (ArrayBuffer.isView(data)) this.port.postMessage({ send: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
      else this.port.postMessage({ send: data instanceof ArrayBuffer ? data : String(data) });
    }
    close(code = 1000, reason = '') {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      this.port.postMessage({ close: { code, reason } });
    }
  }
  Object.assign(PlaygroundWebSocket, states);
  Object.assign(PlaygroundWebSocket.prototype, states);
  window.WebSocket = PlaygroundWebSocket;
}
const WEBSOCKET = `<script>(${webSocketShim})()</script>`;

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
      if (event.data?.kind === 'websocket') {
        this.websocket(event.data, event.ports[0]);
        return;
      }
      if (event.data?.kind !== 'http') return;
      const response = await this.request(event.data);
      event.ports[0].postMessage(response, response.body ? [response.body.buffer] : []);
    });
  }

  // The cookie header for a request: the app's HttpOnly cookies and those in
  // document.cookie.
  cookieHeader() {
    const cookies = [...this.cookies].map(([k, v]) => `${k}=${v}`);
    if (typeof document !== 'undefined' && document.cookie) cookies.push(document.cookie);
    return cookies.length ? `cookie: ${cookies.join('; ')}` : null;
  }

  // A preview's WebSocket (webSocketShim): the opening handshake on a
  // connection to the app, then frames both ways. `port` speaks
  // { open | message | close } to the preview and hears { send | close }.
  websocket({ path, protocols }, port) {
    const connection = this.node.connect(this.port);
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const lines = [`GET ${path} HTTP/1.1`, `host: localhost:${this.port}`, 'upgrade: websocket', 'connection: Upgrade',
      `sec-websocket-key: ${key}`, 'sec-websocket-version: 13', `origin: http://localhost:${this.port}`];
    if (protocols.length) lines.push(`sec-websocket-protocol: ${protocols.join(', ')}`);
    const cookie = this.cookieHeader();
    if (cookie) lines.push(cookie);
    connection.write(new TextEncoder().encode(lines.join('\r\n') + '\r\n\r\n'));

    let buffer = new Uint8Array(0);
    let open = false;
    let closed = false;
    let fragments = [];
    let fragmentType = 0;
    const finish = (code, reason, clean) => {
      if (closed) return;
      closed = true;
      port.postMessage({ close: { code, reason, clean } });
      port.close();
      connection.close();
    };
    // A frame to the app: masked, as a client's must be.
    const frame = (opcode, payload) => {
      const mask = crypto.getRandomValues(new Uint8Array(4));
      const length = payload.length;
      const head = length < 126 ? [0x80 | opcode, 0x80 | length]
        : length < 65536 ? [0x80 | opcode, 0x80 | 126, length >> 8, length & 255]
          : [0x80 | opcode, 0x80 | 127, 0, 0, 0, 0, (length >>> 24) & 255, (length >> 16) & 255, (length >> 8) & 255, length & 255];
      const bytes = new Uint8Array(head.length + 4 + length);
      bytes.set(head);
      bytes.set(mask, head.length);
      for (let i = 0; i < length; i++) bytes[head.length + 4 + i] = payload[i] ^ mask[i & 3];
      connection.write(bytes);
    };
    port.onmessage = ({ data }) => {
      if (closed) return;
      if (data.send !== undefined) {
        if (typeof data.send === 'string') frame(1, new TextEncoder().encode(data.send));
        else frame(2, new Uint8Array(data.send));
      } else if (data.close) {
        const reason = new TextEncoder().encode(data.close.reason ?? '');
        frame(8, new Uint8Array([data.close.code >> 8, data.close.code & 255, ...reason]));
      }
    };
    // Frames from the app: unmasked; fragments joined; pings answered.
    const frames = () => {
      for (;;) {
        if (buffer.length < 2) return;
        const fin = buffer[0] & 0x80;
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let at = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = (buffer[2] << 8) | buffer[3];
          at = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(new DataView(buffer.buffer, buffer.byteOffset + 2, 8).getBigUint64(0));
          at = 10;
        }
        if (buffer[1] & 0x80) at += 4; // Servers do not mask; skip a key if one does.
        if (buffer.length < at + length) return;
        const payload = buffer.slice(at, at + length);
        buffer = buffer.slice(at + length);
        if (opcode === 8) {
          const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
          frame(8, payload.slice(0, 2));
          finish(code, new TextDecoder().decode(payload.slice(2)), true);
          return;
        }
        if (opcode === 9) frame(10, payload);
        if (opcode >= 8) continue;
        if (opcode !== 0) fragmentType = opcode;
        fragments.push(payload);
        if (!fin) continue;
        const whole = concat(fragments);
        fragments = [];
        port.postMessage({ message: fragmentType === 1 ? new TextDecoder().decode(whole) : whole.buffer });
      }
    };
    connection.ondata = (bytes) => {
      buffer = concat([buffer, bytes]);
      if (!open) {
        let split = -1;
        for (let i = 0; i + 3 < buffer.length; i++) {
          if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
            split = i;
            break;
          }
        }
        if (split < 0) return;
        const head = new TextDecoder('latin1').decode(buffer.subarray(0, split)).split('\r\n');
        buffer = buffer.slice(split + 4);
        if (!/^HTTP\/1\.1 101/.test(head[0])) {
          finish(1006, '', false);
          return;
        }
        for (const line of head.slice(1)) {
          const [name, ...value] = line.split(':');
          if (name.trim().toLowerCase() === 'set-cookie') this.remember(value.join(':').trim());
        }
        const protocol = head.find((line) => /^sec-websocket-protocol:/i.test(line))?.split(':')[1].trim() ?? '';
        open = true;
        port.postMessage({ open: protocol });
      }
      frames();
    };
    connection.onend = () => finish(1006, '', false);
    connection.onclose = () => finish(1006, '', false);
  }

  // Announce this page to the service worker as the host of `key` (sw.js
  // routes a preview's requests by it), once it controls the page, and
  // again when another worker takes over.
  static async register(url = 'sw.js', scope = './', key = 'default') {
    await navigator.serviceWorker.register(url, { scope });
    // A forced reload (shift-reload) loads the page uncontrolled; the
    // active worker takes it over when asked.
    const { active } = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) active.postMessage('claim');
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
      const cookie = this.cookieHeader();
      if (cookie) lines.push(cookie);
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
      const injected = at < 0 ? WEBSOCKET + html : html.replace(/<head[^>]*>/i, (m) => m + WEBSOCKET);
      body = new TextEncoder().encode(injected);
    }
    return { status: Number(status), reason, headers, body };
  }

  remember(cookie) {
    const [pair, ...attributes] = cookie.split(';');
    const at = pair.indexOf('=');
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const flags = attributes.map((a) => a.trim().split('=')[0].toLowerCase());
    const expired = attributes.some((a) => {
      const [key, v] = a.trim().split('=');
      return (key.toLowerCase() === 'max-age' && Number(v) <= 0)
        || (key.toLowerCase() === 'expires' && Date.parse(v) < Date.now());
    });
    if (flags.includes('httponly') || typeof document === 'undefined') {
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
      return;
    }
    // The app's JavaScript may read it: the browser keeps it. Secure and
    // SameSite=None need https, which the preview's origin may not be.
    this.cookies.delete(name);
    const kept = attributes
      .map((a) => a.trim())
      .filter((a) => !/^(secure|samesite|domain)/i.test(a));
    document.cookie = [`${name}=${value}`, ...kept, ...(expired ? ['max-age=0'] : [])].join('; ');
  }
}
