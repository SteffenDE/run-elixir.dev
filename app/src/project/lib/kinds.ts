// What a project of each kind starts with. A temporary IEx ('iex') is an
// empty project that is not stored and whose first shell runs IEx.
import type { WorkspaceKind } from '@/shared/lib/projects';

export type { WorkspaceKind };

export interface Setup {
  // The site's boot images to unpack (runtime/build.py).
  boots: string[];
  // The directories below /work the project starts with, from the site.
  template: string[];
  // Where shells start, and what the first one runs.
  cwd: string;
  first: string[];
  // The first terminal tab's name.
  firstTab: string;
  // The preview shows from the start (Phoenix), or once a node serves.
  alwaysPreview: boolean;
  // The file tree and the editor show from the start (else just shells).
  showFiles: boolean;
  // The status line once the first shell runs.
  running: string;
}

export const PHOENIX_APP = '/work/playground';
const SERVER = 'iex -S mix phx.server';

export function setup(kind: WorkspaceKind): Setup {
  if (kind === 'phoenix') {
    return {
      boots: ['boot', 'boot-phoenix'],
      template: [PHOENIX_APP],
      cwd: PHOENIX_APP,
      first: [`cd ${PHOENIX_APP}`, SERVER],
      firstTab: 'Server',
      alwaysPreview: true,
      showFiles: true,
      running: 'Phoenix 1.8 on Rust-OTP (WebAssembly), with PGlite',
    };
  }
  return {
    boots: ['boot'],
    template: [],
    cwd: '/work',
    first: kind === 'iex' ? ['iex'] : [],
    firstTab: kind === 'iex' ? 'IEx' : 'Shell',
    alwaysPreview: false,
    showFiles: kind !== 'iex',
    running: 'Elixir 1.20 on Rust-OTP (WebAssembly)',
  };
}

// The Phoenix server's command line, for "Restart server".
export const serverCommand = (cwd: string) => `cd ${cwd}\n${SERVER}\n`;
