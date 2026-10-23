---
kind: design
status: experiment
last_updated: 2026-10-23
---

# Embedding the playground in another site

Another site (an **embedder**, first Tidewave's IDE at `tidewave.ai/web`)
runs a project in run-elixir.dev without hosting the BEAM, brush,
coreutils, Node.js or Claude Code itself. Its page imports
`https://run-elixir.dev/embed.js`, which frames `embed.html`: the
project's page without the IDE. The two talk over `postMessage` and
MessagePorts only: none of run-elixir.dev's code runs on the embedder's
origin, and none of the embedder's on run-elixir.dev. The security model
of [frames.md](frames.md) stays as it is: project code runs only on the
usercontent domain, and its frames still answer only the apex.

```
embedder's page (COOP same-origin, COEP require-corp: its own headers)
 │  import https://run-elixir.dev/embed.js        (src/embed/client.ts)
 ├─ iframe run-elixir.dev/embed.html              (src/embed/host.ts)
 │   the apex's part of a project: PGlite, the store (IndexedDB), Hex's
 │   cache, the preview's relays, each terminal's line discipline,
 │   Claude Code's files, connections to the embedder's ports
 │   ├─ iframe e-ID.USERCONTENT/exec.html         (unchanged: trusts the apex)
 │   ├─ iframe claude.USERCONTENT/claude.html     (unchanged)
 │   └─ iframe v-ID-PORT.USERCONTENT/relay.html   (unchanged, per port)
 └─ iframe v-ID-PORT.USERCONTENT/…                the embedder's own preview frame
```

`embed.html` reuses the IDE's parts rather than copying them: the exec
frame's start (`shared/lib/execFrame.ts`), the apex's services
(`project/lib/services.ts`: PGlite, Hex), the relays
(`previewOrigins.ts`), the claude frame (`programs/claude/frame.ts`)
and the line discipline (`runtime/terminal.ts`).

## The API (apiVersion 1)

```js
import { create } from 'https://run-elixir.dev/embed.js';

const sandbox = await create({
  runtime: { otp: '29.1.2', elixir: '1.20.4' }, // must be the site's (below)
  project: { template: 'phoenix' },               // or 'empty', or { archive: url }
  // project.id: the embedder's own name for it; the same name is the same project
  persist: true,          // keep /work, /home (~/.claude, ~/.npm) and Postgres
  env: { ANTHROPIC_API_KEY: '…' },                // every command's
  container: document.body,                       // where the 1px frame goes
  onProgress: ({ phase, text }) => {},
});
sandbox.root;                 // the app's directory: /work/playground, /work/APP
sandbox.hello;                // { apiVersion, apiVersions, runtime }

await sandbox.fs.read(path);                     // Uint8Array
await sandbox.fs.write(path, data, { exclusive, expectedSha256 });  // EEXIST, ESTALE
await sandbox.fs.stat(path);                     // { type, size, mtime } or null
await sandbox.fs.list(path);                     // [{ name, type, size, mtime }]
await sandbox.fs.mkdir(path);                    // with its parents
await sandbox.fs.remove(path);                   // a directory with what is in it
await sandbox.fs.rename(from, to);
await sandbox.fs.copy(from, to);                 // a directory too
const unwatch = sandbox.fs.watch(path, ({ path, type }) => {});  // 'changed' | 'deleted'

const p = sandbox.spawn('mix test', { cwd, env });           // a shell line: sh -c
const q = sandbox.spawn(['node', '-e', code]);               // words, quoted
const t = sandbox.spawn(null, { tty: { cols: 80, rows: 24 } }); // an interactive shell
p.onStdout(bytes => {}); p.onStderr(bytes => {}); p.onExit(code => {});
p.write(data); p.closeStdin(); p.kill('SIGTERM'); p.resize(cols, rows);
await p.exited;                                  // 128 + the signal's number when killed

const stream = await sandbox.connect(4000);      // raw bytes to a sandbox server
stream.write(bytes); stream.end(); stream.close();
stream.ondata = bytes => {}; stream.onend = () => {}; stream.onclose = () => {};
const stop = await sandbox.serve(9832, stream => {});  // 127.0.0.1:9832 answered here
const origin = await sandbox.previewOrigin(4000);      // relay ready: frame `${origin}/…`
sandbox.on('serving', ({ ports, port }) => {});        // also 'progress', 'changed', 'warning'
await sandbox.shutdown();
```

Errors carry POSIX's `code` (`ENOENT`, `EEXIST`, `ESTALE`, `ECONNREFUSED`,
`ERUNTIME` for a runtime mismatch, `EACCES` for an origin not allowed).
Output that comes before a listener is given to the first one.

