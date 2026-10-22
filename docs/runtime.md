---
kind: reference
status: live
last_updated: 2026-10-22
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
| `wasi/` | worker, Node | The node's tree and network, and WASI preview 1 for NIF libraries. `index.ts`: the shim (`WASI`) and the calls on the process; `descriptors.ts`: the calls on the node's own files and the host's (`/.proc`, `/.tty`, `/.nif`, `/.net`); `shared.ts`: the client for shared files and the calls on them; `positioned.ts`: `fd_pread`, `fd_pwrite`, `fd_tell`; `fs.ts`: the in-memory filesystem, lazy files, tars, `/dev/urandom`, `/dev/null`; `net.ts`: TCP and UDP (`Network`); `process.ts`: programs and the terminal; `pipe.ts`: pipes between processes; `jspi.d.ts`: JSPI's types; `abi.ts`: errnos, flags and the calls' signatures. |
| `worker/` (`worker.js`) | worker | A node. `index.ts` builds the node's tree from the boot images (the page's tars, else fetched) and runs one command or the shell, each node through `beam.ts`; `channel.ts` takes in the page's frames and runs the page's programs; `nif.ts` fetches NIF libraries (the site's, the backend's). |
| `files.ts` (`files.js`) | worker | The shared filesystem (`/work`, `/tmp`), and keeping a project's changes. |
| `overlay.ts` | worker | A project's kept changes in IndexedDB. |
| `host/` | page | `node.ts`: `Node` (start, type into, interrupt, connect to a node); `programs.ts`: the node's programs that run on the page; `files.ts`: `Files` (the shared filesystem from the page). |
| `setup.ts` | worker, Node | What every node gets: environment, files around the installation (`/etc/hosts`; `/etc/resolv.conf` when the page serves DNS), programs. |
| `coreutils.ts` | worker | uutils coreutils' tools (`coreutils.wasm`): the shell's commands, a node's programs by name (on `PATH`); a node's `sh -c` goes to the page's `sh`. The site's other WASI programs run the same way, each of its own module (`PROGRAMS`: ripgrep's `rg`, `rg.wasm`; git's `git`, `git.wasm`, the shell's `git` but for a remote: [git.md](git.md#gitwasm-git-itself)); the shell runs them as processes (`processes.ts`). |
| `nodejs/` (`nodejs.js`) | worker | A Node.js process or worker thread: Node's modules over the shared files ([nodejs.md](nodejs.md)). |
| `worker/brush.ts` | worker | The terminal's shell: brush, built to WebAssembly, and its host (JSPI). |
| `processes.ts` | worker, Node | A worker's processes: programs built for WASI (and the host's) running at once as coroutines under JSPI, their descriptors shared, pipes between them ([below](#processes-processests)). |
| `git-remote.ts` | worker, Node | git's remote helper for HTTPS (`git remote-https`): protocol v2's `stateless-connect` through the site's proxy, as a process ([git.md](git.md#gitwasm-git-itself)). |
| `sh.ts` | worker, page | Command lines split into words; `&&`-joined commands for the Node harness's `sh -c` (with a page, `sh -c` is brush). |
| `programs.ts` | worker, Node | `git` (as far as Mix asks), `make` (a package's NIF library built to WebAssembly, the site's or the backend's), and stubs for `esbuild` and `tailwind` (the page's replace them; the Node harness keeps them). |
| `nif.ts` | worker, Node | NIF libraries built to WebAssembly, each in an instance beside the node. |
| `vfs.ts` | worker, Node | Files for code beside the node (shell builtins, programs): local and shared paths as one. |
| `terminal.ts` | page | A shell's line discipline, one per shell (the project's, not each xterm.js's): keys in, echo into the shell's output. Cooked: echo, editing, history (seeded with the lines the shell ran first), pastes, Ctrl+C; tab and other control keys are dropped. Raw while the node asks for it (IEx's line editing): keys go through as typed, Ctrl+C still interrupts (the node's SIGINT); raw without signals while a page program asks (Node's setRawMode): Ctrl+C is a key too. Ctrl+D on an empty line is the end of input, for a page program reading the terminal. |
| `sw.ts` (`/sw.js`) | service worker | Sends a preview's requests to its project's page. |
| `https.ts` | page | HTTPS for the node: the gateway of patch 0020, which answers its first line with `fetch` (then each HTTP/1.1 request on the connection with a fetch of `https://NAME[:PORT]/path`) or `tcp` (a TCP connection to the host, Tailscale's, over which the node does TLS: [tailscale.md](tailscale.md)). |
| `dns.ts` | page | The node's DNS at 127.0.0.53, port 53, UDP and TCP: each query answered by a resolver it is given (the playground's: Tailscale's, else no such name). |
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
`new WASI({...}).imports` provides it but `sock_recv` and `sock_send` (a
library importing one gets ENOSYS from `nif.ts`), with `fd_renumber` (as
dup2, then the first closed; not for the standard streams),
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
- **`/dev/urandom`** is a `Device` over `crypto.getRandomValues`;
  **`/dev/null`** one that reads nothing and drops what is written.

### TCP and UDP (`net.ts`)

`gen_tcp` and `gen_udp` run over our `prim_socket` NIF (`beam/socket`)
over `Network`, which keeps listeners, connections and UDP ports. A
connect to the node's own addresses (127.0.0.0/8, ::1) reaches the node's
own listener, or a port the page serves (`remote.ports`, for example
5432); else ECONNREFUSED. A connect to any other address goes to the page
(`remote.dial`, `Network.dial`), which dials it and answers with a
`CONNECTED` frame (with the connection's local end, which `sockname`
then says); the socket answers `select` until then, and connect returns
`ok` or why not (`econnrefused`, `enetunreach`, `ehostunreach`,
`etimedout`). Without `remote.dial` (the Node harness) other hosts are
unreachable. UDP ports (`udpBind`, 0 for an ephemeral one; the page hears
of each, `remote.bound`): a datagram to the node's own address goes to
its port there, else to the page (`remote.datagram`), which takes it to
one of its UDP ports (`remote.udpPorts`, 53 for DNS), to the project's
other node with that port, or to another host; the page's come back as
`DATAGRAM` frames. A datagram nobody takes is dropped, as UDP's are.

Connections from the page have odd ids and the node's own even ones.
`remote.listening(port, on, ephemeral)` reports listeners to the page; a
listener is ephemeral when it asked for port 0. HTTPS that the page
carries (`remote.https`): `ssl:connect` to a host name connects to a
gateway port, names the host in its first line, and waits for the page's:
`fetch` (then plain HTTP/1.1 to the page) or `tcp` (a TCP connection to the
host, which `ssl` upgrades with the options it was given), or `error
REASON` (patch 0020); without it the node's `ssl` does TLS itself.

Names: the hosts file (`localhost`), then, when the page serves DNS
(UDP port 53), `inet_res` at 127.0.0.53 (`/etc/resolv.conf`, which it
reads again before each query; `setup.ts`), answered by the page
(`dns.ts`).

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

## The shell (`worker/brush.ts`)

The terminal's shell is [brush](https://github.com/reubeno/brush) 0.4, a
bash-compatible shell in Rust, with its line editor (reedline), built for
`wasm32-wasip1` by `brush/build.py` (3.4 MB, 1.2 MB gzipped, with
`opt-level = "z"`). The worker loads it with
the boot images and runs it on the terminal (`--rcfile /etc/brushrc -i`: the
prompt, the directory to start in, since WASI has none, and `help`, the
playground's, with brush's `help NAME` for a built-in). A site without
`brush.wasm` does not build (`runtime/build.py`).

brush on WASI has no processes, pipes or `dup`: the worker's process
table has them ([below](#processes-processests)). Our patches to brush
(`brush/patches/brush/`; brush-core's `sys/wasm/playground.rs`) make its
external commands processes of the table's, through the `processes`
imports, and brush runs under JSPI: what would wait suspends it, and the
worker's processes run meanwhile.

- **External commands** start with three of brush's descriptors as their
  standard streams (brush's own 0, 1 and 2 are the terminal) and run while
  brush goes on. A pipeline's commands run at once, joined by the table's
  pipes, so `yes | head` ends when `head` does. `find` in
  `worker/index.ts` names what runs: a node command (or an escript), a
  page program, a program built for WASI (coreutils' tools, `rg`, `git`).
- **Waiting:** brush's own flow waits for a command suspended in the
  host's `wait`. A job (`&`, a tokio task of brush's) waits 10 ms at a time
  and yields, so brush reads the next line meanwhile, and its line editor's
  `crossterm.read` waits without holding the worker (`Channel.rest`). The
  runtime looks at brush's own flow after every task (`event_interval(1)`):
  on WASI, std's thread parking does nothing.
- **Pipes and files:** brush writes to a pipe without waiting (a
  pipeline's input, before its reader starts: WASI's `bounded` off). What
  it reads back itself, a command substitution's output or a here-string,
  stays in its memory; a process's output is fed to it while brush waits.
  Files are shared between their clones (no `dup`).
- **A compound command before a pipeline's last** (a subshell, `{ }`, a
  loop, a function) runs in a task of its own, a clone of the shell, as a
  forked subshell would (`0009`): inline, it ran to its end before its
  reader started, and a program it started waited on a full pipe for
  good.
- **Built-ins WASI lacked:** `exec` (redirections as on unix; a command
  runs as a child, then the shell exits with its status), `trap` and
  `kill` with POSIX's signals, numbered as Linux's (`kill` through the
  table's), and `. NAME` looks on PATH first (`0007`, `0010`). With
  `set -x`, an assignment's status is 0 again (`0008`, brush's own bug).
- **Finding a program:** a name without a slash is looked for on PATH as
  `execvp` would, for a script (`#!` naming sh, bash, node, escript);
  `env` and `xargs` are processes of the table (`utilities.ts`), which
  start the table's programs, and so is `chmod` (WASI has no modes: it
  checks the mode and the files, and changes nothing).
- **Ctrl+C** while brush waits for a command stops every process but
  brush, a job in the background too (bash spares those).

**Its line editor** is reedline, as brush has it natively: Tab completes
(paths, commands, with bash's `complete`), Up and Down go through the
history, Ctrl+R searches it, and a line that does not end a command (a
`for` … `done` over several lines) goes on. It runs on crossterm, whose WASI
backend (`brush/patches/crossterm/`) is the host's terminal through three
imports (`crossterm.raw_mode`, `size`, and `read`, the terminal's input
within a timeout; `worker/brush.ts`): the page's line discipline is raw
while reedline reads, and Ctrl+C reaches it as `\x03`. reedline asks the
terminal where its cursor is (`ESC [ 6 n`): a shell's screen on the page
(`screen` in `playground.ts`, an xterm `Terminal` that is always fed,
shown or not) answers, and the terminals showing it do not (`REPORT`), so
one answer comes for every view of a live session. brush-interactive's
bridge from reedline's callbacks to the shell (`block_on`) polls in place
on WASI, outside tokio's cooperative budget: with one thread, a budget
spent would never be renewed. reedline's history file locks with fd-lock,
whose WASI locks are always granted (`brush/patches/fd-lock/`).

## Processes (`processes.ts`)

One worker's processes, as an OS has them: each a program with
descriptors of its own, some of them its parent's, running at once with
the others on the worker's thread as coroutines under JSPI. Chromium,
Firefox and WebKit have JSPI (`WebAssembly.Suspending`, `promising`).

- **Descriptors are shared, as open file descriptions are:** a child's
  standard streams are the same objects as its parent's descriptors, with
  `shares` counting the tables beyond the first. A pipe's end
  (`wasi/pipe.ts`) closes with its last reference: the reader then sees
  its end, the writer EPIPE.
- **A pipe** holds 64 KiB. A program run with `suspending` (its start
  under `WebAssembly.promising`) that reads an empty one or writes a full
  one is suspended until it changes (`WASI.block`); so is its
  `poll_oneoff`, which knows pipes, and its sleep. The shim's other
  callers (a node's ports) get EAGAIN, as before.
- **A program built for WASI** (`wasmProgram`) gets the `processes`
  imports: `pipe`, `spawn` (a NUL-separated request, as brush's was, and
  three of its descriptors), `wait` (until, not at all, or a little),
  `kill`, `dup` and `dup2`. Its children are found as the shell finds
  commands, by name (`Resolve`).
- **A page program** (`pageProgram` in `worker/index.ts`) streams. Its
  input goes to the page as it comes (`feed`), at most 1 MiB ahead of what
  the program took (`TAKEN` frames from the page, sent as its `oninput`
  takes bytes; what comes before it sets `oninput` waits). Its output goes
  to its stdout as it comes (`writeAll`), waiting while a pipe is full;
  once nothing reads it, the program is stopped (141, SIGPIPE's). It
  cannot be paused itself: what it writes ahead of a slow reader is bounded
  at 16 MiB (`HOSTED_LIMIT`).
- **A node** (`hosted`) takes its input whole first, unless it is the
  terminal's (or a node's) own, which it reads as it comes, and then runs
  to its end, holding the worker. It cannot wait for room in a pipe: it
  writes up to 16 MiB ahead of its reader, and drops what it writes once
  the reader is gone.
- **A task** (`Processes.task`) is a function of a process's own, run
  beside it as a coroutine of the same instance (git's `start_async`:
  `async_start`): it shares its parent's descriptors, and each coroutine
  keeps its C stack pointer across a wait (`WASI.suspended`). A process
  that exits leaves its children to nobody: those that exited are
  forgotten, the others once they do (as init reaps orphans).
- **sh** is brush as a process (`shProgram`): `sh -c LINE`, `sh FILE`,
  and a script whose `#!` names sh or bash, with the streams it was
  given.
- **Signals:** `kill` marks a process and wakes it if it waits; its next
  call ends it (128 + the signal). A parent's `wait` takes in Ctrl+C
  (`idle`, the channel), which stops every process but the shell.
- **brush** is an adopted process of the table (`adopt`), so what it
  starts are its children.

What git runs is [git.md](git.md#processes)'s. Not yet: a node as a child
streams neither its input nor, while it runs, the others' (the BEAM holds
the worker); a program built for WASI that reads the terminal holds it too
(`readInput`); and a page program in the background (`&`) that reads the
terminal takes the shell's typing.

## coreutils (`coreutils.ts`)

uutils coreutils 0.12.0, Rust's rewrite of GNU's (Ubuntu's since 25.10),
built for `wasm32-wasip1` with its own WASI feature set
(`tools/coreutils/build.py`): one module, 89 tools, its first argument naming the
tool, as BusyBox does. BusyBox itself needs `fork`, which WASI lacks. The
one patch has it change to `$PWD` first, as WASI has no working directory.

A worker fetches and compiles it when a tool first runs (140 ms in
Chromium, 200 in WebKit, 470 in Firefox, from the HTTP cache after that). Each run is an
instance of its own over the node's tree and the shared files (`wasi/`).

- **The shell** (brush) runs a tool for a command it does not have as a
  built-in (`ls`, `cp`, `sort`, …; `echo`, `pwd`, `test` are brush's): a
  process ([above](#processes-processests)), at once with the rest of its
  pipeline.
- **A node** finds the tools on `PATH` (`/usr/bin`) and spawns them by
  name: `System.cmd("rm", ["-rf", "c"])`. Run to its end on the node's
  thread, which waits for it, as for any quick command: a tool gets the
  input that is there when it starts and then its end, and runs nothing
  that waits for more (`tail -f`, an interactive `sort`).
- **`sh -c LINE`** from a node is the page's `sh`: brush in a worker of its
  own, which runs the tools as the terminal's does
  ([nodejs.md](nodejs.md#a-nodes-sh--c-is-brush)).

**GNU's text tools** are not coreutils: each is a program of its own
built from C for WASI ([tools.md](tools.md)), named in `PROGRAMS` beside
`rg` and `git`: `sed`, `grep`, `diff`, `cmp`, `diff3`, `sdiff`, `awk`
(gawk, as `gawk` too) and `find`. They take the `processes` imports
(sed's `e`, diff3's diff, awk's pipes and find's `-exec` start children),
so a node's runs in the process table, as its `git` does
(`portProgram`), and so do the shell's utilities (`env`, `xargs`,
`chmod`).

Not yet: `os:cmd`'s `sh -s` (its line on standard input); `grep -P`;
file modes and owners, which WASI does not have (`chmod` changes
nothing, `ls -l`'s columns); a file's link count, which the shim gives
as 1 though the tree has hard links (`find -links`).

## Page and node (`host/`, `worker/`)

`new Node({ base, files, serve, programs, onoutput, onstatus, onexit,
onlistening })` starts a worker. It is a blob module that imports
`worker.js`: Firefox does not start a module worker from a page its service
worker controls, and a blob worker takes the page's cross-origin isolation.
`node.start({ shell, initial, cwd, args, command, env, boots })` boots it:
the shell with `initial` commands typed first, or one command (erl's
`args`, or a `command` by name as the shell runs it, such as `['mix',
'deps.get']` or `['escript', FILE, ...]`), over the boot images `boots`
(default `['boot']`). The start message carries what the exec frame's
worker (`Node`'s owner, [frames.md](frames.md)) has once for every node's
worker: the boot images as `files.js` gunzipped them and the
manifest (`Files.boot`), and `beam.wasm`, `coreutils.wasm` and, for a
shell, `brush.wasm`, compiled (`siteModule`; a compiled module posts to a
worker as it is). The worker builds its tree from the tars; the emulator
instantiates the module through Emscripten's `instantiateWasm` (beam/run.ts).
What is missing, the worker fetches and compiles itself.

**Page → node: frames** in a SharedArrayBuffer ring of 1 MiB:

- each frame is `[kind u8][id u32][length u32][payload]`, little-endian;
- `control[0]` counts bytes written and `control[1]` bytes read;
- the worker sleeps on `control[0]` while it equals `control[1]` (all read),
  so a frame wakes it, also one written while it was taking the others;
- the page queues frames the ring has no room for, and retries every 2 ms.

| Kind | Frame |
| --- | --- |
| 0 `INPUT` | Standard input. |
| 1 `OPEN` | The page connects (id) to a port (payload: u16, big-endian). |
| 2 `DATA`, 3 `END`, 4 `CLOSE` | A connection's data, end, close. |
| 5 `INTERRUPT` | Ctrl+C: the running node's SIGINT (erts' break menu: c continues, a aborts); a page program stops. |
| 11 `TERMINATE` | Stop what runs now at once (the server's restart). |
| 12 `CONNECTED` | How dialing a connection the node opened to another host (id) went: an int8, 1 or a negative errno; once connected, its local end: family (4 or 6), address, port (u16, big-endian). |
| 13 `DATAGRAM` | A datagram for the node's UDP port (id): the source's port (u16, big-endian), family (4 or 6) and address (4 or 16 bytes), then its bytes. |
| 7 `OUTPUT`, 8 `EXIT` | A page program's output and exit code (u8). |

**Node → page: messages.**

| Message | Meaning |
| --- | --- |
| `out` | Terminal output (bytes). |
| `status` | Loading progress, then `running`. |
| `exit` | The command's exit status (one-command mode). |
| `net` | Connection traffic: `open` (a port the page serves, or with `host` the HTTPS gateway), `dial` (another host's address and port), `data`, `end`, `close` and `refused`, by id. |
| `udp` | A datagram from the node's port `from` to `address`:`port`, or (`bound`, `closed`) that the node bound or closed the port. |
| `listening` | The node started or stopped listening on a port (`ephemeral`: one it asked for with 0). `Node.listening` holds every port, `Node.serving` the named ones. |
| `spawn`, `kill` | Start a page program, or tell it its port closed. |
| `nif` | `make` waits for the backend to build a package's NIF library, or stopped waiting: `{ name, version, status, error }` (`onnif`; [nif.md](nif.md#in-the-node)). |

`https: (connection, { host, port }) => …` answers the node's
HTTPS connections (patch 0020's gateway, which waits for the page's first
line); the playground's is `https.ts`'s `httpsByFetch()`. Its `fetch`:
it reads requests with a body (Content-Length or chunked) and answers each
with `fetch()`: the browser does TLS, checks the certificate, follows
redirects, decompresses, and leaves out request headers it sets itself
(Host, User-Agent, Cookie, Accept-Encoding) and response headers the site
does not expose; the answer comes back chunked, as it arrives (one to
HEAD, a 204 and a 304 with the site's Content-Length and no body; a
status without its text, as HTTP/2 answers, with its standard reason), and the
connection closes after it. A site without CORS headers fails the fetch,
answered 502 with why. Without `https`, the node has no HTTPS (its `ssl`
does TLS itself, over sockets that reach no other host).
`httpsByFetch({ tunnel, onblocked })`: `tunnel(host, port)` may give a
TCP connection there instead (`tcp`: the node's `ssl` upgrades the
gateway's socket, with its own options; the playground's: through the
user's tailnet, [tailscale.md](tailscale.md)), or fail (`error REASON`);
`onblocked(url)` hears of a fetch the browser would not make.

`node.connect(port)` gives a connection to the node's listener: `ondata`,
`onend` and `onclose`, with `write`, `end` and `close`. `serve: { port:
handler }` answers the node's connections to those ports (5432: PGlite).

`outbound: (connection, { address, port }) => …` takes the node's
connections to other hosts: `connection.dialed(local)` once there (from
`local`, address:port), or `refuse(errno)` (negative, as WASI numbers it).
`udpServe: { port: (datagram, reply) => … }` answers datagrams to the
page's UDP ports (53: `dns.ts`); `udpPeer(datagram, node)` takes those to
another node's port of the project's (`node.udpPorts`); `udp: {
send(datagram, reply), unbound(port) }` takes those to other hosts,
`reply(address, port, bytes)` sending one back. Without them, other
hosts are unreachable and their datagrams dropped. The playground's go
through the user's tailnet ([tailscale.md](tailscale.md)).
`node.datagram(to, address, port, bytes)` sends the node one.

**Page programs.** `programs: { name: (process, { args, cwd, env, fs }) => …
}` run on the page and may be async. `process.write`, `process.exit` and
`process.onkill`. `fs` is the shared `Files`.

`new Files({ base, boots, template, store, onchange, onwarning })` starts
`files.js` from the site's boot images and manifest (only the shared paths
and the template); once `ready`, `boot` holds the images gunzipped (plain
tars, transferred from `files.js`, which keeps copies of its files only)
and the manifest, for the nodes' workers. It offers `list`, `stat`, `read`, `write`, `mkdir`,
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

**A preview origin per port, on the usercontent domain.** The preview
shows port PORT of the app on `v-ID-PORT.USERCONTENT` (`site.ts`
`previewOrigin`; [frames.md](frames.md)), another site than the IDE's, so
several ports show at once (Livebook's page and its iframe endpoint's
outputs, on another port) and each is kept from the IDE's origin and
from the others':

- the IDE has a hidden `relay.html` frame on each port's origin
  (`project/lib/previewOrigins.ts`, made as a server listens there); its
  page (`frames/relay.ts`) registers that origin's service worker, is its
  host, and passes the preview's requests and WebSockets to the IDE on a
  MessagePort, with the port and the origin's cookies (its jar,
  `runtime/cookies.ts`: a frame of another site keeps few cookies of
  its own, so they are kept in its local storage, and the app's pages
  read and set them as `document.cookie` through a shim the bridge puts
  in each);
- `new Bridge({ connect }, port, origins)` with `origins`
  (`v-ID-{port}.USERCONTENT`) takes each request's port from it; cookies the
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

A live session's guest's preview has preview origins of its own the same
way, its relays' requests answered by the guest page's bridge
([collaboration.md](collaboration.md#the-preview)).

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
