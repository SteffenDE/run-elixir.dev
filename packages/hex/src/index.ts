// The elixir package's Hex cache (docs/api.md, "Hex"): an apex plugin
// that answers Hex for a project's nodes on a port of the project's
// (HEX_PORT), which HEX_MIRROR and HEX_API_URL name, from the page and its
// Cache Storage. The elixir package ships it as hex.js and its index.js
// adds it (create({ plugins: [otp, elixir, …] })); the IDE adds it itself.
import type { ApexPlugin } from '@elixir-playground/api';
import { HEX_PORT, hex as serve, hexEnv } from './hex';

export const HEX_PLUGIN = '@elixir-playground/hex';

export const hex = (): ApexPlugin => ({
  name: HEX_PLUGIN,
  apex: () => ({ services: { hex: serve }, ports: { [HEX_PORT]: 'hex' }, env: hexEnv }),
});
export default hex;
