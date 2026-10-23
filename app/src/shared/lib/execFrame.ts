// The frame that runs a project (e-KEY on the usercontent domain,
// frames/exec.ts), started from the page that drives it: the IDE's
// (project/lib/playground.ts) or embed.html's (embed/host.ts).
import { Rpc } from './rpc';

// A frame on the screen but unseen: a pixel, transparent, out of the way.
// Not `hidden`: WebKit slowed a hidden frame's workers (the nodes') until
// a node waiting on a program's exit never heard of it (docs/frames.md).
// Styled here, not by the page's stylesheet: embed.html has none.
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
export async function startExecFrame(
  origin: string,
  signal: AbortSignal,
  container: HTMLElement,
  framed: (element: HTMLIFrameElement) => void = () => {},
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
    element.src = `${origin}/exec.html`;
    const cleanup = () => {
      removeEventListener('message', loaded);
      signal.removeEventListener('abort', cancelled);
      clearTimeout(timer);
    };
    const cancelled = () => {
      cleanup();
      element.remove();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      element.remove();
      reject(new Error(`${origin}: the project did not start`));
    }, 30000);
    const loaded = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== element.contentWindow) return;
      if (event.data?.kind !== 'playground-exec-loaded') return;
      cleanup();
      if (!event.data.isolated) {
        element.remove();
        reject(new Error(`${origin} is not cross-origin isolated (see docs/frames.md).`));
        return;
      }
      const channel = new MessageChannel();
      element.contentWindow!.postMessage({ kind: 'playground-exec' }, origin, [channel.port2]);
      resolve(new Rpc(channel.port1));
    };
    addEventListener('message', loaded);
    signal.addEventListener('abort', cancelled, { once: true });
    framed(element);
    container.append(element);
  });
}
