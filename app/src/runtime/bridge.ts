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
import type { Connection as NodeConnection } from './host/node';
import { trace } from './trace';

// A connection to the app: a node's, or one through a live session's
// relay to the host's node (src/live/lib/guest.ts).
export type Connection = Pick<NodeConnection, 'ondata' | 'onend' | 'onclose' | 'write' | 'close'>;

// What the preview's WebSocket and the page's bridge say over its port.
type ToSocket =
  | { open: string }
  | { message: string | ArrayBuffer }
  | { close: { code: number; reason: string; clean: boolean } };
type FromSocket = { send: string | ArrayBuffer } | { close: { code: number; reason?: string } };

// The preview's WebSocket: the browser's API over a MessagePort. Its
// source goes into the preview's HTML as it is.
function webSocketShim() {
  const states = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
  class PlaygroundWebSocket extends EventTarget {
    declare url: string;
    declare readyState: number;
    declare protocol: string;
    declare extensions: string;
    declare bufferedAmount: number;
    declare binaryType: 'blob' | 'arraybuffer';
    declare port: MessagePort;
    [handler: `on${string}`]: ((this: PlaygroundWebSocket, event: Event) => void) | null;

    constructor(url: string | URL, protocols: string | string[] = []) {
      super();
      this.url = new URL(url, location.href).href;
      this.readyState = 0;
      this.protocol = '';
      this.extensions = '';
      this.bufferedAmount = 0;
      this.binaryType = 'blob';
      for (const name of ['open', 'message', 'close', 'error']) this[`on${name}`] = null;
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = ({ data }: MessageEvent<ToSocket>) => this.receive(data);
      const target = new URL(this.url);
      navigator.serviceWorker.controller!.postMessage(
        {
          kind: 'websocket',
          path: target.pathname + target.search,
          protocols: ([] as string[]).concat(protocols),
        },
        [channel.port2],
      );
    }
    emit(event: Event) {
      this.dispatchEvent(event);
      const handler = this[`on${event.type}`];
      if (handler) handler.call(this, event);
    }
    receive(data: ToSocket) {
      if ('open' in data) {
        this.readyState = 1;
        this.protocol = data.open;
        this.emit(new Event('open'));
      } else if ('message' in data) {
        let message: string | ArrayBuffer | Blob = data.message;
        if (typeof message !== 'string' && this.binaryType === 'blob')
          message = new Blob([message]);
        this.emit(new MessageEvent('message', { data: message, origin: new URL(this.url).origin }));
      } else if ('close' in data) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        if (!data.close.clean) this.emit(new Event('error'));
        this.emit(
          new CloseEvent('close', {
            code: data.close.code,
            reason: data.close.reason,
            wasClean: data.close.clean,
          }),
        );
        this.port.close();
      }
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.readyState === 0)
        throw new DOMException('Still in CONNECTING state.', 'InvalidStateError');
      if (this.readyState !== 1) return;
      if (data instanceof Blob)
        data.arrayBuffer().then((buffer) => this.port.postMessage({ send: buffer }));
      else if (ArrayBuffer.isView(data))
        this.port.postMessage({
          send: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        });
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
  window.WebSocket = PlaygroundWebSocket as unknown as typeof WebSocket;
}

