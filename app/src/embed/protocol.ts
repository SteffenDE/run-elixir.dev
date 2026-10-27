// What embed.js (client.ts, on the embedder's page) and embed.html
// (host.ts, on the apex, framed by it) say to each other (docs/embed.md).
// The handshake is two window messages; then calls and events go over a
// MessagePort as rpc.ts has them. The API is versioned: a host answers
// every version it lists, and grows by adding calls, options and events,
// so a page loaded before a deploy keeps working with the newer host.
export const API_VERSION = 1;

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

export type ProjectSource =
  | { id?: string; template: 'phoenix' | 'empty' }
  | { id?: string; archive: string };

export interface CreateOptions {
  // The OTP and Elixir the embedder's code was built with; the site's
  // runtime must be them.
  runtime: RuntimeVersions;
  project: ProjectSource;
  // Keep the project's changes (and its Postgres) in embed.html's
  // storage, which the browser keeps apart for each embedding site, under
  // the project's id.
  persist?: boolean;
  // Every command's environment, under each spawn's own.
  env?: Record<string, string>;
  // Let the project's code reach the site's TCP relay's hosts (GitHub,
  // GitLab, Codeberg, Anthropic's API: docs/relay.md), which send no CORS
  // headers. Off by default: no dialog asks here.
  relay?: boolean;
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
  // A terminal of this size: PTY semantics (echo, line editing, Ctrl+C),
  // stderr on stdout. Without: pipes, stderr apart.
  tty?: { cols: number; rows: number };
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
  // A spawned command's output (fd 1, or 2 without a tty) and exit.
  output: { id: number; fd: number; bytes: Uint8Array };
  exit: { id: number; code: number };
  // A connection the sandbox made to a port the embedder serves.
  connection: { port: number; stream: MessagePort };
};

export const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};
