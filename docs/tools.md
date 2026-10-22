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
| `awk`, `gawk` | GNU awk | What Fedora, Arch and most answers online assume: `gensub`, `asort`, `strftime`, `-i inplace`, arrays of arrays; built as the other GNU tools are (BWK's awk, planned first for being small and plain C, lacks them, and its size no longer matters: a program loads when first run) |
| `find` | GNU findutils | `-exec`, `-print0`, as scripts use them (`xargs` is `utilities.ts`'s) |

Not `perl`: none of git's scripts for the shell need it, only some of its
tests. The BSD versions would build more easily but differ where scripts
notice (`sed -i ''`). Licences: GPLv3 for GNU's; the site already ships
GPLv2 git, so the same holds: the tarballs and patches we build from are
the source to offer.

## Building them

One pattern for all, as `tools/git/build.py`'s. Each tool is a directory
of `tools/` (`build.py`, `patches/`, `config.site`), beside
`tools/coreutils/`, `tools/ripgrep/` and the shared C layer,
`tools/wasi-compat/`; what each builds goes to `target/NAME/`.

- **The image:** wasi-sdk 33's (`nif/build.py`'s, pinned by digest); a
  release tarball by URL and SHA-256, `patches/` applied, the tool's own
  `configure --host=wasm32-wasip1`, then `make`, `-Oz`.
  `tools/wasi-compat/autoconf.py` does it for the GNU tools (sed's, grep's,
  diffutils'); each `tools/NAME/build.py` names its release, its configure
  options and what to keep. It is loaded by path: `python3 -I` leaves
  the script's directory off `sys.path`.
- **A shared C layer**, `tools/wasi-compat/` (once git's `git/wasi/`),
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
  in. It also has `getgroups` (none), `getgrnam` (no named groups) and
  an empty mount table (`mntent.h`, for gnulib's mountlist: `find
  -fstype`). `wrap.c`, for the autoconf tools (`-Wl,--wrap=NAME`), wraps
  wasi-libc's own calls: `fcntl`'s `F_DUPFD` and `F_DUPFD_CLOEXEC` by
  `dup`, which wasi-libc refuses and gnulib's `fts` (`grep -r`, `find`)
  needs; and `stat`, `lstat`, `fstat`, `fstatat` with the permission bits
  git's get (`rw-r--r--` for a file, `rwxr-xr-x` for a directory), so that
  `find -perm 644` and `-printf %m` answer as git's modes say.
- **Two headers:** `wasi-posix.h` declares what `stubs.c` defines
  (wasi-libc declares some, behind `__wasilibc_unmodified_upstream`, and
  defines none; and `qsort_r`, which wasi-libc has and declares only in
  an `#ifdef` for `wait`). `wasi-compat.h` is git's: `wasi-posix.h`, then what git
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
  `tools/wasi-compat/config.site` says each is there and declared, except
  `fork` and `exec`, which fail, so that a tool starts programs by
  `popen` and `system`. Then the tool's own `config.site`, for what
  configure cannot run when cross-compiling (sed's: gnulib's regex and
  getopt, as Linux's sed has them). What configure guesses otherwise
  ("guessing no") has gnulib's replacement built in, a little larger and
  as correct.
- **A tool's config.site** also answers what configure cannot run and
  has no guess for (diffutils': `strcasecmp`), and turns off what WASI
  cannot do that configure would find (gawk's: `/inet` sockets, and ptys
  for `|&`, so that a coprocess is two pipes).
- **gnulib** (GNU's portability layer) brings its own replacements where
  WASI lacks a function; what it still misses (signals beyond WASI's
  emulated ones, `fcntl` locks, `fts` for findutils) is stubbed or
  patched. Only the programs are made: automake's `BUILT_SOURCES` first
  (gnulib's generated headers), then `lib/` (gawk's `support/`,
  findutils' `gl/lib/` before its own `lib/`) when the
  tree is recursive (grep's, diffutils', gawk's), then each program
  (`gnulib-tests/` does not build for WASI and is not needed).
- **setjmp:** wasm has none without exception handling, so
  `tools/wasi-compat/include/setjmp.h` stands in for wasi-libc's: `setjmp`
  returns 0, a `longjmp` ends the program saying so. The tools jump only
  where WASI never leads them: gawk's debugger (`gawk -D`), `diff -r`
  when `strcoll` fails (wasi-libc's never does).
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
it per script (`Machine.hosted`: perl, getconf, gpg, …). The host's
`find` there was bfs, not GNU's. Each tool, once built, joins the harness's resolver (as
`git.wasm` and `coreutils.wasm` do) and leaves that count, with the pass
rate holding; a regression is the tool's, or the shared layer's. The
browser's tests (Playwright) add a few lines at the shell for each.

| Tool | Host runs it replaced | Suite (passed / failed) |
| --- | --- | --- |
| none (2026-10-22) | | 29,448 / 747 (97.53%) |
| `sed` | 22,049 | 29,451 / 744 (97.54%): no script fails a test it passed |
| `grep`, `diff`, `cmp` | 13,976, 22,367, 304 | 30,269 / 748 (97.59%): `t0450-txt-doc-vs-help` runs whole (7 → 829 passed); `t7063-status-untracked-cache` swings by as many with the host's tools (48–55 passed) |
| `awk` (gawk) | 435 | 30,273 / 744 (97.60%): no script fails a test it passed |
| `chmod` (`utilities.ts`, no modes) | 1,014 | 30,271 / 746 (97.59%): only the two scripts that flip between runs (`t5200` 6, `t7063` 12) |
| `find` | 144 | 30,268 / 749 (97.59%): `t5605-clone-local` 7 now fails: its `find -links 1` sees the shim's link count, always 1 (bfs saw the host's); `t7063` as ever |

**sed** (4.10, `tools/sed/build.py`): 626 KB (195 KB gzipped). Built as is, no
patches. At the shell (`brush.spec.ts`): `-E` with back-references, `-i`
without a suffix, `e` through sh, a node's `System.cmd("sed", …)`; and
`git submodule add` of a local repository, `status` and `foreach`
(`git.spec.ts`). In Node (`processes.test.ts`): `-z`, `-i.bak`, `s///e`.

**grep** (3.12, `tools/grep/build.py`): 665 KB (210 KB gzipped), without `-P`.
**diffutils** (3.12, `tools/diffutils/build.py`, one patch): `diff` 646 KB,
`cmp` 398, `diff3` 406, `sdiff` 420. At the shell (`brush.spec.ts`):
grep's back-references, `-r` over the tree, its error and statuses;
`diff -u`, `cmp`, `diff3 -m` starting diff through sh; a node's grep. In
Node: the same, and `-v`, `-q`, `-c`.

**gawk** (5.4.1, `tools/gawk/build.py`, one patch): 1.5 MB (415 KB gzipped),
as `awk` and `gawk`. Its five places that fork (`cmd | getline`,
`print | cmd`, `|&`, `system()`, and `wait_any`'s `waitpid(-1)`) take
`__wasi__` branches beside MinGW's: `wasi_spawn` of `sh -c`, and waits
for the pids it knows. Without `-M`, dynamic extensions, `/inet` and the
debugger's jumps. At the shell and in Node: fields, `gensub`, `asort`,
both pipes, a `|&` coprocess with `close(cmd, "to")`, `system()`'s
status, a node's awk.

**find** (findutils 4.11.0, `tools/findutils/build.py`, one patch): 877 KB.
Not findutils' `xargs` (the shell's is `utilities.ts`'s) nor `locate`.
It walks with gnulib's `fts` from descriptors (`FTS_CWDFD`), so it never
changes directory; the patch makes `-exec` and `-execdir` (and `-ok`)
spawn instead of forking, in find's own directory or, for `-execdir`, the
file's by its path (WASI cannot name a descriptor's directory: the
predicate passes the full path along); `run_in_dir` and the restore of
the initial directory do nothing on WASI; and gnulib's
`getlocalename_l-unsafe.c` takes wasi-libc for musl. gnulib's `fchdir`
emulation (directory names kept by descriptor, as for MinGW) is in for
what else calls it. As GNU's: `-exec … \;` of a missing program is false
(status 0), `-exec … +` fails find (1); messages quoted `‘…’`, a UTF-8
locale being wasi-libc's. `-executable` is always true (as the shell's
`test -x`), `-user` any name, `-fstype` matches nothing.

**chmod** is the shell's own (`utilities.ts`), not coreutils' (WASI has
no modes): it checks the mode's syntax (octal, symbolic) and that each
file is there, with GNU's messages and statuses, and changes nothing.

## Order

1. **sed**: the pattern itself, and `git submodule` (done).
2. **grep** and **diffutils**: the same autoconf and gnulib, in turn (done).
3. **awk**: gawk, as the others are; its pipes, `|&` and `system()` over the layer (done).
4. **findutils**: `fts` and `-exec` (done); `chmod` beside it.
