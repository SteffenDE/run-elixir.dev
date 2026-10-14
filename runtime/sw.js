// The playground's service worker: what a preview iframe asks for goes to
// the app in a node, through the page that runs it (bridge.js); everything
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
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// What every answer to the preview carries: it is in a cross-origin
// isolated page, which loads no frame without them. require-corp, as the
// site sends: WebKit takes no credentialless.
const ISOLATION = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'set-cookie'];

// client id → key (hosts, preview windows, the app's documents), and
// key → the host's client id.
const keys = new Map();
const hosts = new Map();
let loading = null;

function database() {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('playground-sw', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('clients');
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
}

function load() {
  loading ??= database()
    .then((db) => new Promise((resolve) => {
      const request = db.transaction('clients').objectStore('clients').get('routes');
      request.onsuccess = () => {
        for (const [id, key] of request.result?.keys ?? []) if (!keys.has(id)) keys.set(id, key);
        for (const [key, id] of request.result?.hosts ?? []) if (!hosts.has(key)) hosts.set(key, id);
        resolve();
      };
      request.onerror = () => resolve();
    }))
    .catch(() => {});
  return loading;
}

let saving = null;
// Keep the maps. Clients that are gone go once there are many: a document
// still loading is no client yet, and must keep its key.
function save() {
  saving ??= new Promise((resolve) => setTimeout(resolve, 200))
    .then(async () => {
      saving = null;
      if (keys.size > 256) {
        const live = new Set((await self.clients.matchAll({ includeUncontrolled: true })).map((c) => c.id));
        for (const id of [...keys.keys()].slice(0, keys.size - 128)) if (!live.has(id)) keys.delete(id);
      }
      const db = await database();
      db.transaction('clients', 'readwrite').objectStore('clients').put({ keys: [...keys], hosts: [...hosts] }, 'routes');
    })
    .catch(() => {});
}

function remember(id, key) {
  if (!id || !key) return;
  keys.set(id, key);
  save();
}

self.addEventListener('message', (event) => {
  if (event.data === 'claim') {
    event.waitUntil(self.clients.claim());
    return;
  }
  // A preview's WebSocket (bridge.js): its port goes to its project's page.
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
async function keyOf(event) {
  await load();
  const known = event.clientId && keys.get(event.clientId);
  if (known) return known;
  const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  // The document that navigated the preview.
  const { referrer } = event.request;
  if (referrer) {
    const from = all.find((client) => client.url === referrer && keys.has(client.id));
    if (from) return keys.get(from.id);
  }
  // The only host there is, else the focused one, else the last.
  const live = [...hosts].filter(([, id]) => all.some((client) => client.id === id));
  if (live.length <= 1) return live[0]?.[0] ?? null;
  const focused = live.find(([, id]) => all.find((client) => client.id === id)?.focused);
  return (focused ?? live[live.length - 1])[0];
}

// Whether each client is a preview's document (a nested frame), as first
// seen. Only those requests are answered here; everything else goes
// straight to the network, without passing through this worker.
const nested = new Map();

async function isApp(id) {
  if (!nested.has(id)) {
    const client = await self.clients.get(id);
    nested.set(id, client?.frameType === 'nested');
  }
  return nested.get(id);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (request.destination !== 'iframe') return;
    nested.set(event.resultingClientId, true);
    event.respondWith(app(event, true));
  } else if (event.clientId && nested.get(event.clientId) !== false) {
    // A client seen for the first time: decided once, here.
    event.respondWith(isApp(event.clientId).then((yes) => (yes ? app(event, false) : fetch(request))));
  }
});

// The page running the key's project.
async function host(key) {
  const id = key && hosts.get(key);
  return id ? self.clients.get(id) : null;
}

// The app's answer to a request, through its page (bridge.js).
async function app(event, navigation) {
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
  const reply = new Promise((resolve) => { channel.port1.onmessage = (e) => resolve(e.data); });
  page.postMessage({ kind: 'http', method: request.method, path: url.pathname + url.search,
    headers: [...request.headers], body }, [channel.port2]);
  const response = await reply;
  const location = response.headers.find(([name]) => name === 'location');
  if (response.status >= 300 && response.status < 400 && location && request.mode !== 'navigate') {
    return Response.redirect(new URL(location[1], url).href, response.status);
  }
  const headers = new Headers(response.headers.filter(([name]) => !HOP.includes(name)));
  for (const [name, value] of Object.entries(ISOLATION)) headers.set(name, value);
  const empty = request.method === 'HEAD' || [101, 204, 205, 304].includes(response.status);
  return new Response(empty ? null : response.body, { status: response.status, statusText: response.reason, headers });
}
