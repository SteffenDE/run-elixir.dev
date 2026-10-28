// The tailnet as a plugin of the playground's own (not a package anyone
// installs: docs/tailscale.md): the exec frame's tailnet calls, answered by
// this page's Tailscale node as the user lets each project use it
// (client.ts).
import type { ApexPlugin } from '@elixir-playground/api/types';
import { tailnetDial, tailnetResolve } from './client';

export const tailscale: ApexPlugin = {
  name: '@elixir-playground/tailscale',
  apex: () => ({ handlers: { tailnetDial, tailnetResolve } }),
};
