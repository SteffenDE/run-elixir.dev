---
kind: reference
status: live
last_updated: 2026-10-15
---

# The backend (`playground/backend`)

The site is static; the backend is what it can't be: a Phoenix API app
(`mix phx.new --no-html --no-assets`, app `:playground`) that builds NIF
libraries to WebAssembly on request, and later relays collaboration
([projects.md](projects.md#plans), not started). It runs at
run-elixir.steffend.me for its admin, and answers the playground's
pages at `/api/nif/` on run-elixir.dev and its project origins, where
`/socket` is kept for collaboration.

Its sandbox, notifications and GitHub sign-in come from SCA (~/sca), a
different project, cut down to what the backend needs.

## Building a NIF library

```
GET /api/nif/PACKAGE/VERSION              → 202 {status} | 200 {url, sha256, app} | 422 {error} | 404
GET /api/nif/PACKAGE/VERSION/library.tar  → the app's priv files (ustar)
```

The first request for a Hex release queues its build (`Playground.Nif`);
the page asks again while it is `queued`, `running` or `setting_up`. The
archive is what [nif.md](nif.md)'s build.py makes, `priv/NAME.so` holding
WebAssembly, for `make` to unpack into the app's directory. Responses carry
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
  elixir_make's environment for the layer (as build.py gives it:
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
missing) are build.py's four recipes.

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

## The sandbox

`Playground.Sandbox` runs one job per Firecracker VM: a Linux 6.18 kernel
and a read-only ext4 root disk built as stages of the backend's
`Dockerfile` (`mix sandbox.setup` → `priv/sandbox` when developing;
`sandbox/build DIR` for a deployment). The guest is the hexpm/elixir Debian image with wasi-sdk 33
and the layer at build.py's paths (`/nif`, `/tools/nifcc`), and build
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
cd playground/backend
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
(`SANDBOX_DIR`, `data/sandbox` by default):

```sh
git submodule update --init --depth 1 third_party/otp   # erl_nif.h
cd playground/backend
cp .env.example .env               # and fill it in
sandbox/build data/sandbox         # the kernel takes a while
mkdir -p data/playground && sudo chown 65534 data/playground
docker compose up --build -d
```

After building the artifacts anew (a new erl_nif layer, say), restart the
app: it reads the toolchain once. It listens on `127.0.0.1:PORT`; Caddy
terminates TLS in front: the admin's site, and `/api/nif/` and `/socket`
on run-elixir.dev's ([deploy.md](deploy.md#caddy) has both). Caddy's
`handle` blocks are exclusive, so these never reach the static site's
fallback.

The GitHub OAuth app's callback is
`https://run-elixir.steffend.me/auth/github/callback`.

## Not yet

- The playground's `make` still fetches only the site's own builds
  (`nif/NAME-VERSION.tar`); it should ask `/api/nif/` for others and wait
  while they build.
- Rustler packages: a toolchain for `wasm32-wasip1` in the guest and a
  layer for Rust NIFs.
- Rate limits on `/api/nif/` beyond the agent's budget and the downloads
  threshold; builds of a popular package's many versions still queue VMs.
- Collaboration over `/socket`.
