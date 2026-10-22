---
kind: design
status: plan
last_updated: 2026-10-22
---

# git, review, and accounts

A plan for git in a project (clone, history, a diff view, push) and for
signing in, and what each needs from the site's origins to stay safe.
Built so far: git itself built to WebAssembly, the only git: the
shell's and a node's (Mix's), the processes it runs and fetching over
HTTPS included ([below](#gitwasm-git-itself)); a public repository opened
as a new project ([below](#opening-a-repository)); pushing to GitHub from
the Changes panel with a pasted token ([below](#push)). A project's history beyond git (every
change, the database too) is [history.md](history.md)'s.
Mix's git dependencies are [architecture.md](architecture.md#git)'s.

## git in the shell

One engine, **git.wasm** ([below](#gitwasm-git-itself)): git 2.56 itself,
for every subcommand at the shell and for what a node runs (Mix's git
dependencies: `portProgram`, a process of the worker's table). Agents
(Claude Code in the playground) and people expect git's own output,
`--porcelain` and all, and its whole porcelain (stash, rebase, apply,
blame, …), which a reimplementation would chase forever. isomorphic-git
(the page's git until 2026-10-22) is gone.

### A baseline commit

Each project with files starts as a repository, so a diff always has a
base: on its first start (and on the first start of a project from
before there was git), the IDE runs `git init -b main`, `git add -A`
and commits the files as they came, **Baseline**, by "Playground"; the
ref `refs/playground/baseline` keeps it for "All changes".

- **Phoenix project:** the template's files, before a link's changes go
  over them (the app's own `.gitignore` leaves out `deps/` and
  `_build/`). Hashing them on the page is quick (some dozens of files),
  so the build ships no objects.
- **A folder opened as a project:** its files, once they are there (a
  link's changes over the empty template).
- **Empty project:** no repository. `git clone URL .` takes an empty
  directory only, so `git init` (or the changes view's *Initialize*) is
  the user's.
- **A repository opened as a project** ([below](#opening-a-repository)):
  its clone's HEAD.

This is also what a share could become: the commits over the baseline
instead of whole changed files ([projects.md](projects.md#sharing)).

### The IDE's git

The page's own commands (the baseline, the changes view) run in a worker
of their own (`runtime/git.ts`, started by the exec frame on the first
`git` call): git.wasm over the project's files (files.js), with no node,
no shell and no BEAM, one command at a time, its output whole
(`playground.git(args, {cwd, env, stdin})`). One at a time, the IDE's
commands never race each other for `index.lock`.

## A diff view for review

`@pierre/diffs` (by the makers of `@pierre/trees`, which the tree uses):
the changes since the baseline (*All changes*), or since HEAD
(*Uncommitted*), which are the same until the first commit
([ide.md](ide.md) has the panel and the tab). `project/lib/changes.ts`
makes them with the IDE's git:

- **A snapshot** of the files as they are: `git add -A` and `git
  write-tree` with an index of the IDE's own (`GIT_INDEX_FILE` =
  `.git/playground-index`), which starts from HEAD's entries (`read-tree
  --reset`) whenever HEAD moves: git.wasm has no executable bit
  (`core.filemode` is false), so an entry takes its mode from the one it
  replaces, and a committed script stays 100755. The user's `.git/index` stays theirs, an
  untracked file is a new file, and what `.gitignore` leaves out is
  not there; the index's stat cache hashes only what changed since.
- **One diff**, base to snapshot: `git diff --raw --numstat --patch -z
  --full-index --find-renames`; the raw records give each file's change
  (renames as such), numstat its counts (`-`: binary).
- **Both files whole** (`git cat-file --batch`, by byte size) under each
  file's hunks (`processFile`), so the view expands a hunk to the rest of
  the file. Binary files, pure renames, mode changes and files past
  1 MiB show no lines.
- **Kept by what they compare** (both sides' object ids, modes and
  paths): a file unchanged since the last time is the same object, which
  the view does not render again.

`project/lib/review.ts` makes them again 300 ms after the files change
(files.js's `changed`, which includes `.git`'s: a commit or checkout at
the shell), but not for builds and dependencies or for the snapshot's own
writes (the IDE's index, `.git/objects`), one refresh at a time.

## Opening a repository

`/github/OWNER/REPO[/tree/REF]` (and `/gitlab/…`, `/codeberg/…`: the
hosts the proxy serves) is a page of its own (`RepositoryPage`): the
repository, its description from the host's API (CORS, no token), and
*Open as a new project*. The home page takes an address too
(`RepositoryImport`): a repository's URL, a `/tree/REF` of it, git's SSH
form, or `OWNER/REPO` for GitHub's (`shared/lib/repository.ts`), and goes
to that page. Opening the link alone makes nothing (a crawler, a
preview), and the page says the code will run here.

The project is an empty one whose seed is the repository instead of a
link's files (`cloneProject`, `Seed.clone`). Its first start runs `git
clone -q --depth 1 [--branch REF] URL .` in `/work` with the IDE's git
(which has the shell's HTTPS helper for it, through the proxy), and
the clone's HEAD becomes the baseline. Shallow: a look at a project wants
the files, not its history (`git fetch --unshallow`). `--depth` implies
`--single-branch`, so the remote is then set to track every branch
(`remote.origin.fetch`), as a full clone's does: `git fetch origin
BRANCH` makes `origin/BRANCH`, and `git switch BRANCH` finds it. A failed clone
keeps the seed and says why; the next start tries again. Public
repositories only, as for the shell. The project's origin is
`repository`, so it asks before it takes the user's settings, as a
link's does.

## Push

Built (2026-10-22) as below, with a pasted token; the GitHub App is
later. Not over git's protocol: opening `git-receive-pack` on the proxy would pass
every token through the site's server in the clear (Caddy ends TLS), which
the relay's rule rules out: the server stays blind.

**GitHub's REST API from the page.** `api.github.com` sends CORS headers:
blobs for the new objects (git.wasm knows them), a tree over the
parent's, a commit, then the branch's ref. One request per blob, within
5000 an hour: enough for a playground's pushes. GitLab and Codeberg have
APIs of the same shape, later.

**How** (`project/lib/push.ts`): the branch's remote (its
`branch.NAME.remote`, else `origin`) must name a GitHub repository; its
branch there (`branch.NAME.merge`, else the same name) must be an
ancestor of HEAD (fetched first if this repository lacks it; else *pull
first*). Each commit GitHub lacks, oldest first: the blobs its diff from
its first parent adds (`diff-tree -r`; all of a root commit's files), a
tree over the parent's (`base_tree`) whose id must be the commit's own,
then the commit with the same message, parents, author and committer, the
dates in their own time zones. So GitHub's commits are this repository's
(the same ids), and the branch moves fast-forward only. Should GitHub
write one otherwise (a date in UTC, say), its commit is written here too
from the API's answer (`git hash-object`, its id checked) and the branch
moves to it: same files, so nothing else changes, and no fetch is needed
(a private repository's could not be). An empty repository takes nothing
until it has a commit: a placeholder file starts it, and the first push
moves its branch past it (forced, once). A new branch is made; the
branch's upstream is set, so `git status` says how far it is. Shallow
history cannot be pushed to where its parents are missing (*git fetch
--unshallow*).

The Changes panel's *Push* (`PushDialog`) says where it goes (branch,
`OWNER/REPO`, commits to push), commits what changed first with a
message (git's identity if it has one, else the token's user and their
`users.noreply.github.com` address), and warns when the project pushed
to another repository before (`Project.pushedTo`: its remote is the
project's code's to change). Tests: `test/unit/push.test.ts` and
`test/e2e/github.spec.ts`, against a stand-in for the API over a bare
repository (`test/fake-github.ts`).

**A token**, in order:

1. A pasted fine-grained personal access token (the chosen repositories,
   contents read and write). No server. Built: Settings' *GitHub*
   (`shared/lib/github.ts`), checked with `GET /user`, kept in the
   apex's IndexedDB under its own key, never with the environment.
2. A GitHub App's user tokens: the user picks the repositories, a token
   lasts 8 hours and refreshes. The web flow's code exchange needs the
   app's secret, so the backend makes it and keeps nothing; the device
   flow needs no secret but its endpoints send no CORS headers either.
   Not an OAuth App (its `repo` scope is every repository). Not the
   admins' sign-in (`backend/lib/playground/github_oauth.ex`).

**Where it is kept** matters more than how it is got:

- **Never in the node's files** (`.git/config`, anything below `/work`):
  the project's code (a dependency, `File.read!`) would read it. Only the
  page program holds it, and only for its own requests.
- **Page programs are the node's to run:** `System.cmd("git", ["push"])`
  runs the page's `git`. A program that uses a credential asks first, on
  the account's origin ([below](#confirmations)). So far no program
  does: the shell's `git push` is refused (pointing to the panel), and
  only the IDE's own dialog, on the apex, uses the token. The IDE's git
  that reads the commits runs in the exec frame, with the project's code,
  and never sees the token; what it reports could be the project's
  making, as its files are, so the dialog names the repository.
- **Live sessions:** a guest who may edit types into the host's terminals;
  a push from a session asks the host on the host's own page, or is off.

## Accounts

Later: signing in with GitHub to keep projects on the server (opened from
any browser, shared by a lasting link, updated in place) instead of in a
link's fragment ([collaboration.md](collaboration.md#later-stored-shares-and-accounts)).
The account is what stops the site from being free anonymous storage:
quotas, size limits, rate limits, and someone to ban.

### What a project's code can reach

Opening a project runs its author's code: Elixir in the node, and the app's
JavaScript in the preview.

- **The node** runs in a worker: no DOM, no frames. It reaches out only by
  `fetch` with `credentials: 'omit'` (`https.ts`, `fetcher.ts`), by the
  page programs it may spawn, and, in a project the user lets use their
  tailnet, by connections, datagrams and names through the apex's
  Tailscale device ([tailscale.md](tailscale.md)), never its keys, which
  stay on the apex.
- **The preview** iframe is on the IDE's origin, without `sandbox`: its
  JavaScript reaches `window.parent` (the IDE, its terminals, its
  programs), the project's IndexedDB, and the apex's `registry.html`,
  which takes it for the project. Today that only lets a project harm
  itself: each project has an origin, and the frame allows only its own
  entry.
- **Safari's one-origin fallback** ([projects.md](projects.md#a-project-domain))
  runs every project on the apex: there a project's preview reaches every
  other project, and whatever the apex keeps.
- **The apex and `p-ID` are one site:** `SameSite` cookies do not keep a
  project's requests out, and a project page can set cookies for
  `.DOMAIN` that shadow the apex's.

The rule: **no project's code runs on the origin that holds the account,
and project pages hold capabilities, not credentials.**

### A preview origin per project (built, per port)

Built as an origin per port of the app (2026-10-18): `v-ID-PORT.DOMAIN`,
with a hidden relay frame of that origin in the IDE that passes its
service worker's requests to the IDE's bridge ([runtime.md](runtime.md),
*On a project domain, a preview origin per port*). The app's code then
runs on `v-ID-PORT`, and only the site's on `p-ID`, so a frame that trusts
`p-ID` for project ID means it.

- **Not `sandbox`.** Without `allow-same-origin` an origin is opaque: no
  service worker controls it, and `document.cookie` and `localStorage`
  throw (Phoenix's session, LiveView).
- **Cookies:** those the app's JavaScript reads are the port origin's
  (the relay frame keeps them); HttpOnly ones stay in the bridge, one jar
  per project.
- **Left open:** the preview may still `postMessage` its parent, so the
  IDE checks `event.source` and, for a relay, `event.origin`. Whether
  Safari runs a service worker in a cross-origin frame wants checking by
  hand (its one-origin fallback keeps the same-origin preview). A site
  without a project domain keeps the same-origin preview.

### The account's origin

- **A registrable domain of its own** (as `github.com` is to
  `githubusercontent.com`): sign-in, the API and stored projects. No
  project's code ever runs there.
- **Its session:** a `__Host-` cookie, host-only, `HttpOnly`,
  `SameSite=Lax`; the API checks `Origin` and answers no credentialed
  CORS to project origins.
- **Capabilities:** a project page talks to a frame of the account's
  origin (as to `registry.html` now), which grants by `event.origin` only
  *read project ID* and *save project ID*. The worst a hostile project
  does is overwrite its own stored copy.

### Confirmations

Publishing, making a share public, linking a GitHub repository to a
project, and pushing are confirmed in a window of the account's origin
(*Publish brave-otter, 12 files?*): code on a project page cannot click
another origin's window. That also covers Safari's fallback, where
`event.origin` does not tell projects apart: there each write asks, or a
project is not synced. A project linked to a repository once may push to
that one only, its token staying on the account's origin.

Opening someone's stored project makes a new local project, on an origin
of its own, as a link does now.

### Encrypted or not

Stored shares encrypted in the browser (the key in the fragment) keep the
server blind, but nothing in them can be moderated, only deleted by
account. Unlisted shares stay encrypted; public, lasting ones are probably
better kept readable.

### Not the public suffix list

With `DOMAIN` on the list, the apex, each `p-ID` and each `v-ID` would be
sites of their own: `SameSite` would separate them, nobody could set
cookies for `.DOMAIN`, and each project would get a process of its own.
But:

- **`registry.html` and `storage.html` become cross-site frames** and
  Chromium and Firefox partition them, as Safari does now: every browser
  would take the one-origin fallback, or the project list would have to
  be redesigned (kept by the apex at creation, changes handed over at the
  top level or through the server).
- **The preview's cookies become third-party:** Safari ignores
  `document.cookie` in a `v-ID` frame under `p-ID`.
- **Slow both ways:** a reviewed request, then browser releases; old
  browsers never get it.

A separate account domain and a same-site preview origin give the same
protection without that. Worth asking again once the server holds the
project list.

## git.wasm: git itself

`tools/git/build.py` builds git 2.56.0 (with `tools/git/patches/`) and zlib with
wasi-sdk 33 in Docker (`nif/build.py`'s image) for `wasm32-wasip1`:
`target/git/git.wasm`, 3.8 MB (1.5 MB gzipped, `-Oz`). The site serves it
beside `rg.wasm`; the shell runs it as a process of the worker's
([runtime.md](runtime.md#processes-processests)), over the node's tree
and the shared files.

**The build:** git's own, with a `config.mak` that turns off what WASI
lacks (threads, curl, iconv, gettext, Rust, sockets, mmap and regex,
which git has fallbacks for), and `tools/wasi-compat/` (every C tool's,
[tools.md](tools.md#building-them)): headers WASI does not have
(`pwd.h`, `sys/wait.h`, `termios.h`, …) and `stubs.c`, which answers as
one user would (uid 0 owns everything, `chmod` does nothing, `PWD` is
the working directory). git's Makefile reads `uname` before
`config.mak`, so the build names WASI on make's command line.

### Processes

git starts every process in `run-command.c`'s `start_command`. Under
`__wasi__` it spawns instead of forking, as its Windows build does
(`patches/0001-wasi-spawn.patch`): `wasi_spawn` (`stubs.c`) hands the
host the program, arguments, environment, directory and three of git's
descriptors, and `pipe`, `dup`, `dup2`, `waitpid` and `kill` are the
host's too (the `processes` imports). A child that is git is another
instance of git.wasm, its own memory and so fresh globals; it runs at
once with its parent, and either waits, suspended, on a pipe or the
other.

**`start_async`** (`patches/0002-wasi-async.patch`) runs a function of
git's beside git (fetch-pack's and send-pack's sideband demultiplexer, a
filter's feeder): under `__wasi__`, `wasi_async_start` (`stubs.c`) gives
the host the `struct async` and a C stack of its own (512 KiB), and the
host runs the exported `wasi_run_async` as a second coroutine of the same
instance (`WebAssembly.promising`, from once git waits). Both share git's
memory and descriptors, as a thread would; at each wait
(`WASI.suspended`) a coroutine keeps its `__stack_pointer` (exported by
the link) and the host's note of which runs (`in_async`), and puts them
back when it resumes. The coroutine is a process of git's in the table
(`Processes.task`), so `finish_async` waits for its pid; a `die` in it
ends it alone (`die_async`).

**`sh`** is brush, as a process with the streams it was given
(`shProgram` in `worker/index.ts`): `sh -c LINE` (the file transport's
`git-upload-pack '…'`, an alias's `!`), and a script whose `#!` names sh
or bash (a hook). git has no templates (`/usr/share/git-core/templates`
is empty), so no sample hooks.

**The transport** is a remote helper (`runtime/git-remote.ts`), a
process of the worker's that git starts as `git remote-https REMOTE URL`:
protocol v2's `stateless-connect`, which only carries pkt-lines between
git and smart HTTP through the site's proxy (`/git/HOST/OWNER/REPO`, the
page's git's): the capability advertisement from a GET of `info/refs`
(its `# service=` packet dropped), then each request git writes (to a
flush packet) a POST to `git-upload-pack`, its answer passed on as it
comes and a response-end packet (`0002`) after. SSH addresses
(`git@HOST:OWNER/REPO`, `ssh://git@HOST/…`) of the proxied hosts are
HTTPS by git's own `url.<base>.insteadOf` (`GIT_CONFIG_COUNT` in git's
environment, `GIT_CONFIG`). Another host is refused by name; push is
refused (the proxy has no `git-receive-pack`: [below](#push)).

**Works** (in Chromium, Firefox and WebKit; `git.spec.ts`, and
`processes.test.ts` in Node): init, add, commit (with `-m`, and its
maintenance after), status (`--porcelain`, `--short --branch`), diff,
log, show, blame, grep, branch, switch, rebase (not `-i`), cherry-pick,
revert, reset, tag, stash, format-patch, config; what runs other
processes: a merge with local changes (`--autostash`), `worktree add`,
`gc` (`pack-refs`, `repack`, `pack-objects` over pipes), `repack`,
`fsck`, aliases with `!`, hooks, `submodule` (a script of git's, with
sed: [tools.md](tools.md)); and over a transport: clone, fetch,
pull, ls-remote from GitHub (HTTPS and SSH addresses, `--depth`), and
clone, fetch and push over `file://` (`--no-local`: `upload-pack` and
`receive-pack` as processes). Per command: a few ms over a small repository. On a Phoenix
project with `deps` and `_build` forced in (3.8k files): `add` 3.3 s
(fetching the template's lazy files included), `status` 0.2 s, `commit`
0.5 s.

**Not yet:**

| Needs | For |
| --- | --- |
| A token, and push over GitHub's REST API ([below](#push)) | push to GitHub |
| An editor | `commit` without `-m`, `rebase -i`, `add -p`'s editing |
| Private repositories (credentials through the helper, not the proxy) | clone and fetch of those |

Also: the Phoenix template's `.git` (phx.new's `git init`) lacks `refs/`
(the template keeps no empty directories), so git.wasm does not take it
for a repository until `git init` again: the baseline commit
([above](#a-baseline-commit)) fixes it. `count-objects` sizes are 0 (no
`st_blocks`). git 3.0 makes Rust required: its parts build for
`wasm32-wasip1` too.

### Next

**Push** stays the REST API ([below](#push)), as the proxy must not see
tokens: the helper with the `push` capability, turning git's pack into
the API's blobs, trees and commits.

**The editor** is the IDE's: `GIT_EDITOR` names a page program that
opens the file in a tab and exits when it is closed. No pager: xterm
scrolls back (`GIT_PAGER=cat`, which git takes for none).

### Tests

- **vitest over a built git.wasm** (`test/unit/processes.test.ts`,
  skipped without `target/git/git.wasm`): git over the shim and the
  process table in Node, in milliseconds: our own cases (processes,
  `start_async`, `file://`, the HTTPS helper against git's own
  `upload-pack --stateless-rpc`).
- **git's own suite** (`test/git/`, `npm run test:git`; `GIT_T` names the
  scripts, `t*` for all, `GIT_T_SHARD=I/N` splits them among runs,
  `GIT_T_LIMIT` ends a script that hangs): `t/`'s scripts over
  `test-lib.sh`, in Node, with brush as sh, git.wasm as git (and its
  dashed programs and scripts), `test-tool.wasm` (`tools/git/build.py` builds
  it, `GIT-BUILD-OPTIONS` and `templates/blt` too), coreutils.wasm and
  GNU's sed, grep, diffutils and awk ([tools.md](tools.md)), each a process of the table as the playground runs them.
  The files are the host's at their own paths (`hostfs.ts`: the shared
  files' protocol over `node:fs`). What the playground lacks yet runs as
  the host's own program: `perl`, `getconf`, `gpg`, `ssh-keygen`, …
  (`Machine.hosted` counts them). Each script's TAP goes to
  `target/git/src/t/results/`, a summary to `target/git/t-results.json`.
  All of `t/` (1059 scripts) in 6 shards takes about 7 minutes.
- **Playwright** for what is the browser's (JSPI in three engines, the
  files across workers, the proxy): `git.spec.ts`.

**Where it stands** (2026-10-22, with GNU's sed, grep, diffutils, awk and find, and the shell's chmod): 30,268 tests pass, 749 fail (97.6%),
257 known breakages as git's own; 748 scripts pass whole, 164 skip
themselves (their prerequisites: HTTP servers, iconv, gettext, …), 9
error before a test (gettext, `git://`), 3 time out (completion,
`refs migrate`, an archive's corner cases). Most failures by script:
`t5601-clone` (54, no ssh or `git://`), `t7610-mergetool` (28),
`t5318-commit-graph` (27), the notes' (`t3321`, `t3301`), `t1050-large`,
reftable's. Known causes: no file modes (`POSIXPERM` passes in
`test-lib.sh`, `test -x` is always true), no signals but the table's,
uid 0 (`SANITY`'s tests skip). What the suite found and fixed: git's
script commands (`git-submodule`, …, `tools/git/build.py` SCRIPTS, at
`/usr/libexec/git-core` on the site); a directory's `st_mode` without
permission bits (git took it for a sparse index's: `stubs.c` adds them);
brush's `exec`, `trap`, `kill` and `.` on WASI, `set -x`'s assignment
status, and a pipeline's compound commands ([runtime.md](runtime.md#the-shell-workerbrushts));
`env`, `xargs`, a script on PATH, `$0` of `sh -c`.

## Built

- **git.wasm at the shell** for every subcommand ([above](#gitwasm-git-itself)):
  `git clone URL [DIR]`, `fetch`, `pull` (merges and rebases as git's do),
  `ls-remote` from GitHub, GitLab and Codeberg through the proxy, SSH
  addresses as HTTPS; a host the proxy does not serve is refused by name,
  and push is refused (pointing to the Changes panel's).
- **A public repository as a new project** (`/github/OWNER/REPO`, the
  home page's field): a shallow clone at its first start
  ([above](#opening-a-repository)).
- **Push to GitHub** from the Changes panel with a fine-grained token
  from Settings: the same commits, made through the REST API
  ([above](#push)). Progress as git prints it, as it is git's.
- **A baseline commit** for each project with files, and **the IDE's
  git** (a worker of its own) to run git for the page
  ([above](#the-ides-git)).
- **A node's git** is git.wasm too: Mix's git dependencies (`fetch
  --depth`, sparse checkout, the lock's check).
- **The shell runs the page's programs** (`tailwind`, `esbuild`, `node`,
  `rebar3`) as processes that stream ([runtime.md](runtime.md#processes-processests));
  Ctrl+C stops one.
