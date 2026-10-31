// A package's shared frame (docs/packages.md, `frames`), on its side: the
// page the api frames once per page on an origin of its own
// (packages/api/src/sharedFrame.ts) takes a port from it for each run of
// the package's page program. What the frame and the program say over
// the port is theirs (the claude package's: its protocol.ts).
import { bridgeClient } from './bridgeClient';

// Frame → parent: it loaded (nothing else in it). Parent → frame: a port.
export const FRAME_LOADED = 'playground-frame-loaded';
export const FRAME_PORT = 'playground-frame';

// The frame's page: its files from its parent (bridge mode), and `take`
// for each port its parent gives. Its parent is the page that framed it
// and gave it its code, so it takes ports from that parent alone.
export function serveFrame(take: (port: MessagePort) => void): void {
  bridgeClient();
  addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    if (event.data?.kind !== FRAME_PORT || !event.ports[0]) return;
    take(event.ports[0]);
  });
  window.parent.postMessage({ kind: FRAME_LOADED }, '*');
}
