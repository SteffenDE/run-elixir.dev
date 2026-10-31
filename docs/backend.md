---
kind: reference
status: live
last_updated: 2026-10-29
---

# The backend (`backend`)

The Phoenix backend provides three services for the static frontend:
WebAssembly NIF builds, encrypted live-session messaging, and a restricted
TCP relay. Project applications still run in the browser.

The deployment examples use `run-elixir.steffend.me` for administration.
The apex proxies `/socket` for live sessions, `/api/v1/nif/` for builds and
`/relay` for the TCP relay. The usercontent domain proxies none of them
(since 2026-10-29): the apex's worker makes the requests
([frames.md](frames.md#the-exec-frame)). See [deploy.md](deploy.md) for
routing.

## Service origins

The services a page's browser uses (NIF builds and the TCP relay) answer
the origins on an allowlist, `PlaygroundWeb.ServiceOrigins` (implemented
2026-10-29):

- `config :playground, :service_origins`, from `PLAYGROUND_SERVICE_ORIGINS`
  (space- or comma-separated exact origins). The default is
  `https://run-elixir.dev https://tidewave.ai https://tidewave.steffend.me`.
  The backend does not start when an entry is not an origin, such as a
  host without its scheme. Unset (developing), any origin is let.
- **NIF builds** refuse another page's request with 403 before any work
  (`ServiceOrigins.require_allowed`, since 2026-10-30): an `Origin` not on
  the list, or no `Origin` with `Sec-Fetch-Site: cross-site` (another
  site's `<img>` or `<script>`). Until then the build ran and only the
  CORS headers were left out. An allowed origin's answer carries
  `Access-Control-Allow-Origin` set to that origin and `Vary: Origin`.
  The library archive (`library.tar`) carries `*` instead: it is cached
  as immutable, and a CDN that ignores `Vary` would otherwise give every
  page the first asker's origin.
- **A request without an `Origin`** that is not marked cross-site goes on
  as before: a non-browser client, or the apex's own same-origin GET
  through the proxy. A non-browser client can send any `Origin` it likes,
  so refusing it would protect nothing.
- **The relay's socket** takes an allowed origin
  (`PlaygroundWeb.RelaySocket.origin_allowed?`), and Phoenix refuses
  another with 403. A browser always sends a WebSocket's `Origin`; a
  client without one connects, as before. Never list an origin of the
  usercontent domain, since any site's code runs there. The default list
  has none, but the backend does not check this
  ([frames.md](frames.md#bridge-mode)). `PLAYGROUND_RELAY_ORIGINS`, which
  let exec frames there open the socket themselves before 2026-10-29, was
  removed on 2026-10-30.
- **git's proxy** is Caddy's, not the backend's. Caddy asks the backend
  first (`forward_auth` to `GET /api/v1/origin`: 204, or 403 by the same
  rule), so the same list decides ([deploy.md](deploy.md#caddy), not run
  against a live Caddy). `/hex/` is the apex's alone and needs no list.

The list is in one place, `PLAYGROUND_SERVICE_ORIGINS`. `serve.py`, which
stands in for Caddy and the backend locally, applies the same rule to the
apex and the origins `--embedders` names
([deploy.md](deploy.md#caddy), "Which layer enforces what"). Tested on 2026-10-30:
`service_origins_test.exs` (an allowed origin, another one refused with
403 before a build is queued, no origin, the relay socket with each) and
`bridge-guard.spec.ts` against `serve.py`.

**Getting on the list.** A site asks run-elixir.dev's operators to add its
origin to `PLAYGROUND_SERVICE_ORIGINS`. An origin is a browser's claim,
not an authentication: it keeps other sites' pages from using the
services through their visitors' browsers, not other clients. A site that
is not listed can run its own backend, or reverse proxy one, and name it
in `create({ services })`.

**`http://localhost:4000` is not on production's list.** A local
Tidewave runs projects on the shared usercontent domain like any page,
but run-elixir.dev's services stay for the listed sites. Any program a
visitor runs on that port would otherwise use the relay (an outbound TCP
proxy) and the NIF builds through their browser. To develop an embedder
locally with the services:

1. Run this backend: `PORT=4001 mix phx.server` in `backend/`. In
   development `:service_origins` is unset, so it answers any origin.
2. Run `python3 -I runtime/serve.py 8081 --embedders
   http://localhost:4000 --api http://localhost:4001`, for git's and
   Hex's proxies and the relay with the backend's sockets.
3. Pass `services: 'http://localhost:8081'` to `create()`.

Without step 3 the page uses run-elixir.dev's services, which refuse
`http://localhost:4000` (403).

## Building a NIF library

```
GET /api/v1/nif/PACKAGE/VERSION?abi=ABI      → 202 {status} | 200 {url, sha256, app} | 422 {error} | 404
                                               | 409 {error}: another NIF ABI | 400: no abi
GET /api/v1/nif/PACKAGE/VERSION/library.tar  → the app's priv files (ustar)
```

`abi` is the NIF ABI the page's OTP loads ([nif.md](nif.md#the-nif-abi)),
from the site manifest. The backend builds for one NIF ABI, its root
disk's (`manifest.json`'s `nif_abi`, from the image's `/nif/abi`), and
answers a request for another with 409, never with a library the page
can't load.

The first request for a Hex release queues its build (`Playground.Nif`);
the playground's `make` asks again while it is `queued`, `running` or
`setting_up`, and the page shows the status ([nif.md](nif.md#in-the-node)). The
archive is the app's `priv` files ([nif.md](nif.md#the-toolchain-backendnif)),
`priv/NAME.so` holding WebAssembly, for `make` to unpack into the app's
directory. Responses carry
`Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy:
cross-origin`, so a page served elsewhere (a local build) can use them too.

Builds are kept per **toolchain**, a digest of the erl_nif layer, its
headers, nifcc and wasi-sdk in the sandbox's root disk
(`priv/sandbox/manifest.json`): a new layer builds every version anew when
it is next requested.

### Templates

A build runs the newest **template** for its package whose `requirement`
meets the version (none: every version). A template's recipe
(`Playground.Nif.Recipe`) is:

- `script`: run with `sh -eu` in the unpacked sources, with
  elixir_make's environment for the layer (`Playground.Nif.Runner`:
  `CC=/tools/nifcc`, `ERTS_INCLUDE_DIR=/nif/include`, `MIX_APP_PATH=$APP`,
  …), plus `SRC`, `APP`, `PKG_NAME`, `PKG_VERSION`. Its output goes to the
  log. A build that needs its dependencies' sources runs `mix deps.get`.
- `allowed_hosts`: what the build may connect to, from the backend's list
  (`repo.hex.pm`, `builds.hex.pm`, GitHub's hosts, GitLab, Codeberg).
  None: the VM has no network.
- `timeout_minutes`: 1 to 30, 10 by default.

What the build leaves in `$APP/priv` must be regular files with at least
one `.so`, every `.so` WebAssembly; the archive is written anew from them.
The seed templates (`priv/repo/seeds.exs`, added on every start when
missing) are four recipes known to build, lazy_html's in
`priv/nif/recipes/lazy_html.sh`.

### The agent

A build without a template, or whose template fails, goes to the agent
(`Playground.Nif.Agent`, `Playground.Nif.SetupWorker`): a model (OpenAI's,
through ReqLLM; `openai:gpt-6-luna` by default) reads the package's files,
tries recipes in VMs (`try_build`, answered with the end of the log) and
saves the last one that built as a template, for later versions too, or
gives up (`unsupported` when there is nothing to build, such as a Rustler
package). Given a template that failed, it starts from that recipe and its
log.

Limits: a session runs once (no retries), at most 40 tool calls, 12
builds and $2; all sessions at most $20 a day (`NIF_DAILY_BUDGET_USD`).
A package without a template gets a session only with 10,000 downloads,
unless an admin asked for the build (`POST /api/admin/builds` or a retry).
Every session's conversation is kept (`/api/admin/setups/ID`).

The package's files are untrusted: the model is told so, recipes can only
reach the backend's hosts, and only VMs run them.

### Notifications

A failed build, a package found unsupported and every template the agent
writes are notified (Web Push, to the browsers subscribed at `/admin`), so
a person reviews what the agent wrote.

## Live sessions' relay

`/socket` (`PlaygroundWeb.LiveSocket`, WebSocket only) has one channel,
`live:ID` (`PlaygroundWeb.LiveChannel`): a live session's host and guests
pass each other binary messages the browsers encrypted, which the relay
cannot read. `Playground.Live` keeps sessions: a process each
(`Playground.Live.Session`, under `Playground.Live.Supervisor`), started
by the host's first join, which answers a token to rejoin with after a
reload; the participants' channels are registered under the session and
their id (`Playground.Live.Registry`). The admitted ones subscribe to the
session's room for broadcasts; one-to-one messages find their target in
the registry. A session ends when the host ends it, 30 s after its host
left, or after 24 hours. Nothing is stored.

What each message and command does, the limits and what the relay sees:
[collaboration.md](collaboration.md#the-relay). The limits are
`config :playground, Playground.Live`. In production, only the site's
origins may open the socket: `PLAYGROUND_ORIGINS` (comma-separated, as
`check_origin` takes them; `//run-elixir.dev` by default: every page is
the apex's, and no page of the usercontent domain opens it).

## The TCP relay

`/relay` (`PlaygroundWeb.RelaySocket`) carries projects' TLS connections
to a few listed hosts on port 443, for pages without a tailnet; each
connection a process (`Playground.Relay.Connection`). Its list
(`priv/relay/hosts.json`), frames, checks and limits:
[relay.md](relay.md). The limits are `config :playground,
Playground.Relay`; only the service origins may open it
([above](#service-origins)): the apex's worker opens it.

## The sandbox

`Playground.Sandbox` runs one job per Firecracker VM: a Linux 6.18 kernel
and a read-only ext4 root disk built as stages of the backend's
`Dockerfile` (`mix sandbox.setup` → `priv/sandbox` when developing;
`sandbox/build DIR` for a deployment). The guest is the hexpm/elixir Debian image with wasi-sdk 33
and the layer from the Dockerfile's `nif-toolchain` stage (`/nif`,
`/tools/nifcc`; [nif.md](nif.md#the-toolchain-backendnif)), and build
tools (make, CMake, Ninja, autotools, git, curl, Python). Jobs run as an
unprivileged user in a tmpfs `/workspace`; the workspace archive comes in
over vsock, stdout and stderr go out (at most 64 MiB each).

With `allowed_hosts`, the guest's network is `sandbox-netd` on the host
(gVisor's TCP/IP stack): names resolve to placeholder addresses, and each
TCP connection is made by the backend if its host, and a TLS client's
server name, are allowed and the address is public. Everything else is
refused and recorded.

A VM boots and runs a job in about 150 ms. Builds run one at a time
(Oban queue `builds`), agent sessions one at a time (`setups`), with 2
vCPUs and 4 GiB each (`NIF_VM_CPUS`, `NIF_VM_MEMORY_MIB`).

## Admin

`/admin` (a page, and a web app for an iPhone's home screen) turns
notifications on and lists recent builds; `/api/admin` lists and changes
builds (`retry`), templates (create, update, delete) and agent sessions.
Admins sign in with GitHub (`/auth/github`); only `ADMIN_GITHUB_LOGINS`
(SteffenDE by default) get in. Changes must be JSON.

## Developing

```sh
cd backend
docker run -d --name playground-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:17
DOCKER="sudo -n docker" mix setup   # deps, database, seeds, sandbox artifacts
mix test                            # without VMs
mix test --only vm                  # Firecracker on PATH, /dev/kvm usable
mix phx.server
```

`DOCKER` names the command the sandbox builder runs (Buildx is needed).
Firecracker's binary is the Dockerfile's `firecracker` stage. Without an
`OPENAI_API_KEY`, packages without a template fail.

## Deploying

`docker-compose.yml` runs the release and Postgres on a machine with KVM.
The VM's artifacts stay out of the image: `sandbox/build` builds them from
the Dockerfile's stages into a directory the app mounts read-only
(`SANDBOX_DIR`, `DATA_DIR/sandbox` by default). `DATA_DIR` (`./data` by
default) holds the database, the app's data and those artifacts; on the
server it is outside the checkout (`/datapool/run-elixir/backend-data`),
so a new clone takes them over:

```sh
cd backend
cp .env.example .env               # and fill it in (DATA_DIR=…)
sandbox/build "$DATA_DIR/sandbox"  # the kernel takes a while
mkdir -p "$DATA_DIR/playground" && sudo chown 65534 "$DATA_DIR/playground"
docker compose up --build -d
```

The compose project is `run-elixir-backend`, whichever directory the
checkout is in.

After building the artifacts anew (a new erl_nif layer, say), restart the
app: it reads the toolchain once. It listens on `127.0.0.1:PORT`; Caddy
terminates TLS in front: the admin's site, plus `/api/v1/nif/`, `/relay`
and `/socket` on the apex ([deploy.md](deploy.md#caddy)). Caddy's
`handle` blocks are exclusive, so these never reach the static site's
fallback.

The GitHub OAuth app's callback is
`https://run-elixir.steffend.me/auth/github/callback`.

## The only source of NIF builds

The site ships no NIF libraries: `make` in a page always asks the backend.
So a NIF package needs it. Working on the playground locally,
`runtime/serve.py` passes `/api/v1/nif/` to production's backend, or to
another (`--api`); the browser tests answer it from their own builds
(`--nif`, [nif.md](nif.md#tests-testsnif)).

A change to the NIF layer is one deploy of two parts, from the same
commit: the site, and the backend's root disk built anew
(`sandbox/build`). Until both are out, the backend answers the new pages
409.

## Not yet

- Rustler packages: a toolchain for `wasm32-wasip1` in the guest and a
  layer for Rust NIFs.
- Rate limits on `/api/v1/nif/` beyond the agent's budget and the downloads
  threshold; builds of a popular package's many versions still queue VMs.
