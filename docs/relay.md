---
kind: design
status: prototype
last_updated: 2026-10-23
---

# The TCP relay

The relay lets project runtimes make HTTPS connections to an allowlist
of hosts without relying on CORS or Tailscale. The backend opens a TCP
connection and forwards encrypted bytes. TLS terminates in the project's
BEAM or Node.js process and at the destination server. The relay sees
connection metadata, but does not decrypt application traffic.

The main implementation is in `backend/lib/playground/relay.ex`,
`backend/lib/playground/relay/` and
`backend/lib/playground_web/relay_socket.ex`. The browser transport is
`packages/runtime/src/relay.ts`; `packages/runtime/src/exec/host.ts` selects the route and
`app/src/relay/client.ts` manages consent on the apex.

## Which way a connection goes

The HTTPS gateway handles BEAM TLS connections and Node.js `tls`,
`https` and `fetch` requests. For a relay-listed host on port 443:

1. If Tailscale has a running exit node and the project has not denied
   access, use Tailscale. Its own consent check still applies.
2. Otherwise, use the relay if the project has allowed it.
3. If the project denied relay access, use the fetch fallback without
   asking again. Requests without CORS support fail.
4. If there is no saved decision, wait for the relay dialog. The user can
   enable the relay, choose Tailscale, or deny access. Opening Tailscale
   setup leaves the decision unset so a later connection asks again.

Consent is stored on the apex in `playground-relay-projects`, keyed by
project ID (`iex` for the temporary IEx). Users can change it in the
project's Network settings. The `/relay` page explains the hosts and
limits. Embedded runtimes use `create({ relay: true })` to opt in and
never show the consent dialog.

Consent controls normal application behavior. It is not a backend access
control: project code could open the relay directly. The backend enforces
the destination allowlist, TLS check and resource limits independently.

`backend/priv/relay/hosts.json` supplies the list to both backend and
frontend:

| Hosts | Default route without Tailscale |
| --- | --- |
| `github.com`, `*.github.com`, `*.githubusercontent.com`, `gitlab.com`, `codeberg.org`, `pushin.eu`, `api.anthropic.com`, `platform.claude.com` | Relay, after consent. |
| `api.github.com`, `raw.githubusercontent.com` | Browser fetch. These hosts are also permitted by the relay. |

Routing is per host, not per HTTP path. The relay cannot see paths inside
TLS, and clients may reuse a connection for several requests. In
particular, `api.anthropic.com` uses the relay for all paths: some
endpoints lack CORS support, and subscription OAuth requests can be
rejected by the browser-facing API even when API-key requests work.
Without a backend relay, fetch remains the fallback and is subject to
those restrictions.

The relay does not provide DNS or arbitrary `gen_tcp` access. Those need
Tailscale. Git's WebAssembly HTTPS helper has no TLS implementation and
continues to use `/git/` for cloning and fetching.

Tests cover the backend relay and socket, browser transport, consent and
end-to-end connections. See `backend/test/playground/relay*`,
`backend/test/playground_web/relay_socket_test.exs`,
`packages/runtime/test/unit/relay*.test.ts`, `app/test/unit/relay-consent.test.ts` and `app/test/e2e/relay.spec.ts`.
The browser integration tests require the backend at `BACKEND`
(default `http://localhost:4000`) and skip if it is unavailable.

## The socket

`/relay` (`PlaygroundWeb.RelaySocket`, a `Phoenix.Socket.Transport`, not
a channel) carries many connections over one WebSocket. Each binary
frame is a kind, a connection id the page picks (32 bits) and the
kind's payload:

| Page → relay | Relay → page |
| --- | --- |
| 1 `OPEN` port::16, host | 2 `OPENED` |
| 4 `DATA` bytes | 3 `ERROR` reason (the id is gone) |
| 5 `END` (the page sends no more) | 4 `DATA` bytes |
| 6 `CLOSE` (the id is gone) | 5 `END` (the host closed; the id is gone) |
| 7 `ACK` n::32 (bytes read) | 7 `ACK` n::32 (bytes passed on) |

Each connection runs in a `Playground.Relay.Connection` process under
`Playground.Relay.Supervisor` and monitors its WebSocket process. The
browser opens the WebSocket for the first connection and closes it
30 seconds after the last connection ends.

**What it lets through.** A connection opens only

- to a listed host (`Playground.Sandbox.Destination.allowed?/2`, as the
  sandbox's list), on port 443;
- at public addresses the relay resolved itself
  (`Destination.resolve/2`): the page names a host, never an address;
- and its bytes go on only once they start with a TLS ClientHello whose
  server name is that host (`Playground.Relay.ClientHello`, within the
  first record, at most 16 KiB). Plain text (`not_tls`) and another name
  (`server_name`) end the connection before a byte reaches the host.
  Matching SNI prevents the client from selecting an unrelated TLS host
  at a shared CDN address. It does not inspect encrypted HTTP headers.
  An ECH outer name that differs from the requested host fails this
  check; neither OTP's `ssl` nor `tls.wasm` currently sends ECH.

**Limits** (`config :playground, Playground.Relay`, the moduledoc):

| Limit | Default |
| --- | --- |
| Bytes either side may send unacknowledged (`window`); a page that sends more loses the connection | 256 KiB |
| Bytes one frame carries (`max_payload`); more ends the socket | 64 KiB (the page sends 64 KiB frames) |
| Bytes one connection carries, both ways (`max_bytes`) | 1 GiB |
| Connections open over one socket (`max_connections`) | 16 |
| Connections open over all sockets (`max_total`) | 512 |
| Connecting to the host (`connect_timeout`) | 10 s |
| A connection without bytes either way (`idle_timeout`) | 5 min |

The host's bytes are read while the page has acknowledged all but a
window of them. The page acknowledges what it hands on, so a slow node
holds the relay back, not the backend's memory.

**Origins.** Production uses `PLAYGROUND_RELAY_ORIGINS` to allow the
usercontent frames that open the socket. It accepts comma-separated
host names and `*.domain` patterns; the default is
`*.run-elixir-usercontent.org`. Development accepts any origin when the
setting is unset. Origin checks are additional browser restrictions;
the destination allowlist and TLS checks apply to every client.

The relay implementation does not log client-to-destination activity.
Reverse-proxy and deployment logging are configured separately.

## Not built yet

- **Bytes per client address** (an hour's or a day's budget). Behind
  Cloudflare and Caddy the backend sees neither's client address without
  trusting their headers; the limits above are per socket and
  connection.
- **Counts** of connections and bytes for the admin.
- **A Node.js process's `net.connect` to a listed host**, and a node's
  `gen_tcp`: they resolve the name first, which needs the tailnet's DNS.
- **A Node.js process's request to `api.anthropic.com` through the
  relay** gets its answer, but the process did not exit in a browser
  test (`node -e "fetch(…/api/claude_code/settings)…"`, 2026-10-23): a
  connection apparently kept open; a node's `:httpc` there finishes.
- **git over the relay** (git.wasm would need TLS of its own); `/git/`
  serves clones and fetches.