**Commands.** A command is `sh -c LINE` in a node of its own (brush, as
the IDE's terminals run it): node commands, page programs (`node`, `npm`,
`npx`, `git`, `claude`, …), coreutils.

- **Without `tty`:** pipes. Its input as it comes (`write`), then its end
  (`closeStdin`); its stdout and stderr apart, through brush, its children,
  a node's `standard_error`, page programs and Node.js's `child_process`
  (below); its exit status.
- **With `tty`:** a terminal. Keys go through a line discipline in
  `embed.html` (echo, editing, Ctrl+C as SIGINT, raw when the program asks:
  brush's line editor, IEx, Node's `setRawMode`), as the IDE keeps it;
  stdout and stderr are one stream (a shell draws its prompt on stderr),
  and a newline is CR LF (a tty's ONLCR). `resize` is SIGWINCH. The
  terminal must answer the cursor-position query (`ESC [ 6 n`) as
  xterm.js does: brush's line editor waits for it, and starts again
  without.
- **`CLAUDE_CODE_EXECUTABLE`** is `/usr/bin/claude` in every command's
  environment, so claude-agent-acp (and the Agent SDK under it) runs the
  playground's Claude Code ([nodejs.md](nodejs.md#claude-code-claude-programsclaudeclaudets)).
  The SDK spawns a path not ending in `.js` itself, with its arguments;
  brush finds `/usr/bin/claude`'s stand-in and runs the page program.

**Ports.** `connect(port)` reaches a server the sandbox runs (as the
preview's bridge does), raw: no `Origin`, so Tidewave's `/tidewave/mcp`
answers it. `serve(port, handler)` makes the sandbox's connections to
`127.0.0.1:port` the embedder's, from a node (`:httpc`, Postgrex) or a
Node.js process (`fetch`, `net`), carried as Postgres's are
(`exec/host.ts` `apex`). A stream's messages are `{ data }`, `{ end:
true }` and `{ close: true }` (`runtime/portConnection.ts`).

**The preview.** `previewOrigin(port)` makes the port's relay frame and
answers its origin, `https://v-ID-PORT.USERCONTENT`; the embedder frames
it itself (Tidewave: `${origin}/tidewave?entrypoint=inner`). The
embedder's frame and the relay are both under the embedder's top-level
site, so the browser gives them one storage partition and the relay's
service worker answers the embedder's frame (checked in Chromium,
Firefox and WebKit). The bridge takes the embedder's origin for the
IDE's: the app's `frame-ancestors` take it, and the preview's first
frame tells it where it is (`playground-location`) and answers
`playground-snapshot`.

### The handshake and versions

1. `embed.html` posts `{ kind: 'run-elixir-embed-loaded', apiVersions }`
   to its parent (it says nothing else).
2. `embed.js` answers `{ kind: 'run-elixir-embed', apiVersion }` with a
   MessagePort. `embed.html` takes it only from its parent, from an origin
   the site names, and once.
3. Over the port, calls and events as `shared/lib/rpc.ts` has them;
   `hello` answers `{ apiVersion, apiVersions, runtime }`.

The API grows by adding calls, options, fields and events, never by
changing them: `embed.js` comes from a stable URL (no-cache), but an
embedder's page may stay open across a deploy, with the older client
and the newer `embed.html`. A breaking change would be apiVersion 2,
with 1 still answered.

**The runtime's versions** are the contract for an embedder's code:
OTP 29.1.2 and Elixir 1.20.4 (`r/RID/runtime.json`, written by
`build.py` from the installation). An embedder's `.beam` files compiled
natively with that pair run on any later build of it. `create()` fails
(`ERUNTIME`) when the deployed runtime is another. Older builds and
runtimes (`b/ID/`, `r/RID/`) need not stay online for embedders.

## Who may embed it

The site names its embedders: `PLAYGROUND_EMBEDDERS` (space-separated
origins) when building, by default `https://tidewave.ai
https://tidewave.steffend.me http://localhost:4000`, written to
`playground.json` (`embedders`). They are in `embed.html`'s
`Content-Security-Policy: frame-ancestors`, which keeps every other site
from framing it, and `embed.html` takes a client only from one of them.
`serve.py --embedders "…"` overrides the list (the tests add
`http://embedder.localhost:PORT`). Caddy's `frame-ancestors` names the
same origins (below): change both. The deploy takes the repository's
variable `PLAYGROUND_EMBEDDERS` (empty: the default).

What the list protects is mostly not the users' data: storage is keyed by
the top-level site, so an embedder sees only what was done in its own
page. It keeps others from building on the site's bandwidth, its proxies
and its NIF builds, it is in place before the apex has a login (whose
session another site must not drive), and it says whose pages a change
of the API could break.

