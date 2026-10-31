// The service worker's bridge (bridge mode, docs/frames.md and
// docs/packages.md): what is below /_bridge/KEY/ on a usercontent origin
// comes from the apex that framed it, over a port to the apex's worker.
// The worker stores none of it (no Cache Storage, no IndexedDB): each
// project is an origin of its own, and a copy per project would be a copy
// per project. The apex's own HTTP cache keeps the files once.
//
// Kept apart from sw.ts, its dependencies given, for its tests.
import type { LinkRequest, LinkResponse } from './lib/apexLink';
import {
  BRIDGE_CONFIG,
  BRIDGE_PAGE,
  belowBridge,
  BRIDGE_PROTOCOLS,
  announcedProtocol,
  bridgePath,
  isBridgeKey,
  type BridgeLost,
  type Bridged,
} from './swProtocol';

export interface BridgeClient {
  url: string;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface BridgeOptions {
  // The worker's window clients, the uncontrolled too (clients.matchAll).
  clients(): Promise<BridgeClient[]>;
  // The worker's origin.
  origin: string;
  // Whether this origin may take a new bridge: it is below the shared
  // domain its /bridge.json names (by default, fetched; swProtocol.ts).
  bridgeable?: () => Promise<boolean>;
  // How long a request waits for a port after `bridge-lost`, and for the
  // apex's answer.
  reconnect?: number;
  answer?: number;
}

// What every answer carries: the frames are cross-origin isolated
// documents of another site than the apex's page that frames them.
export const ISOLATION = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};
// What a constructed Response may not carry as the apex's server sent it,
// and what the apex's server's caching says about its own copy.
const DROPPED = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'set-cookie',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'age',
  'vary',
  'content-security-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'cross-origin-opener-policy',
  'access-control-allow-origin',
];

// A Node.js process's worker (the nodejs package's nodejs.js) and the
// chunks it imports, below a bridge: their policy (docs/nodejs.md, "The
// worker's policy"), as serve.py and Caddy send it on a usercontent domain
// that serves the packages.
const NODE_SCRIPT = /^(npm\/@elixir-playground\/nodejs@[^/]+)\/(?:nodejs\.js|chunks\/[^/]+\.js)$/;
// Firefox (157, Playwright 1.64; 2026-10-29) checks what this worker
// answered (the Node.js worker's own script, its dynamic imports, the
// files it fetches) against worker-src, script-src and connect-src by this
// worker's script's URL (/sw.js), not the request's: /sw.js is listed in
// each. It is public, and outside a service worker's scope it only adds
// listeners that never fire.
// `nodejs`: the nodejs package's path below the bridge.
// `direct`: where the page serves the packages' files, which the exec
// frame's workers read there.
export function nodePolicy(
  origin: string,
  key: string,
  nodejs: string,
  direct: string[] = [],
): string {
  const base = `${origin}/_bridge/${key}/`;
  const scripts = `${base}${nodejs}/nodejs.js ${base}${nodejs}/chunks/`;
  return (
    `default-src 'none'; script-src ${scripts} ${origin}/sw.js 'unsafe-eval' 'wasm-unsafe-eval'; ` +
    `worker-src ${scripts} ${origin}/sw.js blob:; ` +
    `connect-src ${[`${base}npm/@elixir-playground/`, `${origin}/sw.js`, ...direct].join(' ')} data: blob:`
  );
}

// The bridged documents' own policy: no downloads, no top-level
// navigation, no plugins; scripts, workers, forms and popups as the
// runtime's pages need them.
export const DOCUMENT_POLICY =
  'sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups';

const failed = (status: number, text: string) =>
  new Response(text, { status, headers: { 'Content-Type': 'text/plain', ...ISOLATION } });

// Whether `origin` is below the shared domain its /bridge.json names. A
// yes is kept for the worker's life; a no is asked again next time.
export function bridgeConfig(origin: string): () => Promise<boolean> {
  let known: Promise<boolean> | null = null;
  return () => {
    known ??= fetch(new URL(BRIDGE_CONFIG, origin), { cache: 'no-cache' })
      .then((response) => (response.ok ? response.json() : null))
      .then((config) => belowBridge(new URL(origin).host, config))
      .catch(() => false);
    const asked = known;
    void asked.then((ok) => {
      if (!ok && known === asked) known = null;
    });
    return asked;
  };
}

