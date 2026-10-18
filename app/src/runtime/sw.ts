// The playground's service worker: what a preview iframe asks for goes to
// the app in a node, through the page that runs it (bridge.ts); everything
// else (the playground itself) comes from the network. The app sees its
// own paths, so its absolute links work in the iframe.
//
// Several pages may run projects at once, so every request is routed by a
// key: the page running a project announces itself as the host of its key
// ({ kind: 'host', key }), and a popped-out preview window as showing it
// ({ kind: 'preview', key }). A preview's document gets the key of the
// client that navigated it (its referrer), or of the only (or focused)
// host. Which client has which key is kept in IndexedDB too, since a
// service worker is stopped when idle and starts again without its memory.
import type { PreviewResponse } from './bridge';

// What this worker uses of its scope, which the app's DOM library leaves
// out.
interface Client {
  id: string;
  url: string;
  focused?: boolean;
  frameType?: 'auxiliary' | 'top-level' | 'nested' | 'none';
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface ClientMessageEvent extends ExtendableEvent {
  // oxlint-disable-next-line typescript/no-explicit-any -- what pages send.
  data: any;
  source: Client;
  ports: readonly MessagePort[];
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  clientId: string;
  resultingClientId: string;
  respondWith(response: Response | Promise<Response>): void;
}
declare const self: {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: {
    matchAll(options?: { includeUncontrolled?: boolean; type?: 'window' }): Promise<Client[]>;
    get(id: string): Promise<Client | undefined>;
    claim(): Promise<void>;
  };
  addEventListener(type: 'install', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'message', listener: (event: ClientMessageEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// What every answer to the preview carries: it is in a cross-origin
// isolated page, which loads no frame without them. require-corp, as the
// site sends: WebKit takes no credentialless. same-site: on a project
// domain the preview is an origin of its own (v-ID-PORT, site.ts) in the
// IDE's page (p-ID), the same site.
const ISOLATION = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-site',
};
// The site's own frames: the apex's and a project's (frames.ts), and a
// preview origin's relay to its IDE (frames/relay.ts), whose page is this
// worker's host there.
const FRAMES = ['/registry.html', '/storage.html', '/relay.html'];
const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'set-cookie'];

// client id → key (hosts, preview windows, the app's documents), and
// key → the host's client id; and the app's documents (the preview's
// frames), whose requests go to the app.
const keys = new Map<string, string>();
const hosts = new Map<string, string>();
const previews = new Set<string>();
let loading: Promise<void> | null = null;
let loaded = false;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('playground-sw', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('clients');
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
}

function load(): Promise<void> {
  loading ??= database()
    .then(
      (db) =>
        new Promise<void>((resolve) => {
          const request = db.transaction('clients').objectStore('clients').get('routes');
          request.onsuccess = () => {
            for (const [id, key] of request.result?.keys ?? [])
              if (!keys.has(id)) keys.set(id, key);
            for (const [key, id] of request.result?.hosts ?? [])
              if (!hosts.has(key)) hosts.set(key, id);
            for (const id of request.result?.previews ?? []) previews.add(id);
            resolve();
          };
          request.onerror = () => resolve();
        }),
    )
    .catch(() => {})
    .then(() => {
      loaded = true;
    });
  return loading;
}

let saving: Promise<void> | null = null;
// Keep the maps. Clients that are gone go once there are many: a document
// still loading is no client yet, and must keep its key.
function save(): void {
  saving ??= new Promise((resolve) => setTimeout(resolve, 200))
    .then(async () => {
      saving = null;
      if (keys.size > 256) {
        const live = new Set(
          (await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })).map(
            (c) => c.id,
          ),
        );
        for (const id of [...keys.keys()].slice(0, keys.size - 128))
          if (!live.has(id)) keys.delete(id);
      }
      if (previews.size > 256) {
        const live = new Set(
          (await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })).map(
            (c) => c.id,
          ),
        );
        for (const id of [...previews].slice(0, previews.size - 128))
          if (!live.has(id)) previews.delete(id);
      }
      const db = await database();
      db.transaction('clients', 'readwrite')
        .objectStore('clients')
        .put({ keys: [...keys], hosts: [...hosts], previews: [...previews] }, 'routes');
    })
    .catch(() => {});
}

function remember(id: string, key: string | null): void {
  if (!id || !key) return;
  keys.set(id, key);
  save();
}

