// A package's page program (docs/packages.md, "Page programs"): a command
// a package adds (`playground.pagePrograms`: NAME → a JavaScript module of
// its own), which runs on the page, in the exec frame's worker, as the
// runtime's own page programs do (node, npm, esbuild). The module's
// default export is the program. The runtime imports it the first time the
// command runs, below the bridge (its package's path), and puts NAME on
// PATH. What the program reaches is what `host` gives it: the other page
// programs (to run node), and ports to its package's shared frames.
import type { Context, Process } from './programs/tailwind';

export type { Context, Process };

export interface PageProgramHost {
  // The page programs by name (node, npm, sh, …, the packages'): one runs
  // as this process when this one hands its process on to it.
  programs(): Record<string, PageProgram>;
  // A port to one of this program's package's shared frames
  // (`playground.frames`), which the page frames once for every project.
  frame(name: string): Promise<MessagePort>;
}

export type PageProgram = (process: Process, context: Context) => void | Promise<void>;

// What a package's module exports by default.
export type PackageProgram = (
  process: Process,
  context: Context,
  host: PageProgramHost,
) => void | Promise<void>;
