---
kind: index
status: live
last_updated: 2026-10-23
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

The build needs emsdk 6.0.2 (`~/emsdk`), the host's Erlang 29.1.2 and
Elixir 1.20.4, and Docker (for Node, the recording runs and the Vite
build). See [build.md](build.md).

The playground on Rust-OTP (beamos's `crates/rotp`, compiled to
`wasm32-wasip1`) lives on in the local `rotp` branch, built against a
beamos checkout (`BEAMOS`, or `../beamos`).

## Documents

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The moving parts: page, workers, service worker, shared files, how a request reaches Phoenix. |
| [frames.md](frames.md) | The apex as the one trusted origin; previews (and next, the project's runtime) in frames of the usercontent domain; measurements. |
| [embed.md](embed.md) | Experiment: run-elixir.dev embedded by another site (Tidewave's IDE): embed.js and embed.html, the API, who may embed it, versions, archives of natively built apps, headers. |
| [projects.md](projects.md) | Projects: kinds, URLs, what is stored where, one tab per project, deleting; plans for sharing and collaboration. |
| [collaboration.md](collaboration.md) | Plan: *Share* as a link or a live session; the encrypted relay, permissions, editing with Yjs, terminals and preview for guests. |
| [git.md](git.md) | git in a project: git itself built to WebAssembly (git.wasm), the shell's and the nodes' only git, its processes, HTTPS transport and git's own test suite; the diff view, a repository opened as a project, push to GitHub and its token; plans for signing in, and the origins that keep a project's code from the account. |
| [tools.md](tools.md) | Plan: GNU sed, grep, diffutils, findutils and a POSIX awk built with wasi-sdk over a shared C layer, measured by git's suite. |
| [history.md](history.md) | Plan: every moment of a project's files and database, content-addressed in git's format; churn from `_build`, `deps` and `node_modules`; restoring at once. |
| [runtime.md](runtime.md) | `app/src/runtime`: the node's filesystem, network, programs, shared files, NIF libraries' WASI, and the page/worker protocols. |
| [../beam/README.md](../beam/README.md) | The runtime: OTP's own emulator built with Emscripten, its patches, build, benchmarks, how it runs in the playground. |
| [tailscale.md](tailscale.md) | Prototype: the node's HTTPS, TCP, UDP and names through the user's tailnet and an exit node; one Tailscale device per browser on the apex, its tag and policy, each project asked first, a project's servers shared in the tailnet, the setup hint shown once. |
| [relay.md](relay.md) | Prototype: the backend's TCP relay for a few hosts without CORS headers (GitHub, GitLab, Codeberg, Anthropic's console) without a tailnet; its list, its socket's frames, the ClientHello check and its limits. |
| [distribution.md](distribution.md) | Plan: Erlang distribution between a project's nodes, and Livebook; the proof of concept and an estimate. |
| [nif.md](nif.md) | NIF libraries as WebAssembly: the erl_nif layer, building packages' native code. |
| [nodejs.md](nodejs.md) | Experiment: Node.js, npm and npx on the page's engine, worker threads and WASI, a node's `sh -c` in brush, Vite. |
| [backend.md](backend.md) | `backend`: NIF builds on request in Firecracker VMs, templates and the agent that writes them, admin, deploying. |
| [build.md](build.md) | `build.py`: boot images, bundles, the Phoenix template, the Vite build; `node.mjs`. |
| [ide.md](ide.md) | The app (`app`): home page, the project IDE, Tailwind on the page, the preview, terminals and their links. |
| [deploy.md](deploy.md) | Deploying (the deploy branch, releases on the server, rollback) and serving the site: headers, routes, compression, caching (Caddy). |
| [testing.md](testing.md) | The Playwright tests and the Node harness. |
| [status.md](status.md) | What works, known gaps, and what comes next. |