export function bridgeRouter({
  clients,
  origin,
  bridgeable = bridgeConfig(origin),
  reconnect = 5000,
  answer = 120_000,
}: BridgeOptions) {
  const ports = new Map<string, MessagePort>();
  const waiting = new Map<string, (() => void)[]>();

  // A page's port for its key: the bootstrap's for a new key (only on a
  // shared domain's origin: `bridgeable`), a bridged page's for its own.
  // True when taken.
  async function accept(
    data: unknown,
    source: BridgeClient,
    given: readonly MessagePort[],
  ): Promise<boolean> {
    const message = data as { bridge?: unknown; protocol?: unknown };
    const key = message.bridge;
    const protocol = announcedProtocol(message);
    const port = given[0];
    let path = '';
    try {
      path = new URL(source.url).pathname;
    } catch {}
    const own = isBridgeKey(key) && bridgePath(path)?.key === key;
    const fresh =
      isBridgeKey(key) && path === BRIDGE_PAGE && !ports.has(key) && (await bridgeable());
    const ok =
      BRIDGE_PROTOCOLS.includes(protocol) &&
      port !== undefined &&
      (own || (fresh && !ports.has(key)));
    source.postMessage({
      kind: 'bridged',
      bridge: isBridgeKey(key) ? key : '',
      protocol: ok ? protocol : null,
      protocols: [...BRIDGE_PROTOCOLS],
    } satisfies Bridged);
    if (!ok) {
      port?.close();
      return false;
    }
    ports.get(key)?.close();
    ports.set(key, port);
    for (const resolve of waiting.get(key)?.splice(0) ?? []) resolve();
    return true;
  }

  // The port for `key`, asking the bridge's pages for one if the worker
  // has none (it was stopped since).
  async function portFor(key: string): Promise<MessagePort | null> {
    const known = ports.get(key);
    if (known) return known;
    const arrived = new Promise<void>((resolve) => {
      const list = waiting.get(key) ?? [];
      list.push(resolve);
      waiting.set(key, list);
      setTimeout(resolve, reconnect);
    });
    for (const client of await clients()) {
      let path = '';
      try {
        path = new URL(client.url).pathname;
      } catch {}
      if (bridgePath(path)?.key === key)
        client.postMessage({
          kind: 'bridge-lost',
          protocol: BRIDGE_PROTOCOLS[BRIDGE_PROTOCOLS.length - 1],
          bridge: key,
        } satisfies BridgeLost);
    }
    await arrived;
    return ports.get(key) ?? null;
  }

  function ask(port: MessagePort, request: LinkRequest): Promise<LinkResponse | null> {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        resolve(null);
      }, answer);
      channel.port1.onmessage = ({ data }) => {
        clearTimeout(timer);
        channel.port1.close();
        resolve(data as LinkResponse);
      };
      port.postMessage(request, [channel.port2, ...(request.body ? [request.body] : [])]);
    });
  }

  // The answer to a request below /_bridge/KEY/, or null for any other.
  function handles(url: URL): boolean {
    return url.origin === origin && bridgePath(url.pathname) !== null;
  }

  async function respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const bridged = bridgePath(url.pathname);
    if (!bridged || url.origin !== origin) return failed(404, 'Not a bridge’s file.');
    const { key, rest } = bridged;
    // The services are the exec frame's link's alone (lib/apexLink.ts).
    if (rest.startsWith('_services/')) return failed(404, 'Not here.');
    const port = await portFor(key);
    if (!port)
      return failed(503, 'The page that ran this frame is gone. Reload the page that shows it.');
    const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
    const answered = await ask(port, {
      kind: 'get',
      path: rest + url.search,
      method: request.method,
      headers: [...request.headers],
      body,
    });
    if (!answered) {
      // The apex's worker is gone: the next request asks again.
      if (ports.get(key) === port) ports.delete(key);
      return failed(504, 'The page that ran this frame did not answer.');
    }
    const headers = new Headers(
      (answered.headers ?? []).filter(([name]) => !DROPPED.includes(name.toLowerCase())),
    );
    // Never a download: the shared domain hosts none (docs/frames.md).
    if (/^\s*attachment/i.test(headers.get('content-disposition') ?? ''))
      return failed(403, 'The shared usercontent domain serves no downloads.');
    headers.delete('content-disposition');
    for (const [name, value] of Object.entries(ISOLATION)) headers.set(name, value);
    // The apex's hint: where it serves the packages' files, which the
    // frame's workers read there. Plain http(s) URLs only, nothing a policy
    // could read as another directive.
    const direct = (headers.get('x-playground-connect') ?? '')
      .split(' ')
      .filter((each) => /^https?:\/\/[^\s;,'"]+$/.test(each));
    headers.delete('x-playground-connect');
    const node = rest.match(NODE_SCRIPT);
    if (node) headers.set('Content-Security-Policy', nodePolicy(origin, key, node[1], direct));
    else if (request.mode === 'navigate') headers.set('Content-Security-Policy', DOCUMENT_POLICY);
    headers.set('Cache-Control', 'no-store');
    const status = answered.status || 502;
    const empty =
      request.method === 'HEAD' || [101, 204, 205, 304].includes(status) || status < 200;
    return new Response(empty ? null : answered.body, { status, headers });
  }

  return { accept, respond, handles, ports };
}
