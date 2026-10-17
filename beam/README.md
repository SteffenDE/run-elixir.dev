# Real BEAM in WebAssembly (experiment)

An experiment on branch `sd-beam`: OTP's own emulator (erts) built with
Emscripten, as the playground's runtime beside Rust-OTP
(`playground/runtime`). A site is built for one of them
(`PLAYGROUND_RUNTIME=otp`, below); Rust-OTP stays the default.

## Provenance

`patches/0001` to `0014` and `emscripten/` are copied unchanged from
[Popcorn](https://github.com/software-mansion/popcorn) (Software Mansion,
Apache License 2.0), `popcorn/patches` and `popcorn/emscripten` at commit
`a64cbbc23cf1244a27d69a6d684e10c5040aa0e6`. Popcorn wrote them for
OTP-29.0.6; all fourteen apply in order to OTP-29.1.1, our host version.
`build.sh` follows Popcorn's `scripts/build-beam.sh`, and `openssl.sh` its
`build-openssl.sh`. Patches 0015 to 0021 are ours.

| Patch | Effect |
| --- | --- |
| 0001 emscripten-support | configure detects `wasm32-*-emscripten`, `ERTS_EMSCRIPTEN` |
| 0002 without-zstd | drops zstd from erts and stdlib |
| 0003 without-native-sockets | no inet driver sockets (0016 brings TCP back) |
| 0004 without-distribution | no `dist.c`, `net_kernel` stubs |
| 0005 without-crash-dumps | no crash dump writer |
| 0006 without-dynamic-loading | no `dlopen` for drivers and NIFs (0021 loads wasm NIFs) |
| 0007 bootstrap-trim | smaller native bootstrap |
| 0008 driver-start-callbacks | driver start hooks |
| 0009 signal-shutdown | shutdown without signals |
| 0010 disable-os-processes | no `open_port({spawn, ...})` (0018 replaces the driver) |
| 0011 wasm-bridge | `wasm` module and NIF, JS callbacks, TTY over JS |
| 0012 asn-one-erlang-fallback | asn1 without its NIF |
| 0013 module-checksum-xxh | module MD5 replaced by xxhash |
| 0014 no-jump-table | interpreter without computed goto |
| 0015 wasm-process-main-returns | `process_main` returns at each schedule |
| 0016 wasm-prim-socket | our `prim_socket` NIF (`socket/`), `host/*.c` linked into erts |
| 0017 wasm-tty-mode-eof | the terminal's raw mode told to JS, the end of standard input |
| 0018 wasm-spawn-driver | `spawn_driver_entry` is `host/wasm_spawn.c`'s; `erl_init` starts its pump |
| 0019 wasm-system-architecture | `system_architecture` from `ROTP_SYSTEM_ARCHITECTURE` |
| 0020 playground-https | `ssl:connect` through the page's fetch (`PLAYGROUND_HTTPS_GATEWAY`) |
| 0021 wasm-nif-libraries | `load_nif` of a library built to WebAssembly (`host/wasm_nifs.c`) |

Patch 0015: V8 moves a WebAssembly function to optimized (TurboFan) code
only when it is next called, and a scheduler thread entered
`process_main`, the interpreter loop, once for good: it ran as baseline
(Liftoff) code, 64% of a profile. Returning at each schedule and being
called again in a loop made compiling Ash 5.2 times as fast.

## Build

Needs emsdk 6.0.2 (Popcorn's CI's, at `~/emsdk`), host Erlang 29.1.1,
autoconf 2.72, and network access the first time.

    OTP_SOURCE=~/src/otp-29.1.1 OPT=-O2 DIST=out/beam-wasm/site playground/beam/build.sh release

`build.sh` runs `openssl.sh` (OpenSSL 3.0.15, for crypto, ssl and asn1,
their NIFs linked in) and `ncurses.sh` (libtinfo with its terminals
compiled in: prim_tty takes raw input, which IEx's line editing needs,
only with termcap), clones OTP into `out/beam-wasm/<debug|releaseO2>/otp`,
applies the patches (a commit each), copies `socket/` and `host/`'s C into
the tree, and builds. A mode's tree keeps its stamps: changed patches
clone it again, changed configure arguments configure again. `DIST` gets
`beam.wasm` (4.9 MB), the loader `beam.mjs`, the threads' `beam.emu.mjs`,
and `otp/`, the installation (each application's `ebin`, `priv` and
`include`, `bin/start.boot`). The link: pthreads with `PROXY_TO_PTHREAD`,
mimalloc, 4 GB, PROXYFS, and the JS libraries of `socket/`, `host/` and
`emscripten/`. `EXTRA_LINK` adds flags (`-sNODERAWFS=1` for `elixir.mjs`).
No `-O2` in a tree's path: erts' `zlib.mk` rewrites it in CFLAGS.

