---
kind: status
status: live
last_updated: 2026-10-23
---

# Status

The playground runs OTP's emulator compiled with Emscripten. This summary
describes the implementation as of 2026-10-23. Browser tests cover many
of these features; support for a feature does not mean every package or
browser combination has been tested.

## Works

- **Projects and persistence.** Phoenix, empty and temporary IEx projects;
  repository and folder imports; file editing, search, terminals and previews.
  Saved projects keep files and PGlite data in IndexedDB on the apex.
  Project code runs on a separate usercontent domain. A project keeps
  running while the user visits Settings or the project list.
  See [projects](projects.md), [IDE](ide.md) and [frames](frames.md).
- **Elixir and Phoenix.** IEx, Mix, Hex dependencies, rebar3, multiple
  shells, Ecto through PGlite, LiveView and LiveDashboard. Tailwind and
  esbuild run in the browser. Nodes in one project can connect to each
  other over TCP and UDP, including Erlang distribution.
  See [architecture](architecture.md) and [distribution](distribution.md).
- **Shell tools and Git.** Brush runs shell pipelines and scripts.
  WebAssembly builds provide coreutils, ripgrep, Git, sed, grep, diffutils,
  awk and find. Git supports local commits and diffs, cloning and fetching.
  The Changes panel pushes commits to GitHub through its REST API using
  a token stored in Settings. See [tools](tools.md) and [Git](git.md).
- **NIFs.** Bundled WebAssembly libraries cover selected package versions.
  Other packages or versions can request a build from the backend.
  Compatibility depends on the NIF APIs and build tools they need.
  See [NIFs](nif.md) and [backend](backend.md).
- **Networking.** Browser fetch handles HTTPS where CORS permits it.
  The optional [TCP relay](relay.md) carries TLS to an allowlist of hosts.
  [Tailscale](tailscale.md) provides broader TCP, UDP and DNS access,
  including Erlang distribution and sharing project ports in a tailnet.
- **JavaScript programs.** The browser-based [Node.js implementation](nodejs.md)
  runs supported Node APIs, npm, npx and Vite builds. Pi and Claude Code
  run on it, with network access through fetch, the relay or Tailscale.
- **Sharing and collaboration.** Share links copy a project's files.
  Live sessions provide collaborative editing, terminals and previews,
  with permissions controlled by the host. See [collaboration](collaboration.md).
- **Settings and embedding.** Browser-wide and project environment
  variables, startup commands, a setup script and shared files are
  implemented. The [embedding API](embed.md) exposes project runtimes to
  configured embedder sites.

## Known gaps

- **NIF compatibility:** native libraries must be rebuilt for WebAssembly.
  NIF threads, `enif_select` and monitors are not implemented. Library
  resources live until the node stops. Backend builds do not yet check
  their toolchain against the requesting runtime.
- **Node.js compatibility:** this is a browser implementation of Node
  APIs, not native Node.js. See its [module reference](nodejs.md) for
  supported APIs and restrictions.
- **Network access:** the relay permits only listed hosts on port 443.
  Other external TCP, UDP and DNS traffic needs Tailscale. Git's HTTPS
  helper still uses the site's `/git/` proxy.
- **Shell input:** `os:cmd`, which writes commands to the shell's standard
  input, is not supported. `System.shell` uses brush.
- **Database concurrency:** PGlite has one session. Connections take turns
  by transaction. After a transaction is idle for one second, another
  connection from the same node may join it; other nodes remain blocked.
- **Persistence:** file changes are saved after a one-second debounce.
  Closing the tab before that save can lose recent changes.
- **Build invalidation:** a new template version drops a Phoenix project's
  saved template build. An empty project's `_build` is retained, even if
  OTP or Elixir changed.
- **Browser coverage:** earlier testing found intermittent WebKit stalls
  during startup and `mix test`. Claude Code has been exercised in
  Chromium; equivalent Firefox and WebKit coverage is still needed.
- **Performance:** new dependencies can take minutes to compile. Historical
  measurements are recorded in [the BEAM documentation](../beam/README.md).
  They are not current performance guarantees.
- **Validation:** deployment has no browser-test gate. Tests use fresh
  browser contexts, which repeatedly load and compile the runtime.
  See [testing](testing.md).

An `ecto.migrate` failure involving a missing `eex.app` was observed on
Rust-OTP after adding a dependency. It has not been rechecked on the
current emulator; running `mix compile` first was the workaround.

## Next

Planned work includes prebuilt dependencies, broader NIF support,
[unified backend NIF builds](backend.md#plan-one-source-of-nif-builds),
[project archive import and export](projects.md#plans), a browser-test
gate, and further browser compatibility testing. Networking and session
follow-ups are tracked in [relay](relay.md#not-built-yet),
[Tailscale](tailscale.md#not-built-yet) and
[collaboration](collaboration.md#not-built-yet).

The Blink experiment is shelved. Its build notes and measurements remain
on the `worktree-blink` branch; it is not part of the current runtime.
