// The way from the usercontent domain's code back to the apex
// (docs/frames.md, "Bridge mode"): the one seam the runtime reads its
// site's files and reaches the backend's services through.
//
// - **The site's files** (fs layer manifests and bundles, boot recordings,
//   WebAssembly modules) come from the network, at the URLs the site
//   manifest names: below `siteRoot()` on a usercontent domain that serves
//   the packages; in bridge mode, where the apex serves them (with CORS),
//   past the service worker and the apex's worker.
// - **The backend's services** (NIF builds, git's smart HTTP, the TCP
//   relay) are the apex's in every mode: `serviceUrl()` names them below
//   `_services/`, and only the link reaches them. The apex's worker makes
//   the request, so the backend sees the apex's Origin.
//
// The exec frame's worker (exec/host.ts) holds the link: a MessagePort to
// the apex's worker. The workers it starts (the nodes, git.js) may block on
// a service (a node's NIF build), and a worker cannot wait for a message;
// so each gets a port to the exec frame's worker, which asks the apex and
// hands the answer back through shared memory (`linkFor`, `useLink`).

// A request over the link, with a reply port: `path` is below the site's
// root (`npm/@elixir-playground/NAME@VERSION/FILE`, `_services/…`), with
// its query. The reply is a LinkResponse.
export interface LinkRequest {
  kind: 'get';
  path: string;
  method?: string;
  headers?: [string, string][];
  body?: ArrayBuffer | null;
}
export interface LinkResponse {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer | null;
}
// A WebSocket the apex's worker opens (`path`: `_services/relay`), with a
// port that carries it (portSocket).
export interface LinkSocket {
  kind: 'socket';
  path: string;
}

// Where the site's files are: the usercontent origin's root, or in bridge
// mode the bridge's root on it (/_bridge/KEY/: its service worker routes
// what is below it to this bridge's apex). From this module's own URL, not
// `location`: a blob worker's location is its blob.
const BRIDGED = /^\/_bridge\/([A-Za-z0-9_-]{16,64})\//;
function rootOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return new URL('/', parsed).href;
    const bridged = parsed.pathname.match(BRIDGED);
    return `${parsed.origin}${bridged ? bridged[0] : '/'}`;
  } catch {
    return 'file:///';
  }
}
let root = rootOf(import.meta.url);
export const siteRoot = () => root;
// The bridge's key, in bridge mode.
export const bridgeKey = () => root.match(/\/_bridge\/([^/]+)\/$/)?.[1] ?? null;
// For tests, and the Node harness.
export function setSiteRoot(url: string): void {
  root = rootOf(url);
}

const SERVICES = '_services/';
// A service's URL: `nif/NAME/VERSION?abi=…`, `git/HOST/OWNER/REPO/…`.
export const serviceUrl = (path: string) => `${siteRoot()}${SERVICES}${path.replace(/^\/+/, '')}`;
const isService = (url: string) => url.startsWith(`${siteRoot()}${SERVICES}`);

// The link: the services, never the site's files.
let link: { async: MessagePort } | { sync: SyncLink } | null = null;

// This worker's link to the apex's worker (the exec frame's worker).
export function useApexLink(port: MessagePort): void {
  link = { async: port };
}

// What goes over the link rather than the network.
const linked = isService;

function relative(url: string): string {
  return url.slice(siteRoot().length);
}

// Ask the apex's worker for `path`.
function ask(port: MessagePort, request: LinkRequest): Promise<LinkResponse> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }: MessageEvent<LinkResponse>) => {
      channel.port1.close();
      resolve(data);
    };
    port.postMessage(request, [channel.port2, ...(request.body ? [request.body] : [])]);
  });
}

// Counts and times of the site's files read, by every worker of the exec
// frame, for the measurements (docs/frames.md): each read is told on a
// BroadcastChannel (its origin's: the project's), and the exec frame's
// worker adds them up (`countReads`) for its `debug`: the fs layers'
// bundles apart from the other files.
const tally = () => ({ count: 0, bytes: 0, millis: [] as number[] });
export const reads = { bundles: tally(), other: tally() };
let told: BroadcastChannel | null = null;
function note(started: number, bytes: number, url: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  told ??= new BroadcastChannel('playground-reads');
  told.postMessage([performance.now() - started, bytes, url.includes('/fs/bundles/')]);
}
export function countReads(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  new BroadcastChannel('playground-reads').onmessage = ({ data: [millis, bytes, bundle] }) => {
    const kind = bundle ? reads.bundles : reads.other;
    kind.count++;
    kind.bytes += bytes;
    if (kind.millis.length < 100_000) kind.millis.push(millis);
  };
}

