---
kind: reference
status: live
last_updated: 2026-10-28
---

# Testing

The browser suite runs against the built site. Deployment does not
currently require it to pass.

## On GitHub: `.github/workflows`

Pushes to `main` and pull requests on GitHub run three workflows (Forgejo
reads `.forgejo/workflows` only, so the deploy remote runs none of them):

- **app:** lint, format, `tsc --noEmit` and the unit tests.
- **backend:** formatting, a compile without warnings, `mix test` against
  Postgres, and the release image.
- **site:** each WebAssembly tool and the tests' NIF libraries
  (`tests/nif/build.py`) in jobs of their own, then the site
  (`runtime/build.py`), then `tests/nif/layer.py` and the Playwright
  suite in each browser, in four shards, with the backend
  at `localhost:4000`. Run by hand, it can also run the `@slow` tests.
  Each shard's `target/tests` is an artifact. A failed test runs once
  more; WebKit runs on two workers, and its shards do not fail the run:
  there, a node's worker sometimes stops for good inside WebKit as it
  instantiates `git.wasm` (`mix deps.get` in `git.spec.ts`). A test whose page crashes fails at once ("the page crashed"),
  not when its wait times out.

## In browsers: Playwright (`app/test/e2e`)

Use the repository's Playwright version and Docker image, pinned in
`app/package-lock.json` and `tests/run.sh`:

```sh
python3 -I runtime/build.py              # full build; see build.md for prerequisites
python3 -I runtime/build.py app          # app changes only; requires an existing site
python3 -I tests/nif/build.py            # the tests' NIF libraries (Docker; nif.md)
PORT=8181 tests/run.sh --project=chromium # Chrome only
PORT=8181 tests/run.sh                    # Chromium, Firefox and WebKit
PORT=8181 tests/run.sh --project=chromium terminal
PORT=8181 SLOW=1 tests/run.sh --project=chromium shells
```

Run these commands from the repository root. The build installs the app's
npm dependencies in Docker. `tests/run.sh` mounts the repository and
runs `npx playwright test` in `app`; it expects those dependencies to exist.
Both servers answer `/api/v1/nif/` with the tests' NIF libraries
(`serve.py --nif ../target/test-nif`), not a backend's: a NIF package
other than those fails to build.

The default port is 8081. The examples use 8181 to avoid an existing
local server. `app/playwright.config.ts` starts two servers:

| Port | Configuration |
| --- | --- |
| `PORT` | Apex and usercontent domains, plus the test embedder host and files. |
| `PORT + 2` | Apex and usercontent domains, with the backend at `http://localhost:4000`. |

Playwright reuses a server already listening on either port. It must have
the same domain, embedder and backend options as the configured server;
a general-purpose development server can cause misleading failures. Use
unused ports when unsure. Live-session and relay tests need the local
backend; tests that require it skip when it is unavailable.

`WORKERS` defaults to 3. Tests tagged `@slow` are excluded unless `SLOW`
is set. Results, failure screenshots and traces go to `target/tests/`.
To investigate a failure, rerun its spec in one browser before running
the full suite again.

Each test gets a fresh browser context and empty IndexedDB. `fixtures.ts`
fails tests on unexpected page errors. `helpers.ts` provides runtime
access through `window.playground` and waits for LiveView with `syncLV`.
Terminal assertions use the rendered screen, including scrollback;
the raw output stream includes line-editor redraws and repeated prompts.

### Coverage

The specs in `app/test/e2e` are the source of truth for individual checks.
They cover:

- Project creation, import, deletion, persistence, tab ownership and migration.
- Editing, search, file operations, terminal interaction and preview routing.
- Phoenix, LiveView, PGlite, Hex dependencies, rebar3 and WebAssembly NIFs.
- Brush, command-line tools, Git, Node.js, npm and Vite.
- Runtime isolation, embedding, project settings and shared files.
- TCP and UDP, Erlang distribution, relay consent and Tailscale.
- Share links, live sessions, guest permissions and mobile layouts.

Some checks need additional services or artifacts. Tailscale integration
uses the Headscale setup described in [tailscale.md](tailscale.md#testing).
The slow Livebook escript test needs `/livebook-escript` in the built site.

### Chromium validation, 2026-10-23

The standard Chromium run selected 149 tests. After fixing stale copy
assertions and rerunning failures with the required NIF archive, the
combined results were **143 passed, 5 skipped and 1 failed**. This was
not a single fully passing run. The remaining failure was the Tailwind
plugin check in `isolation.spec.ts`: its `/shared/valid-probe` file was
not created. The cause remains unresolved. Slow tests, Firefox and
WebKit were not run in that validation.

The servers and service worker use COEP `require-corp` for cross-origin
isolation. Do not substitute `credentialless` without checking every
supported browser. The fixture filters the known WebKit page error for
a fetch blocked by CORS, which the HTTPS gateway handles itself.

WebKit's page crashes (a segfault in its web process) when many workers
fetch their module script at once, as a node's threads start together.
A node's threads therefore start from a blob of `beam.emu.mjs` that the
node fetches once (`app/src/runtime/beam/run.ts`; `beam/build.sh`
patches Emscripten's worker for it).

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
- **The erl_nif layer** (`backend/nif/`): `python3 -I tests/nif/build.py`,
  then `python3 -I tests/nif/layer.py` over the built site
  ([nif.md](nif.md#tests-testsnif)).
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
