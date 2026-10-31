// The preview's origins on the usercontent domain, one per port of the app
// (site.ts previewOrigin): each has a hidden relay frame in this page
// (frames/relay.ts), its service worker's host there, which passes the
// preview's requests and WebSockets on a port to the worker that runs the
// project (`serve`: exec.ts hands it there), whose bridge answers them from
// that port of the app. A port's preview loads once its relay is ready.
import { previewOrigin } from '@elixir-playground/runtime/lib/site';
import { bridgeFrame } from './bridge';
import { frameTable, type Bridge } from './usercontent';

// Where a sandbox's relays are (sandbox.ts): its shared usercontent
// domain, and its bridge, which answers their frames.
export interface RelayMode {
  usercontent: string;
  bridge: Bridge;
}

// Where a project's previews are: its origins' key (v-KEY-PORT) and its
// relays' mode. The IDE's page holds it from create()'s `connected`; a
// live session's guest makes its own (sandbox.ts previewPlace).
export interface PreviewPlace {
  key: string;
  mode: RelayMode;
}

interface Relay {
  ready: Promise<void>;
  frame: HTMLIFrameElement;
  unbridge: () => void;
}
// By origin: a project's key and a port.
const relays = new Map<string, Relay>();

// The relay for project `key`'s `port` (`key`: its origins' key; made
// once), ready.
export function previewRelay(
  key: string,
  port: number,
  serve: (requests: MessagePort) => void,
  { usercontent, bridge }: RelayMode,
): Promise<void> {
  const origin = previewOrigin(key, port, usercontent);
  if (!origin) return Promise.resolve();
  const known = relays.get(origin);
  if (known) return known.ready;
  const frame = document.createElement('iframe');
  const relay: Relay = { ready: Promise.resolve(), frame, unbridge: () => {} };
  relay.ready = new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      removeEventListener('message', loaded);
      clearTimeout(timer);
      forget(origin, relay);
      reject(error);
    };
    // The domain's bootstrap, then the runtime's relay below the bridge
    // (bridge.ts).
    relay.unbridge = bridgeFrame(
      frame,
      origin,
      `${bridge.runtime}relay.html`,
      frameTable(bridge.table),
      (message) => failed(new Error(message)),
    );
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    const timer = setTimeout(() => failed(new Error(`${origin}: the relay did not start`)), 30000);
    const loaded = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.contentWindow) return;
      if (event.data?.kind !== 'playground-relay-loaded') return;
      removeEventListener('message', loaded);
      const control = new MessageChannel();
      const requests = new MessageChannel();
      control.port1.onmessage = ({ data }) => {
        if (data?.kind !== 'ready') return;
        clearTimeout(timer);
        resolve();
      };
      serve(requests.port1);
      frame.contentWindow!.postMessage({ kind: 'playground-relay' }, origin, [
        control.port2,
        requests.port2,
      ]);
    };
    addEventListener('message', loaded);
    document.body.append(frame);
  });
  relays.set(origin, relay);
  return relay.ready;
}

// A relay goes: its frame, and in bridge mode what answers it.
function forget(origin: string, relay: Relay): void {
  relay.unbridge();
  relay.frame.remove();
  if (relays.get(origin) === relay) relays.delete(origin);
}

// The project's page goes: its relays with it (`origins`: a sandbox's;
// none: every one).
export function forgetRelays(origins?: Iterable<string>): void {
  for (const origin of origins ? [...origins] : [...relays.keys()]) {
    const relay = relays.get(origin);
    if (relay) forget(origin, relay);
  }
}
