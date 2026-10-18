// The preview's origins on a project domain, one per port of the app
// (site.ts previewOrigin): each has a hidden relay frame in this page
// (frames/relay.ts), its service worker's host there, which passes the
// preview's requests and WebSockets to the bridge with that port. A port's
// preview loads once its relay is ready.
import type { Bridge } from '@/runtime/bridge';
import { previewOrigin } from '@/shared/lib/site';

const relays = new Map<number, Promise<void>>();

const UNAVAILABLE = {
  status: 503,
  reason: 'Service Unavailable',
  headers: [['content-type', 'text/plain']] as [string, string][],
};

// The relay for `port` (made once), ready; at once without a project domain.
export function previewRelay(port: number, bridge: () => Bridge | null): Promise<void> {
  const origin = previewOrigin(port);
  if (!origin) return Promise.resolve();
  let ready = relays.get(port);
  if (!ready) {
    ready = new Promise<void>((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.src = `${origin}/relay.html`;
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
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data, ports }) => {
          if (data?.kind === 'ready') {
            clearTimeout(timer);
            resolve();
            return;
          }
          const to = bridge();
          if (data?.kind === 'http') {
            if (!to) {
              const body = new TextEncoder().encode('The project is not running.');
              ports[0].postMessage({ ...UNAVAILABLE, body }, [body.buffer]);
              return;
            }
            void to
              .request(data)
              .then((response) => ports[0].postMessage(response, [response.body.buffer]));
          } else if (data?.kind === 'websocket') {
            if (to) to.websocket(data, ports[0]);
            else ports[0].postMessage({ close: { code: 1006, reason: '', clean: false } });
          }
        };
        frame.contentWindow!.postMessage({ kind: 'playground-relay' }, origin, [channel.port2]);
      };
      addEventListener('message', loaded);
      document.body.append(frame);
    });
    relays.set(port, ready);
    ready.catch(() => relays.delete(port));
  }
  return ready;
}
