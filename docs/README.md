---
kind: index
status: live
last_updated: 2026-10-23
---

# Playground documentation

The playground runs OTP 29 and Elixir 1.20 in browser workers using
OTP's emulator compiled to WebAssembly. The React IDE runs on the apex
origin; project code and previews run on a separate usercontent domain.
Files and databases are stored in the browser's IndexedDB.

Three project types are available:

- **Phoenix** (`/phoenix`): a `phx.new` app with an editor, terminals,
  live preview, and a PGlite database. Its default startup command runs
  `iex -S mix phx.server`.
- **Empty** (`/empty`): an empty `/work` directory and a shell. The
  preview appears when a server starts.
- **Temporary IEx** (`/iex`): an IEx session whose files are not saved.

The backend builds NIF libraries, relays encrypted live sessions, and
provides a restricted TCP relay for HTTPS connections.

## Start here

Follow [build.md](build.md#requirements) to install the toolchains and
build the required WebAssembly programs. Then build and serve the site:

```sh
python3 -I runtime/build.py
python3 -I runtime/serve.py 8081 \
  --domain playground.localhost:8081 --usercontent usercontent.localhost:8081
```

Open `http://playground.localhost:8081/`. A project needs both domains.
For UI changes to an existing build, use `python3 -I runtime/build.py app`.

The older Rust-OTP runtime is preserved on the local `rotp` branch.
Its build instructions and measurements do not describe the current runtime.

## Documents

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The moving parts: page, workers, service worker, shared files, how a request reaches Phoenix. |
| [frames.md](frames.md) | Origin isolation for the IDE, project runtime, previews, and Claude Code cache. |
| [embed.md](embed.md) | Embedding API, runtime versions, persistence, archives and required headers. |
| [projects.md](projects.md) | Project types, routes, storage, settings, imports, sharing, and tab ownership. |
| [collaboration.md](collaboration.md) | *Share* as a link or a live session; the encrypted relay, permissions, editing with Yjs, terminals and preview for guests. |
| [git.md](git.md) | Git commands, diffs, repository imports, GitHub push and planned account support. |
| [tools.md](tools.md) | GNU sed, grep, diffutils, gawk, and findutils: builds, compatibility limits, and Git test results. |
| [history.md](history.md) | Proposal for automatic file and database history; not implemented. |
| [runtime.md](runtime.md) | `app/src/runtime`: the node's filesystem, network, programs, shared files, NIF libraries' WASI, and the page/worker protocols. |
| [../beam/README.md](../beam/README.md) | The runtime: OTP's own emulator built with Emscripten, its patches, build, benchmarks, how it runs in the playground. |
| [tailscale.md](tailscale.md) | Tailnet setup, project permissions, network access and shared ports. |
| [relay.md](relay.md) | HTTPS relay: allowed hosts, consent, protocol and resource limits. |
| [distribution.md](distribution.md) | Erlang distribution between project nodes and tailnet nodes, plus Livebook setup and limitations. |
| [nif.md](nif.md) | NIF libraries as WebAssembly: the erl_nif layer, building packages' native code. |
| [nodejs.md](nodejs.md) | Browser Node.js compatibility, npm, Vite, Pi and Claude Code. |
| [backend.md](backend.md) | NIF build service, live-session relay, administration and deployment. |
| [build.md](build.md) | `build.py`: boot images, bundles, the Phoenix template, the Vite build; `node.mjs`. |
| [ide.md](ide.md) | The app (`app`): home page, the project IDE, Tailwind on the page, the preview, terminals and their links. |
| [deploy.md](deploy.md) | Deploying (the deploy branch, releases on the server, rollback) and serving the site: headers, routes, compression, caching (Caddy). |
| [testing.md](testing.md) | The Playwright tests and the Node harness. |
| [status.md](status.md) | What works, known gaps, and what comes next. |
