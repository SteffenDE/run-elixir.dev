// The packages' surface: a service a plugin answers on the page for the
// project's nodes (an apex plugin's `services`, on its `ports`): HTTP over
// a connection, answered with the page's fetch (the elixir package's Hex
// cache). Code, not a protocol: a package bundles its own copy.
export { fetcher } from '../fetcher';
export type { Served } from '../host/node';
