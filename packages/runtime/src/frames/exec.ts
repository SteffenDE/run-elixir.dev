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

// In bridge mode, a newer service worker can take over this frame after
// it started: a deploy changed the shared domain's sw.js, and another
// frame of this origin loaded since. The host worker checks that its
// requests still reach a service worker (exec/host.ts). Logged, for
// debugging: the bootstrap should have bridged with the newest worker
// (root/bridge.html), so a takeover means sw.js changed after the boot.
if (bridgeKey())
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const after = Math.round(performance.now());
    console.info(
      `exec: a newer service worker took over this frame ${after} ms after it loaded ` +
        `(${worker ? 'after' : 'before'} its host worker started)`,
    );
    worker?.postMessage({ kind: 'playground-exec-controller', after });
  });

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
  worker.postMessage({ kind: 'playground-exec' }, [event.ports[0]]);
  window.parent.postMessage({ kind: 'playground-exec-started' }, event.origin);
});
// Nothing in it but that the frame loaded: any parent may hear it.
window.parent.postMessage({ kind: 'playground-exec-loaded', isolated: crossOriginIsolated }, '*');
