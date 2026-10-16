// What the IDE's components do to a project, wherever it runs: the nodes
// in this page (playground.ts), or a live session's host, for a guest
// (src/live/lib/guest.ts). Components call `workspace()` when they act,
// never the nodes themselves.
export interface Workspace {
  read(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<'file' | 'dir' | null>;
  // The tree's file operations, on absolute paths below /work.
  createFile(path: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  movePath(from: string, to: string): Promise<void>;
  removePath(path: string): Promise<void>;
  // Open a file in the editor, with the caret on `line`.
  openFile(path: string, line?: number): Promise<void>;
  save(path: string, text: string): Promise<void>;
  // Where relative paths a shell prints may start.
  searchPath(): string[];
  // Terminal `id`'s output (what came before is replayed, the echo of what
  // anyone typed too), keys typed into it, and its size.
  onOutput(id: number, listener: (text: string) => void): () => void;
  keys(id: number, data: string): void;
  resize(id: number, columns: number, rows: number): void;
  openTerminal(): void;
  closeTerminal(id: number): void;
  restartServer(): void;
}

let current: Workspace | null = null;

export function setWorkspace(next: Workspace): void {
  current = next;
}

export function workspace(): Workspace {
  if (!current) throw new Error('the playground is not running');
  return current;
}
