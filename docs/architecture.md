---
kind: design
status: live
last_updated: 2026-10-23
---

# Architecture

The frontend is a static site. Each active project runs in a browser tab,
with its files and database stored locally. The backend handles NIF
builds, encrypted collaboration, and the restricted TCP relay; it does
not run the project's Elixir application.

The IDE runs on the apex origin. Project code runs in an exec frame on a
separate usercontent domain, and each preview port has its own origin.
A tab can keep one project running while displaying Settings, Tailscale,
or the project list. Different tabs can run different projects.
See [projects.md](projects.md) and [frames.md](frames.md).

```
apex: React IDE, project storage, PGlite, Hex cache, Tailscale device
  ├─ e-ID.USERCONTENT: exec frame and host worker
  │    ├─ files.js: shared project filesystem
  │    ├─ worker.js: shell and BEAM workers
  │    ├─ nodejs.js: Node.js processes
  │    └─ Tailwind, esbuild, Git, network routing, preview bridge
  ├─ v-ID-PORT.USERCONTENT: relay frame and preview for each server port
  └─ claude.USERCONTENT: Claude Code preparation and cache
```

## The node

A node is one Emscripten BEAM: OTP's erts built with Emscripten
(`beam.mjs`, `beam.emu.mjs`, `beam.wasm`; [../beam/README.md](../beam/README.md)),
loaded in a Web Worker (`packages/runtime/src/worker/`, `packages/runtime/src/beam/`). The
node sees an ordinary filesystem (PROXYFS over the worker's tree), TCP,
child processes, a clock, random bytes and a terminal.

- **Threads of its own.** The emulator runs `PROXY_TO_PTHREAD`: its
  schedulers (as many as the machine has cores, at most four: `+S`) and
  its other threads are Emscripten's workers on one shared memory (up to
  4, 2 or 1 GiB, as can be had). The node's worker is the module's main
  thread: every file and network call the threads make is proxied to it,
  so it never blocks while the node runs. It takes the page's frames as
  they come (`Atomics.waitAsync` on the ring's write count).
- **The shell.** Each terminal runs brush, a Bash-compatible shell built
  to WebAssembly. It supports pipelines, redirections, variables, jobs,
  and command history. `elixir`, `iex`, `mix`, and `erl` start BEAM
  instances; ordinary tools run through the worker's process table.
- **One BEAM at a time per shell worker.** Separate terminal tabs have
  separate workers and share the project's files. Child commands can
  create additional workers. Ctrl+C sends SIGINT to a running BEAM,
  which opens the ERTS break menu; other programs are interrupted.

- **NIFs.** A NIF library built to WebAssembly runs beside the node, on
  the worker's thread, in an instance of its own; erts reaches it through
  one proxy NIF, in external terms ([nif.md](nif.md)).

## Files

- **`/opt/otp/VERSION` and `/opt/elixir/VERSION`** are the installation
  (OTP; Elixir, Mix, Hex, phx_new), each at the root its package names
  ([packages.md](packages.md#fs-layers-fs-format-3)).
  Every worker has its own copy: its project kind's boot images unpacked
  (IEx's; a Phoenix project adds the server's), the rest fetched in bundles
  on first use (see [build.md](build.md)). The images are gunzipped once,
  by `files.js`, and the exec frame's worker compiles `beam.wasm`,
  `brush.wasm` and `coreutils.wasm` once (beside the nodes' workers: a
  compiled module reaches no worker of another site, [frames.md](frames.md)): each worker gets them with its start and builds
  its tree from the tars (tens of milliseconds), rather than fetching and
  compiling for itself.
- **`/work`, `/tmp`, `/home`, and `/shared`** live in `packages/runtime/src/files.ts`, a worker that runs no node
  and so is always free to answer. Nodes reach it synchronously: `wasi/shared.ts`
  sends each call on those paths through a SharedArrayBuffer channel and
  waits with `Atomics.wait`. The page reaches it with messages (the IDE's
  tree and editor), and hears every change from it. What one shell writes,
  every other shell and the page see.
- **A project's `/work`** starts as its template (the site's
  `/work/playground` for Phoenix, nothing otherwise), with the project's
  saved changes applied over it. `files.js` sends changes below `/work`
  and `/home` to apex storage after a one-second debounce
  ([projects.md](projects.md#what-is-kept)).

## How a preview request reaches Phoenix

1. The preview iframe requests a path such as `/posts`. Its service worker
   intercepts preview navigations and requests from preview documents.
   Runtime assets and other non-preview requests go to the network.
2. The service worker forwards the request through the port's relay frame
   (`relay.html`) to the project's exec host. Each preview port has its own
   origin and service worker. Routes survive service-worker restarts.
3. The bridge (`packages/runtime/src/bridge.ts`) connects to the node listening on
   that port and sends an HTTP/1.1 request. It adds cookies from the preview's
   cookie jar, including HttpOnly cookies that the bridge stores because
   service-worker responses cannot set them directly.
4. Bandit handles the request in the node. The response returns through
   the same route.

Service workers cannot intercept WebSocket connections. The runtime
injects a WebSocket implementation into preview documents that sends
connections through the bridge. This carries LiveView traffic.
See [runtime.md](runtime.md#the-preview-swjs-bridgets) for protocol details.

## The database

Postgrex connects to `localhost:5432`. That port is served on the page:
`packages/pglite/src/postgres.ts` hands whole wire-protocol messages to PGlite's
`execProtocolRaw`. PGlite is a single session, so a pool's connections take
turns: one that leaves the session in a transaction, or between a Parse and
its Sync, holds it until a ReadyForQuery says idle, and the others wait
(one that saw another's transaction would take it for its own, and an
unnamed statement would be another's). After a transaction has been idle for a second, waiting connections
from the same node may join it. New connection startups and connections
from other nodes remain blocked: Ecto's
migrator holds a lock in a transaction on one connection and migrates on
another. A connection that closes in its transaction has it rolled back; a
CancelRequest closes its connection and stops nothing. The template's pool
has one connection anyway; a cloned app keeps its own. PGlite starts on the
first connection, and a
stored project's lives in IndexedDB (`idb://playground-pg-ID`); a temporary
IEx's lives in memory.

## Hex

Hex uses a local HTTP adapter. The browser can fetch hex.pm's API
directly, but repo.hex.pm's registry and tarballs need a proxy because
they do not allow CORS. Shells start with `HEX_MIRROR=http://localhost:49180/repo` and
`HEX_API_URL=http://localhost:49180/api`; the page serves that port with
`packages/runtime/src/fetcher.ts`, which answers each request with a `fetch()`
(`src/project/lib/hex.ts`):

- `/repo/…` goes to the site's own proxy at `/hex/` (`serve.py`, Caddy in
  [deploy.md](deploy.md)), or, on a site without one, to hexpm.upyun.com,
  a public mirror that sends CORS headers;
- `/api/…` goes to hex.pm directly.

Hex treats a mirror as untrusted: it checks the registry's signature
against hex.pm's key and every tarball's checksum, so the proxy or mirror
can fail but not alter packages. Tarballs are kept in Cache Storage
(`playground-hex`), so a second project fetches them from the browser.

## git

GitHub's, GitLab's and Codeberg's git endpoints send no CORS headers
either. The node's `git` is git itself, git.wasm ([git.md](git.md#gitwasm-git-itself)),
as the shell's is: a process of the worker's table (`portProgram`), its
transport the HTTPS helper through the site's proxy at
`/git/HOST/OWNER/REPO/` (cloning and fetching only). Mix's git
dependencies are git's own `init`, `fetch --depth`, sparse checkout and
the lock's `rev-parse`. The template's dependencies keep a `.git` git takes
for a repository without its objects (config, HEAD, refs and an empty
`objects/info/packs`), which is all Mix's lock check reads. The Node
harness (`node.ts`, the build's recording) runs git.wasm the same way.

## Programs

When a node spawns a program through `open_port` or `System.cmd`, the
runtime dispatches it by name:

- **WASI tools:** Git, coreutils, ripgrep, sed, grep, diffutils, gawk,
  and find. Tools that spawn children use the worker's process table.
- **Native-build adapter:** `make` obtains the package's WebAssembly NIF
  library from the site or backend and unpacks it into the app's `priv`.
- **Host programs:** Tailwind, esbuild, Node.js, npm, and npx run through
  the exec host. Project plugins execute on the usercontent origin.
- **BEAM commands:** `mix`, `elixir`, `iex`, `erl`, `escript`, and
  `rebar3` run in workers over the same project files.
- **Shell commands:** `sh -c` runs brush, including pipelines,
  redirections, and child processes. `os:cmd`'s `sh -s` input path is
  not supported.

`rebar3` runs the installed escript (`MIX_REBAR3`, the Elixir package's
`mix/rebar3`). `/usr/bin/mix` links to the package's Mix script; stand-ins
on `PATH` let Erlang and Elixir find the other supported programs. The installation
also includes OTP application headers for dependency compilation.

The Hex `esbuild` and `tailwind` packages run the playground's programs
whatever the project: Elixir starts with their `:path` set to
`/usr/bin/esbuild` and `/usr/bin/tailwind` (`-esbuild path …` on the command
line, worker.js), so they never download a binary. A project's own `:path`
wins. The packages check the program's `--version` against the configured
one, so a project configuring another version gets their "Outdated …
version" warning. The node presents itself as Linux x86_64, so other tool
wrappers take their Linux paths.
