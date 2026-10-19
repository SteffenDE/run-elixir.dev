"""uutils coreutils built to WebAssembly (wasm32-wasip1), the playground's
ls, cp, rm, … (docs/runtime.md).

    python3 -I coreutils/build.py   # → target/coreutils/coreutils.wasm

One program for all of them, as BusyBox is: its first argument names the
tool. uutils' own feature set for WASI (feat_wasm), with patches/ applied,
built in Docker with the size profile (release-small). The site serves it
beside the BEAM (r/RID/coreutils.wasm), and a node or the shell fetches it
once it first runs one of them.
"""

import hashlib
import os
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "target", "coreutils")
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
# rust:1.99-slim.
IMAGE = "rust@sha256:4df2ae8cfdfebdfc13a65da7f253b73d68983dc0339f2719bc17a279c913b13d"
VERSION = "0.12.0"
SOURCE = f"https://github.com/uutils/coreutils/archive/refs/tags/{VERSION}.tar.gz"
SHA256 = "4fb327655cb4ffcbf2f16550cf9234079ffe839692f7aa1a6eda104af684e122"


def fetch(path):
    if not os.path.exists(path):
        urllib.request.urlretrieve(SOURCE, path + ".part")
        with open(path + ".part", "rb") as f:
            got = hashlib.sha256(f.read()).hexdigest()
        if got != SHA256:
            raise SystemExit(f"{SOURCE}: sha256 {got}, not {SHA256}")
        os.rename(path + ".part", path)


def stamp():
    """What the build is made from: the image, the version, the patches."""
    hashed = hashlib.sha256(f"{IMAGE}\0{SHA256}\0".encode())
    for name in sorted(os.listdir(os.path.join(HERE, "patches"))):
        with open(os.path.join(HERE, "patches", name), "rb") as f:
            hashed.update(name.encode() + b"\0" + f.read())
    return hashed.hexdigest()


def main():
    os.makedirs(OUT, exist_ok=True)
    built = os.path.join(OUT, "stamp")
    if os.path.exists(os.path.join(OUT, "coreutils.wasm")) and os.path.exists(built):
        with open(built) as f:
            if f.read() == stamp():
                return
    archive = os.path.join(OUT, f"coreutils-{VERSION}.tar.gz")
    fetch(archive)
    work = os.path.join(OUT, "src")
    shutil.rmtree(work, ignore_errors=True)
    with tarfile.open(archive) as tar:
        tar.extractall(OUT, filter="data")
    os.rename(os.path.join(OUT, f"coreutils-{VERSION}"), work)
    for name in sorted(os.listdir(os.path.join(HERE, "patches"))):
        subprocess.run(["patch", "-p1", "-s", "-d", work, "-i", os.path.join(HERE, "patches", name)],
                       check=True)
    cargo = os.path.join(OUT, "cargo")
    # Cargo's build, kept between builds: a changed patch rebuilds what it
    # changed (the tarball's files keep their times).
    build = os.path.join(OUT, "cargo-target")
    os.makedirs(cargo, exist_ok=True)
    os.makedirs(build, exist_ok=True)
    # As root, for rustup's target in the image; the files back to us.
    script = (
        "rustup target add wasm32-wasip1 >/dev/null\n"
        "cargo build -q --locked --profile release-small --target wasm32-wasip1 "
        "--no-default-features --features feat_wasm\n"
        f"chown -R {os.getuid()}:{os.getgid()} /src /cargo /build\n"
    )
    subprocess.run(DOCKER + [
        "run", "--rm", "-e", "CARGO_HOME=/cargo", "-e", "CARGO_TARGET_DIR=/build",
        "-v", f"{work}:/src", "-v", f"{cargo}:/cargo", "-v", f"{build}:/build", "-w", "/src",
        IMAGE, "sh", "-ec", script,
    ], check=True)
    shutil.copy(os.path.join(build, "wasm32-wasip1", "release-small", "coreutils.wasm"),
                os.path.join(OUT, "coreutils.wasm"))
    with open(built, "w") as f:
        f.write(stamp())
    print(f"{OUT}/coreutils.wasm: {os.path.getsize(os.path.join(OUT, 'coreutils.wasm')) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
