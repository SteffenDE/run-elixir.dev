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
- `elixir/`: IEx in xterm.js (elixir-playground.steffend.me).

## Build and try

    python3 -I playground/runtime/build.py elixir    # into target/playground/elixir
    python3 -I playground/runtime/serve.py elixir    # http://localhost:8080/

`build.py` needs the native install (`target/rotp`, from
`tools/rotp/install.exs`): it boots IEx on it to record which files a boot
reads. Those go in `fs/boot.tar.gz` (about 4 MB); the rest are listed in
`fs/manifest.json` and fetched one by one, the first time the node opens
them.

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
