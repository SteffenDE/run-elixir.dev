// The preview origin's service worker (v-ID-PORT.USERCONTENT, site.ts): what
// a preview iframe asks for goes to the app in a node, through the page that
// hosts this origin (the relay, frames/relay.ts, and bridge.ts); everything
// else comes from the network. The app sees its own paths, so its absolute
// links work in the iframe.
//
// One sw.js serves every version of the host on its origin (a Phoenix app
// owns /, so it is root-scoped), so it is a router, and its protocol is
// numbered (swProtocol.ts, docs/packages.md): a host announces
// { kind: 'host', protocol }, and the worker answers { kind: 'hosted',
// protocol } (null: not one it speaks) and speaks it. The origin has one
// host, the last to announce itself; the worker keeps it, and the
// documents it answered, in IndexedDB, since a service worker is stopped
// when idle and starts again without its memory.
import type { PreviewResponse } from './bridge';
import {
  ROUTES,
  announcedProtocol,
  hosted,
  isOwnFrame,
  type HttpRequest,
  type Routes,
} from './swProtocol';

// What this worker uses of its scope, which the app's DOM library leaves
// out.
interface Client {
  id: string;
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
// site sends: WebKit takes no credentialless. cross-origin: the preview is
// an origin of the usercontent domain (v-ID-PORT, site.ts) in the apex's
// page, another site.
const ISOLATION = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};
// What a constructed Response may not carry as the app sent it.
const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'set-cookie'];

const routes: Routes = { host: null, protocol: 0, previews: [] };
// How long a preview's request waits for a host before the 503.
const HOST_WAIT = 3000;
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
          const request = db.transaction('clients').objectStore('clients').get(ROUTES);
          request.onsuccess = () => {
            const kept = request.result as Partial<Routes> | undefined;
            if (routes.host === null && kept?.host) {
              routes.host = kept.host;
              routes.protocol = kept.protocol ?? 0;
            }
            for (const id of kept?.previews ?? []) previews.add(id);
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

// Write the routes now, done once the transaction is.
async function write(): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve) => {
    const transaction = db.transaction('clients', 'readwrite');
    transaction
      .objectStore('clients')
      .put({ ...routes, previews: [...previews] } satisfies Routes, ROUTES);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

let saving: Promise<void> | null = null;
// Keep the routes, a moment later (the preview's documents come in
// bursts). Documents that are gone go once there are many: one still
// loading is no client yet, and must stay. A new host is written at once
// instead (the message's waitUntil): a worker stopped before the moment
// would start again without it, and answer its previews 503.
function save(): void {
  saving ??= new Promise((resolve) => setTimeout(resolve, 200))
    .then(async () => {
      saving = null;
      if (previews.size > 256) {
        const live = new Set(
          (await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })).map(
            (c) => c.id,
          ),
        );
        for (const id of [...previews].slice(0, previews.size - 128))
          if (!live.has(id)) previews.delete(id);
      }
      await write();
    })
    .catch(() => {});
}

// What waits for a host (app()): resolved when one announces itself.
const announced: (() => void)[] = [];
function nextHost(timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    announced.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

self.addEventListener('message', (event) => {
  if (event.data === 'claim') {
    event.waitUntil(self.clients.claim());
    return;
  }
  const kind = event.data?.kind;
  // A preview's WebSocket (bridge.ts): its port goes to the host as it is.
  if (kind === 'websocket') {
    event.waitUntil(
      host().then((page) => {
        if (page && announcedProtocol(event.data) === routes.protocol)
          page.postMessage(event.data, [event.ports[0]]);
        else event.ports[0].postMessage({ close: { code: 1006, reason: '', clean: false } });
      }),
    );
  } else if (kind === 'host') {
    const answer = hosted(announcedProtocol(event.data));
    event.source.postMessage(answer);
    if (answer.protocol === null) return;
    routes.host = event.source.id;
    routes.protocol = answer.protocol;
    for (const resolve of announced.splice(0)) resolve();
    event.waitUntil(write().catch(() => {}));
  }
});

// On a project's preview origin (v-ID-PORT.USERCONTENT, site.ts), the port
// another of the project's preview origins shows, else null: a request
// there from the preview (another port's page or data, which a fetch to
// that origin would ask the network for) goes to the app's port too.
const PREVIEW = /^v-([a-z0-9]{10})-(\d{1,5})\.(.+)$/;
function sibling(url: URL): number | null {
  const own = self.location.host.match(PREVIEW);
  const other = url.protocol === self.location.protocol ? url.host.match(PREVIEW) : null;
  return own && other && own[1] === other[1] && own[3] === other[3] ? Number(other[2]) : null;
}

// Only the preview's documents' requests are answered here (the frames'
// navigations this worker answered, kept with the routes); everything
// else goes straight to the network. Never by asking the client what it
// is: Firefox answers clients.get() for a worker on that worker's thread,
// which a node's worker blocks in a synchronous request for a bundle of
// its files (that comes here) — neither went on for minutes.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    const port = request.mode === 'navigate' ? null : sibling(url);
    if (port !== null && event.clientId && previews.has(event.clientId))
      event.respondWith(app(event, port));
    return;
  }
  if (request.mode === 'navigate') {
    // The site's own pages (the relay), never a preview.
    if (request.destination !== 'iframe' || isOwnFrame(url.pathname)) return;
    previews.add(event.resultingClientId);
    save();
    event.respondWith(app(event));
  } else if (event.clientId && (!loaded || previews.has(event.clientId))) {
    // Before the routes are read (a worker just started): read them first.
    const id = event.clientId;
    event.respondWith(load().then(() => (previews.has(id) ? app(event) : fetch(request))));
  }
});

// The page that hosts this origin.
async function host(): Promise<Client | null> {
  await load();
  return routes.host ? ((await self.clients.get(routes.host)) ?? null) : null;
}

// The app's answer to a request, through the host (bridge.ts), in
// protocol 1; `port`: a sibling preview origin's.
async function app(event: FetchEvent, port?: number): Promise<Response> {
  const { request } = event;
  let page = await host();
  // A host may be announcing itself now: its message and this request
  // come to the worker in either order.
  if (!page) {
    await nextHost(HOST_WAIT);
    page = await host();
  }
  // No host: the project stopped, or the page that hosts it is older than
  // this worker (an unnumbered announce, refused), which a reload fixes.
  if (!page) {
    return new Response(
      'The project is not running. If the playground was updated since you opened this page, reload it.',
      {
        status: 503,
        headers: { 'Content-Type': 'text/plain', ...ISOLATION },
      },
    );
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
    } satisfies HttpRequest,
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
