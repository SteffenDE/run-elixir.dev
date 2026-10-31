// A package's page program (docs/packages.md, "Page programs"): a command
// a package adds (`playground.pagePrograms`: NAME → a JavaScript module of
// its own), which runs on the page, in the exec frame's worker, as the
// runtime's own page programs do (sh). The module's
// default export is the program. The runtime imports it the first time the
// command runs, below the bridge (its package's path), and puts NAME on
// PATH. What the program reaches is what `host` gives it: the other page
// programs (to run node), the project's file changes, and ports to its
// package's shared frames.
import type { FileSystem as Files } from './host/files';

// A program's process: what it writes, its exit, and what it hears.
export interface Process {
  write(data: string | Uint8Array): void;
  // Its standard error (host/programs.ts PageProcess); without, its output.
  writeError?(data: string | Uint8Array): void;
  exit(code?: number): void;
  // The node closed its port.
  onkill: (() => void) | null;
  // The node that started it stopped.
  onowner?: (() => void) | null;
  // What it reads (null: the end), the terminal's size changing, raw input
  // on or off (host/programs.ts PageProcess).
  oninput?: ((bytes: Uint8Array | null) => void) | null;
  onresize?: ((columns: number, rows: number) => void) | null;
  raw?(on: boolean, signals?: boolean): void;
  size?(): number[];
}

// What it runs with: its arguments, directory, environment, the project's
// files and the terminal.
export interface Context {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  fs: Files;
  // Whether its stdin and stdout are the terminal.
  tty?: { stdin: boolean; stdout: boolean };
  // A worker program's own options (programs/workerProgram.ts), which its
  // worker reads (node's `bun`: Bun's globals, for Claude Code).
  options?: Record<string, unknown>;
}

export interface PageProgramHost {
  // The page programs by name (node, npm, sh, …, the packages'): one runs
  // as this process when this one hands its process on to it.
  programs(): Record<string, PageProgram>;
  // A port to one of this program's package's shared frames
  // (`playground.frames`), which the page frames once for every project.
  frame(name: string): Promise<MessagePort>;
  // Each change to the project's files, from the nodes and the editor, as
  // its paths (a watch mode: esbuild's, tailwind's, inotifywait); the
  // returned function stops it.
  watch(changed: (paths: string[]) => void): () => void;
}

export type PageProgram = (process: Process, context: Context) => void | Promise<void>;

// What a package's module exports by default.
export type PackageProgram = (
  process: Process,
  context: Context,
  host: PageProgramHost,
) => void | Promise<void>;
