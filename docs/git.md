---
kind: design
status: plan
last_updated: 2026-10-19
---

# git, review, and accounts

A plan for git in a project (clone, history, a diff view, push) and for
signing in, and what each needs from the site's origins to stay safe.
Built so far: `git clone` and `git pull` in the shell ([below](#built)).
Mix's git dependencies are [architecture.md](architecture.md#git)'s.

## git in the shell

The shell's `git` is the page program Mix already uses
(`src/project/lib/programs/git.ts`, isomorphic-git over the node's files),
fetching through the site's proxy at `/git/HOST/OWNER/REPO/` (GitHub,
GitLab, Codeberg; `git-upload-pack` only). A curated subset, not all of
git:

1. **Now:** `clone` and `pull` (fast-forward only).
2. **Next:** `status`, `log`, `add`, `commit`, `branch`, `checkout` of a
   branch, `diff` (isomorphic-git has no diff: a diff library over its
   `walk`).
3. **Later:** `pull` with merges, `push` ([below](#push)), and the
   tree's marks for changed files (`statusMatrix`).

### A baseline commit

Each project starts as a repository, so a diff always has a base:

- **Empty project:** `git init` with no commit; the first diff is against
  the empty tree. `git clone URL .` takes over a `.git` with no commits.
- **Phoenix project:** a first commit holding the template. The build can
  ship its objects with the template, so nothing is hashed when a project
  starts.

This is also what a share could become: the commits over the baseline
instead of whole changed files ([projects.md](projects.md#sharing)).

## A diff view for review

`@pierre/diffs` (by the makers of `@pierre/trees`, which the tree uses;
also ~/ts/tc's): the changes since the baseline (*all changes*), or since
HEAD (*uncommitted*), which are the same until the first commit. A file's
diff opens from the view and from the tree's marks.

## Push

Not over git's protocol: opening `git-receive-pack` on the proxy would pass
every token through the site's server in the clear (Caddy ends TLS), which
the relay's rule rules out: the server stays blind.

**GitHub's REST API from the page.** `api.github.com` sends CORS headers:
blobs for the new objects (isomorphic-git knows them), a tree over the
parent's, a commit, then the branch's ref. One request per blob, within
5000 an hour: enough for a playground's pushes. GitLab and Codeberg have
APIs of the same shape, later.

**A token**, in order:

1. A pasted fine-grained personal access token (the chosen repositories,
   contents read and write). No server.
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
  the account's origin ([below](#confirmations)).
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

## Built

- **`git clone URL [DIR]`** (`--depth N`, `--branch NAME`, `-b`): into
  `DIR`, or the repository's name, which must be missing or empty (`.`
  clones into the shell's directory). The whole history, as git clones;
  `--depth` (one branch, as in git) is for a large repository. An SSH address (`git@HOST:OWNER/REPO`)
  is fetched over HTTPS; a host the proxy does not serve is refused by name.
  Progress as git prints it.
- **`git pull`**: fetches the current branch's upstream (origin, the same
  name) and fast-forwards; a branch that has diverged is refused, a
  detached HEAD too.
- **The shell runs the page's programs** (`git`, `tailwind`, `esbuild`,
  `sh`, `rebar3`) as it runs a node's commands; Ctrl+C stops one.
