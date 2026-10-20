// exec.html, on a project's exec origin (e-KEY on the usercontent domain,
// site.ts), as a hidden frame of its IDE on the apex (exec.ts in project/
// lib): it starts the worker that runs the project (exec/host.ts) and
// hands it the port the IDE gave, then does nothing else. Its own page's
// timers would be slowed while the frame is hidden; the worker's are not.
import { apexOrigin, loadSite } from '@/shared/lib/site';

await loadSite();
const ide = apexOrigin();
let started = false;

addEventListener('message', (event) => {
  if (event.origin !== ide || event.source !== window.parent || started) return;
  if (event.data?.kind !== 'playground-exec' || !event.ports[0]) return;
  started = true;
  const worker = new Worker(new URL('../exec/host.ts', import.meta.url), {
    type: 'module',
    name: 'playground-exec',
  });
  worker.postMessage({ kind: 'playground-exec' }, [event.ports[0]]);
});
window.parent.postMessage({ kind: 'playground-exec-loaded', isolated: crossOriginIsolated }, ide);
