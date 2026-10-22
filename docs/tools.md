---
kind: design
status: in progress
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
  `configure --host=wasm32-wasip1`, then `make`, `-Oz`.
  `wasi-compat/autoconf.py` does it for the GNU tools (sed's, grep's,
  diffutils'); each `NAME/build.py` names its release, its configure
  options and what to keep. It is loaded by path: `python3 -I` leaves
  the script's directory off `sys.path`.
- **A shared C layer**, `wasi-compat/` (git's `git/wasi/` until it moved),
  for what WASI preview 1 lacks. `stubs.c`: processes through the host
  (`wasi_spawn`, `pipe`, `dup`, `dup2`, `waitpid`, `kill`: the
  `processes` imports), and `popen`, `pclose` and `system` over
  `wasi_spawn` and `sh -c` (brush, a process of the table); one user
  (uid 0, `HOME`), `mkstemp`, no-op `chown`, `getdtablesize`, a no-op
  `tzset` (UTC: WASI has no zone tables); signal sets of 64 and masks
  kept, not applied (wasi-libc's `sigset_t` is a one-byte placeholder);
  and `program_invocation_name` from `argv[0]`, which wasi-libc has and
  never sets (gnulib's `error()` printed `(null):`). A tool links only
  what it calls: wasm-ld drops the rest, and the imports with it
  (sed.wasm imports `pipe`, `spawn` and `wait`; grep.wasm `dup2`).
  `stubs.c` is built the same for every tool, with `wasi-compat.h` forced
  in. `fcntl.c`, for the autoconf tools (`-Wl,--wrap=fcntl`), does
  `F_DUPFD` and `F_DUPFD_CLOEXEC` by `dup`, which wasi-libc's `fcntl`
  refuses and gnulib's `fts` (`grep -r`) needs.
- **Two headers:** `wasi-posix.h` declares what `stubs.c` defines
  (wasi-libc declares some, behind `__wasilibc_unmodified_upstream`, and
  defines none). `wasi-compat.h` is git's: `wasi-posix.h`, then what git
  wants beyond it (`stat` with permission bits, timers, sockets),
  forced into every file by `config.mak`. A tool built with gnulib takes
  `wasi-posix.h` alone, appended to its `config.h` (`lib/config.h` for
  diffutils): gnulib's replacement headers want `config.h` first, so
  `-include` before it fails. `wasi-posix.h` also renames gnulib's
  four-argument `opendirat` after wasi-libc's own (two arguments) is
  declared.
- **config.site:** configure's checks see neither header, so they would
  take what `stubs.c` has for missing (gnulib then replaces it, or the
  tool goes without: sed's `e` needs `HAVE_POPEN`).
  `wasi-compat/config.site` says each is there and declared, except
  `fork` and `exec`, which fail, so that a tool starts programs by
  `popen` and `system`. Then the tool's own `config.site`, for what
  configure cannot run when cross-compiling (sed's: gnulib's regex and
  getopt, as Linux's sed has them). What configure guesses otherwise
  ("guessing no") has gnulib's replacement built in, a little larger and
  as correct.
- **A tool's config.site** also answers what configure cannot run and
  has no guess for (diffutils': `strcasecmp`).
- **gnulib** (GNU's portability layer) brings its own replacements where
  WASI lacks a function; what it still misses (signals beyond WASI's
  emulated ones, `fcntl` locks, `fts` for findutils) is stubbed or
  patched (diffutils' `diff -r` has its `setjmp` taken out: wasm has
  none without exception handling, and wasi-libc's `strcoll` never fails,
  so nothing jumps). Only the programs are made: automake's
  `BUILT_SOURCES` first (gnulib's generated headers), then `lib/` when the
  tree is recursive (grep's, diffutils'), then each program
  (`gnulib-tests/` does not build for WASI and is not needed).
- **Output:** `target/NAME/NAME.wasm`; `runtime/build.py` ships it (its
  `WASM` and `RUNTIME_NAMES`, as `git`), `coreutils.ts`'s `PROGRAMS`
  names it, which puts a stub on PATH (`setup.ts`: brush looks a command
  up itself), and `deploy/build-site.sh` builds it. One build's several
  programs are `DIR/NAME` keys of `WASM` (`diffutils/diff`). Each takes
  the `processes` imports (at least gnulib's `dup2`), so a node's runs
  through the process table too (`portProgram` in `worker/index.ts`, as
  `git`).

## Measured by git's suite

`npm run test:git` (`app/test/git`, [git.md](git.md#tests)) runs git's own
`t/` with what the playground lacks borrowed from the host, and counts
it per script (`Machine.hosted`: grep, diff, cmp, awk, perl, find,
getconf). Each tool, once built, joins the harness's resolver (as
`git.wasm` and `coreutils.wasm` do) and leaves that count, with the pass
rate holding; a regression is the tool's, or the shared layer's. The
browser's tests (Playwright) add a few lines at the shell for each.

| Tool | Host runs it replaced | Suite (passed / failed) |
| --- | --- | --- |
| none (2026-10-22) | | 29,448 / 747 (97.53%) |
| `sed` | 22,049 | 29,451 / 744 (97.54%): no script fails a test it passed |
| `grep`, `diff`, `cmp` | 13,976, 22,367, 304 | 30,269 / 748 (97.59%): `t0450-txt-doc-vs-help` runs whole (7 → 829 passed); `t7063-status-untracked-cache` swings by as many with the host's tools (48–55 passed) |

**sed** (4.10, `sed/build.py`): 626 KB (195 KB gzipped). Built as is, no
patches. At the shell (`brush.spec.ts`): `-E` with back-references, `-i`
without a suffix, `e` through sh, a node's `System.cmd("sed", …)`; and
`git submodule add` of a local repository, `status` and `foreach`
(`git.spec.ts`). In Node (`processes.test.ts`): `-z`, `-i.bak`, `s///e`.

**grep** (3.12, `grep/build.py`): 665 KB (210 KB gzipped), without `-P`.
**diffutils** (3.12, `diffutils/build.py`, one patch): `diff` 646 KB,
`cmp` 398, `diff3` 406, `sdiff` 420. At the shell (`brush.spec.ts`):
grep's back-references, `-r` over the tree, its error and statuses;
`diff -u`, `cmp`, `diff3 -m` starting diff through sh; a node's grep. In
Node: the same, and `-v`, `-q`, `-c`.

## Order

1. **sed**: the pattern itself, and `git submodule` (done).
2. **grep** and **diffutils**: the same autoconf and gnulib, in turn (done).
3. **awk**: plain C and a Makefile; `system()` and pipes over the layer.
4. **findutils**: `fts` and `-exec`.
