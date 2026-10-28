// The preview origin's service worker protocol (docs/packages.md): what
// sw.js, its host page (relay.html, bridge.ts) and the preview's documents
// (the WebSocket the bridge puts in them) say to each other. One
// root-scoped sw.js serves every version of the host on an origin, so its
// protocol is numbered: a host announces the protocol it speaks, and the
// worker answers in it. Within a protocol, changes are additive only; a
// new sw.js keeps speaking every protocol in its support window.

// What this sw.js speaks, and what a host built with it speaks.
export const SW_PROTOCOLS = [1];
export const HOST_PROTOCOL = 1;

// Host → worker, on registration and on each controllerchange.
export interface HostAnnounce {
  kind: 'host';
  protocol: number;
}

// The protocol a host or a document names; 0 (none the worker speaks)
// when it names none.
export function announcedProtocol(message: { protocol?: unknown }): number {
  const { protocol } = message;
  return typeof protocol === 'number' && Number.isInteger(protocol) && protocol > 0 ? protocol : 0;
}

// The protocol the worker answers a host in: the one it asked for, or
// none (the worker is older or newer than its support window).
export function negotiate(
  asked: number,
  supported: readonly number[] = SW_PROTOCOLS,
): number | null {
  return supported.includes(asked) ? asked : null;
}

// Worker → host: the answer to an announce. `protocol: null`: refused;
// the host asks for the newest sw.js (registration.update()) and
// announces again when it takes over.
export interface Hosted {
  kind: 'hosted';
  protocol: number | null;
  protocols: number[];
}

export function hosted(asked: number, supported = SW_PROTOCOLS): Hosted {
  return { kind: 'hosted', protocol: negotiate(asked, supported), protocols: [...supported] };
}

// Document → worker → host, with a MessagePort: a preview document's
// WebSocket (bridge.ts webSocketShim), which the worker passes on as it
// is. `subprotocols`: those the page asked the server for.
export interface WebSocketRequest {
  kind: 'websocket';
  protocol: number;
  path: string;
  subprotocols: string[];
}

// Worker → host, with a reply port: a preview document's request. `port`:
// another of the project's preview origins' (a sibling's), whose port the
// request is for. The reply is bridge.ts's PreviewResponse.
export interface HttpRequest {
  kind: 'http';
  method: string;
  path: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
  destination: string;
  port?: number;
}

// The site's own pages on a preview origin, which the worker never answers
// for the app: the packages' (/npm/@elixir-playground/NAME@VERSION/…:
// the runtime's relay.html), immutable, under a prefix no app's route is
// likely to have. /relay.html is the upgrade bootstrap, also exempted by
// the unnumbered worker so it can update that worker before loading a package.
const PACKAGES = '/npm/@elixir-playground/';
export const isOwnFrame = (pathname: string) =>
  pathname === '/relay.html' || pathname.startsWith(PACKAGES);

// The worker's routes, kept in IndexedDB (playground-sw, store
// `clients`) under ROUTES, as a worker is stopped when idle and starts
// again without its memory. Fields are only added; a record of another
// key is another protocol's, and none of this worker's.
export const ROUTES = 'routes-1';
export interface Routes {
  // The host's client id and the protocol it speaks.
  host: string | null;
  protocol: number;
  // The documents the worker answered (the preview's frames).
  previews: string[];
}
