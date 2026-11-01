---
kind: design
status: experiment
last_updated: 2026-11-01
---

# The API: running a project from a page

`create()` (the `@elixir-playground/api` package, `packages/api/`) runs an
Elixir project from the page that calls it. The playground's IDE runs
every project through it, and another site's page can do the same.

The calling page becomes the project's **apex**. It keeps the project's
stores (its file changes and its Postgres), serves the packages it
installed, and frames the shared usercontent domain's frames, which run
the project's code ([frames.md](frames.md)). Its worker answers those
frames with the packages' files (bridge mode), so the site needs no
second domain of its own. No `embed.html` sits between them: the API's
code runs in the caller's origin.

This replaces `embed.html` and `embed.js` (apiVersion 2, docs/embed.md
until 2026-10-28). They were removed before Tidewave's `/web` was
deployed.

## Using it

```js
import { create } from '@elixir-playground/api';
import otp from '@elixir-playground/otp-29.1.2';
import elixir from '@elixir-playground/elixir-1.20.4';
import standard from '@elixir-playground/standard';
import claude from '@elixir-playground/claude';

const sandbox = await create({
  plugins: [otp, elixir, standard, claude],
  project: { id: 'my-project', template: 'empty', persist: true },  // or a template package, or { archive: url }
  // id: the caller's own name for it; the same name is the same project.
  // persist: keep /work, /home (~/.claude, ~/.npm) and Postgres; needs an id.
  env: { ANTHROPIC_API_KEY: '…' },                 // every command's
  relay: ['github.com', 'api.anthropic.com'],      // hosts through the site's TCP relay (relay.md); none by default
  usercontent: 'run-elixir-usercontent.org',       // the shared domain that runs project code (the default)
  // or { domain, content, worker, packagePath } (below)
  runtime: '/npm/@elixir-playground/runtime@2.1.0/', // where this page serves the runtime package
  services: 'https://run-elixir.dev',              // the backend: NIF builds, git's proxy, the TCP relay
  container: document.body,                        // where the 1px exec frame goes
  onProgress: ({ phase, text }) => {},
});
sandbox.root;                 // the app's directory: /work, /work/playground, /work/APP
sandbox.projectId;            // its origins' key (salted: below)
sandbox.runtime;              // { otp, elixir }

await sandbox.fs.read(path);                     // Uint8Array
await sandbox.fs.write(path, data, { exclusive, expectedSha256 });  // EEXIST, ESTALE
await sandbox.fs.stat(path);                     // { type, size, mtime } or null
await sandbox.fs.list(path);                     // [{ name, type, size, mtime }]
await sandbox.fs.mkdir(path);                    // with its parents
await sandbox.fs.remove(path);                   // a directory with what is in it
await sandbox.fs.rename(from, to);
await sandbox.fs.copy(from, to);                 // a directory too
const unwatch = sandbox.fs.watch(path, ({ path, type }) => {});  // 'changed' | 'deleted'

const p = sandbox.spawn(['mix', 'test'], { cwd, env });   // a program and its arguments, on pipes
const q = sandbox.sh('mix test && echo ok', { cwd, env }); // a shell line: sh -c
const t = sandbox.terminal({ cols: 80, rows: 24 });      // an interactive shell on a terminal
const u = sandbox.terminal({ cols: 80, rows: 24, command: ['iex'] });  // a program on a terminal
const off = p.onStdout((bytes) => {});           // each on… returns a function that stops listening
p.onStderr((bytes) => {}); p.onStatus((text) => {}); p.onExit(({ code, signal }) => {});
p.write(data); p.end(); p.kill('SIGTERM'); p.stopForeground(); p.resize(cols, rows);
await p.exited;                                  // { code: 0, signal: null } or { code: null, signal: 'SIGTERM' }

const stream = await sandbox.connect(4000);      // raw bytes to a sandbox server
stream.write(bytes); stream.end(); stream.close();
stream.onData((bytes) => {}); stream.onEnd(() => {}); stream.onClose(() => {});
const stop = await sandbox.serve(9832, (stream) => {});  // 127.0.0.1:9832 answered here
const url = await sandbox.previewUrl(4000, '/tidewave?entrypoint=inner');  // relay ready: frame it
const unsubscribe = sandbox.on('serving', ({ ports, port }) => {});  // also 'progress', 'changed', 'warning'
await sandbox.shutdown();
```

