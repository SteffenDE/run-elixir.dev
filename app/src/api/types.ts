// The API's types (docs/api.md): what create() takes, and what a sandbox
// answers. create() runs on the page that calls it, which becomes the
// project's apex: its stores and the frames' parent. Nothing here crosses
// a window boundary.
import type { Boot, PackageEntry } from '@/runtime/packages/manifest';
import type { Connection } from '@/runtime/host/node';

// The OTP and Elixir a sandbox runs: its OTP and Elixir packages'.
export interface RuntimeVersions {
  otp: string;
  elixir: string;
}

// A package as its module exports it (import otp from
// '@elixir-playground/otp-29.1.2'): its package.json's name, version, peer
// dependencies and `playground` field, its files, and `base`, where they
// are on the usercontent domain (/npm/@elixir-playground/NAME@VERSION/).
export interface PackageDescriptor extends PackageEntry {
  name: string;
}

// Something a node connects to on the page: Postgres, Hex's cache.
export type Service = (connection: Connection) => void;

// What the exec frame asks the page for a project, beyond its services.
// The playground's own (tailscale.ts); not a stable interface yet.
export interface ApexHandlers {
  tailnetDial?: (host: unknown, port: unknown, proto: unknown, conn: unknown) => Promise<boolean>;
  tailnetResolve?: (query: unknown) => Promise<Uint8Array>;
}

// A plugin's part of one sandbox, on the page.
export interface ApexInstance {
  // Services by name (`postgres`: port 5432).
  services?: Record<string, Service>;
  handlers?: ApexHandlers;
  close?(): void | Promise<void>;
}

// What a plugin is told about the sandbox it joins.
export interface ApexContext {
  // The project's key (its origins' name).
  projectId: string;
  // Whether the project keeps its data (project.persist).
  persist: boolean;
}

// A plugin that runs code on the page (pglite): one instance per sandbox.
export interface ApexPlugin {
  name: string;
  apex(context: ApexContext): ApexInstance | Promise<ApexInstance>;
}

// A package, a plugin with code, or a list of them (a preset:
// @elixir-playground/standard).
export type Plugin = PackageDescriptor | ApexPlugin | readonly Plugin[];

// The project: a template package to start from (its fs layer is the
// app), none ('empty'), or an app the embedder built (a gzipped tar's
// URL). `id` is the embedder's own name for it (the same name is the
// same project); `persist` keeps its changes, its home and what its
// plugins keep (Postgres) in this page's storage, and needs an `id`.
export type ProjectSource = { id?: string; persist?: boolean } & (
  | { template: PackageDescriptor | 'empty' }
  | { archive: string }
);

// How the project's code reaches a host through the site's TCP relay
// (docs/relay.md): the hosts it may reach, as the relay's list names them
// ('github.com', '*.github.com'), or a function that decides per host.
export type Way = 'tailnet' | 'relay' | 'none';
export type RelayPolicy = readonly string[] | ((host: unknown) => Way | Promise<Way>);

export interface CreateOptions {
  // The packages and plugins the sandbox runs with: OTP, Elixir, the
  // shell and its tools (@elixir-playground/standard), Claude Code.
  plugins: readonly Plugin[];
  project: ProjectSource;
  // The boot recordings for this set of packages, if any (faster boot).
  boot?: Boot | null;
  // Every command's environment, under each spawn's own, and both under
  // the playground's own variables (PATH, HOME, …).
  env?: Record<string, string>;
  // None by default: the project reaches only hosts that send CORS headers.
  relay?: RelayPolicy;
  // The usercontent domain that runs project code (with a port, if any):
  // its e-KEY, v-KEY-PORT and claude names. By default the one the page's
  // site names (/playground.json).
  usercontent?: string;
  // The runtime package's path on the usercontent domain
  // (/npm/@elixir-playground/runtime@VERSION/). By default the page's
  // <meta name="playground-runtime">.
  runtime?: string;
  // Where the (one-pixel, unseen) exec frame goes: document.body by default.
  container?: HTMLElement;
  onProgress?: (event: Events['progress']) => void;
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
// shell, which types `initial` first, its history seeded with them). PTY
// semantics: echo, line editing, Ctrl+C; stderr on stdout; a newline is
// CR LF.
export interface TerminalOptions extends SpawnOptions {
  cols: number;
  rows: number;
  command?: string[];
  initial?: string[];
}

// How a process ended: its exit code, or the signal that ended it.
export interface Exit {
  code: number | null;
  signal: string | null;
}

// A byte stream over a MessagePort (connect, serve), each message one of
// these, as runtime/portConnection.ts frames them.
export type StreamFrame = { data: Uint8Array } | { end: true } | { close: true };

// What a sandbox tells (sandbox.on).
export type Events = {
  // Starting: what it does now.
  progress: { phase: string; text: string };
  // The ports the project's servers listen on, and the preview's.
  serving: { ports: number[]; port: number | null };
  // Paths below /work the project changed (files.js, at most every 200 ms).
  changed: string[];
  warning: string;
};