## In the playground

    PLAYGROUND_RUNTIME=otp python3 -I playground/runtime/build.py
    PLAYGROUND_RUNTIME=otp python3 -I playground/runtime/build.py app

`build.py` builds the site for this BEAM: `beam.mjs`, `beam.emu.mjs` and
`beam.wasm` in place of `rotp*.wasm`, `runtime.json` naming the runtime,
and an installation laid out as Rust-OTP's, at `/rotp` in the node
(`target/otp`: OTP from the dist, the host's Elixir, Hex and phx_new
archives and rebar3). The template is built by the host's Mix
(`_build_otp`, in `target/playground-cache-otp`); the boot images are
recorded on this BEAM. `node.ts` runs such a site under Node (the
recording runs); the browser's worker runs it when `runtime.json` says
`otp` (`worker/beam.ts`). Both go through `app/src/runtime/beam/run.ts`;
`beam/args.ts` turns erl's arguments into the emulator's.

- **Threads.** The module's main thread is the node's worker; erts' threads
  are its pthreads, and each file and network call they make is proxied
  to the worker, which must not block while the node runs: it takes the
  page's frames as they come (`Atomics.waitAsync`). WebKit's waitAsync
  wakes some 60 ms late (a node took a minute to start): there the worker
  runs the proxied calls on a MessageChannel tick while the node runs.
- **Memory.** On Emscripten `mmap` is malloc, whose heap erts' carriers
  fragment past any limit (below); each node has a 1 GB super carrier
  (`-MMscs 1024 -MMsco false`), which Emscripten zero-fills at start.
- **Files.** PROXYFS mounts the node's tree (`beam/treefs.ts` over
  `wasi/fs.ts`, lazily fetched files and all) at each top directory but
  Emscripten's `/dev` and `/proc`, and `/work` and `/tmp` from files.js
  (`beam/sharedfs.ts`). Hard links go through the trees (`host/host.js`;
  Emscripten's always fail). Files are executable (`os:find_executable`).
- **Network.** `gen_tcp` is `gen_tcp_socket` over our `prim_socket` NIF
  (`socket/`, below) over the playground's `Network`. A project's nodes
  reach each other's ports through the page (Mix's compile notices go
  so). HTTPS: `ssl:connect` connects to a gateway port whose first line
  names the host; the page answers its plain HTTP with fetch (patch 0020).
- **Ports.** `host/wasm_spawn.c` runs the playground's programs
  (`spawn.js`, the host's `Module.beamSpawn` over Rust-OTP's `Process`
  and programs); `{spawn, Command}` is `/bin/sh -c`. Output and exit come
  through a ring to the driver's event thread, which asks `erl_init`'s
  `wasm_port_pump` to `port_control` the port, where they are delivered.
- **NIFs.** A library built to WebAssembly by `playground/nif` (wasi-sdk,
  `beamos_nif.c`) runs as with Rust-OTP: an instance of its own (`nif.ts`),
  external terms both ways. `host/wasm_nifs.c` makes its entry from its
  answer to `load`; every function is one proxy, which finds its function
  by the process's current MFA.
- **Terminal.** Popcorn's prim_tty over JS, with the raw mode reported
  (`Module.onTtyMode`) and the end of input (a node without a terminal,
  as under `node.ts`, reads a stream that ends).
- **What it says it is.** `os:type()` is `{unix, linux}` (uname),
  `system_architecture` `ROTP_SYSTEM_ARCHITECTURE`'s, and each node has a
  process id of its own (Emscripten's is always 42; Mix tells nodes apart
  by it).

