---
kind: reference
status: live
last_updated: 2026-10-13
---

# The runtime (`playground/runtime`)

The site's runtime. Plain JavaScript modules, served as they are (not
bundled), because the workers import them by URL.

| File | Runs in | Role |
| --- | --- | --- |
| `wasi.js` | worker, Node | WASI preview 1 for `rotp.wasm`: the in-memory filesystem, lazy files, `/dev/urandom`, TCP (`Network`), programs, and the client for shared files. |
| `worker.js` | worker | A node: boots `rotp.wasm`, runs one command or the shell, pumps the page's frames. |
| `files.js` | worker | The shared filesystem (`/work`, `/tmp`), and keeping a project's changes. |
| `overlay.js` | worker | A project's kept changes in IndexedDB. |
| `host.js` | page | `Node` (start, type into, interrupt, connect to a node; page programs) and `Files` (the shared filesystem from the page). |
| `setup.js` | worker, Node | What every node gets: environment, files around the installation, programs. |
| `programs.js` | worker, Node | `git` (as far as Mix asks), and stubs for `esbuild` and `tailwind`. |
| `vfs.js` | worker, Node | Files for code beside the node (shell builtins, programs): local and shared paths as one. |
| `terminal.js` | page | A cooked line discipline over xterm.js: echo, editing, history, pastes, Ctrl+C. |
| `sw.js` | service worker | Sends a preview's requests to its project's page. |
| `bridge.js` | page | Sends them on to the node as HTTP/1.1; keeps cookies; makes LiveView long-poll. |
| `postgres.js` | page | Postgres wire protocol to PGlite. |
| `build.py`, `serve.py`, `node.mjs` | build machine | See [build.md](build.md) and [testing.md](testing.md). |

## WASI (`wasi.js`)

`rotp.wasm` imports 33 functions from `wasi_snapshot_preview1`: args,
environ, clock, random, `poll_oneoff`, `proc_exit`, the `fd_*` calls, the
`path_*` calls, and `sock_accept` and `sock_shutdown`, which are refused.
`new WASI({...}).imports` provides them:

- **Filesystem.** `Dir` and `File` objects under one preopen, `/`. wasi-libc
  turns every path into one relative to it. There are no symlinks; hard
  links are the same `File` under two names (Mix's lock takes one). Errors
  are WASI errno numbers.
- **Terminal.** With `tty: true`, the standard streams are character devices
  without seek or tell rights, which is wasi-libc's test for `isatty`. The
  node then treats them as a terminal (colours, IEx's prompt).
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

### Shared files

With `shared: { prefixes, call }`, the calls on paths under the prefixes
(`/work`, `/tmp`) go to `files.js` instead of the local tree. This covers
`path_open`, `path_filestat_get`, `path_create_directory`,
`path_remove_directory`, `path_unlink_file`, `path_rename`, `path_link`,
and `fd_read`, `fd_write`, `fd_seek`, `fd_filestat_get`,
`fd_filestat_set_size`, `fd_fdstat_get`, `fd_readdir` and `fd_close` on what
they opened. A rename or link between a shared and a local path is EXDEV.
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
records over the template (`overlay.js`), and writes the changed paths
below `/work` a second after they change, in one transaction
([projects.md](projects.md#what-is-kept)). A write that fails is reported
to the page as `{ kind: 'warning', message }`.

## Page and node (`host.js`, `worker.js`)

`new Node({ base, files, serve, programs, onoutput, onstatus, onexit,
onlistening })` starts a worker. It is a blob module that imports
`worker.js`: Firefox does not start a module worker from a page its service
worker controls, and a blob worker takes the page's cross-origin isolation.
`node.start({ shell, initial, cwd, args, env, boots })` boots it: the shell
with `initial` commands typed first, or one command, over the boot images
`boots` (default `['boot']`).

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

## The preview (`sw.js`, `bridge.js`)

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
- adds `Cross-Origin-Embedder-Policy: credentialless` and
  `Cross-Origin-Resource-Policy: same-origin` to every answer, including
  errors, which the isolated page needs to frame them.

`new Bridge({ connect })` answers the service worker's requests. For each
one it:

- opens `connect(bridge.port)` (the IDE sets it to the preview's port) and
  sends HTTP/1.1 with `connection: close`;
- reads the response to its end, removing chunked encoding;
- keeps `Set-Cookie`s in its own jar and sends them back as `cookie`;
- injects `window.WebSocket = undefined` into HTML;
- answers a page that reloads every two seconds while nothing listens.

## Postgres (`postgres.js`)

`postgres(database)` is a connection handler for `serve`; `database()`
gives the PGlite (a promise), asked for on the first message. It buffers bytes into
whole messages (the untyped startup message first), and answers SSLRequest
and GSSENCRequest with `N`. Each batch goes to `db.execProtocolRaw`, in
order, and the bytes come back. Terminate closes the connection.
