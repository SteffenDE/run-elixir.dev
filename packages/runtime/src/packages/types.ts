// The site manifest's types (manifest.ts; docs/packages.md): a
// package.json's `playground` field, a package's entry, the boot
// recordings. Types only, with no imports: the API's published
// declarations (@elixir-playground/api) carry this file.

// A package.json's `playground` field. Each package fills in what it is.
export interface Playground {
  // The ABI seams the package's files use, each at its version (host.json's
  // `provides` names what the runtime offers).
  abi?: Record<string, number>;
  // Programs by name, each a module of the package's, run with the name as
  // its argv[0].
  programs?: Record<string, Program>;
  // shell: the terminal's shell (brush.wasm).
  shell?: string;
  // otp-X: its version, the build's beamAbi id, the NIF ABI its libraries
  // are built for ("LAYER-MAJOR.MINOR": the erl_nif layer's protocol and
  // OTP's erl_nif.h, docs/nif.md), and the emulator's files.
  otp?: string;
  beamAbi?: string;
  nifAbi?: string;
  // (The loader's Emscripten glue loads its threads' script, beam.emu.mjs,
  // from beside itself: the package's own layout.)
  beam?: { loader: string; wasm: string };
  // elixir-X: its version, and the OTP it runs on (a semver range).
  elixir?: string;
  requires?: { otp?: string };
  // A template: its kind, id (a digest of its files, without its build),
  // label, and the OTP and Elixir it was compiled with. Its files are its
  // fs layer's, at the layer's root.
  template?: { kind: string; id: string; label: string; otp: string; elixir: string };
  // Commands: each a file of the package's fs layer (relative to its
  // root), which the runtime links from /usr/bin/NAME.
  bin?: Record<string, string>;
  // Variables every node gets, each a path of the package's fs layer
  // (relative to its root; "." the root itself).
  env?: Record<string, string>;
  // tls: a Node.js process's TLS client and the roots it trusts.
  tls?: { module: string; roots: string };
  // tailscale: the apex's Tailscale node, and Go's glue for it (the Go
  // that built it has its own: wasm_exec.js).
  tailscale?: { module: string; glue: string };
  // claude: the Claude Code versions the preparer was tested with.
  claudeCode?: string;
  // The package's files in the nodes' tree: a layer of the fs image.
  fs?: FsLayer;
}

// A package's files in the nodes' tree (fs format 3), below `root` (an
// absolute path the package chooses: /opt/otp/29.1.2, /usr/libexec/git-core):
// `manifest` lists them relative to it, [path, size, mtime, bundle]
// (wasi/fs.ts Manifest), each `bundle` one of the package's `count` tars
// in `bundles` (N.tar). `version`: a digest of the files' paths and bytes.
export interface FsLayer {
  format: number;
  root: string;
  manifest: string;
  bundles: string;
  count: number;
  version: string;
}

export interface FileEntry {
  size: number;
  sha256: string;
}

export interface PackageEntry {
  version: string;
  // Where its files are, relative to site.json.
  base: string;
  files: Record<string, FileEntry>;
  peerDependencies?: Record<string, string>;
  playground: Playground;
}

// What the nodes boot from: gzipped tars of the files IEx and the Phoenix
// server read first (NAME.tar.gz, in `base`), recorded with exactly the
// packages in `packages`, a combination of them, not a package: their
// versions, and (`layers`) their fs layers' versions, which name their
// files whatever version the package is.
export interface Boot {
  base: string;
  images: string[];
  packages: Record<string, string>;
  layers?: Record<string, string>;
}

export interface SiteManifest {
  manifest: number;
  packages: Record<string, PackageEntry>;
  boot: Boot | null;
}

// A program: its module, and whether that is a multi-call one (coreutils.wasm:
// its first argument names the tool), which the exec frame compiles once
// for every node and runs on its caller's thread. Other modules run as
// processes of the worker's table (processes.ts).
export interface Program {
  module: string;
  multicall?: boolean;
}
