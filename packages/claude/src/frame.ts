// claude.html, the claude package's shared frame (`playground.frames`:
// claude; the runtime's lib/sharedFrame.ts), which the page frames once
// on an origin of its own (claude-HASH on the shared usercontent domain):
// one origin for every project of the page, whose storage keeps Claude
// Code's files once. It starts the worker that makes them (worker.ts) and
// hands it each port the page gives, over which the package's `claude`
// (program.ts) asks (protocol.ts).
import { serveFrame } from '@elixir-playground/runtime/lib/sharedFrame';

const worker = new Worker(new URL('./worker.ts', import.meta.url), {
  type: 'module',
  name: 'playground-claude',
});

serveFrame((port) => worker.postMessage({ kind: 'playground-claude' }, [port]));
