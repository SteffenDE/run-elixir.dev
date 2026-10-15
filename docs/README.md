---
kind: index
status: live
last_updated: 2026-10-15
---

# Playground documentation

The Elixir Playground runs Rust-OTP (`crates/rotp`), compiled to
`wasm32-wasip1`, in the browser: OTP 29 and Elixir 1.20 boot in Web Workers
from an in-memory filesystem. One static site
(`playground/app`, its runtime in `src/runtime`; elixir-playground.steffend.me)
holds every project:

- **Phoenix project** (`/phoenix`): an IDE around a `phx.new` app. File
  tree, editor tabs, shells in terminal tabs (the first runs
  `iex -S mix phx.server`), a live preview of the app, PGlite as its
  Postgres, Tailwind on the page.
- **Empty project** (`/empty`): the same IDE over an empty `/work`, with a
  shell; the preview shows once something listens.
- **Temporary IEx** (`/iex`): an empty project whose first shell runs IEx,
  kept nowhere.

Projects live at `/ID/` and are kept in the browser's IndexedDB: what they
changed over their template, and their database. A backend
(`playground/backend`) builds packages' NIF libraries on request.

## Start here

```sh
python3 -I playground/runtime/build.py        # → target/playground/site
python3 -I playground/runtime/serve.py 8081   # http://localhost:8081/
```

The build needs the native Rust-OTP install (`target/rotp`, from
`tools/rotp/install.exs`) and Docker (for Node, the recording runs and the
Vite build). See [build.md](build.md).

## Documents

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The moving parts: page, workers, service worker, shared files, how a request reaches Phoenix. |
| [projects.md](projects.md) | Projects: kinds, URLs, what is stored where, one tab per project, deleting; plans for sharing and collaboration. |
| [runtime.md](runtime.md) | `playground/app/src/runtime`: the WASI shim, its filesystem, network, programs, shared files, and the page/worker protocols. |
| [rotp-wasm.md](rotp-wasm.md) | What Rust-OTP does differently on `wasm32-wasip1`. |
| [nif.md](nif.md) | NIF libraries as WebAssembly: the erl_nif layer, building packages' native code. |
| [backend.md](backend.md) | `playground/backend`: NIF builds on request in Firecracker VMs, templates and the agent that writes them, admin, deploying. |
| [build.md](build.md) | `build.py`: boot images, bundles, the Phoenix template, the Vite build; `node.mjs`. |
| [ide.md](ide.md) | The app (`playground/app`): home page, the project IDE, Tailwind on the page, the preview, terminals and their links. |
| [deploy.md](deploy.md) | Deploying (the deploy branch, releases on the server, rollback) and serving the site: headers, routes, compression, caching (Caddy). |
| [testing.md](testing.md) | The Playwright tests and the Node harness. |
| [status.md](status.md) | What works, known gaps, and what comes next. |
