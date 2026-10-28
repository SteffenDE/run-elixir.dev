---
kind: design
status: experiment
last_updated: 2026-10-28
---

# The API: running a project from a page

`create()` (the `@elixir-playground/api` package, `packages/api/`) runs an
Elixir project from the page that calls it. The playground's IDE runs
every project through it, and another site's page can do the same.

The calling page becomes the project's **apex**. It keeps the project's
stores (its file changes and its Postgres) and frames the usercontent
domain's frames, which run the project's code
([frames.md](frames.md)). No `embed.html` sits between them: the
API's code runs in the caller's origin.

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
  usercontent: 'run-elixir-usercontent.org',       // the domain that runs project code
  runtime: '/npm/@elixir-playground/runtime@1.0.0/', // the runtime package's path there
  container: document.body,                        // where the 1px exec frame goes
  onProgress: ({ phase, text }) => {},
});
sandbox.root;                 // the app's directory: /work, /work/playground, /work/APP
sandbox.projectId;            // its key, the name of its origins
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

`usercontent` and `runtime` default to what the calling page's site
names: `/playground.json` and `<meta name="playground-runtime">`. The
IDE relies on these defaults.

Errors carry POSIX's `code`:

| Code | Meaning |
| --- | --- |
| `ENOENT`, `EEXIST`, `ESTALE`, `EISDIR`, `ECONNREFUSED`, `EINVAL` | As in POSIX |
| `ERUNTIME` | The plugins do not fit each other or the runtime, or no OTP, Elixir or shell package is among them |
| `EACCES` | The usercontent domain does not run projects for this page's origin |

Output and events that come before a listener are given to the first
one.

## Plugins

`plugins` is a list of packages, plugins with code, and presets (lists of
them). A name given twice counts once, the first time.

- **A package** is what its module exports: its package.json's `name`,
  `version`, `peerDependencies` and `playground` field, its `files`, and
  `base`, the path where its files are on the usercontent domain. Each
  package's `index.js` exports it (`runtime/build.py` `lay`), with
  `base` set to the published layout, `/npm/@elixir-playground/NAME@VERSION/`.
- **A plugin with code** has a `name` and `apex(context)`. The function
  runs on the page once per sandbox and returns the plugin's part of that
  sandbox: `services` (by name; `postgres` is port 5432), `handlers`
  (calls from the exec frame) and `close()`. `context` holds the
  `projectId` and whether the project is kept (`persist`).
- **A preset** is a list. `@elixir-playground/standard` is `[shell, git,
  gnuTools, ripgrep, tls, pglite()]`.

| Package | What it adds | Published |
| --- | --- | --- |
| `otp-X`, `elixir-X` | The BEAM and OTP, Elixir and Mix. Required. | Yes |
| `shell` | brush and coreutils. Required: every process runs through brush. | Yes |
| `git`, `gnu-tools`, `ripgrep`, `tls` | Their programs; `tls` is a Node.js process's TLS client. | Yes |
| `pglite` | Postgres on port 5432 for the nodes, PGlite on the page | Yes |
| `standard` | The preset above | Yes |
| `claude` | Claude Code: without it, `claude` fails | Yes |
| `phoenix-template` | The playground's Phoenix template | No: the playground's own |
| `tailscale` | The apex's Tailscale node | No: the playground's own |

Hex's cache is the API's own service, and every sandbox has it.

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

## A site of your own: the Vite plugin

A site that runs projects needs a second registrable domain for their
code, the usercontent domain ([frames.md](frames.md)).
`@elixir-playground/vite` (`packages/vite`) lays out what that domain
serves:

```js
// vite.config.js
import { defineConfig } from 'vite';
import { elixirPlayground } from '@elixir-playground/vite';

export default defineConfig({
  plugins: [elixirPlayground({ apex: 'example.com', usercontent: 'example-usercontent.com' })],
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
});
```

| Option | Meaning |
| --- | --- |
| `apex` | The site's own host. The usercontent domain's frames take calls from its pages. Required to build; in dev, the dev server's. |
| `usercontent` | The usercontent domain, with a port if any. |
| `embedders` | Other sites whose pages may run projects on it. |
| `packages` | Package directories that are not installed, such as a template of the site's own. |
| `outDir` | Where `vite build` writes the usercontent domain's files: `dist-usercontent/` by default. |
| `https` | The usercontent domain's scheme, for the Node.js worker's policy: `true` by default. |

**`vite build`** writes:

- `dist-usercontent/`, for the usercontent domain: the runtime package
  and every installed package with a `playground` field at
  `/npm/@elixir-playground/NAME@VERSION/` (where the descriptors' `base`
  points); the runtime's `sw.js` and `/relay.html` bootstrap (its
  `root/`); `playground.json`, naming the apex; and `_headers`
  (Netlify, Cloudflare Pages): COEP and CORP everywhere, `/npm/`
  immutable, and the Node.js worker's `Content-Security-Policy`, with a
  wildcard host for the domain's subdomains;
