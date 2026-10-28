// What every playground node gets, in the browser and under node.ts: its
// environment, the files around the installation, and its programs.
import { File, Symlink, devnull, urandom, type Dir } from './wasi/fs';
import type { Programs } from './wasi/process';
import { esbuild, tailwind, make, memsup, type NifSource } from './programs';
import type { Vfs } from './vfs';
import { REGISTRY } from './coreutils';
import { UTILITIES } from './utilities';
import type { Site } from './packages/manifest';

// The node presents itself as Linux (its uname, beam/host/wasm_host.c), so
// Hex tool wrappers take their Linux paths; its architecture is its own
// (wasm32): the esbuild and tailwind packages run /usr/bin/esbuild and
// /usr/bin/tailwind (their :path, worker/index.ts), the programs below,
// and with :path set look no further (esbuild from 0.10.1).
// The runtime's own; the packages add theirs (environment: ROOTDIR,
// MIX_ARCHIVES, MIX_REBAR3, each a path of a package's layer).
export const ENV = {
  // Home is not the project's: Mix's, Hex's and the tools' caches and
  // escripts are kept with the project (files.ts) but are not its files.
  HOME: '/home/user',
  LANG: 'C.UTF-8',
  TERM: 'xterm-256color',
  // The packages' commands are linked from /usr/bin (prepare); Mix's
  // escripts (mix escript.install) are commands too.
  PATH: '/usr/bin:/home/user/.mix/escripts',
  MIX_HOME: '/home/user/.mix',
  // cc_precompiler's target (lazy_html's): the node's own on WebAssembly,
  // which no package lists, so elixir_make runs make (programs.ts) rather
  // than downloading the x86_64 Linux build.
  TARGET_ARCH: 'wasm32',
  TARGET_OS: 'unknown',
  TARGET_ABI: 'wasi',
};

// Every node's environment on `packages`: the runtime's own under the
// packages' (OTP's ROOTDIR; Elixir's MIX_ARCHIVES and MIX_REBAR3, the
// rebar3 escript Mix builds rebar3 dependencies with, which the page's
// rebar3 program runs).
export const environment = (packages: Site): Record<string, string> => ({
  ...ENV,
  ...packages.environment(),
});

// The node's own tree around the installation (/work and /tmp may be
// shared: files.js). dns: names other than the hosts file's are asked of
// the page's DNS at 127.0.0.53 (UDP and TCP port 53; Tailscale's resolver,
// docs/tailscale.md), else they do not resolve. inotifywait: the page's
// (programs/inotifywait.ts) is on PATH, for file_system (Phoenix's live
// reload); without it file_system only warns, where its port would fail.
// bin: the packages' commands (Site.bin), each linked from /usr/bin.
export function prepare(
  root: Dir,
  { dns = false, inotifywait = false, bin = new Map<string, string>() } = {},
): void {
  root.mkdirs('work');
  root.mkdirs('tmp');
  root.mkdirs('home/user');
  root.mkdirs('shared');
  // git.wasm's templates (none: hooks are samples): its init and clone
  // warn without the directory.
  root.mkdirs('usr/share/git-core/templates');
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
  // The packages' commands (mix: Mix's script, which the mix launcher
  // runs), and stand-ins for the programs the node finds on PATH
  // (os:find_executable, System.cmd) that are the page's or the
  // launchers' (worker/index.ts command).
  for (const [name, target] of bin) root.put(`usr/bin/${name}`, new Symlink(target));
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
    // coreutils.wasm's, and the site's other WASI programs (coreutils.ts
    // REGISTRY, from the site manifest).
    ...REGISTRY.keys(),
    // The shell's own processes (utilities.ts UTILITIES).
    ...Object.keys(UTILITIES),
    ...(inotifywait ? ['inotifywait'] : []),
  ])
    if (!bin.has(name)) root.put(`usr/bin/${name}`, new File());
  // What git starts by name from its exec path (on PATH when it runs sh):
  // git.wasm as a transport's other end (git-remote.ts GIT_DASHED); its
  // scripts are the site's files there.
  for (const name of ['git-upload-pack', 'git-receive-pack', 'git-upload-archive'])
    root.put(`usr/libexec/git-core/${name}`, new File());
}

// fs: the node's files (vfs.ts); nif(name, version): a package's NIF
// library build (make), or null.
export const programs = (fs: Vfs, nif: NifSource = () => null): Programs => ({
  memsup,
  esbuild,
  tailwind,
  make: make(fs, nif),
});
