# Playgrounds

Elixir in the browser: Rust-OTP (`crates/rotp`) compiled to
`wasm32-wasip1`, booting OTP and Elixir from an in-memory filesystem in a
Web Worker.

- `runtime/`: what every playground shares.
  - `wasi.js`: WASI preview 1 over an in-memory filesystem, with TCP for the
    node (`crates/rotp/src/host/wasm_net.rs`) and lazily fetched files.
  - `worker.js`: the node in a worker.
  - `build.py`: builds a site.
  - `serve.py`: serves one locally.
  - `node.mjs`: runs a site's node under Node, for tests.
  - `host.js`: the page's side of a node: start it, type into it, interrupt
    it, connect to it.
  - `setup.js`, `programs.js`: what every node gets, including the
    programs it may spawn (`git`, `esbuild`, `tailwind`) in place of the
    OS's.
  - `sw.js`, `bridge.js`: the preview iframe's HTTP requests, through a
    service worker, to the node's listener. The service worker answers only
    the preview's requests; the playground's own go straight to the
    network.
  - `postgres.js`: Postgrex's connections to PGlite on the page.
- `elixir/`: IEx in xterm.js (elixir-playground.steffend.me).
- `phoenix/`: a `phx.new` app with a shell, its preview and PGlite
  (phoenix-playground.steffend.me).

## The Phoenix playground

The node runs a shell that starts `iex -S mix phx.server` in
`/work/playground`. The app is generated once with the native Rust-OTP
into `target/playground-cache` (phx_new 1.8.15, deps fetched and
compiled, assets built), then set up for the browser:

- the Repo has one connection, to PGlite on the page (`postgres.js`);
- no esbuild or tailwind watchers, and no live reload (its socket needs a
  WebSocket, which the preview cannot open);
- the node presents itself as Linux x86_64 (`ROTP_OS_TYPE`,
  `ROTP_SYSTEM_ARCHITECTURE`), so the esbuild and tailwind packages find
  the playground's programs as `_build/esbuild-linux-x64` and
  `_build/tailwind-linux-x64-VSN`.

Mix's builds record absolute paths, so the app's own modules are built
once more in the WebAssembly node at `/work/playground` while `build.py`
records the boot set, and that build is what ships.

In the preview, requests go through `sw.js` to the page and on to Bandit
as HTTP/1.1. The page keeps the app's cookies (a service worker's
responses cannot set any) and removes `window.WebSocket` from HTML, so
LiveView falls back to long polling.

## Build and try

    python3 -I playground/runtime/build.py elixir    # into target/playground/elixir
    python3 -I playground/runtime/serve.py elixir    # http://localhost:8080/

`build.py` needs the native install (`target/rotp`, from
`tools/rotp/install.exs`) and Docker (`DOCKER`, default `sudo -n docker`):
it runs the site's first command in the WebAssembly node under Node with
every file fetched lazily, and records which files it fetches. Those go
in `fs/boot.tar.gz` (Elixir: about 4 MB; Phoenix: about 18 MB); the rest
are listed in `fs/manifest.json` and fetched one by one, the first time
the node opens them. They are served in bundles (`fs/bundles/N.tar`,
a directory's files up to 512 KB each), so a miss brings its neighbours
too.

Under Node (24; 22's WASI crashes partway through a boot), without a
browser:

    printf '1 + 1\n' | docker run --rm -i -v $PWD/playground/runtime:/w:ro \
      -v $PWD/target/playground/elixir:/d:ro node:24 node /w/node.mjs /d \
      -noshell -elixir_root /rotp/lib -pa /rotp/lib/elixir/ebin \
      -user elixir -extra --no-halt +iex

## Deploying

A site is static: rsync `target/playground/SITE/` to the server. Standard
input reaches the worker through a SharedArrayBuffer, which needs
cross-origin isolation, so the server sends COOP and COEP headers. With
Caddy:

    elixir-playground.steffend.me {
        root * /srv/elixir-playground
        header {
            Cross-Origin-Opener-Policy same-origin
            Cross-Origin-Embedder-Policy credentialless
        }
        # .beam files are application/octet-stream, which Caddy does not
        # compress by default.
        encode zstd gzip {
            match {
                header Content-Type text/*
                header Content-Type application/*
            }
        }
        file_server
    }
