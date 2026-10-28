// A preview relay's requests and WebSockets (frames/relay.ts), on the port
// it was handed, answered by a bridge: the exec frame's worker's
// (exec/host.ts), or a live session's guest's page's, which tunnels them
// to the host's app (live/lib/guest.ts).
import type { Bridge, PreviewResponse } from './bridge';

export function serveRelayRequests(port: MessagePort, bridge: () => Bridge | null): void {
  const encoder = new TextEncoder();
  port.onmessage = ({ data, ports }) => {
    const to = bridge();
    if (data?.kind === 'http') {
      if (!to) {
        const body = encoder.encode('The project is not running.');
        ports[0].postMessage(
          {
            status: 503,
            reason: 'Service Unavailable',
            headers: [['content-type', 'text/plain']],
            body,
          } satisfies PreviewResponse,
          [body.buffer],
        );
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
}
