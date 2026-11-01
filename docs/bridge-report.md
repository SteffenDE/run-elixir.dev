---
kind: report
status: experiment
last_updated: 2026-10-30
---

# Bridge mode: a report for embedders (Tidewave's `/web`)

Bridge mode lets a site run projects without a usercontent domain of its
own. Its page serves the packages it installed from npm, and frames a
shared usercontent domain that serves only a bootstrap page and a service
worker. A worker on the page's origin answers the frames' pages and
scripts and reaches the backend's services; the frames read the packages'
data from the page's server themselves. The design and its
security rules are in [frames.md](frames.md#bridge-mode).

Status on 2026-10-30: implemented on the `sd-bridge` branch and, since
that day, the only mode: the playground's IDE runs its projects the same
way, and run-elixir-usercontent.org becomes the shared domain when the
branch deploys. Tested on localhost in Chromium, Firefox and WebKit
through Playwright. Not released to npm, and not deployed. A review's
fixes of 2026-10-30 are [below](#review-fixes-2026-10-30), and the
switch to bridge mode only [after them](#bridge-mode-only-2026-10-30).

## The `create()` options

For a page that installs the packages from npm and serves them itself:

```js
import { create } from '@elixir-playground/api';
import otp from '@elixir-playground/otp-29.1.2';
import elixir from '@elixir-playground/elixir-1.20.4';
import standard from '@elixir-playground/standard';
import claude from '@elixir-playground/claude';

const sandbox = await create({
  plugins: [otp, elixir, standard, claude],
  project: { id: 'my-project', template: 'empty', persist: true },
  usercontent: 'run-elixir-usercontent.org',              // the shared domain (the default)
  runtime: '/npm/@elixir-playground/runtime@1.2.0/',      // where the page serves the runtime
  services: 'https://run-elixir.dev',                     // the default; needs the allowlist
  relay: ['github.com', 'api.anthropic.com'],
  env: { ANTHROPIC_API_KEY: '…' },
});
```

- `usercontent: { domain, content, worker }` takes these two besides the
  domain.
- `usercontent.content`: the directory the packages are below
  (`/web/elixir-playground/`, or a CDN's URL). The descriptors' `base`s
  and `runtime` resolve below it, even with a leading slash. By default
  what `<meta name="playground-content">` names (the Vite plugin names
  Vite's `base`), else the page's origin root.
- `usercontent.worker`: the URL of `apexWorker.js`, if the bundler does
  not emit it beside the api. Vite emits it; the Vite plugin excludes the
  api from dependency pre-bundling, which would lose it in `vite` dev.
- `runtime` can be left out when the page has `<meta
  name="playground-runtime">` (the Vite plugin adds it).

With `@elixir-playground/vite`:

```js
elixirPlayground()  // or elixirPlayground({ usercontent: 'usercontent.localhost:5173' }) locally
```

`vite build` copies every installed package with a `playground` field,
and the runtime, to `dist/npm/@elixir-playground/NAME@VERSION/`. `vite`
serves them in development, and answers a `*.localhost` usercontent
domain's hosts with the bootstrap, service worker and `bridge.json` if
the option names one (`tests/vite-site/run.sh` does this).

## What the page serves, with which headers

| What | Where | Headers |
| --- | --- | --- |
| The page | its own | COOP `same-origin`, COEP `require-corp` |
| Each package's files, and boot recordings if given | its descriptor's `base`: `/npm/@elixir-playground/NAME@VERSION/` | `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`; `Cache-Control: public, max-age=31536000, immutable` recommended |
| `apexWorker.js` | beside the api's `index.js`, as bundled | a JavaScript `Content-Type` |
| An app archive (`project: { archive }`) | anywhere | CORS: the exec frame fetches it from the shared domain |

The frames' workers read the packages' data (fs bundles, layer manifests,
WebAssembly) themselves, from the shared domain's origins, one per
project: hence `*`. The apex's worker fetches the frames' pages, worker
scripts and imports for the service worker. Both use the HTTP cache, so
each file is downloaded once for all of the page's projects; nothing is
stored on the shared domain. The same headers work for a CDN of another
origin (`usercontent.content`). Not tested with a CDN.

The Vite plugin sends these headers in `vite` and `vite preview`. A
production host has to send them itself.

## The backend's services

The page's worker requests NIF builds, git's proxy and the TCP relay
from `services`, with the page's `Origin`. run-elixir.dev's backend
answers the origins in `PLAYGROUND_SERVICE_ORIGINS`
([backend.md](backend.md#service-origins)); its default list holds
`https://tidewave.ai` and `https://tidewave.steffend.me`. Another origin
gets 403 before any work. Caddy's git proxy asks the backend, so that one
list decides for every service ([deploy.md](deploy.md#caddy)). To be
added, a site asks run-elixir.dev's operators. `http://localhost:4000` is
not on the list: local development runs its own backend
([backend.md](backend.md#service-origins)). A site that is not listed can run the backend itself, or
reverse proxy it, and name it in `services` (`{ relay, nif, git }` each,
or one origin for all). Hex's repository does not go through
run-elixir.dev: the page uses its own `/hex/` if it has one, and the public
mirror otherwise.

## Measurements

"Today" in these results is the mode the usercontent domain served the
packages in, which was removed on 2026-10-30; the numbers are as measured
then.

Measured on 2026-10-29 on localhost (`tests/bridge/bench.mjs`, against
`serve.py --immutable`, so the packages' files are cached as production
caches them). Playwright 1.64 with Chromium 156.0.8078.4, Firefox 157.0
and WebKit 27.2, headless, on one 8-core Linux machine (arm64). Cold: a
new browser context. Warm: the same context, the page loaded again, the
same project (its origins and service worker known). Medians of 3 runs
unless named. Seconds unless named. `tests/bridge/summary.mjs` prints the
tables from the JSON files in `target/`.

**Today's mode against bridge mode** (the final build):

| Task | Chromium cold / warm | Firefox cold / warm | WebKit cold / warm |
| --- | --- | --- | --- |
| `create()` + `elixir -e "IO.puts(6 * 7)"`, today | 0.91 / 0.78 | 0.83 / 0.80 | 1.03 / 0.94 |
| the same, bridge | 0.95 / 0.80 | 0.90 / 0.86 | 1.04 / 0.99 |
| `mix phx.server` answering on port 4000 (Phoenix template), today | 3.09 / 2.65 | 2.79 / 2.66 | 6.89 / 7.53 |
| the same, bridge | 3.20 / 2.67 | 3.00 / 2.81 | 7.04 / 7.82 |
| `mix compile` of `mix new demo`, today | 1.15 / 1.08 | 1.06 / 1.02 | 1.29 / 1.19 |
| the same, bridge | 1.17 / 1.11 | 1.09 / 1.11 | 1.22 / 1.19 |
| `mix compile` of an app depending on Ash (Chromium, Firefox: 1 run; WebKit: 3), today | 46.7 / 43.5 | 62.1 / 61.9 | 83.5 / 83.3 |
| the same, bridge | 47.5 / 48.2 | 62.1 / 62.1 | 98.7 / 92.6 |
| `claude --version`, the claude cache warm, `create()` included (1 run, warm), today | 1.90 | 2.74 | 2.23 |
| the same, bridge | 1.91 | 2.77 | 2.27 |

**The Phoenix boot with the page's main thread busy** (100 ms of every
150 ms, warm): today 3.55 / 3.19 / 8.98 s, bridge 3.40 / 3.52 / 8.15 s
(Chromium / Firefox / WebKit).

**fs reads during the Phoenix boot.** 245 bundle reads, 54.1 MB, in both
modes and every browser; 271 during the Ash compile, 109 during the small
one. Latency per bundle read (p50 / p95, ms, warm):

| Mode | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| today | 1.0 / 2.6 | 1.2 / 2.3 | 0.3 / 0.6 |
| bridge | 1.1 / 4.2 | 1.8 / 2.7 | 0.3 / 0.7 |

**The apex's main thread during the Phoenix boot** (warm): Chromium's
long tasks 76 ms today and 61 ms in bridge mode (cold: 810 and 831 ms);
the timer's lag past 50 ms 553 / 426 / 3511 ms today and 516 / 410 /
3527 ms in bridge mode (Chromium / Firefox / WebKit). They are the same
in both modes, and none during `elixir -e`: the busy time is the page's
own (PGlite runs on its main thread), not the bridge's.

**The data paths that were removed.** Before bridge mode kept only direct
reads, the same benchmark compared reads over a port to the apex's worker
and through the service worker (2026-10-29, same machine and browsers;
`target/bridge-bench-2026-10-29T16:48:52.json`, `…T17:17:41.json`,
`…T17:49:37.json`):

| Phoenix boot, warm | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| port to the apex's worker | 3.28 | 3.88 | 7.27 |
| through the service worker | 3.32 | 4.26 | 7.23 |
| direct (kept) | 2.90 | 3.78 | 7.22 |
| port, main thread busy | 3.55 | 7.26 | 9.67 |
| service worker, main thread busy | 4.00 | 8.31 | 9.41 |
| direct, main thread busy | 3.40 | 4.55 | 8.00 |

A SharedWorker in place of the dedicated apex worker brought Firefox's
busy-thread boot down to 4.7 s (port) and 4.8 s (service worker), and
WebKit's only to 8.9 s. The Ash compile did not depend on the path (one
run each, within run-to-run noise). Those runs predate the bootstrap's
background update, which removed about 1.1 s from each `create()` in
Firefox.

**Skipped and unresolved.**

- No deployed setup: no shared domain is deployed.
- Only Playwright's browser builds: no shipped Firefox or real Safari,
  whose process model may differ, no mobile browser, and no CDN as the
  packages' origin.
- Firefox's bundle counts in the removed port and service-worker paths
  were 233 to 234 of 245: reads told on a `BroadcastChannel` by workers
  that ended first. The kept path counts all.
- **WebKit's Ash compile may be slower in bridge mode**, unresolved. Its
  runs: today 80.1, 99.6, 83.5 s cold and 73.8, 83.3, 85.5 s warm; bridge
  90.9, 98.7, 99.2 s cold and 92.6, 82.0, 93.4 s warm. The ranges
  overlap, but the medians differ by 11 to 18%. The compile reads the
  same 271 bundles in both modes, so the data path does not explain it.
  Chromium (one run) is within 10%, Firefox (one run) the same.

## Review fixes (2026-10-30)

A review of the branch found these issues by reading the code. Each fix
below is implemented and tested on localhost as described. Nothing was
run against a live Caddy.

| Finding | Fix | Tested |
| --- | --- | --- |
| `bridge.html` was in the site's root, so any site could frame it on the apex and run code there, past the services' allowlist; and on the usercontent domain, past `embedders` | The bootstrap only in `target/bridge/`; 404 elsewhere; `/bridge.json` checked by the bootstrap and `sw.js`; `frame-ancestors 'self'` on the apex ([frames.md](frames.md#who-may-bridge)) | Reproduced first: a NIF build answered 200 in Chromium, Firefox and WebKit. After the fix, `bridge-guard.spec.ts` passes in all three (Firefox checks the framing header only); unit tests |
| The backend only left out CORS for another origin; the build still ran. The list was in three places | 403 before any work (`ServiceOrigins.require_allowed`); Caddy asks the backend for `/git/` (`forward_auth`); `serve.py` follows the same rule | `service_origins_test.exs`; `bridge.spec.ts`; Caddy not run |
| Without local storage the salt changed on every call, so a kept project lost its files | One salt per page. The salt names only origins; a project's stores keep an unsalted key, the same as today's mode, so a lost salt or a switch to bridge mode keeps its files | `bridge-salt.test.ts` |
| The bridge was a page global: a later `create()` changed an earlier sandbox's previews and claude frame | Each `Sandbox` keeps its bridge, domain and runtime; relays and the claude frame are cached by origin | `bridge.spec.ts`, two sandboxes on one page (Chromium, Firefox, WebKit) |
| Listeners and a port were never released | The relay and claude frames remove their bridge listener when removed or failed; the bootstrap closes a refused worker's port | `bridge-bootstrap.test.ts` |

## Bridge mode only (2026-10-30)

After the review, bridge mode became the only mode, and a package can add
a command and a shared frame of its own:

- **The IDE bridges too.** `create()`'s `usercontent` is the shared
  domain (a string, or `{ domain, content, worker }`), by default the
  page's `<meta name="playground-usercontent">`, its site's
  `playground.json`, then run-elixir-usercontent.org. The usercontent
  domain serves the release's `_usercontent/` (`bridge.html`, `sw.js`,
  `bridge.json`) and nothing else; the apex serves the packages with
  CORS. `embedders`, `EACCES`, the `/relay.html` bootstrap, the Vite
  plugin's own usercontent layout (`dist-usercontent/`, `_headers`) and
  `PLAYGROUND_RELAY_ORIGINS` are gone.
- **Kept projects keep their files.** Their stores' key is the one
  their origins had before; only their origins' key is salted
  ([api.md](api.md#project-keys)).
- **Packages' page programs and shared frames** replace everything the
  api and the runtime knew of Claude Code
  ([packages.md](packages.md#page-programs-and-shared-frames)): the
  claude package (2.0) adds `claude` and its preparing frame, on the
  runtime's new `pagePrograms` and `frames` seams (runtime 1.2).

Tested on 2026-10-30; see the final report on the branch for the runs.

## Open questions

- **Deploying the shared domain.** run-elixir-usercontent.org becomes
  it (decided 2026-10-30): its Caddy root moves to
  `current/_usercontent`. Older `sw.js` copies on preview origins route
  `/bridge.html` into the app until they update (one failed load), and
  most of those origins are not visited again, because origin names are
  salted now.
- **Trust.** Whoever controls the shared domain controls `bridge.html` and
  `sw.js`, through which the frames' pages, scripts and imports pass (the
  data reads do not). The page supplies the code that runs, so the
  domain's operator cannot change it without changing those two files. An embedder that does not
  accept this self-hosts a usercontent domain.
- **Storage partitioning.** The guarantees between embedders rely on it
  ([frames.md](frames.md#what-relies-on-storage-partitioning)). A browser
  with it turned off shares the claude frame's cache between embedders.
- **WebKit's long compiles** may be 10 to 20% slower in bridge mode
  ([above](#measurements)); not explained yet.
- **Downloads in previews.** The shared domain refuses attachments only
  for bridged files. A project's own app can still serve one in its
  preview, as it can today.
- **Not measured:** a deployed setup (none exists), a real Safari, a
  mobile browser, and a CDN as the packages' origin.
