// A frame's page below /_bridge/KEY/ (bridge mode, docs/frames.md): the
// origin's service worker asks it for a new port to the apex's worker when
// it was stopped and lost its own (`bridge-lost`). The page gets a port of
// its own to the apex's worker from its parent, the apex, and makes each
// new one over it. Outside bridge mode it does nothing.
import { BRIDGE_PROTOCOL, type BridgeAnnounce, type BridgeClient } from '../swProtocol';
import { bridgeKey } from './apexLink';

export function bridgeClient(): void {
  const key = bridgeKey();
  if (!key || typeof window === 'undefined' || window.top === window) return;
  let control: MessagePort | null = null;
  addEventListener('message', (event) => {
    if (event.source !== window.parent || control) return;
    if (event.data?.kind !== 'playground-bridge-control' || !event.ports[0]) return;
    control = event.ports[0];
  });
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.kind !== 'bridge-lost' || data.bridge !== key || !control) return;
    const channel = new MessageChannel();
    control.postMessage({ kind: 'serve' }, [channel.port1]);
    (event.source as ServiceWorker | null)?.postMessage(
      { kind: 'bridge', protocol: BRIDGE_PROTOCOL, bridge: key } satisfies BridgeAnnounce,
      [channel.port2],
    );
  });
  navigator.serviceWorker.startMessages();
  // Nothing in it but what it asks for: any parent may hear it (only its
  // own parent's answer is taken).
  window.parent.postMessage(
    { kind: 'playground-bridge-client', protocol: BRIDGE_PROTOCOL } satisfies BridgeClient,
    '*',
  );
}
