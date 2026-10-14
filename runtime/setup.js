// What every playground node gets, in the browser and under node.mjs: its
// environment, the files around the installation, and its programs.
import { File, urandom } from './wasi.js';
import { git, esbuild, tailwind } from './programs.js';

// The node presents itself as Linux x86_64 (crates/rotp/src/host/mod.rs),
// so Hex tool wrappers look for _build/esbuild-linux-x64 and
// _build/tailwind-linux-x64-VSN, which are the programs below.
export const ENV = {
  ROOTDIR: '/rotp', HOME: '/work', LANG: 'C.UTF-8', TERM: 'xterm-256color',
  PATH: '/usr/bin:/rotp/bin', MIX_HOME: '/work/.mix', MIX_ARCHIVES: '/rotp/mix/archives',
  ROTP_OS_TYPE: 'linux', ROTP_SYSTEM_ARCHITECTURE: 'x86_64-pc-linux-gnu',
  // The rebar3 Mix builds rebar3 dependencies with (installed by
  // tools/rotp/mix.exs): an escript, which the page's rebar3 program runs.
  MIX_REBAR3: '/rotp/mix/rebar3',
};

// The node's own tree around the installation (/work and /tmp may be
// shared: files.js).
export function prepare(root) {
  root.mkdirs('work');
  root.mkdirs('tmp');
  root.put('dev/urandom', urandom());
  root.put('rotp/bin/mix', new File(new TextEncoder().encode('Mix.CLI.main()\n')));
  for (const name of ['git', 'esbuild', 'tailwind', 'sh']) root.put(`usr/bin/${name}`, new File());
}

// fs: the node's files (vfs.js).
export const programs = (fs) => ({ git: git(fs), esbuild, tailwind });
