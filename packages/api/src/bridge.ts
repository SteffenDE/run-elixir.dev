// The page's side of bridge mode (docs/frames.md) and of the services
// (every mode): the apex's worker (apexWorker.ts), started once per page,
// and the ports each frame gets to it. The page's main thread only wires
// ports: the worker answers every file and service request, so the page's
// own work (an IDE's UI) neither slows a project's boot nor is slowed by
// it.
import { BRIDGE_PROTOCOL, type BridgeStart } from '@elixir-playground/runtime/swProtocol';
import type { BridgeTable } from './apexWorker';

export type { BridgeTable };

let started: Worker | null = null;
let workerUrl: string | URL | null = null;

// Where the worker's script is, if not beside this module (a bundler that
// does not follow `new URL('./apexWorker.ts', import.meta.url)`).
export function setApexWorkerUrl(url: string | URL | null): void {
  workerUrl = url;
}

function apexWorker(): Worker {
  if (started) return started;
  const worker = workerUrl
    ? new Worker(workerUrl, { type: 'module', name: 'playground-apex' })
    : new Worker(new URL('./apexWorker.ts', import.meta.url), {
        type: 'module',
        name: 'playground-apex',
      });
  // Its script did not load (a bundler that left it out: create()'s
  // usercontent.worker names it).
  worker.addEventListener('error', (event) =>
    console.error(
      `the playground's apex worker failed: ${event.message || 'its script did not load'}`,
    ),
  );
  started = worker;
  return started;
}

// A port to the apex's worker for a frame of `table`: `frame` (a frame's
// control port: it asks for more with `serve`) or `link` (the exec frame's
// worker's own).
export function apexPort(kind: 'frame' | 'link', table: BridgeTable): MessagePort {
  const channel = new MessageChannel();
  apexWorker().postMessage({ kind, table }, [channel.port1]);
  return channel.port2;
}

// Frame `element` on `origin` in bridge mode: its source is the domain's
// bootstrap, which this page answers with `entry` (the frame's page below
// the bridge) and a port to the apex's worker; each page it loads then
// asks for a port of its own (bridgeClient.ts). Returns what stops
// answering it (once the element is gone).
export function bridgeFrame(
  element: HTMLIFrameElement,
  origin: string,
  entry: string,
  table: BridgeTable,
  failed: (message: string) => void = () => {},
): () => void {
  const heard = (event: MessageEvent) => {
    // The frame is gone (a sandbox's shutdown removes it).
    if (!element.isConnected && element.src) return removeEventListener('message', heard);
    if (event.origin !== origin || event.source !== element.contentWindow) return;
    const kind = event.data?.kind;
    if (kind === 'playground-bridge-loaded') {
      if (!event.data.protocols?.includes?.(BRIDGE_PROTOCOL))
        return failed(`${origin} speaks no bridge protocol this page does`);
      const start: BridgeStart = { kind: 'playground-bridge', protocol: BRIDGE_PROTOCOL, entry };
      element.contentWindow!.postMessage(start, origin, [apexPort('frame', table)]);
    } else if (kind === 'playground-bridge-client') {
      element.contentWindow!.postMessage({ kind: 'playground-bridge-control' }, origin, [
        apexPort('frame', table),
      ]);
    } else if (kind === 'playground-bridge-failed') {
      failed(`${origin}: ${String(event.data.message)}`);
    }
  };
  addEventListener('message', heard);
  element.src = `${origin}/bridge.html`;
  return () => removeEventListener('message', heard);
}
