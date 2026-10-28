---
kind: design
status: prototype
last_updated: 2026-10-23
---

# Tailscale: the node's network through the user's tailnet

Tailscale connects the browser to the user's tailnet as one shared
device. Authorized projects can use it for HTTPS, TCP, UDP, and DNS.
An exit node provides internet access; tailnet services remain subject
to the device's access policy. Projects can also expose server ports to
other tailnet devices.

Without Tailscale, HTTPS uses browser fetch where CORS permits it, or the
restricted [TCP relay](relay.md) for allowed hosts. General outbound TCP,
UDP, and DNS require Tailscale.

Implementation: `tailscale/` builds the client, `app/src/tailscale/`
hosts the device and permissions, and `app/src/runtime/https.ts` and
`dns.ts` route project requests. Browser coverage is in
`tailscale.spec.ts` and `sockets.spec.ts`.

## What it does (built, a prototype)

- **One device per browser, `elixir-playground`, tagged
  `tag:elixir-playground`.** The user signs in once, on the apex's
  `/tailscale` page; every project in the browser uses that one device. Key expiry is disabled by default for tagged devices.
- **The recommended policy limits access to exit nodes.** The setup asks the user to add the
  tag to the tailnet's policy, allowed `autogroup:internet` only (below):
  the device can use exit nodes, and reach none of the tailnet's devices.
- **Each project asks first.** The first time a project's code reaches
  for the tailnet, a dialog asks whether it may (`ConsentDialog`: what it
  reaches, through which exit node), its request waiting for the answer.
  The apex keeps the answer per project (its id); the Tailscale menu
  and the `/tailscale` page change it. The IDE's page refuses a project
  that may not, whatever its page asks.
- **Live sessions keep it,** unless the host says otherwise: a guest with
  the terminals or the files runs code in the host's project, and the
  host's panel offers *No tailnet for this project while a guest may type
  or edit* (off by default, kept with the session across a reload; shown
  once Tailscale is set up).
