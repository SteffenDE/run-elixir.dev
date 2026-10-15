---
kind: reference
status: live
last_updated: 2026-10-15
---

# Building the site (`runtime/build.py`)

```sh
python3 -I playground/runtime/build.py       # → target/playground/site
python3 -I playground/runtime/build.py app   # just the page and the runtime's JavaScript
python3 -I playground/runtime/serve.py 8081
```

`build.py app` rebuilds the Vite app and the runtime's bundles into an
existing site, without the recording runs (seconds instead of a minute).

## Requirements

- **The native install:** `target/rotp`, from `elixir tools/rotp/install.exs`.
  Its `mix/archives` must hold Hex and, for Phoenix, phx_new (`build.py`
  installs phx_new 1.8.15 when it is missing).
- **Docker,** through `DOCKER` (default `sudo -n docker`). Node 24 runs the
  recording runs and the Vite build; Node 22's WASI crashes partway through
  a boot.
- **Network access the first time,** for the template's Hex packages, two
  git dependencies and the native tailwind and esbuild binaries.
- **NIF builds,** optional: `python3 -I playground/nif/build.py` first
  ([nif.md](nif.md)); the site takes what is in
  `target/playground/nif/packages` (also `build.py app`).

## What the site is

```
target/playground/site/
  index.html, preview.html,  the app's Vite build (assets in _playground/), each
  registry.html, storage.html  naming its build: <meta name="playground-build">
  sw.js                      the service worker, at the root for its scope /
  playground.json            the project domain, if any
  _playground/               the Vite assets, content-hashed
  b/ID/                      the build, ID a digest of what is in it:
    worker.js files.js         the runtime's workers, bundled (Vite),
    thread.js, chunks/           and what they share
    rotp.wasm                  stripped, 3.1 MB
    rotp-threads.wasm          the same for wasm32-wasip1-threads, 3.1 MB
    fs/boot.tar.gz             what IEx reads first (3.8 MB)
    fs/boot-phoenix.tar.gz     what the Phoenix server reads beyond it (14.5 MB)
    fs/manifest.json           every file not in boot.tar.gz: [path, size, mtime, bundle]
    fs/bundles/N.tar           those files, uncompressed tars of ≤ 512 KB
    fs/templates.json          each template's id (its files, without its build) and label
    fs/version                 a digest of fs/, which kept project changes note
    nif/NAME-VERSION.tar       a package's NIF library built to WebAssembly (its priv)
```

The build's files keep their names from one build to the next, so they
live under a path of their own (`b/ID/`), which the page reads from its
`<meta>` (`app/src/shared/lib/build.ts`): a page loaded before a deploy
keeps loading its own build, never a newer `rotp.wasm` with its older
filesystem, for as long as the server keeps the older build
([deploy.md](deploy.md)). `build.py` builds flat and moves the build
there last; `build.py app` lays it flat again first. The Node harness
takes the site or one build.

Every project unpacks `boot.tar.gz`; a Phoenix project also unpacks
`boot-phoenix.tar.gz`. The manifest lists the second image's files too, so
an empty project fetches them lazily when it needs them.

The filesystem holds:

- `/rotp`: the native install's `bin/*.boot`, `releases/`, `mix/archives/`
  and the `ebin` and `priv` of the applications a playground needs (`APPS`
  in `build.py`);
- `/work/playground`: the Phoenix template's app, which only a Phoenix
  project mounts.

## Steps

1. **Vite build.** `npm ci && npm run build` in `playground/app`, in Docker:
   `tsc --noEmit`, the app (`vite.config.ts`), then the runtime
   (`vite.runtime.config.ts`). Its browser entries, `worker.js`,
   `files.js`, `thread.js` and `sw.js`, keep their names (the page starts
   them by URL; `sw.js` is the service worker), beside the app's in
   `dist/`, which goes into the site; with `--mode node`, the Node harness
   (`node.mjs`, `thread-node.mjs`) into `dist-node/`, which goes to
   `target/playground/node`. The NIF builds go into `nif/`.
2. **`rotp.wasm`.** A stripped release build for `wasm32-wasip1`, and
   `rotp-threads.wasm`, the same for `wasm32-wasip1-threads`.
3. **The Phoenix template** (once, into `target/playground-cache`):
   1. `mix archive.install hex phx_new 1.8.15` and `mix phx.new playground
      --no-install`, with the native Rust-OTP.
   2. `mix deps.get`. Tailwind and esbuild come from curl, because
      `tailwind.install` through Rust-OTP's httpc was killed downloading
      100 MB.
   3. `mix assets.build`, then `configure()`.
   4. `mix compile`. A later build compiles it again (from an empty
      `_build_rotp/dev`) when the Rust-OTP binary differs from the one that
      compiled it, since its backend decides the code; the binary's digest
      is `playground-cache/playground.compiler`.

   `configure()` edits the generated config:
   - **`dev.exs`:** the Repo uses database `postgres` with a pool of 1
     (PGlite is one session). The watchers are phx.new's, esbuild and
     tailwind, which run on the page; the natively built assets are where
     they start.
   - **`runtime.exs`:** the live reload block goes: without `inotifywait`
     its watcher sees no change. The IDE reloads the preview itself.
