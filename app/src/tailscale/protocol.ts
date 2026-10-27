// What the apex's Tailscale worker (worker.ts) and the pages say to each
// other (docs/tailscale.md): on a port per page of the apex's, and on a
// port per connection through the node (the other end of an outbound
// one is the exec frame's worker, tailnet.ts).

// The tag the node advertises, which the user's policy file lets use exit
// nodes and nothing else (SetupSteps).
export const TAG = 'tag:elixir-playground';
// Its name in the tailnet (Tailscale adds -1, -2, … to a name in use).
export const HOSTNAME = 'elixir-playground';
export const CONTROL_URL = 'https://controlplane.tailscale.com';

export interface ExitNode {
  id: string;
  name: string;
  online: boolean;
}

// The node: 'off' until Tailscale is set up in this browser (its
// WebAssembly is not loaded), 'waiting' while another build's worker runs
// it, 'loading' while it loads; then Tailscale's own state (main.go):
// NoState, NeedsLogin, NeedsMachineAuth, Starting, Running or Stopped.
export interface Status {
  state: string;
  // While it waits for a sign-in: where, and what went wrong last.
  loginURL?: string;
  error?: string;
  // What Tailscale's own clients would warn of (the control server out of
  // reach, a login that failed).
  warnings?: string[];
  controlURL: string;
  // Once running: this device's MagicDNS name, addresses and tags.
  name?: string;
  addresses?: string[];
  tags?: string[];
  tailnet?: string;
  magicDNSSuffix?: string;
  // The exit node in use (its id) and those it may use.
  exitNode?: string;
  exitNodes: ExitNode[];
}

export type Action =
  | { kind: 'start' }
  | { kind: 'login' }
  | { kind: 'logout' }
  | { kind: 'exit-node'; id: string }
  | { kind: 'control-url'; url: string };

// How a connection through the node goes: TCP, or a connected UDP socket
// (each piece of data a datagram).
export type Proto = 'tcp' | 'udp';

// A page to the worker. `hello` first: where the node's WebAssembly is
// (the page's build's runtime); the status follows, and again on each
// change. `dial` brings the connection's port; `dns` is a DNS message for
// Tailscale's resolver; `expose` brings the port that inbound connections
// to the device's `port` come in on (Exposure), `lock` the name of a Web
// Lock the page holds for as long as it shares the port (the worker hears
// of a page gone, a closed tab too, by it), `take` to take the port from
// the project that shares it.
export type Request =
  | { kind: 'hello'; wasm: string; glue: string }
  | { kind: 'act'; id: number; action: Action }
  | { kind: 'dial'; host: string; port: number; proto: Proto }
  | { kind: 'expose'; port: number; lock: string; take?: boolean }
  | { kind: 'dns'; id: number; query: Uint8Array }
  | { kind: 'logs'; id: number };

export type Reply =
  | { kind: 'status'; status: Status }
  | { kind: 'done'; id: number; error?: string }
  | { kind: 'logs'; id: number; lines: string[] }
  | { kind: 'dns'; id: number; answer?: Uint8Array; error?: string };

// On a connection's port: from the worker, { kind: 'open', local } (this
// device's address and port) or { kind: 'error', message } first; then
// both ways { kind: 'data', bytes } and { kind: 'end' } (from the worker
// with `error` if it broke), and { kind: 'close' } from the page. An
// inbound connection's port starts with the page's { kind: 'open' } (it
// took it), or its close.
export type Piece =
  | { kind: 'open'; local?: string }
  | { kind: 'error'; message: string }
  | { kind: 'data'; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'end'; error?: string | null }
  | { kind: 'close' };

// On an exposure's port (the page's that shares a port in the tailnet):
// from the worker { kind: 'exposed' } or { kind: 'error', message } (with
// `free`, a device port no project shares, when another project shares
// this one), then an { kind: 'inbound', remote } with each connection's
// port (Piece), and { kind: 'taken' } when another project took the port;
// from the page { kind: 'unexpose' }.
export type Exposure =
  | { kind: 'exposed' }
  | { kind: 'error'; message: string; free?: number }
  | { kind: 'inbound'; remote: string }
  | { kind: 'taken' }
  | { kind: 'unexpose' };

// The Web Locks a page holds for its shared ports: this, and an id.
export const SHARE_LOCK = 'playground-tailscale-share:';
