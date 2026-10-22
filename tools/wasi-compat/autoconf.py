"""A GNU tool (autoconf and gnulib) built to WebAssembly (wasm32-wasip1)
over tools/wasi-compat/: what tools/sed/build.py and the others like it share
(docs/tools.md). Each names its release and what to keep:

    build(HERE, "sed", ("4.10", URL, SHA256), {"sed": "sed/sed"}, ["--disable-acl"])
    # → target/sed/sed.wasm

The release tarball by URL and SHA-256, the tool's patches/ applied, its
own configure --host=wasm32-wasip1 and make in wasi-sdk 33's image (as
tools/git/build.py's, pinned by digest), -Oz. What WASI lacks is stubs.c's
(built as git's is, wasi-compat.h forced in), declared by wasi-posix.h,
which goes at the end of the tool's config.h: gnulib's replacement
headers want config.h first, and bring their own signals. What configure
cannot learn when cross-compiling, config.site answers: this directory's
for stubs.c's functions, then the tool's own.

Loaded by path (python3 -I leaves the script's directory off sys.path).
"""

import hashlib
import os
import shutil
import subprocess
import tarfile
import urllib.request

# The repository (this file is tools/wasi-compat/autoconf.py).
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
COMPAT = os.path.dirname(os.path.abspath(__file__))
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
# wasi-sdk 33 (clang 23), as nif/build.py's and tools/git/build.py's.
IMAGE = "ghcr.io/webassembly/wasi-sdk@sha256:52595085a0ffbaf574d8d678a9aa81305f0b3af81c639291f15bc7713e42848e"
CC = "/opt/wasi-sdk/bin/clang --target=wasm32-wasip1 --sysroot=/opt/wasi-sdk/share/wasi-sysroot"
# wasi-libc's emulations (signal, raise, clock, getpid, mmap), as git's.
EMULATED = ("signal", "process-clocks", "getpid", "mman")
CFLAGS = "-Oz -I/wasi/include " + " ".join(f"-D_WASI_EMULATED_{e.upper().replace('-', '_')}" for e in EMULATED)
# wrap.o wraps wasi-libc's fcntl (F_DUPFD by dup) and stat's kin (modes).
WRAPPED = ("fcntl", "stat", "lstat", "fstat", "fstatat")
LIBS = ("/wasi/stubs.o /wasi/wrap.o " + " ".join(f"-Wl,--wrap={name}" for name in WRAPPED) + " "
        + " ".join(f"-lwasi-emulated-{e}" for e in EMULATED))


def fetch(source, sha256, path):
    if not os.path.exists(path):
        urllib.request.urlretrieve(source, path + ".part")
        with open(path + ".part", "rb") as f:
            got = hashlib.sha256(f.read()).hexdigest()
        if got != sha256:
            raise SystemExit(f"{source}: sha256 {got}, not {sha256}")
        os.rename(path + ".part", path)


def stamp(here, release, configure):
    """What the build is made from: the image, the release, the options,
    the tool's files and this directory's (not .py files)."""
    hashed = hashlib.sha256("\0".join([IMAGE, release[2], *configure, ""]).encode())
    for top in (here, COMPAT):
        for directory, _, names in sorted(os.walk(top)):
            for name in sorted(names):
                if name.endswith(".py") or name == "__pycache__":
                    continue
                path = os.path.join(directory, name)
                with open(path, "rb") as f:
                    hashed.update(os.path.relpath(path, ROOT).encode() + b"\0" + f.read())
    return hashed.hexdigest()


def build(here, name, release, programs, configure=()):
    """`name`'s `release` (version, URL, SHA-256) built; `programs` maps
    each wasm to keep (target/NAME/KEY.wasm) to what make builds (a path
    in the source tree, its make target too)."""
    out = os.path.join(ROOT, "target", name)
    os.makedirs(out, exist_ok=True)
    built = os.path.join(out, "stamp")
    wasm = {key: os.path.join(out, f"{key}.wasm") for key in programs}
    made = stamp(here, release, configure)
    if all(map(os.path.exists, wasm.values())) and os.path.exists(built):
        with open(built) as f:
            if f.read() == made:
                return
    version, source, sha256 = release
    archive = os.path.join(out, os.path.basename(source))
    fetch(source, sha256, archive)
    src = os.path.join(out, "src")
    shutil.rmtree(src, ignore_errors=True)
    with tarfile.open(archive) as tar:
        tar.extractall(out, filter="data")
    os.rename(os.path.join(out, f"{name}-{version}"), src)
    patches = os.path.join(here, "patches")
    for patch in sorted(os.listdir(patches)) if os.path.isdir(patches) else ():
        subprocess.run(["patch", "-p1", "-s", "-d", src, "-i", os.path.join(patches, patch)], check=True)
    wasi = os.path.join(out, "wasi")
    shutil.rmtree(wasi, ignore_errors=True)
    shutil.copytree(COMPAT, wasi, ignore=shutil.ignore_patterns("*.py", "__pycache__"))
    sites = "/wasi/config.site" + (" /tool/config.site" if os.path.exists(os.path.join(here, "config.site")) else "")
    script = (
        f"{CC} {CFLAGS} -include /wasi/include/wasi-compat.h -c /wasi/stubs.c -o /wasi/stubs.o\n"
        f"{CC} {CFLAGS} -c /wasi/wrap.c -o /wasi/wrap.o\n"
        "cd /src\n"
        f"CONFIG_SITE='{sites}' ./configure --host=wasm32-wasip1 --disable-nls {' '.join(configure)} "
        f"CC='{CC}' CFLAGS='{CFLAGS}' LIBS='{LIBS}' >configure.out 2>&1 "
        "|| { tail -20 configure.out; tail -40 config.log; exit 1; }\n"
        # After config.h, whose #defines gnulib's headers want first.
        # (config.h, or lib/config.h: diffutils'.)
        "header=$(ls config.h lib/config.h 2>/dev/null | head -n 1)\n"
        "echo '#include <wasi-posix.h>' >> ${header:?configure made no config.h}\n"
        # The programs alone (gnulib-tests/ does not build for WASI), after
        # what automake makes first for `all` (gnulib's generated headers).
        "printf 'built-sources: $(BUILT_SOURCES)\\n' > built-sources.mk\n"
        "make -s -j$(nproc) -f Makefile -f built-sources.mk built-sources >/dev/null\n"
        # A recursive tree (grep's, diffutils': lib/, src/) makes gnulib's
        # lib/ (gawk's support/; findutils' gl/lib/, then its own lib/)
        # first, then each program in its directory; a flat one (sed's)
        # each from the top.
        "for lib in gl/lib lib support; do\n"
        "  if [ -f $lib/Makefile ]; then make -s -j$(nproc) -C $lib >/dev/null; fi\n"
        "done\n"
        f"for program in {' '.join(programs.values())}; do\n"
        "  dir=${program%/*}\n"
        "  if [ -f $dir/Makefile ]; then make -s -j$(nproc) -C $dir ${program##*/} >/dev/null\n"
        "  else make -s -j$(nproc) $program >/dev/null; fi\n"
        "done\n"
    )
    subprocess.run(DOCKER + [
        "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}", "-v", f"{src}:/src", "-v", f"{wasi}:/wasi",
        "-v", f"{here}:/tool:ro", IMAGE, "sh", "-ec", script,
    ], check=True)
    for key, path in programs.items():
        shutil.copy(os.path.join(src, path), wasm[key])
    with open(built, "w") as f:
        f.write(made)
    for path in wasm.values():
        print(f"{path}: {os.path.getsize(path) / 1e3:.0f} KB")
