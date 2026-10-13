// The playground's service worker: what the preview iframe asks for goes to
// the Phoenix app in the node, through the page that runs it (bridge.js);
// everything else (the playground itself) comes from the network. The app
// sees its own paths, so its absolute links work in the iframe.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// The page running the node, as it announced itself. A service worker is
// stopped when idle and starts again without it; then the playground is
// the top-level window among this worker's clients.
let host = null;

async function playground() {
  const known = host && (await self.clients.get(host));
  if (known) return known;
  const windows = await self.clients.matchAll({ type: 'window' });
  const page = windows.reverse().find((client) => client.frameType === 'top-level');
  host = page?.id ?? null;
  return page ?? null;
}

// What every answer to the preview carries: it is in a cross-origin
// isolated page, which loads no frame without them.
const ISOLATION = {
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
self.addEventListener('message', (event) => {
  if (event.data === 'host') host = event.source.id;
});

const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'set-cookie'];

// Whether each client (the preview iframe and its pages, the playground,
// its worker) is the app's, as first seen. Only the app's requests are
// answered here; everything else goes straight to the network, without
// passing through this worker.
const clients = new Map();

async function isApp(id) {
  if (!clients.has(id)) {
    const client = await self.clients.get(id);
    clients.set(id, client?.frameType === 'nested');
  }
  return clients.get(id);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (request.destination !== 'iframe') return;
    clients.set(event.resultingClientId, true);
    event.respondWith(app(event));
  } else if (event.clientId && clients.get(event.clientId) !== false) {
    // A client seen for the first time: decided once, here.
    event.respondWith(isApp(event.clientId).then((yes) => (yes ? app(event) : fetch(request))));
  }
});

// The app's answer to a request, through the page (bridge.js).
async function app(event) {
  const { request } = event;
  const page = await playground();
  if (!page) {
    return new Response('The playground is not running.', {
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
