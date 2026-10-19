---
kind: design
status: experiment
last_updated: 2026-10-19
---

# Node.js in the playground

An experiment on the `worktree-node` branch: `node`, `npm` and `npx` in a
project's terminal and from its nodes, with scripts on the page's own
JavaScript engine rather than an engine compiled to WebAssembly (which
could not JIT). Node's modules are the playground's own
(`app/src/runtime/nodejs/`), over the project's files. A React project
installs and builds with Vite in Chromium, Firefox and WebKit
(`app/test/e2e/vite.spec.ts`).

## A process (`nodejs.js`, `programs/nodejs.ts`)

`node` is a page program: each process is a worker of its own (the
runtime's entry `nodejs/index.ts`, built as `nodejs.js`), started with a
channel to the shared files (`Files.connect()`), as a node's worker is. Its
output and exit come back as messages; closing its port (Ctrl+C) stops the
worker. `/usr/bin/node` is a stand-in, so `System.cmd("node", …)` finds it,
and the shell runs a script whose first line names `node` (a package's bin
in `node_modules/.bin`) with it.

| File | What it is |
| --- | --- |
| `index.ts` | The entry: `node`'s flags (`-e`, `-p`, `-r`, `--version`), a script or a thread, the globals (`process`, `Buffer`, `console`, timers, Node's `MessageChannel`, assignable `self` and `navigator`), uncaught errors and rejections. |
| `fs.ts` | `fs` over the channel: the synchronous calls as they are, the callback and promise forms on top; Node's error codes from WASI's. `watch` is there and quiet. |
| `loader.ts` | `require` with Node's resolution (paths, `node_modules` and `NODE_PATH`, `package.json`'s `main`, `exports` and `imports`, one condition set for both: `node`, `import`, `require`, `module-sync`, `default`). CommonJS in Node's wrapper; ES modules and TypeScript turned into CommonJS by sucrase, so a module loads synchronously however it is required or imported. `import()` answers namespaces as Node's does and holds the loop. |
| `source.ts` | A scan of code, strings, templates, comments and regular expressions: the loader's rewrites (`import.meta`, `require(`, `import(`, `exports."…"`) touch code alone. |
| `process.ts` | `process`, `console`, timers. The process ends when nothing holds its loop, as Node's: timers, intervals, immediates, pending `import()`, workers and ports that are ref'd; promises are not. |
| `threads.ts` | `worker_threads`: a `Worker` is a nested worker running `nodejs.js` as a thread of the same process, sharing its files channel (one call at a time, by a lock in shared memory); messages as structured clones (shared memories, WebAssembly modules); a thread's output and uncaught error go to its parent. Node's `MessageChannel`: ports with `ref`/`unref` and `on('message')`. |
| `wasi.ts` | `node:wasi` over the runtime's WASI (`wasi/index.ts`), on the shared files. |
| `builtins.ts`, `util.ts`, `path.ts`, `buffer.ts` | The other core modules: `path`, `util` (`format`, `inspect`, `promisify`, `parseEnv`, …), `events`, `stream` (readable-stream), `os`, `url`, `assert`, `tty`, `readline`, `vm`, `async_hooks`, `perf_hooks`, `timers/promises`, `module`, `crypto` (random values only), `Buffer` with `base64url`. |

Stacks print as Node's (`at f (file:line:col)`) whatever the engine wrote,
without the runtime's own frames.

**What is missing** says so when called: `http`, `https`, `net`, `dns`,
`tls` (no sockets yet), `child_process`, `zlib`, `crypto.createHash` and
the rest of `crypto`, `fs.watch` events. There is no REPL, and a process
reads no standard input (`process.stdin` ends at once).

## npm and npx (`programs/npm.ts`)

The page's own npm, not npm's CLI (which would need `http`, `zlib`, `crypto`
and `child_process`, and load a thousand modules per run): `npm install`
(and `ci`, `add`, `-D`, `-E`, `--no-save`), `npm run` (and `test`,
`start`), `npm exec`, `npm init`, and `npx`.

- **The registry** is fetched by the page: registry.npmjs.org sends CORS
  headers on metadata and tarballs; it answers no preflight, so requests
  carry only simple headers (the abbreviated metadata's `Accept` is one).
  Tarballs are checked against their integrity and kept in Cache Storage
  (`playground-npm`). Private registries and git or `file:` dependencies
  do not install.
- **The tree** is laid out as npm lays it out (each package as high as it
  goes without another version in the way); a `package-lock.json`'s
  versions are kept where they still satisfy, and one is written
  (lockfileVersion 3). Bins are links in `node_modules/.bin`
  (`Files.symlink`). Extraneous packages are not pruned.
- **Platforms:** packages for another os or cpu are left out, matched as
  `os: linux`, `cpu: wasm32`. napi-rs packages list only their native
  builds; npm adds their `PREFIX-wasm32-wasi` build beside them (Rolldown's
  binding). Install scripts do not run (npm says which packages had one).
- **`npm run`** runs a script with the page's `sh` (brush, below), with
  `node_modules/.bin` on `PATH` and npm's `npm_*` variables; `npx` runs a
  project's bin, or installs the package into `~/.npm/_npx` first.

## A node's sh -c is brush

`sh -c LINE` (`System.shell`, `open_port`'s spawn, npm's scripts) starts a
worker whose brush runs the line without its line editor, dispatching
commands as the terminal's shell does: pipes, `||`, `;`, variables,
redirections; node commands in that worker, page programs, coreutils.
`sh.ts`'s `commands()` remains only for the Node harness (no page).
`System.shell("true")` takes some 70–220 ms, mostly the worker's start
(it builds its tree from the page's boot tars).

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

## Tests

- `nodejs.spec.ts`: scripts, CommonJS and ES modules, a package by its
  exports, top-level await, TypeScript, an uncaught error's stack and
  status, `System.cmd("node", …)`.
- `npm.spec.ts`: install (and the lock), a package with a tree of its own
  and a bin, `npx`, `npm run` with a pipe, `npx` of a package the project
  lacks, up to date.
- `vite.spec.ts`: a React app built with `npm run build`.
- `coreutils.spec.ts`: `System.shell` with pipes, `||`, variables,
  redirections and `node`.

## Next

1. **Vite's dev server**: `http.createServer` and `net` on the runtime's
   TCP (`wasi/net.ts`, the page's `bridge.ts`), so a port a Node process
   listens on shows in the preview, as a node's does; then `fs.watch`
   (files.js reports changes already) and Vite's WebSocket for HMR.
2. `child_process` through the page's programs (as `npm run` runs `sh`),
   `zlib` (DecompressionStream is asynchronous; synchronous inflate needs a
   library), `crypto.createHash`.
3. A Phoenix project whose assets are a Vite app.
4. Standard input for a process (the terminal's typing; a pipeline's
   input), and a REPL.
