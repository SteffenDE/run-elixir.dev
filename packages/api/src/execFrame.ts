// The frame that runs a project (e-KEY on the usercontent domain,
// frames/exec.ts), started by create() (api/sandbox.ts) on the page that
// drives it: the IDE's, or another site's.
import { Rpc } from '@elixir-playground/runtime/lib/rpc';
import { bridgeFrame, type BridgeTable } from './bridge';
import type { BridgeTrace } from './types';

// A frame on the screen but unseen: a pixel, transparent, out of the way.
// Not `hidden`: WebKit slowed a hidden frame's workers (the nodes') until
// a node waiting on a program's exit never heard of it (docs/frames.md).
// Styled here, not by the page's stylesheet: another site's page has none
// of ours.
export function unseen(element: HTMLIFrameElement): HTMLIFrameElement {
  element.className = 'exec-frame';
  Object.assign(element.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '1px',
    height: '1px',
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  });
  element.setAttribute('aria-hidden', 'true');
  element.tabIndex = -1;
  // Its own SharedArrayBuffers and threads (Chromium asks for this).
  element.allow = 'cross-origin-isolated';
  return element;
}

// The exec frame at `origin`, its worker's port once it started, the
// frame put in `container`. After the page's load: a frame of another
// site would hold its load event up (Firefox) until it started. `framed`
// hears the element as it goes in (the page removes it at its shutdown).
// `bridge` (bridge.ts): the frame's page below the bridge, what the frame
// may ask this page's worker for, and who hears how its bootstrap chose
// its service worker.
export async function startExecFrame(
  origin: string,
  signal: AbortSignal,
  container: HTMLElement,
  framed: (element: HTMLIFrameElement) => void,
  bridge: { entry: string; table: BridgeTable; traced?: (trace: BridgeTrace) => void },
): Promise<Rpc> {
  if (document.readyState !== 'complete')
    await new Promise<void>((resolve, reject) => {
      const loaded = () => {
        signal.removeEventListener('abort', cancelled);
        resolve();
      };
      const cancelled = () => {
        removeEventListener('load', loaded);
        reject(signal.reason);
      };
      signal.addEventListener('abort', cancelled, { once: true });
      addEventListener('load', loaded, { once: true });
    });
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const element = unseen(document.createElement('iframe'));
    let unbridge = () => {};
    const cleanup = () => {
      removeEventListener('message', loaded);
      signal.removeEventListener('abort', cancelled);
      clearTimeout(timer);
    };
    const fail = (error: Error) => {
      cleanup();
      unbridge();
      element.remove();
      reject(error);
    };
    const cancelled = () => fail(signal.reason);
    const timer = setTimeout(() => fail(new Error(`${origin}: the project did not start`)), 30000);
    let channel: MessageChannel | null = null;
    // It loads, takes the port (started) or says it does not run
    // projects for this page (refused: its site names the pages it does).
    const loaded = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== element.contentWindow) return;
      const kind = event.data?.kind;
      if (kind === 'playground-exec-loaded' && !channel) {
        if (!event.data.isolated) {
          fail(new Error(`${origin} is not cross-origin isolated (see docs/frames.md).`));
          return;
        }
        channel = new MessageChannel();
        element.contentWindow!.postMessage({ kind: 'playground-exec' }, origin, [channel.port2]);
      } else if (kind === 'playground-exec-started' && channel) {
        cleanup();
        resolve(new Rpc(channel.port1));
      } else if (kind === 'playground-exec-refused') {
        fail(
          Object.assign(
            new Error(`${origin} does not run projects for ${location.origin} (docs/api.md)`),
            { code: 'EACCES' },
          ),
        );
      }
    };
    addEventListener('message', loaded);
    signal.addEventListener('abort', cancelled, { once: true });
    unbridge = bridgeFrame(
      element,
      origin,
      bridge.entry,
      bridge.table,
      (message) => fail(new Error(message)),
      bridge.traced,
    );
    framed(element);
    container.append(element);
  });
}