**The proxies** (`/hex/`, `/git/`, `/api/nif/`) refuse a browser's
request from another site's page (`Sec-Fetch-Site: cross-site`):
`serve.py` and Caddy. That keeps them from being any site's through its
visitors' browsers (which could not read the answers anyway); it is no
boundary for other clients, which send what they like. Rate limits would
be the next step.

## Storage

`embed.html` is framed by another site, so the browser keeps its
IndexedDB, Cache Storage and service workers apart for each embedding
site (Chromium, Firefox and WebKit partition by top-level site), and
apart from run-elixir.dev's own projects. With `persist`, the project's
changes below `/work` and `/home` (so `~/.claude`'s credentials from
`claude /login` and its session transcripts for `session/load`, and
`~/.npm/_npx`'s installed agent) and its Postgres are kept there, under
the project's key (the embedder's `id`, hashed to ten letters and
digits). The claude frame's cache of Claude Code is likewise one per
embedding site.

## Projects from an archive

`project: { archive: url }` starts from an app the embedder built:
a gzipped tar whose top directory (`demo/`) becomes `/work/demo`
(`sandbox.root`), laid into the shared files as a template is (its
files kept in memory, its changes kept over it with `persist`), mtimes
kept, so Mix finds its build current. The project also unpacks the
Phoenix server's boot image, for OTP's and Elixir's files the server
reads; the playground's own template is not mounted. No recording is
needed: what the app reads comes from the archive at once.

What the embedder builds (`tests/embed-archive.sh` does it in Docker):