async function bodyOf(init?: RequestInit): Promise<ArrayBuffer | null> {
  if (init?.body == null) return null;
  return new Response(init.body).arrayBuffer();
}

// fetch(), for the site's files and the services.
export async function siteFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), siteRoot()).href;
  if (!linked(url)) {
    const started = performance.now();
    const response = await fetch(url, init);
    if (!isService(url)) {
      const bytes = await response.arrayBuffer();
      note(started, bytes.byteLength, url);
      return new Response(bytes, { status: response.status, headers: response.headers });
    }
    return response;
  }
  if (!link) return new Response(null, { status: 502, statusText: 'no link to the apex' });
  const started = performance.now();
  const request: LinkRequest = {
    kind: 'get',
    path: relative(url),
    method: init?.method ?? 'GET',
    headers: [...new Headers(init?.headers)],
    body: await bodyOf(init),
  };
  const answer = 'async' in link ? await ask(link.async, request) : link.sync.request(request);
  if (!isService(url)) note(started, answer.body?.byteLength ?? 0, url);
  const empty = [101, 204, 205, 304].includes(answer.status) || answer.status < 200;
  return new Response(empty ? null : answer.body, {
    status: answer.status || 502,
    headers: answer.headers,
  });
}

// A GET, synchronously (a worker that waits for a file): [status, bytes],
// status 0 when it failed.
export function siteGetSync(input: string | URL): [number, Uint8Array | null];
export function siteGetSync(input: string | URL, binary: false): [number, string | null];
export function siteGetSync(
  input: string | URL,
  binary = true,
): [number, Uint8Array | string | null] {
  const url = new URL(String(input), siteRoot()).href;
  const started = performance.now();
  let status = 0;
  let bytes: Uint8Array | null = null;
  if (linked(url) && link && 'sync' in link) {
    const answer = link.sync.request({ kind: 'get', path: relative(url), method: 'GET' });
    status = answer.status;
    bytes = answer.body ? new Uint8Array(answer.body) : null;
  } else if (linked(url)) {
    return [0, null];
  } else {
    const request = new XMLHttpRequest();
    request.open('GET', url, false);
    request.responseType = 'arraybuffer';
    try {
      request.send();
      status = request.status;
      bytes = new Uint8Array(request.response);
    } catch {
      return [0, null];
    }
  }
  if (!isService(url)) note(started, bytes?.length ?? 0, url);
  return [status, binary ? bytes : bytes && new TextDecoder().decode(bytes)];
}

// A WebSocket to a service (`relay`), opened by the apex's worker: what
// relay.ts takes (the few members it uses).
export function serviceSocket(path: string): WebSocket {
  if (!link || !('async' in link)) throw new Error('no link to the apex');
  const channel = new MessageChannel();
  link.async.postMessage({ kind: 'socket', path: `${SERVICES}${path}` } satisfies LinkSocket, [
    channel.port2,
  ]);
  return portSocket(channel.port1) as unknown as WebSocket;
}

