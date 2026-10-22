---
kind: design
status: live
last_updated: 2026-10-19
---

# Architecture

A project runs in one browser tab. Nothing on the server knows about
Elixir: the site is static files. The home page (`/`) only lists projects;
a project's page (`/ID/`, `/iex`) runs it, and several tabs may run
several projects (one tab per project, [projects.md](projects.md)). Every
page is the apex's; what the project's code runs is in frames of the
usercontent domain, another site ([frames.md](frames.md)).

```
 project page (React IDE, apex)
 ├─ terminals' screens and line disciplines, the tree, the tabs
 ├─ postgres.ts ─── PGlite (Postgres in WebAssembly; the apex's IndexedDB)
 ├─ overlay.ts serveStore: /work's changes, in the apex's IndexedDB
 ├─ hex.ts: Hex's tarballs, in the apex's Cache Storage
 │
 ├─ exec frame (e-ID.USERCONTENT) ─► exec/host.ts, a worker: rpc.ts ◄─► the page
 │   ├─ host/ Node ──────────► worker.js  (one per shell / terminal tab)
 │   │    frames in a SharedArrayBuffer ring;   the Emscripten BEAM
 │   │    messages back                         its own /rotp, /dev, /usr
 │   ├─ host/ Files ─────────► files.js   (one; runs no node)
 │   │    messages                              /work and /tmp, shared;
 │   │                                          keeps /work's changes
 │   │                                          through the page's store
 │   │                worker.js ═══════════► files.js
 │   │                synchronous calls (SharedArrayBuffer + Atomics.wait)
 │   ├─ bridge.ts: the preview's requests, to the app
 │   ├─ 5432, Hex's port ──► carried to the page (portConnection.ts)
 │   └─ page programs: tailwind (the project's plugins), esbuild, git,
 │       node, npm and npx (nodejs.md), and sh and rebar3
 │       (programs/node.ts), which start a node of their own
 │
 └─ relay frame (v-ID-PORT.USERCONTENT), per port ◄── sw.js ◄── preview <iframe>
     passes requests to the exec frame's bridge         (the app), or a
                                                        popped-out window
```

## The node