// The preview's links, as the app means them. The app believes it is at
// http://localhost:PORT, so it writes absolute links there (a magic link
// in a mail): they go to their path here. Its top is the preview's first
// frame, not the IDE's page: Swoosh's mailbox opens a mail's links in
// _top, which would navigate the IDE away. Changed as they are clicked or
// submitted, not in the HTML.
function linkShim(port: number) {
  const marked = window as Window & { playgroundApp?: boolean };
  marked.playgroundApp = true;
  const app = (url: URL) =>
    url.origin === location.origin ||
    (url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.port === String(port));
  const parentOf = (win: Window): Window | null => {
    try {
      return win.parent !== win &&
        (win.parent as Window & { playgroundApp?: boolean }).playgroundApp
        ? win.parent
        : null;
    } catch {
      return null;
    }
  };
  const root = () => {
    let win: Window = window;
    for (let up = parentOf(win); up; up = parentOf(win)) win = up;
    return win;
  };
  const path = (url: URL) => url.pathname + url.search + url.hash;
  addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const link = event
        .composedPath()
        .find((node): node is HTMLAnchorElement => (node as Element).tagName === 'A');
      if (!link?.href) return;
      const url = new URL(link.href, location.href);
      const target = (
        link.target ||
        document.querySelector('base[target]')?.getAttribute('target') ||
        ''
      ).toLowerCase();
      const out = target === '_top' || target === '_parent';
      if (!app(url)) {
        // Out of the preview, not over the IDE.
        if (out) {
          event.preventDefault();
          open(url.href, '_blank', 'noopener');
        }
        return;
      }
      if (url.origin !== location.origin) link.href = path(url);
      if (!out) return;
      const into = target === '_top' ? root() : (parentOf(window) ?? window);
      if (into === window) {
        link.target = '_self';
        return;
      }
      event.preventDefault();
      into.location.assign(path(url));
    },
    true,
  );
  addEventListener(
    'submit',
    (event) => {
      const form = event.target as HTMLFormElement;
      const url = new URL(form.action, location.href);
      if (app(url) && url.origin !== location.origin) form.action = path(url);
    },
    true,
  );
}

const shims = (port: number) => `<script>(${webSocketShim})();(${linkShim})(${port})</script>`;

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function dechunk(body: Uint8Array): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
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

// A request from the preview (sw.js), and what answers it.
export interface PreviewRequest {
  method: string;
  path: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}
export interface PreviewResponse {
  status: number;
  reason: string;
  headers: [string, string][];
  body: Uint8Array<ArrayBuffer>;
}

// A request or WebSocket under way, for debug().
interface Flight {
  kind: 'http' | 'websocket';
  what: string;
  started: number;
  bytes: number;
  state: string;
}

export class Bridge {
  declare node: { connect(port: number): Connection };
  declare port: number;
  declare cookies: Map<string, string>;
  flights = new Map<number, Flight>();
  nextFlight = 1;

  // What is under way, for a bug hunt: window.playground.debug().
  debug() {
    return [...this.flights.values()].map(({ started, ...flight }) => ({
      ...flight,
      age: `${((Date.now() - started) / 1000).toFixed(1)} s`,
    }));
  }

  private flight(kind: Flight['kind'], what: string): Flight {
    const flight = { kind, what, started: Date.now(), bytes: 0, state: 'connecting' };
    const number = this.nextFlight++;
    this.flights.set(number, flight);
    trace('net', `bridge ${kind} ${number}: ${what}`);
    const done = () => {
      this.flights.delete(number);
      trace('net', `bridge ${kind} ${number}: done (${flight.state}, ${flight.bytes} bytes)`);
    };
    return Object.assign(flight, { done });
  }

