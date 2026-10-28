// claude.html, the claude package's page on the claude origin
// (claude.USERCONTENT), as a hidden frame of the page that runs projects
// (the api package's claudeFrame.ts: the apex's, or an embedder's the
// site names): one origin for every project, whose storage keeps Claude
// Code's files once (for each top-level site). It starts the worker that
// makes them (worker.ts) and hands it each port that page gives, over
// which the exec frame's `claude` asks (the runtime's
// programs/claude/protocol.ts).
import { loadSite, parentOrigins } from '@elixir-playground/runtime/lib/site';

await loadSite();
const parents = new Set(parentOrigins());
const worker = new Worker(new URL('./worker.ts', import.meta.url), {
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
