// What every playground node gets, in the browser and under node.ts: its
// environment, the files around the installation, and its programs.
import { File, devnull, urandom, type Dir } from './wasi/fs';
import type { Programs } from './wasi/process';
import { git, esbuild, tailwind, make, memsup, type NifSource } from './programs';
import type { Vfs } from './vfs';
import { PROGRAMS, TOOLS } from './coreutils';

// The node presents itself as Linux (its uname, beam/host/wasm_host.c), so
// Hex tool wrappers take their Linux paths; its architecture is its own
// (wasm32): the esbuild and tailwind packages run /usr/bin/esbuild and
// /usr/bin/tailwind (their :path, worker/index.ts), the programs below,
// and with :path set look no further (esbuild from 0.10.1).
export const ENV = {
  ROOTDIR: '/rotp',
  // Home is not the project's: Mix's, Hex's and the tools' caches and
  // escripts are kept with the project (files.ts) but are not its files.
  HOME: '/home/user',
  LANG: 'C.UTF-8',
  TERM: 'xterm-256color',
  // Mix's escripts (mix escript.install) are commands too.
  PATH: '/usr/bin:/rotp/bin:/home/user/.mix/escripts',
  MIX_HOME: '/home/user/.mix',
  MIX_ARCHIVES: '/rotp/mix/archives',
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
// shared: files.js). dns: names other than the hosts file's are asked of
// the page's DNS at 127.0.0.53 (UDP and TCP port 53; Tailscale's resolver,
// docs/tailscale.md), else they do not resolve. inotifywait: the page's
// (programs/inotifywait.ts) is on PATH, for file_system (Phoenix's live
// reload); without it file_system only warns, where its port would fail.
export function prepare(root: Dir, { dns = false, inotifywait = false } = {}): void {
  root.mkdirs('work');
  root.mkdirs('tmp');
  root.mkdirs('home/user');
  root.mkdirs('shared');
  root.put('dev/urandom', urandom());
  root.put('dev/null', devnull());
  // Names from the hosts file, then the page's DNS (the Emscripten BEAM's
  // inet, with ERL_INETRC; it has no inet_gethost).
  const text = (string: string) => new File(new TextEncoder().encode(string));
  root.put('etc/hosts', text('127.0.0.1 localhost\n::1 localhost\n'));
  // inet_res takes its nameservers from resolv.conf, again before each
  // query (one in inetrc alone would be dropped).
  if (dns) root.put('etc/resolv.conf', text('nameserver 127.0.0.53\n'));
  root.put(
    'etc/inetrc',
    text(
      `{lookup, [file${dns ? ', dns' : ''}]}.\n` +
        '{host, {127,0,0,1}, ["localhost"]}.\n{host, {0,0,0,0,0,0,0,1}, ["localhost"]}.\n',
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
    // Node.js, npm and npx, on the page (programs/nodejs.ts, npm.ts).
    'node',
    'npm',
    'npx',
    // Claude Code, its JavaScript on that Node (programs/claude/claude.ts).
    'claude',
    'sh',
    'bash',
    'elixir',
    'iex',
    'erl',
    'escript',
    // coreutils.wasm's, and the site's other WASI programs (coreutils.ts).
    ...TOOLS,
    ...Object.keys(PROGRAMS),
    ...(inotifywait ? ['inotifywait'] : []),
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
