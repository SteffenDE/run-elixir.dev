---
kind: design
status: live
last_updated: 2026-11-04
---

# One trusted origin, and frames for what a project's code runs

The apex (`run-elixir.dev` in the deployment examples) hosts the IDE,
project storage, settings, GitHub token, and Tailscale credentials.
Project code runs on a separate registrable domain, the **shared
usercontent domain**, configured with `PLAYGROUND_USERCONTENT`
(`run-elixir-usercontent.org` in the examples). That domain serves no
packages and no code of its own: the page that frames it supplies every
file its frames load ([bridge mode](#bridge-mode)). The IDE and every
other site that calls `create()` use it the same way.

| Origin | Runs there |
| --- | --- |
| `DOMAIN` | React IDE, project list, stores, PGlite, Tailscale shared worker, and the apex's worker. |
| `e-KEY.USERCONTENT` | Project exec frame and its workers: BEAM, Node.js, tools, and plugins. |
| `v-KEY-PORT.USERCONTENT` | Preview, service worker, and relay frame for one project server port. |
| `NAME-HASH.USERCONTENT` | A package's shared frame (`claude-HASH`: Claude Code's preparation worker and cached files). |

`KEY` and `HASH` are salted with a secret of the page that frames them
([below](#what-relies-on-storage-partitioning)), so another frame cannot
tell them from a project's id.

Implemented on the `sd-bridge` branch on 2026-10-30. Before it, the
usercontent domain served the site's packages itself, and bridge mode was
an option (2026-10-29) that the IDE did not use. Nothing deployed uses
bridge mode yet.

The layout before that put project IDEs on `p-ID.DOMAIN` and guest pages
on `l-ID.DOMAIN`. Those URLs now redirect to the apex. Legacy project
stores are migrated when a project opens or the home page lists it.

## Previews on another site

The apex's page frames `v-KEY-PORT.USERCONTENT/bridge.html` for every
port its app serves, and the bridge loads the runtime package's
`relay.html` below it (`previewOrigins.ts`). The relay registers its
origin's service worker as the preview's host and forwards requests to
the exec host's bridge through a MessagePort the page supplies. The
preview's own frame then loads that origin. Both frames are the apex's
site's, so the browser keys their storage, service worker and cookies by
the apex's site (partitioned): the same partition for both, and for a
popped-out preview, which is an apex page (`preview.html`, the origins'
key in its URL) framing it the same way.

- **Headers.** Every answer of the service worker carries COEP
  `require-corp` and CORP `cross-origin` (the apex frames it from
  another site); `serve.py` and Caddy answer the usercontent domain's
  three files the same.
- **Cookies.** A frame of another site keeps no cookies of its own in
  WebKit, and only `SameSite=None; Secure` ones in Chromium. The app's
  HttpOnly cookies stay in the bridge's jar, as before; those its
  JavaScript may read are kept in the origin's local storage
  (`cookies.ts`), which the relay sends with each request and the app's
  pages see as `document.cookie` (a shim the bridge puts in each page).

## The exec frame

The page frames `e-KEY.USERCONTENT/bridge.html`, which loads the runtime
package's `exec.html` below the bridge (`allow="cross-origin-isolated"`,
which Chromium asks for: the nodes' threads need it). Its page only
starts a worker (`exec/host.ts`) and hands it the port the page gave: a
hidden frame's page has its timers slowed, a worker's are not. The frame
is not hidden either, but a pixel on the screen, unseen (`.exec-frame`):
in a `hidden` one, WebKit slowed the nodes' workers (the worker's own
workers) until a node waiting on a program's exit never heard of it. The
worker runs what the IDE's page ran before:

- `files.js` and the nodes, a shell per terminal tab and one per command
  they run, and their routing to each other's ports;
- the page programs: Tailwind (the project's plugins run here, nowhere
  else), esbuild, git, `sh`, `rebar3`, `mix` and friends, and `node`,
  `npm`, and `npx`, whose processes are workers of this one, held by a
  `Content-Security-Policy` of their own to no network but this worker's
  messages ([nodejs.md](nodejs.md#the-workers-policy)); and the
  packages' page programs (`claude`: [below](#packages-page-programs-and-shared-frames));
- epmd, HTTPS by fetch (from this origin: no cookie of the apex goes
  along), and the bridge to the app for the preview, whose relays send
  their requests straight to it on ports the page hands over.

The backend's services are the apex's (implemented 2026-10-29): the NIF
builds, git's proxy and the TCP relay. The exec frame's worker reaches
them over a port to the apex's worker
(`packages/runtime/src/lib/apexLink.ts`, `packages/api/src/apexWorker.ts`),
which makes the requests. The backend therefore sees the apex's `Origin`
and checks it against its allowlist ([backend.md](backend.md#service-origins)).
The usercontent domain serves none of them.

The page drives it over a port (`shared/lib/rpc.ts`): calls for files,
shells and the preview, events back for output, status, the ports
served, changed files, NIF builds, CSS and bundles. What is the apex's
stays the apex's:

- **The stores.** `files.js` keeps a project's changes through a port to
  the page (`overlay.ts` `remote`), which writes them to the apex's
  IndexedDB (`serveStore`), under the project's stores' key, which has no
  salt ([api.md](api.md#project-keys)). PGlite runs on the page. The frame
  writes no store of its own.
- **Postgres and Hex's cache.** A node's connections to 5432 and to Hex's
  port are carried over ports to the page (`portConnection.ts`), which
  answers them as before.
- **Tailscale's device** ([tailscale.md](tailscale.md)): a shared
  worker of the apex's, its keys in the apex's IndexedDB. The frame asks
  the IDE's page for each connection through the tailnet and each name;
  the page decides (the project's answer, a live session's guests) and
  hands the connection's port to that worker.
- **The terminals.** Their screens are the IDE's; their line
  disciplines are the frame's, one per process on a terminal
  (`exec/host.ts` `spawn`, the process API that `create()` drives,
  [api.md](api.md)):
  the IDE sends the keys, and the echo comes back with the output.
- **What the IDE changes** (a save, the tree's operations) is kept before
  the frame answers: the page may go at once (a reload), and the frame
  with it. What the nodes change is kept a second later, as before.

A live session's guest has no exec frame: its page bridges the relays of
its own preview origins (salted with its own secret), their connections
tunnelled to the host ([collaboration.md](collaboration.md#the-preview)).

## Packages' page programs and shared frames

A package can add a command and keep state across a page's projects
without the api or the runtime naming it (implemented 2026-10-30,
[packages.md](packages.md#page-programs-and-shared-frames)). The claude
package is the first to do so.

- **A page program** (`playground.pagePrograms`: NAME → a JavaScript
  module of the package's) is a command on PATH. The exec frame's worker
  imports the module below the bridge the first time the command runs,
  and calls its default export with the process, its context, and a
  host: the other page programs (`node`, to run Claude Code's JavaScript)
  and ports to the package's shared frames (`runtime/src/pageProgram.ts`).
- **A shared frame** (`playground.frames`: NAME → a page of the
  package's) is framed once per page, when a program first asks for it,
  on `NAME-HASH.USERCONTENT`. `HASH` is salted with the page's secret and
  covers the package's name, so each package's frames have origins and
  storage of their own (`packages/api/src/sharedFrame.ts`). Its page
  calls `serveFrame` (`runtime/src/lib/sharedFrame.ts`) and takes a port
  for each request; what the two say over it is the package's.
- **The exec frame asks for a port** with `framePort(package, name)`; the
  page answers only for the package's own frames.

**Claude Code** ([nodejs.md](nodejs.md#claude-code-claude)) is the claude
package's page program, `claude` (`packages/claude/src/program.ts`), and
its shared frame, `claude` (`claude.html`: `frame.ts` starts `worker.ts`,
which prepares with `build.ts` and `bungraph.ts`). The frame downloads
125 MB from the registry and extracts and compiles the JavaScript in
about 20 seconds. It caches the result once per version for all the
page's projects, in its origin's IndexedDB. Projects request the cached
files over their ports but cannot change the cache: only the worker
writes it, and it verifies the version pinned by the site before
preparing. A Web Lock serializes preparation across tabs. The apex does
not store or execute Claude Code.

## Bridge mode

A page runs projects on the shared usercontent domain, which serves no
packages and no backend services. The page supplies every file its
frames load, so any site can embed projects without a second registrable
domain of its own:

```js
create({ ..., usercontent: 'run-elixir-usercontent.org' }); // the default
```

The shared domain serves three files on every subdomain: `/bridge.html`
(the bootstrap), `/sw.js` (the preview service worker, extended:
[packages.md](packages.md#the-preview-origins-service-worker)), and
`/bridge.json`, which names the domain (`{ "bridge": "DOMAIN" }`;
[below](#who-may-bridge)). Everything else answers 404. `serve.py
--usercontent DOMAIN` serves such a domain locally, and so does the Vite
plugin in `vite` and `vite preview` for a `*.localhost` name.

### Schemes

The usercontent origins do not take the page's scheme. `site.ts`
`domainScheme` picks one rule for every origin the api and the runtime
build or check: the exec frame (`e-KEY`), the previews (`v-KEY-PORT`),
the shared frames (`NAME-HASH`) and the apex.

| Domain as written | Scheme |
| --- | --- |
| With a scheme: `https://run-elixir-usercontent.org` | That scheme (http or https only) |
| `localhost`, `*.localhost`, or a host with a port: `bridge.localhost:8081` | http |
| Any other host: `run-elixir-usercontent.org` | https |
| The page's own host | The page's scheme |

So a page on `http://localhost:9000` frames
`https://e-KEY.run-elixir-usercontent.org`. Before 2026-11-01 it framed
the http origin, which Cloudflare answers with a 308 redirect to https.
That redirect has no CORP header, so the cross-origin isolated page blocked
the frame. The frames read the apex and the shared domain from their
`playground.json` (the bridge table's `config`). `create()` writes each
domain with its scheme when the frames would otherwise pick the wrong
one, so an https frame accepts messages from an http parent. Otherwise
it writes the host alone, as runtime 2.0 reads it.

When the page serves its packages over http and the frames are https,
the frames read the package files below the bridge (through the service
worker and the apex's worker), not directly ([below](#the-data-path)).
WebKit blocks the direct reads as mixed content, even on `*.localhost`.
Chromium and Firefox allow them there.

### How a frame starts

1. The apex frames `https://ORIGIN.SHARED/bridge.html` (`e-KEY`,
   `v-KEY-PORT` or a shared frame's `NAME-HASH`). The bootstrap checks
   `/bridge.json`, then tells its parent that it loaded.
2. The apex's main thread answers with the frame's page (for example,
   `npm/@elixir-playground/runtime@2.1.0/exec.html`) and a port to the
   **apex's worker** (`packages/api/src/apexWorker.ts`), a dedicated worker
   on the apex's origin.
3. The bootstrap registers `/sw.js` and makes sure it bridges with the
   newest worker ([below](#service-worker-updates)). It picks a random
   key and gives the service worker a port to the apex's worker under
   that key (`bridge`).
4. The bootstrap navigates to `/_bridge/KEY/` followed by the page's path.
   The navigation is a new document, so the active worker controls it
   without a reload.
5. The service worker answers every request below `/_bridge/KEY/` (the
   frame's pages, worker scripts and imports) by asking the apex's worker.
   The apex's worker fetches the file from where the page serves its
   packages: each descriptor's `base`, below `usercontent.content` (the
   page's origin root by default, or a path or CDN directory). The runtime's data reads go there
   directly ([below](#the-data-path)).
6. The frame's page (`exec.html`, `relay.html`, `claude.html`) then runs
   as it does today. It asks its parent for a port of its own
   (`playground-bridge-client`), which it uses to give the service worker
   a new port after the browser stopped it (`bridge-lost`).

The service worker stores no content. It uses no Cache Storage and no
IndexedDB for files: each project is an origin of its own, so stored
files would be a copy per project. The apex's HTTP cache keeps one copy
for all of the page's projects. The service worker adds COEP
`require-corp`, CORP `cross-origin`, the Node.js worker's
`Content-Security-Policy`, and a `sandbox` policy on documents
(`swBridge.ts`).

### When a frame loses its service worker

A bridged frame needs its service worker for every file it loads. The
browser can remove the worker while the page runs. The frame's requests
below `/_bridge/KEY/` then reach the shared domain's server, which answers
404. Processes that are already running keep working, but no new worker
loads, so no new process starts. Only a reload helps: the bootstrap
registers the worker again.

**Safari deletes the shared domain's storage from time to time.**
Intelligent Tracking Prevention (ITP) removes all script-written storage
of a registrable domain that had no first-party user interaction. That
includes service worker registrations, IndexedDB and Local Storage. The
shared domain never has first-party interaction: browsers only ever load
it as a third-party frame. So every removal run deletes it, for every
page's frames at once, while they run.

The rules are in open-source WebKit
(`Source/WebKit/NetworkProcess/Classifier/ResourceLoadStatisticsStore.cpp`,
trunk of 2026-11-04):

- `shouldRemoveAllButCookiesFor` selects every domain without recent user
  interaction. The default mode is `FirstPartyWebsiteDataRemovalMode::AllButCookies`,
  and a domain that never had interaction gets no grace period. No tracker
  classification is needed.
- `WebResourceLoadStatisticsStore::monitoredDataTypes()` includes
  `ServiceWorkerRegistrations`.
- Statistics are processed 5 s after they change, for example after a page
  load (`minimumStatisticsProcessingInterval`). A removal runs at most once
  an hour (`minimumTimeBetweenDataRecordsRemoval`). The time of the last
  removal is kept in memory, so the first processing after Safari's network
  process restarts can remove too.
- Only the exact domain `localhost` is exempt (`shouldSkip`), not
  `*.usercontent.localhost`.

Observed in desktop Safari (macOS 27.2) with Tidewave's `/web` page on
`localhost:9000` and the shared domain `usercontent.localhost:9000`,
2026-11-04:

- After the page was closed for a while, the exec frame booted with an
  active, current worker. 4.9 s later its controller changed, and the host
  worker's `HEAD` of its own script got 404 from the server. The server log
  showed no request between the two. After the reload, the `e-`,
  `claude-` and `v-` frames each installed a new worker: all three
  registrations had been deleted.
- A separate test page on `localhost` that framed
  `e-test.usercontent.localhost` kept its registration across reloads and
  after 14 minutes closed. About an hour later, after the deletion above,
  it had none.
- A quick reload usually worked. Fresh Playwright WebKit profiles did not
  reproduce it.

This also deletes the shared frames' storage, such as Claude Code's
prepared files in the `claude-HASH` frame's IndexedDB
([packages](#packages-page-programs-and-shared-frames)). The frame then
prepares them again. The two Safari failures that
[Service worker updates](#service-worker-updates) attributes to a
takeover had the same symptoms and may have been this deletion instead.

**The runtime reports the loss once, as soon as it notices.** The host
worker sends a `HEAD` request for its own script below the bridge
(`lib/controller.ts`). The file exists, so the service worker answers 200.
A 404 means the request reached the server. The host worker checks:

- when the exec frame's controller changes (`frames/exec.ts`);
- when a worker does not load, before any retry (`host/worker.ts`
  `checkDetached`). If the requests skip the service worker, it fails at
  once instead of retrying;
- when the exec frame's page becomes visible again. Safari deletes the
  registration when the page is used after a pause.

It then sends the warning `This page lost the playground’s service
worker, and new processes cannot start. Reload the page.` and the
`detached` event ([api.md](api.md)) with the check's `reason`. If the host
worker itself does not load, the exec frame logs an error in its console.
The page is not told: the frame has already reported that it started.

### Service worker updates

A deploy that changes the runtime changes `/sw.js` on every origin of
the shared domain. The browser installs the new worker on its next update
check. `sw.js` calls `skipWaiting()` and `clients.claim()`, so the new
worker takes over the frames that the old one controlled. It has none of
the old worker's ports, so it asks each bridged page for a new one
(`bridge-lost`).

**A takeover during the boot broke the frame.** The bootstrap used to
bridge with the active worker and leave `registration.update()` running
in the background. When `sw.js` had changed, the new worker installed
while the frame booted:

- Tidewave reported it in desktop Safari after the runtime went from
  2.1.1 to 2.1.3. The first reload failed with `worker.js: the worker did
  not load after 5 tries`, and each load of `worker.js` below
  `/_bridge/KEY/` got 404 from the shared domain's server. A 404 means
  the request skipped the service worker. A later reload worked. The
  likely cause is that Safari kept the dedicated workers that started
  before the takeover with the old, now redundant worker. This is not
  reproduced; no Safari was available for testing.
- Playwright's WebKit (1.64, WebKit 2370) failed in another way. The
  project did not start, and a request below `/_bridge/KEY/` got 503
  from the service worker. The new worker had taken over before the
  bridged page had its port from its parent, so no page answered its
  `bridge-lost`. `bridge.spec.ts` changes `sw.js` between two loads
  (`serve.py --test-hooks`). With the old bootstrap, the second load
  failed in 3 of 4 and then 4 of 4 runs. Chromium and Firefox passed.

**The bootstrap now bridges only with the newest worker**
(`root/bridge.html`):

1. The build appends a stamp line to `sw.js`:
   `self.playgroundScript="HASH";`, the SHA-256 of the script before it
   (`src/swScript.ts`, `vite.runtime.config.ts`). The worker reports
   the hash in its `bridged` answer.
2. The bootstrap fetches `/sw.js` (`cache: 'no-cache'`) and hashes it
   without the stamp line. If the active worker reports the same hash,
   the browser's update check cannot find a new worker. The bootstrap
   then bridges with the active worker at once.
3. Otherwise the active worker is outdated. That includes an older
   worker that reports no hash. The bootstrap waits for the worker that
   replaces it: one already installing or waiting, or else the one that
   the next `updatefound` brings, which `registration.update()` starts.
   It waits until that worker is `activated` (15 s at most). It bridges
   only if that worker reports the served hash too, and tries once more
   otherwise. Then it fails, and `create()` rejects with why.
4. If the served `sw.js` is unknown (the fetch failed) or has no stamp
   line (a runtime before 2.1.4), no worker can be checked. The bootstrap
   awaits `registration.update()` and bridges with the worker that the
   check left in `installing`, `waiting` or `active`, once it is active.

Step 3 does not take what `installing` holds when `update()` settles.
The 2.1.3 bootstrap did, with no hash check. Tidewave then saw the same
failure in desktop Safari after the runtime went from 2.1.3 to 2.1.4 with
a changed `sw.js`, 2026-11-03. The first reload logged the exec frame's
takeover warning (below), then `worker.js: the worker did not load after
5 tries`, with 404s. A later reload worked. The likely cause, from the
code and not yet observed: `update()` settled before the new worker was
in `installing`, so the bootstrap bridged with the old worker, which the
new one then replaced. In Playwright's WebKit that bootstrap bridged
correctly in 10 of 10 runs from an unstamped to a stamped `sw.js`, so it
does not reproduce Safari's ordering. The bootstrap's trace (below)
shows the ordering: `update() settled: … installing none` followed by a
later `updatefound` confirms it.

Waiting for `update()` on every boot was simpler, but Firefox's
`update()` takes a fixed ~1 s even when `sw.js` is unchanged. A plain
fetch of `/sw.js` took 1–3 ms there. `create()` of a project whose worker
is current, median of 8 runs, local test server, Playwright 1.64,
2026-11-02:

| Bootstrap | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Before (update in the background) | 43 ms | 88 ms | 51 ms |
| Always waits for `update()` | 43 ms | 1119 ms | 53 ms |
| Waits only when the hash differs | 40 ms | 86 ms | 45 ms |

Against a real server, the fetch adds one round trip to `/sw.js`. With
the fix, the `bridge.spec.ts` update test passed 12 of 12 runs across
the three browsers (2026-11-02). With step 3 as it is now, 2026-11-03,
local test server: the two update tests passed 20 of 20 runs in WebKit
and 10 of 10 each in Chromium and Firefox. They check that the second
load bridged with a worker that reports the served hash, and that no
`controllerchange` reached its exec frame afterwards.

**A takeover after the boot** can still happen. For example, a deploy
changes `sw.js` while a page runs, and another tab then opens the same
project. Its bootstrap installs the new worker, which also takes over the
running page's exec frame. In Chromium, Firefox and WebKit the running
page's nodes still started afterwards (`bridge.spec.ts`). The test
checks that the running exec frame logged `controllerchange` in
Chromium and WebKit. Firefox's logged none. For browsers whose workers
keep the old worker, the host worker checks its requests on each
`controllerchange` ([above](#when-a-frame-loses-its-service-worker)). No
tested browser fails that check after a takeover. In Safari it fired on
2026-11-03, during the boot described above, and on 2026-11-04 after ITP
deleted the registration.

### Debugging a service worker update

Each bootstrap records its steps with the time since it ran: the
registration's workers, the served hash, what `update()` left,
`updatefound`, each state of the new worker, `controllerchange`, and each
worker's answer. It logs them to its frame's console (`bridge: …`, debug
level) and sends the trace to its parent before it loads the frame's page
(`playground-bridge-trace`), or with `playground-bridge-failed`.

| Where | What |
| --- | --- |
| The page's console | Each frame's trace: debug level when the active worker was current, info when the bootstrap waited for a new worker, a warning when it failed (`api/src/bridge.ts`). |
| The exec frame's console | `exec: this frame's controller changed N ms after it loaded, to …`, on each `controllerchange` after the boot. `exec: the host worker did not load …` when it did not. |
| The page's console, after the frame lost its service worker | An error with the reason, the exec frame's boot trace, its served hash and the hash of the worker it bridged with. |
| `sandbox.on('detached', …)` | `{ message, reason, after, boot }`: the warning's text, what the runtime noticed, the controller change's time, and the trace. |
| `sandbox.boot` (internal) | The exec frame's trace; the e2e tests read it. |

The trace's `path` says how the bootstrap chose its worker: `current`
(step 2), `updated` (step 3) or `unchecked` (step 4).

### The data path

Only what the browser loads by URL comes through the service worker:
pages, worker scripts, module imports and frames. The runtime's own reads
do not (`packages/runtime/src/lib/apexLink.ts`): fs layer manifests and
bundles, boot recordings and WebAssembly modules. The site manifest names
them where the page serves them, as absolute URLs, and the frame's
workers read them there with CORS, through the HTTP cache. The page
therefore sends `Access-Control-Allow-Origin: *` and CORP `cross-origin`
on its package files ([api.md](api.md#what-the-page-serves)).

One exception: a page that serves its packages over http to https
frames ([Schemes](#schemes)). Its site manifest names the packages below
the bridge, so those reads go through the service worker.

A Node.js process reads the tls package's files the same way, so its
worker's `connect-src` names those URLs. The apex's worker hints them on
its answers (`x-playground-connect`), and the service worker takes only
plain `http(s)` URLs from the hint.

Two other data paths were built and measured on 2026-10-29, then removed:
the reads over a port to the apex's worker, and the reads through the
service worker. Neither changed a large compile (Ash), but both were
slower to boot, and in Firefox and WebKit a busy apex page held them up
([bridge-report.md](bridge-report.md#measurements)). The runtime compiles
WebAssembly from bytes (`WebAssembly.compile`), so no streaming compile
cache is lost either way.

### The backend's services

The apex's worker answers the services for the exec frame's worker only (the other frames' ports get files and nothing
else): `_services/nif/…`, `_services/git/…` and the relay's WebSocket.
`create({ services })` names the backend. The default is the site's own
backend when the page is its apex, and run-elixir.dev otherwise. That
backend answers only the origins on its allowlist
([backend.md](backend.md#service-origins)). Hex's cache does not move: it
already ran on the apex. It uses the apex's `/hex/` when the apex has one,
and the public mirror otherwise. run-elixir.dev's `/hex/` stays its own
pages' only.

### Security

- **The bootstrap runs only framed.** It throws before registering
  anything when `window.top === window` or when it has an opener. It
  takes its start only from `window.parent`, and nothing from its URL. It
  loads only a package's `.html` path below the bridge it made
  (`bridge-bootstrap.test.ts`).
- **A frame reaches only the page's packages.** The apex's worker fetches
  a bridged path only if it resolves below that package's `base` (or a
  service's URL) on the same origin. It refuses leading or doubled
  slashes, `.` and `..` segments, backslashes, and encoded `.`, `/` or
  `\`. It sends no credentials, so a path cannot reach the page's
  authenticated endpoints (`apexWorker.ts` `below`, `apex-worker.test.ts`).
- **Each bridge sees only its own files.** The service worker routes by
  the key in the path, not by client. It takes a new key only from the
  bootstrap page, and a key it knows only from a page below that key.
  After a restart it asks only the pages below that key for a port
  (`sw-bridge.test.ts`).
- **No downloads.** The service worker refuses a bridged response with
  `Content-Disposition: attachment` (403). Its documents carry
  `Content-Security-Policy: sandbox allow-scripts allow-same-origin
  allow-forms allow-modals allow-popups`, without `allow-downloads` or
  `allow-top-navigation`.
- **Nothing is hosted top-level.** A visitor who opens a shared-domain URL
  in a tab gets the bootstrap's refusal or a 404. No service worker
  answers there, because the bootstrap never registers one top-level
  (`bridge.spec.ts`).
- **Previews are always framed.** A popped-out preview is still an apex
  page (`preview.html`). A preview
  app's own responses are not checked for attachments: an app that offers
  a download still works.
- **The Node.js worker's policy holds.** Chromium 156, Firefox 157 and
  WebKit 27.2 apply a `Content-Security-Policy` that the service worker
  put on a worker script's synthesized response. Every escape in
  `escapes.ts` is blocked (`bridge.spec.ts`, 2026-10-29).
- **Each sandbox keeps its own bridge.** Its bridge (the table, the
  packages' paths) and its usercontent domain stay on the `Sandbox`. Its
  preview relays and its packages' shared frames use them, so another
  `create()` on the same page, on another domain, changes nothing for it.
  Relays and shared frames are cached by origin (`bridge.spec.ts`, two
  sandboxes on one page).

### Who may bridge

Only a shared domain's origins run the bootstrap. Any page may frame
`bridge.html` and feed it code, so an origin that has it runs whatever
another site's page supplies. Until 2026-10-30, `build.py` put
`bridge.html` in the site's root, which the apex and the usercontent
domain both serve. A page on any other site could then run its own code
on the apex's origin, where its same-origin requests passed the
services' allowlist (`Origin: https://run-elixir.dev`, `Sec-Fetch-Site:
same-origin`): NIF builds, git, the relay and `/hex/`. On the usercontent
domain, which then served the packages itself, it got around the
`embedders` list that domain had then. This was reproduced on
2026-10-30 against `serve.py`, in Chromium, Firefox and WebKit: a NIF
build answered 200 (`bridge-guard.spec.ts`).

Three things now prevent it:

- **The bootstrap ships only to the shared domain.** `build.py` writes
  it with `sw.js` and `bridge.json` to the site's `_usercontent/`, the
  usercontent domain's root, never to the site's root. The Vite plugin
  leaves it out of the apex's `dist/`. `serve.py`, and the Caddy example
  in [deploy.md](deploy.md#caddy), answer 404 on the apex for
  `/bridge.html`, `/bridge.json`, `/_usercontent/` and a runtime
  package's `root/bridge.html`. The package keeps the file: the Vite
  plugin serves it on its local usercontent hosts.
- **The bootstrap and `sw.js` check `/bridge.json`.** The bootstrap reads
  `/bridge.json` from its own origin before it says it loaded. It runs
  only if the file names a domain its host is below. `sw.js` checks the
  same before it takes a new key (`swProtocol.ts` `belowBridge`). A yes
  is kept for the worker's life, and a no is asked again. The check is a
  file of the deployment, not a constant of the build. `sw.js` and
  `bridge.html` are the same files on every domain and in the published
  runtime package, and which domain is shared is its operator's choice.
  A missing file (or the apex's page in its place) means no bridging.
- **No other site frames the apex's pages.** The apex sends
  `Content-Security-Policy: frame-ancestors 'self'`. The one apex page
  framed from another origin is `storage.html` on a former project origin
  (`p-ID.DOMAIN`), which the apex frames while it moves that origin's
  stores ([below](#moving-the-former-layouts-stores)). There it also lets
  the apex's origin. No other site frames an apex page: `embed.html` is
  gone, and the usercontent domain's frames are not apex pages.

Tested on 2026-10-30 against `serve.py`, in Chromium, Firefox and WebKit:
every bootstrap path on the apex answers 404, and a stranger's attempt
runs nothing there. A stranger that bridges the usercontent domain runs
its code there and reaches no service (404). The apex
refuses to be framed by another site (`bridge-guard.spec.ts`; Firefox
checks only the header, because Playwright's Firefox cannot inspect
another site's frame). The bootstrap's and the worker's checks have unit
tests (`bridge-bootstrap.test.ts`, `sw-bridge.test.ts`). The Caddy rules
have not been run against a live Caddy.

### What relies on storage partitioning

Browsers key a frame's storage, service worker registrations, and HTTP
cache by the top-level site as well as the origin. Bridge mode relies on
that for these guarantees:

- **Another site cannot reach an embedder's frames.** A site that frames
  `e-KEY.SHARED/bridge.html` gets its own service worker registration and
  storage under its own top-level site. It can feed code only to its own
  frames.
- **A shared frame's storage is per embedder.** The claude frame's
  cache is IndexedDB on its origin. Only frames under the same top-level
  site share it. Without partitioning, a hostile site could write
  prepared Claude Code that another embedder's projects would run.
- **A preview's state is per embedder.** The routes record and the
  preview's cookie jar (`cookies.ts`, local storage) live on the
  `v-KEY-PORT` origin.

Partitioning does **not** separate pages of one top-level site. A frame
inside the embedder's page (an ad, a widget) shares the embedder's
partition and can frame the shared domain's bootstrap too. So bridge
mode does not depend on partitioning for this:

- the service worker keeps bridges apart by their random key (above);
- the apex salts the origin names it uses with a secret in its own local
  storage (`playground-bridge-salt`, `usercontent.ts`). A project's
  origins (`e-KEY`, `v-KEY-PORT`) and the shared frames' (`NAME-HASH`)
  cannot be computed from the caller's project ids, which may be public
  (the IDE's are in its URLs), or from a package's name. Without the
  salt, another frame in the partition, such as a project's own preview,
  could run its own code on the embedder's claude or preview origins. The
  claude frame matters most: its cache holds the Claude Code that every
  project runs. The salt names origins only. A project's files and
  Postgres are on the apex, under a key without it (`sandbox.ts`
  `projectKeys`), so a lost salt changes only the origins' names
  ([api.md](api.md#project-keys)).

A browser with third-party storage partitioning turned off (for example,
by an enterprise policy) loses the first list. Bridge mode does not
detect that.

### Browser behavior found while building it

- **Firefox does not let the service worker control a blob worker that a
  worker starts.** Its imports then go to the network. So the exec
  frame's workers (`host/worker.ts`) and a Node.js process's threads
  (the nodejs package's `threads.ts`) start from their script's URL when bridged.
- **WebKit sends some concurrent worker loads of one URL past the service
  worker.** When several nodes start at once, each node's module worker
  loads `worker.js` and its static imports (`chunks/fs-*.js` and others)
  below `/_bridge/KEY/`. In WebKit, one of the loads of a URL reaches the
  service worker; others go to the network, where the shared domain's
  server answers 404. The console shows `Refused to load … because of
  Cross-Origin-Embedder-Policy` and `Importing a module script failed`,
  and the worker fires `error`. A load of the same URL on its own reaches
  the service worker. The runtime therefore loads its own workers one at
  a time in bridge mode, and starts a worker again when it fails to load
  (`host/worker.ts`, [runtime.md](runtime.md#page-and-node-host-worker)).
  The cause inside WebKit is not confirmed. Tidewave reported it with
  Playwright's WebKit 27.2 and in desktop Safari, where caching made it
  more frequent and `worker.js` itself also failed. `bridge.spec.ts`
  reproduces it by starting eight `sh` processes at once. Measured on
  2026-11-02 with Playwright 1.64's WebKit, against the local test
  embedder:

  | Runtime | Result |
  | --- | --- |
  | Before the fix | 6 or 7 of 8 nodes failed, in each of 3 runs |
  | Retries only | All started; 9–14 retries for 8 nodes, 21–31 for 16 |
  | One load at a time, and retries | All started; no retries in 12 runs of 8 and 16 nodes |

  Node.js processes are worker programs, which are not gated. Six
  `node -e` processes started at once needed one retry in two of four
  runs.
- **Firefox checks a synthesized response against `worker-src`,
  `script-src` (a dynamic import) and `connect-src` by the service
  worker's script URL (`/sw.js`), not by the request's.** So the Node.js
  worker's policy lists `/sw.js` in all three. `/sw.js` is public, and
  outside a service worker's scope it only adds listeners that never
  fire. Found when Claude Code's process failed a dynamic import.
- **A preview origin with an older `sw.js`** (protocol 1, before the
  bridge) routes `/bridge.html` into the app. This happens once when
  run-elixir-usercontent.org switches to bridge mode, on the preview
  origins a browser used before. The browser updates the worker on that
  navigation, so a reload recovers. Not handled automatically. The
  switch also changes every project's origin names (they are salted
  now), so most old origins are never visited again.

### Measurements

See [the bridge mode report](bridge-report.md#measurements) (2026-10-29,
localhost, Chromium 156, Firefox 157 and WebKit 27.2), measured against
the former mode, in which the usercontent domain served the packages. On
the final build, bridge mode boots within about 10% of that mode in every
browser, also with the apex's main thread kept busy, and `claude
--version` with a warm cache takes the same time. Chromium's and
Firefox's Ash compile take the same time in both modes; WebKit's median
was 11 to 18% slower in bridge mode over three runs, with overlapping
ranges, which is not explained.

## Measurements (2026-10-19)

A spike, in Playwright's Chromium (with site isolation on: the frame in a
process of its own), Firefox and WebKit, with the apex and a usercontent
domain on `*.localhost`:

| | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| A frame of another site is cross-origin isolated (SharedArrayBuffer, threads) | with `allow="cross-origin-isolated"` | yes | yes |
| A SharedArrayBuffer or a compiled WebAssembly module posted between the apex and that frame | no | no | no |
| A node's synchronous call to `files.js`, shared memory (as now) | 25 µs | 20 µs | 20 µs |
| The same call by messages to another site's worker | 105 µs | 180 µs | 340 µs |
| A preview's service worker in a frame of another site | yes | yes | yes |
| Timers of a hidden frame's page | normal | ~1 s when the tab is not in front | ~1 s offscreen |
| Timers of that frame's workers | ~4.5 ms | ~4.5 ms | ~4.5 ms |

A Phoenix project makes 4,814 such calls while it starts (4.2 s) and
10,880 in `mix compile --force` (2.9 s): by messages, 30% to 120% longer.
So the nodes and `files.js` stay together, and what is the page's work
now goes to a worker, never to a hidden frame's page.

## Moving the former layout's stores

A browser that ran a project on `p-ID.DOMAIN` keeps its files' changes and
its Postgres there. The apex moves them (`shared/lib/migrate.ts`) through
that origin's `storage.html` (`frames/storage.ts`), the apex's site, so a
frame of it sees its own storage (Chromium, Firefox; Safari ran projects
on the apex itself): it copies each database (stores, indexes, records:
`idbCopy.ts`) where the apex has none of its own, then has the frame
delete them, and the former layout's service worker and caches. A project
does so as it opens (waiting at most five seconds for the frame), the
home page for every listed project in the background; each once
(`playground-moved` in local storage). The frame keeps the former
storage frame's name: that layout's service worker, if the browser still
has it there, lets only its own frames' names through to the network.

## Tests in Firefox

Playwright's Firefox reaches no frame of another site (its frames show no
URL, and nothing in them can be found). There the tests read what the
preview shows from its page's own answer to the IDE
(`window.playground.previewSnapshot`, `bridge.ts`'s injected script),
and skip what needs a hand inside the preview (`helpers.ts`
`seesInPreview`, `reachesPreview`). Its page reloads wait for
`domcontentloaded`: Playwright would wait for those frames' `load`
forever.

## Deploying

A second site in Caddy for the usercontent domain, with a wildcard
certificate of its own. It serves the release's `_usercontent/`
(`/bridge.html`, `/sw.js`, `/bridge.json`) and nothing else: the
packages are the apex's, with CORS, and the Hex and git proxies,
`/api/v1/nif/` and `/relay` are the apex's too
([deploy.md](deploy.md#the-two-domains)). `PLAYGROUND_USERCONTENT` in the
build, `USERCONTENT` in `playground-deploy`'s configuration, which checks
the bootstrap's headers and `bridge.json` there. The apex's subdomains
stay for the former layout's addresses until their stores have moved.
Not deployed as of 2026-10-30.

## Not yet

- **A real Safari.** Playwright's WebKit runs all of this; Safari's own
  storage rules (ITP) for a frame of another site are not.
- **Firefox leaving a page** with a frame of another site in it hung in
  Playwright's Firefox, which the pages now avoid (`leave.ts`); a stock
  Firefox is not checked.
- **Deployment prerequisites:** configure wildcard DNS and a certificate
  for the usercontent domain. See [deploy.md](deploy.md#the-two-domains).
  The repository does not establish whether a particular deployment has
  completed these steps.
