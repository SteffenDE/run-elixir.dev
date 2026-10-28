# Real BEAM in WebAssembly

OTP's own emulator (erts) built with Emscripten: the playground's runtime
(`runtime/`, below). It began as an experiment beside Rust-OTP (beamos's
branch `sd-beam`), which the playground ran before (the `rotp` branch);
comparisons with Rust-OTP below are from then.

## Provenance

`patches/0001` to `0014` and `emscripten/` are copied unchanged from
[Popcorn](https://github.com/software-mansion/popcorn) (Software Mansion,
Apache License 2.0), `popcorn/patches` and `popcorn/emscripten` at commit
`a64cbbc23cf1244a27d69a6d684e10c5040aa0e6`. Popcorn wrote them for
OTP-29.0.6; The retained patches apply to OTP-29.1.2, the configured host version.
`build.sh` follows Popcorn's `scripts/build-beam.sh`, and `openssl.sh` its
`build-openssl.sh`. Patches 0015 through 0024 are ours; Popcorn's 0004
(without-distribution, which stubbed `dist.c` and left the distribution
modules out of kernel) is gone ([distribution.md](../docs/distribution.md)).

| Patch | Effect |
| --- | --- |
| 0001 emscripten-support | configure detects `wasm32-*-emscripten`, `ERTS_EMSCRIPTEN` |
| 0002 without-zstd | drops zstd from erts and stdlib |
| 0003 without-native-sockets | no inet driver sockets (0016 brings TCP back) |
| 0005 without-crash-dumps | no crash dump writer |
| 0006 without-dynamic-loading | no `dlopen` for drivers and NIFs (0021 loads wasm NIFs) |
| 0007 bootstrap-trim | smaller native bootstrap |
| 0008 driver-start-callbacks | driver start hooks |
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
| 0020 playground-https | `ssl:connect` through the page's gateway (`PLAYGROUND_HTTPS_GATEWAY`): its fetch, or a TCP connection the node does TLS over |
| 0021 wasm-nif-libraries | `load_nif` of a library built to WebAssembly (`host/wasm_nifs.c`) |
| 0022 memory-without-alloc-util | `erlang:memory/0,1` with erts' allocators off (`+Mea min`) |
| 0023 wasm-gethostname | the host is `localhost` without `prim_net`'s NIF (`global`, `-sname`) |
| 0024 wasm-stdin-take | `popcornStdinTake`: fd 0's input from prim_tty's buffer, for erts' break menu (Ctrl+C) |

Patch 0015: V8 moves a WebAssembly function to optimized (TurboFan) code
only when it is next called, and a scheduler thread entered
`process_main`, the interpreter loop, once for good: it ran as baseline
(Liftoff) code, 64% of a profile. Returning at each schedule and being
called again in a loop made compiling Ash 5.2 times as fast.

## Build

Needs emsdk 6.0.2 (Popcorn's CI's, at `~/emsdk`), host Erlang 29.1.2,
autoconf 2.72, and network access the first time.

    OTP_SOURCE=~/src/otp-29.1.2 OPT=-O2 DIST=out/beam-wasm/site beam/build.sh release

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

    python3 -I runtime/build.py
    python3 -I runtime/build.py app

`build.py` builds the site for this BEAM: `beam.mjs`, `beam.emu.mjs` and
`beam.wasm`, and an installation laid out as Rust-OTP's was, at `/rotp`
in the node (`target/otp`: OTP from the dist, the host's Elixir, Hex and
phx_new archives and rebar3). The template is built by the host's Mix
(`_build_otp`, in `target/cache-otp`); the boot images are recorded on
this BEAM. `node.ts` runs the site under Node (the recording runs); the
browser's worker runs it (`worker/beam.ts`). Both go through
`packages/runtime/src/beam/run.ts`; `beam/args.ts` turns erl's arguments into
the emulator's.

- **Loading.** The page compiles `beam.wasm` once and every node's worker
  instantiates that module (`instantiateWasm`, in the link's
  `INCOMING_MODULE_JS_API`; `beam/run.ts`), so a node no longer fetches and
  compiles 5 MB: its BEAM loads in some 12–40 ms after the first (97–165 ms
  each before). Its threads get the module from the worker, as Emscripten
  passes it.
