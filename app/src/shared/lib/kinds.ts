// What the IDE shows for a project of each kind (the kinds are the
// runtime's: @elixir-playground/runtime/kinds).
import type { WorkspaceKind } from '@elixir-playground/runtime/kinds';

export interface Setup {
  // The first terminal tab's name.
  firstTab: string;
  // The preview shows from the start (Phoenix), or once a node serves.
  alwaysPreview: boolean;
  // The file tree and the editor show from the start (else just shells).
  showFiles: boolean;
  // The status line once the first shell runs.
  running: string;
}

export function setup(kind: WorkspaceKind): Setup {
  if (kind === 'phoenix') {
    return {
      firstTab: 'Server',
      alwaysPreview: true,
      showFiles: true,
      running: 'Phoenix 1.8 on OTP (WebAssembly), with PGlite',
    };
  }
  return {
    firstTab: kind === 'iex' ? 'IEx' : 'Shell',
    alwaysPreview: false,
    showFiles: kind !== 'iex',
    running: 'Elixir 1.20 on OTP (WebAssembly)',
  };
}