- the app compiled natively with the runtime's OTP and Elixir
  (hexpm/elixir's image of them), `deps/` and `_build/dev` in the tar;
- **at `/work/APP`**, the path it has in the playground: Mix records the
  app's absolute path, and elsewhere compiles the app's own sources again
  at its first start (15 files of a new Phoenix app, ~2 s more; its
  dependencies stay as they are);
- its assets built (`priv/static`); the native `_build/esbuild-*` and
  `_build/tailwind-*` left out (the playground runs its own);
- git dependencies' `.git` without objects (config, HEAD, refs, an empty
  `objects/info/packs`: what Mix's lock check reads), as the template's;
- the Repo on database `postgres` with `pool_size: 1` (PGlite is one
  session).

The tar is fetched by the exec frame (the usercontent domain), so its
server must answer with CORS (`Access-Control-Allow-Origin`). A Phoenix
app with Tidewave, so built: 15 MB gzipped.

## Headers

**The embedder** serves its page cross-origin isolated (COOP
`same-origin`, COEP `require-corp`); `embed.js`'s frame asks for
`allow="cross-origin-isolated"` (Chromium), and `embed.html` asks the
same of its frames. Each nested frame is a pixel on the screen, unseen
(`execFrame.ts` `unseen`, inline styles: `embed.html` has no
stylesheet), not `hidden`.

**run-elixir.dev** answers `embed.html` with
`Cross-Origin-Resource-Policy: cross-origin`, `Cross-Origin-Embedder-
Policy: require-corp` and `Content-Security-Policy: frame-ancestors
EMBEDDERS`, and `embed.js` with CORP `cross-origin` and
`Access-Control-Allow-Origin: *` (an embedder's page imports it as a
module). The usercontent domain does not serve `embed.html`. Caddy:

```caddy
(apex) {
	header {
		Cross-Origin-Opener-Policy same-origin
		Cross-Origin-Embedder-Policy require-corp
	}
	@own not path /embed.html /embed.js
	header @own Cross-Origin-Resource-Policy same-site
	# embed.html, framed by the embedders (PLAYGROUND_EMBEDDERS), and
	# embed.js, which their pages import (docs/embed.md).
	@embed path /embed.html
	header @embed {
		Cross-Origin-Resource-Policy cross-origin
		Content-Security-Policy "frame-ancestors https://tidewave.ai https://tidewave.steffend.me http://localhost:4000"
	}
	@embedjs path /embed.js
	header @embedjs {
		Cross-Origin-Resource-Policy cross-origin
		Access-Control-Allow-Origin *
	}
}

# The proxies refuse another site's pages (Sec-Fetch-Site). A handle,
# imported first in each site: handle blocks are tried in the order they
# appear, and a bare respond would run after all of them.
(proxies) {
	@crosssite {
		path /hex/* /git/* /api/nif/*
		header Sec-Fetch-Site cross-site
	}
	handle @crosssite {
		respond 403
	}
}

run-elixir.dev, *.run-elixir.dev {
	…
	import proxies
	@backend path /api/nif/* /socket /socket/*
	…
}

*.run-elixir-usercontent.org {
	…
	import proxies
	handle /embed.html {
		respond 404
	}
	@backend path /api/nif/*
	…
}
```

`playground-deploy`'s check fails a release whose `embed.html` is not
CORP `cross-origin` with a `frame-ancestors`, or whose `embed.js` has no
CORS ([deploy.md](deploy.md)).

## What Tidewave maps onto it

| Tidewave's CLI | Here |
| --- | --- |
| `/read`, `/write`, `/stat`, `/listdir`, `/mkdir`, `/delete`, `/copy`, `/move`; `watch:` | `fs.*`; `fs.watch` |
| `/cmd`, `/shell`, `/which` | `spawn(line)` without a tty: stdout, stderr, status |
| `terminal:` | `spawn(null or line, { tty })`, raw keys in, PTY output out |
| ACP proxy | `spawn('npx -y @agentclientprotocol/claude-agent-acp@0.85.1')`, newline-delimited JSON-RPC on stdin/stdout, its logs on stderr |
| reverse MCP bridge (`127.0.0.1:9832/socket/mcp-remote-client`) | `serve(9832, …)`: a tiny HTTP/1.1 server on the stream |
| the app's `/tidewave/mcp`, `/config`, `/upload` | `connect(4000)`, raw HTTP |
| the agent's own MCP (`localhost:4000/tidewave/mcp`) | inside the sandbox, as any connection |
| the app frame | `previewOrigin(4000) + '/tidewave?entrypoint=inner'` |

## Measurements (2026-10-23)

Playwright 1.64 in Docker, the site and the embedder on `*.localhost`
(serve.py, no network latency), each test a new browser profile:

| | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| `create()`, Phoenix template, cold profile | 0.53–0.55 s | 0.59–0.74 s | 0.51–0.55 s |
| `create()` again, kept project (same profile) | 0.47–0.49 s | 0.55 s | 0.48 s |
| `mix phx.server` running, template, cold | 5.3 s | 2.8 s | 4.4–4.7 s |
| the same, kept project, warm | 3.6 s | 3.0 s | 3.3 s |
| `create()` from the archive (15 MB) | 0.85–0.87 s | 0.99 s | 0.97 s |
| the archive's `mix phx.server` running (nothing compiled) | 5.5 s | 3.1 s | 5.7 s |
| claude-agent-acp: `initialize` answered after spawn (npx's install) | ~15 s | | |
| `initialize` + `session/new`, first run (Claude Code fetched and prepared) | 53–60 s | 68 s | 61 s |
| `session/prompt` against a mock API (a Bash tool, permission asked) | 1.1–1.2 s | 1.2 s | 1.7 s |

"Cold" is a new browser profile, so nothing in the HTTP cache, but on
localhost: over a network, a first visit also downloads the boot images
and bundles (tens of MB) and Claude Code (125 MB). Of `session/new`'s
time, about 40 s is the claude frame preparing Claude Code (as in the
IDE, [nodejs.md](nodejs.md#claude-code-claude-programsclaudeclaudets)),
once per embedding site; the Agent SDK also waits 5 s for a `claude auth
status` that does not answer in time.

`embed.html`'s frames are two levels deep (embedder → embed.html → exec
frame and its workers). No throttling showed in any of the three
browsers: the frames are a pixel on the screen, and what runs is in
workers.

## Tests

`embed.spec.ts`, against the test embedder (`app/test/embed/index.html`,
served by `serve.py --embedder-host embedder.localhost:PORT`, its own
site, cross-origin isolated):

- a Phoenix project: files, a command, its server over a raw
  `connect(4000)`, its preview framed by the embedder (its text by the
  bridge's snapshot in Firefox);
- commands: stderr apart (brush, Node.js, its `child_process`, a node), a
  program not found, input as it comes, SIGTERM, an interactive shell on a
  terminal, `serve(9832)` from a Node.js process and from a node;
- claude-agent-acp over pipes against a mock API: `initialize`,
  `session/new`, `session/prompt` with a Bash tool through a permission
  request;
- an archive built by `tests/embed-archive.sh` (skipped without it):
  booted without compiling, Tidewave's `/tidewave/config` and MCP
  `tools/list`;
- another site cannot frame `embed.html`; a runtime mismatch is refused;
- a kept project's files and `~/.claude` after a reload.

## Not yet

- **A real Safari**: Playwright's WebKit runs all of this; Safari's own
  rules for a frame of another site (ITP, storage partitioning of a
  nested frame of a third site) are not checked, nor a phone.
- **Tidewave's side**: the browser shim of its CLI and the `/web` route.
- **`fs.watch`'s kinds**: a change says only whether the path is there
  now (`changed`) or not (`deleted`); a rename is the two.
- **An archive's updates**: kept changes lie over whatever the URL now
  serves; a new archive for a kept project is the embedder's to version
  (a new `id`, or `fs` writes).
- **Sizes over a network**: the boot images and bundles (tens of MB) and
  Claude Code's 125 MB come from the network on a profile's first run;
  the measurements above are on localhost.
