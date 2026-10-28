// claude.html, on the claude origin (claude.USERCONTENT, site.ts), as a
// hidden frame of the page that runs projects (programs/claude/frame.ts:
// the apex's, or an embedder's the site names): one origin for every
// project, whose storage keeps Claude Code's files once (for each
// top-level site). It starts the worker that makes them
// (programs/claude/worker.ts) and hands it each port that page gives.
import { loadSite, parentOrigins } from '../lib/site';

await loadSite();
const parents = new Set(parentOrigins());
const worker = new Worker(new URL('../programs/claude/worker.ts', import.meta.url), {
  type: 'module',
  name: 'playground-claude',
});

addEventListener('message', (event) => {
  if (!parents.has(event.origin) || event.source !== window.parent) return;
  if (event.data?.kind !== 'playground-claude' || !event.ports[0]) return;
  worker.postMessage({ kind: 'playground-claude' }, [event.ports[0]]);
});
// Nothing in it but that the frame loaded: any parent may hear it.
window.parent.postMessage({ kind: 'playground-claude-loaded' }, '*');
