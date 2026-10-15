---
kind: design
status: live
last_updated: 2026-10-14
---

# Projects

Everything a user makes is a project, kept in the browser that made it.
Nothing is stored on the server.

## Kinds and URLs

| Path | What |
| --- | --- |
| `/` | The home page: new projects, and the projects in this browser, last opened first, each deletable. |
| `/phoenix` | Make a Phoenix project and go to it. |
| `/empty` | Make an empty project and go to it. |
| `/iex` | A temporary IEx: an empty project whose first shell runs `iex`, kept nowhere, marked *ephemeral*. Each visit is a new one. |
| `/ID/` | A project. `ID` is ten random letters and digits; an unknown one says so. |
| `/import#DATA` | A shared project's link: what it holds, and a new project made from it. |

Every path is the same page (`index.html`; the server falls back to it, see
[deploy.md](deploy.md)). Moving between pages is a whole page load, so a
project's workers end when its page does.

A project's kind (`src/project/lib/kinds.ts`) decides how it starts:

| | Phoenix | Empty, temporary IEx |
| --- | --- | --- |
| Boot images | `boot`, `boot-phoenix` | `boot` |
| `/work` starts with | the template, `/work/playground` | nothing |
| Shells start in | `/work/playground` | `/work` |
| First shell runs | `iex -S mix phx.server` ("Server" tab) | nothing ("Shell"), `iex` ("IEx") |
| Preview | from the start | once a node serves (4000, else its lowest port) |
| Files and editor | shown | shown; a temporary IEx starts with the terminals maximized |

PGlite starts for any kind on the first connection to 5432. A new project
gets a random name (`brave-otter`), renamed by clicking it in the top bar.

## A project domain

A site may have a project domain (`playground.json`'s `domain`;
`PLAYGROUND_DOMAIN` when building, [deploy.md](deploy.md)). Then each
project runs on an origin of its own, and the apex (the domain itself)
has everything else (`src/shared/lib/site.ts`):

| Where | What |
| --- | --- |
| `DOMAIN/` | The home page, as above. |
| `DOMAIN/phoenix`, `/empty`, `/import#DATA` | Make a project, then go to its origin. |
| `DOMAIN/iex` | A temporary IEx, on the apex (it keeps nothing). |
| `DOMAIN/ID/` | An older link: goes to `p-ID.DOMAIN/`. |
| `p-ID.DOMAIN/` | The project: its IDE, nodes and preview. |
| Any other `NAME.DOMAIN/` | Reserved (`www`, `phoenix`, …): not found, with a button to `DOMAIN/`. |

A project's subdomain is `p-` and its id (`p-` and a chosen name could
follow); every other name stays free for the site. A `p-ID` this browser
has no project for is not found either; if the project's files or
database are still kept on that origin (its entry gone from the list),
the page says so and offers to delete them, which only that origin can.

A project's files, database, service worker, Hex cache, and the cookies
and local storage of the app in its preview are its origin's own, and
the preview's service worker has only that project to send a request to
(with one origin it tells projects apart by their tabs: a navigation by
the document that started it, else the only, focused or last tab).

The projects' list stays the apex's. The two sides call each other
through a hidden frame of the other origin (`src/shared/lib/frames.ts`),
which answers only the origins it lets in. The apex and its projects are
one site, so in Chromium and Firefox, which key a frame's storage by site,
neither frame's storage is partitioned:

