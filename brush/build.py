"""brush, the terminal's shell, built to WebAssembly (wasm32-wasip1).

    python3 -I brush/build.py   # → target/brush/brush.wasm

brush with its line editor (reedline), from three submodules at release
tags, each with its patches/ applied to a copy:

- src/brush: on WASI, its external commands, pipes and files are the
  playground's, and reedline runs on one thread (docs/runtime.md); its
  workspace takes crossterm and fd-lock from beside it;
- src/crossterm: a WASI backend, the terminal through the host's
  `crossterm` imports (raw mode, size, input);
- src/fd-lock: WASI locks, always granted (reedline's history file).

Built in Docker, optimized for size; cached until the image, a
submodule's commit or the patches change.
"""

import hashlib
import io
import os
import shutil
import subprocess
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "target", "brush")
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
# rust:1.99-slim, as tools/coreutils/build.py.
IMAGE = "rust@sha256:4df2ae8cfdfebdfc13a65da7f253b73d68983dc0339f2719bc17a279c913b13d"
# The sources, as brush's workspace finds them (../crossterm, ../fd-lock).
SOURCES = ["brush", "crossterm", "fd-lock"]


def commit(name):
    return subprocess.run(["git", "-C", os.path.join(HERE, "src", name), "rev-parse", "HEAD"],
                          check=True, capture_output=True, text=True).stdout.strip()


def patches(name):
    directory = os.path.join(HERE, "patches", name)
    return [os.path.join(directory, f) for f in sorted(os.listdir(directory))] \
        if os.path.isdir(directory) else []


def stamp():
    """What the build is made from: the image, the commits, the patches."""
    hashed = hashlib.sha256(IMAGE.encode())
    for name in SOURCES:
        hashed.update(f"\0{name}\0{commit(name)}".encode())
        for path in patches(name):
            with open(path, "rb") as f:
                hashed.update(os.path.basename(path).encode() + b"\0" + f.read())
    return hashed.hexdigest()


def main():
    for name in SOURCES:
        if not os.path.exists(os.path.join(HERE, "src", name, "Cargo.toml")):
            raise SystemExit(f"brush/src/{name}: empty (git submodule update --init brush/src)")
    os.makedirs(OUT, exist_ok=True)
    built = os.path.join(OUT, "stamp")
    if os.path.exists(os.path.join(OUT, "brush.wasm")) and os.path.exists(built):
        with open(built) as f:
            if f.read() == stamp():
                return
    # Each submodule's commit, untouched, with our patches on a copy of it.
    work = os.path.join(OUT, "work")
    shutil.rmtree(work, ignore_errors=True)
    for name in SOURCES:
        archive = subprocess.run(["git", "-C", os.path.join(HERE, "src", name), "archive", "HEAD"],
                                 check=True, capture_output=True).stdout
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(os.path.join(work, name), filter="data")
        for path in patches(name):
            subprocess.run(["patch", "-p1", "-s", "-d", os.path.join(work, name), "-i", path],
                           check=True)
    cargo = os.path.join(OUT, "cargo")
    # Cargo's build, kept between builds: a changed patch rebuilds what it
    # changed (the copies keep their commit's times, from git archive).
    build = os.path.join(OUT, "cargo-target")
    os.makedirs(cargo, exist_ok=True)
    os.makedirs(build, exist_ok=True)
    # As root, for rustup's target in the image; the files back to us.
    script = (
        "rustup target add wasm32-wasip1 >/dev/null\n"
        "cd brush\n"
        "CARGO_PROFILE_RELEASE_OPT_LEVEL=z cargo build -q --locked --release "
        "--target wasm32-wasip1 -p brush-shell --no-default-features --features minimal,reedline\n"
        f"chown -R {os.getuid()}:{os.getgid()} /work /cargo /build\n"
    )
    subprocess.run(DOCKER + [
        "run", "--rm", "-e", "CARGO_HOME=/cargo", "-e", "CARGO_TARGET_DIR=/build",
        "-v", f"{work}:/work", "-v", f"{cargo}:/cargo", "-v", f"{build}:/build", "-w", "/work",
        IMAGE, "sh", "-ec", script,
    ], check=True)
    shutil.copy(os.path.join(build, "wasm32-wasip1", "release", "brush.wasm"),
                os.path.join(OUT, "brush.wasm"))
    with open(built, "w") as f:
        f.write(stamp())
    print(f"{OUT}/brush.wasm: {os.path.getsize(os.path.join(OUT, 'brush.wasm')) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
