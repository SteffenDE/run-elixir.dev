// exec.html, on a project's exec origin (e-KEY on the usercontent domain,
// site.ts), as a hidden frame of the page that runs the project (create(),
// api/sandbox.ts): the apex's, or an embedder's the site names. It starts
// the worker that runs the project (exec/host.ts) and hands it the port
// that page gave, then does nothing else. Its own page's timers would be
// slowed while the frame is hidden; the worker's are not.
import { bridgeKey } from '../lib/apexLink';
import { bridgeClient } from '../lib/bridgeClient';
import { loadSite, parentOrigins } from '../lib/site';

// In bridge mode (docs/frames.md), its files come from the parent: the
// apex's worker answers its loadSite() as the apex, its only parent.
bridgeClient();
await loadSite();
const parents = new Set(parentOrigins());
let started = false;
let worker: Worker | null = null;

// In bridge mode, this frame can lose its service worker after it loaded
// (docs/frames.md, "When a frame loses its service worker"): Safari deletes
// the shared domain's registration (Intelligent Tracking Prevention), or a
// newer worker takes over after a deploy changed sw.js. The host worker
// checks whether its requests still reach a service worker (exec/host.ts)
// when the controller changes, and when the page becomes visible again:
// Safari deletes the registration when the page is used after a pause.
// What comes before the host worker starts waits for it.
const pending: unknown[] = [];
const tell = (message: unknown) => (worker ? worker.postMessage(message) : pending.push(message));
if (bridgeKey()) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const after = Math.round(performance.now());
    const controller = navigator.serviceWorker.controller ? 'a service worker' : 'none';
    console.info(
      `exec: this frame's controller changed ${after} ms after it loaded, to ${controller} ` +
        `(${worker ? 'after' : 'before'} its host worker started)`,
    );
    tell({ kind: 'playground-exec-controller', after });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tell({ kind: 'playground-exec-visible' });
  });
}

addEventListener('message', (event) => {
  if (event.source !== window.parent || started) return;
  if (event.data?.kind !== 'playground-exec' || !event.ports[0]) return;
  if (!parents.has(event.origin)) {
    // Said to that page alone, so that it fails with why.
    window.parent.postMessage({ kind: 'playground-exec-refused' }, event.origin);
    return;
  }
  started = true;
  worker = new Worker(new URL('../exec/host.ts', import.meta.url), {
    type: 'module',
    name: 'playground-exec',
  });
  worker.onerror = (error) => {
    // A load's failure has no message: in bridge mode, most likely its
    // request skipped the service worker, which nothing here can report.
    if (!error.message)
      console.error(
        `exec: the host worker did not load (this frame's service worker: ` +
          `${navigator.serviceWorker?.controller ? 'present' : 'none'}). Reload the page.`,
      );
  };
  worker.postMessage({ kind: 'playground-exec' }, [event.ports[0]]);
  for (const message of pending.splice(0)) worker.postMessage(message);
  window.parent.postMessage({ kind: 'playground-exec-started' }, event.origin);
});
// Nothing in it but that the frame loaded: any parent may hear it.
window.parent.postMessage({ kind: 'playground-exec-loaded', isolated: crossOriginIsolated }, '*');
