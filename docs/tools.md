---
kind: design
status: plan
last_updated: 2026-10-22
---

# sed, grep, diff, awk and find

The shell has coreutils (uutils, Rust: [runtime.md](runtime.md#coreutils-coreutilsts)),
`rg` and `git`, but not the text tools every script reaches for: `sed`,
`grep`, `diff` and `cmp`, `awk`, `find`. git's own shell scripts need them
(`git submodule` wants `sed`), as do agents and people. The plan: GNU's
own, built from C with wasi-sdk, each a program of the worker's process
table ([runtime.md](runtime.md#processes-processests)).

## Which

| Tool | Source | Why |
| --- | --- | --- |
| `sed` | GNU sed | What Linux has: `sed -i` without a suffix, `-E`, `-z`, GNU's regex |
| `grep` | GNU grep | Back-references in basic regex, `-P` aside; ripgrep's engine has none |
| `diff`, `cmp` | GNU diffutils | `diff -u` as git's tests compare (`test_cmp`), `cmp` |
| `awk` | onetrue-awk (BWK's) | POSIX's reference, small, portable C; Debian and Ubuntu ship mawk, so no one expects gawk |
| `find` | GNU findutils | `-exec`, `-print0`, as scripts use them (`xargs` is `utilities.ts`'s) |

Not `perl`: none of git's scripts for the shell need it, only some of its
tests. The BSD versions would build more easily but differ where scripts
notice (`sed -i ''`). Licences: GPLv3 for GNU's; the site already ships
GPLv2 git, so the same holds: the tarballs and patches we build from are
the source to offer.

## Building them

One pattern for all, as `git/build.py`'s:

- **The image:** wasi-sdk 33's (`nif/build.py`'s, pinned by digest); a
  release tarball by URL and SHA-256, `patches/` applied, the tool's own
  `configure --host=wasm32-wasip1`, then `make`. What `configure` cannot
  run when cross-compiling, a `config.site` answers.
- **A shared C layer** for what WASI preview 1 lacks: `git/wasi/` today
  (`wasi-compat.h`, `stubs.c`, the stub headers), moved where every C tool
  links it: processes through the host (`wasi_spawn`, `pipe`, `dup`,
  `dup2`, `waitpid`, `kill`: the `processes` imports), `stat`'s permission
  bits (`wasi_stat`: WASI gives the type alone), one user (uid 0, `HOME`),
  `mkstemp`, no-op `chmod`. What starts another program (sed's `e`,
  awk's `system()` and pipes, `find -exec`) spawns through it; `popen`
  and `system` are written over `wasi_spawn` and `sh -c` (brush, a
  process of the table).
- **gnulib** (GNU's portability layer) brings its own replacements where
  WASI lacks a function; what it still misses (signals beyond WASI's
  emulated ones, `fcntl` locks, `fts` for findutils) is stubbed or
  patched.
- **Output:** `target/NAME/NAME.wasm`, `-Oz`, a few hundred KB each;
  `runtime/build.py` ships them (its `WASM` and `RUNTIME_NAMES`, as
  `git`), `coreutils.ts`'s `PROGRAMS` names them, and `setup.ts` puts a
  stub for each on PATH (brush looks a command up itself).

## Measured by git's suite

`npm run test:git` (`app/test/git`, [git.md](git.md#tests)) runs git's own
`t/` with what the playground lacks borrowed from the host, and counts
it per script (`Machine.hosted`: sed, grep, diff, cmp, perl, find,
getconf). Each tool, once built, joins the harness's resolver (as
`git.wasm` and `coreutils.wasm` do) and leaves that count, with the pass
rate (97.5%, 2026-10-22) holding; a regression is the tool's, or the
shared layer's. The browser's tests (Playwright) add a few lines at the
shell for each, and `git submodule add` from a local repository once
`sed` is in.

## Order

1. **sed**: the pattern itself, and `git submodule`.
2. **grep** and **diffutils**: the same autoconf and gnulib, in turn.
3. **awk**: plain C and a Makefile; `system()` and pipes over the layer.
4. **findutils**: `fts` and `-exec`.
