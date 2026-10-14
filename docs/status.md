---
kind: status
status: live
last_updated: 2026-10-13
---

# Status

## Works

- **One site with projects** (Chromium and Firefox): a home page; Phoenix,
  empty and temporary IEx projects at their own paths; files and the
  database kept in IndexedDB over the template; several projects in
  several tabs, one tab per project with a handover; deleting a project
  deletes its storage.
- **Temporary IEx.** Answers about 1.4 s after load (Chromium). Modules
  load lazily; colours, history, Ctrl+C.
- **Hex.** `mix deps.get` fetches packages through the page (Jason: fetched,
  compiled and used in about 20 s in Chromium and Firefox).
- **git dependencies.** Through the page and the site's proxy: heroicons
  as phx.new adds it (a tag, sparse, depth 1) in 14 s (Chromium), and
  again from the lock.
- **Sharing:** a link carries a project's changes over its template; opening
  it makes a new project with them (Phoenix included).
- **Phones:** one pane at a time.
- **Terminals** fit their panels and link source locations to the editor
  and addresses to the preview.
- **Phoenix projects** (Chromium and Firefox):
  - The server runs about 7 s after load. Pages serve in about 200–400 ms,
    and static files in milliseconds.
  - Ecto through PGlite.
  - LiveView over WebSockets (the bridge's).
  - Phoenix LiveDashboard (`/dev/dashboard`) over the same WebSocket: every
    page, and the details of processes, ports, ETS tables and applications.
  - `mix phx.gen.auth … --hashing-lib pbkdf2`: generated, `pbkdf2_elixir`
    from Hex, migrated (citext), and a user registered in the preview.
  - Editing and saving with recompilation on the next request; Tailwind on
    the page.
  - Several shells: `mix phx.gen.live`, `mix ecto.migrate` and others run in
    one while the server runs in another.
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
- **NIFs** do not load (Rust-OTP loads no native libraries): a module whose
  on_load loads one stays unloaded, as on ERTS without the library. So
  `phx.gen.auth` needs `--hashing-lib pbkdf2`; its default on Linux,
  bcrypt_elixir, is a NIF.
- WASI has no symlinks: Phoenix warns that its code reloader would be faster
  with them. `priv` and colocated assets are copies.

**In the playground**
- **`mix phx.new`** in the playground is untested beyond the archive being
  there: Hex and git dependencies work, but compiling a new app's deps in
  WebAssembly takes minutes on one scheduler. The plans: prebuilt deps for
  phx.new's default lock, and several schedulers (wasm32-wasip1-threads).
- **git in the shell:** only what Mix asks (`git` is a program, not a shell
  command yet); no pushes.
- **HTTPS from a node** goes by the page's `fetch()` (`https.js`): only
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

1. `mix phx.new` with prebuilt deps and a Hex cache.
2. `ecto.migrate`'s pruned `eex` after a new dependency.
3. Routing a node's connection to another node's listener (Mix's locks).
4. A gate job for the playground tests; a persistent browser context per
   test worker.
5. Zip export and import of a project ([projects.md](projects.md#plans)).
6. A TCP relay through the site for the node's other connections
   (allow-listed hosts, TLS in the node), as an API-only Phoenix app the
   collaboration relay can grow from.
7. Collaboration ([projects.md](projects.md#plans)).
8. Several schedulers (wasm32-wasip1-threads).
