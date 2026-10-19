---
kind: reference
status: live
last_updated: 2026-10-18
---

# The runtime (`app/src/runtime`)

The site's runtime, in TypeScript, as part of the app: one `tsconfig`,
oxlint and oxfmt (`npm run lint`, `format:check`), erasable syntax only
(no enums or namespaces). The app's Vite build bundles it
([build.md](build.md#steps)). The page's parts (`host/`, `bridge.ts`, …)
go into the app, which imports them as `@/runtime/…`. The scripts that
load by URL go into the build as entries of their own, under their
names: `worker.js` (`worker/index.ts`) and `files.js` (what they share in
`chunks/`), and `sw.js`, at the site's root. `node.ts` is
bundled for Node, as `node.mjs`.

**The WASI calls stay cheap** (NIF libraries'). The calls are closures, built once per
node (`functions()`, `sharedCalls`, `positioned`) and wrapped once in
`unsigned()`; classes declare their fields (`declare`), so types add no
code, and a call goes through no more functions than it did as
JavaScript.

| File | Runs in | Role |
| --- | --- | --- |
| `wasi/` | worker, Node | The node's tree and network, and WASI preview 1 for NIF libraries. `index.ts`: the shim (`WASI`) and the calls on the process; `descriptors.ts`: the calls on the node's own files and the host's (`/.proc`, `/.tty`, `/.nif`, `/.net`); `shared.ts`: the client for shared files and the calls on them; `positioned.ts`: `fd_pread`, `fd_pwrite`, `fd_tell`; `fs.ts`: the in-memory filesystem, lazy files, tars, `/dev/urandom`; `net.ts`: TCP (`Network`); `process.ts`: programs and the terminal; `abi.ts`: errnos, flags and the calls' signatures. |
| `worker/` (`worker.js`) | worker | A node. `index.ts` unpacks the boot images and runs one command or the shell, each node through `beam.ts`; `channel.ts` takes in the page's frames and runs the page's programs; `nif.ts` fetches NIF libraries (the site's, the backend's). |
| `files.ts` (`files.js`) | worker | The shared filesystem (`/work`, `/tmp`), and keeping a project's changes. |
| `overlay.ts` | worker | A project's kept changes in IndexedDB. |
| `host/` | page | `node.ts`: `Node` (start, type into, interrupt, connect to a node); `programs.ts`: the node's programs that run on the page; `files.ts`: `Files` (the shared filesystem from the page). |
| `setup.ts` | worker, Node | What every node gets: environment, files around the installation, programs. |
| `coreutils.ts` | worker | uutils coreutils' tools (`coreutils.wasm`): the shell's commands, a node's programs by name (on `PATH`), and a node's `sh -c` around them. |
| `sh.ts` | worker, page | Command lines split into words and `&&`-joined commands. |
| `programs.ts` | worker, Node | `git` (as far as Mix asks), `make` (a package's NIF library built to WebAssembly, the site's or the backend's), and stubs for `esbuild` and `tailwind` (the page's replace them; the Node harness keeps them). |
| `nif.ts` | worker, Node | NIF libraries built to WebAssembly, each in an instance beside the node. |
| `vfs.ts` | worker, Node | Files for code beside the node (shell builtins, programs): local and shared paths as one. |
| `terminal.ts` | page | A shell's line discipline, one per shell (the project's, not each xterm.js's): keys in, echo into the shell's output. Cooked: echo, editing, history (seeded with the lines the shell ran first), pastes, Ctrl+C; tab and other control keys are dropped. Raw while the node asks for it (IEx's line editing): keys go through as typed, Ctrl+C still interrupts. |
| `sw.ts` (`/sw.js`) | service worker | Sends a preview's requests to its project's page. |
| `https.ts` | page | HTTPS for the node by `fetch()`: answers each HTTP/1.1 request on an HTTPS connection with a fetch of `https://NAME[:PORT]/path`. |
| `bridge.ts` | page | Sends them on to the node as HTTP/1.1, with the app's cookies; carries the preview's WebSockets. |
| `postgres.ts` | page | Postgres wire protocol to PGlite. |
| `fetcher.ts` | page | Plain HTTP from the node, answered with the page's `fetch()` (Hex). |
| `beam/`, `worker/beam.ts` | worker, Node | The node: OTP's own emulator built with Emscripten ([`../beam/README.md`](../beam/README.md#in-the-playground)): `run.ts` starts a node (the tree and the shared files through PROXYFS: `treefs.ts`, `sharedfs.ts`; TCP, ports, NIFs, the terminal); `args.ts` turns erl's arguments into the emulator's; `worker/beam.ts` runs it in the node's worker, which serves its threads and takes the page's frames as they come. |
| `node.ts` (`node.mjs`) | Node | The Node harness: the node without a browser ([build.md](build.md#the-node-harness-srcruntimenodets)). `build.py` and `serve.py`, on the build machine, are in `runtime/`. |

## The node's tree and WASI (`wasi/`)

The Emscripten BEAM mounts the node's tree through PROXYFS
(`beam/treefs.ts` over `fs.ts`) and the shared directories through
`beam/sharedfs.ts` ([../beam/README.md](../beam/README.md#in-the-playground)).
NIF libraries ([nif.md](nif.md)) get WASI preview 1 over the same tree:
`new WASI({...}).imports` provides it but `fd_renumber`, `sock_recv` and
`sock_send` (a library importing one gets ENOSYS from `nif.ts`), with
`fd_pread`, `fd_pwrite` and `fd_tell` on top of the descriptor's
position (kept by the call; a write at an offset does not append),
`fd_allocate`, `clock_res_get` (1 µs), `proc_raise` (the program ends,
128 + the signal), and `fd_datasync`, `fd_advise`,
`fd_fdstat_set_rights` and the `*_filestat_set_times` calls, which do
nothing.

- **Filesystem.** `Dir`, `File` and `Symlink` objects under one root,
  `/`. Hard links are the same `File` under two names (Mix's lock takes
  one). Errors are WASI errno numbers (`treefs.ts` names them for
  Emscripten).
- **Symbolic links:** `lookup()` follows the ones in the middle of a
  path, and a last one when the call says to (`stat` and `open` do,
  `lstat` and `O_NOFOLLOW` do not); a relative target is read from the
  link's directory, `..` is the physical parent, and 40 links in a row are
  `ELOOP`. The shared files (`files.js`) resolve the same way and keep a
  link as a record of its own (overlay.ts); a change is kept by its path
  with the links on the way resolved, and laying the records back makes
  what a dangling link names, as a link can sort before it; the page's requests follow
  links but for removing and renaming. A link and what it names stay on
  one side, the shared directories (`/work`, `/tmp`) or a node's own: a
  path goes to one or the other by its prefix. Mix links a build's `priv`
  to the project's, as natively, so Phoenix serves new assets at once and
  no longer warns.
- **Terminal.** Popcorn's prim_tty over JS (patches 0011, 0017): the node
  reports raw or cooked input (`onTtyMode`), worker.js tells the page (a
  `tty` message; back to cooked when the node ends) and passes on the size
  the page sends in RESIZE frames. IEx edits its own lines: tab
  completion, its history, line wrapping by the terminal's width.
- **Lazy files.** `mount(manifest, root)` lists files without their bytes.
  `load(node, fetch)` fetches one the first time it is opened, with
  `fetch(source, bundle)`. `bundled(get)` turns a synchronous bundle getter
  into that `fetch`: a miss loads the file's whole bundle (a tar), and its
  other files wait in memory until they are opened.
- **mtimes.** Untarred and mounted files keep their modification times, so
  Mix sees sources older than its manifests.
- **`/dev/urandom`** is a `Device` over `crypto.getRandomValues`.

### TCP (`net.ts`)

`gen_tcp` runs over our `prim_socket` NIF (`beam/socket`) over `Network`,
which keeps listeners and connections. A connect reaches the node's own
listener, or a port the page serves (`remote.ports`, for example 5432);
else ECONNREFUSED. Connections from the page have odd ids and the node's
own even ones. `remote.listening(port, on, ephemeral)` reports listeners
to the page; a listener is ephemeral when it asked for port 0. HTTPS that
the page carries (`remote.https`): `ssl:connect` to a host name connects to
a gateway port whose first line names the host, and the connection is
then plain HTTP/1.1 to the page (patch 0020); without it the node's `ssl`
does TLS itself.

### Programs (`process.ts`)

A port's program (`open_port`'s `{spawn, Command}`, `System.cmd`) runs
through `Module.beamSpawn` (`beam/host`). It is looked up by its base
name, then by the part before the first `-` (so
`_build/tailwind-linux-x64-4.3.3` is `tailwind`). A program is
`(process, { args, cwd, env }) => …` that writes to and exits its
`Process`; closing the port calls `process.onclose`. No program by that
name means ENOENT, which the node reports as `enoent`.

### NIF libraries

`erlang:load_nif` of a library built to WebAssembly (patch 0021,
`beam/host/wasm_nifs.c`) asks `nifs.js`, which hands its bytes to
`nif.ts` (`Nifs`): an instance of its own with a WASI of its own over the
node's files and environment, run synchronously on the module's main
thread. Requests and answers are external terms ([nif.md](nif.md)); a
library that trapped or exited is gone.

### Shared files

With `shared: { prefixes, call }`, the calls on paths under the prefixes
(`/work`, `/tmp`) go to `files.js` instead of the local tree. This covers
`path_open`, `path_filestat_get`, `path_create_directory`,
`path_remove_directory`, `path_unlink_file`, `path_rename`, `path_link`,
and `fd_read`, `fd_write`, `fd_seek`, `fd_filestat_get`,
`fd_filestat_set_size`, `fd_allocate`, `fd_fdstat_get`, `fd_readdir` and
`fd_close` on what they opened (and so `fd_pread`, `fd_pwrite` and
`fd_tell`). A rename or link between a shared and a local path is EXDEV.
Reads and writes move at most 512 KB per call.

`sharedClient(doorbell, channel)` is `call`. The channel is a
SharedArrayBuffer of 8 + 1 MiB:

- `control` is `Int32Array(channel, 0, 2)`: `control[0]` is 0 when idle, 1
  with a request in it, 2 with an answer; `control[1]` is the data's length.
- The data, at offset 8, is a request or an answer: a little-endian u32
  header length, a JSON header, then bytes.
- The client writes a request, sets `control[0]` to 1, increments and
  notifies the shared doorbell (a 4-byte SharedArrayBuffer), and waits until
  `control[0]` leaves 1.

`files.js` answers every channel whose `control[0]` is 1. It waits on the
doorbell (5 ms at a time, at most 20 ms), then yields to its event loop so
that the page's messages get in. Requests are `stat`, `open` (handle, type,
size), `read` and `write` (by handle and offset, or append), `truncate`,
`fstat`, `readdir`, `close`, `mkdir`, `rmdir`, `unlink`, `rename` and
`link`. Errors are errno numbers. Closing a written file, and every
directory change, is reported to the page as `{ kind: 'changed', paths }`,
at most every 200 ms.

**Starting.** The page's `start` message names the boot images to unpack
(`boots`), the directories below `/work` the project starts with
(`template`, from the manifest and the images), and `store`, the IndexedDB
database of the project's changes. With a store, `files.js` lays the kept
records over the template (`overlay.ts`), and writes the changed paths
below `/work` a second after they change, in one transaction
([projects.md](projects.md#what-is-kept)). A write that fails is reported
to the page as `{ kind: 'warning', message }`.

## coreutils (`coreutils.ts`)

uutils coreutils 0.12.0, Rust's rewrite of GNU's (Ubuntu's since 25.10),
built for `wasm32-wasip1` with its own WASI feature set
(`coreutils/build.py`): one module, 89 tools, its first argument naming the
tool, as BusyBox does. BusyBox itself needs `fork`, which WASI lacks. The
one patch has it change to `$PWD` first, as WASI has no working directory.

A worker fetches and compiles it when a tool first runs (140 ms in
Chromium, 200 in WebKit, 470 in Firefox, from the HTTP cache after that). Each run is an
instance of its own over the node's tree and the shared files (`wasi/`),
run to its end on the caller's thread: the shell's, or the node's for a
port, which waits for it, as for any quick command. So a tool gets the
input that is there when it starts and then its end, and runs nothing
that waits for more (`tail -f`, an interactive `sort`).

- **The shell** runs a tool for a command it does not have itself (`cd`,
  `pwd`, `echo`, `help`, `clear` stay its own); without `coreutils.wasm`,
  its old `ls`, `cat`, `mkdir` and `rm` answer.
- **A node** finds the tools on `PATH` (`/usr/bin`) and spawns them by
  name: `System.cmd("rm", ["-rf", "c"])`.
- **`sh -c LINE`** with a tool in it runs here: the tools, `cd`, and each
  node command (`mix`, …) through the page's `sh` on its own, in order while
  they succeed. A line without a tool is the page's `sh`'s alone.

Not yet: pipes, redirections, `;` and `||`, globs and `$VAR` in either
shell; `os:cmd`'s `sh -s` (its line on standard input); `grep`, `sed`,
`find` and `awk`, which are not coreutils; file modes and owners, which
WASI does not have (`chmod`, `ls -l`'s columns).

## Page and node (`host/`, `worker/`)

`new Node({ base, files, serve, programs, onoutput, onstatus, onexit,
onlistening })` starts a worker. It is a blob module that imports
`worker.js`: Firefox does not start a module worker from a page its service
worker controls, and a blob worker takes the page's cross-origin isolation.
`node.start({ shell, initial, cwd, args, command, env, boots })` boots it:
the shell with `initial` commands typed first, or one command (erl's
`args`, or a `command` by name as the shell runs it, such as `['mix',
'deps.get']` or `['escript', FILE, ...]`), over the boot images `boots`
(default `['boot']`).

**Page → node: frames** in a SharedArrayBuffer ring of 1 MiB:

- each frame is `[kind u8][id u32][length u32][payload]`, little-endian;
- `control[0]` counts bytes written and `control[1]` bytes read;
- the worker sleeps on `control[0]`, so a frame wakes it;
- the page queues frames the ring has no room for, and retries every 2 ms.

| Kind | Frame |
| --- | --- |
| 0 `INPUT` | Standard input. |
| 1 `OPEN` | The page connects (id) to a port (payload: u16, big-endian). |
| 2 `DATA`, 3 `END`, 4 `CLOSE` | A connection's data, end, close. |
| 5 `INTERRUPT` | Ctrl+C: stop the running node. |
| 7 `OUTPUT`, 8 `EXIT` | A page program's output and exit code (u8). |

**Node → page: messages.**

| Message | Meaning |
| --- | --- |
| `out` | Terminal output (bytes). |
| `status` | Loading progress, then `running`. |
| `exit` | The command's exit status (one-command mode). |
| `net` | Connection traffic: `open`, `data`, `end`, `close` and `refused`, by id. |
| `listening` | The node started or stopped listening on a port (`ephemeral`: one it asked for with 0). `Node.listening` holds every port, `Node.serving` the named ones. |
| `spawn`, `kill` | Start a page program, or tell it its port closed. |
| `nif` | `make` waits for the backend to build a package's NIF library, or stopped waiting: `{ name, version, status, error }` (`onnif`; [nif.md](nif.md#in-the-node)). |

`https: (connection, { host, port }) => …` answers the node's
HTTPS connections; the playground's is `https.ts`'s
`httpsByFetch()`. It reads requests with a body (Content-Length or
chunked) and answers each with `fetch()`: the browser does TLS, checks the
certificate, follows redirects, decompresses, and leaves out request
headers it sets itself (Host, User-Agent, Cookie, Accept-Encoding) and
response headers the site does not expose; the answer comes back chunked,
as it arrives, and the connection closes after it. A site without CORS
headers fails the fetch, answered 502 with why. Without `https`, the node
has no HTTPS.

`node.connect(port)` gives a connection to the node's listener: `ondata`,
`onend` and `onclose`, with `write`, `end` and `close`. `serve: { port:
handler }` answers the node's connections to those ports (5432: PGlite).

**Page programs.** `programs: { name: (process, { args, cwd, env, fs }) => …
}` run on the page and may be async. `process.write`, `process.exit` and
`process.onkill`. `fs` is the shared `Files`.

`new Files({ base, boots, template, store, onchange, onwarning })` starts
`files.js` from the site's boot images and manifest (only the shared paths
and the template). It offers `list`, `stat`, `read`, `write`, `mkdir`,
`remove`, `rename`, `search` and `flush` (write the pending changes now)
for the page, and `connect()`, which makes a node's channel. `search(path,
query, skip, limit)` finds a text or a regular expression (of any case, or
this one) in the files below `path`, in the worker (`runtime/search.ts`):
files over 1 MiB or with a NUL in their first 8 KiB are skipped, hits come
in the order of the paths, each with its line and column and a piece of
the line from a little before the match, at most `limit` (1000) of them.

## The preview (`sw.js`, `bridge.ts`)

`Bridge.register(url, scope, key)` installs the service worker and
announces the page as the host of `key` (a stored project's id, a temporary
IEx's own). A page that a forced reload left uncontrolled asks the active
worker to claim it first. `Bridge.announce({ kind: 'preview', key })` is the
popped-out preview window's. Both announce again when another worker takes
over. The service worker:

- answers iframe navigations (but the site's own frames), and requests
  from the documents those made, whose ids it keeps;
- lets everything else go to the network without passing through it; until
  it has read its routes (it just started), it fetches the rest itself;
- never asks a client what it is (`clients.get`): Firefox answers that for a
  worker on the worker's thread, which a node's worker blocks in its
  synchronous request for a bundle (and that request comes here). Once the
  service worker had stopped (idle, about 30 s) and asked, the two waited on
  each other for minutes, and with them the whole node;
- routes each request by key: a document's own (taken when it was
  navigated), else that of the client its referrer names (the project page,
  the popped-out window, or the app's previous document), else the only or
  the focused host's;
- keeps which client has which key, each key's host, and the preview's
  documents in IndexedDB (`playground-sw`), so a restart keeps routing;
- answers 503 when the key's page is gone;
- adds `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Resource-Policy: same-site` to every answer, including
  errors, which the isolated page needs to frame them (on a project
  domain, from a port's origin of the same site).

`new Bridge({ connect })` answers the service worker's requests. For each
one it:

- opens `connect(bridge.port)` (the IDE sets it to the preview's port) and
  sends HTTP/1.1 with `connection: close`;
- reads the response to its end, removing chunked encoding;
- keeps HttpOnly `Set-Cookie`s in its own jar and puts the others in
  `document.cookie` (the preview's origin is the page's, so the app's
  JavaScript reads and sets them too), and sends both as `cookie`; an
  HttpOnly one replaces or expires one of its name in `document.cookie`,
  as a browser's jar would (Plug expires cookies as HttpOnly);
- injects a `WebSocket` of its own into HTML (below), and a script
  (`linkShim`) that sends the app's absolute links
  (`http://localhost:PORT/…`, as in a magic link's mail) and forms to
  their paths (through `SWITCH` for another port) as they are clicked or submitted, and keeps `_top` and
  `_parent` inside the preview (Swoosh's mailbox opens a mail's links in
  `_top`; an outside link with them opens a new tab instead of replacing
  the IDE);
- turns a redirect's `Location` at `http://localhost:PORT` into its path;
- shows one of the app's ports at a time: a request for
  `/__playground/port/PORT/path` (`SWITCH`: the path bar, a link or
  redirect to another port) switches it, tells the IDE (`onport`), and
  redirects to the path;
- answers a page that reloads every two seconds while nothing listens.

**On a project domain, a preview origin per port.** The preview shows
port PORT of the app on `v-ID-PORT.DOMAIN` (`site.ts` `previewOrigin`),
so several ports show at once (Livebook's page and its iframe endpoint's
outputs, on another port) and each is kept from the IDE's origin and
from the others':

- the IDE has a hidden `relay.html` frame on each port's origin
  (`project/lib/previewOrigins.ts`, made as a server listens there); its
  page (`frames/relay.ts`) registers that origin's service worker, is its
  host, and passes the preview's requests and WebSockets to the IDE on a
  MessagePort, with the port and the origin's `document.cookie`;
- `new Bridge({ connect }, port, origins)` with `origins`
  (`v-ID-{port}.DOMAIN`) takes each request's port from it; cookies the
  app's JavaScript may read come back to the relay to set on its origin
  (HttpOnly ones stay in the bridge's jar, one per project, as a browser
  keeps cookies whatever the port);
- links and redirects to another port go to that port's origin, not
  through `SWITCH`; a `frame-ancestors` in the app's
  `Content-Security-Policy` takes the IDE's origin too, and `X-Frame-Options:
  SAMEORIGIN` goes (Phoenix's and Livebook's say `'self'`, which the
  IDE's page stood for while it was the preview's origin);
- the preview is another origin than the IDE's, so the injected script
  tells the IDE where the preview's first frame is (`playground-location`:
  its path and port, as it loads and as it navigates, addressed to the
  IDE's origin so that a frame of the app's own tells its parent nothing),
  and reloads its stylesheets when asked (`playground-css`);
  `PreviewFrame` follows the frame to a port it went to by itself;
- a preview document's request to another of the project's port origins
  (a `fetch` there goes to the network, not to that origin's service
  worker) is answered by its own origin's service worker, through its
  relay, from that port: the request stays cross-origin, so the app's
  CORS answers it (Livebook fetches its iframe page from 8081 to check
  its checksum);
- the scripts go into documents only (`destination` document, iframe or
  frame), not into HTML fetched as data;
- every node has `PLAYGROUND_PREVIEW_ORIGIN` (the origins, with `{port}`)
  and `LIVEBOOK_IFRAME_URL` (Livebook 0.19's iframe page on 8081's
  origin; another version of it sets its own).

Without a project domain (and in Safari's one-origin fallback, and a live
session's guest), the preview stays the page's origin and shows one port
at a time.

**WebSockets.** A service worker sees no WebSocket connection. The
injected `WebSocket` (the browser's API: `onopen`/`onmessage`/`onclose`,
`send`, `close`, `binaryType`, the state constants) sends
`{ kind: 'websocket', path, protocols }` with a MessagePort to the service
worker, which passes it to its project's page. There `Bridge.websocket`
connects to the app, sends the opening handshake (with the cookies and an
`origin` of `http://localhost:PORT`), and after `101` speaks RFC 6455:
client frames masked, fragments joined, pings answered with pongs, close
answered. The port carries `{ send }`/`{ close }` in and
`{ open }`/`{ message }`/`{ close }` out.

## Postgres (`postgres.ts`)

`postgres(database)` is a connection handler for `serve`; `database()`
gives the PGlite (a promise), asked for on the first message. It buffers bytes into
whole messages (the untyped startup message first), and answers SSLRequest
and GSSENCRequest with `N`. Each batch goes to `db.execProtocolRaw`, in
order, and the bytes come back. Terminate closes the connection.

PGlite is one session, which every node's connections share, so they take
turns: a connection that leaves it in a transaction holds it until a
ReadyForQuery says idle. A transaction idle for a second lets waiting
connections of a holder's node join it (Ecto's migrator holds its lock on
one connection and migrates on another), not another node's: its unnamed
statement would replace a holder's between Parse and Bind. A connection
between a Parse and its Sync holds the session alone.
