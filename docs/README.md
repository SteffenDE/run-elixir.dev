---
kind: index
status: live
last_updated: 2026-10-18
---

# Playground documentation

The Elixir Playground runs OTP's own emulator, built to WebAssembly with
Emscripten (`beam/`), in the browser: OTP 29 and Elixir 1.20 boot in Web
Workers from an in-memory filesystem. One static site
(`app`, its runtime in `src/runtime`; elixir-playground.steffend.me)
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
(`backend`) builds packages' NIF libraries on request.

## Start here

```sh
python3 -I runtime/build.py        # → target/site
python3 -I runtime/serve.py 8081   # http://localhost:8081/
```

The build needs emsdk 6.0.2 (`~/emsdk`), the host's Erlang 29.1.1 and
Elixir 1.20.4, and Docker (for Node, the recording runs and the Vite
build). See [build.md](build.md).

The playground on Rust-OTP (beamos's `crates/rotp`, compiled to
`wasm32-wasip1`) lives on in the local `rotp` branch, built against a
beamos checkout (`BEAMOS`, or `../beamos`).

## Documents

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The moving parts: page, workers, service worker, shared files, how a request reaches Phoenix. |
| [projects.md](projects.md) | Projects: kinds, URLs, what is stored where, one tab per project, deleting; plans for sharing and collaboration. |
| [collaboration.md](collaboration.md) | Plan: *Share* as a link or a live session; the encrypted relay, permissions, editing with Yjs, terminals and preview for guests. |
| [git.md](git.md) | Plan: git in a project (clone, a diff view, push and its tokens), signing in, and the origins that keep a project's code from the account. |
| [runtime.md](runtime.md) | `app/src/runtime`: the node's filesystem, network, programs, shared files, NIF libraries' WASI, and the page/worker protocols. |
| [../beam/README.md](../beam/README.md) | The runtime: OTP's own emulator built with Emscripten, its patches, build, benchmarks, how it runs in the playground. |
| [distribution.md](distribution.md) | Plan: Erlang distribution between a project's nodes, and Livebook; the proof of concept and an estimate. |
| [nif.md](nif.md) | NIF libraries as WebAssembly: the erl_nif layer, building packages' native code. |
| [backend.md](backend.md) | `backend`: NIF builds on request in Firecracker VMs, templates and the agent that writes them, admin, deploying. |
| [build.md](build.md) | `build.py`: boot images, bundles, the Phoenix template, the Vite build; `node.mjs`. |
| [ide.md](ide.md) | The app (`app`): home page, the project IDE, Tailwind on the page, the preview, terminals and their links. |
| [deploy.md](deploy.md) | Deploying (the deploy branch, releases on the server, rollback) and serving the site: headers, routes, compression, caching (Caddy). |
| [testing.md](testing.md) | The Playwright tests and the Node harness. |
| [status.md](status.md) | What works, known gaps, and what comes next. |