  constructor(node: { connect(port: number): Connection }, port = 4000) {
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
  cookieHeader(): string | null {
    const cookies = [...this.cookies].map(([k, v]) => `${k}=${v}`);
    if (typeof document !== 'undefined' && document.cookie) cookies.push(document.cookie);
    return cookies.length ? `cookie: ${cookies.join('; ')}` : null;
  }

  // A preview's WebSocket (webSocketShim): the opening handshake on a
  // connection to the app, then frames both ways. `port` speaks
  // { open | message | close } to the preview and hears { send | close }.
  websocket({ path, protocols }: { path: string; protocols: string[] }, port: MessagePort): void {
    const flight = this.flight('websocket', path) as Flight & { done(): void };
    const connection = this.node.connect(this.port);
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const lines = [
      `GET ${path} HTTP/1.1`,
      `host: localhost:${this.port}`,
      'upgrade: websocket',
      'connection: Upgrade',
      `sec-websocket-key: ${key}`,
      'sec-websocket-version: 13',
      `origin: http://localhost:${this.port}`,
    ];
    if (protocols.length) lines.push(`sec-websocket-protocol: ${protocols.join(', ')}`);
    const cookie = this.cookieHeader();
    if (cookie) lines.push(cookie);
    connection.write(new TextEncoder().encode(lines.join('\r\n') + '\r\n\r\n'));

    let buffer = new Uint8Array(0);
    let open = false;
    let closed = false;
    let fragments: Uint8Array[] = [];
    let fragmentType = 0;
    const finish = (code: number, reason: string, clean: boolean) => {
      if (closed) return;
      closed = true;
      flight.state = `closed ${code}`;
      flight.done();
      port.postMessage({ close: { code, reason, clean } });
      port.close();
      connection.close();
    };
    // A frame to the app: masked, as a client's must be.
    const frame = (opcode: number, payload: Uint8Array) => {
      const mask = crypto.getRandomValues(new Uint8Array(4));
      const length = payload.length;
      const head =
        length < 126
          ? [0x80 | opcode, 0x80 | length]
          : length < 65536
            ? [0x80 | opcode, 0x80 | 126, length >> 8, length & 255]
            : [
                0x80 | opcode,
                0x80 | 127,
                0,
                0,
                0,
                0,
                (length >>> 24) & 255,
                (length >> 16) & 255,
                (length >> 8) & 255,
                length & 255,
              ];
      const bytes = new Uint8Array(head.length + 4 + length);
      bytes.set(head);
      bytes.set(mask, head.length);
      for (let i = 0; i < length; i++) bytes[head.length + 4 + i] = payload[i] ^ mask[i & 3];
      connection.write(bytes);
    };
    port.onmessage = ({ data }: MessageEvent<FromSocket>) => {
      if (closed) return;
      if ('send' in data) {
        if (typeof data.send === 'string') frame(1, new TextEncoder().encode(data.send));
        else frame(2, new Uint8Array(data.send));
      } else if ('close' in data) {
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
        port.postMessage({
          message: fragmentType === 1 ? new TextDecoder().decode(whole) : whole.buffer,
        });
      }
    };
    connection.ondata = (bytes) => {
      flight.bytes += bytes.length;
      buffer = concat([buffer, bytes]);
      if (!open) {
        let split = -1;
        for (let i = 0; i + 3 < buffer.length; i++) {
          if (
            buffer[i] === 13 &&
            buffer[i + 1] === 10 &&
            buffer[i + 2] === 13 &&
            buffer[i + 3] === 10
          ) {
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
        const protocol =
          head
            .find((line) => /^sec-websocket-protocol:/i.test(line))
            ?.split(':')[1]
            .trim() ?? '';
        open = true;
        flight.state = 'open';
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
  static async register(url = 'sw.js', scope = './', key = 'default'): Promise<void> {
    await navigator.serviceWorker.register(url, { scope });
    // A forced reload (shift-reload) loads the page uncontrolled; the
    // active worker takes it over when asked.
    const { active } = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) active!.postMessage('claim');
    await Bridge.announce({ kind: 'host', key });
  }

  // Tell the service worker who this page is: { kind: 'host' | 'preview', key }.
  static async announce(message: { kind: 'host' | 'preview'; key: string }): Promise<void> {
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
      );
    }
    navigator.serviceWorker.controller!.postMessage(message);
    navigator.serviceWorker.addEventListener('controllerchange', () =>
      navigator.serviceWorker.controller?.postMessage(message),
    );
  }

  request({ method, path, headers, body }: PreviewRequest): Promise<PreviewResponse> {
    return new Promise((resolve) => {
      const lines = [
        `${method} ${path} HTTP/1.1`,
        `host: localhost:${this.port}`,
        'connection: close',
      ];
      for (const [name, value] of headers) {
        if (!['host', 'connection', 'cookie', 'accept-encoding', 'content-length'].includes(name))
          lines.push(`${name}: ${value}`);
      }
      const cookie = this.cookieHeader();
      if (cookie) lines.push(cookie);
      const payload = body ? new Uint8Array(body) : null;
      if (payload) lines.push(`content-length: ${payload.length}`);
      const chunks: Uint8Array[] = [];
      const flight = this.flight('http', `${method} ${path}`) as Flight & { done(): void };
      const connection = this.node.connect(this.port);
      flight.state = 'waiting for the answer';
      let done = false;
      const finish = (refused: boolean) => {
        if (done) return;
        done = true;
        flight.state = refused
          ? 'refused'
          : chunks.length
            ? 'answered'
            : 'closed without an answer';
        flight.done();
        if (refused || !chunks.length) {
          resolve({
            status: 502,
            reason: 'Bad Gateway',
            headers: [['content-type', 'text/html']],
            body: new TextEncoder().encode(
              '<meta http-equiv="refresh" content="2"><p style="font-family:system-ui">Waiting for the Phoenix server to start…</p>',
            ),
          });
          return;
        }
        resolve(this.parse(concat(chunks)));
      };
      connection.ondata = (bytes) => {
        flight.bytes += bytes.length;
        flight.state = 'receiving (until the node ends the connection)';
        chunks.push(bytes);
      };
      connection.onend = () => {
        finish(false);
        connection.close();
      };
      connection.onclose = (why) => finish(why === 'refused');
      connection.write(new TextEncoder().encode(lines.join('\r\n') + '\r\n\r\n'));
      if (payload) connection.write(payload);
    });
  }

  parse(raw: Uint8Array<ArrayBuffer>): PreviewResponse {
    let split = -1;
    for (let i = 0; i + 3 < raw.length; i++) {
      if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
        split = i;
        break;
      }
    }
    const head = new TextDecoder('latin1')
      .decode(raw.subarray(0, split < 0 ? raw.length : split))
      .split('\r\n');
    let body = split < 0 ? new Uint8Array(0) : raw.slice(split + 4);
    const [, status, reason] = head[0].match(/^HTTP\/1\.[01] (\d+) ?(.*)$/) || [
      null,
      '502',
      'Bad Gateway',
    ];
    const headers: [string, string][] = [];
    for (const line of head.slice(1)) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      const name = line.slice(0, at).trim().toLowerCase();
      const value = line.slice(at + 1).trim();
      if (name === 'set-cookie') this.remember(value);
      // A redirect to the app's absolute URL: its path, here.
      if (name === 'location') {
        const app = value.match(/^http:\/\/(?:localhost|127\.0\.0\.1):(\d+)(\/.*)?$/);
        if (app && Number(app[1]) === this.port) {
          headers.push([name, app[2] ?? '/']);
          continue;
        }
      }
      headers.push([name, value]);
    }
    if (headers.some(([n, v]) => n === 'transfer-encoding' && /chunked/i.test(v)))
      body = dechunk(body);
    const type = headers.find(([n]) => n === 'content-type')?.[1] ?? '';
    if (type.startsWith('text/html')) {
      const html = new TextDecoder().decode(body);
      const at = html.search(/<head[^>]*>/i);
      const scripts = shims(this.port);
      const injected = at < 0 ? scripts + html : html.replace(/<head[^>]*>/i, (m) => m + scripts);
      body = new TextEncoder().encode(injected);
    }
    return { status: Number(status), reason, headers, body };
  }

  remember(cookie: string): void {
    const [pair, ...attributes] = cookie.split(';');
    const at = pair.indexOf('=');
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const flags = attributes.map((a) => a.trim().split('=')[0].toLowerCase());
    const expired = attributes.some((a) => {
      const [key, v] = a.trim().split('=');
      return (
        (key.toLowerCase() === 'max-age' && Number(v) <= 0) ||
        (key.toLowerCase() === 'expires' && Date.parse(v) < Date.now())
      );
    });
    if (flags.includes('httponly') || typeof document === 'undefined') {
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
      // A browser keeps one cookie of a name: an HttpOnly one replaces, or
      // expires, one the app's JavaScript set (LiveView's reload status,
      // which Plug's delete_resp_cookie expires as HttpOnly).
      if (typeof document !== 'undefined' && hasCookie(name)) {
        const path = attributes.map((a) => a.trim()).find((a) => /^path=/i.test(a)) ?? 'path=/';
        document.cookie = `${name}=; ${path}; max-age=0`;
      }
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

function hasCookie(name: string): boolean {
  return document.cookie.split(';').some((pair) => pair.split('=')[0].trim() === name);
}
