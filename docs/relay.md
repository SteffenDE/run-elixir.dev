---
kind: design
status: prototype
last_updated: 2026-10-23
---

# The TCP relay: a few hosts without CORS, without a tailnet

Without Tailscale, a node reaches HTTPS sites only by the page's
`fetch()` (`https.ts`), which reads only sites that send CORS headers.
GitHub's pages and downloads, GitLab, Codeberg and Anthropic's API
send none. For a short list of such hosts, the backend makes the TCP
connection instead, and the node (or Node.js process) does TLS over it
itself, as it does through the tailnet. The backend sees the host, the
port and how many bytes pass, never what they say (unlike the `/git/`
and `/hex/` proxies, where Caddy ends TLS).

Code: `backend/lib/playground/relay.ex`, `relay/` (the list, the
connection, the ClientHello check) and
`backend/lib/playground_web/relay_socket.ex` (the socket);
`app/src/runtime/relay.ts` (the page's side) and `exec/host.ts` (its
place in the gateway). Tests: `backend/test/playground/relay*`,
`backend/test/playground_web/relay_socket_test.exs`,
`app/src/relay/` (the project's choice and its dialog, on the IDE's
page). Tests: `app/test/unit/relay.test.ts`,
`app/test/unit/relay-consent.test.ts`, `app/test/e2e/relay.spec.ts` (with the
backend at `BACKEND`, `http://localhost:4000` by default; skipped
without).

## Which way a connection goes

The HTTPS gateway (`https.ts`) carries a node's `ssl:connect` to a host
name and a Node.js process's `tls.connect`, `https` and `fetch` to port
443. `exec/host.ts`'s `tunnel(host, port)` decides. A host off the relay's
list goes through the tailnet where it takes it, else by `fetch()`, as
before. For a host on it, on 443, that sends no CORS headers
(`relayed()`), the exec frame asks the IDE's page (`relayWay`,
`relay/client.ts`), which runs no project code and keeps each project's
answer:

1. **Tailscale runs with an exit node** (and the project did not refuse
   the tailnet): the tailnet, whose own question
   ([tailscale.md](tailscale.md)) still comes first if the project was
   never asked.
2. **The project allowed the relay:** the relay.
3. **It refused it:** `fetch()`, which the host refuses (502), and no
   question again.
4. **Not asked yet:** the dialog (`RelayDialog`), the connection waiting
   for its answer: *Enable relay*; *Allow Tailscale* (running with an
   exit node, the project having refused it) or *Set up Tailscale* (the
   Tailscale page, in a new tab; nothing kept, the next connection asks
   again); *Don't allow*. Closing it says no.

The answer is the apex's (`playground-relay-projects` in its storage, by
project id; `iex` for the temporary IEx); the project's settings (top
bar, *Network*) turn the relay on or off later. The setup hint
(TailscaleDialog) does not show for a relayed host: the dialog asked.
The exec frame could open `/relay` without asking (its origin may): the
question is the user's say over their project, not a boundary; the list
is that. `fetch()` also when the relay cannot be reached (a local build
without a backend).

**Embedded** ([embed.md](embed.md)), no dialog asks: `create({ relay:
true })` lets the project use the relay, else it is off.

**The list** is one file, `backend/priv/relay/hosts.json`, which the
backend reads when it compiles and the page imports, so the page picks
a way without opening the socket:

| Hosts | Way |
| --- | --- |
| `github.com`, `*.github.com`, `*.githubusercontent.com`, `gitlab.com`, `codeberg.org`, `pushin.eu`, `api.anthropic.com`, `platform.claude.com` | The relay. |
| `api.github.com`, `raw.githubusercontent.com` (its `fetch` list) | `fetch()`, from the user's own address: they send CORS headers on every path, so they spare the relay's bandwidth. The relay allows them too. |

A host goes one way for all its paths: over the relay the TLS is the
page's own, so neither the gateway nor the relay sees a request's path,
and an HTTP client reuses one connection for all of them. So
`api.anthropic.com` takes the relay, every path and every request: its
Messages API sends CORS headers (with
`anthropic-dangerous-direct-browser-access`, which the gateway's
`fetch()` adds), but Claude Code's `/api/claude_code/settings` there
does not, and with a subscription's OAuth token the Messages API too
answers `401 CORS requests are not allowed for this Organization because
of its settings`. Not even a Node.js process's request, whose path its
`https.request` knows, goes by `fetch()` (tried, then dropped,
2026-10-23). Without the relay (no backend), it is `fetch()` as before:
the Messages API with an API key only.

Not `gen_tcp` to an address, nor
names (DNS): those stay the tailnet's. git.wasm's HTTPS helper
(`git-remote.ts`, no TLS of its own) keeps `/git/`.

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

Each connection is a process (`Playground.Relay.Connection`, under
`Playground.Relay.Supervisor`) that watches its socket's. The page's
WebSocket opens with the first connection and closes 30 s after its
last.

**What it lets through.** A connection opens only

- to a listed host (`Playground.Sandbox.Destination.allowed?/2`, as the
  sandbox's list), on port 443;
- at public addresses the relay resolved itself
  (`Destination.resolve/2`): the page names a host, never an address;
- and its bytes go on only once they start with a TLS ClientHello whose
  server name is that host (`Playground.Relay.ClientHello`, within the
  first record, at most 16 KiB). Plain text (`not_tls`) and another name
  (`server_name`) end the connection before a byte reaches the host.
  The server name is what closes domain fronting: several listed hosts
  are on CDNs (Fastly, Cloudflare) that would serve any of their
  customers at the same address. ECH would fail the check (its outer
  name is the CDN's); neither OTP's `ssl` nor `tls.wasm` sends it.

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

**Origins.** Only projects' exec frames open it, each on its own
subdomain of the usercontent domain: `PLAYGROUND_RELAY_ORIGINS`
(comma-separated host names, `*.domain` for its subdomains;
`*.run-elixir-usercontent.org` by default). Unset when developing: any.
The list is the gate, not the frame: a page elsewhere could only reach
the listed hosts, with TLS it does itself.

**Nothing is logged** about who reached which host.

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
