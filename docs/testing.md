---
kind: reference
status: live
last_updated: 2026-10-19
---

# Testing

There is no gate job for the playground yet. These are the checks used while
building it.

## In browsers: Playwright (`app/test/e2e`)

`@playwright/test` 1.64 (Chrome 156, Firefox 157, WebKit as in Safari 27.2), run in the Playwright
Docker image against the built site:

```sh
python3 -I runtime/build.py                   # or `build.py app` after page changes
tests/run.sh                                  # Chromium, Firefox and WebKit
tests/run.sh --project=chromium terminal      # one browser, one file
SLOW=1 tests/run.sh --project=chromium shells # the slow ones too
```

Debug a failure with that spec
alone in one browser: the whole suite takes over an hour with `SLOW=1`.

`run.sh` mounts the repository and runs `npx playwright test` in
`app` (its `node_modules` must be installed: `npm ci` there, in
Docker). The config (`playwright.config.ts`) serves the site with
`runtime/serve.py` on `PORT` (8081) unless something already listens there,
runs `WORKERS` (3) tests at a time, and leaves tests tagged `@slow` to
`SLOW=1`. Results, failure screenshots and traces go to
`target/tests/`.

The live session tests need the backend's relay: `mix phx.server` in
`backend` (on port 4000; [backend.md](backend.md#developing)).
The config serves the site for them on `PORT` + 2, and with a project
domain on `PORT` + 3, both with `--api http://localhost:4000`; without a
backend there, they are skipped.

Each test gets a fresh browser context, so its IndexedDB starts empty.
`fixtures.ts` fails a test on an uncaught page error; `helpers.ts` drives
the page through `window.playground`, and `syncLV(page or frame)` waits for
a connected LiveView with nothing pending (before and after clicks and
submits) (`node`, `output`, `sessions`,
`files`, `database`, `openTerminal`). A shell's output is what its screen
shows (`output()` reads the session's `screen`, scrollback and all):
brush's line editor repaints its line, so the stream it writes repeats
the prompt; a prompt on the screen is one per command.

| Spec | Checks |
| --- | --- |
| `projects` | The home page; a temporary IEx answers and is ephemeral; an empty project gets a shell, is listed and deleted; renaming; a folder from this computer (the picker) opens as a project without its `_build`, `deps`, `node_modules`, an editor's cache or what its `.gitignore` files ignore, and compiles; one too large opens once a directory is left out; an unknown id; a project that cannot start says why in a modal dialog; a project starts after a forced reload. |
| `persist` | An empty project's files, and a Phoenix project's edited, removed and moved template files, are there after a reload; the server comes back without recompiling dependencies. |
| `database` | A Phoenix project's PGlite rows survive a reload; deleting the project deletes both of its databases. |
| `tabs` | Two Phoenix projects in two tabs each show their own app, also after the service worker stops (Chromium); a third tab takes one over. |
| `terminal` | Terminals fit their panel after resizes; a `path:line` opens the file at that line; an address opens in the preview. |
| `edit` | A heading typed in the editor and saved shows in the preview, and Tailwind builds its class; a change to `assets/js/app.js` is bundled by the esbuild watcher and runs in the reloaded preview. |
| `preview` | The path bar navigates and a reload stays; the app's absolute links (also `_top` from a frame of it) and its pasted URL go to their paths in the preview; the bar shows the port and switches to a second endpoint's and back; the preview pops out and docks; it comes back after the service worker stops (Chromium). |
| `hex` | In an empty project, a Mix app depending on Jason: `mix deps.get` fetches it through the page and `mix run` uses it. |
| `rebar3` | `System.cmd` runs `elixir` and `mix` from `PATH` as nodes; a shell line ending in `\` goes on; `System.shell` runs a command line as a node (`elixir -e`, `cd /tmp && …`, in the node's `File.cd` directory, an unknown command answers 127); a Mix app depending on telemetry, a rebar3 package, builds it with rebar3 and uses it. |
| `esbuild` | In an empty project, a Mix app depending on the Hex esbuild package: `Esbuild.bin_path()` is the page's program, and `mix esbuild default` downloads nothing, warns that the configured version (0.12.18) is not the page's, and bundles a relative import, an `@` alias, an external and CSS with `data:` and remote URLs. |
| `nif` | In an empty project, a Mix app depending on bcrypt_elixir 3.3.2: `mix deps.get`, then `mix run` builds it (`make` unpacks the site's WebAssembly build) and hashes a password that `verify_pass` accepts, and rejects another. Another on lazy_html 0.1.13: built without downloading (cc_precompiler), it queries a fragment, and an invalid selector (a C++ exception) raises its message. Another on argon2_elixir 4.1.3 and picosat_elixir 0.2.3: a hash with two lanes verifies (and another password does not), and a formula is solved and another found unsatisfiable. Two on versions the site has not built, with the backend's `/api/nif/` stubbed (Chromium only: the node's requests go through the service worker, whose requests only Chromium lets a context route): bcrypt_elixir 3.3.1 queued, then set up (the dialog says an agent works on it), then built from the site's 3.3.2 library, and it hashes; 3.3.0 failed, so `make` and the dialog say why. |
| `brush` | The terminal's shell: variables and arithmetic, `mkdir -p … && touch … && ls \| wc -l`, `printf \| sort \| head`, `$(…)` into a file with `>` and `>>`, `wc -l <`, `cd`, a glob in a `for` loop, a node's output piped into `tr`, `2>/dev/null \|\|`, and 127 for an unknown command. Its line editor: Tab completes a path (`cat docs/no` → `docs/notes.txt`) and a command (`ech` → `echo`), Up recalls the last line, and a `for` loop typed over three lines runs. |
| `coreutils` | In an empty project's shell, coreutils' `mkdir -p`, `wc -l`, `cp -r`, `ls`, `sort -r` and `rm -rf` (the tree follows the removal); `System.cmd("rm", …)` from a node; `System.shell` with `mkdir`, `touch`, a node command and `ls` joined by `&&`. |
| `distribution` | Two shells in an empty project, `iex --sname a` and `iex --sname b`: b's `Node.ping(:a@localhost)` is `:pong` and its `:erpc.call` runs a fun on a; a's `Node.list()` names b. |
| `livebook` (`@slow`) | Livebook's escript (built natively, `/livebook-escript` in the site; skipped without) in an empty project: `livebook server`, its home page in the preview, a new notebook's cell evaluated on the standalone runtime (`15150`). About 12–16 s. |
| `livebook-ports` (`@slow`) | `mix escript.install hex livebook 0.19.10` in an empty project, `livebook server` from `PATH`, a new notebook's setup cell `Mix.install([:kino])`, and a `Kino.HTML` output in Livebook's iframe, from port 8081's origin on the usercontent domain. About 3 minutes. |
| `https` | httpc in an empty project gets hex.pm's API (200, JSON) through the page's fetch; a site without CORS headers answers 502 with why. |
| `domains` | The site's two domains (`serve.py --domain playground.localhost:PORT --usercontent usercontent.localhost:PORT`, which the config starts for every test): a Phoenix project's page is the apex's `/ID/` and its preview `v-ID-4000` on the usercontent domain, LiveDashboard (its redirect too) and its WebSocket there; the apex lists a project renamed on its page, marks it open, refuses to delete it while open and deletes it and its databases once closed; a share link opens as a new project on the apex; the former `p-ID` and `l-SESSION` addresses go to the apex's; other names under either domain are not found, with a button to the apex. |
| `git` | heroicons as phx.new adds it (tag, sparse, depth 1): fetched and checked out sparsely, the lock checked, and fetched again from the lock. In the shell, `git clone` of todo_trek (an SSH address) into an empty project, `pull` already up to date and then fast-forwarding a branch set one commit back; a non-empty destination and another host refused. |
| `quick-open` | ⌘P / Ctrl+P from a terminal opens quick open; a fuzzy query picks `endpoint.ex` first and Enter opens it; then the open tab comes first, the arrows move, an unmatched query says so and Escape closes; a very long file name is cut, and nothing scrolls sideways. |
| `search` | ⌘⇧F / Ctrl+Shift+F from a terminal shows *Search*, focused; a file with a needle on line 150: any case finds both, *Match case* one, a regular expression one, an invalid one says why; nothing from `deps`; the hit's line and column, its match marked; clicking it opens the file with the caret on line 150 (typing and saving shows where); the *Files* tab still has the tree. |
| `tree` | Files and folders made, renamed, moved (Chromium) and deleted from the tree, kept across a reload. |
| `worker` (`@slow`, Firefox) | After the service worker idled (45 s), a Phoenix server still answers a path whose modules the node has not loaded (the service worker and the node's worker once waited on each other for minutes). |
| `bundles` | The node's lazily loaded files arrive although every bundle's first two downloads fail: a temporary IEx starts and answers (Chromium and Firefox: WebKit's routing does not see a worker's requests). |
| `share` | An empty project (text and bytes) and a Phoenix project (an edited and a removed template file) shared as links and opened in a fresh browser context; a damaged link. |
| `live` | A live session, host and guest in two browser contexts: the guest watches (tree, terminal, a file it cannot change, a search of the host's files), then edits once allowed (typing both ways, each other's carets, undo of its own typing, saving, a change on disk), types into the host's terminal, and sees the session end; asking before letting a guest in, and removing one; a fork with unsaved text; the host's reload; a Phoenix app in the guest's preview, LiveDashboard over its WebSocket, and a save in the host's editor reloading it; a guest following the host (its files, its caret far down a file), stopping when it opens a file itself, and following again. |
| `migrate` (Chromium, Firefox) | A project's stores as the former layout left them on `p-ID` (a changed file, a database standing in for PGlite's) move to the apex as it opens: the file in the project, the database's record on the apex, both gone from `p-ID`. |
| `isolation` | The exec frame is `e-ID` on the usercontent domain, cross-origin isolated, and sees none of the apex's databases (Chromium, WebKit); a Tailwind plugin of a Phoenix project's runs in it (its origin in the built CSS). |
| `ports` | Two ports of an empty project's app (a small `gen_tcp` server): port 4000's page shows port 4001's in an iframe, each on its own origin (`v-ID-4000`, `v-ID-4001` on the usercontent domain), and a link to 4001 goes to its origin with its path, the path bar following; a cookie the page's JavaScript set is its `document.cookie` on the next load (the origin's jar, `cookies.ts`). |
| `sockets` | In an empty project, `gen_udp` between the node's ports (passive, active, connected) and between two shells' nodes; without Tailscale, `gen_tcp` to another host is `enetunreach` and a name `nxdomain`, both at once. |
| `tailscale` (Chromium) | Without Tailscale set up, an empty project's `httpc` to a site without CORS gets 502 and the setup dialog, once (not again after *Not now*, nor in another project); the apex's `/tailscale` page; the temporary IEx's menu. With a Headscale (`HEADSCALE_URL`, `HEADSCALE_API_KEY`, `HEADSCALE_USER`, as `tests/headscale.sh start` prints; else skipped): signing in, the tag, the exit node, a project asking and allowed; its `httpc` (200, the node's own TLS), names, short names, `gen_tcp`, `sockname`, UDP to 1.1.1.1, `ssl:connect` with its options, Erlang distribution to a node in the tailnet, a shared port reached from the tailnet, the tailnet's other devices out of reach, a refused project; two projects' port 4000 (the second at the device's 4001, then taking 4000; a closed tab frees it); and with the backend's relay, a live session keeping the tailnet with a guest in, and keeping it off while a guest may type once the host says so ([tailscale.md](tailscale.md#testing)). |
| `phone` | At 390×844: the home page and projects fit, one pane at a time, a Phoenix project opens on its preview; the manifest, the icons and the link preview's card are served as images, the page does not rubber-band, and a home-screen app's top-edge strip (its standalone rules forced: Playwright does not emulate `display-mode`) spans the viewport 6 px high in the colour of the page or the top bar, above the top bar's buttons; the installed app's viewport does not zoom (the page told it is installed), a tab's keeps its own. |
| `websocket` | A WebSocket from the preview to `/live/websocket` gets Phoenix's heartbeat reply; LiveDashboard (path bar `/dev/dashboard`) connects over `:websocket`, shows its home page and a process's details. |
| `auth` (`@slow`) | `phx.gen.auth --hashing-lib pbkdf2` in a second shell, `deps.get`, `compile`, `ecto.migrate`, the server restarted, a registration in the preview over LiveView's WebSocket (flash, PGlite row). About 1.2 min. |
| `livetest` (`@slow`) | In a Phoenix project's second shell, `mix test` with a LiveView test added (`live_isolated`, `render_click`, `has_element?`: LiveViewTest parses with lazy_html, built by `make` from the site): the test environment's dependencies compile (about 5 minutes in Chromium), then the app's 5 tests and the LiveView one pass. |
| `shells` (`@slow`) | A second shell runs `mix phx.gen.live`, patches the router and migrates while the server runs; the generated form saves a post. Minutes. |

Typical times: all three browsers' 102 tests in about 8 minutes, or
Chromium's 34 in about 2.7; Firefox's and WebKit's take about as long each
(`hex` 25 s against 22, `rebar3` 26 against 26, `https` 32 against 33).

**WebKit needs `require-corp`.** It does not take
`Cross-Origin-Embedder-Policy: credentialless`: with it the page is not
cross-origin isolated, has no SharedArrayBuffer, and the playground starts
nothing. So `serve.py`, the deployment and the service worker send
`require-corp`. WebKit also reports a `fetch()` that CORS blocks as an
uncaught page error, though `https.ts` catches it; the fixture leaves that
one out. `tree` fails a focus check under heavy load (four workers and all
three browsers), in Chromium too, and passes alone.

Playwright before 1.64 shipped a Firefox (141) without an optimizing
WebAssembly compiler, which ran Rust-OTP's `rotp.wasm` about 10× slower than Chromium
(`Enum.reduce(1..3_000_000, 0, &+/2)`: 8.6 s against 0.9 s); Firefox 157
has one.

## Debugging a stuck preview in the browser

In a project's page, `playground.debug()` shows what is under way between
the page and its nodes: the bridge's requests and WebSockets (with their
age and bytes), and for each node its open and recently ended connections
(bytes each way, who ended them), bytes it has not read yet from the page,
frames waiting to be written, and when its worker last sent each kind of
message. In a live session, `playgroundLive.debug()` adds the relay
connection's state and queue and the preview's tunnels. To see every
connection event as it happens:

```js
localStorage.setItem('playground-trace', 'net'); // then reload
```

## Without a browser: `node.mjs`

The Node harness ([build.md](build.md#the-node-harness-srcruntimenodets)) runs
the site's node as the browser's worker does. It is the quickest way to
see what a node does: boot errors, a request's status and headers, which
files are fetched. For example, IEx with input:

```sh
printf '1 + 1\n' | docker run --rm -i -v $PWD/target/node:/w:ro \
  -v $PWD/target/site:/d:ro -e BOOT=boot node:24 node /w/node.mjs /d \
  -noshell -elixir_root /rotp/lib -pa /rotp/lib/elixir/ebin \
  -user elixir -extra --no-halt +iex
```

It does not cover the page's parts: shared files and their storage, page
programs (Tailwind), the service worker, PGlite.

## After changing the runtime

- **The BEAM:** `beam/smoke.mjs` and `beam/elixir.mjs` under emsdk's Node
  ([`../beam/README.md`](../beam/README.md)).
- **The erl_nif layer** (`nif/`): `python3 -I nif/test/test.py`
  over the built site ([nif.md](nif.md)).
- **The app and the runtime:** `npm run lint`, `npm run format:check`,
  `tsc --noEmit` (part of `npm run build`), in Docker (`node:24`) in
  `app`.
- **The browsers:** the Playwright suite in Chromium, Firefox and WebKit.

## Not yet: caching the runtime between tests

A fresh context starts with an empty HTTP cache, so every test fetches and
compiles `beam.wasm` and unpacks its boot images again. Fetching from
`serve.py` is cheap; compiling and unpacking per worker is not. A
persistent context per Playwright worker (one profile, its IndexedDB and
storage cleared between tests) would keep the HTTP cache and the compiled
code; measuring how much of a boot each step takes comes first.
