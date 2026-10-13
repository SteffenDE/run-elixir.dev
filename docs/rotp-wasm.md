---
kind: reference
status: live
last_updated: 2026-10-13
---

# Rust-OTP on `wasm32-wasip1`

`rotp` builds for WebAssembly with no WebAssembly-specific crates and no
`unsafe`:

```sh
CARGO_TARGET_DIR=target/wasm cargo build --release --target wasm32-wasip1 -p rotp
```

`build.py` adds `CARGO_PROFILE_RELEASE_DEBUG=false` and
`CARGO_PROFILE_RELEASE_STRIP=true`, which take `rotp.wasm` from about 109 MB
to 2.9 MB. Native builds are unchanged; the differences sit behind
`cfg(target_family = "wasm")` in `crates/rotp/src/host`.

| Area | On wasm |
| --- | --- |
| Schedulers | One: `std::thread::available_parallelism` fails on WASI. The single-scheduler loop in `session.rs` ticks and polls in turn. |
| Standard input | No reader thread (WASI has none): `tty.rs` reads standard input from its poll while a select is armed. A read that would block adds nothing. |
| Files | `platform.rs` holds what is not portable std. On WASI the mode is 644/755 (WASI has no permission bits, and std calls every file read-only, which made `System.tmp_dir!` fail). Files report the executable bit, so `os:find_executable` finds the host's programs. Positioned I/O goes through the file offset; there are no links or owners. |
| File errors | `file.rs` `posix/1` names errors by their kind off Linux (WASI's errno numbers differ), not by Linux numbers. |
| TCP | `wasm_net.rs`: `TcpListener` and `TcpStream` over the host's `/.net` files ([runtime.md](runtime.md#tcp-net)), with a peek buffer for passive sockets. `localhost` and written-out addresses resolve. |
| Ports | `wasm_proc.rs`: `open_port` and `System.cmd` run the host's programs through `/.proc/spawn`; `port.rs` polls them as it polls its reader threads natively. |
| zstd | Not built (no C toolchain for wasm): `zstd_none.rs` refuses, as a BEAM built without zstd. |
| Process id | `os:getpid/0` is 1 (`std::process::id` panics on WASI). |
| Working directory | WASI starts in `/`; `main.rs` changes to `$PWD`. |
| OS and architecture | `{unix, wasi}` and `wasm32-unknown-wasi`, unless `ROTP_OS_TYPE` and `ROTP_SYSTEM_ARCHITECTURE` say otherwise. The playground sets `linux` and `x86_64-pc-linux-gnu`, so Hex tool wrappers (esbuild, tailwind) take their Linux paths. |
| 32-bit | The runtime's binary size guards compare as u64. |

The runtime itself (`beam-runtime`) and the compiler need nothing
WebAssembly-specific.

## Speed

One scheduler and WebAssembly cost against native Rust-OTP, roughly:

- **Compute:** `fib(25)` takes about 30–45 ms against 9 ms natively.
- **Boot:** the Elixir playground reaches its IEx prompt in about 1 s, and the
  Phoenix server runs at about 7 s (Chromium).
- **Compiling deps:** what takes 100 s natively takes minutes in WebAssembly,
  which is why the image ships them built.
