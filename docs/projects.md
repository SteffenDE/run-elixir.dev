---
kind: design
status: live
last_updated: 2026-10-27
---

# Projects

Projects run in the browser and store their files and databases there.
The server does not persist project contents. Sharing a link exports a
copy; live collaboration streams the running project through an encrypted
relay.

## Kinds and URLs

| Path | What |
| --- | --- |
| `/` | The home page: new projects (also from a folder on this computer), and the projects in this browser, last opened first, each deletable. |
| `/phoenix` | Make a Phoenix project and go to it. |
| `/empty` | Make an empty project and go to it. |
| `/iex` | A temporary IEx: an empty project whose first shell runs `iex`, kept nowhere, marked *ephemeral*. Each visit is a new one. |
| `/ID/` | A project. `ID` is ten random letters and digits; an unknown one says so. |
| `/import#DATA` | A shared project's link: what it holds, and a new project made from it. |
| `/github/OWNER/REPO[/tree/REF]` | A public repository (`/gitlab/…`, `/codeberg/…` too), and a new project cloned from it ([git.md](git.md#opening-a-repository)). |

All app routes load `index.html`. Navigation between app pages uses the
client-side router (`shared/lib/navigate.ts`, `main.tsx`).

The active project keeps running while the tab shows the home page,
Settings, Tailscale, the relay page, or an import preview. A return link
opens its IDE again. Opening a different project asks what to do with
unsaved editor changes, then flushes saved files, stops the old runtime
and PGlite, releases its lock, and closes its detached preview.
A live guest page uses a full navigation when leaving.

Additional routes are `/settings`, `/tailscale`, `/relay`, and
`/live/ID#k=KEY&h=HOSTKEY` for a live-session guest.

A project's kind (`src/project/lib/kinds.ts`) chooses its files and initial
settings. Startup commands are saved on the project and remain editable:

| | Phoenix | Empty, temporary IEx |
| --- | --- | --- |
| Boot images | `boot`, `boot-phoenix` | `boot` |
| `/work` starts with | the template, `/work/playground` | nothing |
| Shells start in | `/work` | `/work` |
| Initial startup setting | `cd playground && iex -S mix phx.server` ("Server" tab), editable | empty ("Shell"), `iex` for a temporary IEx ("IEx") |
| Preview | from the start | once a node serves (4000, else its lowest port) |
| Files and editor | shown | shown; a temporary IEx starts with the terminals maximized |

PGlite starts for any kind on the first connection to 5432. A new project
gets a random name (`brave-otter`), renamed by clicking it in the top bar.

## The apex and the usercontent domain

The IDE runs on the apex. Project code runs on a separate usercontent
domain. `playground.json` records both domains, configured at build time
with `PLAYGROUND_DOMAIN` and `PLAYGROUND_USERCONTENT`. See
[deploy.md](deploy.md), [frames.md](frames.md) and `src/shared/lib/site.ts`.

| Where | What |
| --- | --- |
| `DOMAIN/` | The home page, as above. |
| `DOMAIN/phoenix`, `/empty`, `/import#DATA` | Make a project, then go to its page. |
| `DOMAIN/ID/` | The project IDE. |
| `e-ID.USERCONTENT/` | The exec frame and project runtime. |
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

Project metadata uses the shared `playground` database. Each project
has two additional databases for files and Postgres
(`src/shared/lib/storage.ts`):

| Database | Holds | Written by |
| --- | --- | --- |
| `playground` (Dexie), table `projects` | id, name, kind, created and opened times; where it came from (a link, repository, or live-session fork), whether it takes the user's settings, its own settings | the page |
| `playground-files-ID` | Changes below `/work` and `/home`, including tool caches and escripts. `/home` is excluded from the tree, search and share links. | Apex storage, through a port from `files.js` (`packages/runtime/src/overlay.ts`) |
| `/pglite/playground-pg-ID` | the project's Postgres | PGlite (`idb://playground-pg-ID`) |

### Files: an overlay over the template

A project keeps only what it changed. Its template stays on the site, so a
new project costs nothing until it is used. `files.js` notes each changed
path below `/work` or `/home`. After a one-second debounce, it sends
records to the apex for storage:

- `{ kind: 'file', data, mtime }`: the bytes and modification time (Mix
  compares mtimes);
- `{ kind: 'dir', opaque, mtime }`: a directory; *opaque* when it replaced
  a removed one or was moved there, so the template's entries in it stay
  out;
- `{ kind: 'link', target, mtime }`: a symbolic link;
- `{ kind: 'gone' }`: a deleted path, which hides the template entry.

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

The build names each template (its package's `playground` field in
`site.json`, [packages.md](packages.md)): an id, a digest of
its files without its build (which changes with the runtime, not with
the template), and a label (`phx.new 1.8.16`). A Phoenix project records
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
routes each preview to its project's page ([runtime.md](runtime.md#the-preview-swjs-bridgets)).

## Sharing

*Share* in the top bar offers a link or a live session. A live session
lets others join the project as it runs in this tab
([collaboration.md](collaboration.md)); its guests' pages are
`/live/ID#k=KEY&h=HOSTKEY` on the apex. A link is the
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

Manage browser-wide settings at `/settings` on the apex. Manage
project-specific settings from the project's top bar
(`src/shared/lib/settings.ts`).

| Setting | Scope | Applies |
| --- | --- | --- |
| Environment | User defaults with project overrides | New shells and their child processes inherit the variables. Playground variables, including Hex, cookie, and preview settings, take precedence over both. |
| `/shared` | User; enabled by default | Mounted at project startup. All projects share the same folder, stored on the apex. |
| Setup script | User | Sourced once in a new project's first shell, on its first start. Projects created before this feature never run it. |
| Startup lines | Project | Run in the first shell at each start, from `/work`. A Phoenix project's saved value initially contains `cd playground && iex -S mix phx.server`; it can be edited or cleared to start an empty shell. The start/restart action also uses the saved commands, starting from `/work`. |

The apex's `playground` database stores user settings in the `settings`
table and project settings on each project record. A `BroadcastChannel`
notifies open projects when settings change. Environment changes apply to
new shells. Startup changes apply on the next project start or use of the
start/restart action. Changes to `/shared` and permission to use the user's
settings apply when the project restarts.

- **`/shared`** is stored in the apex's `playground-shared` database.
  Each project's `files.js` accesses it over a port, using the same
  mechanism as the project's own store. `files.js` saves changes to
  `/work` and `/home` within a second and `/shared` changes within 200 ms.
  The IDE broadcasts saved `/shared` changes to other open projects.
  Each project's `files.js` updates the affected files in place, so
  existing file handles see the changes. The last change to a file wins.
  Projects without access to the shared folder get an empty `/shared`
  whose contents are not persisted. To share a tool's settings, link its
  configuration folder to `/shared`: `ln -s /shared/claude ~/.claude`.
- **Imported projects:** projects created from a repository or share link, or forked
  from a live session are marked as imported. Before running any code
  on their first start, they ask for permission to use the user's
  settings. The dialog lists environment variable names without their
  values, `/shared` if it contains anything, and the setup script's first
  line. The project's code could access these settings. Closing the
  dialog declines access. The user can change this decision in Project
  settings. The dialog is skipped if no user settings would apply. Share
  links contain files only and never include settings.
- **Live sessions:** by default, new shells omit the user's environment
  variables and `/shared` appears empty while any guest has permission
  to type or edit. The shared folder is restored when those guests leave
  or lose that permission. Hosts can disable this behavior. Existing
  shells retain their environment.

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

The home page can stop and delete the project running in the current tab.
A project running in another tab must be closed there first.
`deleteProject()` takes the project's Web Lock, deletes its file and
PGlite databases on the apex, then removes its metadata and seed.
Legacy-origin migration is handled separately by `migrate.ts`.

## Plans

Not built yet; the design leaves room for them.

- **Export and import.** A project as a zip: its kind, name, and its
  changed files (the overlay without `_build`), imported over the same
  template.
- **Shares on a server,** for projects too large for a link, encrypted
  in the browser ([collaboration.md](collaboration.md#later-stored-shares-and-accounts)), and accounts ([git.md](git.md#accounts)). Git history and the diff view
  are already implemented.
- **Live sessions:** what is left ([collaboration.md](collaboration.md#not-built-yet)).
