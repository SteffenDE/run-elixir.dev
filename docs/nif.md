---
kind: reference
status: live
last_updated: 2026-10-18
---

# NIFs (`nif/`)

The Emscripten BEAM links no native libraries. In the playground a NIF
library is a WebAssembly module instead: the package's C or C++, built
with wasi-sdk against an erl_nif of our own, run in an instance of its
own beside the node. The node and the library exchange external terms
(`term_to_binary`), so erts needs only one proxy NIF for them (patch
0021). The layer was written for Rust-OTP, which runs the same builds
(the `rotp` branch).

## The erl_nif layer (`beamos_nif.c`)

A NIF library is OTP's `erl_nif.h` (OTP 29.1.1's, in `nif/include` with
`include/erl_int_sizes_config.h` for wasm32), linked with `beamos_nif.o`
into a WASI reactor. The layer implements the API over terms of its own:

- **Terms** are cells in an environment's arena (`ERL_NIF_TERM` is the
  cell's address). Atoms and pids are interned, so equal ones are the same
  term (NIFs compare atoms with `==`). An environment's terms go when it is
  cleared: a call's after the call, `enif_alloc_env`'s when the NIF clears
  or frees it.
- **External terms** cross both ways. Integers beyond 64 bits, bitstrings,
  funs, ports and references stay their external bytes.
- **References** a library makes (resources', `enif_make_ref`'s) are
  `nonode@nohost`'s in three words, laid out as Rust-OTP's: a 61-bit
  counter, which it decodes exactly only within that layout. The layer
  sets bit 59, which the node's counter never reaches, bit 58 for a plain
  reference, a 16-bit nonce of the instance's (so another instance's do
  not match) and a 34-bit id. A resource that has crossed is kept for
  the instance's life: the node does not report collected references
  yet.
- **`enif_send`** queues the message; the answer carries it to the node.
- **One thread.** Locks do nothing, `enif_thread_create` fails with
  ENOTSUP, `enif_cond_wait` aborts. Dirty NIFs and `enif_schedule_nif` run
  at once, in the call (`enif_thread_type` says which kind of scheduler).
- **Not there:** `enif_select` (NOTSUP), monitors (accepted, never fire),
  `enif_whereis_*` (not found), ports, `enif_dlopen`, I/O queues and
  iovecs (a library that uses them does not link). `enif_hash` is not
  ERTS's hash. `enif_make_existing_atom` makes the atom.

**Exports.** `beamos_nif_input(size)` (room for a request),
`beamos_nif_run(size)` (the answer's size) and `beamos_nif_output()`
(where it is). Requests and answers are external terms:

| Request | Answer |
| --- | --- |
| `{load, LoadInfo, Self}` | `{ok, Module, [{Name, Arity, Flags}], Messages}` or `{error, Reason, Messages}` |
| `{call, Index, Args, Self}` | `{ok, Result, Messages}` or `{raise, Reason, Messages}` |

`Module` is `ERL_NIF_INIT`'s name, `Index` a function's place in that
list, `Messages` what `enif_send` sent meanwhile, `[{Pid, Message}]`.

## In the node

1. **`make`.** elixir_make runs `make` in the package's directory (with
   cc_precompiler too: the node's `TARGET_ARCH`, `TARGET_OS` and
   `TARGET_ABI` make its target `wasm32-unknown-wasi`, which no package
   lists, so it builds instead of downloading an x86_64 Linux library). The
   playground's `make` (`src/runtime/programs.ts`) reads the package's name and
   version from its `hex_metadata.config` and unpacks that version's
   library into `MIX_APP_PATH`, so `priv/bcrypt_nif.so` is where the
   Makefile would have put it: the site's `nif/NAME-VERSION.tar` when it
   has one, else the backend's ([backend.md](backend.md)), asked for at
   `/api/nif/NAME/VERSION` on the page's origin (`worker.js`). While the
   backend builds it (`queued`, `running`, or `setting_up` while an agent
   writes a recipe), `make` asks again every 2 s, and the page shows a
   dialog with the status (a `nif` message, `NifBuildDialog`) that can be
   hidden; the node reads `make`'s own lines on what happened once it
   returns. Ctrl-C stops waiting, and the node with it. When the backend
   could not build it, or there is no backend (a page answers), `make`
   fails (status 2) and says why, as does the dialog; `make clean` does
   nothing.
2. **`erlang:load_nif(Path, Info)`**: erts cannot link `Path.so`, so it
   asks `erts_wasm_nif_entry` (patch 0021, `beam/host/wasm_nifs.c`):
   `nifs.js` reads the file and opens it as an instance (`nif.ts`, with a
   WASI of its own over the node's files and environment: a WASI
   function it lacks answers ENOSYS, so the library loads and only a call
   that needs it fails), then `{load, Info, self()}` runs the library's
   load. Its answer makes an `ErlNifEntry` whose every function is one
   proxy, which finds its function by the process's current MFA. erts's
   errors on failure.
