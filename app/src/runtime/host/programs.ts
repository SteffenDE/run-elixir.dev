// Programs the node spawns that run on the page (Node's `programs`).
import type { FileSystem } from './files';
import { CHUNK, FRAME, type Node, type SpawnMessage } from './node';

// A program the node started that runs on the page.
export interface PageProcess {
  write(data: string | Uint8Array): void;
  exit(code?: number): void;
  // The node closed its port.
  onkill: (() => void) | null;
  // The node that started it stopped.
  onowner?: (() => void) | null;
  // What it reads: bytes as they come (the terminal's typing, a pipe's),
  // null at their end.
  oninput?: ((bytes: Uint8Array | null) => void) | null;
  // The terminal's size changed.
  onresize?: ((columns: number, rows: number) => void) | null;
  // Sets the terminal's input to raw (keys as typed, Ctrl+C one of them)
  // or back to lines; signals: Ctrl+C still interrupts.
  raw?(on: boolean, signals?: boolean): void;
  // The terminal's size: [columns, rows].
  size?(): number[];
}

export type PageProgram = (
  process: PageProcess,
  context: {
    args: string[];
    cwd: string;
    env: Record<string, string>;
    fs: FileSystem;
    // Whether its stdin and stdout are the terminal.
    tty?: { stdin: boolean; stdout: boolean };
  },
) => void | Promise<void>;

// A program the node started (worker/channel.ts onPage).
export function spawn(node: Node, { id, name, args, cwd, env, tty }: SpawnMessage): void {
  let exited = false;
  const process: PageProcess = {
    onkill: null,
    raw: (on, signals = !on) =>
      node.frame(FRAME.MODE, id, new Uint8Array([on ? 1 : 0, signals ? 1 : 0])),
    size: () => node.size,
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
    .then(() =>
      node.programs[name](process, {
        args,
        cwd,
        env,
        fs: node.fs!,
        tty: { stdin: tty?.[0] ?? false, stdout: tty?.[1] ?? false },
      }),
    )
    .catch((error) => {
      process.write(`${name}: ${error.message}\n`);
      process.exit(1);
    });
}
