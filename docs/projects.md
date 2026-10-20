---
kind: design
status: live
last_updated: 2026-10-16
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

## The apex and the usercontent domain

Every page is the apex's (`playground.json`'s `domain`;
`PLAYGROUND_DOMAIN` when building, [deploy.md](deploy.md)), and what a
project's code runs is another site's, the usercontent domain's
(`usercontent`, `PLAYGROUND_USERCONTENT`): [frames.md](frames.md),
`src/shared/lib/site.ts`.

| Where | What |
| --- | --- |
| `DOMAIN/` | The home page, as above. |
| `DOMAIN/phoenix`, `/empty`, `/import#DATA` | Make a project, then go to its page. |
| `DOMAIN/ID/` | The project: its IDE and nodes. |
| `DOMAIN/iex` | A temporary IEx (it keeps nothing). |
| `v-ID-PORT.USERCONTENT/` | The project's preview of its app's PORT, in the IDE ([runtime.md](runtime.md)); opened by itself, not found. |
| `p-ID.DOMAIN/`, `l-SESSION.DOMAIN/live/SESSION` | The former layout's (a project's own origin, a live guest's): go to the apex's `/ID/` and `/live/SESSION`. |
| Any other name under either domain | Not found, with a button to `DOMAIN/`. |

The projects' list, their files and databases are the apex's. A
preview's origin keeps what the app in it keeps (its service worker,
cookies, local storage), partitioned by the apex's site.

Before, each project ran on an origin of its own under the apex
(`p-ID.DOMAIN`); a browser that used one has its stores moved to the
apex as it opens the project, or the home page
([frames.md](frames.md#moving-the-former-layouts-stores)). Safari, whose
frames' storage is partitioned by origin, ran projects on the apex
itself.

## What is kept

Three IndexedDB databases, all named after the project's id
(`src/shared/lib/storage.ts`):

| Database | Holds | Written by |
| --- | --- | --- |
| `playground` (Dexie), table `projects` | id, name, kind, created and opened times | the page |
| `playground-files-ID` | what changed below `/work`, and below `/home` (home: Mix's, Hex's and the tools' caches, escripts; not in the tree, search or a share link) | `files.js` (`src/runtime/overlay.ts`) |
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

*Share* in the top bar offers a link or a live session. A live session
lets others join the project as it runs in this tab
([collaboration.md](collaboration.md)); its guests' pages are
`/live/ID#KEY`, and on a project domain `l-ID.DOMAIN`. A link is the
project's changes over its template, copied (`src/shared/lib/share.ts`):

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
want a server to keep them
([collaboration.md](collaboration.md#later-stored-shares-and-accounts)).

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
- **Shares on a server,** for projects too large for a link, encrypted
  in the browser ([collaboration.md](collaboration.md#later-stored-shares-and-accounts)), and git
  history in a project, a diff view and accounts ([git.md](git.md)).
- **Live sessions:** what is left ([collaboration.md](collaboration.md#not-built-yet)).
