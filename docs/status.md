---
kind: status
status: live
last_updated: 2026-10-16
---

# Status

## Works

- **One site with projects** (Chromium, Firefox and WebKit): a home page;
  Phoenix, empty and temporary IEx projects at their own paths; files and the
  database kept in IndexedDB over the template; several projects in
  several tabs, one tab per project with a handover; deleting a project
  deletes its storage.
- **Temporary IEx.** Answers about 1.4 s after load (Chromium). Modules
  load lazily; colours, IEx's own line editing (tab completion, history,
  the terminal's width), Ctrl+C.
- **Hex.** `mix deps.get` fetches packages through the page (Jason: fetched,
  compiled and used in about 20 s in Chromium and Firefox).
- **NIFs built to WebAssembly** ([nif.md](nif.md)): a package the site
  has a build of (bcrypt_elixir 3.3.2, argon2_elixir 4.1.3, picosat_elixir
  0.2.3; lazy_html 0.1.13, C++ with exceptions, which the Phoenix
  template's tests use) compiles in a
  project, its `make` unpacking the library, and its NIFs run in the
  node's worker (fetched, built and used in about 13–16 s in each
  browser).
- **Live sessions** ([collaboration.md](collaboration.md)): *Share*
  starts one; guests join with the link and see the project as it runs
  in the host's tab, its tree, terminals, files and preview (their own
  cookies and LiveView), end-to-end encrypted through the backend's
  relay. Files open in the session are Yjs documents, edited together
  with each other's carets; the host chooses who may edit, use the
  terminals or fork, and may ask before letting each guest in.
- **The backend** ([backend.md](backend.md), run-elixir.steffend.me,
  deployed with docker compose on anubis): builds a Hex release's NIF
  library on request (`/api/nif/`) in a Firecracker VM, from a template
  for its package (build.py's four recipes are the seeds; each builds
  the same library as build.py, lazy_html in 24 s), or, without one, from
  a template an agent (OpenAI, through ReqLLM) writes and that later
  versions reuse. Failures and new templates are notified (Web Push);
  admins sign in with GitHub. A version the site has not built is asked
  of it by `make`, which waits while it builds; the page says so in a
  dialog. Tested with the API stubbed (Chromium); bcrypt_elixir and
  argon2_elixir built through production. No real agent session has run
  yet.
- **Several schedulers** (`rotp-threads.wasm`, `min(4,
  hardwareConcurrency)`; [architecture.md](architecture.md)): Ecto's
  `deps.compile` about 1.9× faster than one scheduler in each browser
  (Chromium 24.1 s). Without cross-origin isolation's shared memory a node
  runs one scheduler from `rotp.wasm`.
