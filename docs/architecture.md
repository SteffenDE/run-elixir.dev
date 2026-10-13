---
kind: design
status: live
last_updated: 2026-10-13
---

# Architecture

Everything runs in one browser tab. Nothing on the server knows about
Elixir: a site is static files.

```
 page (React IDE, or the Elixir page)
 ├─ host.js Node ──────────────► worker.js  (one per shell / terminal tab)
 │    frames in a SharedArrayBuffer ring;      rotp.wasm over wasi.js
 │    messages back                            its own /rotp, /dev, /usr
 ├─ host.js Files ─────────────► files.js   (one; runs no node)
 │    messages                                 /work and /tmp, shared
 │                   worker.js ═══════════════► files.js
 │                   synchronous calls (SharedArrayBuffer + Atomics.wait)
 ├─ bridge.js ◄──── sw.js (service worker) ◄─── preview <iframe> (the app)
 ├─ postgres.js ─── PGlite (Postgres in WebAssembly)
 └─ page programs: tailwind (programs/tailwind.ts)
```

## The node

A node is one Rust-OTP instance: `rotp.wasm` instantiated in a Web Worker
(`runtime/worker.js`) with the WASI imports from `runtime/wasi.js`. The node
sees an ordinary filesystem, TCP, child processes, a clock, random bytes and a
terminal. All of them are the shim's.

- **One scheduler.** WASI has no threads, so the node runs one scheduler, and
  the worker is busy for as long as the node runs. Its event loop does not
  turn. Everything that must reach a running node goes through shared memory:
  input, network data, interrupts and the output of page programs. The worker
  reads it whenever the node polls, sleeps or reads the clock.
- **The shell.** A worker runs a small shell. `elixir`, `iex`, `mix` and `erl`
  each start a fresh instance of the compiled module, as a Unix shell starts
  processes; `cd`, `ls`, `cat`, `mkdir`, `rm`, `echo`, `clear` and `help` are
  builtins. Ctrl+C makes the next poll throw out of the instance.
- **One node per worker.** A worker cannot interleave two nodes, so each
  terminal tab is a worker of its own.

## Files

- **`/rotp`** is the Rust-OTP installation (OTP, Elixir, Mix, Hex, phx_new).
  Every worker has its own copy: the boot tarball unpacked, the rest fetched
  in bundles on first use (see [build.md](build.md)).
- **`/work` and `/tmp`** live in `runtime/files.js`, a worker that runs no node
  and so is always free to answer. Nodes reach it synchronously: `wasi.js`
  sends each call on those paths through a SharedArrayBuffer channel and
  waits with `Atomics.wait`. The page reaches it with messages (the IDE's
  tree and editor), and hears every change from it. What one shell writes,
  every other shell and the page see.

## How a preview request reaches Phoenix

1. The preview iframe asks for `/posts`. The service worker (`runtime/sw.js`)
   answers only the preview's requests: iframe navigations, and requests
   from clients it has seen to be nested frames. Everything else goes to the
   network directly.
2. The service worker sends the request to the playground page (it finds the
   page again after a restart).
3. `runtime/bridge.js` on the page opens a connection to port 4000 of the node
   that listens there. Nodes report their listening ports, and the IDE
   routes by them. The request goes in as HTTP/1.1, with the cookies the
   bridge keeps (a service worker's responses cannot set cookies).
4. Bandit answers in the node; the response comes back the same way. HTML
   gets `window.WebSocket` removed, so LiveView falls back to long polling,
   which works through the service worker.

## The database

Postgrex connects to `localhost:5432`. That port is served on the page:
`runtime/postgres.js` hands whole wire-protocol messages to PGlite's
`execProtocolRaw`, one connection at a time. PGlite is a single session, so
the app's pool has one connection. The data lives in memory, for the life of
the tab.

## Programs

When the node spawns a program (`open_port`, `System.cmd`), the shim runs a
JavaScript one instead:

- **In the worker, synchronously:** `git`, as far as Mix asks a git
  dependency.
- **On the page, asynchronously:** `tailwind`. The worker forwards the spawn,
  and output and exit come back as frames.

The node presents itself as Linux x86_64, so the Hex `esbuild` and `tailwind`
packages look for their binaries at `_build/esbuild-linux-x64` and
`_build/tailwind-linux-x64-VSN`. Empty files there stand for the
playground's programs.
