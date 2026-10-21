// claude.html, on the claude origin (claude.USERCONTENT, site.ts), as a
// hidden frame of the IDE on the apex (programs/claude/frame.ts): one origin
// for every project, whose storage keeps Claude Code's files once. It
// starts the worker that makes them (programs/claude/worker.ts) and hands
// it each port the IDE gives, from the IDE alone.
import { apexOrigin, loadSite } from '@/shared/lib/site';

await loadSite();
const ide = apexOrigin();
const worker = new Worker(new URL('../project/lib/programs/claude/worker.ts', import.meta.url), {
  type: 'module',
  name: 'playground-claude',
});

addEventListener('message', (event) => {
  if (event.origin !== ide || event.source !== window.parent) return;
  if (event.data?.kind !== 'playground-claude' || !event.ports[0]) return;
  worker.postMessage({ kind: 'playground-claude' }, [event.ports[0]]);
});
window.parent.postMessage({ kind: 'playground-claude-loaded' }, ide);