- **An Ash app** (`mix igniter.new … --install ash,ash_phoenix,
  ash_postgres,ash_authentication,ash_authentication_phoenix,ash_admin
  --auth-strategy magic_link --setup --yes`) is generated, compiled and
  installed: 2299 s in Chromium on a 12-core AMD machine with four
  schedulers, BEAM `+S 4` 314 s
  ([log](../../docs/log/2026-10-15.md#playground-the-ash-app)); measured
  before the day's later runtime fixes, which took Ash's own compile from
  157 s to about 135 s natively. Starting it needed mnesia, which every
  Ash app starts and the installation now has; not yet tried in the
  browser.
- **git dependencies.** Through the page and the site's proxy: heroicons
  as phx.new adds it (a tag, sparse, depth 1) in 14 s (Chromium), and
  again from the lock.
- **Sharing:** a link carries a project's changes over its template; opening
  it makes a new project with them (Phoenix included).
- **A project per origin** with a project domain (`p-ID.DOMAIN`; the apex
  keeps the list): [projects.md](projects.md#a-project-domain).
- **Rust-OTP programs and shell lines from a node:** `System.cmd("mix", …)`,
  `System.shell` lines and rebar3 run as nodes of their own, so a phx.new
  1.6 app's deps (rebar3's included) compile, and its server runs.
- **HTTPS from a node** by the page's `fetch()`, to sites with CORS (hex.pm's
  API: igniter's version lookups).
- **Phones:** one pane at a time.
- **Terminals** fit their panels and link source locations to the editor
  and addresses to the preview.
- **Phoenix projects** (Chromium, Firefox and WebKit):
  - The server runs about 7 s after load. Pages serve in about 200–400 ms,
    and static files in milliseconds.
  - Ecto through PGlite.
  - LiveView over WebSockets (the bridge's).
  - Phoenix LiveDashboard (`/dev/dashboard`) over the same WebSocket: every
    page, and the details of processes, ports, ETS tables and applications.
  - `mix phx.gen.auth … --hashing-lib pbkdf2`: generated, `pbkdf2_elixir`
    from Hex, migrated (citext), and a user registered in the preview.
  - Editing and saving with recompilation on the next request; Tailwind and
    esbuild (esbuild-wasm, the template's watcher) on the page, never
    downloaded for any project.
  - Several shells: `mix phx.gen.live`, `mix ecto.migrate` and others run in
    one while the server runs in another.
  - `mix test`, LiveView tests too (lazy_html as a NIF): about 5 minutes
    the first time, for the test environment's dependencies (Chromium).
  - The preview pops out into its own window.
  - After a reload, the server is back in about 6 s without recompiling
    dependencies.

## Known gaps

**In Rust-OTP**
- **LiveDashboard shows less than on ERTS:** no OS data (no `os_mon`),
  no sockets (Rust-OTP's sockets are not ports), 0 atoms (atoms are
  values, not table entries), no allocators, and memory sizes Rust-OTP
  does not measure (every process reports a fresh process's 2.6 KB).
- `file_system` finds no `inotifywait`, so Phoenix's live reload is off, and
  boot logs the warning. A small `inotifywait` program fed by `files.js`
  changes would quiet it and could drive live reload, now that its socket
  has a WebSocket.
- **NIFs** load only as WebAssembly built for the playground
  ([nif.md](nif.md)): the site has bcrypt_elixir 3.3.2, argon2_elixir
  4.1.3, picosat_elixir 0.2.3 and lazy_html 0.1.13; the backend builds
  other versions and packages, as far as a template or its agent can.
  When neither can, `make` fails, and a module whose on_load loads a
  native library stays unloaded, as on ERTS without the library. The
  backend's library is built with its own toolchain, which the request
  does not check against the page's yet (plan in
  [backend.md](backend.md#plan-one-source-of-nif-builds)).
  Resources live as long as their library (the node does not report
  collected references); NIF threads, `enif_select` and monitors are
  missing; rustler_precompiled packages still try to download.

**In the playground**
- **Compiling is about 7× BEAM** (the Ash app above, before the day's later
  fixes), most of it the interpreter: a new app's deps take minutes. The
  plans: prebuilt deps, and a faster interpreter
  ([interpreter.md](../../docs/design/interpreter.md#where-it-stands-2026-10-15)).
- **git in the shell:** `clone` and fast-forward `pull` from GitHub,
  GitLab and Codeberg, besides what Mix asks; no commits, diffs or pushes
  yet ([git.md](git.md)).
- **HTTPS from a node** goes by the page's `fetch()` (`https.ts`): only
  to sites that send CORS headers (hex.pm's API does; most others do not:
  502), HTTP/1.1 only, one request per connection, without the headers
  the browser sets itself. Other protocols over TLS have no route. A relay
  through the site (an allow-listed TCP relay, on a Phoenix API app) is
  the plan for the rest.
- **Shell commands from a node** (`System.shell`, `{spawn, Command}`) run
  only `mix`, `elixir`, `iex`, `erl`, `escript` and `cd`, joined by `&&`,
  each as a node of its own; `os:cmd` (which writes its command to the
  shell's input) does not run.
- **Nodes reach each other only through the page's ports** (5432, 4000).
  Mix's compile lock checks its holder over TCP, which another shell's node
  cannot reach, so two shells compiling at once can both proceed. The page
  could route a node's connection to the node listening on that port, as
  it routes the preview's.
- **`mix ecto.migrate` right after `mix deps.get`** of a new dependency
  (after `phx.gen.auth`) fails to start `ecto_sql` (`eex.app` not found):
  compiling the new dependencies pruned `eex` from the code path before
  the app's own compile adds it back. Only in the browser (host OTP and
  native Rust-OTP in the same sequence pass); not yet understood. `mix
  compile` first avoids it.
- **PGlite is one session,** so Ecto's pool is 1, and two shells using the
  database at once share it.
- **Changes under a second old** are lost when the tab closes (files are
  written a second after they change).
- **A new site build** drops a Phoenix project's kept template build; Mix
  recompiles its changed sources. An empty project's `_build` is kept as it
  is, even if a new `rotp.wasm` would compile differently.
- **Long sessions:** each node's frame ring counts bytes in an Int32, so a
  session that sends it 2 GB would wrap.
- **esbuild's options** are the common ones (ide.md); plugins, a metafile
  and `--serve` are not there, and a change before the watcher starts is
  bundled only by its first build, without a preview reload.
- **No Tailwind minification;** Tailwind's candidate scan is a
  plain split, not the oxide scanner.

**In the build**
- **Phoenix's tailwind download** (`mix assets.setup`) through Rust-OTP's
  httpc was killed downloading the 100 MB binary natively; `build.py`
  uses curl.
- **No gate job** builds or tests the playground yet.
- **The browser tests** fetch and compile the runtime afresh in every test
  ([testing.md](testing.md#not-yet-caching-the-runtime-between-tests)).

## Next

1. `mix phx.new` with prebuilt deps and a Hex cache; with bcrypt_elixir
   built, `phx.gen.auth` with its default hashing library.
2. More NIF packages ([nif.md](nif.md)): exqlite; Rustler
   NIFs (rustler_precompiled). The backend as the one source of NIF
   builds, the request naming the page's layer
   ([backend.md](backend.md#plan-one-source-of-nif-builds)); a first real
   agent session. The template's test build prebuilt, so `mix test`
   starts at once.
3. `ecto.migrate`'s pruned `eex` after a new dependency.
4. Routing a node's connection to another node's listener (Mix's locks).
5. A gate job for the playground tests; a persistent browser context per
   test worker.
6. Zip export and import of a project ([projects.md](projects.md#plans)).
7. A TCP relay through the site for the node's other connections
   (allow-listed hosts, TLS in the node), as an API-only Phoenix app the
   collaboration relay can grow from.
8. Live sessions: what is left
   ([collaboration.md](collaboration.md#not-built-yet)); `/socket` on
   elixir-playground.steffend.me too.
9. Compile speed: within 3–4× of BEAM on the Ash app (now about 7×).
