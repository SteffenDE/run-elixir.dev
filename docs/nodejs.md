---
kind: design
status: experiment
last_updated: 2026-10-23
---

# Node.js in the playground

The playground provides `node`, `npm`, and `npx` in project terminals and
as child commands. JavaScript runs on the browser's engine in workers
under the project's exec frame. Node-compatible modules in
`app/src/runtime/nodejs/` provide access to project files, processes, and
network services.

This is a compatibility implementation, not an embedded Node.js binary.
It supports Vite builds and dev servers, Vue and Svelte project creation,
and coding agents. Unsupported APIs fail explicitly; the limits below
are part of the current implementation.

## A process (`nodejs.js`, `programs/nodejs.ts`)

`node` is a page program (in the exec frame's worker, `exec/host.ts`, as
the others now are): each process is a worker of its own, nested in that
one (the runtime's entry `nodejs/index.ts`, built as `nodejs.js`), started with a
channel to the shared files (`Files.connect()`), as a node's worker is. Its
output and exit come back as messages; closing its port (Ctrl+C) stops the
worker. `/usr/bin/node` is a stand-in, so `System.cmd("node", …)` finds it,
and the shell runs a script whose first line names `node` (a package's bin
in `node_modules/.bin`) with it.

| File | What it is |
| --- | --- |
| `index.ts` | The entry: `node`'s flags (`-e`, `-p`, `-r`, `--version`), a script or a thread, the globals (`process`, `Buffer`, `console`, timers, Node's `MessageChannel`, assignable `self` and `navigator`), uncaught errors and rejections. |
| `fs.ts` | `fs` over the channel: the synchronous calls as they are, the callback and promise forms on top; Node's error codes from WASI's. `watch`, `watchFile` and `promises.watch` hear what changed (below). `createReadStream` and `createWriteStream` (and a `FileHandle`'s) on its open, read and write. |
| `loader.ts` | `require` with Node's resolution (paths, `node_modules` and `NODE_PATH`, `package.json`'s `main`, `exports` and `imports` with Node's conditions: `node`, `require` or `import`, `module-sync`, `default`; a require that finds no entry of its own takes the import one). CommonJS in Node's wrapper; ES modules and TypeScript turned into CommonJS by sucrase, so a module loads synchronously however it is required or imported; one that awaits at its top level, or imports one that does, runs its body once those imports have run. An ES module's own `require` (`createRequire`'s) stays its own. An import of CommonJS has its `module.exports` as the default, `__esModule` or not, as Node's. `import()` answers namespaces as Node's does and holds the loop. |
| `source.ts` | A scan of code, strings, templates, comments and regular expressions: the loader's rewrites (`import.meta`, `require(`, `import(`, `exports."…"`) touch code alone (and `import(` as a call, not a method named `import`). |
| `process.ts` | `process`, `console`, timers. The process ends when nothing holds its loop, as Node's: timers, intervals, immediates, pending `import()`, workers and ports that are ref'd; promises are not. `process.nextTick` is one queue drained whole before promise jobs queued meanwhile, as Node's, and readable-stream's too (its `process` package is `process-shim.ts`, whose own nextTick ran on a timer). |
| `webstreams.ts` | The browser's web streams with the closed promise Node's carry, for `stream.finished()` on a web stream (undici calls it on a response's body), settled as their consumer sees them end. |
| `fetch.ts` | The global `fetch`, Node's: by the process's own `http` and `https` (below). |
| `threads.ts` | `worker_threads`: a `Worker` is a nested worker running `nodejs.js` as a thread of the same process, sharing its files channel (one call at a time, by a lock in shared memory); messages as structured clones (shared memories, WebAssembly modules); a thread's output and uncaught error go to its parent. Node's `MessageChannel`: ports with `ref`/`unref` and `on('message')`, and so is a port a thread or its parent receives. A thread stopped (`terminate`, its exit) takes the lock no more, nor do those under it, and its worker is stopped once none of them holds it or is taking it (each says so before it looks whether it is stopped); their tokens are given again after. A process has at most 1022 threads at once. `receiveMessageOnPort` answers nothing: a browser's port is read by the event loop alone. |
| `wasi.ts` | `node:wasi` over the runtime's WASI (`wasi/index.ts`), on the shared files. |
| `net.ts`, `http.ts` | `net.Server`, `net.Socket` and `net.connect` on the project's ports, and to other hosts through the tailnet (below); `http.createServer` over them: requests with a body by length or in chunks, kept connections (those pipelined before the client ends its side answered too), `upgrade` (a WebSocket), a request and its response that `'close'` when the client goes, responses with Node's header calls, by length or in chunks; `http.request` and `get`, each on a connection of its own (no pooling), with `upgrade` too; `https.request` and `get`, the same over HTTPS the exec frame carries (below). |
| `tls.ts` | `tls.connect` and `TLSSocket`: rustls built to WebAssembly (`tls/`, below), over a socket it opens or one it is given. A peer certificate's subject, issuer and altnames, and `checkServerIdentity` (an option, and the exported one) that checks them. |
| `dns.ts`, `dgram.ts` | `dns` (`lookup`, `resolve4`/`6`, CNAME, MX, NS, SRV, TXT) by the node's DNS; `dgram` on the project's UDP ports (below). |
| `hashes.ts` | `crypto.createHash`, `createHmac` and `hash` (md5, sha1, sha2, ripemd160), synchronous, by `@noble/hashes`; a Hash and an Hmac are Transform streams too. |
| `child.ts` | `child_process` (below). |
| `zlib.ts` | `zlib` by fflate: gzip (concatenated members too), deflate and raw deflate, and unzip, synchronous, with callbacks and as streams (their classes, and `flush()`); `crc32`; brotli named, and missing when called. |
| `builtins.ts`, `util.ts`, `path.ts`, `buffer.ts` | The other core modules: `path`, `util` (`format`, `inspect`, `promisify`, `parseEnv`, `parseArgs`, …), `events`, `stream` (readable-stream), `os`, `url`, `assert`, `tty`, `readline`, `vm`, `async_hooks` (whose `AsyncLocalStorage` keeps its store for the synchronous part of `run()` alone: the browser has no async context to carry it past an `await`), `perf_hooks`, `timers/promises`, `module`, `crypto` (random values and hashes), `Buffer` with `base64url`. |

Stacks print as Node's (`at f (file:line:col)`) whatever the engine wrote,
without the runtime's own frames.

**What is missing** says so when called: an HTTPS server and
`tls.createServer`, brotli in
`zlib`, ciphers and keys in `crypto`, HTTP/2 (its constants are there,
which clients read as they load). There is no REPL (`node` alone).

## The worker's policy

A script runs on the browser's own engine, so it can reach for the
browser's APIs as well as Node's: `self.fetch` behind Node's, `XMLHttpRequest`,
`WebSocket`, `EventSource`, `import()` of a URL, `caches.add`, a `Worker`.
Those would bypass the process's messages, through which all of its other
network goes (the gateway, the tailnet's gates). The process's worker
therefore starts from `nodejs.js`'s URL, not a blob (`programs/nodejs.ts`).
A worker from a URL takes the `Content-Security-Policy` its script was
served with, and `serve.py` and Caddy ([deploy.md](deploy.md#caddy))
answer `/b/ID/nodejs.js` and `/b/ID/chunks/*.js` with:

```
default-src 'none';
script-src  ORIGIN/b/ID/nodejs.js ORIGIN/b/ID/chunks/ 'unsafe-eval' 'wasm-unsafe-eval';
worker-src  ORIGIN/b/ID/nodejs.js ORIGIN/b/ID/chunks/ blob:;
connect-src ORIGIN/r/ data: blob:
```

- **Its own scripts in `worker-src` too:** a module worker's imports are
  fetched as worker scripts, so `worker-src blob:` alone refuses its
  chunks. Only those paths, not `/b/`: the build's other workers
  (`worker.js`, `files.js`, `git.js`) carry no policy, and a script that
  started one from its URL would have their network. A worker started
  from `nodejs.js` or a chunk takes the same policy from its own response.
- **Threads** (`threads.ts`) start from blobs, which inherit the policy.
- **`connect-src`:** the runtime's files (`tls.wasm`, `roots.pem`), and
  `data:` and `blob:` URLs for Node's `fetch`. Not `'self'`: the exec
  origin also serves `/git/`, `/hex/` and `/api/nif/`.
- **`'unsafe-eval'`** for the loader's CommonJS wrapper, and
  **`'wasm-unsafe-eval'`** for tls.wasm and `node:wasi`.

`nodepolicy.spec.ts` tries each API against something that would succeed
without the policy (the exec origin's `/exec.html`, a `data:` module,
`worker.js`) and expects each to be refused, in all three browsers.
Without the header (a server that does not send it) the process still
runs, unconfined: the deploy's check fails a release whose exec origin
does not send it ([deploy.md](deploy.md)).

## Standard input and the terminal

A process reads what is typed at the terminal, as a node does, through
the IDE's line discipline (`runtime/terminal.ts`):

- **Lines:** cooked, the line discipline echoes and edits a line, and the
  process gets it at Enter; Ctrl+D on an empty line is the end of its
  input. While the shell runs a page program (`pageProgram` in
  `worker/index.ts`), the terminal's input goes to it (`stdin` messages to
  the page's `PageProcess.oninput`), not to the shell.
- **Raw input:** `process.stdin.setRawMode(true)` asks for it (a `MODE`
  frame to the shell's worker): keys go as typed, and Ctrl+C is one of
  them (no signals, as a tty without ISIG), so a TUI handles it itself.
  The shell's mode comes back once the program ends, however it ends.
- **A pipe's bytes** (`echo x | node …`) and then their end; with neither
  a terminal nor a pipe (a child process's, a node's port), stdin stays
  open with nothing in it, as an open pipe does. `process.stdin` holds
  the loop only while something reads it, so a process that never reads
  ends as before.
- **Its size:** `stdout.columns` and `rows` are the terminal's, with
  `'resize'` and SIGWINCH as it changes; `isTTY` says whether stdin and
  stdout are the terminal.
- `sh` (a node of its own) and `npm run` pass the input, the size and
  the raw mode through, so `npm run dev`'s Vite or a script's prompt reads
  the terminal too, and so does a child process that inherits the
  terminal ([child_process](#child_process-childts)).
- **readline** (`readline.ts`): keypress events as Node parses a
  terminal's keys, and `createInterface` on a terminal with its own line
  editing (raw input, history, Ctrl+C, Ctrl+D), else lines;
  `question` and `readline/promises`. create-vue's and sv's prompts
  (clack's) work at the terminal.

## npm and npx (`programs/npm.ts`)

The playground's own npm, not npm's CLI (which would need `http`, `zlib`, `crypto`
and `child_process`, and load a thousand modules per run): `npm install`
(and `ci`, `add`, `-D`, `-E`, `--no-save`), `npm run` (and `test`,
`start`), `npm exec`, `npm init`, `npm create` (`npm init NAME`: the
initializer's package, `create-NAME`, `@scope/create`, by npx), and
`npx`.

- **The registry** is fetched from the exec frame's worker (its origin,
  so no cookie of the apex's goes along): registry.npmjs.org sends CORS
  headers on metadata and tarballs; it answers no preflight, so requests
  carry only simple headers (the abbreviated metadata's `Accept` is one).
  Tarballs are checked against their integrity and kept in the exec
  frame's Cache Storage (`playground-npm`; Hex's cache, by contrast, is
  the apex's). Private registries and git or `file:` dependencies
  do not install.
- **The tree** is laid out as npm lays it out (each package as high as it
  goes without another version in the way, nor where it would hide the
  copy a package below it uses); a peer that conflicts with what is there
  is warned of (`ERESOLVE`, as npm's `--legacy-peer-deps`) and left out.
- **The lock:** a `package-lock.json`'s (lockfileVersion 2 or 3) versions
  are kept where they still satisfy, and one is written (lockfileVersion
  3, with the fields npm keeps: an alias's `name`, `peerDependenciesMeta`,
  `deprecated`, …). A locked package that still satisfies, with
  `resolved` and `integrity`, is laid out from its entry, as `npm ci`
  does: its tarball from Cache Storage, else by `resolved`, checked
  against `integrity`. The registry's metadata (kept for the page alone)
  is fetched only for what the lock lacks, what it has at a version
  that no longer satisfies, and what the command names (`npm install
  foo@2`, npx's package for a range or a tag). Optional packages for
  another platform stay in the lock, uninstalled, as npm keeps them; a
  package the registry has not (a guessed `-wasm32-wasi` build, below) is
  remembered in Cache Storage for a day. So after a reload an unchanged
  project installs without the registry, and `npm install newpkg` asks
  it for what is new. Bins are links in `node_modules/.bin`
  (`Files.symlink`). Extraneous packages are not pruned.
- **Platforms:** packages for another os or cpu are left out, matched as
  `os: linux`, `cpu: wasm32`. napi-rs packages list only their native
  builds; npm adds their `PREFIX-wasm32-wasi` build beside them (Rolldown's
  binding). Packages whose WebAssembly build has another name are in a
  table (`STAND_INS`), never guessed: `lightningcss` (Vite's CSS
  minifier) gets `lightningcss-wasm` at its version and a stand-in
  `lightningcss-linux-x64-gnu` beside it that is it (what lightningcss
  requires here; the process says linux on x64). Install scripts do not
  run (npm says which packages had one).
- **`npm run`** runs a script with the page program `sh` (brush, below), with
  `node_modules/.bin` on `PATH` and npm's `npm_*` variables; `npx` runs a
  project's bin, or installs the package into `~/.npm/_npx/NAME@SPEC`
  first (a scope's `/` as `+`). An exact version already installed
  there, with its bin, runs as it is, without the registry (as npm's npx
  reuses its cache); a range, a tag or `latest` installs again, which the
  lock makes cheap (above): its package's metadata alone. An embedder
  may run that bin itself once it is there ([embed.md](embed.md)).

## child_process (`child.ts`)

A child is a command line the page program `sh` runs in the exec frame
(brush in a worker of its own, below), as the terminal would: node, npm,
npx, git, mix, coreutils, rg, `node_modules/.bin`'s scripts. `spawn` quotes
the command and its arguments unless `shell`; `exec` and `execFile`
collect the output (and `promisify` answers `{ stdout, stderr }`); `fork`
is `node` without the IPC channel. The process asks `{ kind: 'child', op:
'spawn', id, line, cwd, env }`, `{ op: 'stdin', id, bytes }` (or its
end) and `{ op: 'kill', id }`, and hears `out` and `exit`; a child holds
the loop until its `'close'`, and goes with the process. A command `sh`
did not find (127, and sh's message for the program itself, nothing else)
is spawn's `ENOENT`; another 127 keeps its status and output
(`spawnSync` with `inherit` cannot tell; sh's message comes on stderr,
and both streams are read for it). `kill()` stops the child's node
(which a closed port alone leaves running, as a node's port's program
does), its status a SIGTERM's (143), its `signalCode` the signal
`kill()` was given.

- **stderr is its own stream:** a child's `child.stderr` (and exec's
  callback's, spawnSync's) is what it wrote to fd 2: brush's own errors,
  its children's, a node's `standard_error`, a page program's
  (`writeError`, `OUTPUT_ERR` frames to its process's fd 2: runtime.md),
  npm's and npx's warnings and errors, claude's progress. `stdio` `[…, …,
  1]` is `2>&1`. A terminal still shows both as one.
- What the program writes to `child.stdin` is the child's input, and
  `end()` its end (its `sh -c` node passes it on, byte for byte, to what
  it runs: a page program, a coreutils tool, rg).
- `stdio` may name a stream, such as `process.stdout` itself (npm-run-all2
  does on a TTY): the child's output goes there.
- **The terminal, inherited:** a child whose stdin or stdout is the
  process's (`'inherit'`, `[0, 1, 2]`, `process.stdin` and
  `process.stdout` themselves) has the terminal where the process's is
  it, as on a real tty: `isTTY` on its streams, the same `columns` and
  `rows`, SIGWINCH, and `setRawMode` (the process's raw mode, as the
  terminal's own programs set it). With stdin, the typing goes to the
  child, not to the process, until it ends (to the last such child, if
  several), and the process's mode is the terminal's again after.
  `claude-agent-acp --cli` runs Claude Code so (`spawn(claude, args, {
  stdio: 'inherit' })`). Neither a pipe's input nor a node's is passed
  on: a child that inherits a stdin that is no terminal reads nothing.
- **`spawnSync`, `execSync`, `execFileSync`:** the spawn carries a
  SharedArrayBuffer of `maxBuffer`'s size (Node's 1 MiB; more is
  `ENOBUFS`, for each stream), which the exec frame fills with the
  child's stdout and stderr and then its status, and the process waits on it (`Atomics.wait`), standing
  still meanwhile as Node's does. `input` is the child's stdin and then
  its end; `timeout` stops it (`ETIMEDOUT`); with `stdio: 'inherit'` its
  output is the process's own as it comes. `execSync` throws on a failure,
  the result on the error (`status`, `stdout`).

## A node's sh -c is brush

`sh -c LINE` (`System.shell`, `open_port`'s spawn, npm's scripts) starts a
worker whose brush runs the line without its line editor, dispatching
commands as the terminal's shell does: pipes, `||`, `;`, variables,
redirections; node commands in that worker, page programs, coreutils. A
tool with neither a file nor a pipe reads the node's input, as on a
real machine: an open-ended `System.shell("sort")` waits for its end.
Reading it waits without holding the worker (`ready` on the input's
descriptor), so a job in the background runs meanwhile, and the port's
closing is the input's end. file_system's line, `inotifywait "$0" "$@" &
PID=$!; read a; kill -KILL $PID`, runs as written: the page's
`inotifywait` in the background until the port closes.
`sh.ts`'s `commands()` remains only for the Node harness (no page).
`System.shell("true")` takes some 70–220 ms, mostly the worker's start
(it builds its tree from the boot tars the exec frame's worker has).

## Vite and Rolldown

Vite 8 bundles with Rolldown, whose WebAssembly build (napi-rs,
`@rolldown/binding-wasm32-wasi`) runs here with `node:wasi` and real
worker threads through emnapi. What it needed beyond the above:
`MessageChannel` ports that hold the process (emnapi refs one while a
thread-safe function waits), Node's `require(esm)` for a `"module.exports"`
export, and an ES module's own `require` and `__dirname`. `npm run build`
of a small React app: about 1.9 s in Chromium, 3 s in Firefox and WebKit
(Vite's build itself some 0.6 s). Rolldown's binding asks for a shared
memory of 1 GiB (up to 4 GiB), which a phone may not have.

## Servers and connections: ports, and the files' changes

A process's `listen` asks the exec frame's worker for its port (`{ kind:
'net', op: 'listen' }`); `exec/host.ts` takes it unless a node or another
process holds it (0 takes a free one, which is no server), and answers.
It holds a process's ports as it holds a node's: the preview's bridge, a
live session's guest and the project's nodes (`routePeer`) connect to
them, each connection a series of messages to and from the process's
worker (`open`, `data`, `end`, `close`), whose `net.Socket` is a stream
of them. A port a process serves shows in the preview as a node's does;
a save in the editor does not reload a page a Node.js server shows (it
updates its page itself, as Vite does). The process's ports go when it
ends; the IDE hears which ports are a process's with the others
(`serving`'s `scripts`). With no server on Phoenix's 4000, the preview
shows the server that started last (Vite, after the backend it proxies
to).

A connection a process makes (`{ op: 'connect', id, port }`, even ids)
goes where a node's would (`route` in `exec/host.ts`): to the services
(Postgres on 5432 and Hex, carried to the IDE's page as a node's are,
`portConnection.ts`; epmd), another process's port, or a node's; the
worker answers `connected` or `refused`
(`ECONNREFUSED`), and the bytes go as a listener's do. So `pg` queries the
project's database, processes talk HTTP to each other, Vite's
`server.proxy` reaches a backend, and a node's `:httpc` a process's
server.

`https.request` goes as a node's HTTPS does (`https.ts`): its connection
asks for a host (`{ op: 'connect', id, port, host }`), the request goes
on it as plain HTTP, and the exec frame's worker answers it with a
`fetch()` of `https://host/path` (from the usercontent origin). The browser does TLS and checks the
certificate; it reads only what the site's CORS allows (a site without
CORS headers answers 502, saying why), sets Host, User-Agent and Cookie
itself, follows redirects and decompresses. Each connection carries one
request. The gateway says how first (`https.ts`: a line, `fetch`, `tcp`
or `error REASON`), which the socket reads before its `connect`. With
an allowed Tailscale route or permission to use the restricted relay, it
says `tcp`: a TCP connection to the host through that route, over which the socket does TLS itself
(`tls.ts`'s Engine, ALPN `http/1.1`, the request's or its agent's `ca`,
`cert`, `key`, `servername` and `rejectUnauthorized`), as a node's HTTPS
does. Tailscale can reach any host allowed by its policy; the relay
accepts only its allowlist on port 443 ([relay.md](relay.md)).

### TLS (`tls/`, `tls.ts`)

A process does TLS itself, as a node does: rustls 0.23 with ring's crypto
and Mozilla's roots (webpki-roots), built for `wasm32-wasip1` in Docker
(`tls/build.py`, `target/tls/tls.wasm`: 0.71 MB, 0.29 MB gzipped), with a
C-like API over handles and no I/O of its own (`tls/src/lib.rs`): feed
what the socket read, write what the program writes, take what to send,
read what the program reads. WASI gives it randomness and the clock
(`crypto.getRandomValues`, `Date.now`), the rest of WASI it does not use.
The process fetches and instantiates it on its first TLS connection, one
instance and a handle per connection. Plaintext stays in the process's
worker: what crosses to the apex's Tailscale worker is TLS.

- `tls.connect(port, host, options)` or `({ socket })`: SNI from the host
  (none for an address, unless `servername`); `ALPNProtocols`; `ca`
  (replacing Mozilla's roots), `cert` and `key` (a client certificate);
  `rejectUnauthorized` (default true, `NODE_TLS_REJECT_UNAUTHORIZED=0`
  too). `secureConnect` once the handshake is done.
- On port 443, the gateway chooses Tailscale, the restricted TCP relay,
  or browser fetch. Tailscale and relay connections use the process's
  own TLS. The fetch fallback sends plain HTTP to the gateway, which
  delegates TLS and certificate checks to the browser. Other ports
  require Tailscale.
- A connection the other side closed is read to its end before it is
  destroyed (`closeAfterEnd`, `net.ts`'s sockets too).
- `authorized` and `authorizationError` (OpenSSL's codes from rustls's
  reasons: `CERT_HAS_EXPIRED`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`,
  `ERR_TLS_CERT_ALTNAME_INVALID`, …; with `rejectUnauthorized: false` the
  reason is kept and the connection goes on), `alpnProtocol`,
  `getProtocol()` (TLSv1.2 or 1.3), `getCipher()`, and
  `getPeerCertificate()`: its `raw` DER, `subject`, `issuer` and
  `subjectaltname` (not its dates, fingerprints or serial).
- `checkServerIdentity`, the option and the exported one (Node's rules),
  once rustls has authorized the certificate; a connection that closes
  before the handshake is `ECONNRESET`, as Node's. The tailnet's
  `https.request` (`net.ts`'s own TLS) asks it too; by the gateway's
  `fetch()`, the browser checks the certificate and it is not asked.
- Not yet: `tls.createServer`, sessions and resumption, `rootCertificates`'
  PEMs, a certificate's dates.

### fetch (`fetch.ts`)

The global `fetch` is Node's, as undici's is: a request by the process's
own `http` and `https`, not the browser's `fetch`. So
`fetch('http://localhost:3000')` reaches another process's or a node's
server (which the browser's cannot), and HTTPS goes as `https.request`
does: through Tailscale or the restricted relay with the process's own
TLS, otherwise through the exec frame's browser fetch under CORS rules. Redirects are followed as fetch's, gzip
and deflate answers decompressed. All of the caller's headers are sent
(`Cookie`, `Origin`, `Accept-Encoding`, …: the browser's `Request` would
drop them), and an abort rejects, or errors the body, with the signal's
reason. It holds the loop from its call until
its body is read to its end, cancelled, or a body method (`text()`, …) has
settled (the browser's settle a task or more after the last bytes). `data:` and `blob:` URLs, and a worker thread's `fetch`, are
the browser's, which [the worker's policy](#the-workers-policy) lets
reach only the site's runtime files.

### Other hosts: the tailnet ([tailscale.md](tailscale.md))

As a node's, a process's network beyond the machine goes through the
user's tailnet, through the IDE's page's gates (`tailnet.ts`), and is out
of reach without it:

- **Names:** `dns` sends DNS messages to the node's DNS (`{ op: 'dns',
  ref, query }`, `runtime/dns.ts`): Tailscale's resolver, else NXDOMAIN
  at once (`ENOTFOUND`). The machine's own names and addresses stay
  local. A worker thread resolves only those.
- **TCP:** `net.connect` (and `http.request`) to another host looks the
  name up, then asks for a connection to the address (`{ op: 'connect',
  id, port, host, via: 'tcp' }`), which `exec/host.ts`'s `dial` opens
  through the tailnet and pipes; `connected` carries the device's end
  (`socket.localAddress`), `refused` the error's code (`ENETUNREACH`
  without Tailscale, and the setup hint; `ECONNREFUSED`, `ETIMEDOUT`),
  and `reset` a connection that broke off on the way (`ECONNRESET`, not
  an `'end'`).
- **UDP:** `dgram` sockets bind ports of the project's UDP (`udp-bind`,
  0 a free one), shared with the nodes' (`node.udpPorts`); a datagram to
  the machine's own address goes to a process's port or a node's, or to
  the node's DNS on 53, from 127.0.0.1; to another host, through the
  tailnet (`tailnet.ts`'s `udp`, one route per process: its answers come
  back to the port they were sent from); dropped without it. A send
  without a port on a socket not (or not yet) connected is
  `ERR_SOCKET_BAD_PORT`, as Node's.

What files.js reports changed (every 200 ms at most) the exec frame's
worker passes on
to each process (`{ kind: 'changed', paths }`), whose watchers emit
Node's events. Vite's dev server (`npm run dev`) on a React app: its
page in the preview some 3 s after the command in Chromium, 4–5 s in
Firefox and WebKit; an edit saved in the editor reaches its watcher
(chokidar) and the page updates in place over its WebSocket (React Fast
Refresh), through the bridge's WebSocket as LiveView's goes.

## Coding agents

Pi (`@earendil-works/pi-coding-agent`) runs in the terminal. It uses raw
input for its TUI and project tools for reading, editing, writing, and
shell commands. Its API requests use the same HTTPS routing as other
Node.js programs: Tailscale, the restricted relay for allowed hosts, or
browser fetch when CORS permits it. Authentication requirements still
come from the provider. Pi can continue without its optional `fd` binary
when that download is unavailable.

What it needed: `http2`'s constants, `worker_threads.markAsUncloneable`,
`process.getBuiltinModule` and `performance.markResourceTiming` (undici's,
as it loads and as its fetch ends), Node's `fetch`, `tls.connect` by the
gateway, and what undici's fetch leans on as Node's has it: `finished()`
on a web stream, `nextTick`'s order, a closed connection read to its
end, and a connection the gateway keeps open for the next request. Codex's
npm package is a native binary (Rust); opencode needs Bun.

### Claude Code (`claude`, `programs/claude/claude.ts`)

Claude Code's npm package is a Bun executable containing Bun's runtime
and Claude Code's JavaScript module graph. The `claude` command extracts
and runs that JavaScript on the playground's Node implementation. The
site does not host Claude Code's files.

- **Version:** `CLAUDE_CODE` in `programs/claude/build.ts` pins a tested
  version, including the linux-x64 tarball URL and integrity hash. Site
  releases update this version.
- **First run:** the claude frame's worker downloads the 125 MB tarball
  from the npm registry. It computes the SHA-512 hash while streaming the
  download and checks it against the pinned integrity hash. It also
  decompresses the gzip stream and extracts the executable from the tar
  archive. `programs/claude/bungraph.ts` parses Bun's undocumented module
  graph format, validates the layout, and reports an error for unsupported
  binaries. Bun's loader byte identifies JavaScript modules. The parser
  rewrites imports between modules as relative paths and maps Bun's
  `import.meta.require` and `import.meta.dir` to their Node equivalents.
  It decompresses zstd assets and omits native addons. esbuild-wasm's
  `transform` compiles each module to CommonJS separately because bundling
  the whole graph exceeds wasm's memory limit. The loader's usual
  compiler, sucrase, misinterprets labels and private names in a minified
  module as imports. Preparation takes about 22 seconds in Chromium.
- **Cache and execution:** the
  [claude frame](frames.md#the-claude-frame) prepares and caches files on
  a separate origin. All projects share its `playground-claude-code`
  IndexedDB database. The cache key includes the package version and
  `LAYOUT`, which identifies the generated file format; obsolete entries
  are removed. Subsequent projects reuse the cached files. Each run
  loads the files into `files.js` memory at `/opt/claude-code/VERSION`,
  outside the persisted `/work` directory, and runs `cli.js` with `node`.
  `nodejs/claude/bun.ts` installs Bun globals for that process, including
  `Bun.stringWidth`, `wrapAnsi`, `sliceAnsi`, `which`, `hash`, `semver`,
  `YAML`, and `TOML`. Requiring a text file returns its contents.
  `XMLHttpRequest` is removed so axios uses Node's `https` implementation.
  A cached run of `claude --version` takes about 0.4 seconds.
- **Terminal UI:** Claude Code's terminal renderer uses
  `Bun.ant.CellSegmenter`, an API in Anthropic's Bun build.
  `nodejs/claude/cellsegmenter.ts` implements the behavior the renderer
  requires. It uses `Intl.Segmenter` and string-width to split text,
  including SGR and OSC 8 sequences, into grapheme cells and style runs.
  It paints these into the renderer's screen, handling tabs and spacer
  cells for wide characters. Overwriting either half of a wide character
  clears the other half.
- **Shell:** the playground provides a `bash` stand-in backed by brush.
  It translates `bash -c -l LINE` to `sh -c LINE` and responds to
  `bash --version`. The Linux build of Claude Code passes an open file
  descriptor as a child command's stdout, then immediately closes the
  parent's descriptor. The child continues writing through its own copy.
  Claude Code also uses `/proc/self/fd/N/…` to write into an open directory
  and `/proc/self/fd/N` to run `rg`. `fs.ts` and `child.ts` resolve these
  paths to the paths used when opening the descriptors.
  A pipeline's commands run at once, as processes joined by pipes
  ([runtime.md](runtime.md#processes-processests)). `node` streams both
  ways (`yes | node …`, `node … | head`); a node (`mix`, `elixir`) takes
  its input whole and cannot wait for room in a pipe: each way, 16 MiB at
  most ahead of the other end, so `yes | mix …` fails with an error once
  16 MiB came.
- **Search:** `claude` passes `--allowedTools=Glob,Grep` to enable the
  Glob and Grep tools, which use `rg`. Without this flag, the pinned build
  replaces them with bfs and ugrep, embedded in its executable and invoked
  with commands such as `exec -a bfs "$CLAUDE_CODE_EXECPATH"`. Neither
  brush nor Node can run these embedded programs. GNU `find` and `grep`
  are available as separate shell commands, but they do not implement
  those embedded executable entry points.
- **Network access:** without the tailnet, `api.anthropic.com` and
  `platform.claude.com` go through the site's TCP relay
  ([relay.md](relay.md)), with the process's own TLS: the settings
  endpoint (`/api/claude_code/settings`) and the OAuth host's
  `/api/hello` send no CORS headers, only the Messages API does. Without
  relay, the gateway falls back to `fetch()`. API-key requests to the
  Messages API can work, but OAuth requests and endpoints without CORS
  support fail. Interactive mode exits if its connectivity check fails.
  `claude` defaults `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` to `1`
  unless the environment specifies a value.

Supporting Claude Code required `/proc/self/fd/N` paths, child output to
file descriptors, `path/win32`, `stream/consumers`, `fs.realpath.native`,
and `FileHandle.sync`. Directories must support `O_DIRECTORY` and
`O_NOFOLLOW` and report ownership by the process's uid; Claude Code
rejects temporary directories owned by another user. Module resolutions
are cached as in Node, avoiding about 90 lookups per module, each a call
to `files.js`. The event loop waits for two idle tasks before exiting so
the browser can report unhandled promise rejections.

## Tests

- `nodejs.spec.ts`: scripts, CommonJS and ES modules, a package by its
  exports, top-level await, TypeScript, an uncaught error's stack and
  status, `System.cmd("node", …)`.
- `npm.spec.ts`: install (and the lock), a package with a tree of its own
  and a bin, `npx`, `npm run` with a pipe, `npx` of a package the project
  lacks, up to date.
- `npm.test.ts` (unit, a stubbed registry): the tree's layout; npx of an
  exact version again, and an install from a lock, after a reload
  without the registry (another platform's build and a missing
  WebAssembly build too); `npm install NAME` asking for NAME alone; a
  locked version no longer allowed fetched again. `embed.spec.ts`
  counts the registry's requests after a reload of a kept project: none
  for `npx -y @agentclientprotocol/claude-agent-acp@0.85.1` and `npm
  install`, picocolors' alone for `npm install picocolors`.
- `vite.spec.ts`: a React app built with `npm run build`; `npm run dev`
  in the preview, an edit saved in the editor updating it in place (no
  reload), and Ctrl+C ending the server.
- `nodenet.spec.ts`: `pg` against the project's Postgres; `http.get` and
  a chunked POST between processes; a page Vite serves fetching `/api`
  through Vite's proxy to a backend; a process's `http.get` to a node's
  `:gen_tcp` server, and a node's `:httpc` to a process's server;
  `https.get` of hex.pm's API by fetch, and a site without
  CORS answering 502; without Tailscale, `net.connect` to an address
  (`ENETUNREACH`), `dns.lookup`, `resolve4` and an `http.get` by name
  (`ENOTFOUND`), at once; `dgram` between processes, a node and a process
  both ways, a DNS query to 127.0.0.53 (NXDOMAIN), and a datagram to
  another host dropped.
- `tailscale.spec.ts` (with `tests/headscale.sh`'s tailnet): a process's
  `dns.lookup` (a MagicDNS short name too), `net.connect` by name (its
  local address the device's), `http.get` by name, and a DNS query to
  1.1.1.1 over `dgram`, out of the exit node; its TLS: `https.get` of
  www.example.com (no CORS headers: 200 and its page), `tls.connect` with
  ALPN (authorized, TLS 1.3, h2), expired.badssl.com refused
  (`CERT_HAS_EXPIRED`) and, with `rejectUnauthorized: false`, let through
  unauthorized; Pi with a key that is none, Anthropic's API answering its
  request (`authentication_error`). Its Caddy holds port 8091, so the
  worktree runs it with `PORT=8095`.
- `stdin.spec.ts`: a process reads typed lines and Ctrl+D's end,
  answers readline's question, reads raw keys (a letter, an arrow,
  Ctrl+C as a key) and leaves the terminal the shell's again, and reads a
  pipe's bytes and their end (`isTTY` false then).
- `create.spec.ts`: `npm create vue@latest`, its questions answered at
  the terminal (the name, TypeScript, the features), installed (157
  packages) and built (`run-p`'s `vue-tsc --build` and
  `vite build`, its CSS minified by lightningcss-wasm); `npx sv create`
  (a minimal SvelteKit project in TypeScript), installed and built
  (TypeScript's compiler by `import()`, zlib). Each about 30 s.
- `nodenet.spec.ts`'s fetch: another process's server on localhost (a
  POST, a redirect followed, a gzip answer), and hex.pm's API by HTTPS;
  without Tailscale, Anthropic's API by Node's `fetch` and by Pi, a key
  that is none refused (`authentication_error`).
- `claude.spec.ts`: `claude --version` (from the registry, then kept),
  `claude -p` against a mock of Anthropic's API on a project port (its
  Bash tool through brush, its Write tool), and its terminal UI drawing;
  with a Headscale, interactively through the tailnet to its onboarding.
- `child.spec.ts`: `execSync`'s output, `input` into a Node.js child,
  `spawnSync`'s status, `execSync` throwing, `ENOENT`, an asynchronous
  child's stdin, and `kill()`. `embed.spec.ts`: a child with `stdio:
  'inherit'` under a tty spawn sees `isTTY` on its three streams and the
  terminal's size, hears a resize, and reads one raw key; its parent's
  mode is cooked again after (`child.test.ts`: which streams a spawn says
  it inherits).
- `nodepolicy.spec.ts`: a script's ways around the process's messages,
  each refused ([the worker's policy](#the-workers-policy)): the
  browser's `fetch`, a synchronous `XMLHttpRequest`, `import()` of a
  `data:` module, `WebSocket`, `EventSource`, a `Worker` from the build's
  `worker.js` (which WebKit refuses even without the policy), `caches.add`,
  and a thread's `XMLHttpRequest`; `tls.rootCertificates` still read.
- `coreutils.spec.ts`: `System.shell` with pipes, `||`, variables,
  redirections and `node`; `rg` at the shell (an `.ignore`d directory
  left out), in a pipe, from `execSync` and from `System.cmd`.

## Next

1. A pool of kept connections for `http.Agent({ keepAlive })` (and
   `fetch`'s); `fd` in WebAssembly beside `rg` (its walker's threads).
2. `child_process`'s rest: fork's IPC, brotli in
   `zlib`; more entries in npm's `STAND_INS` as projects need them
   (`@swc/core` → `@swc/wasm`, `rollup` → `@rollup/wasm-node`,
   `sass-embedded` → `sass`), each checked by hand.
3. A Phoenix project whose assets are a Vite app.
4. A REPL (`node` alone); a test of a resize and of a TUI (Ink).
5. `fs.watch` in a worker thread (only a process hears the changes); a
   worker thread's `fetch` of an `http(s)` URL is the browser's, which
   the policy now refuses and which, without it, did not settle (the
   exec origin's own page, Firefox in 20 s, Chromium in 3 s): Node's
   instead, over the process's messages.
6. TLS's rest: a certificate's dates and fingerprints, session
   resumption, `tls.createServer`; tls.wasm compiled once by the exec
   frame (as `beam.wasm` is) rather than once per process.