- in the apex's `dist/`: `playground.json` and, in each page, `<meta
  name="playground-runtime">`, which `create()` reads by default.

The apex's own pages must be served cross-origin isolated (COOP
`same-origin`, COEP `require-corp`); that is the site's server's job.

**`vite`** (dev) and **`vite preview`** answer the usercontent
domain's hosts themselves (`usercontent.localhost:5173`, say: browsers
resolve `*.localhost` to this machine), and send the apex's pages
COOP and COEP.

The backend's services (the TCP relay, NIF builds, the `/hex/` and
`/git/` proxies) are not part of it ([packages.md](packages.md#backend-services)).

`tests/vite-site/run.sh` builds a fixture site with the plugin over a
built site's packages, serves it with `vite preview`, and runs
`elixir -e` in Chromium (2026-10-28: `42` in 0.9 s, localhost).
`packages/vite/test` checks the layout and the headers.

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
  frame's port before the files start.

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
  environment, so claude-agent-acp (and the Agent SDK under it) runs the
  playground's Claude Code ([nodejs.md](nodejs.md#claude-code-claude-programsclaudeclaudets)).

**Ports.** `connect(port)` reaches a server the sandbox runs, raw: no
`Origin`, so Tidewave's `/tidewave/mcp` answers it. `serve(port,
handler)` makes the sandbox's connections to `127.0.0.1:port` the
page's, from a node or a Node.js process.

**The preview.** `previewUrl(port, path)` makes the port's relay frame
and returns the page's URL, `https://v-ID-PORT.USERCONTENT/path`; the
caller frames it itself. The caller's frame and the relay are both
under the caller's top-level site, so the browser gives them one
storage partition, and the relay's service worker answers the frame. The
bridge takes the caller's origin as its framer.

**The relay.** `relay` names the hosts the project's code may reach
through the site's TCP relay, as the relay's own list names them
(`'*.github.com'`: its subdomains), or is a function that decides per
host. The relay still connects only to its own list's hosts
([relay.md](relay.md)).

## Who may run projects on a usercontent domain

The usercontent domain's frames (`exec.html`, `relay.html`,
`claude.html`) take their parent's calls only from the origins the
domain's `playground.json` names: its apex (`domain`) and `embedders`.
Each frame says it loaded to any parent; that message holds nothing
else. The exec frame answers a page it does not run projects for with
`playground-exec-refused`, and `create()` fails with `EACCES`.

`PLAYGROUND_EMBEDDERS` (space-separated origins) names the other sites
when building. The default is `https://tidewave.ai
https://tidewave.steffend.me http://localhost:4000`. `serve.py
--embedders "…"` overrides the list; the tests add
`http://embedder.localhost:PORT`.

A site that self-hosts its usercontent domain names its own apex there.

**The proxies** (`/hex/`, `/git/`, `/api/v1/nif/`) refuse a browser's
request from another site's page (`Sec-Fetch-Site: cross-site`), in
`serve.py` and Caddy. On another site's page, Hex's repository comes
from the public mirror, because that page's origin has no `/hex/`.

## Storage

Everything the apex keeps is in the calling page's origin: the project's
file changes (`playground-files-KEY`), its Postgres (the pglite plugin's,
`/pglite/playground-pg-KEY`) and Hex's cache. With `persist`, the
project's changes below `/work` and `/home` (`~/.claude`'s credentials,
`~/.npm/_npx`) and its Postgres are kept there, under the project's key
(the caller's `id`, hashed to ten letters and digits; an id that already
is ten letters and digits is the key). The claude frame's cache of
Claude Code is one per top-level site.

## Projects from an archive

`project: { archive: url }` starts from an app the caller built: a
gzipped tar whose top directory (`demo/`) becomes `/work/demo`
(`sandbox.root`). It is laid into the shared files as a template is, with
mtimes kept, so Mix finds its build current. The project also unpacks
the Phoenix server's boot image, if the `boot` recordings have one.

What the caller builds (`tests/embed-archive.sh` does it in Docker):

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

The exec frame fetches the tar from the usercontent domain, so its
server must answer with CORS (`Access-Control-Allow-Origin`).

## Headers

**The calling page** is served cross-origin isolated (COOP
`same-origin`, COEP `require-corp`). Its frames are a pixel on the
screen, unseen (`execFrame.ts` `unseen`, inline styles), not `hidden`,
and ask for `allow="cross-origin-isolated"`.

**The usercontent domain** answers with CORP `cross-origin` (the
calling page frames it from another site). The Node.js worker's CSP and
the immutable paths are as in [deploy.md](deploy.md#caddy).

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
- a site that is not named gets `EACCES`; packages that do not fit get
  `ERUNTIME`;
- a kept project's files and `~/.claude` after a reload.

## Not yet

- **A real Safari**, and Tidewave's side (`/web` on the API).
- **`fs.watch`'s kinds**: a change says only whether the path is there
  now (`changed`) or not (`deleted`); a rename is the two.
