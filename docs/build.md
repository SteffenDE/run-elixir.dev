---
kind: reference
status: live
last_updated: 2026-10-28
---

# Building the site (`runtime/build.py`)

```sh
python3 -I runtime/build.py       # → target/site
python3 -I runtime/build.py app   # just the page and the runtime's JavaScript
python3 -I runtime/serve.py 8081 \
  --domain playground.localhost:8081 --usercontent usercontent.localhost:8081
```

Open `http://playground.localhost:8081`. Both domains are required to run projects.

`build.py app` rebuilds the Vite app and the runtime's bundles into an
existing site, without the recording runs (seconds instead of a minute).

The site runs OTP's own emulator built with Emscripten
([`../beam/README.md`](../beam/README.md#in-the-playground)): `build.py`
builds it (`beam/build.sh release`), lays out OTP's installation from
that build in `target/otp`, takes Elixir, Hex, phx_new and rebar3 from
the host's installation, and builds the template with the host's Mix in
`target/cache-otp`. Each package's fs layer comes from its own source
(`fs_layers` in `build.py`), with every mtime fixed (`MTIME`), so the same
files make the same package directory across builds.

## Requirements

- **emsdk 6.0.2** at `~/emsdk`, autoconf, and the host's Erlang 29.1.2
  and Elixir 1.20.4, which build the BEAM and the template
  ([`../beam/README.md`](../beam/README.md#build)). The host's `~/.mix`
  must hold Hex and phx_new 1.8.15 (`mix archive.install hex phx_new
  1.8.15`) and rebar3 (`mix local.rebar`).
- **Docker,** through `DOCKER` (default `sudo -n docker`). Node 24 runs the
  recording runs and the Vite build.
- **Network access the first time,** for the template's Hex packages, two
  git dependencies and the native tailwind and esbuild binaries.
- **brush:** `python3 -I brush/build.py` first (the
  `brush/src/` submodules, `git submodule update --init brush/src`: brush,
  crossterm and fd-lock, each with `brush/patches/NAME/`, in Docker, about
  a minute; cached until its image, commits or patches change); the site
  takes `target/brush/brush.wasm` (also `build.py app`).
- **coreutils:** `python3 -I tools/coreutils/build.py` first (uutils
  coreutils for WASI, in Docker, about a minute; cached until its image,
  version or patches change); the site takes
  `target/coreutils/coreutils.wasm` (also `build.py app`).
- **Tailscale:** `python3 -I tailscale/build.py` first (the node's
  Tailscale client for `js/wasm`, Go 1.27 in Docker, under a minute with
  its module cache in `target/tailscale/gomod`; cached until its image,
  tags or sources change); the site takes
  `target/tailscale/tailscale.wasm` (also `build.py app`).
- **ripgrep:** `python3 -I tools/ripgrep/build.py` first (ripgrep 15.2.0 for
  `wasm32-wasip1` with `tools/ripgrep/patches/`, in Docker, about a minute;
  cached until its image, version or patches change); the site takes
  `target/rg/rg.wasm` (also `build.py app`).
- **git:** `python3 -I tools/git/build.py` first (git 2.56.0 and zlib for
  `wasm32-wasip1` with wasi-sdk 33 and `tools/wasi-compat/`, in Docker, under a
  minute; cached until its image, versions or the files of `tools/git/` or
  `tools/wasi-compat/` change; not its `.py` files); the
  site takes `target/git/git.wasm` (also `build.py app`).
- **sed:** `python3 -I tools/sed/build.py` first (GNU sed 4.10 for
  `wasm32-wasip1` over `tools/wasi-compat/`, its configure and make in wasi-sdk
  33's image, about ten seconds: `tools/wasi-compat/autoconf.py`,
  [tools.md](tools.md#building-them); cached as git's is); the site takes
  `target/sed/sed.wasm` (also `build.py app`).
- **grep, diffutils, gawk, findutils:** `python3 -I tools/grep/build.py`,
  `tools/diffutils/build.py`, `tools/gawk/build.py` and `tools/findutils/build.py` first
  (GNU grep 3.12, diffutils 3.12, gawk 5.4.1 and findutils 4.11.0, as
  sed's); the site takes `target/grep/grep.wasm`,
  `target/diffutils/{diff,cmp,diff3,sdiff}.wasm`, `target/gawk/gawk.wasm`
  and `target/findutils/find.wasm` (also `build.py app`).
- **TLS:** `python3 -I tls/build.py` first (a Node.js process's TLS
  client, rustls for `wasm32-wasip1`, Rust and clang in Docker, about a
  minute; cached until its image or the crate's files change); the site
  takes `target/tls/tls.wasm` (also `build.py app`).
  [tailscale.md](tailscale.md).

## What the site is

```
target/site/
  index.html, preview.html,  the apex's pages, the app's Vite build (assets in _playground/),
  storage.html, embed.html     each naming what it runs with: <meta name="playground-runtime">
                               (the runtime package's path), <meta name="playground-site">
                               (the site manifest's)
  embed.js                   the embedders' client (embed.md), self-contained, at the root
  sw.js                      the preview origins' service worker, at the root for its scope /,
                               one for every version (packages.md, its protocol)
  playground.json            the apex, the usercontent domain (frames.md) and the
                               sites that may embed it (PLAYGROUND_EMBEDDERS, embed.md)
  favicon.ico, icons/,       app/public as it is: the icons, the web app manifest,
  manifest.webmanifest,        the link preview's card (og:image, absolute with a
  og.png                       project domain)
  _playground/               the Vite assets, content-hashed
  npm/@elixir-playground/    the packages (packages.md), each NAME@VERSION+ID/ (ID a digest
                               of what is in it) with its package.json:
    runtime@…/                 worker.js, files.js, git.js, nodejs.js, tailscale.js and
                                 chunks/ (the runtime's workers); exec.html, relay.html,
                                 claude.html and frames/ (the usercontent domain's frames)
    otp-29.1.2@…/              beam.mjs, beam.emu.mjs (the emulator's loader and its
                                 threads'), beam.wasm (5.2 MB); fs/ (OTP's applications)
    elixir-1.20.4@…/           fs/ (Elixir, IEx, Mix, ExUnit; Hex, phx_new, rebar3)
    phoenix-template@…/        fs/ (the template's app, at /work/playground)
    shell@…/                   brush.wasm (3.4 MB, 1.2 MB gzipped), coreutils.wasm (7.8 MB,
                                 3.0 MB gzipped); fs/ (the terminfo entry)
    git@…/                     git.wasm (3.8 MB, 1.5 MB gzipped); fs/ (its shell scripts)
    ripgrep@…/                 rg.wasm (3.0 MB, 1.0 MB gzipped)
    gnu-tools@…/               sed, grep, diff, cmp, diff3, sdiff, gawk, find (.wasm,
                                 627 KB to 1.5 MB each)
    tls@…/                     tls.wasm (0.71 MB), roots.pem; fs/ (the nodes' CA bundle)
    tailscale@…/               tailscale.wasm (29.3 MB, 6.8 MB gzipped)
    claude@…/, api@…/          the Claude Code range tested (package.json); embed.js
  boot/ID/                   the recordings: boot.tar.gz (what IEx reads first),
                               boot-phoenix.tar.gz (what the Phoenix server reads beyond it)
  site/ID.json               the site manifest (packages.md): each package's version, files,
                               peer dependencies and `playground` field, the recordings
  licenses/                  the licenses page (index.html) and the IDE's bundle's texts
                               (apex/): licenses.md
```

Every package also has `NOTICE.md`, `licenses/` and its `license` field,
`LICENSE` when the playground's own code is in it, and `source/` when a
component's license asks for its source ([licenses.md](licenses.md)).

A package's `fs/` is its layer of the nodes' tree: `fs/manifest.json`
lists its files (`[path, size, mtime, bundle]`) and `fs/bundles/N.tar`
holds them, uncompressed tars of up to 512 KB of one directory's files.
The runtime merges the layers into one tree and numbers their bundles
one after another (`Site.tree`, `Site.bundle`,
`app/src/runtime/packages/manifest.ts`).

Every path but the pages', `sw.js`'s, `embed.js`'s and
`playground.json`'s is immutable: a package's directory is named by a
digest of what is in it, so an unchanged package keeps its name across
builds, and browsers keep it cached. The page reads both paths from its
`<meta>`s (`app/src/shared/lib/build.ts` `BUILD` and `SITE`) and gives
them to the frames and workers; the runtime finds everything else
through the site manifest. A page loaded before a deploy keeps loading
its own build's files, never a newer `beam.wasm` with an older
filesystem, for as long as the server keeps them
([deploy.md](deploy.md)). `build.py app` lays every package out again
from the builds in `target/`, but the emulator, the fs layers and the
recordings, which it takes from the site it builds over: with nothing
changed, the same names. The Node harness takes the site (the manifest
its `index.html` names) or a site manifest.

Every project unpacks `boot.tar.gz`; a Phoenix project also unpacks
`boot-phoenix.tar.gz`. The layers list every file, those of the images
too, so an empty project fetches the Phoenix server's lazily when it
needs them.

The filesystem holds:

- `/opt/otp/29.1.2`: the `otp-X` package's layer, `target/otp`'s
  `bin/*.boot`, `releases/` and the applications a playground needs
  (`APPS` in `build.py`);
- `/opt/elixir/1.20.4`: the `elixir-X` package's layer, the host's Elixir
  applications (`ELIXIR_APPS`) under `lib/`, Mix's archives at
  `mix/archives/`, `mix/rebar3`, and Mix's script `bin/mix` (its `mix`
  command, linked from `/usr/bin/mix`);
- `/work/playground`: the Phoenix template's app, which only a Phoenix
  project mounts;
- `/usr/libexec/git-core`, `/etc/ssl`, `/usr/share/terminfo`: the git,
  tls and shell packages' layers.

Each root is the package's own (`root` in `PACKAGES`,
[packages.md](packages.md#fs-layers-fs-format-3)): the runtime takes
OTP's and Elixir's from the site manifest.

## Steps

1. **Vite build.** `npm ci && npm run build` in `app`, in Docker:
   `tsc --noEmit`; the apex's pages (`vite.config.ts`) into `dist/`, which
   goes to the site's root; the runtime's scripts (`vite.runtime.config.ts`:
   `worker.js`, `files.js`, `git.js`, `nodejs.js`, `tailscale.js`, which
   keep their names, the pages start them by URL, and `sw.js`, which goes to
   the root) and the usercontent domain's frames (`vite.frames.config.ts`:
   `exec.html`, `relay.html`, `claude.html`, with a relative base, sharing
   nothing with the IDE) into `dist-runtime/`, the runtime package;
   `embed.js` (`vite.embed.config.ts`, one module with nothing to share);
   with `--mode node`, the Node harness (`node.ts` and `beam-node.ts`, as
   `.mjs`) into `dist-node/`, which goes to `target/node`. NIF libraries
   are the backend's ([nif.md](nif.md)): the site has none.
2. **The BEAM.** `beam/build.sh release` with `OPT=-O2` into
   `out/beam-wasm/site`; its `beam*` files go into the OTP package, its
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
   - **`runtime.exs`:** phx.new's live reload block stays: `file_system`
     runs the page's `inotifywait` (`programs/inotifywait.ts`, fed the
     node's and the editor's changes), and Phoenix reloads the preview and
     swaps its CSS. A cache from before gets the block back.
4. **Files.** Each package's layer from its source: OTP's installation,
   the host's Elixir and Mix archives, git's scripts, the CA bundle, the
   terminfo entry, and the app:
   - `_build_otp` becomes `_build`;
   - links in the build (each dependency's `priv`, some `src`) are copied in
     place;
   - a dependency's `.git` keeps `config`, `HEAD`, `packed-refs` and
     `refs`, with empty object directories. This preserves the revision
     metadata Mix needs without bundling the repository's object history;
   - the native tool binaries become empty stand-ins.
5. **Record.** Lay out every package, its files lazily, with a site
   manifest of no recordings (`site/recording.json`), then run each boot
   image's command in the node under `node.mjs` in Docker (`RECORD` in
   `build.py`):
   - `boot`: IEx in `/work` with `1 + 1`.
   - `boot-phoenix`: `iex -S mix phx.server` in `/work/playground` with one
     `GET /`, until 5 s after its response (at most 120 s).

   What each fetches is its boot set. The Phoenix run's writes below
   `/work` (`SNAPSHOT`) replace the template's files. Mix's builds record
   absolute paths, so the app is compiled once more at `/work/playground`
   in that run, and that build is what ships: the template's package is
   laid out again with it. Without this, every boot would recompile it.
6. **Pack.**
   - `boot.tar.gz` gets IEx's recorded files outside `/work`, plus every
     `.app`, `.boot` and release file and erts's preloaded modules.
   - `boot-phoenix.tar.gz` gets what the Phoenix run fetched beyond
     that, and the template's `.app` files. Both have no time in their
     gzip headers: the same files are the same bytes.
   - Each fs layer's `version` is a digest of its files' paths and bytes,
     without Mix's records of a compile (`_build/ENV/lib/APP/.mix/`, which
     note when it ran). A kept project notes the layers' versions it was
     made over (`Site.fsVersion`).
   - The site manifest names the packages, the recordings, and the
     packages they were recorded with.
   - `build.py` prints the files and sizes of each image, the layers'
     files by package, and the runtime's and the site manifest's paths.

## The Node harness (`src/runtime/node.ts`)

`node node.mjs SITE ERL-ARGS…` runs the site's node under Node as the
browser's worker does (`beam/run.ts`), without a browser. It runs bundled
(`node.mjs`), from `target/node` (the
Vite build's, step 1). Standard input is read whole, then ends. The
environment controls the rest:

| Variable | Effect |
| --- | --- |
| `CWD` | The node's working directory (default `/work`). |
| `BOOT=NAME,…` | The boot images to unpack (default: every one the site manifest names). |
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
  node /w/node.mjs /d -noshell -elixir_root /opt/elixir/1.20.4/lib -pa /opt/elixir/1.20.4/lib/elixir/ebin \
  -user elixir -extra --no-halt +iex /opt/elixir/1.20.4/bin/mix phx.server </dev/null
```

The paths are the Elixir package's root (`record_args` in `build.py`
takes them from `PACKAGES`).

The harness runs the node with its whole filesystem local: no `files.js`, no
page programs. It is the recording run's environment.