- **A project's node** reaches through the tailnet once the device runs and
  has an exit node, or the host is a tailnet name or address:
  - **HTTPS** (`ssl:connect` to a host name, patch 0020's gateway): a TCP
    connection to the host, over which the node does TLS itself, with the
    options it was given (its CA certificates, `verify_none`, a client
    certificate, ALPN and HTTP/2); else by `fetch()` as before, which
    for `api.anthropic.com` adds `anthropic-dangerous-direct-browser-access:
    true` (its CORS lets a browser in then; `https.ts` BROWSER_HEADERS).
  - **Its sockets:** `gen_tcp` to another host (a database in the tailnet,
    plain HTTP, SMTP, Erlang distribution to a node of the user's),
    `gen_udp` (`inet_res` to a nameserver of its own, statsd, …), and
    names (`inet:gethostbyname`, and everything that connects by name),
    short MagicDNS names (`my-laptop`) too. A connected socket's own
    address is the device's tailnet address.
  - Without Tailscale, another host is `enetunreach` and a name `nxdomain`,
    at once.
  - A Node.js process's `net`, `dns`,
    `dgram` and HTTPS go the same ways, its TLS its own (rustls in
    WebAssembly, [nodejs.md](nodejs.md#tls-tls-tlsts)).
- **Its servers in the tailnet:** the Tailscale menu shares a port a
  project's server listens on, at the device's own port
  (`http://elixir-playground.TAILNET.ts.net:4000/`), for the tailnet's
  devices the policy lets reach the tag; until the menu stops it, or the
  page goes.
- **The setup hint, once.** Without Tailscale set up, the first request
  `fetch()` cannot make, or the first name, connection or datagram to
  another host, opens a dialog (`TailscaleDialog`): why it can't be
  reached, the three setup steps, *Set up Tailscale* and *Not now*.
  However it closes, it does not show again in this browser (the apex's
  `localStorage`, `playground-tailscale-hint`).
- **The top bar's Tailscale button:** on the projects' list, a link to
  `/tailscale`; on a project's page (and the temporary IEx's), a menu: the
  device's state, whether the project may use the tailnet, its servers'
  ports to share, and `/tailscale`. Its dot: green, connected through an
  exit node; amber, needs something.
- **`/tailscale` on the apex**: the device (state, name, addresses, tags,
  the exit node to use), *Sign in with Tailscale* and *Sign out*, which
  projects may use it, the setup steps, and another control server
  (Headscale), while signed out.

## Setting it up (what the user does)

1. **The policy.** In the admin console's Access controls, add to the
   policy file's `tagOwners` and `grants`:

   ```json
   "tagOwners": {
     "tag:elixir-playground": ["autogroup:member"]
   },
   "grants": [
     {
       "src": ["tag:elixir-playground"],
       "dst": ["autogroup:internet"],
       "ip":  ["*"]
     }
   ]
   ```

   Any member may then sign the playground in as the tag; the tag may use
   exit nodes (`autogroup:internet` is the internet through an exit node,
   not the tailnet's devices). A rule with `"src": ["*"]`, as the default
   policy's allow-all one, covers tagged devices too: its source becomes
   `autogroup:member`. In `acls` syntax: `{ "action": "accept", "src":
   ["tag:elixir-playground"], "dst": ["autogroup:internet:*"] }`.
   Without the tag in `tagOwners`, signing in fails with Tailscale's
   *requested tags [tag:elixir-playground] are invalid or not permitted*,
   which the page explains. To reach a device of the tailnet (a database,
   an Erlang node) the tag needs a grant to it; to reach a project's
   shared server, the user's devices need one to the tag: `{ "src":
   ["autogroup:member"], "dst": ["tag:elixir-playground"], "ip":
   ["tcp:4000"] }` (the menu shows it).
2. **An exit node:** `tailscale set --advertise-exit-node` on a machine of
   the user's, allowed in the admin console, or Mullvad's.
3. **Signing in** on `/tailscale`, and picking the exit node.

## How it works

### The node (`tailscale/`)

`main.go` is Tailscale's client as its own `cmd/tsconnect` builds it for
the browser (`tsd.System`, a userspace `wgengine`, gVisor's netstack,
`ipnlocal.LocalBackend`), against tailscale.com v1.104.1, built for
`js/wasm` with Go 1.27 in Docker (`build.py`, the image pinned by digest),
leaving out what a browser device does not use (`ts_omit_ssh`, taildrop,
Taildrive, the port mapper, …). 29.3 MB, about 6.8 MB gzipped; it loads
only once Tailscale is set up or the user signs in. Go's `wasm_exec.js` is
kept in `tailscale/` as the image's Go has it (the app bundles it);
`build.py` stops if a new image's differs. It offers JavaScript
`globalThis.playgroundTailscale`:

- `start`, `login`, `logout`, `setExitNode`, `setControlURL`; `notify`
  gets its status as JSON: the backend's state, a login URL or error,
  Tailscale's health warnings, the device, and the exit nodes it may use.
- `dial(host, port, proto, ondata, onend)`, TCP or a connected UDP socket
  (each write and each `ondata` a datagram), through
  `tsdial.Dialer.UserDial`: MagicDNS names from the netmap, other names
  through the exit node's DNS over its peer API. The handle's `local` is
  the device's end (`sockname`).
- `dnsQuery(bytes)`: a DNS message, answered by the DNS manager's `Query`,
  as 100.100.100.100 answers (MagicDNS names, the rest through the exit
  node's DNS or the tailnet's resolvers). A one-label name is asked as
  the tailnet's (`NAME.SUFFIX.`) and answered under the name it asked, as
  a system's search domain makes it. The device has `CorpDNS` on for it
  (a browser has no system DNS it would change).
- `listen(port, onconnection)` and `unlisten(port)`: the tailnet's
  connections to the device on that port (netstack's
  `GetTCPHandlerForFlow`; the device's own packet filter, from the
  policy, decides who gets there).

A browser sends no UDP, so the device has no direct paths: its WireGuard
packets go through Tailscale's DERP relays, over WebSocket, as do its
control connection (`ts2021` over WebSocket). Tailscale's control and DERP
servers accept WebSockets from any origin, and its control server sends
CORS headers on `/key` (the server's key, a plain `fetch()` before the
WebSocket), which the browser needs. **Headscale does not:** a Headscale
for the playground needs `Access-Control-Allow-Origin: *` on `/key` from
its reverse proxy (the test's Caddy, below), and its `tagOwners` take
users (`alice@`), not `autogroup:member`.

### Where it runs: the apex, never the usercontent domain

The device's keys are a credential, and a project's code must not reach
them ([git.md](git.md#what-a-projects-code-can-reach): *project pages hold
capabilities, not credentials*). So the node runs on the apex, which runs
no project's code: that runs in the exec frame, on the usercontent
domain ([frames.md](frames.md)).

- **A shared worker on the apex** (`app/src/tailscale/worker.ts`, built
  as the runtime package's `tailscale.js`): one node for every page of the apex that
  connects. It keeps the node's state (`state`: main.go's keys) and its
  settings (`settings`: the control server, whether it is set up) in the
  apex's IndexedDB, `playground-tailscale`. Two builds' pages make two
  workers (a shared worker is its script's URL); a Web Lock
  (`playground-tailscale`) lets one run the node, the other says so.
  Its last 1000 log lines: `window.tailscale.logs()` on an apex page.
  A shared worker ends with its last page, so the tab moves between the
  apex's pages in place ([projects.md](projects.md)): going from a project
  to `/tailscale` or another project keeps the node running.
- **The IDE's page** (`client.ts`), on the apex, reaches the worker
  directly, as the projects' list and `/tailscale` do. It follows the
  node's status, keeps the hint's dismissal and which projects may
  (`playground-tailscale-projects` in the apex's `localStorage`, by
  project id, `iex` for the temporary IEx; a `storage` event brings
  another tab's change), and answers what the project's exec frame asks
  over its port (`rpc.ts`): `tailnetDial(host, port, proto, conn)` and
  `tailnetResolve(query)`, checked here (the frame runs the project's
  code, so nothing it says is taken on trust); and `blocked`, which may
  show the hint. A dial the page lets through hands the connection's port
  (`conn`) to the worker, so its bytes go between the exec frame's worker
  and the Tailscale worker, not through the page. Signing in and out, the
  exit node and the control server are `/tailscale`'s only.
- **The exec frame's worker** (`tailnet.ts`, in `exec/host.ts`): the
  node's HTTPS tunnels, outbound TCP, UDP and DNS, each asked of the
  IDE's page as above.
- **Not offered** on a live session's guest's page, which runs no
  project (the host's runs it).
- **Signing in** on the apex's top-level page: *Sign in with Tailscale*
  opens a tab on the click, which goes to the control server's sign-in
  page when its URL comes (a tab opened later would be blocked).

### The node's sockets (`beam/socket`, `net.ts`)

([runtime.md](runtime.md#tcp-and-udp-netts),
[../beam/README.md](../beam/README.md#the-network-socket)):

- **A connect to another host's address** goes to the page
  (`remote.dial`), and `connect` answers `select` until the page says how
  dialing went (a `CONNECTED` frame, with the device's end once it is
  there): `ok`, or `econnrefused`, `enetunreach`, `ehostunreach`,
  `etimedout`, as a system's would.
- **Datagram sockets:** UDP ports of the node's network; datagrams between
  them, to the page's UDP ports (53), to the project's other nodes' ports
  (the page hands them on, as it does TCP between them), and through the
  page to other hosts (`DATAGRAM` frames back); connected sockets keep
  their peer's.
- **Names:** the node's `/etc/resolv.conf` names 127.0.0.53 and its
  `inetrc` looks names up in the hosts file, then DNS. The page answers
  port 53 (UDP and TCP, `dns.ts`) with the device's `dnsQuery`, or, without
  Tailscale, NXDOMAIN, so a name fails at once as before.

The exec frame (`tailscale/tailnet.ts`): `outbound` dials a TCP
connection through the tailnet and pipes it; `udp` keeps, per node,
one connected UDP socket through the tailnet per port of the node's and
address it sends to (closed two minutes after its last datagram, or with
the node's port); `resolve` asks the IDE's page, which asks the device's
resolver. The IDE's page (`tailscale/client.ts`) lets each take the
tailnet when the device runs, has an exit node
or the address is the tailnet's (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`),
the host has not kept it off for a live session's guests who may type or
edit (`offForGuests`, the live session's `tailnetOff`), and the project
may (asked once, its request waiting); else refuses, drops, or answers
NXDOMAIN, and shows the setup hint.

### The node's HTTPS (`https.ts`, patch 0020)

`ssl:connect` to a host name connects to the gateway port of the node's
network, names the host and port in a first line, and waits for the
page's: `fetch` (plain HTTP, answered by `fetch()`, as before), `tcp` (a
TCP connection to the host through the tailnet, over which `ssl:connect`
upgrades the socket with the options it was given, the host's name as SNI
and for the certificate's check unless they name one), or `error REASON`
(`etimedout`, …). `httpsByFetch({ tunnel, onblocked })`: `tunnel(host,
port)` in `exec/host.ts` chooses the tailnet or restricted relay, or
returns null for fetch. The IDE supplies the project's permission decision. `onblocked(url)` (the IDE's page's
`tailscaleBlocked`) hears of each `fetch()` that failed,
and shows the hint while Tailscale is not set up and the hint was not
dismissed.

Not *fetch() first, the tailnet if it fails*: a failed `fetch()` does not
mean nothing was sent (a simple POST reaches the server, only its answer
is withheld), and it cannot tell CORS from the network. Once set up, the
tailnet takes every HTTPS request that it can route.

### Shared ports

The menu's *Share* opens an exposure (`share(port)`): the IDE's page
takes a Web Lock of its own for it (`playground-tailscale-share:ID`) and
hands a port to the worker, which listens on the device (`listen`, one
listener a port) and sends each inbound connection's port to that page,
which connects it to the server on the port (`connectServer`, carried to
the exec frame) and answers `open` (or closes it when none listens).

The browser is one device, so a device port is one project's:

- **Another project shares it:** the worker says so, with the next
  device port no project shares; the menu offers *Share as port 4001*
  (the project's 4000 at the device's 4001, `http://DEVICE:4001/`) and
  *Share here instead*, which takes the port: the other project's menu
  says another project shares it now.
- **The page goes** (it stops sharing, leaves the project, its tab
  closes or crashes): the browser lets its lock go, the worker's own
  request for it is granted, and the port is free at once.

## Testing

`tailscale.spec.ts` (Chromium):

- **The hint, once:** an empty project's `httpc` to www.example.com gets
  502 and the dialog with the policy; after *Not now*, neither that
  project nor a new one shows it again; `/tailscale` shows the steps.
- **Through a tailnet** (skipped without `HEADSCALE_URL`,
  `HEADSCALE_API_KEY`, `HEADSCALE_USER`): `/tailscale` with the Headscale
  as control server, signing in (the test registers the device through
  Headscale's API, as an admin would), the tag, the exit node; then in a
  project, which asks and is allowed:
  - `httpc` gets www.example.com's page (200), the node's own TLS;
  - the node resolves www.example.com (the exit node's DNS), the exit
    node's MagicDNS name and its short name, sends HTTP/1.0 over
    `gen_tcp` (200; its `sockname` the device's 100.x address), a DNS query
    over UDP to 1.1.1.1 itself (answered), and `ssl:connect` with its own
    options (TLS 1.x, ALPN);
  - Erlang distribution to `probe@exit-box.tailnet.test`, a node on the
    exit node's machine (`erpc` returns its OTP release);
  - a server on port 4000 in a second shell, shared from the menu,
    answers exit-box through the tailnet;
  - two projects' servers on port 4000 (`two projects share…`): the
    second shares at the device's 4001, then takes 4000 (the first's menu
    says so); its tab closed, a third project shares 4000 at once;
  - the exit node's own HTTPS port does not answer (the policy keeps the
    tag off the tailnet's devices but those it grants; `etimedout`);
  - a second project, refused, gets `enetunreach`; `/tailscale` lists
    both.
- **A live session** (with the backend's relay; skipped without it): a
  guest with the terminals in, the project keeps the tailnet; with the
  host's *No tailnet … while a guest may type or edit*, it does not (and
  the menu says why); once the guest has gone, it does again.

`sockets.spec.ts` (no tailnet): UDP between a node's own ports (passive,
active, connected) and between two shells' nodes; and, without
Tailscale, `enetunreach` and `nxdomain` at once.

The tailnet for it, in Docker on the host's network
(`tests/headscale.sh`): Headscale 0.29.5 on `localhost:8090` with
Tailscale's DERP map and the setup's policy (`tagOwners` `alice@` for both
tags, the grant, `autoApprovers` for `tag:exit`'s exit routes; and the
test's: exit-box to the tag's ports 4000-4001, the tag to exit-box's 4369 and
9100), Caddy on `:8091` adding the CORS header to `/key`,
`tailscale/tailscale` 1.104.1 as `exit-box` (`TS_USERSPACE=true`, a
pre-auth key with `--tags tag:exit`, `--advertise-exit-node`), an Erlang
28 node on the host's network (exit-box forwards its tailnet address's
ports there), and a probe on `:8093` that has exit-box `tailscale nc`
into the tailnet. `start` prints the test's environment:

```sh
env $(tests/headscale.sh start) tests/run.sh --project=chromium tailscale
tests/headscale.sh stop
```

All pass (2026-10-19; the tailnet test about 55 s, 30 of them the
refused dial).

## Not built yet

- **Inbound UDP**, and datagrams from a host the node did not send to
  first.
- **`ssl:connect` to an address** (not a name) through the tailnet: no SNI,
  so the certificate's check needs the caller's own options.
- **An inbound connection's bytes cross the main thread** (Tailscale
  worker → the IDE's page → the exec frame's worker → the node's);
  outbound ones go between the workers.
- **The gates apply when a connection opens:** connections already open
  stay open when the project's answer turns to no, or a guest who may
  type comes in while the host keeps the tailnet off.
- **Per-project ephemeral devices** would need a reusable, ephemeral,
  tagged auth key the user pastes once (a bearer secret kept in the
  browser): interactive sign-in approves one device, and minting keys
  from an OAuth client needs `api.tailscale.com`, which sends no CORS
  headers. Not planned; one shared device does the job.
- **No gate job** builds it; `runtime/build.py` needs
  `python3 -I tailscale/build.py` first, as brush and coreutils.
- **Not tried against Tailscale's own control server** (only Headscale):
  signing in, the tag's error text, and exit nodes there.

## Without a tailnet: the site's relay

For a few hosts that send no CORS headers (GitHub's pages and downloads,
GitLab, Codeberg, Anthropic's API), the gateway's `tcp` line comes
from the backend's TCP relay when the tailnet does not take the
connection: [relay.md](relay.md).
