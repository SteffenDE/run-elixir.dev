"""git built to WebAssembly (wasm32-wasip1): the git CLI itself, for the
shell and the nodes (docs/git.md).

    python3 -I tools/git/build.py   # → target/git/git.wasm

git's release with patches/ applied, and zlib, built with wasi-sdk in
Docker (backend/Dockerfile's wasi-sdk). WASI preview 1 lacks processes, users,
modes, terminals and sockets: tools/wasi-compat/ (every C tool's) declares what
git asks of them and stubs it (stubs.c), its processes the playground's
host's (the `processes` imports, packages/runtime/src/processes.ts:
run-command.c spawns instead of forking), and config.mak turns off the
rest.
"""

import hashlib
import importlib.util
import os
import shutil
import subprocess
import tarfile
import urllib.request

# The repository (this file is tools/NAME/build.py).
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
# What WASI lacks, for every C tool (wasi-compat.h, stubs.c).
COMPAT = os.path.join(ROOT, "tools", "wasi-compat")
OUT = os.path.join(ROOT, "target", "git")
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
# wasi-sdk 33 (clang 23), as the backend's NIF toolchain (backend/Dockerfile).
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
    for top in (HERE, COMPAT):
        for directory, _, names in sorted(os.walk(top)):
            for name in sorted(names):
                if name.endswith(".py"):
                    continue
                path = os.path.join(directory, name)
                with open(path, "rb") as f:
                    hashed.update(os.path.relpath(path, ROOT).encode() + b"\0" + f.read())
    return hashed.hexdigest()


def licensed(git_archive, zlib_archive):
    """target/git/licenses (tools/licenses.py) and target/git/source: git is
    GPL-2.0, so its source goes with it: the releases, the patches and the
    build's files, zlib's too (git links it)."""
    spec = importlib.util.spec_from_file_location("licenses", os.path.join(ROOT, "tools", "licenses.py"))
    licenses = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(licenses)
    if licenses.current(OUT, stamp()):
        return
    fetch(GIT[1], GIT[2], git_archive)
    fetch(ZLIB[1], ZLIB[2], zlib_archive)
    zlib = licenses.Inventory().add("zlib", ZLIB[0], "Zlib", "https://zlib.net",
                                    licenses.archive_texts(zlib_archive, f"zlib-{ZLIB[0]}", ["LICENSE"]))
    sources = {os.path.basename(git_archive): git_archive, os.path.basename(zlib_archive): zlib_archive,
               "tools/git/build.py": os.path.join(HERE, "build.py"),
               "tools/git/config.mak": os.path.join(HERE, "config.mak"),
               "tools/git/patches": os.path.join(HERE, "patches"), "tools/wasi-compat": COMPAT}
    inventory = licenses.c_tool(OUT, "git", GIT[0], "GPL-2.0-only", "https://git-scm.com", git_archive,
                                ["COPYING", "LGPL-2.1"], sources, "tools/git/build.py", [zlib])
    licenses.finish(inventory, OUT, stamp())


def unpack(archive, name, into):
    shutil.rmtree(into, ignore_errors=True)
    with tarfile.open(archive) as tar:
        tar.extractall(OUT, filter="data")
    os.rename(os.path.join(OUT, name), into)


# git's commands that are shell scripts (its SCRIPT_SH and SCRIPT_LIB), which
# the playground's sh runs from git's exec path.
SCRIPTS = [
    "git-difftool--helper", "git-filter-branch", "git-merge-octopus", "git-merge-one-file",
    "git-merge-resolve", "git-mergetool", "git-quiltimport", "git-request-pull", "git-submodule",
    "git-web--browse", "git-mergetool--lib", "git-sh-i18n", "git-sh-setup",
]


def main():
    os.makedirs(OUT, exist_ok=True)
    built = os.path.join(OUT, "stamp")
    git_archive = os.path.join(OUT, f"git-{GIT[0]}.tar.xz")
    zlib_archive = os.path.join(OUT, f"zlib-{ZLIB[0]}.tar.gz")
    if os.path.exists(os.path.join(OUT, "git.wasm")) and os.path.exists(built):
        with open(built) as f:
            if f.read() == stamp():
                return licensed(git_archive, zlib_archive)
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
    shutil.copytree(COMPAT, wasi)
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
        # test-tool, GIT-BUILD-OPTIONS and templates/blt: for git's own tests
        # (packages/runtime/test/git).
        f"make -s -j$(nproc) {UNAME} git {' '.join(SCRIPTS)} t/helper/test-tool GIT-BUILD-OPTIONS >/dev/null\n"
        "make -s -C templates >/dev/null\n"
        f"chown -R {os.getuid()}:{os.getgid()} /src /zlib-src /zlib /wasi\n"
    )
    zlib_out = os.path.join(OUT, "zlib")
    os.makedirs(zlib_out, exist_ok=True)
    subprocess.run(DOCKER + [
        "run", "--rm", "-v", f"{src}:/src", "-v", f"{zlib}:/zlib-src", "-v", f"{zlib_out}:/zlib",
        "-v", f"{wasi}:/wasi", IMAGE, "sh", "-ec", script,
    ], check=True)
    shutil.copy(os.path.join(src, "git"), os.path.join(OUT, "git.wasm"))
    shutil.copy(os.path.join(src, "t", "helper", "test-tool"), os.path.join(OUT, "test-tool.wasm"))
    # The scripts, for the site's /usr/libexec/git-core (runtime/build.py).
    libexec = os.path.join(OUT, "libexec")
    shutil.rmtree(libexec, ignore_errors=True)
    os.makedirs(libexec)
    for name in SCRIPTS:
        shutil.copy(os.path.join(src, name), os.path.join(libexec, name))
    # The build's paths, as the tests on the host see them (not Docker's /src).
    options = os.path.join(src, "GIT-BUILD-OPTIONS")
    with open(options) as f:
        text = f.read().replace("='/src", f"='{src}")
    with open(options, "w") as f:
        f.write(text)
    with open(built, "w") as f:
        f.write(stamp())
    licensed(git_archive, zlib_archive)
    print(f"{OUT}/git.wasm: {os.path.getsize(os.path.join(OUT, 'git.wasm')) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
