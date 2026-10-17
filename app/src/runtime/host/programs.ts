// Programs the node spawns that run on the page (Node's `programs`).
import type { FileSystem } from './files';
import { CHUNK, FRAME, type Node, type SpawnMessage } from './node';

// A program the node started that runs on the page.
export interface PageProcess {
  write(data: string | Uint8Array): void;
  exit(code?: number): void;
  onkill: (() => void) | null;
}

export type PageProgram = (
  process: PageProcess,
  context: { args: string[]; cwd: string; env: Record<string, string>; fs: FileSystem },
) => void | Promise<void>;

// A program the node started (worker/channel.ts onPage).
export function spawn(node: Node, { id, name, args, cwd, env }: SpawnMessage): void {
  let exited = false;
  const process: PageProcess = {
    onkill: null,
    write: (data) => {
      if (exited) return;
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      for (let at = 0; at < bytes.length; at += CHUNK)
        node.frame(FRAME.OUTPUT, id, bytes.subarray(at, at + CHUNK));
    },
    exit: (code = 0) => {
      if (exited) return;
      exited = true;
      node.running.delete(id);
      node.spawned.delete(id);
      node.frame(FRAME.EXIT, id, new Uint8Array([code & 255]));
    },
  };
  node.running.set(id, process);
  node.spawned.set(id, { command: [name, ...args].join(' '), started: Date.now() });
  Promise.resolve()
    // Page programs come with shared files.
    .then(() => node.programs[name](process, { args, cwd, env, fs: node.fs! }))
    .catch((error) => {
      process.write(`${name}: ${error.message}\n`);
      process.exit(1);
    });
}
