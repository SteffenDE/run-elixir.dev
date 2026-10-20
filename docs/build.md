---
kind: reference
status: live
last_updated: 2026-10-19
---

# Building the site (`runtime/build.py`)

```sh
python3 -I runtime/build.py       # → target/site
python3 -I runtime/build.py app   # just the page and the runtime's JavaScript
python3 -I runtime/serve.py 8081
```

`build.py app` rebuilds the Vite app and the runtime's bundles into an
existing site, without the recording runs (seconds instead of a minute).

The site runs OTP's own emulator built with Emscripten
([`../beam/README.md`](../beam/README.md#in-the-playground)): `build.py`
builds it (`beam/build.sh release`), lays out its installation in
`target/otp` (OTP from that build, the host's Elixir, Hex, phx_new and
rebar3), and builds the template with the host's Mix in
`target/cache-otp`.

## Requirements

- **emsdk 6.0.2** at `~/emsdk`, autoconf, and the host's Erlang 29.1.1
  and Elixir 1.20.4, which build the BEAM and the template
  ([`../beam/README.md`](../beam/README.md#build)). The host's `~/.mix`
  must hold Hex and phx_new 1.8.15 (`mix archive.install hex phx_new
  1.8.15`) and rebar3 (`mix local.rebar`).
- **Docker,** through `DOCKER` (default `sudo -n docker`). Node 24 runs the
  recording runs and the Vite build.
- **Network access the first time,** for the template's Hex packages, two
  git dependencies and the native tailwind and esbuild binaries.
- **NIF builds,** optional: `python3 -I nif/build.py` first
  ([nif.md](nif.md)); the site takes what is in
  `target/nif/packages` (also `build.py app`).
- **brush:** `python3 -I brush/build.py` first (the
  `brush/src/` submodules, `git submodule update --init brush/src`: brush,
  crossterm and fd-lock, each with `brush/patches/NAME/`, in Docker, about
  a minute; cached until its image, commits or patches change); the site
  takes `target/brush/brush.wasm` (also `build.py app`).
- **coreutils:** `python3 -I coreutils/build.py` first (uutils
  coreutils for WASI, in Docker, about a minute; cached until its image,
  version or patches change); the site takes
  `target/coreutils/coreutils.wasm` (also `build.py app`).
- **Tailscale:** `python3 -I tailscale/build.py` first (the node's
  Tailscale client for `js/wasm`, Go 1.27 in Docker, under a minute with
  its module cache in `target/tailscale/gomod`; cached until its image,
  tags or sources change); the site takes
  `target/tailscale/tailscale.wasm` (also `build.py app`).
- **TLS:** `python3 -I tls/build.py` first (a Node.js process's TLS
  client, rustls for `wasm32-wasip1`, Rust and clang in Docker, about a
  minute; cached until its image or the crate's files change); the site
  takes `target/tls/tls.wasm` (also `build.py app`).
  [tailscale.md](tailscale.md).

## What the site is

```
target/site/
  index.html, preview.html,  the app's Vite build (assets in _playground/), each
  relay.html, exec.html,       naming its build and runtime: <meta name="playground-build">,
  storage.html                 <meta name="playground-runtime">
  sw.js                      the service worker, at the root for its scope /
  playground.json            the apex and the usercontent domain (frames.md)
  favicon.ico, icons/,       app/public as it is: the icons, the web app manifest,
  manifest.webmanifest,        the link preview's card (og:image, absolute with a
  og.png                       project domain)
  _playground/               the Vite assets, content-hashed
  b/ID/                      the build's JavaScript, ID a digest of it and RID:
    worker.js files.js         the runtime's workers, bundled (Vite),
    tailscale.js                 the apex's Tailscale worker,
    chunks/                      and what they share
  r/RID/                     the runtime, RID a digest of what is in it:
    beam.mjs, beam.emu.mjs     the emulator's loader and its threads'
    beam.wasm                  the emulator, 4.9 MB
    brush.wasm                 the terminal's shell (brush, patched), 3.4 MB (1.2 MB gzipped)
    coreutils.wasm             ls, cp, rm, … (coreutils/build.py), 7.8 MB (3.0 MB gzipped)
    tailscale.wasm             the Tailscale node (tailscale/build.py), 29.3 MB (6.8 MB gzipped)
    tls.wasm                   a Node.js process's TLS (tls/build.py), 0.71 MB (0.29 MB gzipped)
    fs/boot.tar.gz             what IEx reads first
    fs/boot-phoenix.tar.gz     what the Phoenix server reads beyond it
    fs/manifest.json           every file not in boot.tar.gz: [path, size, mtime, bundle]
    fs/bundles/N.tar           those files, uncompressed tars of ≤ 512 KB
    fs/templates.json          each template's id (its files, without its build) and label
    fs/version                 a digest of fs/, which kept project changes note
    nif/NAME-VERSION.tar       a package's NIF library built to WebAssembly (its priv)
```

The build's files keep their names from one build to the next, so they
live under paths of their own, which the page reads from its `<meta>`s
(`app/src/shared/lib/build.ts` BUILD and RUNTIME, which it gives the
workers): `b/ID/` for the runtime's JavaScript and `r/RID/` for the BEAM
and what it reads. RID depends on those files alone, so a build that
changes only JavaScript (`build.py app`) keeps it, and browsers keep the
BEAM, the boot images and the bundles cached across that deploy. A page
loaded before a deploy keeps loading its own build and runtime, never a
newer `beam.wasm` with its older filesystem, for as long as the server
keeps them ([deploy.md](deploy.md)). `build.py` builds flat and moves
both there last; `build.py app` lays them flat again first. The Node
harness takes the site or one runtime directory.

Every project unpacks `boot.tar.gz`; a Phoenix project also unpacks
`boot-phoenix.tar.gz`. The manifest lists the second image's files too, so
an empty project fetches them lazily when it needs them.

The filesystem holds:

- `/rotp` (the name is Rust-OTP's): `target/otp`'s `bin/*.boot`,
  `releases/`, `mix/archives/`, `mix/rebar3` and the applications a
  playground needs (`APPS` in `build.py`);
- `/work/playground`: the Phoenix template's app, which only a Phoenix
  project mounts.

## Steps

1. **Vite build.** `npm ci && npm run build` in `app`, in Docker:
   `tsc --noEmit`, the app (`vite.config.ts`), then the runtime
   (`vite.runtime.config.ts`). Its browser entries, `worker.js`,
   `files.js` and `sw.js`, keep their names (the page starts
   them by URL; `sw.js` is the service worker), beside the app's in
   `dist/`, which goes into the site; with `--mode node`, the Node harness
   (`node.ts` and `beam-node.ts`, as `.mjs`) into `dist-node/`, which goes to
   `target/node`. The NIF builds go into `nif/`.
2. **The BEAM.** `beam/build.sh release` with `OPT=-O2` into
   `out/beam-wasm/site`; its `beam*` files go into the site, its
   installation into `target/otp`.
3. **The Phoenix template** (once, into `target/cache-otp`), with the
   host's Mix and `MIX_BUILD_ROOT=_build_otp`:
   1. `mix phx.new playground --no-install`.
   2. `mix deps.get`. Tailwind and esbuild come from curl (on Rust-OTP,
      `tailwind.install` through its httpc was killed downloading
      100 MB).
   3. `mix assets.build`, then `configure()`.
   4. `mix compile`. A later build compiles it again (from an empty
      `_build_otp/dev`) when the host's `elixir --version` differs from
      the one that compiled it; its digest is
      `cache-otp/playground.compiler`.

   `configure()` edits the generated config:
   - **`dev.exs`:** the Repo uses database `postgres` with a pool of 1
     (PGlite is one session). The watchers are phx.new's, esbuild and
     tailwind, which run on the page; the natively built assets are where
     they start.
   - **`runtime.exs`:** the live reload block goes: without `inotifywait`
     its watcher sees no change. The IDE reloads the preview itself.
4. **Files.** The installation, then the app:
   - `_build_otp` becomes `_build`;
   - links in the build (each dependency's `priv`, some `src`) are copied in
     place;
   - a dependency's `.git` keeps only `config` and `HEAD`, which is what
     Mix's lock check asks `git` about;
   - the native tool binaries become empty stand-ins.
5. **Record.** Write every file lazily, then run each boot image's command
   in the node under `node.mjs` in Docker (`RECORD` in
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
   - `build.py` prints the files and sizes of each image and the bundles.

## The Node harness (`src/runtime/node.ts`)

`node node.mjs DIR ERL-ARGS…` runs the site's node under Node as the
browser's worker does (`beam/run.ts`), without a browser. It runs bundled
(`node.mjs`), from `target/node` (the
Vite build's, step 1). Standard input is read whole, then ends. The
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
| `TTY=1` | Standard input is a terminal (raw input; mode changes on standard error). |
| `SHOW_FETCH=1`, `TRACE_NET=1` | Print each lazy fetch; trace the network. |

For example:

```sh
docker run --rm -i -e CWD=/work/playground -e HTTP=4000/ -e STOP_AFTER=20000 -e NO_EOF=1 \
  -v $PWD/target/node:/w:ro -v $PWD/target/site:/d:ro node:24 \
  node /w/node.mjs /d -noshell -elixir_root /rotp/lib -pa /rotp/lib/elixir/ebin \
  -user elixir -extra --no-halt +iex /rotp/bin/mix phx.server </dev/null
```

The harness runs the node with its whole filesystem local: no `files.js`, no
page programs. It is the recording run's environment.
