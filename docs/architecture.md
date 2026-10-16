---
kind: design
status: live
last_updated: 2026-10-14
---

# Architecture

A project runs in one browser tab. Nothing on the server knows about
Elixir: the site is static files. The home page (`/`) only lists projects;
a project's page (`/ID/`, `/iex`) runs it, and several tabs may run
several projects (one tab per project, [projects.md](projects.md)).

```
 project page (React IDE, playground/app)
 ├─ host/ Node ────────────────► worker.js  (one per shell / terminal tab)
 │    frames in a SharedArrayBuffer ring;      rotp.wasm over wasi/
 │    messages back                            its own /rotp, /dev, /usr
 ├─ host/ Files ───────────────► files.js   (one; runs no node)
 │    messages                                 /work and /tmp, shared;
 │                                             keeps /work's changes in
 │                                             IndexedDB (overlay.ts)
 │                   worker.js ═══════════════► files.js
 │                   synchronous calls (SharedArrayBuffer + Atomics.wait)
 ├─ bridge.ts ◄──── sw.js (service worker) ◄─── preview <iframe> (the app)
 │                  routes by project key       or a popped-out window
 ├─ postgres.ts ─── PGlite (Postgres in WebAssembly; IndexedDB)
 └─ page programs: tailwind, git, and sh and rebar3 (programs/node.ts),
                    which start a node of their own
```

## The node

A node is one Rust-OTP instance: `rotp.wasm` instantiated in a Web Worker
(`src/runtime/worker/`) with the WASI imports from `src/runtime/wasi/`. The node
sees an ordinary filesystem, TCP, child processes, a clock, random bytes and a
terminal. All of them are the shim's.

- **Schedulers in workers of their own.** Where the page is cross-origin
  isolated and a shared memory of up to 4, 2 or 1 GiB can be had, the
  worker loads `rotp-threads.wasm` (`wasm32-wasip1-threads`) and runs the
  node with as many schedulers as the machine has cores, at most four.
  The worker then runs no WebAssembly: it keeps the WASI state and serves
  the threads' calls (`src/runtime/threads.ts`), and the page starts a worker
  for each thread (`src/runtime/thread.ts`), since a worker busy serving could
  not start them; the page stops them when the node ends. Elsewhere, or
  when `rotp-threads.wasm` does not load, the worker runs `rotp.wasm` with
  one scheduler itself. Chromium before 157 (V8 before 15.7) checks
  `memory.copy`'s bounds against a size of the memory each thread learns
  late after another grew it; rotp's allocator (`crates/thread-cache`)
  brings the thread up to date for a block it hands out.
- **A busy worker.** The worker is busy for as long as the node runs. Its
  event loop does not turn. Everything that must reach a running node goes
  through shared memory: input, network data, interrupts and the output of
  page programs. The worker reads it whenever the node polls, sleeps or
  reads the clock (a threaded node's host, at least every 5 ms).
- **The shell.** A worker runs a small shell. `elixir`, `iex`, `mix` and `erl`
  each start a fresh instance of the compiled module, as a Unix shell starts
  processes; `cd`, `ls`, `cat`, `mkdir`, `rm`, `echo`, `clear` and `help` are
  builtins. A line ending in `\` goes on in the next, as in sh. Ctrl+C
  makes the next poll throw out of the instance.
- **One node per worker.** A worker cannot interleave two nodes, so each
  terminal tab is a worker of its own.
- **NIFs.** A NIF library built to WebAssembly runs beside the node, in its
  worker, in an instance of its own; the node reaches it through `/.nif`
  files, in external terms ([nif.md](nif.md)).

## Files

- **`/rotp`** is the Rust-OTP installation (OTP, Elixir, Mix, Hex, phx_new).
  Every worker has its own copy: its project kind's boot images unpacked
  (IEx's; a Phoenix project adds the server's), the rest fetched in bundles
  on first use (see [build.md](build.md)).
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

1. The preview iframe asks for `/posts`. The service worker (`src/runtime/sw.js`)
   answers only the preview's requests: iframe navigations, and requests
   from clients it has seen to be nested frames. Everything else goes to the
   network directly.
2. The service worker sends the request to the page running the preview's
   project. Each project page announces itself under its project's key, and
   each preview document takes the key of what navigated it; the routes
   outlive a service worker restart ([runtime.md](runtime.md#the-preview-swjs-bridgejs)).
   With a project domain each project has an origin, and so a service
   worker, of its own ([projects.md](projects.md#a-project-domain)). Its
   frames (`registry.html`, `storage.html`) are never a preview.
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
`execProtocolRaw`, one connection at a time. PGlite is a single session, so
the app's pool has one connection. It starts on the first connection, and a
stored project's lives in IndexedDB (`idb://playground-pg-ID`); a temporary
IEx's lives in memory.

## Hex

The node has no sockets to the internet, and the page reads only what
CORS allows: hex.pm's API does, repo.hex.pm (the registry and tarballs)
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
The Node harness keeps a stub that answers only the lock check.

## Programs

When the node spawns a program (`open_port`, `System.cmd`), the shim runs a
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
  runs a line of `mix`, `elixir`, `iex`, `erl` or `escript` commands and `cd`,
  joined by `&&`, without the `( )` and `</dev/null` that `System.shell`
  wraps it in; anything else answers 127. `rebar3` runs
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
