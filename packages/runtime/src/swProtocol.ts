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
// In bridge mode, /bridge.html is the bootstrap, and /_bridge/KEY/ what a
// bridge serves (below).
const PACKAGES = '/npm/@elixir-playground/';
export const isOwnFrame = (pathname: string) =>
  pathname === '/relay.html' ||
  pathname === BRIDGE_PAGE ||
  pathname.startsWith(PACKAGES) ||
  bridgePath(pathname) !== null;

// Bridge mode (docs/frames.md): a shared usercontent domain serves only
// /bridge.html and this worker. The page that frames a usercontent origin
// (the apex) supplies every file over a MessagePort to its worker. The
// bootstrap picks a random key, gives the worker a port to the apex's
// worker under that key (`bridge`), and navigates to the frame's page
// below /_bridge/KEY/. The worker answers what is below /_bridge/KEY/ by
// asking that port (`LinkRequest`, lib/apexLink.ts), and nothing else of
// it: so two bridges in one storage partition (one top-level site's
// pages) never see each other's files. A worker stopped when idle starts
// again without its ports; it asks the bridge's pages (its clients below
// /_bridge/KEY/) for a new one (`bridge-lost`).
export const BRIDGE_PAGE = '/bridge.html';
// Who may bridge (docs/frames.md, "Who may bridge"): only an origin below
// the shared domain that /bridge.json names, which only that domain's
// directory has ({ "bridge": "DOMAIN" }, with a port if any). The apex and
// a usercontent domain that serves the packages have the same sw.js but
// no such file, so no other site's page can bridge them, even if a
// bootstrap is there (a package's root/bridge.html). A file of the
// deployment, not a constant of the build: the runtime package is the
// same for every site, and a shared domain is its operator's choice.
export const BRIDGE_CONFIG = '/bridge.json';
export function belowBridge(host: string, config: unknown): boolean {
  const domain = (config as { bridge?: unknown } | null)?.bridge;
  return (
    typeof domain === 'string' &&
    domain !== '' &&
    host.toLowerCase().endsWith(`.${domain.toLowerCase()}`)
  );
}
export const BRIDGE_PROTOCOLS = [1];
export const BRIDGE_PROTOCOL = 1;
const BRIDGE_PATH = /^\/_bridge\/([A-Za-z0-9_-]{16,64})\/(.*)$/;
// A bridge's key and the path below it, or null.
export function bridgePath(pathname: string): { key: string; rest: string } | null {
  const match = pathname.match(BRIDGE_PATH);
  return match ? { key: match[1], rest: match[2] } : null;
}
export const isBridgeKey = (key: unknown): key is string =>
  typeof key === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(key);

// Bootstrap or bridged page → worker, with a port to the apex's worker: the
// bridge `bridge` is served there. From the bootstrap (/bridge.html), for
// a key the worker does not know yet; from a page below /_bridge/KEY/, for
// its own key (after `bridge-lost`). The worker answers `bridged`.
export interface BridgeAnnounce {
  kind: 'bridge';
  protocol: number;
  bridge: string;
}
// Worker → that page: `protocol: null` refused (another key's page, a key
// taken, a protocol it does not speak).
export interface Bridged {
  kind: 'bridged';
  bridge: string;
  protocol: number | null;
  protocols: number[];
}
// Worker → the bridge's pages, when it has no port for their key (it was
// stopped): one of them sends `bridge` again with a new port.
export interface BridgeLost {
  kind: 'bridge-lost';
  protocol: number;
  bridge: string;
}

// Frame ↔ its parent, the apex (window messages, not the worker's): the
// bootstrap says it loaded; the parent sends the first page's path below
// the bridge and a port to its worker; a bridged page asks for a port of
// its own, to answer `bridge-lost`.
export interface BridgeLoaded {
  kind: 'playground-bridge-loaded';
  protocols: number[];
}
export interface BridgeStart {
  kind: 'playground-bridge';
  protocol: number;
  // The page to load, below /_bridge/KEY/ (npm/@elixir-playground/
  // runtime@VERSION/exec.html).
  entry: string;
}
export interface BridgeClient {
  kind: 'playground-bridge-client';
  protocol: number;
}

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
