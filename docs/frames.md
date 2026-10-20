---
kind: design
status: live
last_updated: 2026-10-19
---

# One trusted origin, and frames for what a project's code runs

The apex (run-elixir.dev) is the only origin that holds anything of the
user's: every page (the projects' list, `/ID/`, `/iex`, `/live/S`,
`/import`), every store, and, later, a login. Whatever a project's code
makes the browser run lives on another registrable domain, the
**usercontent domain** (`PLAYGROUND_USERCONTENT`; the name is not chosen
yet), framed by the apex's pages:

| Origin | What runs there |
| --- | --- |
| `DOMAIN` (the apex) | The IDE (React), the stores, the projects' list. Cross-origin isolated (COOP `same-origin`, COEP `require-corp`). |
| `v-ID-PORT.USERCONTENT` | The preview of port PORT of project ID's app: its pages, its service worker (`sw.ts`), and the relay frame that passes its requests to the IDE (`frames/relay.ts`). |
| `e-ID.USERCONTENT` | The exec frame: a worker that runs the project (below). |

The former layout ran each project's IDE on an origin of its own under the
apex (`p-ID.DOMAIN`, and a live guest's page on `l-ID.DOMAIN`), the same
site as the apex, so their cookies and same-site requests were the apex's
too, and code of the project's ran on the IDE's origin: a Tailwind
plugin (`programs/modules.ts`), a page the service worker served to any
frame, and in Safari (whose frames' storage is partitioned by origin)
the whole preview, on the apex itself. Those addresses now send their
visitors to the apex's; a project's stores there move to the apex (below).

## Previews on another site

The apex's page frames `v-ID-PORT.USERCONTENT/relay.html` for every port
its app serves (`previewOrigins.ts`); the relay registers its origin's
service worker and is its host there, and passes each request to the
IDE's bridge on a port the IDE gave it. The preview's own frame then
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

The IDE's page frames `e-ID.USERCONTENT/exec.html` (`allow="cross-origin-
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
  else), esbuild, git, `sh`, `rebar3`, `mix` and friends;
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
- **The terminals.** Their screens and line disciplines are the IDE's:
  keys are echoed and edited there, and lines go to the node.
- **What the IDE changes** (a save, the tree's operations) is kept before
  the frame answers: the page may go at once (a reload), and the frame
  with it. What the nodes change is kept a second later, as before.

A live session's guest has no exec frame: its page's bridge answers the
relays of its own preview origins, its connections tunnelled to the
host ([collaboration.md](collaboration.md#the-preview)).

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

## Next

1. **Deploy.** A second site in Caddy with a wildcard certificate of its
   own; the old `*.DOMAIN` names for the move only.
