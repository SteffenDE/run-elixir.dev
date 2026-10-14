---
kind: reference
status: live
last_updated: 2026-10-13
---

# Testing

There is no gate job for the playground yet. These are the checks used while
building it.

## In browsers: Playwright (`playground/app/test/e2e`)

`@playwright/test` 1.64 (Chrome 156, Firefox 157, WebKit as in Safari 27.2), run in the Playwright
Docker image against the built site:

```sh
python3 -I playground/runtime/build.py                   # or `build.py app` after page changes
playground/tests/run.sh                                  # Chromium, Firefox and WebKit
playground/tests/run.sh --project=chromium terminal      # one browser, one file
SLOW=1 playground/tests/run.sh --project=chromium shells # the slow ones too
```

`run.sh` mounts the repository and runs `npx playwright test` in
`playground/app` (its `node_modules` must be installed: `npm ci` there, in
Docker). The config (`playwright.config.ts`) serves the site with
`runtime/serve.py` on `PORT` (8081) unless something already listens there,
runs `WORKERS` (3) tests at a time, and leaves tests tagged `@slow` to
`SLOW=1`. Results, failure screenshots and traces go to
`target/playground-tests/`.

Each test gets a fresh browser context, so its IndexedDB starts empty.
`fixtures.ts` fails a test on an uncaught page error; `helpers.ts` drives
the page through `window.playground`, and `syncLV(page or frame)` waits for
a connected LiveView with nothing pending (before and after clicks and
submits) (`node`, `output`, `sessions`,
`files`, `database`, `openTerminal`).

