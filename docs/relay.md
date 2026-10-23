---
kind: design
status: prototype
last_updated: 2026-10-23
---

# The TCP relay: a few hosts without CORS, without a tailnet

Without Tailscale, a node reaches HTTPS sites only by the page's
`fetch()` (`https.ts`), which reads only sites that send CORS headers.
GitHub's pages and downloads, GitLab, Codeberg and Anthropic's console
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
`app/test/unit/relay.test.ts`, `app/test/e2e/relay.spec.ts` (with the
backend at `BACKEND`, `http://localhost:4000` by default; skipped
without).

## Which way a connection goes

The HTTPS gateway (`https.ts`) carries a node's `ssl:connect` to a host
name and a Node.js process's `tls.connect`, `https` and `fetch` to port
443. `exec/host.ts`'s `tunnel(host, port)` decides:

1. **The tailnet**, where it takes the connection (Tailscale set up and
   the project allowed: [tailscale.md](tailscale.md)).
2. **The relay**, for a host on its list, on 443, that sends no CORS
   headers (`relayed()`).
3. **`fetch()`** otherwise; also when the relay cannot be reached (a
   local build without a backend).

**The list** is one file, `backend/priv/relay/hosts.json`, which the
backend reads when it compiles and the page imports, so the page picks
a way without opening the socket:

| Hosts | Way |
| --- | --- |
| `github.com`, `*.github.com`, `*.githubusercontent.com`, `gitlab.com`, `codeberg.org`, `pushin.eu`, `platform.anthropic.com` | The relay. |
| `api.github.com`, `raw.githubusercontent.com`, `api.anthropic.com` (its `fetch` list) | `fetch()`, from the user's own address: they send CORS headers (Anthropic's with `anthropic-dangerous-direct-browser-access`, which the gateway adds), so they spare the relay's bandwidth. The relay allows them too. |

No setup hint for a relayed host, and no consent asked: nothing a
`fetch()` could not reach but for CORS. Not `gen_tcp` to an address, nor
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
- **git over the relay** (git.wasm would need TLS of its own); `/git/`
  serves clones and fetches.
