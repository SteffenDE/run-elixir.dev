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
