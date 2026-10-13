---
kind: index
status: live
last_updated: 2026-10-13
---

# Playground documentation

The playgrounds run Rust-OTP (`crates/rotp`), compiled to `wasm32-wasip1`, in
the browser: OTP 29 and Elixir 1.20 boot in a Web Worker from an in-memory
filesystem, with no server-side code. There are two sites:

- **Elixir playground** (`playground/elixir`, elixir-playground.steffend.me):
  IEx in a terminal.
- **Phoenix playground** (`playground/phoenix`,
  phoenix-playground.steffend.me): an IDE around a `phx.new` app. It has a
  file tree, editor tabs, shells in terminal tabs (the first runs
  `iex -S mix phx.server`), a live preview of the app, and PGlite as its
  Postgres. Tailwind runs on the page.

## Start here

```sh
python3 -I playground/runtime/build.py phoenix        # → target/playground/phoenix
python3 -I playground/runtime/serve.py phoenix 8081   # http://localhost:8081/
```

The build needs the native Rust-OTP install (`target/rotp`, from
`tools/rotp/install.exs`) and Docker (for Node, the recording run and the
Vite build). See [build.md](build.md).

## Documents

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The moving parts: page, workers, service worker, file server, how a request reaches Phoenix. |
| [runtime.md](runtime.md) | `playground/runtime`: the WASI shim, its filesystem, network, programs, shared files, and the page/worker protocols. |
| [rotp-wasm.md](rotp-wasm.md) | What Rust-OTP does differently on `wasm32-wasip1`. |
| [build.md](build.md) | `build.py`: the image, the boot set, bundles, the Phoenix app, the Vite build; `node.mjs`. |
| [ide.md](ide.md) | The Phoenix IDE (`playground/phoenix`): its React app, Tailwind on the page, the preview, terminals. |
| [deploy.md](deploy.md) | Serving a site: headers, compression, caching (Caddy). |
| [testing.md](testing.md) | The Node harness and the Playwright tests in `playground/tests`. |
| [status.md](status.md) | What works, known gaps, and what comes next. |
