# Real BEAM in WebAssembly (experiment)

An experiment on branch `sd-beam`: build OTP's own emulator (erts) with
Emscripten, instead of running Rust-OTP (`playground/runtime`) in the
playground.

## Provenance

`patches/` and `emscripten/` are copied unchanged from
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

## Build

Needs emsdk (Popcorn's CI uses 6.0.2, installed at `~/emsdk`), host
Erlang, autoconf 2.72.

    playground/beam/build.sh debug        # or release
    OTP_SOURCE=~/src/otp-29.1.1 playground/beam/build.sh debug

Output is in `out/beam-wasm/dist`: `beam.wasm`, the Emscripten loader
`beam.mjs` (with pthread workers from `beam.emu.mjs`) and `vm.boot`.
Logs are `out/beam-wasm/configure.log` and `out/beam-wasm/build.log`.

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
| Rust-OTP wasm (`rotp-threads.wasm`, `node.mjs`) | 153.2 s | 2.0 GB RSS |
| BEAM wasm, `-O2`, mimalloc, `-MMscs 1536 -MMsco false` | 449.9 s | 1659 MB wasm, 2.2 GB RSS |
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