A node is one Emscripten BEAM: OTP's erts built with Emscripten
(`beam.mjs`, `beam.emu.mjs`, `beam.wasm`; [../beam/README.md](../beam/README.md)),
loaded in a Web Worker (`src/runtime/worker/`, `src/runtime/beam/`). The
node sees an ordinary filesystem (PROXYFS over the worker's tree), TCP,
child processes, a clock, random bytes and a terminal.

- **Threads of its own.** The emulator runs `PROXY_TO_PTHREAD`: its
  schedulers (as many as the machine has cores, at most four: `+S`) and
  its other threads are Emscripten's workers on one shared memory (up to
  4, 2 or 1 GiB, as can be had). The node's worker is the module's main
  thread: every file and network call the threads make is proxied to it,
  so it never blocks while the node runs. It takes the page's frames as
  they come (`Atomics.waitAsync` on the ring's write count).
- **The shell.** A worker runs a small shell. `elixir`, `iex`, `mix` and `erl`
  each start a fresh node, as a Unix shell starts processes; `cd`, `ls`,
  `cat`, `mkdir`, `rm`, `echo`, `clear` and `help` are builtins. A line
  ending in `\` goes on in the next, as in sh. Ctrl+C stops the node
  (status 130).
- **One node per worker.** A worker runs one node at a time, so each
  terminal tab is a worker of its own.
- **NIFs.** A NIF library built to WebAssembly runs beside the node, on
  the worker's thread, in an instance of its own; erts reaches it through
  one proxy NIF, in external terms ([nif.md](nif.md)).

## Files

- **`/rotp`** is the installation (OTP, Elixir, Mix, Hex, phx_new; the
  name is Rust-OTP's).
  Every worker has its own copy: its project kind's boot images unpacked
  (IEx's; a Phoenix project adds the server's), the rest fetched in bundles
  on first use (see [build.md](build.md)). The images are gunzipped once,
  by `files.js`, and the exec frame's worker compiles `beam.wasm`,
  `brush.wasm` and `coreutils.wasm` once (beside the nodes' workers: a
  compiled module reaches no worker of another site, [frames.md](frames.md)): each worker gets them with its start and builds
  its tree from the tars (tens of milliseconds), rather than fetching and
  compiling for itself.
- **`/work` and `/tmp`** live in `src/runtime/files.ts`, a worker that runs no node
  and so is always free to answer. Nodes reach it synchronously: `wasi/shared.ts`
  sends each call on those paths through a SharedArrayBuffer channel and
  waits with `Atomics.wait`. The page reaches it with messages (the IDE's
  tree and editor), and hears every change from it. What one shell writes,
  every other shell and the page see.
- **A project's `/work`** starts as its template (the site's
  `/work/playground` for Phoenix, nothing otherwise), with the project's
  kept changes laid over it. `files.js` writes what changes below `/work`
  to the project's IndexedDB database a second later
  ([projects.md](projects.md#what-is-kept)).

## How a preview request reaches Phoenix

1. The preview iframe asks for `/posts`. The service worker (`src/runtime/sw.ts`, served as `/sw.js`)
   answers only the preview's requests: iframe navigations, and requests
   from the documents those made. Everything else goes to the network
   directly.
2. The service worker sends the request to the page running the preview's
   project. Each project page announces itself under its project's key, and
   each preview document takes the key of what navigated it; the routes
   outlive a service worker restart ([runtime.md](runtime.md#the-preview-swjs-bridgejs)).
   Each port of a project's app has an origin of its own on the
   usercontent domain, and so a service worker
   ([frames.md](frames.md)); its relay frame (`relay.html`) is never a
   preview.
3. `src/runtime/bridge.ts` on the page opens a connection to the preview's port
   (4000, else the lowest port a node serves on; ports a node asked for
   with 0, such as Mix's compile lock's, are no server) of the node that
   listens there. Nodes report their listening ports, and the IDE routes by
   them. The request goes in as HTTP/1.1 with the app's cookies: the
   HttpOnly ones the bridge keeps (a service worker's responses cannot set
   cookies) and those in `document.cookie`, which the preview shares with
   the page.
4. Bandit answers in the node; the response comes back the same way.

A service worker sees no WebSocket connection, so HTML gets a `WebSocket`
of the bridge's: it asks the service worker for the project's page, whose
bridge connects to the app and speaks the protocol for it. LiveView runs
over it as outside the playground.

## The database

Postgrex connects to `localhost:5432`. That port is served on the page:
`src/runtime/postgres.ts` hands whole wire-protocol messages to PGlite's
`execProtocolRaw`. PGlite is a single session, so a pool's connections take
turns: one that leaves the session in a transaction, or between a Parse and
its Sync, holds it until a ReadyForQuery says idle, and the others wait
(one that saw another's transaction would take it for its own, and an
unnamed statement would be another's). A transaction idle for a second lets
the waiting ones in, into it, except a new connection's startup: Ecto's
migrator holds a lock in a transaction on one connection and migrates on
another. A connection that closes in its transaction has it rolled back; a
CancelRequest closes its connection and stops nothing. The template's pool
has one connection anyway; a cloned app keeps its own. PGlite starts on the
first connection, and a
stored project's lives in IndexedDB (`idb://playground-pg-ID`); a temporary
IEx's lives in memory.

## Hex

The node reaches no other host but through the page (and the user's
tailnet, once Tailscale is set up: [tailscale.md](tailscale.md)), and the
page reads only what CORS allows: hex.pm's API does, repo.hex.pm (the registry and tarballs)
does not. Shells start with `HEX_MIRROR=http://localhost:49180/repo` and
`HEX_API_URL=http://localhost:49180/api`; the page serves that port with
`src/runtime/fetcher.ts`, which answers each request with a `fetch()`
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
either. The node's `git` is a page program (`src/project/lib/programs/git.ts`)
on isomorphic-git over the node's files (through `Files`' POSIX-shaped
operations), fetching over git's smart HTTP through the site's proxy at
`/git/HOST/OWNER/REPO/` (cloning and fetching only). It answers what Mix
asks for a git dependency: `init`, `remote add` and `set-head`, `config`,
`fetch` (a branch, a tag, or a locked revision, which it finds among the
server's refs; a locked revision with depth 1), `checkout` (sparse, as
`.git/info/sparse-checkout` says), `read-tree -mu HEAD`, `rev-parse`.
In the shell it also clones and pulls ([git.md](git.md#built)).
The Node harness keeps a stub that answers only the lock check.

## Programs

When the node spawns a program (`open_port`, `System.cmd`), the worker runs a
JavaScript one instead:

- **In the worker, synchronously:** `git`, as far as Mix asks a git
  dependency, and `make`, as elixir_make runs it: it unpacks the site's
  WebAssembly build of the package's NIF library into the app's `priv`
  ([nif.md](nif.md)).
- **On the page, asynchronously:** `tailwind`, `esbuild` and `git`. The
  worker forwards the spawn, and output and exit come back as frames.
- **As a node of its own:** `sh`, `rebar3`, and `mix`, `elixir`, `iex`,
  `erl` and `escript` themselves (`programs/node.ts`), page
  programs that start a node in a new worker over the same files, as the
  shell does, and pass on its output and exit status. `sh -c LINE` (open_port's
  `{spawn, Command}`, `System.shell`; `phx.new` runs `mix deps.get` that way)
  is brush in that worker, without its line editor: the line runs as the
  terminal's shell runs it (pipes, `||`, variables, redirections), a node
  command in that worker ([nodejs.md](nodejs.md#a-nodes-sh--c-is-brush)). `rebar3` runs
  `escript /rotp/mix/rebar3`, the rebar3 the installation built, which Mix
  builds rebar3 dependencies with (`MIX_REBAR3`). `System.cmd("mix", …)`
  finds `/rotp/bin/mix` on `PATH` (the others have stand-ins in
  `/usr/bin`) and runs it as a node; `igniter.new` runs `mix deps.get`
  that way. The image has the OTP
  applications' `include` directories for them. `os:cmd` writes its command
  to the shell's input, which page programs do not read, so it is not
  covered.

The Hex `esbuild` and `tailwind` packages run the playground's programs
whatever the project: Elixir starts with their `:path` set to
`/usr/bin/esbuild` and `/usr/bin/tailwind` (`-esbuild path …` on the command
line, worker.js), so they never download a binary. A project's own `:path`
wins. The packages check the program's `--version` against the configured
one, so a project configuring another version gets their "Outdated …
version" warning. The node presents itself as Linux x86_64, so other tool
wrappers take their Linux paths.
