---
kind: design
status: live
last_updated: 2026-10-21
---

# Projects

Everything a user makes is a project, kept in the browser that made it.
Nothing is stored on the server.

## Kinds and URLs

| Path | What |
| --- | --- |
| `/` | The home page: new projects (also from a folder on this computer), and the projects in this browser, last opened first, each deletable. |
| `/phoenix` | Make a Phoenix project and go to it. |
| `/empty` | Make an empty project and go to it. |
| `/iex` | A temporary IEx: an empty project whose first shell runs `iex`, kept nowhere, marked *ephemeral*. Each visit is a new one. |
| `/ID/` | A project. `ID` is ten random letters and digits; an unknown one says so. |
| `/import#DATA` | A shared project's link: what it holds, and a new project made from it. |

Every path is the same page (`index.html`; the server falls back to it, see
[deploy.md](deploy.md)). The tab moves between them in place
(`shared/lib/navigate.ts`, `main.tsx`): a link to one of these paths,
back and forward render the next page without loading it, so what lives
as long as the tab stays (the Tailscale node's connection,
[tailscale.md](tailscale.md)). Leaving a project ends what it ran as a load
would (`leave` in `playground.ts`): its changes kept, its exec frame and
PGlite stopped, its lock let go, its terminals and stores reset, a popped-out
preview closed, a live session left (not ended: it resumes when the project
opens again in the tab). A live session's guest's page is left by a load.

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
(`src/shared/lib/storage.ts`), besides the user's own (below):

| Database | Holds | Written by |
| --- | --- | --- |
| `playground` (Dexie), table `projects` | id, name, kind, created and opened times; where it came from (a link, a fork), whether it takes the user's settings, its own settings | the page |
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

## Settings

The user's, for every project of the browser, on the apex's `/settings`
page; a project's own, in its top bar (`src/shared/lib/settings.ts`).

| Setting | Of | Applies |
| --- | --- | --- |
| Environment | the user; a project's over it | each new shell, and what it runs: the user's under the playground's own (Hex's, the cookie, the preview's), so they cannot clobber them |
| `/shared` | the user (on unless turned off) | at a project's start: the same folder in every project, kept on the apex |
| Setup script | the user | once, in a new project's first shell, at its first start (sourced, so its lines run as a script); projects made before it never run it |
| Startup lines | a project | at each start, in its first shell, in place of its kind's (Phoenix's `iex -S mix phx.server`) |

Kept in the apex's `playground` database: the user's in table
`settings`, a project's on its record. Saving reaches the new shells of
the projects open (a `BroadcastChannel`); `/shared`, the startup lines
and whether a project takes the user's settings, its next start.

- **`/shared`** is the apex's database `playground-shared`, served to each
  project's `files.js` over a port, as a project's own store is.
  `files.js` keeps changes by prefix: the project's (`/work`, `/home`)
  within a second, `/shared`'s within 200 ms, and reports what it keeps
  in `/shared` to the IDE's page, which tells the other projects open,
  whose `files.js` lays it over theirs (a file changed in place, so what
  has it open reads it). The last change to a file wins. A project
  without it (turned off, a link's) has an empty `/shared`, kept nowhere.
  Link a tool's folder in to share it: `ln -s /shared/claude ~/.claude`.
- **From someone else:** a project made from a share link or a live
  session's fork is marked so, and asks at its first start, before
  anything runs, whether it takes the user's settings: their environment
  (the names, not the values), `/shared` if it holds anything, the setup
  script's first line. Its code could read them. Closing says no; the
  project's settings change the answer. A user with nothing to give is
  not asked. A link carries files only, never settings.
- **Live sessions:** while a guest who may type or edit is in, new shells
  start without the user's environment and `/shared` is an empty folder
  in its place, the real one back once no such guest is (the host's
  choice, on unless unchecked; shells already running keep what they
  had).

## A folder from this computer

A note under the new projects' cards offers a Mix project on the user's
computer: dropped anywhere on the home page, or chosen
(`src/home/components/FolderImport.tsx`, `src/shared/lib/folder.ts`). It
becomes an empty project named after the folder, whose files go straight
into `/work` (the first shell starts in the project): the same seed a
shared link makes, laid down before the first shell starts. Nothing
reaches a server.

Left out from the start, and not shown:

- what the file tree hides (`_build`, `deps`, `.mix`, `.hex`,
  `node_modules`, `.git`, `.elixir_ls`): builds were made on another
  machine, and `mix deps.get` fetches the dependencies;
- what the folder's `.gitignore` files ignore (`src/shared/lib/gitignore.ts`:
  comments, `!`, a trailing `/`, anchoring, `*`, `?`, `[…]`, `**`; a deeper
  file over a shallower one; what is below an ignored directory is not
  taken back).

A dropped folder's left-out directories are not even read. The picker
(`<input webkitdirectory>`) lists every file, and the page filters them;
WebKit (Safari, and every browser on iOS) gives no files or directories
whose names start with a dot, so no `.gitignore` either, and no symlinks;
the panel says so there (`losesDotfiles`). A folder of more than 100,000 files past all that is
refused as it is read (someone's home, not a project's).

Reading lists the files without their bytes (a `File` is a handle), so
the folder is then shown as a tree of its directories, largest first (by
what they take of the limits), each with its files and size and a
checkbox to leave it out with all below it. Editors' and tools'
directories a `.gitignore` often misses (`.expert`, `.lexical`,
`.elixir-tools`, `.next-ls`, `cover`) start unchecked. A project starts
with at most 5000 files and 64 MB (they are read into memory, kept in
IndexedDB until it starts, and then in the tree): past that the panel says
so and *Open as a new project* waits until enough is left out. Only the
files kept are read.

A Phoenix app comes in as an empty project too, not over the Phoenix
template: PGlite starts on its first connection and the preview once it
serves.

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
