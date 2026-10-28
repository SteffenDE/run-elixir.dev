// The claude frame's worker (frames/claude.ts, on claude.USERCONTENT): it
// answers each port the frame passes on (an exec frame's `claude`, through
// the IDE's page: frame.ts) with Claude Code's files, made once for every
// project and every tab (build.ts; a lock, so two never make them at
// once). It runs none of Claude Code: it fetches, checks, reads and
// compiles, and keeps the result.
import { Rpc, transfer } from '../../lib/rpc';
import { CLAUDE_CODE, claudeFiles } from './build';

const LOCK = 'playground-claude-code';
// Progress listeners for requests waiting for Claude Code's files.
const waiting = new Set<(text: string) => void>();
const say = (text: string) => {
  for (const listener of waiting) listener(text);
};

self.onmessage = ({ data, ports }: MessageEvent) => {
  if (data?.kind !== 'playground-claude' || !ports[0]) return;
  const rpc = new Rpc(ports[0]).handle({
    async files() {
      const progress = (text: string) => rpc.emit('progress', text);
      waiting.add(progress);
      try {
        const files = await navigator.locks.request(LOCK, () => claudeFiles(say));
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
