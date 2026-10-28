// The preview's origins on the usercontent domain, one per port of the app
// (site.ts previewOrigin): each has a hidden relay frame in this page
// (frames/relay.ts), its service worker's host there, which passes the
// preview's requests and WebSockets on a port to the worker that runs the
// project (`serve`: exec.ts hands it there), whose bridge answers them from
// that port of the app. A port's preview loads once its relay is ready.
import { previewOrigin } from '@/shared/lib/site';
import { runtimePath } from '@/shared/lib/build';

const relays = new Map<number, Promise<void>>();

// The relay for project `key`'s `port` (made once), ready.
export function previewRelay(
  key: string,
  port: number,
  serve: (requests: MessagePort) => void,
): Promise<void> {
  const origin = previewOrigin(key, port);
  if (!origin) return Promise.resolve();
  let ready = relays.get(port);
  if (!ready) {
    ready = new Promise<void>((resolve, reject) => {
      const frame = document.createElement('iframe');
      // The previous worker exempts /relay.html, but would route a new
      // package URL into the app. The bootstrap updates it before moving
      // to this build's immutable relay.
      frame.src = `${origin}/relay.html?runtime=${encodeURIComponent(runtimePath())}`;
      frame.hidden = true;
      frame.setAttribute('aria-hidden', 'true');
      const timer = setTimeout(
        () => reject(new Error(`${origin}: the relay did not start`)),
        30000,
      );
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
    relays.set(port, ready);
    ready.catch(() => relays.delete(port));
  }
  return ready;
}

// The project's page goes: its relays with it.
export function forgetRelays(): void {
  relays.clear();
}