self.addEventListener('message', (event) => {
  if (event.data === 'claim') {
    event.waitUntil(self.clients.claim());
    return;
  }
  // A preview's WebSocket (bridge.ts): its port goes to its project's page.
  if (event.data?.kind === 'websocket') {
    event.waitUntil(
      load()
        .then(() => host(keys.get(event.source.id)))
        .then((page) => {
          if (page) page.postMessage(event.data, [event.ports[0]]);
          else event.ports[0].postMessage({ close: { code: 1006, reason: '', clean: false } });
        }),
    );
    return;
  }
  const { kind, key } = event.data ?? {};
  if (kind === 'host') {
    hosts.set(key, event.source.id);
    remember(event.source.id, key);
  } else if (kind === 'preview') remember(event.source.id, key);
});

// The key a request belongs to.
async function keyOf(event: FetchEvent): Promise<string | null> {
  await load();
  const known = event.clientId && keys.get(event.clientId);
  if (known) return known;
  const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  // The document that navigated the preview.
  const { referrer } = event.request;
  if (referrer) {
    const from = all.find((client) => client.url === referrer && keys.has(client.id));
    if (from) return keys.get(from.id)!;
  }
  // The only host there is, else the focused one, else the last.
  const live = [...hosts].filter(([, id]) => all.some((client) => client.id === id));
  if (live.length <= 1) return live[0]?.[0] ?? null;
  const focused = live.find(([, id]) => all.find((client) => client.id === id)?.focused);
  return (focused ?? live[live.length - 1])[0];
}

// Only the preview's documents' requests are answered here (they were
// the frames' navigations this worker answered, kept with the routes, as
// a worker is stopped when idle); everything else goes straight to the
// network. Never by asking the client what it is: Firefox answers
// clients.get() for a worker on that worker's thread, which a node's
// worker blocks in a synchronous request for a bundle of its files (that
// comes here) — neither went on for minutes.
// On a project's preview origin (v-ID-PORT.DOMAIN, site.ts), the port
// another of the project's preview origins shows, else null: a request
// there from the preview (another port's page or data, which a fetch to
// that origin would ask the network for) goes to the app's port too.
const PREVIEW = /^v-([a-z0-9]{10})-(\d{1,5})\.(.+)$/;
function sibling(url: URL): number | null {
  const own = self.location.host.match(PREVIEW);
  const other = url.protocol === self.location.protocol ? url.host.match(PREVIEW) : null;
  return own && other && own[1] === other[1] && own[3] === other[3] ? Number(other[2]) : null;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    const port = request.mode === 'navigate' ? null : sibling(url);
    if (port !== null && event.clientId && previews.has(event.clientId))
      event.respondWith(app(event, false, port));
    return;
  }
  if (request.mode === 'navigate') {
    if (request.destination !== 'iframe') return;
    // The site's own frames (frames.ts), never a preview.
    if (FRAMES.includes(new URL(request.url).pathname)) return;
    previews.add(event.resultingClientId);
    save();
    event.respondWith(app(event, true));
  } else if (event.clientId && (!loaded || previews.has(event.clientId))) {
    // Before the routes are read (a worker just started): read them first.
    const id = event.clientId;
    event.respondWith(load().then(() => (previews.has(id) ? app(event, false) : fetch(request))));
  }
});

// The page running the key's project.
async function host(key: string | null | undefined): Promise<Client | null | undefined> {
  const id = key && hosts.get(key);
  return id ? self.clients.get(id) : null;
}

// The app's answer to a request, through its page (bridge.ts); `port`: a
// sibling preview origin's.
async function app(event: FetchEvent, navigation: boolean, port?: number): Promise<Response> {
  const { request } = event;
  const key = await keyOf(event);
  if (navigation) remember(event.resultingClientId, key);
  const page = await host(key);
  if (!page) {
    return new Response('The project is not running.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain', ...ISOLATION },
    });
  }
  const url = new URL(request.url);
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
  const channel = new MessageChannel();
  const reply = new Promise<PreviewResponse>((resolve) => {
    channel.port1.onmessage = (e) => resolve(e.data);
  });
  page.postMessage(
    {
      kind: 'http',
      method: request.method,
      path: url.pathname + url.search,
      headers: [...request.headers],
      body,
      destination: request.destination,
      ...(port === undefined ? {} : { port }),
    },
    [channel.port2],
  );
  const response = await reply;
  const location = response.headers.find(([name]) => name === 'location');
  if (response.status >= 300 && response.status < 400 && location && request.mode !== 'navigate') {
    return Response.redirect(new URL(location[1], url).href, response.status);
  }
  const headers = new Headers(response.headers.filter(([name]) => !HOP.includes(name)));
  for (const [name, value] of Object.entries(ISOLATION)) headers.set(name, value);
  const empty = request.method === 'HEAD' || [101, 204, 205, 304].includes(response.status);
  return new Response(empty ? null : response.body, {
    status: response.status,
    statusText: response.reason,
    headers,
  });
}
