---
kind: reference
status: live
last_updated: 2026-10-13
---

# Building a site (`runtime/build.py`)

```sh
python3 -I playground/runtime/build.py elixir    # → target/playground/elixir
python3 -I playground/runtime/build.py phoenix   # → target/playground/phoenix
python3 -I playground/runtime/serve.py phoenix 8081
```

## Requirements

- **The native install:** `target/rotp`, from `elixir tools/rotp/install.exs`.
  Its `mix/archives` must hold Hex and, for Phoenix, phx_new (`build.py`
  installs phx_new 1.8.15 when it is missing).
- **Docker,** through `DOCKER` (default `sudo -n docker`). Node 24 runs the
  recording run and the Vite build; Node 22's WASI crashes partway through a
  boot.
- **For Phoenix:** network access the first time, for Hex packages, two git
  dependencies and the native tailwind and esbuild binaries.

## What a site is

```
target/playground/SITE/
  index.html, …            the site's page (Vite build for phoenix)
  wasi.js worker.js …      runtime/*.js, served as they are
  rotp.wasm                stripped, 2.9 MB
  fs/boot.tar.gz           what the first command reads
  fs/manifest.json         every other file: [path, size, mtime, bundle]
  fs/bundles/N.tar         those files, uncompressed tars of ≤ 512 KB
```

The filesystem holds:

- `/rotp`: the native install's `bin/*.boot`, `releases/`, `mix/archives/`
  and the `ebin` and `priv` of the applications a playground needs (`APPS`
  in `build.py`);
- `/work/playground`: the Phoenix site's app.

## Steps

1. **Vite build.** For a site with a `package.json` (phoenix), run
   `npm ci && npm run build` in Docker, then copy `dist/`. Other sites copy
   `playground/SITE`.
2. **`rotp.wasm`.** A stripped release build for `wasm32-wasip1`.
3. **The Phoenix app** (phoenix only, once, into `target/playground-cache`):
   1. `mix archive.install hex phx_new 1.8.15` and `mix phx.new playground
      --no-install`, with the native Rust-OTP.
   2. `mix deps.get`. Tailwind and esbuild come from curl, because
      `tailwind.install` through Rust-OTP's httpc was killed downloading
      100 MB.
   3. `mix assets.build`, then `configure()`.
   4. `mix compile`.

   `configure()` edits the generated config:
   - **`dev.exs`:** the Repo uses database `postgres` with a pool of 1
     (PGlite is one session). There is no symlink warning for colocated
     assets. The watchers are just the tailwind one, which runs on the page;
     esbuild's is left out, and the JavaScript is prebuilt.
   - **`runtime.exs`:** the live reload block goes, because its socket needs
     a WebSocket the preview cannot open. The IDE reloads the preview itself.
4. **Files.** The installation, then the app:
   - `_build_rotp` becomes `_build`;
   - links in the build (each dependency's `priv`, some `src`) are copied in
     place, since WASI has none;
   - a dependency's `.git` keeps only `config` and `HEAD`, which is what
     Mix's lock check asks `git` about;
   - the native tool binaries become empty stand-ins.
5. **Record.** Write every file lazily, then run the site's first command in
   the WebAssembly node under `node.mjs` in Docker (`RECORD` in `build.py`):
   - Elixir: IEx with `1 + 1`.
   - Phoenix: `iex -S mix phx.server` for 60 s, with one `GET /`.

   What it fetches is the boot set. The run's writes below `/work`
   (`SNAPSHOT`) replace the app's files. Mix's builds record absolute paths,
   so the app is compiled once more at `/work/playground` in that run, and
   that build is what ships. Without this, every boot would recompile it.
6. **Pack.**
   - `fs/boot.tar.gz` gets the recorded files, plus every `.app`, `.boot`
     and release file and erts's preloaded modules.
   - Everything else goes into bundles: sorted by path, one directory per
     bundle, up to 512 KB each.
   - Results: Elixir about 3.8 MB of boot set and 120 bundles; Phoenix
     about 18 MB of boot set and 580 bundles.

## The Node harness (`runtime/node.mjs`)

`node node.mjs DIR ERL-ARGS…` runs a site's node under Node with the same
shim, without a browser. Standard input is read whole, then ends. The
environment controls the rest:

| Variable | Effect |
| --- | --- |
| `CWD` | The node's working directory (default `/work`). |
| `MOUNT=VFSDIR:HOSTDIR,…` | Host directories in the node's tree, read lazily. |
| `HTTP=PORT/PATH,…` | Once the node listens on PORT, GET each PATH in turn; print each status line. |
| `HTTP_HEADERS=1`, `HTTP_BODY=FILE` | Also print the headers; write the last body to FILE. |
| `STOP_AFTER=MS` | Stop the node then (a server never halts). |
| `NO_EOF=1` | Standard input waits instead of ending (IEx halts at its end). |
| `RECORD=FILE` | Write the files fetched lazily, one per line. |
| `SNAPSHOT=VFSDIR:HOSTDIR` | Copy what the node wrote below VFSDIR out, with mtimes. |
| `SHOW_FETCH=1`, `TRACE_WASI=1` | Print each lazy fetch; print every WASI call. |
| `ROTP_*` | Passed to the node (`ROTP_TRACE_HOST=1` prints host calls). |

For example:

```sh
docker run --rm -i -e CWD=/work/playground -e HTTP=4000/ -e STOP_AFTER=20000 -e NO_EOF=1 \
  -v $PWD/playground/runtime:/w:ro -v $PWD/target/playground/phoenix:/d:ro node:24 \
  node /w/node.mjs /d -noshell -elixir_root /rotp/lib -pa /rotp/lib/elixir/ebin \
  -user elixir -extra --no-halt +iex /rotp/bin/mix phx.server </dev/null
```

The harness runs the node with its whole filesystem local: no `files.js`, no
page programs. It is the recording run's environment.