- **Threads.** The module's main thread is the node's worker; erts' threads
  are its pthreads, and each file and network call they make is proxied
  to the worker, which must not block while the node runs: it takes the
  page's frames as they come (`Atomics.waitAsync`). WebKit's waitAsync
  wakes some 60 ms late (a node took a minute to start): there the worker
  runs the proxied calls itself, 8 ms at a time waiting on its pthread's
  first word (which a thread notifies when it posts a call), then lets the
  worker's other events in. A tick per check (some 170,000 a second) kept
  its timers from firing, and WebKit freed the MessageEvents so late that
  the page passed its 16 GB limit and was killed.
- **Memory.** On Emscripten `mmap` is malloc, whose heap erts' carriers
  fragment past any limit (below), so the nodes run without erts' own
  allocators (`+Mea min`): mimalloc takes every allocation. Patch 0022
  answers `erlang:memory/0,1` then (mimalloc's committed bytes, each
  process' memory; binaries and ETS tables counted as system).
- **Files.** PROXYFS mounts the node's tree (`beam/treefs.ts` over
  `wasi/fs.ts`, lazily fetched files and all) at each top directory but
  Emscripten's `/dev` and `/proc`, and `/work`, `/tmp`, `/home`, and `/shared` from files.js
  (`beam/sharedfs.ts`). Hard links go through the trees (`host/host.js`;
  Emscripten's always fail). Files are executable (`os:find_executable`).
- **Network.** `gen_tcp` and `gen_udp` are `gen_tcp_socket` and
  `gen_udp_socket` over our `prim_socket` NIF (`socket/`, below) over the
  playground's `Network`. A project's nodes reach each other's ports
  through the page (Mix's compile notices go so); other hosts' through
  the page too, which dials them (through the user's tailnet,
  `docs/tailscale.md`). HTTPS: `ssl:connect` connects to a gateway port,
  names the host in its first line, and the page's says how it goes on:
  `fetch` (the page answers its plain HTTP with fetch), `tcp` (a TCP
  connection through Tailscale or the restricted relay, which `ssl` upgrades with the options it
  was given) or `error REASON` (patch 0020).
- **Ports.** `host/wasm_spawn.c` runs the playground's programs
  (`spawn.js`, the host's `Module.beamSpawn` over the playground's
  `Process` and programs, `wasi/process.ts`); `{spawn, Command}` is `/bin/sh -c`. Output and exit come
  through a ring to the driver's event thread, which asks `erl_init`'s
  `wasm_port_pump` to `port_control` the port, where they are delivered.
- **NIFs.** A library built to WebAssembly by `nif/` (wasi-sdk,
  `beamos_nif.c`) runs in an instance of its own (`nif.ts`),
  external terms both ways. `host/wasm_nifs.c` makes its entry from its
  answer to `load`; every function is one proxy, which finds its function
  by the process's current MFA.
- **Terminal.** Popcorn's prim_tty over JS, with the raw mode reported
  (`Module.onTtyMode`) and the end of input (a node without a terminal,
  as under `node.ts`, reads a stream that ends).
- **Signals, unpatched.** erts handles them as on Unix: `sigaction`
  handlers write to a self-pipe its signal-dispatcher thread reads. What
  Emscripten lacks is the runtime's, linked in with `--wrap` (`build.sh`):
  `host/wasm_pipes.c` makes `pipe()`s that block (Emscripten's never do:
  the dispatcher and the poll set's wakeups wait on them, `poll()` too),
  and `host/wasm_process.c` ends the runtime from any thread's `exit`
  (`emscripten_force_exit`; Emscripten passes a pthread's exit to the main
  thread, which the kept-alive runtime outlives) and lets erts' main thread
  wait for good (`select` on nothing). A signal is the host's `raise()` on
  the main browser thread (`run.ts`'s `signal`): Ctrl+C is SIGINT, so the
  break menu, whose key fd 0 takes from prim_tty's buffer while it waits
  (patch 0024). SIGTERM would be `init:stop`, though nothing sends it yet.
- **What it says it is.** `os:type()` is `{unix, linux}` (uname),
  `system_architecture` `ROTP_SYSTEM_ARCHITECTURE`'s, and each node has a
  process id of its own (Emscripten's is always 42; Mix tells nodes apart
  by it).

Status (2026-10-17, later): `shells` passes in WebKit too: the page made
a Postgres handler per node, so the server's and a shell's connections
never took turns in PGlite's one session, and PGlite's startup reply (a
view of its buffer) was overwritten before the node read it; both fixed
in `packages/runtime/src` and the project page, for Rust-OTP as well.
Firefox's endpoint switch was Playwright's: Juggler loses an iframe's
navigation once the wrapper of the frame's docShell has been collected
(its observer does not QueryInterface it), which happens within seconds
on this site; the test looks at the frame just before. A full `SLOW=1`
run on this site had 150 of 189 tests passed and none failed when it
was stopped (low memory on the machine); the rest, mostly WebKit's and
the `domain` project's, did not run. `projects` takes
`gen_tcp_socket`'s socket as `:gen_tcp.listen`'s answer, `bundles` a
module no boot image has, `websocket` erts's banner.

Status (2026-10-17, end of day): WebKit's `mix test` no longer passes
16 GB (the page's poll took a message per mailbox check; now it polls in
8 ms slices) and nodes run on mimalloc alone (`+Mea min`, patch 0022).
The full `SLOW=1` run in Chromium, Firefox and WebKit (two workers):
177 passed, 9 skipped, 3 failed, all WebKit. `share`'s Phoenix link
carried the asset watchers' output (fixed, 037fde2). `livetest` and
`git` stalled together, both with the other running; alone, each passes.
Two rare WebKit stalls remain, both more often with two pages at once:
a new node hanging in `new WebAssembly.Memory`, and a node's worker
stopping in the middle of `mix test` (beamos's docs/log/2026-10-17.md).

## The network: `socket/`

Patch 0016 builds `socket/prim_socket_nif.c` (copied into the tree by
`build.sh`) as `prim_socket`'s NIF in place of esock's, and gives
`prim_socket.erl` the tables esock would report (`nif_supports`,
`nif_info/0`). With `-kernel inet_backend socket`, `gen_tcp` and
`gen_udp` run as `gen_tcp_socket` and `gen_udp_socket` over `socket` over
it, all OTP's own code. The NIF has stream and datagram sockets over the
playground's `Network` (`wasi/net.ts`): each operation calls
`socket/socket.js` on the module's main thread (`__proxy: 'sync'`); data,
datagrams, connections and dialing's end arriving wake the NIF's event
thread through a ring in its memory, which sends the `select` messages.
As esock does, one connection wakes one acceptor: `gen_tcp_socket`
answers a `select` to its retry with `{error, timeout}`.

A stream connects to the node's own addresses (127.0.0.0/8, ::1, the
unspecified one) at once; to another host's, `connect/3` answers `select`
while the page dials (`wasm_socket_dial`), and `connect/1`, or
`connect/3` again (as `gen_tcp_socket` retries), says how it went. A
datagram socket binds a port of the `Network` on `bind` or its first
send (`-1`, as `inet_res` asks, is any free one), takes `sendto`,
`recvfrom`, and on a connected socket `send` and `recv` (a connected
socket keeps its peer's datagrams only). Addresses come back as they
came: `inet_res` checks that its nameserver answered.

## Smoke test

    ~/emsdk/node/*/bin/node beam/smoke.mjs ['<erlang expr>']
    BEAM_WASM=out/beam-wasm/site APPS=kernel,stdlib,compiler node beam/smoke.mjs '...'

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

Without erts' allocators (`+Mea min`) there are no carriers: every block
is mimalloc's, whose size classes reuse what is freed. Eight tasks
building and dropping lists and binaries for 2400 rounds (2026-10-17,
Node, four schedulers):

| Flags | Wasm memory | Time |
| --- | --- | --- |
| none | the 4 GB cap within 10 s, then stuck | - |
| `-MMscs 1024 -MMsco false` | 1147 MB | 128.4 s |
| one carrier size (`-Musmbcs 8192 -Mulmbcs 8192 -Musbct 4096 -MMmcs 0`) | 777 MB | - |
| the same with `-sMALLOC=dlmalloc` | 870 MB | - |
| `-Mea min` | 191 MB | 130.7 s |

In WebKit the playground's `mix test` page (livetest.spec.ts) peaked at
3.9 GB instead of 7.3 GB; with one carrier size it passed 8.5 GB. Less
is also safer there: a page process gets 15 shared memories of 4 GB at
most (the next throws), JSC collects synchronously when a new memory
would pass its committed-bytes limit, and a node starting during the
1 GB super carriers' days once hung inside `new WebAssembly.Memory`
(which of the two is not proven).

Sampled with `perf` (Node `--perf-basic-prof`, a `--profiling-funcs`
link), the wasm BEAM with patch 0015 and the native interpreter spend
their time alike: `process_main` 57% and 49%, then `eq`,
`erts_cmp_compound`, sweeping, collection and maps. WebAssembly costs
about 1.5 to 1.8 times throughout, a little more in the interpreter
loop, whose dispatch is a `switch` there (patch 0014): WebAssembly has
no computed goto.