Status (2026-10-17): the Playwright suite in all three browsers (`SLOW=1`)
passes but for Firefox's `preview` switch to another endpoint (Playwright's
Firefox loses the preview frame, which the page sees navigate) and
`shells` (Ecto's migrator against PGlite's one session, which Rust-OTP
fails too in WebKit; `postgres.ts` keeps a connection between Parse and
Sync alone now). `projects` takes `gen_tcp_socket`'s socket as `:gen_tcp.listen`'s
answer, `bundles` a module no boot image has, `websocket` erts's banner.

## The network: `socket/`

Patch 0016 builds `socket/prim_socket_nif.c` (copied into the tree by
`build.sh`) as `prim_socket`'s NIF in place of esock's, and gives
`prim_socket.erl` the tables esock would report (`nif_supports`,
`nif_info/0`). With `-kernel inet_backend socket`, `gen_tcp` runs as
`gen_tcp_socket` over `socket` over it, all OTP's own code. The NIF has
stream sockets over the playground's `Network` (`wasi/net.ts`): each
operation calls `socket/socket.js` on the module's main thread
(`__proxy: 'sync'`); data and connections arriving wake the NIF's event
thread through a ring in its memory, which sends the `select` messages.
As esock does, one connection wakes one acceptor: `gen_tcp_socket`
answers a `select` to its retry with `{error, timeout}`.

## Smoke test

    ~/emsdk/node/*/bin/node playground/beam/smoke.mjs ['<erlang expr>']
    BEAM_WASM=out/beam-wasm/site APPS=kernel,stdlib,compiler node playground/beam/smoke.mjs '...'

The script copies a dist's application ebins into MEMFS and boots with
`-noshell -eval`. Observed 2026-10-16 (debug build,
Node 24.19 from emsdk): `hello from 29 on "wasm32-unknown-emscripten"`,
exit 0 in 2.3 s. The host's unmodified Elixir 1.20.4 ebin (compiled by
OTP 29.1.1) loads too: `Code.eval_string` runs, 2.4 s to exit. Module
checksums (patch 0013) are computed by the loader, so stock `.beam`
files need no rebuild.

## Ash benchmark (2026-10-16)

`bench_ash.exs` compiles Ash 3.36.1's 659 files (1380 modules) with
`Kernel.ParallelCompiler`, every other dependency compiled, four
schedulers, on a 12-core AMD machine; Node 24.19 from emsdk.

| VM | Time | Peak memory |
| --- | --- | --- |
| BEAM 29.1.1 native (JIT) | 37.4 s | 644 MB RSS |
| Rust-OTP native | 97.2 s | 2.2 GB RSS |
| Rust-OTP wasm (`rotp-threads.wasm`, `node.mjs`) | 153.2 s (152.4 s with `--no-liftoff`) | 2.0 GB RSS |
| BEAM 29.1.1 native, `--disable-jit` | 58.3 s | 550 MB RSS |
| BEAM wasm, `-O2`, mimalloc, `-MMscs 1536 -MMsco false`, patch 0015 | 86.5 s (86.6, 86.3; a first run 100.0) | 1659 MB wasm, 2.2 GB RSS |
| same without patch 0015 | 449.9 s | same |
| same without patch 0015, Node `--no-liftoff` | 103.7 s | same |
| BEAM wasm, `-O2`, emmalloc or mimalloc, no super carrier | crashes | 2 GB / 4 GB cap |

Without a super carrier the wasm BEAM's memory grows until the cap
(about 14 MB/s) while `erlang:memory/0` stays near 100 MB and the
allocators' carriers near 128 MB: on Emscripten `mmap` is `malloc` and
`munmap` is `free`, and mseg's carriers of varying sizes fragment the
heap, which WebAssembly cannot shrink. Eight tasks building and dropping
large lists reproduce it: 1620 MB of wasm memory against 302 MB RSS
natively. A super carrier keeps carriers in one region erts manages
itself; Emscripten zero-fills it when it is mapped, so it costs its
whole size up front.

Sampled with `perf` (Node `--perf-basic-prof`, a `--profiling-funcs`
link), the wasm BEAM with patch 0015 and the native interpreter spend
their time alike: `process_main` 57% and 49%, then `eq`,
`erts_cmp_compound`, sweeping, collection and maps. WebAssembly costs
about 1.5 to 1.8 times throughout, a little more in the interpreter
loop, whose dispatch is a `switch` there (patch 0014): WebAssembly has
no computed goto.
