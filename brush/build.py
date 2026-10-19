"""brush, the terminal's shell, built to WebAssembly (wasm32-wasip1).

    python3 -I brush/build.py   # → target/brush/brush.wasm

brush (upstream/, a submodule at a release tag) with patches/ applied: on
WASI, its external commands, pipes and files are the playground's
(docs/runtime.md). Built in Docker with its plain line reader (the
`minimal` feature), optimized for size; cached until the image, the
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
UPSTREAM = os.path.join(HERE, "upstream")
OUT = os.path.join(ROOT, "target", "brush")
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
# rust:1.99-slim, as coreutils/build.py.
IMAGE = "rust@sha256:4df2ae8cfdfebdfc13a65da7f253b73d68983dc0339f2719bc17a279c913b13d"


def commit():
    return subprocess.run(["git", "-C", UPSTREAM, "rev-parse", "HEAD"], check=True,
                          capture_output=True, text=True).stdout.strip()


def stamp():
    """What the build is made from: the image, the commit, the patches."""
    hashed = hashlib.sha256(f"{IMAGE}\0{commit()}\0".encode())
    for name in sorted(os.listdir(os.path.join(HERE, "patches"))):
        with open(os.path.join(HERE, "patches", name), "rb") as f:
            hashed.update(name.encode() + b"\0" + f.read())
    return hashed.hexdigest()


def main():
    if not os.path.exists(os.path.join(UPSTREAM, "Cargo.toml")):
        raise SystemExit(f"{UPSTREAM}: empty (git submodule update --init brush/upstream)")
    os.makedirs(OUT, exist_ok=True)
    built = os.path.join(OUT, "stamp")
    if os.path.exists(os.path.join(OUT, "brush.wasm")) and os.path.exists(built):
        with open(built) as f:
            if f.read() == stamp():
                return
    # The submodule's commit, untouched, with our patches on a copy of it.
    work = os.path.join(OUT, "src")
    shutil.rmtree(work, ignore_errors=True)
    archive = subprocess.run(["git", "-C", UPSTREAM, "archive", "HEAD"], check=True,
                             capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(work, filter="data")
    for name in sorted(os.listdir(os.path.join(HERE, "patches"))):
        subprocess.run(["patch", "-p1", "-s", "-d", work, "-i", os.path.join(HERE, "patches", name)],
                       check=True)
    cargo = os.path.join(OUT, "cargo")
    os.makedirs(cargo, exist_ok=True)
    # As root, for rustup's target in the image; the files back to us.
    script = (
        "rustup target add wasm32-wasip1 >/dev/null\n"
        "CARGO_PROFILE_RELEASE_OPT_LEVEL=z cargo build -q --locked --release "
        "--target wasm32-wasip1 -p brush-shell --no-default-features --features minimal\n"
        f"chown -R {os.getuid()}:{os.getgid()} /src /cargo\n"
    )
    subprocess.run(DOCKER + [
        "run", "--rm", "-e", "CARGO_HOME=/cargo",
        "-v", f"{work}:/src", "-v", f"{cargo}:/cargo", "-w", "/src",
        IMAGE, "sh", "-ec", script,
    ], check=True)
    shutil.copy(os.path.join(work, "target", "wasm32-wasip1", "release", "brush.wasm"),
                os.path.join(OUT, "brush.wasm"))
    with open(built, "w") as f:
        f.write(stamp())
    print(f"{OUT}/brush.wasm: {os.path.getsize(os.path.join(OUT, 'brush.wasm')) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
