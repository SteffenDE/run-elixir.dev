// exec.html, on a project's exec origin (e-KEY on the usercontent domain,
// site.ts), as a hidden frame of the page that runs the project (create(),
// api/sandbox.ts): the apex's, or an embedder's the site names. It starts
// the worker that runs the project (exec/host.ts) and hands it the port
// that page gave, then does nothing else. Its own page's timers would be
// slowed while the frame is hidden; the worker's are not.
import { loadSite, parentOrigins } from '@/shared/lib/site';

await loadSite();
const parents = new Set(parentOrigins());
let started = false;

addEventListener('message', (event) => {
  if (event.source !== window.parent || started) return;
  if (event.data?.kind !== 'playground-exec' || !event.ports[0]) return;
  if (!parents.has(event.origin)) {
    // Said to that page alone, so that it fails with why.
    window.parent.postMessage({ kind: 'playground-exec-refused' }, event.origin);
    return;
  }
  started = true;
  const worker = new Worker(new URL('../exec/host.ts', import.meta.url), {
    type: 'module',
    name: 'playground-exec',
  });
  worker.postMessage({ kind: 'playground-exec' }, [event.ports[0]]);
  window.parent.postMessage({ kind: 'playground-exec-started' }, event.origin);
});
// Nothing in it but that the frame loaded: any parent may hear it.
window.parent.postMessage({ kind: 'playground-exec-loaded', isolated: crossOriginIsolated }, '*');
