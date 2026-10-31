// The claude frame's worker (frame.ts, on claude-HASH.USERCONTENT): it
// answers each port the frame passes on (program.ts, an exec frame's
// `claude`, through the page: the api package's sharedFrame.ts) with Claude Code's
// files (protocol.ts), made once for every
// project and every tab (build.ts; a lock, so two never make them at
// once). It runs none of Claude Code: it fetches, checks, reads and
// compiles, and keeps the result.
import { Rpc, transfer } from '@elixir-playground/runtime/sdk/frame';
import { CLAUDE_CODE, claudeFiles, type EsbuildLoader } from './build';

const LOCK = 'playground-claude-code';
// Progress listeners for requests waiting for Claude Code's files.
const waiting = new Set<(text: string) => void>();
const say = (text: string) => {
  for (const listener of waiting) listener(text);
};

// The esbuild package's esbuild.js (the frame's peer), loaded once.
let esbuild: ReturnType<EsbuildLoader> | null = null;
const loadEsbuild =
  (url: string | null): EsbuildLoader =>
  () => {
    if (!url)
      return Promise.reject(new Error('the site has no @elixir-playground/esbuild package'));
    esbuild ??= import(/* @vite-ignore */ new URL('esbuild.js', url).href).then(
      (module: { load: EsbuildLoader }) => module.load(),
    );
    esbuild.catch(() => (esbuild = null));
    return esbuild;
  };

self.onmessage = ({ data, ports }: MessageEvent) => {
  if (data?.kind !== 'playground-claude' || !ports[0]) return;
  const load = loadEsbuild(typeof data.esbuild === 'string' ? data.esbuild : null);
  const rpc = new Rpc(ports[0]).handle({
    async files() {
      const progress = (text: string) => rpc.emit('progress', text);
      waiting.add(progress);
      try {
        const files = await navigator.locks.request(LOCK, () => claudeFiles(say, load));
        // Each file's bytes, handed over (they are this request's own: kept
        // files are read anew each time).
        const buffers = [...new Set(files.map((file) => file.data.buffer as ArrayBuffer))];
        return transfer({ version: CLAUDE_CODE.version, files }, buffers);
      } finally {
        waiting.delete(progress);
      }
    },
  });
};
