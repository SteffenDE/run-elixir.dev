// What embed.js (client.ts, on the embedder's page) and embed.html
// (host.ts, on the apex, framed by it) say to each other (docs/embed.md).
// The handshake is two window messages; then calls and events go over a
// MessagePort as rpc.ts has them. The API is versioned: a host answers
// every version it lists, and grows by adding calls, options and events,
// so a page loaded before a deploy keeps working with the newer host.
export const API_VERSION = 2;

// embed.html → its parent, once it can be driven (nothing more in it).
export const LOADED = 'run-elixir-embed-loaded';
// The embedder → embed.html, with the port the calls go over.
export const CONNECT = 'run-elixir-embed';

// The OTP and Elixir a runtime is (its packages in site.json): the contract for
// an embedder's natively compiled .beam files.
export interface RuntimeVersions {
  otp: string;
  elixir: string;
}

// What `hello` answers.
export interface Hello {
  apiVersion: number;
  apiVersions: number[];
  runtime: RuntimeVersions;
}

// A project: the template it starts from, or an app the embedder built (a
// gzipped tar's URL). `id` is the embedder's own name for it (the same
// name is the same project); `persist` keeps its changes, its home and its
// Postgres in embed.html's storage, which the browser keeps apart for each
// embedding site, and needs an `id`.
export type ProjectSource = { id?: string; persist?: boolean } & (
  | { template: 'phoenix' | 'empty' }
  | { archive: string }
);

export interface CreateOptions {
  // What the embedder's code needs of the site's runtime: semver ranges
  // (OTP's four-part versions compare on their first three parts). None:
  // any.
  requires?: { otp?: string; elixir?: string };
  project: ProjectSource;
  // Every command's environment, under each spawn's own, and both under
  // the playground's own variables (PATH, HOME, …).
  env?: Record<string, string>;
  // The hosts the project's code may reach through the site's TCP relay
  // (docs/relay.md), as its list names them ('github.com', '*.github.com'):
  // those that send no CORS headers. None by default: no dialog asks here.
  relay?: string[];
}

export interface Created {
  // The project's key: its exec and preview origins' name.
  projectId: string;
  runtime: RuntimeVersions;
  // The app's directory (the template's, or the archive's top one).
  root: string;
}

export interface Stat {
  type: 'file' | 'dir';
  size: number;
  // Milliseconds since the epoch.
  mtime: number;
}

export interface DirEntry extends Stat {
  name: string;
}

export interface WriteOptions {
  // Fail (EEXIST) if the file is there already.
  exclusive?: boolean;
  // Fail (ESTALE) unless the file now is these bytes (hex SHA-256), or
  // (empty string) is not there.
  expectedSha256?: string;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

// A terminal: its size, and the program on it (by default an interactive
// shell). PTY semantics: echo, line editing, Ctrl+C; stderr on stdout; a
// newline is CR LF.
export interface TerminalOptions extends SpawnOptions {
  cols: number;
  rows: number;
  command?: string[];
}

// What a process's spawn is, over the port: its words (argv), a shell line
// (sh -c), or neither (an interactive shell); a terminal or pipes.
export interface ProcessRequest extends SpawnOptions {
  argv?: string[];
  line?: string;
  tty?: { cols: number; rows: number };
}

// How a process ended: its exit code, or the signal that ended it.
export interface Exit {
  code: number | null;
  signal: string | null;
}

// A byte stream over a MessagePort (connect, serve), each message one of
// these, as runtime/portConnection.ts frames them.
export type StreamFrame = { data: Uint8Array } | { end: true } | { close: true };

// What the host tells the client.
export type Events = {
  // Starting: what it does now.
  progress: { phase: string; text: string };
  // The ports the project's servers listen on, and the preview's.
  serving: { ports: number[]; port: number | null };
  // Paths below /work the project changed (files.js, at most every 200 ms).
  changed: string[];
  warning: string;
  // A process's output (fd 1, or 2 without a tty) and how it ended.
  output: { id: number; fd: number; bytes: Uint8Array };
  exit: { id: number } & Exit;
  // A connection the sandbox made to a port the embedder serves.
  connection: { port: number; stream: MessagePort };
};
