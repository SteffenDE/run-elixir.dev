---
kind: status
status: live
last_updated: 2026-10-13
---

# Status

## Works

- **Elixir playground.** IEx at about 1 s after load (Chromium). Modules
  load lazily; colours, history, Ctrl+C.
- **Phoenix playground** (Chromium; Firefox, slower):
  - The server runs about 7 s after load. Pages serve in about 200–400 ms,
    and static files in milliseconds.
  - Ecto through PGlite.
  - LiveView over long polling.
  - Editing and saving with recompilation on the next request; Tailwind on
    the page.
  - Several shells: `mix phx.gen.live`, `mix ecto.migrate` and others run in
    one while the server runs in another.
  - The preview pops out into its own window.

## Known gaps

**In Rust-OTP**
- Phoenix LiveDashboard (`/dev/dashboard/home`) fails with `:notsup`, which
  Plug.Debugger then hits again while rendering the error. Not yet
  investigated.
- `file_system` finds no `inotifywait`, so Phoenix's live reload is off (its
  socket needs a WebSocket anyway), and boot logs the warning. A small
  `inotifywait` program fed by `files.js` changes would quiet it and could
  drive live reload.
- WASI has no symlinks: Phoenix warns that its code reloader would be faster
  with them. `priv` and colocated assets are copies.

**In the playground**
- **esbuild** does not run on the page: app.js is prebuilt, so changes to
  `assets/js` do not take effect. esbuild-wasm behind the `esbuild` program,
  as Tailwind is, is the plan.
- **`mix phx.new`** in the playground is untested beyond the archive being
  there: a new app's `deps.get` needs Hex over the network, and compiling
  its deps in WebAssembly takes minutes. The plan is a bundled Hex cache and
  prebuilt deps for phx.new's default lock.
- **Nodes reach each other only through the page's ports** (5432, 4000).
  Mix's compile lock checks its holder over TCP, which another shell's node
  cannot reach, so two shells compiling at once can both proceed.
- **PGlite is one session,** so Ecto's pool is 1, and two shells using the
  database at once share it.
- **Nothing persists:** files and the database live as long as the tab.
- **Long sessions:** each node's frame ring counts bytes in an Int32, so a
  session that sends it 2 GB would wrap.
- **No esbuild or Tailwind minification;** Tailwind's candidate scan is a
  plain split, not the oxide scanner.

**In the build**
- **Phoenix's tailwind download** (`mix assets.setup`) through Rust-OTP's
  httpc was killed downloading the 100 MB binary natively; `build.py`
  uses curl.
- **No gate job** builds or tests the playgrounds yet.

## Next

1. esbuild-wasm as a page program, and the esbuild watcher back in the app's
   config.
2. `mix phx.new` with prebuilt deps and a Hex cache.
3. The LiveDashboard `:notsup` in Rust-OTP.
4. Persistence (files and PGlite in IndexedDB), and a gate job for the
   playground tests.