- `DOMAIN/registry.html`, in a project's page: the project's entry
  (read, renamed, opened, its template, a link's seed), and only its
  own. It holds the project's lock on the apex for as long as the page
  lives, so the home page marks it open.
- `p-ID.DOMAIN/storage.html`, in the home page: deletes what the project
  keeps on its origin (`registry.ts`), refused while a tab runs it.

Safari (and every browser on iOS) keys a frame's storage by the page's
origin, so there each side's frame sees an empty store of its own. That is
found out rather than guessed from the browser's name (`site.ts`): the
apex's page keeps a key in its local storage and in a cookie, and a
registry frame that sees the cookie but not the key is partitioned. The
project's page then goes to the apex's `/ID/?one-origin`, and from then on
the apex runs its projects itself at `/ID/`, as a site without a project
domain does. On `*.playground.localhost` WebKit takes each name for a site
of its own and shows the frame no cookie, so the browser tests cannot
reach this; it was checked by hand in Safari on the deployed site.

Projects made before a site had a domain stay where they were, on the
origin that made them.

## What is kept

Three IndexedDB databases, all named after the project's id
(`src/shared/lib/storage.ts`):

| Database | Holds | Written by |
| --- | --- | --- |
| `playground` (Dexie), table `projects` | id, name, kind, created and opened times | the page |
| `playground-files-ID` | what changed below `/work` | `files.js` (`runtime/overlay.js`) |
| `/pglite/playground-pg-ID` | the project's Postgres | PGlite (`idb://playground-pg-ID`) |

### Files: an overlay over the template

A project keeps only what it changed. Its template stays on the site, so a
new project costs nothing until it is used. `files.js` notes each changed
path below `/work` (a closed written file, a directory made, removed or
renamed) and, a second later, writes one record per path:

- `{ kind: 'file', data, mtime }`: the bytes and modification time (Mix
  compares mtimes);
- `{ kind: 'dir', opaque, mtime }`: a directory; *opaque* when it replaced
  a removed one or was moved there, so the template's entries in it stay
  out;
- `{ kind: 'gone' }`: a whiteout.

A moved directory is written with everything in it. On start, the records
are applied over the template in path order (a directory before its
contents). `Files.flush()` writes what is pending at once; the page asks
for it before it lets a project go to another tab. A change less than a
second old is lost if the tab closes.

Everything below `/work` is kept, `_build` and `deps` included, so a reload
does not recompile. The records note the site version (`fs/version`, a
digest of the filesystem) they were made over. Over another version, the
template's `_build` records are dropped: the new template's build is used
and the project's sources recompile over it. A project without a template
keeps its `_build` as it is.

## Template versions

The build names each template (`fs/templates.json`): an id, a digest of
its files without its build (which changes with the runtime, not with
the template), and a label (`phx.new 1.8.15`). A Phoenix project records
the template it was made from, and so does a shared link; a project made
before templates had versions takes the current one when first opened.

A project whose template is not the site's says so in a notice under its
top bar: its changes now sit over the current template, which may not fit
them (a changed config, a newer lock). Dismissing it takes the current
template as the project's. The import page says the same of a link made
from another template.

Older templates are not kept: a template's build is compiled by the
runtime it shipped with, so keeping one means keeping that whole site
(runtime, boot images, bundles) beside the new one, at a path of its own.

## One tab per project

A page runs a project while it holds the project's Web Lock
(`playground-project:ID`, `src/shared/lib/lock.ts`). Another tab opening the
project finds the lock taken and offers *Open it here*. That asks the holder
over a BroadcastChannel to let go: it flushes its files, stops its nodes,
closes PGlite, releases the lock, and says the project is open elsewhere
now. A holder that does not answer within 5 s loses the lock anyway (and
stops when it notices).

Different projects run in different tabs at once. The service worker
routes each preview to its project's page ([runtime.md](runtime.md#the-preview-swjs-bridgejs)).

## Sharing

*Share* in the top bar makes a link to the project's changes over its
template and copies it (`src/shared/lib/share.ts`):

- **What:** the files below `/work` it added, renamed or wrote, whole, and
  the template's files it removed (`files.js`'s `changes`, against the
  template's files as the project started), but nothing in `_build`,
  `deps`, `.mix`, `.hex`, `node_modules`, `.git` or `.elixir_ls`, and not
  the database. Plus its kind, its name and the site version.
- **How:** JSON (text as text, other bytes as base64), compressed
  (deflate-raw), base64url, in the link's fragment: `/import#DATA`. The
  fragment never reaches a server.
- **Opening it** shows the name, kind and files, and *Open as a new
  project* makes one, keeping the link's changes as its seed (Dexie table
  `seeds`). The project lays them over its template before its first
  shell starts, so a Phoenix server boots with them; the seed is then
  gone. Dependencies a shared `mix.exs` adds come with `mix deps.get`.

Whole files, rather than line diffs, apply exactly over any version of
the template, and compression takes most of the difference in size: a
Phoenix project with one edited template file and one removed makes a
link of a few KB. A link holds what a URL can; very large projects will
want a server to keep them (with the collaboration server).

## Deleting

Deleting from the home page takes the project's lock (so not while a tab
runs it), deletes both of its databases and then its row. The home page
marks projects open in a tab. With a project domain, the project's
storage frame takes the lock and deletes on its origin (also its caches
and service worker), and then the apex deletes the row.

## Plans

Not built yet; the design leaves room for them.

- **Export and import.** A project as a zip: its kind, name, and its
  changed files (the overlay without `_build`), imported over the same
  template.
- **Shares on a server,** for projects too large for a link, and git
  history in a project (the shell's `git` beyond what Mix asks).
- **Collaboration.** Two browsers on one project, tunnelling TCP (the
  preview's and the database's connections) and file access over WebRTC
  (with a small rendezvous service) or a Phoenix channel. The page reaches
  the nodes only through `Files` and the port routing in
  `src/project/lib/playground.ts`, which a remote side could stand behind.