4. **Files.** The installation, then the app:
   - `_build_rotp` becomes `_build`;
   - links in the build (each dependency's `priv`, some `src`) are copied in
     place, since WASI has none;
   - a dependency's `.git` keeps only `config` and `HEAD`, which is what
     Mix's lock check asks `git` about;
   - the native tool binaries become empty stand-ins.
5. **Record.** Write every file lazily, then run each boot image's command
   in the WebAssembly node under `node.mjs` in Docker (`RECORD` in
   `build.py`):
   - `boot`: IEx in `/work` with `1 + 1`.
   - `boot-phoenix`: `iex -S mix phx.server` in `/work/playground` with one
     `GET /`, until 5 s after its response (at most 120 s).

   What each fetches is its boot set. The Phoenix run's writes below
   `/work` (`SNAPSHOT`) replace the template's files. Mix's builds record
   absolute paths, so the app is compiled once more at `/work/playground`
   in that run, and that build is what ships. Without this, every boot
   would recompile it.
6. **Pack.**
   - `fs/boot.tar.gz` gets IEx's recorded files outside `/work`, plus every
     `.app`, `.boot` and release file and erts's preloaded modules.
   - `fs/boot-phoenix.tar.gz` gets what the Phoenix run fetched beyond
     that, and the template's `.app` files.
   - Everything not in `boot.tar.gz` goes into bundles: sorted by path, one
     directory per bundle, up to 512 KB each.
   - `fs/version` is a digest of `fs/`.
   - Results: 272 and 1342 files in the two images (3.8 and 14.5 MB),
     4825 lazy files in 706 bundles.

## The Node harness (`runtime/node.mjs`)

`node node.mjs DIR ERL-ARGS…` runs the site's node under Node with the same
shim, without a browser. It runs bundled, from `target/playground/node`
(the Vite build's, step 1). Standard input is read whole, then ends. The
environment controls the rest:

| Variable | Effect |
| --- | --- |
| `CWD` | The node's working directory (default `/work`). |
| `BOOT=NAME,…` | The boot images to unpack (default: every `fs/boot*.tar.gz`). |
| `MOUNT=VFSDIR:HOSTDIR,…` | Host directories in the node's tree, read lazily. |
| `HTTP=PORT/PATH,…` | Once the node listens on PORT, GET each PATH in turn; print each status line. |
| `HTTP_HEADERS=1`, `HTTP_BODY=FILE` | Also print the headers; write the last body to FILE. |
| `STOP_AFTER=MS` | Stop the node then (a server never halts). |
| `STOP_SERVED=MS` | Stop the node that long after the last `HTTP` response. |
| `NO_EOF=1` | Standard input waits instead of ending (IEx halts at its end). |
| `RECORD=FILE` | Write the files fetched lazily, one per line. |
| `SNAPSHOT=VFSDIR:HOSTDIR` | Copy what the node wrote below VFSDIR out, with mtimes. |
| `SHOW_FETCH=1`, `TRACE_WASI=1` | Print each lazy fetch; print every WASI call. |
| `ROTP_*` | Passed to the node (`ROTP_TRACE_HOST=1` prints host calls). |

For example:

```sh
docker run --rm -i -e CWD=/work/playground -e HTTP=4000/ -e STOP_AFTER=20000 -e NO_EOF=1 \
  -v $PWD/target/playground/node:/w:ro -v $PWD/target/playground/site:/d:ro node:24 \
  node /w/node.mjs /d -noshell -elixir_root /rotp/lib -pa /rotp/lib/elixir/ebin \
  -user elixir -extra --no-halt +iex /rotp/bin/mix phx.server </dev/null
```

The harness runs the node with its whole filesystem local: no `files.js`, no
page programs. It is the recording run's environment.

A `rotp.wasm` built for `wasm32-wasip1-threads` (it imports its memory;
`.cargo/config.toml` lets it grow to 4 GiB) runs threaded: each thread in
a worker on one shared memory, the node's schedulers as `+S` says.
`threads.js` keeps the WASI state with a host that runs no WebAssembly
(a thread waiting in a futex could not serve calls): a thread forwards
each call through its slot in a SharedArrayBuffer, and the host runs
`wasi.js`'s function on the shared memory and answers. Clocks,
randomness and sleeping stay with the thread. The site runs nodes this
way too ([architecture.md](architecture.md#the-node)). Compiling ecto (deps compiled natively): 41.9 s with
`+S 1`, 23.6 s with `+S 2`, 16.2 s with `+S 4` and as long with `+S 8`
(native: 29.2, 17.7, 13.5 s); 474 MiB of memory with one scheduler,
565 MiB with four. Every WebAssembly build allocates through
`crates/thread-cache`, a per-thread cache of small blocks: wasi-libc's
malloc serializes threads on one lock, and before it four schedulers
spent half their time waiting there (42.3 s with `+S 4`; 2026-10-14).
The single-threaded build compiles ecto in 39.9 s with it, about 41.5
without.
