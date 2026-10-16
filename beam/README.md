# Real BEAM in WebAssembly (experiment)

An experiment on branch `sd-beam`: build OTP's own emulator (erts) with
Emscripten, instead of running Rust-OTP (`playground/runtime`) in the
playground.

## Provenance

`patches/0001` to `0014` and `emscripten/` are copied unchanged from
[Popcorn](https://github.com/software-mansion/popcorn) (Software Mansion,
Apache License 2.0), `popcorn/patches` and `popcorn/emscripten` at commit
`a64cbbc23cf1244a27d69a6d684e10c5040aa0e6`. Popcorn wrote them for
OTP-29.0.6; all fourteen apply in order to OTP-29.1.1, our host version.
`build.sh` follows Popcorn's `scripts/build-beam.sh`, without the crypto
variant and the patch-regeneration tooling.

The patches, in order:

| Patch | Effect |
| --- | --- |
| 0001 emscripten-support | configure detects `wasm32-*-emscripten`, `ERTS_EMSCRIPTEN` |
| 0002 without-zstd | drops zstd from erts and stdlib |
| 0003 without-native-sockets | no inet driver sockets |
| 0004 without-distribution | no `dist.c`, `net_kernel` stubs |
| 0005 without-crash-dumps | no crash dump writer |
| 0006 without-dynamic-loading | no `dlopen` for drivers and NIFs |
| 0007 bootstrap-trim | smaller native bootstrap |
| 0008 driver-start-callbacks | driver start hooks |
| 0009 signal-shutdown | shutdown without signals |
| 0010 disable-os-processes | no `open_port({spawn, ...})` |
| 0011 wasm-bridge | `wasm` module and NIF, JS callbacks, TTY over JS |
| 0012 asn-one-erlang-fallback | asn1 without its NIF |
| 0013 module-checksum-xxh | module MD5 replaced by xxhash |
| 0014 no-jump-table | interpreter without computed goto |
| 0015 wasm-process-main-returns | ours: `process_main` returns at each schedule |

Patch 0015 is ours. V8 moves a WebAssembly function to optimized
(TurboFan) code only when it is next called, and a scheduler thread
entered `process_main`, the interpreter loop, once for good: it ran as
baseline (Liftoff) code, 64% of a profile. Returning at each schedule and
being called again in a loop made compiling Ash 5.2 times as fast.

## Build

Needs emsdk (Popcorn's CI uses 6.0.2, installed at `~/emsdk`), host
Erlang, autoconf 2.72.

    playground/beam/build.sh debug        # or release
    OTP_SOURCE=~/src/otp-29.1.1 playground/beam/build.sh debug

Output is in `out/beam-wasm/dist`: `beam.wasm`, the Emscripten loader
`beam.mjs` (with pthread workers from `beam.emu.mjs`) and `vm.boot`.
Logs are `out/beam-wasm/configure.log` and `out/beam-wasm/build.log`.

## Under the playground's runtime: `beam-node.mjs`

`build.sh` links the playground's build: mimalloc, 4 GB, and
`-lproxyfs.js`, through which `app/src/runtime/beam/treefs.ts` mounts the
playground's tree (`wasi/fs.ts`, as Rust-OTP's WASI shim serves it) at
each of its top directories. `dist/otp` is the installation (each
application's `ebin` and `priv`, `bin/start.boot`). The Node harness
`app/src/runtime/beam-node.ts` (`vite build -c vite.runtime.config.ts
--mode node`, into `app/dist-node`) mounts it at `/otp`, and host
directories, read when first opened, with `MOUNT=VFSDIR:HOSTDIR,...`:

    MOUNT=/elixir:$ELIXIR/lib,/work/ash:$HOME/src/ash_bench,/bench:playground/beam \
    CWD=/work/ash node playground/app/dist-node/beam-node.mjs out/beam-wasm/web \
      -S 4:4 -MMscs 1536 -MMsco false -- -root /otp -bindir /otp/bin -progname erl \
      -home /work -boot /otp/bin/start -noshell -kernel start_distribution false \
      -elixir_root /elixir -pa /elixir/elixir/ebin -pa /elixir/mix/ebin \
      -s elixir start_cli -extra /bench/bench_ash.exs ash _build

Ash compiles so in 80.7 s (each file call proxied to the main thread,
the output kept in memory). Renaming between two top directories (`/work`
to `/tmp`) is `exdev`: they are separate mounts.

## Smoke test

    ~/emsdk/node/*/bin/node playground/beam/smoke.mjs ['<erlang expr>']
    APPS=kernel,stdlib,compiler,elixir node playground/beam/smoke.mjs '...'

The script copies application ebins from `out/beam-wasm/otp/lib` into
MEMFS and boots with `-noshell -eval`. Observed 2026-10-16 (debug build,
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

## Plan: the playground on this BEAM

A proof of concept with what the playground's Rust-OTP node has, in this
order: files and the network first (a Phoenix app's needs), then the
terminal, ports, crypto and NIFs. What the playground provides today is
mapped in [`../docs/runtime.md`](../docs/runtime.md); how each part maps:

- **Files.** Today `rt/wasi/fs.ts` is the node's tree: boot images,
  bundles fetched lazily by synchronous XHR, `/work` and `/tmp` served by
  `files.js` over a SharedArrayBuffer. With `PROXY_TO_PTHREAD`
  Emscripten's file system runs on the worker that loaded the module, so
  a custom Emscripten file system (`node_ops`/`stream_ops`) over the same
  tree keeps all of it. The images and bundles are rebuilt from stock
  `.beam` files (OTP's from this tree, Elixir's and the template's
  `_build` from the host), and the recording runs redone on this VM.
- **Network.** Patch 0003 takes out the inet driver. OTP's other
  `gen_tcp` backend, `gen_tcp_socket` (`-kernel inet_backend socket`), is
  Erlang over `socket`, whose NIF is `prim_socket`. A `prim_socket` of
  ours for TCP (open, bind, listen, accept, connect, send, recv,
  setopt/getopt, close, with `select` messages when a call would block)
  over the playground's `Network` keeps the page's side as it is (the
  preview's requests, WebSockets, PGlite on 5432, the Hex fetcher).
  HTTPS needs an `ssl` shim as `BeamOS.Ssl` is.
- **NIFs.** As with Rust-OTP: each library a separate WebAssembly
  instance with `playground/nif/beamos_nif.c`, called with copied terms.
  The existing wasi-sdk builds stay. erts' `load_nif` (stubbed by patch
  0006) asks JS for the instance and registers every function with one
  proxy: erts sets the process's `current` to the function's MFA before
  calling a NIF, so the proxy finds which one was called without a table
  of stubs. Calls go to the one thread that holds the instances.
- **Ports.** Patch 0010 takes out `open_port({spawn, ...})`; a static
  driver speaking the playground's `/.proc` protocol to its programs.
- **Crypto.** OpenSSL for WebAssembly, as Popcorn's
  `scripts/build-openssl.sh` builds it.

Open questions: Firefox and WebKit (only Node is measured), and the
super carrier's memory, mapped (and zero-filled) whole at start.