`usercontent` defaults to what the page names
(`<meta name="playground-usercontent">`, which the Vite plugin writes),
then its site's `/playground.json`, then run-elixir.dev's shared domain,
`run-elixir-usercontent.org`. `runtime` defaults to
`<meta name="playground-runtime">`. The IDE relies on these defaults.
`services` defaults to the site's own
backend when `/playground.json` names this page as its apex, and to
`https://run-elixir.dev` otherwise; that backend answers only the
origins on its allowlist ([backend.md](backend.md#service-origins)).

Errors carry POSIX's `code`:

| Code | Meaning |
| --- | --- |
| `ENOENT`, `EEXIST`, `ESTALE`, `EISDIR`, `ECONNREFUSED`, `EINVAL` | As in POSIX |
| `ERUNTIME` | The plugins do not fit each other or the runtime, or no OTP, Elixir or shell package is among them |

Output and events that come before a listener are given to the first
one.

## Plugins

`plugins` is a list of packages, plugins with code, and presets (lists of
them). A name given twice counts once, the first time.

- **A package** is what its module exports: its package.json's `name`,
  `version`, `peerDependencies` and `playground` field, its `files`, and
  `base`, the path where the page serves its files (below `content`).
  Each package's `index.js` exports it (`runtime/build.py` `lay`), with
  `base` set to the published layout, `/npm/@elixir-playground/NAME@VERSION/`.
  A package can add commands and shared frames of its own, as the claude
  package does ([packages.md](packages.md#page-programs-and-shared-frames)).
- **A plugin with code** has a `name` and `apex(context)`. The function
  runs on the page once per sandbox and returns the plugin's part of that
  sandbox: `services` (by name), `ports` (the project's ports they
  answer: pglite's `{ 5432: 'postgres' }`), `env` (variables every
  process gets), `handlers` (calls from the exec frame) and `close()`.
  `context` holds the `projectId` and whether the project is kept
  (`persist`). The runtime names no service or port of its own (since
  2026-10-31).
- **A preset** is a list. `@elixir-playground/standard` is `[shell, git,
  gnuTools, ripgrep, tls, nodejs, esbuild, tailwind, inotifyTools,
  pglite()]`. The elixir package's module exports a list too: the package
  and its Hex plugin.

| Package | What it adds | Published |
| --- | --- | --- |
| `otp-X`, `elixir-X` | The BEAM and OTP, Elixir and Mix, and the elixir package's Hex cache (its `hex.js`, an apex plugin). Required. | Yes |
| `shell` | brush and coreutils. Required: every process runs through brush. | Yes |
| `git`, `gnu-tools`, `ripgrep`, `tls` | Their programs; `tls` is a Node.js process's TLS client. | Yes |
| `pglite` | Postgres on port 5432 for the nodes, PGlite on the page | Yes |
| `standard` | The preset above | Yes |
| `claude` | Claude Code: its `claude` command and the shared frame that prepares it. Without it there is no `claude` | Yes |
| `phoenix-template` | The playground's Phoenix template | No: the playground's own |
| `tailscale` | The apex's Tailscale node | No: the playground's own |

Hex's cache comes with the elixir package (since 2026-10-31; before, it
was the api's own): its `index.js` exports the package and the plugin,
which answers Hex on a port of the project's and sets `HEX_MIRROR` and
`HEX_API_URL`. A site that takes the package from a site manifest
instead of its `index.js` adds the plugin itself:

```js
import hex from '@elixir-playground/elixir-1.20.4/hex.js';

create({ plugins: [hex()], /* … */ });
```

The IDE does the same with the workspace's `@elixir-playground/hex`,
which is not published.

`create()` makes the site manifest ([packages.md](packages.md#the-site-manifest))
from the packages and the `boot` recordings, if any. It checks them
before any frame starts (`check.ts`, `ERUNTIME`) and hands the manifest
to the exec frame, which checks it again.

### Templates

`project.template` is a package with a `template` key and an fs layer
(its app is the layer, at the layer's root), or `'empty'`. The
playground's template is not published. A site that wants a precompiled
app brings its own template package, or an archive (below). A template
package fits only the OTP and Elixir it was compiled with (the
load-time check compares them).

Boot recordings (`boot`) are optional. Without them every file comes
lazily, and the first boot is slower.

## The usercontent domain, and where the page serves the packages

Projects run on a shared usercontent domain that serves no packages
([frames.md](frames.md#bridge-mode)). The page serves the packages itself,
as its own files, and a dedicated worker on the page's origin answers the
frames. The site needs no second domain, wildcard certificate or backend
of its own. Implemented 2026-10-29 as an option and made the only mode on
2026-10-30. run-elixir-usercontent.org is deployed as the shared domain:
on 2026-11-01 its subdomains served `/bridge.html`, `/sw.js` and
`/bridge.json`, and the bare domain served no bootstrap.

```js
const sandbox = await create({
  plugins: [otp, elixir, standard, claude],
  project: { id: 'my-project', template: 'empty', persist: true },
  usercontent: {
    domain: 'run-elixir-usercontent.org', // the shared domain (the default)
    content: '/web/elixir-playground/',   // the directory the packages are below: / by default
    worker: '/assets/apexWorker.js',      // only if the bundler leaves the api's worker out
  },
  runtime: '/npm/@elixir-playground/runtime@2.1.0/', // where this page serves it
  services: 'https://run-elixir.dev',
});
```

| Option | Meaning |
| --- | --- |
| `usercontent` | The shared domain, with a port if any, or the object below. Defaults as [above](#using-it). |
| `usercontent.domain` | The shared domain: a host (`run-elixir-usercontent.org`), or a host with its scheme (`https://bridge.localhost:8443`). |
| `usercontent.scheme` | `'http'` or `'https'`, overriding the scheme in `domain`. By default the scheme in `domain`; otherwise https, or http for `*.localhost` or a host with a port. Never the page's scheme ([frames.md](frames.md#schemes)). |
| `usercontent.content` | The directory the packages are below, on the page's origin or another (a CDN). The descriptors' `base`s, the boot recordings' `base` and `runtime` resolve below it, even with a leading slash. By default what `<meta name="playground-content">` names, else the page's origin root (`/`). |
| `usercontent.worker` | The apex worker's script, if the bundler leaves the api's own out, or the page's scripts are on another origin ([below](#the-apex-worker)). |
| `usercontent.packagePath` | Each package's directory below `content`, with `{name}` and `{version}` in it: `'{name}@{version}/'` for unpkg's layout. By default each descriptor's `base` (`/npm/NAME@VERSION/`, jsDelivr's layout). A `base` that is a URL of its own stays as it is. |
| `services` | The backend's origin, or `{ relay, nif, git }`, each a URL or `null` for none. |

### What the page serves

- Each package directory, unchanged, at its descriptor's `base` below
  `content`: `CONTENT/npm/@elixir-playground/NAME@VERSION/` for the
  published ones, and the runtime at `runtime`. With `content:
  'https://example.com/web/elixir-playground/'`, OTP's files are at
  `https://example.com/web/elixir-playground/npm/@elixir-playground/otp-29.1.2@1.0.1/`.
  A boot recording's `base` too, if given.
- The api's apex worker, on the page's origin ([below](#the-apex-worker)).
- An archive (`project.archive`) with CORS.

**Headers:**

- The page: COOP `same-origin` and COEP `require-corp`.
- The packages' files (and recordings), wherever they are:
  `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy:
  cross-origin`. The frames' workers read them from the shared domain's
  origins, one per project, so no single origin can be named. Their paths
  are immutable: `Cache-Control: public, max-age=31536000, immutable`
  lets the HTTP cache keep them for every project.

Each package file's `Content-Type` comes from its extension: the apex
worker sets `.html`, `.js`, `.mjs`, `.wasm`, `.json` and `.css` itself,
whatever the server sends. Other files, and error answers, keep the
server's type.

### The apex worker

The api starts a dedicated worker, the apex worker, which answers the
frames. A dedicated worker's script must be on the page's origin. The
api's `index.js` starts it with
`new Worker(new URL('./apexWorker.js', import.meta.url), { type: 'module' })`,
the form that Vite and webpack 5 document for workers: the bundler
emits the worker with the page's own scripts. The package also exports
`@elixir-playground/api/apexWorker.js`.

Tested on 2026-11-01 with Vite 8.3.4 (`tests/vite-site/plain.sh`): a
plain Vite app without the Vite plugin, its packages on another origin,
ran `elixir -e` after `vite build` and on the dev server, with the api
pre-bundled. Webpack and other bundlers were not tested.

A page needs `usercontent.worker` when:

- its bundler leaves the worker out;
- or its scripts come from another origin than the page: a Vite dev
  server beside a Phoenix page, or a CDN. A `Worker` from another origin
  fails to start.

For scripts on another origin, give the worker as a `blob:` URL of the
page's origin that imports the real script. Tidewave does this, roughly
as below; this repository's tests do not cover it:

```js
import workerUrl from '@elixir-playground/api/apexWorker.js?url';

const worker = URL.createObjectURL(
  new Blob([`import ${JSON.stringify(new URL(workerUrl, import.meta.url).href)};`], {
    type: 'text/javascript',
  }),
);
await create({ /* … */ usercontent: { domain, content, worker } });
```

The imported script needs CORS (and CORP `cross-origin` under COEP), as
the packages' files do.

### From a public npm CDN

A page can take the packages from a public npm CDN as `content`, without
serving about 85 MB itself. On 2026-11-01 both of these ran `elixir -e`
in Chromium with the published packages (`tests/vite-site/cdn.sh`;
results in [bridge-report.md](bridge-report.md#a-public-npm-cdn)):

| CDN | Options |
| --- | --- |
| jsDelivr | `content: 'https://cdn.jsdelivr.net/'`, `runtime: '/npm/@elixir-playground/runtime@VERSION/'`. The descriptors' `base`s already name its layout. |
| unpkg | `content: 'https://unpkg.com/'`, `packagePath: '{name}@{version}/'`, `runtime: '/@elixir-playground/runtime@VERSION/'`. |

Both send `Access-Control-Allow-Origin: *` and CORP `cross-origin`.
jsDelivr sends `.html` as `text/plain`, which the apex worker corrects
(above). The page still serves its own scripts and the apex worker.

**The backend's services** are requested by the page's worker with the
page's `Origin`. run-elixir.dev answers the origins on its allowlist
(`PLAYGROUND_SERVICE_ORIGINS`, [backend.md](backend.md#service-origins)).
A site that is not on it gets 403, and can point `services` at a backend
of its own or a reverse proxy to one. For local development,
[backend.md](backend.md#service-origins) shows how.

**The shared domain** serves `/bridge.html`, `/sw.js` and `/bridge.json`,
which names it. A page cannot bridge any other domain
([frames.md](frames.md#who-may-bridge)).

**Several sandboxes on one page** each keep their own domain and bridge.
A sandbox's previews and shared frames stay on its own domain after
another `create()` on the page names another.

### Project keys

A project has two keys:

- **Its stores' key** names what the page keeps of it (its files and its
  Postgres, [below](#storage)): the caller's `id` hashed to ten letters
  and digits, or the `id` itself if it already is ten letters and digits.
  Only the page reads its own storage, so this key needs no secret. It is
  the key the usercontent domain's origins had before 2026-10-30, so kept
  projects keep their files across that change.
- **Its origins' key** (`sandbox.projectId`) names its frames' origins
  (`e-KEY`, `v-KEY-PORT`). Every `id` is salted with a secret in the
  page's local storage, an `id` that is already ten letters and digits
  too. Then no other frame can tell a project's origins from its `id`
  ([frames.md](frames.md#what-relies-on-storage-partitioning)).

The page keeps one salt while it is open. If local storage cannot keep it
(blocked, or full), the next load gets other origin names, and what the
old origins kept (a preview's cookies and routes, the claude frame's
cache) starts anew. Kept projects keep their files.

## A site of your own: the Vite plugin

`@elixir-playground/vite` (`packages/vite`) lays out what a site serves
for its projects: the packages, as its own files.

```js
// vite.config.js
import { defineConfig } from 'vite';
import { elixirPlayground } from '@elixir-playground/vite';

export default defineConfig({
  plugins: [elixirPlayground()],
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
});
```

| Option | Meaning |
| --- | --- |
| `usercontent` | The shared usercontent domain, with a port if any, and with a scheme if the default is wrong ([frames.md](frames.md#schemes)). Named in each page's `<meta name="playground-usercontent">`; without it, `create()` takes run-elixir.dev's. A `*.localhost` name (`usercontent.localhost:5173`) is answered by `vite` and `vite preview` themselves, for local work. |
| `packages` | Package directories that are not installed, such as a template of the site's own. |

**`vite build`** lays the runtime package and every installed package
with a `playground` object, of any npm scope or none (since 2026-10-31),
out in the site's own output, at `dist/npm/NAME@VERSION/` (NAME with its
scope: `dist/npm/@elixir-playground/git@1.0.3/`, `dist/npm/ruby-shell@3.0.0/`;
served below Vite's `base`; the bootstrap, `root/bridge.html`, left out). Each page gets `<meta
name="playground-runtime">`, `<meta name="playground-content">` (Vite's
`base`) and, with `usercontent`, `<meta name="playground-usercontent">`,
which `create()` reads by default.

The site's server sends the pages COOP `same-origin` and COEP
`require-corp`, and the packages the headers [above](#what-the-page-serves).
**`vite`** (dev) and **`vite preview`** send them themselves, and answer a
`*.localhost` usercontent domain's hosts (`/bridge.html`, `/sw.js`,
`/bridge.json`).

The backend's services (the TCP relay, NIF builds, the `/hex/` and
`/git/` proxies) are not part of it ([packages.md](packages.md#backend-services)):
`create({ services })` names them.

`tests/vite-site/run.sh` builds a fixture site with the plugin over a
built site's packages, below Vite's `base` `/web/`, serves it with `vite
preview`, and runs `elixir -e` in Chromium. `packages/vite/test` checks
the layout and the pages' meta tags.

## How the IDE uses it

The IDE (`project/lib/playground.ts`) creates a sandbox each time a
project starts. It passes:

- the site's packages (`sitePackages()`, from the site manifest), its
  boot recordings, the `pglite()` plugin and the `tailscale` plugin
  (`tailscale/plugin.ts`);
- `relay`, as a function that asks the user (`relay/client.ts`
  `relayWay`);
- options of its own (`PlaygroundOptions` in `packages/api/src/sandbox.ts`, not a
  stable interface): `kind: 'iex'` for a temporary IEx, the `/shared`
  store's port, an abort signal, and `connected`, which gets the exec
  frame's port and where its previews are (their origins' key and their
  relays' bridge) before the files start.

Its terminals are `sandbox.terminal({ initial })` processes. Project
management, settings, trust, `/shared`, sharing and git's changes view
stay in the IDE. The IDE's own calls (git, search, the changes to share)
go over `sandbox.exec`, the exec frame's port, which is not a stable
interface.

## Processes

Every process is the exec frame's (`exec/host.ts` `spawn`), the IDE's
terminals too: a node of its own, running `sh -c LINE` (brush, as the
terminals run it). `spawn(argv)` quotes its words into that line. A
process runs node commands, page programs (`node`, `npm`, `npx`, `git`,
`claude`, …) and coreutils. Its environment is `create()`'s `env`, then
its own, both under the playground's own variables (`PATH`, `HOME`,
`MIX_HOME`, the preview's origins).

- **On pipes** (`spawn`, `sh`): its input as it comes (`write`), then its
  end (`end`); its stdout and stderr apart, through brush, its children,
  a node's `standard_error`, page programs and Node.js's `child_process`;
  how it ended.
- **On a terminal** (`terminal`): the exec frame keeps its line
  discipline: echo, editing, history, Ctrl+C as SIGINT, raw when the
  program asks (brush's line editor, IEx, Node's `setRawMode`). Output
  and errors are one stream, on stdout, and a newline is CR LF. `resize`
  is SIGWINCH. The terminal must answer the cursor-position query
  (`ESC [ 6 n`) as xterm.js does: brush's line editor waits for it.
  `initial` lines are typed first and seed the history.
- **Signals:** `kill('SIGINT')` is Ctrl+C, and the program decides how it
  ends. Another signal ends the process at once: `{ code: null, signal }`.
  `stopForeground()` ends a shell's foreground program, and the shell
  stays.
- **`CLAUDE_CODE_EXECUTABLE`** is `/usr/bin/claude` in every command's
  environment with the claude package (its `variables`), so
  claude-agent-acp (and the Agent SDK under it) runs the playground's
  Claude Code ([nodejs.md](nodejs.md#claude-code-claude)).

**Ports.** `connect(port)` reaches a server the sandbox runs, raw: no
`Origin`, so Tidewave's `/tidewave/mcp` answers it. `serve(port,
handler)` makes the sandbox's connections to `127.0.0.1:port` the
page's, from a node or a Node.js process.

**The preview.** `previewUrl(port, path)` makes the port's relay frame
and returns the page's URL, `https://v-KEY-PORT.USERCONTENT/path`; the
caller frames it itself. The caller's frame and the relay are both
under the caller's top-level site, so the browser gives them one
storage partition, and the relay's service worker answers the frame. The
bridge takes the caller's origin as its framer.

**The relay.** `relay` names the hosts the project's code may reach
through the site's TCP relay, as the relay's own list names them
(`'*.github.com'`: its subdomains), or is a function that decides per
host. The relay still connects only to its own list's hosts
([relay.md](relay.md)).

## Who may run projects on the usercontent domain

Any page may. The shared domain names no one: the page supplies its
frames' code, and they take it as their apex, their only parent. What
keeps sites apart there is the browser's storage partitioning and the
bridge's salted names
([frames.md](frames.md#what-relies-on-storage-partitioning)). Until
2026-10-30 the domain served the packages itself, and its
`playground.json` named the sites whose pages it ran projects for
(`embedders`, `PLAYGROUND_EMBEDDERS`); a page of another site got
`EACCES`. Both are gone.

**The services** (`/git/`, `/api/v1/nif/`, `/relay`) are the apex's
since 2026-10-29: the page's worker requests them, with the page's
`Origin`. They answer the apex and the origins on the backend's
allowlist (with CORS), and refuse another origin with 403
([backend.md](backend.md#service-origins)). `/hex/` serves the apex's own
pages only: on another site's page, Hex's repository comes from the
public mirror, because that page's origin has no `/hex/`.

## Storage

Everything the apex keeps is in the calling page's origin: the project's
file changes (`playground-files-KEY`), its Postgres (the pglite plugin's,
`/pglite/playground-pg-KEY`) and Hex's cache. With `persist`, the
project's changes below `/work` and `/home` (`~/.claude`'s credentials,
`~/.npm/_npx`) and its Postgres are kept there, under the project's
stores' key (the caller's `id`, hashed to ten letters and digits; an id
that already is ten letters and digits is the key;
[above](#project-keys)). The claude frame's cache of Claude Code is one
per apex origin and top-level site (its `claude-HASH` origin is salted
with the page's secret).

## Projects from an archive

`project: { archive: url }` starts from an app the caller built: a
gzipped tar whose top directory (`demo/`) becomes `/work/demo`
(`sandbox.root`). It is laid into the shared files as a template is, with
mtimes kept, so Mix finds its build current. The project also unpacks
the Phoenix server's boot image, if the `boot` recordings have one.

The playground's own Phoenix template (`phoenix-template`) is not
published, and there is no plan to publish it: it is built for the
playground's IDE. An embedder builds an archive instead.

What the caller builds (`tests/embed-archive.sh` does it in Docker, or
with `--native` on a host with exactly the runtime's OTP and Elixir):

- the app compiled natively with the runtime's OTP and Elixir, `deps/`
  and `_build/dev` in the tar;
- **at `/work/APP`**, the path it has in the playground: Mix records the
  app's absolute path;
- its assets built (`priv/static`), without the native
  `_build/esbuild-*` and `_build/tailwind-*`;
- git dependencies' `.git` without objects (config, HEAD, refs, an empty
  `objects/info/packs`), as the template's;
- the Repo on database `postgres` with `pool_size: 1` (PGlite is one
  session).

The exec frame fetches the tar from the URL the page gives, from the
usercontent domain, so its server must answer with CORS
(`Access-Control-Allow-Origin`).

`tests/embed-archive.sh` builds phx_new 1.8.15 with Tidewave 0.9 (about
15 MB). `--native` checks the host's OTP and Elixir versions, builds in
`WORK` (default `/work`, which must exist and be writable) and keeps Mix
and Hex in scratch homes. Below a path other than `/work`, the app's own
sources compile again in the playground.

## Headers

**The calling page** is served cross-origin isolated (COOP
`same-origin`, COEP `require-corp`). Its frames are a pixel on the
screen, unseen (`execFrame.ts` `unseen`, inline styles), not `hidden`,
and ask for `allow="cross-origin-isolated"`.

**The packages' files** carry CORS and CORP `cross-origin`
([above](#what-the-page-serves)).

**The usercontent domain** answers its three files with CORP
`cross-origin` (the calling page frames it from another site). Its
service worker sends the frames' headers itself, the Node.js worker's CSP
among them ([frames.md](frames.md#bridge-mode)).

## What Tidewave maps onto it

| Tidewave's CLI | Here |
| --- | --- |
| `/read`, `/write`, `/stat`, `/listdir`, `/mkdir`, `/delete`, `/copy`, `/move`; `watch:` | `fs.*`; `fs.watch` |
| `/cmd`, `/shell`, `/which` | `sh(line)` on pipes: stdout, stderr, how it ended |
| `terminal:` | `terminal({ cols, rows, command })`, raw keys in, PTY output out |
| ACP proxy | `spawn(['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.85.1'])`, newline-delimited JSON-RPC on stdin/stdout, its logs on stderr |
| reverse MCP bridge (`127.0.0.1:9832/socket/mcp-remote-client`) | `serve(9832, …)`: a tiny HTTP/1.1 server on the stream |
| the app's `/tidewave/mcp`, `/config`, `/upload` | `connect(4000)`, raw HTTP |
| the app frame | `previewUrl(4000, '/tidewave?entrypoint=inner')` |

## Types

`api` and `pglite` ship declarations (`index.d.ts`, with `types/` beside
it), and each descriptor package and `standard` an `index.d.ts` that
types its export with `api`'s `PackageDescriptor` or `Plugin`. Building
a package runs `tsc -p tsconfig.build.json` (declarations only, members
marked `@internal` left out) and `packages/types.mjs`, which keeps the
files `index.d.ts` reaches. The runtime package publishes no
declarations: the few types of its that `api` exports (the site
manifest's, in `runtime/src/packages/types.ts`, and `Signal`) travel in
`api`'s `types/`. Not public, and left out: the exec frame's port
(`sandbox.exec`), the IDE's options (`createSandbox`), and the process
and sandbox constructors.

## Tests

`api.spec.ts` runs against a test embedder (`app/test/embedder/index.html`,
served by `serve.py --embedder-host embedder.localhost:PORT`, its own
site, cross-origin isolated). The page imports the packages through an
import map, as installed: `serve.py` serves the site's packages at
`/node_modules/@elixir-playground/NAME/`, PGlite at
`/node_modules/@electric-sql/pglite/`, and each package's published path
(`/npm/@elixir-playground/NAME@VERSION/`) from the directory `build.py`
laid it out in. Its template is the playground's own, described from its
package.json.

- a Phoenix project: files, a command, its server over a raw
  `connect(4000)`, its preview framed by the embedder;
- commands: stderr apart, a program not found, input as it comes,
  SIGTERM, an interactive shell on a terminal, `serve(9832)`;
- claude-agent-acp over pipes against a mock API;
- an archive built by `tests/embed-archive.sh` (skipped without it);
- a site that the playground names nowhere runs a project; packages
  that do not fit get `ERUNTIME`;
- a kept project's files and `~/.claude` after a reload.

`bridge.spec.ts` runs the embedder on a second shared domain
(`serve.py --bridge bridge.localhost:PORT`): a Phoenix project and its
preview, git through the apex's worker with the embedder's `Origin`, a
NIF build (skipped without `tests/nif/build.py`'s fixtures), the Node.js
worker's policy, the shared domain hosting nothing top-level, the
services' allowlist, Claude Code, two sandboxes on one page, and a kept
project's files after a lost salt. `https-bridge.spec.ts` runs the http
embedder on an https shared domain (`serve.py --https-bridge
bridge.localhost:PORT+3`, self-signed): the exec frame and a preview on
https origins. `bridge-guard.spec.ts` checks that no
other site can bridge the apex. `embedder.ts` holds the helpers the
specs use.

Outside Playwright's suite, each over a built site:

- `tests/vite-site/run.sh`: a Vite site with the Vite plugin, below
  `base: '/web/'` (CI).
- `tests/vite-site/plain.sh`: a plain Vite app without the plugin, the
  packages on another origin, the apex worker as Vite emits it; after
  `vite build` and on the dev server (CI).
- `tests/vite-site/cdn.sh jsdelivr|unpkg`: the published packages from a
  public npm CDN. It needs the network, so it is not in CI.

## Not yet

- **A real Safari.**
- **Tidewave's side** (`/web` on the published packages): in progress.
- **`fs.watch`'s kinds**: a change says only whether the path is there
  now (`changed`) or not (`deleted`); a rename is the two.