| Spec | Checks |
| --- | --- |
| `projects` | The home page; a temporary IEx answers and is ephemeral; an empty project gets a shell, is listed and deleted; renaming; an unknown id; a project starts after a forced reload. |
| `persist` | An empty project's files, and a Phoenix project's edited, removed and moved template files, are there after a reload; the server comes back without recompiling dependencies. |
| `database` | A Phoenix project's PGlite rows survive a reload; deleting the project deletes both of its databases. |
| `tabs` | Two Phoenix projects in two tabs each show their own app, also after the service worker stops (Chromium); a third tab takes one over. |
| `terminal` | Terminals fit their panel after resizes; a `path:line` opens the file at that line; an address opens in the preview. |
| `edit` | A heading typed in the editor and saved shows in the preview, and Tailwind builds its class; a change to `assets/js/app.js` is bundled by the esbuild watcher and runs in the reloaded preview. |
| `preview` | The path bar navigates and a reload stays; the preview pops out and docks; it comes back after the service worker stops (Chromium). |
| `hex` | In an empty project, a Mix app depending on Jason: `mix deps.get` fetches it through the page and `mix run` uses it. |
| `rebar3` | `System.cmd` runs `elixir` and `mix` from `PATH` as nodes; a shell line ending in `\` goes on; `System.shell` runs a command line as a node (`elixir -e`, `cd /tmp && …`, in the node's `File.cd` directory, an unknown command answers 127); a Mix app depending on telemetry, a rebar3 package, builds it with rebar3 and uses it. |
| `esbuild` | In an empty project, a Mix app depending on the Hex esbuild package: `Esbuild.bin_path()` is the page's program, and `mix esbuild default` downloads nothing, warns that the configured version (0.12.18) is not the page's, and bundles a relative import, an `@` alias, an external and CSS with `data:` and remote URLs. |
| `https` | httpc in an empty project gets hex.pm's API (200, JSON) through the page's fetch; a site without CORS headers answers 502 with why. |
| `domain` (project `domain`, Chromium) | With a project domain (`serve.py --domain playground.localhost:8082`, which the config starts): an empty project runs on its own origin; renamed there, the apex lists it, marks it open, refuses to delete it while open and deletes it once closed; an old `/ID/` link and a share link reach a project's origin; a Phoenix project's preview and LiveDashboard (its redirect too) on its origin. |
| `git` | heroicons as phx.new adds it (tag, sparse, depth 1): fetched and checked out sparsely, the lock checked, and fetched again from the lock. |
| `tree` | Files and folders made, renamed, moved (Chromium) and deleted from the tree, kept across a reload. |
| `share` | An empty project (text and bytes) and a Phoenix project (an edited and a removed template file) shared as links and opened in a fresh browser context; a damaged link. |
| `phone` | At 390×844: the home page and projects fit, one pane at a time, a Phoenix project opens on its preview. |
| `websocket` | A WebSocket from the preview to `/live/websocket` gets Phoenix's heartbeat reply; LiveDashboard (path bar `/dev/dashboard`) connects over `:websocket`, shows its home page and a process's details. |
| `auth` (`@slow`) | `phx.gen.auth --hashing-lib pbkdf2` in a second shell, `deps.get`, `compile`, `ecto.migrate`, the server restarted, a registration in the preview over LiveView's WebSocket (flash, PGlite row). About 1.2 min. |
| `shells` (`@slow`) | A second shell runs `mix phx.gen.live`, patches the router and migrates while the server runs; the generated form saves a post. Minutes. |

Typical times: all three browsers' 102 tests in about 8 minutes, or
Chromium's 34 in about 2.7; Firefox's and WebKit's take about as long each
(`hex` 25 s against 22, `rebar3` 26 against 26, `https` 32 against 33).

**WebKit needs `require-corp`.** It does not take
`Cross-Origin-Embedder-Policy: credentialless`: with it the page is not
cross-origin isolated, has no SharedArrayBuffer, and the playground starts
nothing. So `serve.py`, the deployment and the service worker send
`require-corp`. WebKit also reports a `fetch()` that CORS blocks as an
uncaught page error, though `https.js` catches it; the fixture leaves that
one out. `tree` fails a focus check under heavy load (four workers and all
three browsers), in Chromium too, and passes alone.

Playwright before 1.64 shipped a Firefox (141) without an optimizing
WebAssembly compiler, which ran `rotp.wasm` about 10× slower than Chromium
(`Enum.reduce(1..3_000_000, 0, &+/2)`: 8.6 s against 0.9 s); Firefox 157
has one.

## Without a browser: `node.mjs`

The Node harness ([build.md](build.md#the-node-harness-runtimenodemjs)) runs
the site's node with the same shim. It is the quickest way to see what a
node does: boot errors, a request's status and headers, which files are
fetched, every WASI call. For example, IEx with input:

```sh
printf '1 + 1\n' | docker run --rm -i -v $PWD/playground/runtime:/w:ro \
  -v $PWD/target/playground/site:/d:ro -e BOOT=boot node:24 node /w/node.mjs /d \
  -noshell -elixir_root /rotp/lib -pa /rotp/lib/elixir/ebin \
  -user elixir -extra --no-halt +iex
```

It does not cover the page's parts: shared files and their storage, page
programs (Tailwind), the service worker, PGlite.

## After changing the runtime

- **Native Rust-OTP:** `ROTP_INSTALL=$PWD/target/rotp python3 -I
  scripts/test-rotp.py`, plus clippy for both targets:
  - `CARGO_TARGET_DIR=target/clippy cargo clippy -q -p rotp --all-targets --
    -D warnings`
  - `CARGO_TARGET_DIR=target/wasm cargo clippy -q --target wasm32-wasip1 -p
    rotp -- -D warnings`
- **The app:** `npm run lint`, `npm run format:check`, `tsc --noEmit` (part
  of `npm run build`).
- **The browsers:** the Playwright suite in Chromium, Firefox and WebKit.

## Not yet: caching the runtime between tests

A fresh context starts with an empty HTTP cache, so every test fetches and
compiles `rotp.wasm` and unpacks its boot images again. Fetching from
`serve.py` is cheap; compiling and unpacking per worker is not. A
persistent context per Playwright worker (one profile, its IndexedDB and
storage cleared between tests) would keep the HTTP cache and the compiled
code; measuring how much of a boot each step takes comes first.