3. **Calls** go to the library as `{call, Index, Args, self()}`; `raise`
   raises its reason as an error, as ERTS does; messages the library sent
   are sent from the caller. A library that traps is gone: its calls
   raise `nif_library_failed`. Dirty NIFs run as the others.

Calls go one at a time (`nifs.js` keeps one answer), on the module's
main thread: a call blocks its scheduler while it runs, as a long NIF
does on ERTS without dirty schedulers.

## Building (`build.py`)

```sh
python3 -I nif/build.py [PACKAGE...]   # → target/nif
```

The site build copies `target/nif/packages` to the site's
`nif/` (`runtime/build.py`, also `build.py app`).

In the wasi-sdk image (Docker, pinned by digest): `beamos_nif.o`, then each
package in `PACKAGES` from its Hex tarball, by its own Makefile with the
environment elixir_make gives it (`ERTS_INCLUDE_DIR`, `MIX_APP_PATH`, …)
and `CC=nifcc`, `CXX=nifc++`. What the build put in the app's `priv`
becomes `packages/NAME-VERSION.tar`: the library is the file ERTS would
load (`priv/bcrypt_nif.so`), holding WebAssembly. `nifcc` compiles for `wasm32-wasip1` and
links a reactor with the layer where the Makefile asks for a shared library
(it leaves out `-shared`, `-fPIC` and dynamic lookup). C++ gets
WebAssembly exceptions (`-fwasm-exceptions`, libunwind) in their new
encoding (`try_table`): wasi-sdk's libc++ has that one, and Chromium and
WebKit refuse a module that mixes it with the legacy one clang still makes
by default. So C++ NIFs need Chrome 137, Firefox 131 or Safari 18.4.
`setjmp` and `longjmp` work in C and C++ on the same exceptions
(`-mllvm -wasm-enable-sjlj`, libsetjmp; C gets `-mexception-handling`).
wasi-libc's emulations are on: `nifcc` defines `_WASI_EMULATED_SIGNAL`,
`_MMAN`, `_PROCESS_CLOCKS` and `_GETPID` and links their libraries, so
`signal()`/`raise()` (handlers run in the library; an unhandled signal
ends the call, as `proc_raise`), anonymous and read-only `mmap()`,
`clock()`/`times()` and `getpid()` compile and link; a library takes only
what it uses.

A package's recipe in `PACKAGES` gives its make targets, its `make_env`
per version, Hex packages whose directories it names (`headers`, such as
Fine's include directory) and `prepare`, what the Makefile would fetch and
build itself (lazy_html's lexbor, cloned and built with cmake: here from
GitHub's archive of the commit, with the wasi-sdk cmake toolchain).

**Adding a package** (or a version): a recipe in `PACKAGES`, then
`build.py NAME`, the layer's and the package's checks, and a site build.
A library that does not link names the `enif_` functions the layer lacks.
`make` looks a build up by the exact name and version in the project's
`deps`, so a version the site has not built fails in `make`.

**Test.** `test/test.py` builds `test/layer.c` with `nifcc` and runs
`test/layer.exs` in the Node harness over the built site: a resource made,
bumped and given back, a message from `enif_send`, a map with an unsigned
64-bit value, a term with a pid, a reference, a bitstring, bignums, a map
and a fun echoed unchanged, and `badarg` for a bad argument and for a
reference that is no resource. Then what C libraries ask of WASI and
wasi-libc: a file's times set by path (SQLite does; exqlite failed to
load without it), `posix_fadvise`, `longjmp` back to a `setjmp`, a
signal handled, anonymous `mmap`, `getpid` and `clock`, `pwrite` then
`pread` keeping the position (`fd_tell`), `fd_allocate`, `fd_datasync`
and `clock_res_get`.

| Package | Library |
| --- | --- |
| bcrypt_elixir 3.3.2 | `priv/bcrypt_nif.so`, 239 KB |
| argon2_elixir 4.1.3 (Argon2's lanes in turn: `ARGON2_NO_THREADS`) | `priv/argon2_nif.so`, 250 KB |
| picosat_elixir 0.2.3 (Ash's policy SAT solver; without `getrusage`) | `priv/picosat_nif.so`, 296 KB |
| lazy_html 0.1.13 (Fine 0.1.6, lexbor 244b849) | `priv/liblazy_html.so`, 1.6 MB |

## Not yet

- Releasing resources when the node collects their references, and the
  rest of the API above (threads, `enif_select`, monitors).
- Rustler: rustler_precompiled downloads its build (its target is the
  node's `x86_64-pc-linux-gnu`); Rust NIFs need a recipe that builds the
  crate for `wasm32-wasip1` against the layer.
- The backend as the only source of builds, the request naming the
  page's layer ([backend.md](backend.md#plan-one-source-of-nif-builds));
  and the template's test build prebuilt, so a Phoenix project's first
  `mix test` does not compile for minutes.
