// What the package's `claude` (program.ts, a page program) and its shared
// frame's worker (worker.ts) say over the port the page gives. Both are
// this package's, so the runtime has no part in it. The worker answers
// `files` with a version's files, and tells `progress` (text) while it
// makes them.

// A file of Claude Code as the worker made it: its path below the
// version's directory (`cli.js`, the entry), and its bytes.
export interface GraphFile {
  name: string;
  data: Uint8Array;
}

// What `files` answers.
export interface ClaudeFiles {
  version: string;
  files: GraphFile[];
}

// Where a project's files.js holds them, by version (claude.ts).
export const DIR = '/opt/claude-code';
