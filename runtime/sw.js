// The playground's service worker: what the preview iframe asks for goes to
// the Phoenix app in the node, through the page that runs it (bridge.js);
// everything else (the playground itself) comes from the network. The app
// sees its own paths, so its absolute links work in the iframe.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// The page running the node, as it announced itself.
let host = null;
self.addEventListener('message', (event) => {
  if (event.data === 'host') host = event.source.id;
});

const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'set-cookie'];

async function forApp(event) {
  const { request } = event;
  if (new URL(request.url).origin !== self.location.origin) return false;
  if (request.mode === 'navigate') return request.destination === 'iframe';
  const client = event.clientId && (await self.clients.get(event.clientId));
  return client?.frameType === 'nested';
}

self.addEventListener('fetch', (event) => {
  event.respondWith((async () => {
    const { request } = event;
    if (!(await forApp(event))) return fetch(request);
    const page = host && (await self.clients.get(host));
    if (!page) return new Response('The playground is not running.', { status: 503 });
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
    // The iframe is in a cross-origin isolated page.
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    const empty = request.method === 'HEAD' || [101, 204, 205, 304].includes(response.status);
    return new Response(empty ? null : response.body, { status: response.status, statusText: response.reason, headers });
  })());
});
