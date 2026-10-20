---
kind: design
status: experiment
last_updated: 2026-10-20
---

# Node.js in the playground

An experiment on the `worktree-node` branch: `node`, `npm` and `npx` in a
project's terminal and from its nodes, with scripts on the browser's own
JavaScript engine rather than an engine compiled to WebAssembly (which
could not JIT). Like the nodes, they run in the project's exec frame, on
the usercontent domain ([frames.md](frames.md)). Node's modules are the playground's own
(`app/src/runtime/nodejs/`), over the project's files. A React project
installs and builds with Vite, and its dev server shows the app in the
preview and hot-updates it on an edit, in Chromium, Firefox and WebKit
(`app/test/e2e/vite.spec.ts`). `npm create vue@latest` asks its questions
at the terminal and its project builds; the coding agent Pi runs, and
through a tailnet talks to its provider's API (below).

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
| `fs.ts` | `fs` over the channel: the synchronous calls as they are, the callback and promise forms on top; Node's error codes from WASI's. `watch`, `watchFile` and `promises.watch` hear what changed (below). |
| `loader.ts` | `require` with Node's resolution (paths, `node_modules` and `NODE_PATH`, `package.json`'s `main`, `exports` and `imports` with Node's conditions: `node`, `require` or `import`, `module-sync`, `default`; a require that finds no entry of its own takes the import one). CommonJS in Node's wrapper; ES modules and TypeScript turned into CommonJS by sucrase, so a module loads synchronously however it is required or imported. `import()` answers namespaces as Node's does and holds the loop. |
| `source.ts` | A scan of code, strings, templates, comments and regular expressions: the loader's rewrites (`import.meta`, `require(`, `import(`, `exports."…"`) touch code alone. |
| `process.ts` | `process`, `console`, timers. The process ends when nothing holds its loop, as Node's: timers, intervals, immediates, pending `import()`, workers and ports that are ref'd; promises are not. Dry for eight turns in a row, not one, and a read of a web stream or a body (a stream's `read`, `pipeTo`, `text()`, …) holds it until it settles, a second at most: what the browser does for a script holds nothing else (its streams pass bytes on over tasks), where Node's native work would hold its loop. |
| `fetch.ts` | The global `fetch`, Node's: by the process's own `http` and `https` (below). |
| `threads.ts` | `worker_threads`: a `Worker` is a nested worker running `nodejs.js` as a thread of the same process, sharing its files channel (one call at a time, by a lock in shared memory); messages as structured clones (shared memories, WebAssembly modules); a thread's output and uncaught error go to its parent. Node's `MessageChannel`: ports with `ref`/`unref` and `on('message')`. |
| `wasi.ts` | `node:wasi` over the runtime's WASI (`wasi/index.ts`), on the shared files. |
| `net.ts`, `http.ts` | `net.Server`, `net.Socket` and `net.connect` on the project's ports, and to other hosts through the tailnet (below); `http.createServer` over them: requests with a body by length or in chunks, kept connections, `upgrade` (a WebSocket), responses with Node's header calls, by length or in chunks; `http.request` and `get`, each on a connection of its own (no pooling), with `upgrade` too; `https.request` and `get`, the same over HTTPS the exec frame carries (below). |
| `tls.ts` | `tls.connect` and `TLSSocket`: rustls built to WebAssembly (`tls/`, below), over a socket it opens or one it is given. |
| `dns.ts`, `dgram.ts` | `dns` (`lookup`, `resolve4`/`6`, CNAME, MX, NS, SRV, TXT) by the node's DNS; `dgram` on the project's UDP ports (below). |
| `hashes.ts` | `crypto.createHash`, `createHmac` and `hash` (md5, sha1, sha2, ripemd160), synchronous, by `@noble/hashes`. |
| `child.ts` | `child_process` (below). |
| `zlib.ts` | `zlib` by fflate: gzip, deflate and raw deflate, and unzip, synchronous, with callbacks and as streams; `crc32`; brotli named, and missing when called. |
| `builtins.ts`, `util.ts`, `path.ts`, `buffer.ts` | The other core modules: `path`, `util` (`format`, `inspect`, `promisify`, `parseEnv`, `parseArgs`, …), `events`, `stream` (readable-stream), `os`, `url`, `assert`, `tty`, `readline`, `vm`, `async_hooks`, `perf_hooks`, `timers/promises`, `module`, `crypto` (random values and hashes), `Buffer` with `base64url`. |

Stacks print as Node's (`at f (file:line:col)`) whatever the engine wrote,
without the runtime's own frames.

**What is missing** says so when called: an HTTPS server and
`tls.createServer`, `child_process`'s synchronous forms, brotli in
`zlib`, ciphers and keys in `crypto`, HTTP/2 (its constants are there,
which clients read as they load). There is no REPL (`node` alone).

## Standard input and the terminal

A process reads what is typed at the terminal, as a node does, through
the IDE's line discipline (`runtime/terminal.ts`):

- **Lines:** cooked, the line discipline echoes and edits a line, and the
  process gets it at Enter; Ctrl+D on an empty line is the end of its
  input. While the shell runs a page program (`runOnPage` in
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
  the terminal too.
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
  goes without another version in the way); a `package-lock.json`'s
  versions are kept where they still satisfy, and one is written
  (lockfileVersion 3). Bins are links in `node_modules/.bin`
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
  project's bin, or installs the package into `~/.npm/_npx` first.

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
did not find (127) is spawn's `ENOENT`. `kill()` stops the child's node
(which a closed port alone leaves running, as a node's port's program
does), its status a SIGTERM's.

- A page program has one output: a child's stderr comes on its stdout.
- What the program writes to `child.stdin` is the child's input, and
  `end()` its end (its `sh -c` node passes it on to what it runs).
- `stdio` may name a stream, such as `process.stdout` itself (npm-run-all2
  does on a TTY): the child's output goes there.
- **`spawnSync`, `execSync`, `execFileSync`:** the spawn carries a
  SharedArrayBuffer of `maxBuffer`'s size (Node's 1 MiB; more is
  `ENOBUFS`), which the exec frame fills with the child's output and then
  its status, and the process waits on it (`Atomics.wait`), standing
  still meanwhile as Node's does. `input` is the child's stdin and then
  its end; `timeout` stops it (`ETIMEDOUT`); with `stdio: 'inherit'` its
  output is the process's own as it comes. `execSync` throws on a failure,
  the result on the error (`status`, `stdout`).

