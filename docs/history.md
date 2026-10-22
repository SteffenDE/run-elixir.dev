---
kind: design
status: plan
last_updated: 2026-10-21
---

# A project's history

A plan: every state of a project's files, and of its database, kept as
it changes, so that any moment can be looked at, compared and restored
at once. One mechanism, also behind the overlay that keeps a project
([projects.md](projects.md#files-an-overlay-over-the-template)), git's
baseline commit ([git.md](git.md#a-baseline-commit)) and shares.

## Why now

An agent in the project (Claude Code, [frames.md](frames.md)) changes
many files, runs commands, migrates the database. *Undo everything since
I asked for X* wants more than its own checkpoints, which know only the
files its tools edited: also what a command wrote, what `mix deps.get`
fetched, and the rows a migration changed.

## Content-addressed, in git's format

Every write already reaches one tree, in one worker (`files.js`,
`src/runtime/files.ts`). History lives there:

- **Blobs** by `sha1("blob N\0" + bytes)`, **trees** as git's, of the
  tree's directories: a moment is one root hash.
- **Hashes are cached on the nodes.** A write clears its file's and its
  directories' up to the root, so a snapshot hashes what changed since the
  last one, not the whole of `node_modules`.
- **A checkpoint** is `{ root, database, time, why, HEAD }`: taken a
  second after the last write (when the overlay writes now), before each
  shell command, at each of an agent's turns (a hook), and by hand.
- **Kept** in IndexedDB (or OPFS for the blobs, if large ones are slow),
  per project, beside or instead of the overlay.

Git's format makes a checkpoint a commit for free (*keep this as a
commit*), lets the diff view ([git.md](git.md#a-diff-view-for-review))
compare any two moments, and lets git.wasm read the store as an
alternate. The template ships as hashed trees too: its own files
(`_build`, `deps`, `node_modules`) cost nothing to keep, and the
overlay's records become *the current root over the template's*.

## Churn: `_build`, `deps`, `node_modules`

Content addressing absorbs most of it: an unchanged `node_modules` costs
nothing per checkpoint, and Mix rewrites only the `.beam` files of what it
recompiled. What is left is retention and keeping a restore consistent:

1. **Derived directories age out sooner.** Sources keep every checkpoint;
   `_build`, `deps` and `node_modules` keep recent ones and a thinning
   series of older ones. Blobs no kept checkpoint reaches are collected,
   within a quota from `navigator.storage.estimate()`.
2. **Derived trees are keyed by their inputs**, as Nix and Bazel do:
   `deps` and `node_modules` by the hash of `mix.lock` and
   `package-lock.json`, `_build` by the lock's and the sources'. A
   restore takes any derived tree whose inputs match, even when its own
   checkpoint's was collected: instant in the common case, where the lock
   did not change.
3. **mtimes.** Mix compares them. Sources restored with their old mtimes
   beside a newer `_build` would not recompile, so either `_build`
   comes back with them (consistent), or the sources get the time of the
   restore and recompile. Never half of each.

## Restoring

A restore is a diff of the current tree against the chosen one, applied
in place: unchanged files keep their inodes, and the changes reach the
watchers as edits do (inotifywait, Phoenix's live reload, the code
reloader). So by default a running server picks it up; *restart* is the
other choice. The BEAM's memory is not part of a moment.

## PGlite

PGlite keeps its data directory in memory and writes it to IndexedDB
(`idb://playground-pg-ID`). Two steps:

1. **`dumpDataDir()` at a checkpoint**, its files in the same blob
   store. Postgres keeps a file per table and index, so unchanged tables
   are shared between checkpoints; split into 8 KB pages (Postgres's), a
   migration costs only the pages it touched. A restore loads the
   chosen directory (`loadDataDir`) and restarts PGlite.
2. **PGlite over `files.js`**: a filesystem of our own for its data
   directory (say `/var/pg`, outside `/work`), so one snapshot takes the
   files and the database together, atomically.

Either way, only while PGlite is idle between queries, after a
`CHECKPOINT`. Relying on recovery from the WAL instead (a copy at any
moment is a crashed server's) wants checking against PGlite's settings
first.

## What else it makes cheap

- **A fast `git status`:** `files.js` knows what changed; git.wasm can
  ask it through `core.fsmonitor`, and the tree's marks come from the
  same place.
- **Forks in O(1):** a project, or a checkpoint, forked is a new root
  over the same blobs.
- **Worktrees for agents:** each its own copy-on-write tree, and perhaps
  its own database.
- **Shares** as the checkpoints over the template rather than whole
  files ([projects.md](projects.md#sharing)).
- **Bisecting** over checkpoints: when did the page break, without
  commits.

## Order

1. The blob store and cached hashes in `files.js`; the template's trees
   hashed by the build.
2. Checkpoints and a timeline for files (sources, and derived trees by
   their inputs).
3. PGlite through `dumpDataDir`, deduplicated by file.
4. git on the same store (git.wasm, [git.md](git.md#gitwasm-git-itself)).

**To measure first:** SHA-1 in the files worker over a Phoenix project's
first full hash (git.wasm's `add` of its 3.8k files took 3.3 s, lazy
files fetched included); and how large and slow a fresh PGlite's
`dumpDataDir()` is.
