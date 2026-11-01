// A package's shared frame (docs/packages.md, `frames`), on its side: the
// page the api frames once per page on an origin of its own
// (packages/api/src/sharedFrame.ts) takes a port from it for each run of
// the package's page program. What the frame and the program say over
// the port is theirs (the claude package's: its protocol.ts).
import { bridgeClient } from './bridgeClient';

// Frame → parent: it loaded (nothing else in it). Parent → frame: a port,
// with `packages`: its package's peer dependencies' paths below the
// bridge (npm/NAME@VERSION/), those the site has.
export const FRAME_LOADED = 'playground-frame-loaded';
export const FRAME_PORT = 'playground-frame';

// What a frame knows beside each port: where its package's peers' files
// are, below its own bridge (the claude frame's esbuild), or null for a
// package that is no peer of its own or that the site lacks.
export interface FrameContext {
  packageUrl(name: string): URL | null;
}

// Where a path below the bridge is, from a page below it.
export function belowOwnBridge(path: string, page: string = location.href): URL | null {
  const at = new URL(page);
  const bridge = at.pathname.match(/^\/_bridge\/[^/]+\//);
  return bridge ? new URL(path, `${at.origin}${bridge[0]}`) : null;
}

// The frame's page: its files from its parent (bridge mode), and `take`
// for each port its parent gives. Its parent is the page that framed it
// and gave it its code, so it takes ports from that parent alone.
export function serveFrame(take: (port: MessagePort, frame: FrameContext) => void): void {
  bridgeClient();
  addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    if (event.data?.kind !== FRAME_PORT || !event.ports[0]) return;
    const packages: Record<string, string> = event.data.packages ?? {};
    take(event.ports[0], {
      packageUrl: (name) => (Object.hasOwn(packages, name) ? belowOwnBridge(packages[name]) : null),
    });
  });
  window.parent.postMessage({ kind: FRAME_LOADED }, '*');
}
