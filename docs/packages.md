---
kind: design
status: proposal
last_updated: 2026-10-28
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

Tidewave's `/web`, which uses `embed.js` ([embed.md](embed.md)), is the
first embedder this is for. run-elixir.dev is the first consumer of the
packages.

Publishing, the build plugin and the hosted mirror are proposals. The
site itself is already laid out as these packages, and the runtime runs
from them: [What is implemented](#what-is-implemented) has the details.
Nothing is published.

## Packages

Each package's `package.json` has a `playground` field ([below](#the-playground-field)).
Every package except `runtime` peer-depends on `@elixir-playground/runtime`.
Sizes are of the 2026-10-27 build, on disk.

| Package | Contents | Peer dependencies | Size |
| --- | --- | --- | --- |
| `runtime` | The runtime's workers (`worker.js`, `files.js`, `git.js`, `nodejs.js`, `tailscale.js`, `chunks/`); the usercontent domain's frames (`exec.html`, `relay.html`, `claude.html`, `frames/`, the exec frame's worker among them) | none | 14 MB |
| `api` | `embed.js`, the embedding API's client | `runtime` | 16 KB |
| `otp-X` | `beam.mjs`, `beam.emu.mjs`, `beam.wasm` (the Emscripten build and its glue); OTP's applications (an fs layer, 831 files) | `runtime` | 39 MB |
| `elixir-X` | Elixir, IEx, Mix, ExUnit, Logger, EEx; Hex, phx_new, rebar3 (an fs layer, 604 files) | `runtime` | 14 MB |
| `phoenix-template` | The phx.new app at `/work/playground`, with `deps/` and its `_build`, compiled for one OTP and Elixir pair (an fs layer, 4,640 files) | `runtime`, `otp-X ^N`, `elixir-Y ^N` | 47 MB |
| `shell` | `brush.wasm` (the shell), `coreutils.wasm` (78 tools); the terminfo entry (an fs layer) | `runtime` | 11 MB |
| `git` | `git.wasm`; its shell-script commands (an fs layer, 13 files) | `runtime` | 3.8 MB |
| `ripgrep` | `rg.wasm` | `runtime` | 2.9 MB |
| `gnu-tools` | GNU `sed`, `grep`, `diff`, `cmp`, `diff3`, `sdiff`, `gawk`, `find` | `runtime` | 5.3 MB |
| `tls` | `tls.wasm` (a Node.js process's TLS client), `roots.pem`; the nodes' CA bundle (an fs layer) | `runtime` | 1.1 MB |
| `tailscale` | `tailscale.wasm` (the apex's Tailscale node) and `wasm_exec.js`, the glue of the Go that built it | `runtime` | 28 MB |
| `claude` | The Claude Code range the preparer was tested with; no Claude Code | `runtime` | 8 KB |
| `vite` (proposed) | A build plugin, and a CLI for sites that don't use Vite | `runtime` | |

`tailscale` is a package of its own because it is 29 MB, and only the
apex's Tailscale worker uses it.

What is still not where it belongs:

- **`claude`'s preparer** (Bun graph → CommonJS) is part of the runtime
  package's frames (`claude.html`'s worker), so `claude` holds only the
  range.
- **`api` is the client only.** The host it drives is `embed.html`, part
  of the app on the apex. Moving the host into `api` makes the embedder's
  page the apex ([below](#keeping-embedhtml)).
- **esbuild's WebAssembly** (12 MB, the page program `esbuild`) is in the
  runtime package's frames; it could be a package of its own.

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

The repository's packages are all `1.0.0` (`PACKAGES` in `build.py`;
`app/src/runtime/packages/host.json` for the runtime). The site build
names each package's directory `NAME@VERSION+ID`, ID a digest of what is
in it: unpublished, the same version may be another build, and the path
must still be immutable. A published package would be `NAME@VERSION`. A
publishing job would compare each package's digest with the published
version's and bump the patch when they differ.

## The site's layout

```
npm/@elixir-playground/NAME@VERSION+ID/   a package: package.json, its files, its fs layer (fs/)
boot/ID/                                  the boot recordings: boot.tar.gz, boot-phoenix.tar.gz
site/ID.json                              the site manifest
```

Each of these is immutable. The pages (`index.html`, `preview.html`,
`embed.html`, `storage.html`, the `/relay.html` upgrade bootstrap), `sw.js`,
`embed.js` and `playground.json`
keep their names. Each page names the runtime package's path and the
site manifest's (`<meta name="playground-runtime">`, `<meta
name="playground-site">`); the runtime finds everything else through the
manifest. [build.md](build.md#what-the-site-is) has the whole tree.

### fs layers (fs format 3)

A package with files in the nodes' tree has an fs layer, and says where
it goes: `fs.root`, an absolute path. `fs/manifest.json` lists the files
below it (`[path, size, mtime, bundle]`, `path` relative to the root) and
`fs/bundles/N.tar` holds them (uncompressed tars of up to 512 KB of one
directory's files, each named by its path in the tree: the root without
its leading slash, then the file's path). The runtime merges the layers into one tree at their
roots, and numbers the layers' bundles one after another in the
manifest's order (`Site.tree`, `Site.bundle`), so a lazy file is
`(source, bundle)` as before.

- **OTP and Elixir carry their version in the path:** `/opt/otp/29.1.2`,
  `/opt/elixir/1.20.4`, so that a project may one day install two side
  by side. The tools go where their programs expect them: git's scripts
  at `/usr/libexec/git-core` (git.wasm's exec path), the CA bundle under
  `/etc/ssl`, the terminfo entry under `/usr/share/terminfo`; the
  template at `/work/playground`.
- **The runtime finds OTP and Elixir by their packages' roots**
  (`Site.otp`, `Site.elixir`): erl's `-root`, `-bindir` and `-boot`, and
  the launchers' `-elixir_root` and `-pa`. It has no path of its own.
- **A package's commands are its `bin`:** files of its layer, which the
  runtime links from `/usr/bin/NAME` (Elixir's `mix`, Mix's script). The
  programs the runtime itself runs (the launchers `elixir`, `iex`, `erl`,
  `escript`; the page's `node`, `claude`, …; the WebAssembly programs)
  keep empty stand-ins there.
- **A package's variables are its `env`:** each a path of its layer,
  which every node gets: OTP's `ROOTDIR`, Elixir's `MIX_ARCHIVES` and
  `MIX_REBAR3`.

- **Every file's mtime is 2000-01-01** (`MTIME` in `build.py`), in the
  layer manifests, the bundles and the boot images, whose tar headers
  also carry no owner and only the executable bit of a mode. The same
  files then make the same bytes, and a package keeps its `+ID` across
  builds, though `beam/build.sh` installs OTP anew and the recording run
  compiles the template anew. Mix compares mtimes with `>` alone, and
  the recording run sees the same mtime, so the template's compile
  manifests record what a node finds and nothing is stale at boot.
- **A layer's `version`** is a digest of its files' paths and bytes,
  without Mix's records of the recording run's compile
  (`_build/ENV/lib/APP/.mix/`). A kept project
  notes the layers' versions it was made over (`Site.fsVersion`); when
  they change, `files.js` drops the template's `_build` from the kept
  records, and the project recompiles over the new one.
- **The boot recordings are not a package.** They are what IEx and the
  Phoenix server read first, recorded for an installed set: the site
  manifest's `boot`, with the packages (and versions) they were recorded
  with. Without them every file comes lazily, and boot is slower. Browser
  startup loads only the requested images present in the manifest, so a
  site can omit all recordings or provide only some of them.
- **The template's build is made by a recording.** Mix records absolute
  paths, so `build.py` compiles the template again at `/work/playground`
  in the node, under the Node harness, and lays out the template package
  with that build. A template package can only be built by running the
  `runtime`, `otp-X` and `elixir-Y` it is for.

## The `playground` field

Every key is optional. A package sets the keys that describe it.

| Key | In | Meaning |
| --- | --- | --- |
| `abi` | artifacts | `{ seam: version }`: the host ABI seams its files use ([below](#abi-seams)). |
| `programs` | `shell`, `git`, `ripgrep`, `gnu-tools` | `{ name: { module, multicall? } }`: programs the shell and nodes find by name, run with `name` as `argv[0]`. A `multicall` module (`coreutils.wasm`) serves several names; the exec frame compiles it once for every node, and it runs on its caller's thread. Others run as processes of the worker's table. |
| `shell` | `shell` | The shell's module (`brush.wasm`). |
| `otp`, `beamAbi`, `nifAbi`, `beam` | `otp-X` | OTP's version, the build's id, the NIF ABI it loads, and `{ loader, wasm }`. |
| `elixir`, `requires.otp` | `elixir-X` | Elixir's version, and the OTP range it runs on. |
| `template` | `phoenix-template` | `{ kind, id, label, otp, elixir }`: the id is a digest of its files without its build; `otp` and `elixir` are the pair it was compiled with. Its files are its fs layer's, at the layer's root. |
| `fs` | packages with files in the nodes' tree | `{ format, root, manifest, bundles, count, version }`: its fs layer, and where it goes ([above](#fs-layers-fs-format-3)). |
| `bin` | `elixir-X` | `{ name: file }`: its commands, files of its layer (relative to the root), linked from `/usr/bin/NAME`. |
| `env` | `otp-X`, `elixir-X` | `{ NAME: file }`: variables every node gets, each a path of its layer (`"."` the root). |
| `tls` | `tls` | `{ module, roots }`. |
| `tailscale` | `tailscale` | `{ module, glue }`. |
| `claudeCode` | `claude` | The tested Claude Code range ([below](#claude-code)). |
| `apiVersions` | `api` | The embedding API versions its client speaks. |
| `provides` | `runtime` | `{ seam: [versions] }`: what the runtime speaks. |

From today's build:

```json
"playground": {
  "abi": { "wasi": 1, "processes": 1 },
  "programs": { "git": { "module": "git.wasm" } },
  "fs": { "format": 3, "root": "/usr/libexec/git-core", "manifest": "fs/manifest.json", "bundles": "fs/bundles/", "count": 1, "version": "…" }
}
```

```json
"playground": {
  "abi": { "beam": 1 },
  "otp": "29.1.2",
  "beamAbi": "a51ebfdb010b7d3e",
  "nifAbi": "1-2.18",
  "beam": { "loader": "beam.mjs", "wasm": "beam.wasm" },
  "env": { "ROOTDIR": "." },
  "fs": { "format": 3, "root": "/opt/otp/29.1.2", "manifest": "fs/manifest.json", "bundles": "fs/bundles/", "count": 101, "version": "…" }
}
```

### The site manifest

The runtime does not read `node_modules`. It reads a site manifest that
the build step writes for the installed set (`site/ID.json`, manifest
version 2):

```json
{
  "manifest": 2,
  "packages": {
    "@elixir-playground/git": {
      "version": "1.0.0",
      "base": "../npm/@elixir-playground/git@1.0.0+05f3ba702001/",
      "files": { "git.wasm": { "size": 3845749, "sha256": "…" } },
      "peerDependencies": { "@elixir-playground/runtime": "^1.0.0" },
      "playground": { "abi": { "wasi": 1, "processes": 1 }, "programs": { "git": { "module": "git.wasm" } }, "fs": { … } }
    }
  },
  "boot": {
    "base": "../boot/8736843503d5/",
    "images": ["boot", "boot-phoenix"],
    "packages": { "@elixir-playground/otp-29.1.2": "1.0.0", "…": "…" }
  }
}
```

- **`base`** is relative to the manifest.
- **`boot`** names the recordings, and the exact versions they were made
  with.

The site has no NIF libraries: `make` asks the backend for each, naming
OTP's `nifAbi` ([nif.md](nif.md)).

The `runtime` package is not in the manifest. The running JavaScript is
the runtime, and it knows its own version and seams (`host.json`).
`build.py app` rebuilds the JavaScript over the packages a full build
made; a JavaScript build that breaks an ABI meets older artifacts, and
the check catches it.

## The load-time check

npm's peer dependencies choose a compatible set at install time. A
lockfile can still hold a set that does not fit, for example after
`--force` or `--legacy-peer-deps`, or with a hand-written site manifest.
So the exec frame checks the site manifest again as it starts
(`app/src/runtime/packages/check.ts`). A mismatch fails `start` with
`ERUNTIME`. It checks:

- the manifest version is one the runtime reads (`provides.manifest`);
- each package's peer dependencies are present and in range. That
  includes `runtime`, whose version is the running JavaScript's;
- each `abi` seam is at a version the runtime `provides`;
- each fs layer's format (`provides.fs`);
- one OTP package and one Elixir package at most;
- Elixir's `requires.otp` against OTP's version. OTP's four-part versions
  such as `26.2.5.3` are compared on their first three parts;
- the template's `otp` and `elixir` against the installed ones;
- the boot recordings' packages at exactly the installed versions;
- OTP's NIF ABI against the layers the runtime loads (`provides.nif`).

`build.py` checks each module's imports when it lays out a package. Every
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
| `manifest` | the build step and the runtime | 2 | the site manifest's schema, the `playground` keys, how `programs` run | `runtime` major |
| `fs` | fs layers and `files.js`, the node workers and the Node harness | 3 | layer manifests' entries (paths below `root`), bundles as uncompressed USTAR, boot images as gzipped USTAR | `runtime` major; every package with an fs layer |
| `wasi` | a WASI module and the runtime's shim (`wasi/`) | 1 | a call the shim stops answering, a changed meaning | `runtime` major |
| `processes` | `brush.wasm`, `git.wasm`, the GNU tools, and `processes.ts` | 1 | `pipe`, `spawn` (its NUL-separated request), `wait`, `kill`, `dup`, `dup2`; git's task export (`wasi_run_async`, `__stack_pointer`) | `runtime` major, and the minor of each artifact that needs a new call |
| `crossterm` | `brush.wasm` and `worker/brush.ts` | 1 | `raw_mode`, `size`, `read` | `runtime` major, `shell` |
| `tls` | `tls.wasm`'s exports and `nodejs/tls.ts` | 1 | its 19 exports (`tls_client`, `tls_alpn`, …) | `tls` major or `runtime` major |
| `tailscale` | `tailscale.wasm` with its `wasm_exec.js`, and the Tailscale worker | 1 | the worker's calls into the node | `tailscale` major or `runtime` major |
| `beam` | `beam.mjs` and the runtime's `beam/run.ts`, `worker/beam.ts` | 1 | the `Module` hooks the runtime fills: `beamSpawn`, PROXYFS mounts, sockets, the tty, `nifs.js` | `otp-X` major or `runtime` major |
| `beamAbi` | an OTP build and what is made for it | an id | any change to emsdk, the patch stack, or `beam.wasm`'s imports or exports | a new id; recordings follow |
| `nifAbi` | a NIF library and `nif.ts` plus patch 0021 | `1-2.18` | the layer: `beamos_nif_abi`/`input`/`run`/`output`, the request and answer terms; OTP's `erl_nif.h` | `BEAMOS_NIF_ABI` (and `provides.nif`), or OTP's NIF version |
| template pair | `phoenix-template` and OTP plus Elixir | exact versions | another OTP or Elixir | a new template build |
| recordings | the boot images and the installed set | exact versions | a package with an fs layer changing | a new recording |
| embedding API | `api` (`embed.js`) and the host (`embed.html`) | apiVersion 2 | [embed.md](embed.md#the-handshake-and-versions) | a new apiVersion |
| process API | `embed.html` and the IDE, and the exec frame | not numbered | `exec/host.ts` `spawn`, `input`, `closeInput`, `resize`, `signal`, `stopForeground`; `processOutput`, `processStatus`, `processExit` | numbered once `api` drives the exec frame itself |

`beamAbi` is computed by `build.py`: a digest of OTP's tag and the patch
stack (`beam/build.sh`'s `.stamp-patched`), the output of `emcc --version`,
and `beam.wasm`'s imports and exports. The runtime cannot range-check a
digest, so the runtime-facing interface is the numbered `beam` seam.

**The NIF ABI is not the BEAM's.** A NIF library is a WASI reactor in an
instance of its own ([nif.md](nif.md#the-nif-abi)). It does not link
against `beam.wasm`. It depends on the erl_nif layer's protocol and on the
`erl_nif.h` of the OTP it was compiled against, so its ABI is `nifAbi`:
`LAYER-MAJOR.MINOR`, such as `1-2.18`. An emsdk or patch change makes a
new `beamAbi` and keeps every NIF library built so far.

## The build step (proposal)

The `vite` package's plugin (and its CLI for other sites) writes what
depends on the installed set, which npm cannot provide:

- **The site manifest** for the installed packages, with `base` pointing
  at `/npm/@elixir-playground/NAME@VERSION/`.
- **Boot recordings,** recorded with the Node harness for the installed
  set. They are optional.
- **`apex/`**, copied into the embedder's app: the `api` entry and the
  apex-side files (PGlite, the claude frame's host, the Tailscale worker).
- **`usercontent/`**, for a second site: `sw.js` and the packages under
  `/npm/@elixir-playground/NAME@VERSION/` (the frames are the runtime
  package's).
- **Header configurations** for Caddy, nginx and `_headers` (Netlify,
  Cloudflare Pages): COOP, COEP, CORP, `frame-ancestors`, the Node.js
  worker's CSP, and caching (immutable under `/npm/`, `/boot/`, `/site/`,
  `/nif/`; `no-cache` for `sw.js` and the pages).

`runtime/build.py` does the same for run-elixir.dev from the repository's
own builds ([build.md](build.md)).

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
layout is the same as the mirror's, and as run-elixir.dev's own.

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
  page, the runtime package's `relay.html`.
- The parent first loads `/relay.html`, a small bootstrap that updates
  `sw.js` and waits for activation before navigating to the chosen runtime's
  relay. The unnumbered worker already exempts this root path; it would
  otherwise route the new package URL into the app. Both workers leave
  the bootstrap to the network.
- Its protocol is numbered. The host announces `{ kind: 'host', protocol:
  N }`, and the worker answers in that protocol.
- Changes within a protocol are additive only. A new `sw.js` keeps
  speaking every protocol in its support window: at least 12 months after
  the next protocol's release.
- A real break moves to a new host level, `v-ID-PORT.r4.<usercontent>`.
  Each major needs one wildcard certificate. That level has its own
  storage: the worker's routing table, the preview's cookie jar, and the
  claude frame's cache. Projects are stored on the apex, so a move loses
  no project data.

### Protocol 1

What `runtime/sw.ts`, its host (`frames/relay.ts` with `runtime/bridge.ts`)
and the preview's documents exchange (`runtime/swProtocol.ts`, as of
2026-10-27).

**Host → worker** (to `navigator.serviceWorker.controller`, or to the
active worker):

| Message | Meaning |
| --- | --- |
| `'claim'` (a string) | The page is uncontrolled (a forced reload). The worker calls `clients.claim()`. |
| `{ kind: 'host', protocol }` | The page hosts the origin. Sent on registration and again on every `controllerchange`. A host that names no protocol is refused. |

**Worker → host:**

| Message | Meaning |
| --- | --- |
| `{ kind: 'hosted', protocol, protocols }` | The answer to an announce: the protocol it will speak, or `null` with the protocols it does speak. On `null`, the host calls `registration.update()` and announces again when the new worker takes over. |
| `{ kind: 'http', method, path, headers, body, destination, port? }` + a reply port | A preview request (`HttpRequest`). `headers` is `[name, value][]`; `body` is an `ArrayBuffer` or `null` (GET, HEAD); `destination` is the request's; `port` only for a sibling origin (below). The reply on the port is `{ status, reason, headers, body, cookies? }` (`PreviewResponse`). |
| `{ kind: 'websocket', protocol, path, subprotocols }` + a port | A preview document's WebSocket, passed on as the document sent it. |

**Preview document → worker:** `{ kind: 'websocket', protocol, path,
subprotocols }` (`WebSocketRequest`) with a port, from the WebSocket shim
the bridge injects, which the host gives its protocol. The worker passes
it to its host when the host speaks that protocol; else it closes the
port with `{ close: { code: 1006, reason: '', clean: false } }`. After
the handoff, the port carries the shim's and the bridge's messages
(`{ send }`, `{ close }` in; `{ open }`, `{ message }`, `{ close }` out).
Both ends are the host's version, so the worker never reads them.

**What the worker does:**

- **Navigations:** it answers iframe navigations only. The site's own
  pages go to the network: every path under `/npm/@elixir-playground/`
  (the runtime package's `relay.html`). It remembers each document it
  answered.
- **Requests:** it sends to the host the requests from the documents it
  answered. Before its routes are loaded, it loads them first. Everything
  else goes to the network without passing through it.
- **Sibling origins:** a preview document's request to another of the
  project's preview origins (same ID, same domain) goes to its own host
  with that origin's `port`.
- **One host:** the origin's host is the last page to announce itself.
- **Responses:** for a non-navigation, it turns a 3xx with `location` into
  `Response.redirect`. It drops `connection`, `keep-alive`,
  `transfer-encoding`, `content-length` and `set-cookie`, and sends no body
  for HEAD, 101, 204, 205 and 304. It adds COEP `require-corp` and CORP
  `cross-origin` to every answer, its own 503 included.
- **No host:** with no host page, it answers 503: "The project is not
  running. If the playground was updated since you opened this page,
  reload it." A page older than protocol 1 announces without a protocol
  and is refused, so its previews get this answer until it reloads.
- **State:** IndexedDB `playground-sw` version 1, store `clients`, record
  `routes-1` (`Routes`): `{ host, protocol, previews }`. Every version of
  the worker reads and writes it, so fields are only added; another
  protocol's record has another key.
- It never calls `clients.get()` for a request's client, because of a
  Firefox deadlock with a node's synchronous bundle fetch
  ([runtime.md](runtime.md#the-preview-swjs-bridgets)).
- **Lifecycle:** `skipWaiting()` on install, `clients.claim()` on activate.

**What stays in the worker, and why.** The response shaping (redirects,
dropped headers, empty bodies) is what the Fetch standard requires of a
constructed `Response`, not app policy. The isolation headers are a
property of the origin, and the worker needs them for its own 503, when
there is no host to ask. Cookies already live in the host (`cookies.ts`,
the relay's local storage). The rest is routing.

**What makes a frozen protocol harder:**

- **The shim posts to whatever worker controls the document.** That is
  the shared worker, so the shim's message is part of the protocol, even
  though the host injects the shim.
- **Version skew on update.** A new relay registers `sw.js`, and the old
  worker controls the page until the new one activates. A new host must
  keep working with the previous worker for that moment, so it must speak
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
`project/lib/programs/claude/build.ts`), and the claude package's range
is `">=2.1.306 <=2.1.306"`. The range is not read yet.

## Backend services

These stay servers: the TCP relay (`/relay`, [relay.md](relay.md)), NIF
builds ([nif.md](nif.md)), the `/hex/` and `/git/` proxies, and live
sessions (`/socket`).

- **Use run-elixir.dev's.** Each embedder's origins go on per-service
  allowlists, as `PLAYGROUND_EMBEDDERS` does for `embed.html` today.
- **Mount them.** The backend could become a Hex package an embedder adds
  to its own Phoenix app.
- **Versioned endpoints.** An embedder's lockfile can hold an `api` for
  months. NIF builds are at `/api/v1/nif/NAME/VERSION?abi=NIF_ABI`
  ([backend.md](backend.md#building-a-nif-library)): the backend builds
  for one NIF ABI and refuses others (409).

## Keeping embed.html

Once `api` runs in the embedder's page, the embedder's page is the apex:
PGlite, the stores, and the frames' parent. `embed.html` then becomes a
wrapper that answers the current apiVersion over its MessagePort, as
today, for embedders that frame it. Storage stays where it is
(partitioned under `embed.html`'s origin), so its kept projects survive.
An embedder that moves to `api` changes its apex, so kept projects do not
come along: a move needs an export and import, or starts fresh.

## Open questions

- **CDN limits for using the packages without installing them.** An
  import-without-install mode would load packages straight from a public
  npm CDN (jsDelivr, unpkg, esm.sh). `tailscale.wasm` is 29 MB. jsDelivr's
  acceptable-use policy says it limits single-file size, file count and
  package size, but it gives no numbers. A third-party listing says 100 MB
  per npm package. None of this is verified, and these CDNs also don't send
  COEP-compatible CORP headers for every file, the Node.js worker's CSP,
  or our `frame-ancestors`. Such a mode probably needs the hosted mirror
  anyway.
- **npm package size.** `phoenix-template` is 47 MB on disk (570
  bundles) and `otp-29.1.2` 39 MB. npm documents no tarball limit that I
  found. Large tarballs slow every `npm install`. Rarely used OTP
  applications (`mnesia`, `os_mon`, `xmerl`) could be packages of their
  own.
- **The template's identity.** `phoenix-template` is compiled for one pair.
  Two pairs cannot both be `phoenix-template@1.x`. Either the pair goes in
  the name (`phoenix-template-otp-29.1.2-elixir-1.20.4`), or the major
  encodes it.
- **Recordings for embedders without the plugin:** ship a recording with
  the template package for its own pair, or boot lazily.
- **Where the site manifest lives** for the hosted mirror: the plugin
  bakes it into `api`, or the page passes it to the exec frame.
- **Who runs the check first.** Today it is the exec frame. The apex could
  run it before it creates any frame, to fail faster with a clearer
  message.
- **The process API's version.** It is not numbered, because only the
  same build's apex drives it. Once `api` runs in the embedder's page, it
  is a seam between two packages.
- **Support window length** for `sw.js` protocols, and whether a major also
  needs a new usercontent host level for the claude frame's cache.

## What is implemented

As of 2026-10-28:

- **The site is laid out as the packages** (`runtime/build.py`): each in
  `npm/@elixir-playground/NAME@VERSION+ID/` with its package.json (each
  `"private": true`, its `license`, `NOTICE.md` and `licenses/`:
  [licenses.md](licenses.md)), the recordings in `boot/ID/`, the site manifest in
  `site/ID.json`. The site ships no NIF libraries (2026-10-28): the
  backend builds them all. `b/ID/` and `r/RID/` are
  gone. `build.py app` lays every package out again over a full build's
  fs layers and recordings; with nothing changed, the same names. A full
  build (checked twice in a row, 2026-10-28) gives every package the same
  name but `phoenix-template` and the recordings. Mix's records of the
  recording run's compile (`_build/dev/lib/playground/.mix/`) hold the
  time of that compile. The template's layer version leaves them out, so
  it stays the same, and kept projects keep their builds. The template
  compiles with `ERL_COMPILER_OPTIONS=deterministic` on the host and in
  the recording run, so its modules are the same bytes each build.
- **fs format 3:** a layer per package at the root the package names,
  merged by the runtime, with the package's commands (`bin`) and
  variables (`env`); the layers' versions are what kept projects were
  made over. The runtime names no path of OTP's or Elixir's itself.
- **The runtime reads the manifest.** The exec frame, the node workers,
  `files.js`, the IDE's git, Node.js's TLS, the Tailscale worker (and Go's
  glue), the template list, `embed.html`'s OTP and Elixir check and the
  Node harness all find their files through it
  (`app/src/runtime/packages/manifest.ts`). The program registry
  (`coreutils.ts` `REGISTRY`) is the packages' `programs`.
- **The frames are the runtime package's** (`vite.frames.config.ts`):
  their own build, with a relative base, sharing nothing with the IDE.
- **The load-time check** (`check.ts`), run by the exec frame's `start`,
  and `build.py`'s import check.
- **The NIF ABI** (`nifAbi`): the layer numbers its protocol, `nif.ts`
  refuses a library of another, and the backend's `/api/v1/nif/` builds
  for one ([nif.md](nif.md#the-nif-abi)).
- **Protocol 1 of the service worker** (`runtime/swProtocol.ts`): one host
  per origin, the `hosted` answer, the shim's protocol, the
  `/npm/@elixir-playground/` pass-through, the `routes-1` record.
- **apiVersion 2 of the embedding API**, over one process API in the exec
  frame for the IDE and embedders ([embed.md](embed.md)).
- **The deploy** (`deploy/upload.sh`, `deploy/server/playground-deploy`):
  a new package's directory is seeded from the live one's, and the
  newest releases' packages, recordings and manifests are kept. Tested
  against a local `SITE` (2026-10-27), not against the server.

**Deploying it** needs, besides the release:

- Caddy's matchers ([deploy.md](deploy.md#caddy)): the Node.js worker's
  CSP on `/npm/@elixir-playground/runtime@…/nodejs.js` and `chunks/`, the
  immutable paths (`/npm/*`, `/boot/*`, `/site/*`), and the
  proxies' `/api/v1/nif/*`;
- the backend deployed with `/api/v1/nif/` and a root disk built anew
  (`sandbox/build`), whose `manifest.json` has `nif_abi`;
- Tidewave's `/web` moved to apiVersion 2: `embed.html` no longer answers 1.

Not built: publishing, the Vite plugin and CLI, the npm-backed mirror,
moving the host from `embed.html` into `api`, the `.r4.` host level, the
claude package's range in use, and the Claude CI job.
