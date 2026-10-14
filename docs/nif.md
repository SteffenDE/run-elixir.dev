---
kind: reference
status: live
last_updated: 2026-10-14
---

# NIFs (`playground/nif`)

Rust-OTP loads no native libraries. In the playground a NIF library is a
WebAssembly module instead: the package's C, built with wasi-sdk against
an erl_nif of our own, run by the node's worker in an instance of its own.
The node and the library exchange external terms (`term_to_binary`), so
nothing in Rust-OTP's runtime needs to know about NIFs.

## The erl_nif layer (`beamos_nif.c`)

A NIF library is OTP's `erl_nif.h` (copied from `third_party/otp`, with
`include/erl_int_sizes_config.h` for wasm32), linked with `beamos_nif.o`
into a WASI reactor. The layer implements the API over terms of its own:

- **Terms** are cells in an environment's arena (`ERL_NIF_TERM` is the
  cell's address). Atoms and pids are interned, so equal ones are the same
  term (NIFs compare atoms with `==`). An environment's terms go when it is
  cleared: a call's after the call, `enif_alloc_env`'s when the NIF clears
  or frees it.
- **External terms** cross both ways. Integers beyond 64 bits, bitstrings,
  funs, ports and references stay their external bytes.
- **Resources** cross as references on node `beamos_nif@wasm` whose ids
  name them (with the instance's nonce, so another instance's do not
  match). A resource that has crossed is kept for the instance's life:
  the node does not report collected references yet.
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

## Building (`build.py`)

```sh
python3 -I playground/nif/build.py   # → target/playground/nif
```

In the wasi-sdk image (Docker, pinned by digest): `beamos_nif.o`, then each
package in `PACKAGES` from its Hex tarball, by its own Makefile with the
environment elixir_make gives it (`ERTS_INCLUDE_DIR`, `MIX_APP_PATH`, …)
and `CC=nifcc`. `nifcc` compiles for `wasm32-wasip1` and links a reactor
with the layer where the Makefile asks for a shared library (it leaves out
`-shared`, `-fPIC` and dynamic lookup). What the build put in the app's
`priv` becomes `packages/NAME-VERSION.tar`: the library is the file ERTS
would load (`priv/bcrypt_nif.so`), holding WebAssembly.

| Package | Library |
| --- | --- |
| bcrypt_elixir 3.3.2 | `priv/bcrypt_nif.so`, 239 KB |
