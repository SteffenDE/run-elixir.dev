"""git built to WebAssembly (wasm32-wasip1): the git CLI itself, for the
shell and the nodes (docs/git.md).

    python3 -I git/build.py   # → target/git/git.wasm

git's release with patches/ applied, and zlib, built with wasi-sdk in
Docker (nif/build.py's image). WASI preview 1 lacks processes, users,
modes, terminals and sockets: wasi/ declares what git asks of them and
stubs it (stubs.c), its processes the playground's host's (the
`processes` imports, app/src/runtime/processes.ts: run-command.c spawns
instead of forking), and config.mak turns off the rest.
"""

import hashlib
import os
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "target", "git")
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
# wasi-sdk 33 (clang 23), as nif/build.py's.
IMAGE = "ghcr.io/webassembly/wasi-sdk@sha256:52595085a0ffbaf574d8d678a9aa81305f0b3af81c639291f15bc7713e42848e"
GIT = ("2.56.0", "https://mirrors.edge.kernel.org/pub/software/scm/git/git-2.56.0.tar.xz",
       "26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3")
ZLIB = ("1.3.2", "https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz",
        "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16")
# git's Makefile reads `uname` before config.mak: on the command line, so
# that the host's (Linux) settings stay out.
UNAME = "uname_S=WASI uname_M=wasm32 uname_O=WASI uname_R=1 uname_V=1"


def fetch(source, sha256, path):
    if not os.path.exists(path):
        urllib.request.urlretrieve(source, path + ".part")
        with open(path + ".part", "rb") as f:
            got = hashlib.sha256(f.read()).hexdigest()
        if got != sha256:
            raise SystemExit(f"{source}: sha256 {got}, not {sha256}")
        os.rename(path + ".part", path)


def stamp():
    """What the build is made from: the image, the sources, our files."""
    hashed = hashlib.sha256(f"{IMAGE}\0{GIT[2]}\0{ZLIB[2]}\0".encode())
    for directory, _, names in sorted(os.walk(HERE)):
        for name in sorted(names):
            if name.endswith(".py"):
                continue
            path = os.path.join(directory, name)
            with open(path, "rb") as f:
                hashed.update(os.path.relpath(path, HERE).encode() + b"\0" + f.read())
    return hashed.hexdigest()


def unpack(archive, name, into):
    shutil.rmtree(into, ignore_errors=True)
    with tarfile.open(archive) as tar:
        tar.extractall(OUT, filter="data")
    os.rename(os.path.join(OUT, name), into)


def main():
    os.makedirs(OUT, exist_ok=True)
    built = os.path.join(OUT, "stamp")
    if os.path.exists(os.path.join(OUT, "git.wasm")) and os.path.exists(built):
        with open(built) as f:
            if f.read() == stamp():
                return
    git_archive = os.path.join(OUT, f"git-{GIT[0]}.tar.xz")
    zlib_archive = os.path.join(OUT, f"zlib-{ZLIB[0]}.tar.gz")
    fetch(GIT[1], GIT[2], git_archive)
    fetch(ZLIB[1], ZLIB[2], zlib_archive)
    src = os.path.join(OUT, "src")
    zlib = os.path.join(OUT, "zlib-src")
    unpack(git_archive, f"git-{GIT[0]}", src)
    for name in sorted(os.listdir(os.path.join(HERE, "patches"))):
        subprocess.run(["patch", "-p1", "-s", "-d", src, "-i", os.path.join(HERE, "patches", name)],
                       check=True)
    unpack(zlib_archive, f"zlib-{ZLIB[0]}", zlib)
    shutil.copy(os.path.join(HERE, "config.mak"), os.path.join(src, "config.mak"))
    wasi = os.path.join(OUT, "wasi")
    shutil.rmtree(wasi, ignore_errors=True)
    shutil.copytree(os.path.join(HERE, "wasi"), wasi)
    cc = "/opt/wasi-sdk/bin/clang --target=wasm32-wasip1 --sysroot=/opt/wasi-sdk/share/wasi-sysroot"
    script = (
        # zlib's configure runs what it builds: its files by hand instead.
        "cd /zlib-src\n"
        "mkdir -p /zlib/include /zlib/lib\n"
        f"for c in adler32 compress crc32 deflate gzclose gzlib gzread gzwrite infback inffast "
        f"inflate inftrees trees uncompr zutil; do {cc} -Oz -DHAVE_UNISTD_H -DHAVE_STDARG_H -c $c.c -o $c.o; done\n"
        "/opt/wasi-sdk/bin/llvm-ar rcs /zlib/lib/libz.a *.o\n"
        "cp zlib.h zconf.h /zlib/include/\n"
        "cd /src\n"
        f"make -s -j$(nproc) {UNAME} git >/dev/null\n"
        f"chown -R {os.getuid()}:{os.getgid()} /src /zlib-src /zlib /wasi\n"
    )
    zlib_out = os.path.join(OUT, "zlib")
    os.makedirs(zlib_out, exist_ok=True)
    subprocess.run(DOCKER + [
        "run", "--rm", "-v", f"{src}:/src", "-v", f"{zlib}:/zlib-src", "-v", f"{zlib_out}:/zlib",
        "-v", f"{wasi}:/wasi", IMAGE, "sh", "-ec", script,
    ], check=True)
    shutil.copy(os.path.join(src, "git"), os.path.join(OUT, "git.wasm"))
    with open(built, "w") as f:
        f.write(stamp())
    print(f"{OUT}/git.wasm: {os.path.getsize(os.path.join(OUT, 'git.wasm')) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