## A node's sh -c is brush

`sh -c LINE` (`System.shell`, `open_port`'s spawn, npm's scripts) starts a
worker whose brush runs the line without its line editor, dispatching
commands as the terminal's shell does: pipes, `||`, `;`, variables,
redirections; node commands in that worker, page programs, coreutils.
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
Tailscale set up and the project allowed, it says `tcp`: a TCP connection
to the host through the tailnet, over which the socket does TLS itself
(`tls.ts`'s Engine, ALPN `http/1.1`, the request's or its agent's `ca`,
`cert`, `key`, `servername` and `rejectUnauthorized`), as a node's HTTPS
does: any site, CORS or not.

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
- To port 443 it asks the gateway (as `https.request` does): through the
  tailnet, its own TLS over the tunnel's TCP; without, plain HTTP to the
  gateway's `fetch()`, the browser doing the TLS (`authorized`, ALPN
  `http/1.1`). Other ports (a database's TLS) go by the tailnet alone.
- A connection the other side closed is read to its end before it is
  destroyed (`closeAfterEnd`, `net.ts`'s sockets too).
- `authorized` and `authorizationError` (OpenSSL's codes from rustls's
  reasons: `CERT_HAS_EXPIRED`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`,
  `ERR_TLS_CERT_ALTNAME_INVALID`, …; with `rejectUnauthorized: false` the
  reason is kept and the connection goes on), `alpnProtocol`,
  `getProtocol()` (TLSv1.2 or 1.3), `getCipher()`, and
  `getPeerCertificate()`'s `raw` DER (not parsed: no subject, issuer or
  dates yet).
- Not yet: `tls.createServer`, sessions and resumption, `rootCertificates`'
  PEMs, a certificate's fields.

### fetch (`fetch.ts`)

The global `fetch` is Node's, as undici's is: a request by the process's
own `http` and `https`, not the browser's `fetch`. So
`fetch('http://localhost:3000')` reaches another process's or a node's
server (which the browser's cannot), and HTTPS goes as `https.request`
does: through the tailnet with the process's own TLS, else by the exec
frame's `fetch()` (CORS's rules). Redirects are followed as fetch's, gzip
and deflate answers decompressed; it holds the loop from its call to its
body's end. `data:` and `blob:` URLs, and a worker thread's `fetch`, are
the browser's.

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
  without Tailscale, and the setup hint; `ECONNREFUSED`, `ETIMEDOUT`).
- **UDP:** `dgram` sockets bind ports of the project's UDP (`udp-bind`,
  0 a free one), shared with the nodes' (`node.udpPorts`); a datagram to
  the machine's own address goes to a process's port or a node's, or to
  the node's DNS on 53, from 127.0.0.1; to another host, through the
  tailnet (`tailnet.ts`'s `udp`, one route per process: its answers come
  back to the port they were sent from); dropped without it.

What files.js reports changed (every 200 ms at most) the exec frame's
worker passes on
to each process (`{ kind: 'changed', paths }`), whose watchers emit
Node's events. Vite's dev server (`npm run dev`) on a React app: its
page in the preview some 3 s after the command in Chromium, 4–5 s in
Firefox and WebKit; an edit saved in the editor reaches its watcher
(chokidar) and the page updates in place over its WebSocket (React Fast
Refresh), through the bridge's WebSocket as LiveView's goes.

## Coding agents

Pi (`@earendil-works/pi-coding-agent`, a Node.js bundle) runs in the
terminal: its TUI draws and reads raw keys, and with a provider's key it
works on the project with its tools (read, edit, write, bash: `sh -c` by
`child_process`). Its requests are undici's (on `net` and `tls`) and
`fetch`'s, so a model's API is reached through the tailnet; without
Tailscale, by the gateway's `fetch()` (undici's `tls.connect` to port 443
is plain HTTP to it), an API whose CORS lets a browser in: Anthropic's
does when asked (`anthropic-dangerous-direct-browser-access: true`, which
the gateway adds for `api.anthropic.com`). It looks for `fd` and tries to
download it, which fails without the tailnet; it goes on without.

What it needed: `http2`'s constants, `worker_threads.markAsUncloneable`,
`process.getBuiltinModule` and `performance.markResourceTiming` (undici's,
as it loads and as its fetch ends), Node's `fetch`, and the loop's
patience above, a closed connection read to its end, and `tls.connect`
by the gateway. Claude Code's npm package is a native binary (Bun's),
Codex's too (Rust); opencode needs Bun.

## Tests

- `nodejs.spec.ts`: scripts, CommonJS and ES modules, a package by its
  exports, top-level await, TypeScript, an uncaught error's stack and
  status, `System.cmd("node", …)`.
- `npm.spec.ts`: install (and the lock), a package with a tree of its own
  and a bin, `npx`, `npm run` with a pipe, `npx` of a package the project
  lacks, up to date.
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
- `child.spec.ts`: `execSync`'s output, `input` into a Node.js child,
  `spawnSync`'s status, `execSync` throwing, `ENOENT`, an asynchronous
  child's stdin, and `kill()`.
- `coreutils.spec.ts`: `System.shell` with pipes, `||`, variables,
  redirections and `node`; `rg` at the shell (an `.ignore`d directory
  left out), in a pipe, from `execSync` and from `System.cmd`.

## Next

1. A pool of kept connections for `http.Agent({ keepAlive })` (and
   `fetch`'s); `fd` in WebAssembly beside `rg` (its walker's threads).
2. `child_process`'s rest: a child's own stderr, the terminal for one
   that inherits stdin, fork's IPC; brotli in
   `zlib`; more entries in npm's `STAND_INS` as projects need them
   (`@swc/core` → `@swc/wasm`, `rollup` → `@rollup/wasm-node`,
   `sass-embedded` → `sass`), each checked by hand.
3. A Phoenix project whose assets are a Vite app.
4. A REPL (`node` alone); a page program's own stderr (a third
   stream); a test of a resize and of a TUI (Ink).
5. `fs.watch` in a worker thread (only a process hears the changes).
6. TLS's rest: `getPeerCertificate()`'s fields (an X.509 parser), session
   resumption, `tls.createServer`; tls.wasm compiled once by the exec
   frame (as `beam.wasm` is) rather than once per process.