// A WebSocket's members over a port: { open }, { message }, { close }
// in; { send }, { close } out. Exported for its test.
export function portSocket(port: MessagePort) {
  const socket = {
    binaryType: 'arraybuffer' as BinaryType,
    readyState: 0,
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onclose: null as ((event: CloseEvent | Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    send(data: ArrayBufferLike | ArrayBufferView) {
      const bytes =
        data instanceof ArrayBuffer
          ? data.slice(0)
          : new Uint8Array(
              (data as ArrayBufferView).buffer,
              (data as ArrayBufferView).byteOffset,
              (data as ArrayBufferView).byteLength,
            ).slice().buffer;
      port.postMessage({ send: bytes }, [bytes]);
    },
    close() {
      if (socket.readyState >= 2) return;
      socket.readyState = 2;
      port.postMessage({ close: true });
    },
  };
  port.onmessage = ({ data }) => {
    if (data?.open) {
      socket.readyState = 1;
      socket.onopen?.(new Event('open'));
    } else if (data?.message) {
      socket.onmessage?.(new MessageEvent('message', { data: data.message }));
    } else if (data?.close) {
      socket.readyState = 3;
      if (data.close.error) socket.onerror?.(new Event('error'));
      socket.onclose?.(new Event('close'));
      port.close();
    }
  };
  return socket;
}

// The workers the exec frame's worker starts: a port to it each, which it
// serves (linkFor), and the worker's side (useLink). A request is answered
// in chunks through shared memory, since the worker waits in
// Atomics.wait: [ready, status, total, length, id] and then the chunk.
// `id` is the request's: an answer that came after its request gave up
// is not the next one's.
const CHUNK = 1 << 22;
const HEADER = 32;
// How long a worker waits for an answer before it counts as failed.
const WAIT = 120_000;

class SyncLink {
  private buffer = new SharedArrayBuffer(HEADER + CHUNK);
  private control = new Int32Array(this.buffer, 0, 5);
  private data = new Uint8Array(this.buffer, HEADER);
  private next = 1;

  constructor(private port: MessagePort) {}

  request(request: LinkRequest): LinkResponse {
    const { control } = this;
    const id = this.next++;
    Atomics.store(control, 0, 0);
    this.port.postMessage(
      { ...request, id, buffer: this.buffer },
      request.body ? [request.body] : [],
    );
    let out: Uint8Array | null = null;
    let at = 0;
    let headers: [string, string][] = [];
    const until = performance.now() + WAIT;
    for (;;) {
      const left = until - performance.now();
      if (left <= 0 || Atomics.wait(control, 0, 0, left) === 'timed-out')
        return { status: 0, headers: [], body: null };
      // Another request's late answer: not this one's.
      if (control[4] !== id) {
        Atomics.store(control, 0, 0);
        continue;
      }
      const status = control[1];
      const total = control[2];
      const length = control[3];
      if (!out) {
        out = new Uint8Array(total);
        const decoded = new TextDecoder().decode(this.data.slice(0, length));
        headers = decoded ? JSON.parse(decoded) : [];
      } else {
        out.set(this.data.subarray(0, length), at);
        at += length;
      }
      if (at >= total)
        return { status, headers, body: total || status ? (out.buffer as ArrayBuffer) : null };
      Atomics.store(control, 0, 0);
      this.port.postMessage({ kind: 'more' });
    }
  }
}

// A worker's side: the port the exec frame's worker gave it.
export function useLink(port: MessagePort | null | undefined): void {
  if (!port) return;
  link = { sync: new SyncLink(port) };
}

// The exec frame's worker: a port for a worker it starts, served from its
// own link; null without one.
export function linkFor(): MessagePort | null {
  if (!link || !('async' in link)) return null;
  const upstream = link.async;
  const channel = new MessageChannel();
  serveSync(channel.port1, (request) => ask(upstream, request));
  return channel.port2;
}

// Answers a worker's requests through shared memory: the headers first
// (JSON), then the body in chunks, each when the worker asks for more.
export function serveSync(
  port: MessagePort,
  answer: (request: LinkRequest) => Promise<LinkResponse>,
): void {
  let pending: { control: Int32Array; data: Uint8Array; body: Uint8Array; at: number } | null =
    null;
  // The newest request: an older one's answer is dropped.
  let newest = 0;
  const send = () => {
    if (!pending) return;
    const { control, data, body, at } = pending;
    const length = Math.min(CHUNK, body.length - at);
    data.set(body.subarray(at, at + length));
    control[3] = length;
    pending.at += length;
    if (pending.at >= body.length) pending = null;
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
  };
  port.onmessage = async ({ data: message }) => {
    if (message?.kind === 'more') return send();
    if (message?.kind !== 'get') return;
    const { buffer, id, ...request } = message as LinkRequest & {
      buffer: SharedArrayBuffer;
      id: number;
    };
    newest = id;
    const control = new Int32Array(buffer, 0, 5);
    const data = new Uint8Array(buffer, HEADER);
    let response: LinkResponse;
    try {
      response = await answer(request);
    } catch {
      response = { status: 0, headers: [], body: null };
    }
    if (id !== newest) return;
    const body = new Uint8Array(response.body ?? new ArrayBuffer(0));
    const headers = new TextEncoder().encode(JSON.stringify(response.headers ?? []));
    data.set(headers.subarray(0, CHUNK));
    control[1] = response.status;
    control[2] = body.length;
    control[3] = Math.min(headers.length, CHUNK);
    control[4] = id;
    pending = body.length ? { control, data, body, at: 0 } : null;
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
  };
}
