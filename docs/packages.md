---
kind: design
status: proposal
last_updated: 2026-10-27
---

# Distributing the playground as npm packages

This document proposes publishing the playground as a set of npm packages
under `@elixir-playground/`. An embedder installs the OTP and Elixir it
wants plus the tools it needs, and npm's version ranges choose the newest
builds that fit together:

```sh
npm install @elixir-playground/api @elixir-playground/otp-29.1.2 \
  @elixir-playground/elixir-1.20.4 @elixir-playground/shell \
  @elixir-playground/git @elixir-playground/claude
```

Tidewave's `/web`, which uses `embed.js` today ([embed.md](embed.md)), is
the first embedder this is for. run-elixir.dev becomes the first consumer
of the packages.

Most of this document is a proposal. [What is implemented](#what-is-implemented)
lists what exists in the repository today: the site manifest, the
load-time check, `target/packages/`, and the numbered service worker
protocol. Nothing is published.

## Packages

Each package's `package.json` has a `playground` field ([below](#the-playground-field)).
Every package except `runtime` peer-depends on `@elixir-playground/runtime`.

| Package | Contents | Peer dependencies |
| --- | --- | --- |
| `runtime` | Node, files, git and Node.js workers; `sw.js`; the program registry; Node.js and npm; the RPC protocol; the frames' pages (`exec.html`, `relay.html`, `claude.html`) | none |
| `api` | `create()`, `fs`, `spawn`, `connect`, `serve`. Runs in the embedder's page. | `runtime` |
| `otp-X` | `beam.mjs`, `beam.emu.mjs`, `beam.wasm` (Emscripten build and glue); OTP's applications as fs bundles. Declares `beamAbi`. | `runtime` |
| `elixir-X` | Elixir's applications, Hex, rebar3 and phx_new as fs bundles. | `runtime` |
| `phoenix-template` | The phx.new app with `deps/` and its `_build`, compiled for one OTP and Elixir pair. | `runtime`, `otp-X ^N`, `elixir-Y ^N` |
| `shell` | `brush.wasm` (the shell) and `coreutils.wasm` (78 tools). The terminfo entry. | `runtime` |
| `git` | `git.wasm`; its shell-script commands (`usr/libexec/git-core/`). | `runtime` |
| `ripgrep` | `rg.wasm`. | `runtime` |
| `gnu-tools` | GNU `sed`, `grep`, `diff`, `cmp`, `diff3`, `sdiff`, `gawk`, `find`. | `runtime` |
| `tls` | `tls.wasm` (a Node.js process's TLS client) and `roots.pem`. The nodes' CA bundle. | `runtime` |
| `tailscale` | `tailscale.wasm` (the apex's Tailscale node). | `runtime` |
| `claude` | The preparer (Bun graph → CommonJS) and the Claude Code range it was tested with. No Claude Code. | `runtime` |
| `vite` | A build plugin, and a CLI for sites that don't use Vite. | `runtime` |

`tailscale` is not in the first list of packages the embedders asked for.
It is a package of its own because it is 29 MB, and only the apex's
Tailscale worker uses it.

### What maps onto today's artifacts

`runtime/build.py` writes `target/packages/NAME/` for the packages whose
files are already separate in the site (2026-10-27 build):

| Package | Files | Size |
| --- | --- | --- |
| `runtime` | `worker.js`, `files.js`, `git.js`, `nodejs.js`, `tailscale.js`, `chunks/`, `sw.js` | 0.8 MB |
| `api` | `embed.js` | 16 KB |
| `otp-29.1.2` | `beam.mjs`, `beam.emu.mjs`, `beam.wasm` | 6.6 MB |
| `shell` | `brush.wasm`, `coreutils.wasm` | 11 MB |
| `git` | `git.wasm` | 3.7 MB |
| `ripgrep` | `rg.wasm` | 2.9 MB |
| `gnu-tools` | 8 modules | 5.3 MB |
| `tls` | `tls.wasm`, `roots.pem` | 0.9 MB |
| `tailscale` | `tailscale.wasm` | 28 MB |

These packages do not map cleanly yet:

- **`elixir-X` and `phoenix-template`** have no files of their own. Their
  files are in the site's one fs image (below). They appear in the site
  manifest with their `playground` fields only.
- **`otp-X`** has its emulator but not OTP's applications, which are in the
  fs image.
- **`git`, `tls` and `shell`** each have files in the fs image too: git's
  13 shell-script commands, the nodes' CA bundle, and the terminfo entry.
- **`runtime`** lacks the frames' pages. `exec.html`, `relay.html` and
  `claude.html` are entries of the app's Vite build. Their scripts are
  chunks in `_playground/`, shared with the IDE.
- **`api`** is only the client (`embed.js`). The host it drives is
  `embed.html`, which is part of the app.
- **`claude`**: the preparer is part of the app's build
  (`project/lib/programs/claude/`), so the package has no files.
- **`tailscale`**: its glue, Go's `wasm_exec.js`, is bundled into the
  runtime's `tailscale.js`. That glue must match the Go version that built
  `tailscale.wasm`, so it belongs in the `tailscale` package.

### The fs image

Today one fs image holds the files of six packages (2026-10-27 build,
6,090 files):

| Package | Files |
| --- | --- |
| `phoenix-template` | 4,640 |
| `otp-29.1.2` | 831 |
| `elixir-1.20.4` | 604 |
| `git` | 13 |
| `shell` | 1 |
| `tls` | 1 |

The image is `fs/boot.tar.gz` (7.2 MB), `fs/boot-phoenix.tar.gz`
(10.1 MB), `fs/manifest.json`, and 688 bundles of the 5,885 files not in
`boot.tar.gz` (41 MB gzipped). [build.md](build.md#what-the-site-is)
describes how it is made.

Splitting it per package needs fs format 2:

- **Bundle numbers are global.** A manifest entry is `[path, size, mtime,
  bundle]`, and `bundle` is an index into one `fs/bundles/`. Format 2 needs
  one manifest and set of bundles per package, mounted together, or
  package-qualified bundle references.
- **The boot images mix every package's files.** They are recordings of
  what IEx and the Phoenix server read first. That is a property of the
  installed set, not of one package. They are combination outputs (below).
- **The template's build is made by a recording.** Mix records absolute
  paths, so `build.py` compiles the template again at `/work/playground`
  inside the node, under the Node harness. The template package can only
  be built by running the `runtime`, `otp-X` and `elixir-Y` it is for.
- **One version for all of it.** A project's kept changes note `fs/version`.
  When it changes, `files.js` drops the template's `_build`, and the
  project recompiles over the new one. Per package, the template package's
  version would decide that, not a digest of everything.

## Versioning

- **The upstream version is in the package name.** The package's own
  semver is our build of it: `@elixir-playground/otp-29.1.2@3.1.4`,
  `@elixir-playground/elixir-1.20.4@3.0.2`.
- **Major:** an ABI break. **Minor:** a new capability. **Patch:** a
  rebuild or a fix.
- **An embedder pins OTP and Elixir and lets the build float.** Prereleases
  such as `29.1.2-3` don't work for this. They sort before `29.1.2`, and
  ranges don't match them unless they name the prerelease.
- **`runtime`'s major is the host ABI.** Every artifact peer-depends on it
  with the minimum minor it needs: git `"@elixir-playground/runtime": "^3.2"`.
- **The template peer-depends on its own OTP and Elixir packages** (`^N`
  of each). Because the upstream version is in the name, npm installs it
  only next to that exact pair.
- **Elixir does not peer-depend on OTP.** Elixir 1.20.4 runs on any OTP 29,
  but `otp-29.1.2` and `otp-29.1.3` are different packages, and a peer
  dependency names one. `elixir-X` says `"requires": { "otp": "^29.0.0" }`
  in its `playground` field instead, and only the load-time check enforces
  it.

The repository's packages are all `1.0.0` today (`PACKAGES` in
`build.py`; `app/src/runtime/packages/host.json` for the runtime). A
publishing job would compare each package's file digests (site.json's
`sha256`) with the published version's, and bump the patch when they
differ.

## The `playground` field

Every key is optional. A package sets the keys that describe it.

| Key | In | Meaning |
| --- | --- | --- |
| `abi` | artifacts | `{ seam: version }`: the host ABI seams its files use ([below](#abi-seams)). |
| `programs` | `shell`, `git`, `ripgrep`, `gnu-tools` | `{ name: file }`: programs the shell and nodes find by name. The program runs with `name` as `argv[0]`. Several names may share a multi-call module. |
| `shell`, `tools` | `shell` | The shell's module (`brush.wasm`) and the tools' multi-call module (`coreutils.wasm`), which the exec frame compiles once for every node. |
| `otp`, `beamAbi`, `beam` | `otp-X` | OTP's version, the build's id, and `{ loader, threads, wasm }`. |
| `elixir`, `requires.otp` | `elixir-X` | Elixir's version, and the OTP range it runs on. |
| `template` | `phoenix-template` | `{ kind, id, label, otp, elixir }`: the id is a digest of its files without its build. `otp` and `elixir` are the pair it was compiled with. |
| `tls` | `tls` | `{ module, roots }`. |
| `tailscale` | `tailscale` | Its module. |
| `claudeCode` | `claude` | The tested Claude Code range ([below](#claude-code)). |
| `apiVersions` | `api` | The embedding API versions its client speaks. |
| `provides` | `runtime` | `{ seam: [versions] }`: what the runtime speaks. |

For example (from today's build):

```json
"playground": {
  "abi": { "wasi": 1, "processes": 1 },
  "programs": { "git": "git.wasm" }
}
```

```json
"playground": {
  "abi": { "beam": 1 },
  "otp": "29.1.2",
  "beamAbi": "a51ebfdb010b7d3e",
  "beam": { "loader": "beam.mjs", "threads": "beam.emu.mjs", "wasm": "beam.wasm" }
}
```

### The site manifest (`site.json`)

The runtime does not read `node_modules`. It reads a site manifest that
the build step writes for the installed set:

```json
{
  "manifest": 1,
  "packages": {
    "@elixir-playground/git": {
      "version": "1.0.0",
      "base": "./",
      "files": { "git.wasm": { "size": 3849103, "sha256": "…" } },
      "peerDependencies": { "@elixir-playground/runtime": "^1.0.0" },
      "playground": { "abi": { "wasi": 1, "processes": 1 }, "programs": { "git": "git.wasm" } }
    }
  },
  "fs": {
    "base": "fs/", "format": 1, "version": "fedf4ac562a937a6",
    "boots": ["boot", "boot-phoenix"],
    "packages": { "@elixir-playground/otp-29.1.2": "1.0.0" }
  },
  "nif": { "base": "nif/", "beamAbi": "a51ebfdb010b7d3e", "libraries": ["bcrypt_elixir-3.3.2"] }
}
```

- **`base`** is relative to `site.json`. Today every base is `./`, because
  `site.json` is in `r/RID/` beside the files. In an npm layout it is
  `../NAME@VERSION/`.
- **`fs`** is the fs image, a combination output. `fs.packages` lists the
  packages whose files it holds, at the exact versions it was made from.
- **`nif`** lists the NIF libraries the site bundles. `make` asks the
  backend for any other library without first requesting a missing file
  from the site.

The `runtime` package is not in `site.json`. The running JavaScript is
the runtime, and it knows its own version and seams (`host.json`). This
matters today because `build.py app` rebuilds the JavaScript and keeps
`r/RID/`. A JavaScript build that breaks an ABI then meets older
artifacts, and the check catches it.

## The load-time check

npm's peer dependencies choose a compatible set at install time. A
lockfile can still hold a set that does not fit, for example after
`--force` or `--legacy-peer-deps`, or with a hand-written site manifest.
So the exec frame checks the site manifest again as it starts
(`app/src/runtime/packages/check.ts`). A mismatch fails `start` with
`ERUNTIME`, as `create()`'s OTP and Elixir check does
([embed.md](embed.md#the-handshake-and-versions)). It checks:

- the manifest version is one the runtime reads (`provides.manifest`);
- each package's peer dependencies are present and in range. That
  includes `runtime`, whose version is the running JavaScript's;
- each `abi` seam is at a version the runtime `provides`;
- one OTP package and one Elixir package at most;
- Elixir's `requires.otp` against OTP's version. OTP's four-part versions
  such as `26.2.5.3` are compared on their first three parts;
- the template's `otp` and `elixir` against the installed ones;
- the fs image's format, and each of its `packages` at exactly the
  installed version;
- the bundled NIF libraries' `beamAbi` against OTP's.

`build.py` checks each module's imports when it writes the manifest. Every
import module must belong to a seam the package's `abi` names:
`wasi_snapshot_preview1` → `wasi`, `processes` → `processes`, `crossterm`
→ `crossterm`, `gojs` → `tailscale`. `beam.wasm`'s imports (`env`,
`wasi_snapshot_preview1`) are its own glue's (`beam.mjs`), so the `otp-X`
package names them as its own.

## ABI seams

These are the interfaces between packages, and what forces a new version
of each.

| Seam | Between | Today | A break | Bumps |
| --- | --- | --- | --- | --- |
| `manifest` | the build step and the runtime | 1 | `site.json`'s schema, the `playground` keys, how `programs` run (`argv[0]`, the multi-call rule) | `runtime` major (registry) |
| `fs` | the fs image and `files.js`, the node workers and the Node harness | 1 | manifest entries `[path, size, mtime, bundle]`, bundles as uncompressed USTAR, boot images as gzipped USTAR | `runtime` major; every package with fs files |
| `wasi` | a WASI module and the runtime's shim (`wasi/`) | 1 | a call the shim stops answering, a changed meaning | `runtime` major |
| `processes` | `brush.wasm`, `git.wasm`, the GNU tools, and `processes.ts` | 1 | `pipe`, `spawn` (its NUL-separated request), `wait`, `kill`, `dup`, `dup2`; git's task export (`wasi_run_async`, `__stack_pointer`) | `runtime` major, and the minor of each artifact that needs a new call |
| `crossterm` | `brush.wasm` and `worker/brush.ts` | 1 | `raw_mode`, `size`, `read` | `runtime` major, `shell` |
| `tls` | `tls.wasm`'s exports and `nodejs/tls.ts` | 1 | its 19 exports (`tls_client`, `tls_alpn`, …) | `tls` major or `runtime` major |
| `tailscale` | `tailscale.wasm` and `wasm_exec.js` plus the Tailscale worker | 1 | Go's version (the glue), the worker's calls into the node | `tailscale`; moving `wasm_exec.js` into `tailscale` leaves only the worker's calls |
| `beam` | `beam.mjs` and the runtime's `beam/run.ts`, `worker/beam.ts` | 1 | the `Module` hooks the runtime fills: `beamSpawn`, PROXYFS mounts, sockets, the tty, `nifs.js` | `otp-X` major or `runtime` major |
| `beamAbi` | an OTP build and what is made for it | an id | any change to emsdk, the patch stack, or `beam.wasm`'s imports or exports | a new id; recordings and keyed caches follow |
| NIF ABI | a NIF library and `nif.ts` plus patch 0021 | not numbered | `beamos_nif_input`/`run`/`output`, the request and answer terms, OTP's `erl_nif.h` | see below |
| template pair | `phoenix-template` and OTP plus Elixir | exact versions | another OTP or Elixir | a new template build |
| recordings | the boot images and the installed set | exact versions | any package with fs files changing | a new recording |
| embedding API | `api` (`embed.js`) and the host (`embed.html`) | apiVersion 1 | [embed.md](embed.md#the-handshake-and-versions) | apiVersion 2, with 1 still answered |

`beamAbi` is computed by `build.py`. It is a digest of OTP's tag and the
patch stack (`beam/build.sh`'s `.stamp-patched`), the output of
`emcc --version`, and `beam.wasm`'s imports and exports. The runtime
cannot range-check a digest, so the runtime-facing interface is the
numbered `beam` seam. `beamAbi` identifies a build for what is keyed by
it.

**The NIF ABI is not the BEAM's.** A NIF library is a WASI reactor in an
instance of its own ([nif.md](nif.md)). It does not link against
`beam.wasm`. It depends on the erl_nif layer's protocol (its three
exports and the request terms) and on the `erl_nif.h` of the OTP it was
compiled against. Keying NIF builds by `beamAbi`, as planned, rebuilds
every library after an emsdk or patch change that does not affect them.
A numbered `nifAbi` (the layer's protocol version plus OTP's NIF API
version) would keep them valid. This is an open question below.

## The build step (proposal)

The `vite` package's plugin (and its CLI for other sites) writes what
depends on the installed set, which npm cannot provide:

- **`site.json`** for the installed packages, with `base` pointing at
  `/npm/@elixir-playground/NAME@VERSION/`.
- **Boot recordings:** `boot*.tar.gz`, recorded with the Node harness for
  the installed set. They are optional. Without them, the node fetches
  every file lazily, and boot is slower.
- **`apex/`**, copied into the embedder's app: the `api` entry and the
  apex-side files (PGlite, the claude frame's host, the Tailscale worker).
- **`usercontent/`**, for a second site: the exec, relay and claude
  frames, `sw.js`, and the artifacts under immutable paths:
  `/npm/@elixir-playground/NAME@VERSION/…`. These paths replace `b/ID` and
  `r/RID`.
- **Header configurations** for Caddy, nginx and `_headers` (Netlify,
  Cloudflare Pages): COOP, COEP, CORP, `frame-ancestors`, and caching
  (immutable under `/npm/`, `no-cache` for `sw.js` and the pages).

NIF libraries stay a backend service (`/api/nif/`).

## Usercontent: hosted or self-hosted

An embedder needs a second registrable domain for project code
([frames.md](frames.md)). There are two ways to get one.

**Hosted (offered, optional).** The hosted usercontent domain is an
npm-backed mirror. On first request,
`https://e-ID.<hosted usercontent>/npm/@elixir-playground/runtime@3.4.1/exec.html`
is fetched from the published tarball, checked against its `integrity`,
served with the playground's headers, and cached forever. npm forbids
republishing a version, so every version in any lockfile stays available,
and the mirror is compatible by construction. `api` loads its frames,
workers and artifacts from the exact versions in the embedder's lockfile,
which the plugin bakes in.

**Self-hosted.** The embedder serves `usercontent/` from its own second
domain, with the generated headers and a wildcard certificate. The disk
layout is the same as the mirror's.

**The trust cost of hosted usercontent.** The hosted domain serves the
code that runs every project, for every embedder that uses it. Whoever
controls run-elixir.dev's usercontent servers can change what runs in
those embedders' users' sessions, within the usercontent origins: their
project files, terminals, and agent credentials passed into projects.
`embed.html` already has this property today. Integrity checks against
npm limit the mirror to published versions, but they do not remove the
operator from the path. An embedder that does not accept this
self-hosts.

## The preview origin's service worker

A Phoenix app owns `/` on its preview origin (`v-ID-PORT.USERCONTENT`).
So that origin's `sw.js` must be root-scoped, and one worker serves every
version of the host on it. It is the one shared, unversioned piece.

- It is a router. It passes a preview's requests and WebSockets to its host
  page, the versioned `relay.html`.
- Its protocol is numbered. The host announces `{ kind: 'host', key,
  protocol: N }`, and the worker answers in that protocol.
- Changes within a protocol are additive only. A new `sw.js` keeps
  speaking every protocol in its support window: at least 12 months after
  the next protocol's release.
- A real break moves to a new host level, `v-ID-PORT.r4.<usercontent>`.
  Each major needs one wildcard certificate. That level has its own
  storage: the worker's routing table, the preview's cookie jar, and the
  claude frame's cache. Projects are stored on the apex, so a move loses
  no project data.

### Protocol 1

This is what `runtime/sw.ts` and its host (`frames/relay.ts` with
`runtime/bridge.ts`) exchange as of 2026-10-27.

**Host → worker** (to `navigator.serviceWorker.controller`, or to the
active worker):

| Message | Meaning |
| --- | --- |
| `'claim'` (a string) | The page is uncontrolled (a forced reload). The worker calls `clients.claim()`. |
| `{ kind: 'host', key, protocol? }` | The page hosts `key` (always `'default'` on a preview origin). Sent on registration and again on every `controllerchange`. No `protocol`: protocol 1. |
| `{ kind: 'preview', key }` | A popped-out preview window shows `key`. No page sends it on a preview origin today; the worker still accepts it. |

**Worker → host:**

| Message | Meaning |
| --- | --- |
| `{ kind: 'hosted', key, protocol, protocols }` | The answer to an announce: the protocol it will speak, or `null` with the protocols it does speak. A host gets no answer from a worker older than this field and treats that as protocol 1. On `null`, the host calls `registration.update()` and announces again when the new worker takes over. |
| `{ kind: 'http', method, path, headers, body, destination, port? }` + a reply port | A preview request. `headers` is `[name, value][]`; `body` is an `ArrayBuffer` or `null` (GET, HEAD); `destination` is the request's; `port` only for a sibling origin (below). The reply on the port is `{ status, reason, headers, body, cookies? }` (`PreviewResponse`). |
| `{ kind: 'websocket', path, protocols }` + a port | A preview document's WebSocket, passed on as the document sent it. |

**Preview document → worker:** `{ kind: 'websocket', path, protocols }`
with a port, from the WebSocket shim the bridge injects. The worker sends
it to the host of the document's key. With no host, it closes the port
with `{ close: { code: 1006, reason: '', clean: false } }`. After the
handoff, the port carries the shim's and the bridge's messages
(`{ send }`, `{ close }` in; `{ open }`, `{ message }`, `{ close }` out).
Both ends are the host's version, so the worker never reads them.

**What the worker does:**

- **Navigations:** it answers iframe navigations only. The site's own
  pages go to the network: `/relay.html`, `/exec.html`, and every path
  under `/npm/@elixir-playground/`. It remembers each document it
  answered.
- **Requests:** it sends to the host the requests from the documents it
  answered. Before its routes are loaded, it loads them first. Everything
  else goes to the network without passing through it.
- **Sibling origins:** a preview document's request to another of the
  project's preview origins (same ID, same domain) goes to its own host
  with that origin's `port`.
- **Keys:** a request's key is its document's, else that of the client its
  referrer names, else the only host's, else the focused host's, else the
  last host's.
- **Responses:** for a non-navigation, it turns a 3xx with `location` into
  `Response.redirect`. It drops `connection`, `keep-alive`,
  `transfer-encoding`, `content-length` and `set-cookie`, and sends no body
  for HEAD, 101, 204, 205 and 304. It adds COEP `require-corp` and CORP
  `cross-origin` to every answer, its own 503 ("The project is not
  running.") included.
- **State:** IndexedDB `playground-sw` version 1, store `clients`, record
  `routes`: `{ keys: [[client, key]], hosts: [[key, client]], previews:
  [client], protocols: [[key, protocol]] }`. Above 256 entries, it drops
  clients that are gone. Every version of the worker reads and writes this
  record, so its schema is frozen too, and fields are only added.
- It never calls `clients.get()` on a request's path, because of a Firefox
  deadlock with a node's synchronous bundle fetch ([runtime.md](runtime.md#the-preview-swjs-bridgets)).
- **Lifecycle:** `skipWaiting()` on install, `clients.claim()` on activate.

**What moved, and what stays.** The audit found the worker already close
to a router. One piece of site knowledge had to change: a fixed list of
page paths (`/relay.html`, `/exec.html`). A versioned relay at
`/npm/@elixir-playground/runtime@V/relay.html` would have been answered as
a preview. The rule now also passes the whole package prefix, so the
versioned relay works with today's worker. This change must be deployed
before any host lives at a versioned path. Nothing moved to the host:

- **The response shaping** (redirects, dropped headers, empty bodies) is
  what the Fetch standard requires of a constructed `Response`, not app
  policy.
- **The isolation headers** are a property of the origin. The worker
  also needs them for its own 503, when there is no host to ask.
- **Key routing and sibling origins** are routing.
- **Cookies** already live in the host (`cookies.ts`, the relay's local
  storage).
- **Per protocol,** the worker can't drop protocol 1's behaviour while
  protocol 1 hosts exist. Moving work to the host only pays off in
  protocol 2.

**What makes the frozen protocol harder:**

- **The shim posts to whatever worker controls the document.** That is
  the shared worker, so the shim's first message (`kind: 'websocket'`)
  is part of the protocol, even though the host injects the shim.
- **Version skew on update.** A new relay registers `sw.js`, and the old
  worker controls the page until the new one activates. So a new host must
  keep working with the previous worker for that moment: it must speak
  every protocol the previous worker might, until it gets a `hosted`
  answer.
- **The routing record is shared** by every version of the worker (above).
- **Each embedder has its own copy of the worker.** Storage is partitioned
  by top-level site, and self-hosters deploy their own `sw.js`. A support
  window is a promise about what our `sw.js` keeps speaking. We cannot
  update every copy.

## Claude Code

The browser always fetches Claude Code from npm. We never republish it.

- `@elixir-playground/claude` holds the preparer and the range it was
  tested with: `"playground": { "claudeCode": ">=2.1.300 <=2.1.306" }`.
  The upper bound is inclusive and is the newest version tested.
- The claude frame takes the highest version on the registry within the
  range.
- Its cache is keyed by `(Claude Code version, preparer version)`.
- `create({ claude: { version } })` may pin a version inside the range. A
  pin outside it is refused.
- **Planned:** a nightly CI job that tests new Claude Code releases. On a
  pass, it publishes a patch of the claude package with a wider range.

Today the app pins one version with its integrity (`CLAUDE_CODE` in
`project/lib/programs/claude/build.ts`). The site manifest's claude
package has `">=2.1.306 <=2.1.306"`.

## Backend services

These stay servers: the TCP relay (`/relay`, [relay.md](relay.md)), NIF
builds (`/api/nif/`, [nif.md](nif.md)), the `/hex/` and `/git/` proxies,
and live sessions (`/socket`).

- **Use run-elixir.dev's.** Each embedder's origins go on per-service
  allowlists, as `PLAYGROUND_EMBEDDERS` does for `embed.html` today.
- **Mount them.** The backend could become a Hex package an embedder adds
  to its own Phoenix app.
- **Version the endpoints** (`/api/v1/nif/…`). An embedder's lockfile can
  hold an `api` for months.
- NIF builds are keyed by the BEAM build: `beamAbi` as planned, or a NIF
  ABI ([above](#abi-seams)).

## Keeping apiVersion 1 and `embed.html`

Once `api` runs in the embedder's page, the embedder's page is the apex:
PGlite, the stores, and the frames' parent. `embed.html` becomes a
compatibility wrapper. It loads `api` from the site's own installed
packages and answers apiVersion 1 over its MessagePort, as today. Its
handshake, `hello`, its `ERUNTIME` check, and its `frame-ancestors` and
`PLAYGROUND_EMBEDDERS` stay. Storage stays where it is (partitioned under
`embed.html`'s origin), so kept projects survive. An embedder can move to
`api` at its own pace, but the move changes the apex, so kept projects do
not come along. A move needs an export or import, or must start fresh.

## Open questions

- **CDN limits for using the packages without installing them.** An
  import-without-install mode would load packages straight from a public
  npm CDN (jsDelivr, unpkg, esm.sh). `tailscale.wasm` is 29 MB. jsDelivr's
  acceptable-use policy says it limits single-file size, file count and
  package size, but it gives no numbers. A third-party listing says 100 MB
  per npm package. None of this is verified, and these CDNs also don't send
  COEP-compatible CORP headers for every file, or our `frame-ancestors`.
  Such a mode probably needs the hosted mirror anyway.
- **npm package size.** The fs-bundle packages would be large. Today's
  whole fs image (boot images and bundles, mostly `phoenix-template`'s
  4,640 files and OTP's applications) is 100 MB on disk. Its bundles are
  41 MB gzipped. npm documents no tarball limit
  that I found. Large tarballs slow every `npm install`. Splitting
  rarely used OTP applications (`mnesia`, `os_mon`, `xmerl`) into their own
  packages is an option.
- **The template's identity.** `phoenix-template` is compiled for one pair.
  Two pairs cannot both be `phoenix-template@1.x`. Either the pair goes in
  the name (`phoenix-template-otp-29.1.2-elixir-1.20.4`), or the major
  encodes it.
- **NIF ABI vs `beamAbi`** ([above](#abi-seams)).
- **fs format 2:** per-package manifests and bundles, and how a project's
  kept changes note what they were made over.
- **Recordings for embedders without the plugin:** ship a recording with
  the template package for its own pair, or boot lazily.
- **The frames' pages in `runtime`:** a Vite build of their own, so they do
  not share chunks with the IDE.
- **Where `site.json` lives** for the hosted mirror: the plugin bakes it
  into `api`, or the page passes it to the exec frame. A site manifest
  under `/npm/` names exact versions, so it can be cached forever.
- **Who runs the check first.** Today it is the exec frame. The apex could
  run it before it creates any frame, to fail faster with a clearer
  message.
- **Support window length** for `sw.js` protocols, and whether a major also
  needs a new usercontent host level for the claude frame's cache.

## What is implemented

As of 2026-10-27, on the `sd-packages` branch:

- **The site manifest.** `runtime/build.py` writes `site.json` into
  `r/RID/`, with every package above but `runtime`, `api` and `vite`.
  It replaces `runtime.json` and `fs/templates.json`. `build.py app`
  reuses the facts only a full build knows (`beamAbi`, the template id,
  the fs version) from the site manifest it replaces.
- **The runtime reads it.** The exec frame, the node workers, `files.js`,
  the IDE's git, Node.js's TLS, the Tailscale worker, the template list,
  `embed.html`'s OTP and Elixir check and the Node harness all find
  their files through `site.json` (`app/src/runtime/packages/manifest.ts`).
  The program registry (`coreutils.ts` `REGISTRY`) is built from the
  packages' `programs`. coreutils' tool list moved from TypeScript to
  `build.py`. `shared/lib/build.ts` `SITE` is `${RUNTIME}site.json`.
- **The load-time check** (`check.ts`), run by the exec frame's `start`,
  and `build.py`'s import check.
- **`target/packages/NAME/`** for the nine packages in [the table above](#what-maps-onto-todays-artifacts).
  Each `package.json` is `"private": true`.
- **Protocol 1 of the service worker** with the `protocol` field, the
  `hosted` answer, and the `/npm/@elixir-playground/` pass-through
  (`runtime/swProtocol.ts`).

Not built: publishing, the Vite plugin and CLI, the npm-backed mirror,
moving the host from `embed.html` into `api`, the `.r4.` host level,
fs format 2, and the Claude CI job.
