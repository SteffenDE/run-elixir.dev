---
kind: design
status: live
last_updated: 2026-10-13
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

## Deleting

Deleting from the home page takes the project's lock (so not while a tab
runs it), deletes both of its databases and then its row. The home page
marks projects open in a tab.

## Plans

Not built yet; the design leaves room for them.

- **Export and import.** A project as a zip: its kind, name, and its
  changed files (the overlay without `_build`), imported over the same
  template.
- **Sharing through git.** A git in the playground (a page or worker
  program behind the shell's `git`), with the template committed as a
  project's baseline when it is made. A share is then the template's
  version plus a compressed diff of the tracked files, applied over the
  template in the other browser. Git is for sharing, not for keeping: the
  overlay also keeps the untracked `_build` and `deps`, which a diff would
  lose, and costs no hashing per save.
- **Collaboration.** Two browsers on one project, tunnelling TCP (the
  preview's and the database's connections) and file access over WebRTC
  (with a small rendezvous service) or a Phoenix channel. The page reaches
  the nodes only through `Files` and the port routing in
  `src/project/lib/playground.ts`, which a remote side could stand behind.
