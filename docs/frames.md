---
kind: design
status: live
last_updated: 2026-10-27
---

# One trusted origin, and frames for what a project's code runs

The apex (`run-elixir.dev` in the deployment examples) hosts the IDE,
project storage, settings, GitHub token, and Tailscale credentials.
Project code runs on a separate registrable domain, configured with
`PLAYGROUND_USERCONTENT` (`run-elixir-usercontent.org` in the examples).

| Origin | Runs there |
| --- | --- |
| `DOMAIN` | React IDE, project list, stores, PGlite, and Tailscale shared worker. |
| `e-ID.USERCONTENT` | Project exec frame and its workers: BEAM, Node.js, tools, and plugins. |
| `v-ID-PORT.USERCONTENT` | Preview, service worker, and relay frame for one project server port. |
| `claude.USERCONTENT` | Claude Code preparation worker and cached files. |

The previous layout put project IDEs on `p-ID.DOMAIN` and guest pages on
`l-ID.DOMAIN`. Those URLs now redirect to the apex. Legacy project stores
are migrated when a project opens or the home page lists it.

## Previews on another site

The apex's page frames `v-ID-PORT.USERCONTENT/RUNTIME/relay.html` (`RUNTIME`
the runtime package's path, `/npm/@elixir-playground/runtime@VERSION+ID`:
[packages.md](packages.md)) for every port
its app serves (`previewOrigins.ts`). The relay registers its origin's
service worker and forwards requests to the exec host's bridge through
a MessagePort supplied by the IDE. The preview's own frame then
loads that origin. Both frames are the apex's site's, so the browser
keys their storage, service worker and cookies by the apex's site
(partitioned): the same partition for both, and for a popped-out
preview, which is an apex page (`preview.html`) framing it the same way.

- **Headers.** Every answer of the service worker carries COEP
  `require-corp` and CORP `cross-origin` (the apex frames it from
  another site); `serve.py` and Caddy answer the usercontent domain's
  hosts the same.
- **Cookies.** A frame of another site keeps no cookies of its own in
  WebKit, and only `SameSite=None; Secure` ones in Chromium. The app's
  HttpOnly cookies stay in the bridge's jar, as before; those its
  JavaScript may read are kept in the origin's local storage
  (`cookies.ts`), which the relay sends with each request and the app's
  pages see as `document.cookie` (a shim the bridge puts in each page).

## The exec frame

The IDE's page frames `e-ID.USERCONTENT/RUNTIME/exec.html` (`allow="cross-origin-
isolated"`, which Chromium asks for: the nodes' threads need it). Its page
only starts a worker (`exec/host.ts`) and hands it the port the IDE gave:
a hidden frame's page has its timers slowed, a worker's are not. The frame
is not hidden either, but a pixel on the screen, unseen (`.exec-frame`):
in a `hidden` one, WebKit slowed the nodes' workers (the worker's own
workers) until a node waiting on a program's exit never heard of it. The
worker runs what the IDE's page ran before:

- `files.js` and the nodes, a shell per terminal tab and one per command
  they run, and their routing to each other's ports;
- the page programs: Tailwind (the project's plugins run here, nowhere
  else), esbuild, git, `sh`, `rebar3`, `mix` and friends, and `node`, `npm`, and `npx`, whose processes are
  workers of this one, held by a `Content-Security-Policy` of their own to
  no network but this worker's messages
  ([nodejs.md](nodejs.md#the-workers-policy));
- epmd, HTTPS by fetch (from this origin: no cookie of the apex goes
  along), and the bridge to the app for the preview, whose relays send
  their requests straight to it on ports the IDE hands over.

The IDE's page drives it over a port (`shared/lib/rpc.ts`): calls for
files, shells and the preview, events back for output, status, the
ports served, changed files, NIF builds, CSS and bundles. What is the
apex's stays the apex's:

- **The stores.** `files.js` keeps a project's changes through a port to
  the IDE's page (`overlay.ts` `remote`), which writes them to the apex's
  IndexedDB (`serveStore`). PGlite runs on the IDE's page. The frame
  writes no store of its own.
- **Postgres and Hex's cache.** A node's connections to 5432 and to Hex's
  port are carried over ports to the IDE's page (`portConnection.ts`),
  which answers them as before.
- **Tailscale's device** ([tailscale.md](tailscale.md)): a shared
  worker of the apex's, its keys in the apex's IndexedDB. The frame asks
  the IDE's page for each connection through the tailnet and each name;
  the page decides (the project's answer, a live session's guests) and
  hands the connection's port to that worker.
- **The terminals.** Their screens are the IDE's; their line
  disciplines are the frame's, one per process on a terminal
  (`exec/host.ts` `spawn`, the process API that `embed.html` uses too):
  the IDE sends the keys, and the echo comes back with the output.
- **What the IDE changes** (a save, the tree's operations) is kept before
  the frame answers: the page may go at once (a reload), and the frame
  with it. What the nodes change is kept a second later, as before.

## The claude frame

`claude` ([nodejs.md](nodejs.md#claude-code-claude-programsclaudeclaudets))
runs the JavaScript embedded in Claude Code's npm package, a Bun
executable. The claude frame downloads 125 MB from the registry and
extracts and compiles the JavaScript in about 20 seconds. It caches the
result once per version for all projects, on a separate origin. The apex
does not store or execute Claude Code.

- **Frame creation:** when a project first runs `claude`,
  `programs/claude/frame.ts` creates an invisible iframe at
  `claude.USERCONTENT/RUNTIME/claude.html`, using the same approach as the exec
  frame. `frames/claude.ts` starts the worker in
  `programs/claude/worker.ts` and forwards ports received from the IDE.
  It accepts ports only from the IDE's origin.
- **Connections:** each run requests a port from the IDE through
  `claudePort`. The IDE gives one end of a channel to the exec frame and
  the other to the claude frame. The worker handles `files` requests by
  transferring the cached file buffers. During preparation, it sends
  `progress` events.
- **Shared cache:** every project's IDE embeds the claude origin under
  the same apex site, so the frames share an IndexedDB storage partition.
  Subsequent projects reuse the cached files. A Web Lock serializes
  preparation across tabs.
- **Cache access:** projects can request cached files but cannot modify
  the cache. Only the worker writes to it. The worker fetches the version
  pinned by the site and verifies its integrity before preparing the
  files. It does not execute Claude Code.

A live session's guest has no exec frame: its page's bridge answers the
relays of its own preview origins, its connections tunnelled to the
host ([collaboration.md](collaboration.md#the-preview)).

## Embedded by another site

`embed.html` is the apex's part of a project without the IDE, framed by
another site (an embedder the site names) that drives it from
`embed.js`; it frames the same exec, claude and relay frames, which
still answer the apex alone ([embed.md](embed.md)).

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
certificate of its own, its headers, the Hex and git proxies and
`/api/v1/nif/` ([deploy.md](deploy.md#the-two-domains)); `PLAYGROUND_USERCONTENT`
in the build, `USERCONTENT` in `playground-deploy`'s configuration, which
checks an exec frame's headers there. The apex's subdomains stay for the
former layout's addresses until their stores have moved.

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
