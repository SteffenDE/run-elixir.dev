---
kind: reference
status: live
last_updated: 2026-10-15
---

# The runtime (`playground/app/src/runtime`)

The site's runtime: JavaScript modules, which the app's Vite build
bundles ([build.md](build.md#steps)). The page's parts (`host.ts`,
`bridge.ts`, …) go into the app. The scripts that load by URL go into the
build as entries of their own, under their names: `worker.js`, `files.js`
and `thread.js` (what they share in `chunks/`), and `sw.js`, at the
site's root. `node.mjs` is bundled for Node.

| File | Runs in | Role |
| --- | --- | --- |
| `wasi/` | worker, Node | WASI preview 1 for `rotp.wasm`. `index.ts`: the shim (`WASI`) and the calls on the process; `descriptors.ts`: the calls on the node's own files and the host's (`/.proc`, `/.tty`, `/.nif`, `/.net`); `shared.ts`: the client for shared files and the calls on them; `positioned.ts`: `fd_pread`, `fd_pwrite`, `fd_tell`; `fs.ts`: the in-memory filesystem, lazy files, tars, `/dev/urandom`; `net.ts`: TCP (`Network`); `process.ts`: programs and the terminal; `abi.ts`: errnos, flags and the calls' signatures. |
| `worker.js` | worker | A node: boots `rotp.wasm`, runs one command or the shell, pumps the page's frames. |
| `files.js` | worker | The shared filesystem (`/work`, `/tmp`), and keeping a project's changes. |
| `overlay.ts` | worker | A project's kept changes in IndexedDB. |
| `host.ts` | page | `Node` (start, type into, interrupt, connect to a node; page programs) and `Files` (the shared filesystem from the page). |
| `setup.ts` | worker, Node | What every node gets: environment, files around the installation, programs. |
| `programs.ts` | worker, Node | `git` (as far as Mix asks), `make` (a package's NIF library built to WebAssembly, the site's or the backend's), and stubs for `esbuild` and `tailwind` (the page's replace them; the Node harness keeps them). |
| `nif.ts` | worker, Node | NIF libraries built to WebAssembly (`/.nif`), each in an instance beside the node. |
| `vfs.ts` | worker, Node | Files for code beside the node (shell builtins, programs): local and shared paths as one. |
| `terminal.ts` | page | The line discipline over xterm.js. Cooked: echo, editing, history (seeded with the lines the shell ran first), pastes, Ctrl+C; tab and other control keys are dropped. Raw while the node asks for it (IEx's line editing): keys go through as typed, Ctrl+C still interrupts. |
| `sw.js` | service worker | Sends a preview's requests to its project's page. |
| `https.ts` | page | HTTPS for the node by `fetch()`: answers each HTTP/1.1 request on a `/.net/https` connection with a fetch of `https://NAME[:PORT]/path`. |
| `bridge.ts` | page | Sends them on to the node as HTTP/1.1, with the app's cookies; carries the preview's WebSockets. |
| `postgres.ts` | page | Postgres wire protocol to PGlite. |
| `fetcher.ts` | page | Plain HTTP from the node, answered with the page's `fetch()` (Hex). |
| `node.ts` (`build.py`, `serve.py` in `playground/runtime`) | build machine | See [build.md](build.md) and [testing.md](testing.md). |

## WASI (`wasi/`)

`rotp.wasm` imports 33 functions from `wasi_snapshot_preview1`: args,
environ, clock, random, `poll_oneoff`, `proc_exit`, the `fd_*` calls, the
`path_*` calls, and `sock_accept` and `sock_shutdown`, which are refused.
`new WASI({...}).imports` provides them, and the rest of preview 1 for NIF
libraries ([nif.md](nif.md)) but `fd_renumber`, `sock_recv` and
`sock_send` (a library importing one gets ENOSYS from `nif.ts`):
`fd_pread`, `fd_pwrite` and `fd_tell` on top of the descriptor's
position (kept by the call; a write at an offset does not append),
`fd_allocate`, `clock_res_get` (1 µs), `proc_raise` (the program ends,
128 + the signal), and `fd_datasync`, `fd_advise`,
`fd_fdstat_set_rights` and the `*_filestat_set_times` calls, which do
nothing:

- **Filesystem.** `Dir`, `File` and `Symlink` objects under one preopen,
  `/`. wasi-libc turns every path into one relative to it. Hard links are
  the same `File` under two names (Mix's lock takes one). Errors are WASI
  errno numbers.
- **Symbolic links** (`path_symlink`, `path_readlink`): `lookup()`
  follows the ones in the middle of a path, and a last one when the call's
  `LOOKUP_SYMLINKS` flag says to (wasi-libc's `stat` and `open` set it,
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
- **Terminal.** With `tty: true`, the standard streams are character devices
  without seek or tell rights, which is wasi-libc's test for `isatty`. The
  node then treats them as a terminal (colours, IEx's prompt).
- **Raw input** (`/.tty`, with a `terminal`): the node writes `raw` or
  `cooked` to `/.tty/mode`, and reads `/.tty/size` as `COLUMNS ROWS`
  (`tty.rs`). worker.js tells the page of a mode change (a `tty` message;
  back to cooked when the node ends) and keeps the size the page sends in
  RESIZE frames. With TERM=xterm-256color and the entry at
  `/usr/share/terminfo/x/xterm-256color`, IEx edits its own lines: tab
  completion, its history, line wrapping by the terminal's width.
- **Standard input** is a callback. It answers bytes, `null` when nothing is
  waiting (EAGAIN: the node polls again) or an empty array at its end.
- **Sleep.** `poll_oneoff` with a clock calls `sleep(ms)`. The worker sleeps
  on its frame ring, so a frame wakes it. Every read, sleep and clock read
  first calls `pump()`, which takes in the page's frames, and an interrupt
  throws from there.
- **Lazy files.** `mount(manifest, root)` lists files without their bytes.
  `load(node, fetch)` fetches one the first time it is opened, with
  `fetch(source, bundle)`. `bundled(get)` turns a synchronous bundle getter
  into that `fetch`: a miss loads the file's whole bundle (a tar), and its
  other files wait in memory until they are opened.
- **mtimes.** Untarred and mounted files keep their modification times, so
  Mix sees sources older than its manifests.
- **`/dev/urandom`** is a `Device` over `crypto.getRandomValues`.

### TCP: `/.net`

The node's sockets (`crates/rotp/src/host/wasm_net.rs`) are files that
`path_open` recognises:

| Path | Meaning |
| --- | --- |
| `/.net/listen/IP/PORT` | Listen (`PORT` 0: any free port). The file's size is the port; each read gives one waiting connection as `ID IP PORT`, or EAGAIN. |
| `/.net/conn/ID` | That connection. |
| `/.net/connect/IP/PORT` | Connect: to the node's own listener, or to a port the page serves (`remote.ports`, for example 5432); else ECONNREFUSED. |
| `/.net/https/NAME/PORT` | HTTPS to NAME that the page carries (`remote.https`): a connection to the page whose bytes are plain HTTP/1.1; else ENOENT, and the node's `ssl` does TLS itself. |

A connection's reads return what the peer sent: EAGAIN while it has sent
nothing, 0 once it has ended. Writes go to the peer, truncating the file
ends this side's output, and closing it closes the connection. `Network`
keeps listeners and connections. Connections from the page have odd ids and
the node's own even ones. `remote.listening(port, on, ephemeral)` reports listeners to
the page; a listener is ephemeral when it asked for port 0.

### Child processes: `/.proc/spawn`

`crates/rotp/src/host/wasm_proc.rs` opens `/.proc/spawn` and writes one
request. It is NUL-terminated fields: program, working directory, argument
count, the arguments, variable count, `NAME=VALUE` variables. After that the
file is the process:

- reads give its output (EAGAIN while there is none, 0 at its end);
- writes go to its input, and truncating the file closes the input;
- its size is 0 while it runs and the exit status + 1 once it has exited.

The program is looked up by its base name, then by the part before the first
`-` (so `_build/tailwind-linux-x64-4.3.3` is `tailwind`). A program is
`(process, { args, cwd, env }) => …` that writes to and exits its `Process`.
Closing the port calls `process.onclose`. No program by that name means
ENOENT, which the node reports as `enoent`.

### NIF libraries: `/.nif`

`BeamOS.Nif` (the installation's `erlang:load_nif`) runs NIF libraries
built to WebAssembly ([nif.md](nif.md)) through two kinds of file, each
opened for one exchange: the node writes its request, and its reads give
the answer, then 0.

| Path | Request | Answer |
| --- | --- | --- |
| `/.nif/new` | A library's bytes. | Its id, or `error WHY`. |
| `/.nif/ID` | An external term for the library. | The library's external term, or `{error, Why}` once it trapped or exited (it is gone then). |

`nif.ts` (`Nifs`) instantiates each library with the node's own WASI
imports and runs it synchronously, in the node's worker. While a library
runs, the WASI calls work on its memory instead of the node's: it sees
the node's files, environment and terminal.

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

## Page and node (`host.ts`, `worker.js`)

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
`/.net/https` connections; the playground's is `https.ts`'s
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
`remove`, `rename` and `flush` (write the pending changes now) for the page,
and `connect()`, which makes a node's channel.

## The preview (`sw.js`, `bridge.ts`)

`Bridge.register(url, scope, key)` installs the service worker and
announces the page as the host of `key` (a stored project's id, a temporary
IEx's own). A page that a forced reload left uncontrolled asks the active
worker to claim it first. `Bridge.announce({ kind: 'preview', key })` is the
popped-out preview window's. Both announce again when another worker takes
over. The service worker:

- answers iframe navigations, and requests from clients it first sees to be
  nested frames (it decides once per client);
- lets everything else go to the network without passing through it;
- routes each request by key: a document's own (taken when it was
  navigated), else that of the client its referrer names (the project page,
  the popped-out window, or the app's previous document), else the only or
  the focused host's;
- keeps which client has which key, and each key's host, in IndexedDB
  (`playground-sw`), so a restart keeps routing;
- answers 503 when the key's page is gone;
- adds `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Resource-Policy: same-origin` to every answer, including
  errors, which the isolated page needs to frame them.

`new Bridge({ connect })` answers the service worker's requests. For each
one it:

- opens `connect(bridge.port)` (the IDE sets it to the preview's port) and
  sends HTTP/1.1 with `connection: close`;
- reads the response to its end, removing chunked encoding;
- keeps HttpOnly `Set-Cookie`s in its own jar and puts the others in
  `document.cookie` (the preview's origin is the page's, so the app's
  JavaScript reads and sets them too), and sends both as `cookie`;
- injects a `WebSocket` of its own into HTML (below);
- answers a page that reloads every two seconds while nothing listens.

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
