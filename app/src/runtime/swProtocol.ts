// The preview origin's service worker protocol (docs/packages.md): what
// sw.js and its host page (relay.html, bridge.ts) say to each other. One
// root-scoped sw.js serves every version of the host on an origin, so its
// protocol is numbered: a host announces the protocol it speaks, and the
// worker answers in it. Within a protocol, changes are additive only; a
// new sw.js keeps speaking every protocol in its support window.

// What this sw.js speaks, and what a host built with it speaks.
export const SW_PROTOCOLS = [1];
export const HOST_PROTOCOL = 1;

// A host's announce: { kind: 'host', key, protocol? }. Without `protocol`,
// a host from before it was numbered: protocol 1.
export interface HostAnnounce {
  kind: 'host';
  key: string;
  protocol?: number;
}

export function announcedProtocol(announce: { protocol?: unknown }): number {
  const { protocol } = announce;
  return typeof protocol === 'number' && Number.isInteger(protocol) && protocol > 0 ? protocol : 1;
}

// The protocol the worker answers a host in: the one it asked for, or
// none (the worker is older or newer than its support window).
export function negotiate(
  asked: number,
  supported: readonly number[] = SW_PROTOCOLS,
): number | null {
  return supported.includes(asked) ? asked : null;
}

// The worker's answer to an announce. A host without an answer is
// talking to a worker from before the protocol was numbered: protocol 1.
// `protocol: null`: refused; the host asks for the newest sw.js
// (registration.update()) and announces again when it takes over.
export interface Hosted {
  kind: 'hosted';
  key: string;
  protocol: number | null;
  protocols: number[];
}

export function hosted(key: string, asked: number, supported = SW_PROTOCOLS): Hosted {
  return { kind: 'hosted', key, protocol: negotiate(asked, supported), protocols: [...supported] };
}

// The site's own pages on a preview origin, which the worker never answers
// for the app: today's relay at the root, and every page under the
// packages' immutable paths (/npm/@elixir-playground/NAME@VERSION/…),
// where a versioned relay.html will be.
const FRAMES = ['/relay.html', '/exec.html'];
const PACKAGES = '/npm/@elixir-playground/';
export const isOwnFrame = (pathname: string) =>
  FRAMES.includes(pathname) || pathname.startsWith(PACKAGES);
