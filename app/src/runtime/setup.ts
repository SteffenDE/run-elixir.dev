// What every playground node gets, in the browser and under node.ts: its
// environment, the files around the installation, and its programs.
import { File, urandom, type Dir } from './wasi/fs';
import type { Programs } from './wasi/process';
import { git, esbuild, tailwind, make, memsup, type NifSource } from './programs';
import type { Vfs } from './vfs';

// The node presents itself as Linux x86_64 (crates/rotp/src/host/mod.rs),
// so Hex tool wrappers take their Linux paths; the esbuild and tailwind
// packages run /usr/bin/esbuild and /usr/bin/tailwind (their :path,
// worker/index.ts), the programs below.
export const ENV = {
  ROOTDIR: '/rotp',
  HOME: '/work',
  LANG: 'C.UTF-8',
  TERM: 'xterm-256color',
  // Mix's escripts (mix escript.install) are commands too.
  PATH: '/usr/bin:/rotp/bin:/work/.mix/escripts',
  MIX_HOME: '/work/.mix',
  MIX_ARCHIVES: '/rotp/mix/archives',
  ROTP_OS_TYPE: 'linux',
  ROTP_SYSTEM_ARCHITECTURE: 'x86_64-pc-linux-gnu',
  // cc_precompiler's target (lazy_html's): the node's own on WebAssembly,
  // which no package lists, so elixir_make runs make (programs.ts) rather
  // than downloading the x86_64 Linux build.
  TARGET_ARCH: 'wasm32',
  TARGET_OS: 'unknown',
  TARGET_ABI: 'wasi',
  // The rebar3 Mix builds rebar3 dependencies with (installed by
  // tools/rotp/mix.exs): an escript, which the page's rebar3 program runs.
  MIX_REBAR3: '/rotp/mix/rebar3',
};

// The node's own tree around the installation (/work and /tmp may be
// shared: files.js).
export function prepare(root: Dir): void {
  root.mkdirs('work');
  root.mkdirs('tmp');
  root.put('dev/urandom', urandom());
  // Names from the hosts file only (the Emscripten BEAM's inet, with
  // ERL_INETRC; it has no inet_gethost).
  const text = (string: string) => new File(new TextEncoder().encode(string));
  root.put('etc/hosts', text('127.0.0.1 localhost\n::1 localhost\n'));
  root.put(
    'etc/inetrc',
    text(
      '{lookup, [file]}.\n{host, {127,0,0,1}, ["localhost"]}.\n{host, {0,0,0,0,0,0,0,1}, ["localhost"]}.\n',
    ),
  );
  root.put('rotp/bin/mix', new File(new TextEncoder().encode('Mix.CLI.main()\n')));
  // Programs the node finds on PATH (os:find_executable, System.cmd): the
  // page's (/rotp/bin/mix is Mix's script, which mix runs).
  for (const name of [
    'git',
    'esbuild',
    'tailwind',
    'make',
    'sh',
    'elixir',
    'iex',
    'erl',
    'escript',
  ])
    root.put(`usr/bin/${name}`, new File());
}

// fs: the node's files (vfs.ts); nif(name, version): a package's NIF
// library build (make), or null.
export const programs = (fs: Vfs, nif: NifSource = () => null): Programs => ({
  git: git(fs),
  memsup,
  esbuild,
  tailwind,
  make: make(fs, nif),
});
