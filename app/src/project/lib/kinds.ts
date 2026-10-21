// What a project of each kind starts with. A temporary IEx ('iex') is an
// empty project that is not stored and whose first shell runs IEx.
import type { WorkspaceKind } from '@/shared/lib/projects';

export type { WorkspaceKind };

export interface Setup {
  // The site's boot images to unpack (runtime/build.py).
  boots: string[];
  // The directories below /work the project starts with, from the site.
  template: string[];
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

export function setup(kind: WorkspaceKind): Setup {
  if (kind === 'phoenix') {
    return {
      boots: ['boot', 'boot-phoenix'],
      template: [PHOENIX_APP],
      firstTab: 'Server',
      alwaysPreview: true,
      showFiles: true,
      running: 'Phoenix 1.8 on OTP (WebAssembly), with PGlite',
    };
  }
  return {
    boots: ['boot'],
    template: [],
    firstTab: kind === 'iex' ? 'IEx' : 'Shell',
    alwaysPreview: false,
    showFiles: kind !== 'iex',
    running: 'Elixir 1.20 on OTP (WebAssembly)',
  };
}
