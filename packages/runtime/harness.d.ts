// @elixir-playground/runtime/harness: the Node harness (src/harness.ts),
// one node of the Emscripten BEAM under Node. The runtime package
// publishes this file as node/harness.d.ts, beside the bundle; it
// follows src/harness.ts's types by hand.

// A package: its installed directory (with its package.json), or a
// descriptor of one (`base` its directory's URL).
export type HarnessPackage =
  | string
  | URL
  | {
      name: string;
      version: string;
      base: string;
      files: Record<string, { size: number; sha256: string }>;
      peerDependencies?: Record<string, string>;
      playground: Record<string, unknown>;
    };

// A program a node's port runs (open_port spawn): the runtime's process
// interface, not a stable one.
// oxlint-disable-next-line typescript/no-explicit-any -- the runtime's own types.
export type HarnessProgram = (process: any, context: any) => void;

export interface HarnessOptions {
  // The packages the node runs on, in order (OTP's among them), or a site
  // manifest: its file, or a site whose index.html names it.
  packages?: HarnessPackage[];
  site?: string;
  // erl's arguments.
  args: string[];
  // The working directory (default /work), and variables over the
  // packages' and the runtime's own.
  cwd?: string;
  env?: Record<string, string>;
  // Host directories in the node's tree, read when first opened; what
  // the node writes stays in memory (HarnessResult.snapshot copies it out).
  mounts?: Record<string, string>;
  // The site's boot images to unpack (default: every one it names).
  boot?: string[];
  tty?: boolean;
  size?: [columns: number, rows: number];
  onMode?: (raw: boolean) => void;
  stdout?: (bytes: Uint8Array) => void;
  stderr?: (bytes: Uint8Array) => void;
  // Plain HTTP on the node's ports: http://localhost:PORT/PATH is answered
  // with Node's fetch of the URL route(PATH) names (null: 404).
  http?: Record<number, (path: string) => string | null | Promise<string | null>>;
  programs?: Record<string, HarnessProgram>;
  onFetch?: (path: string) => void;
  trace?: boolean;
}

export interface HarnessResult {
  status: number;
  unpacked: number;
  fetched: string[];
  // What the node wrote below `at`, copied to `host`; the files' paths
  // below `at`.
  snapshot(at: string, host: string): string[];
}

export interface HarnessNode {
  // The node's network (its listeners): the runtime's, not a stable
  // interface.
  network: unknown;
  input(bytes: Uint8Array): void;
  end(): void;
  resize(columns: number, rows: number): void;
  signal(signum: number): boolean;
  kill(status: number): void;
  done: Promise<HarnessResult>;
}

export declare function start(options: HarnessOptions): Promise<HarnessNode>;

// This process's terminal, or its pipes, for a node: `options` for
// start(), then attach(node), which feeds it standard input, Ctrl+C and
// the terminal's size, and resolves with its status once it halts.
export declare function processTerminal(): {
  options: Pick<HarnessOptions, 'tty' | 'size' | 'onMode'>;
  attach(node: HarnessNode): Promise<number>;
};

// MOUNT=VFSDIR:HOSTDIR,…: start()'s mounts, as the commands take them.
export declare function envMounts(value?: string): Record<string, string>;
