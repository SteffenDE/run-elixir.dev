"""A Node.js process's TLS client (rustls, ring's crypto, Mozilla's roots)
built to WebAssembly (wasm32-wasip1), for tls.connect and HTTPS through the
tailnet (docs/nodejs.md).

    python3 -I tls/build.py   # → target/tls/tls.wasm

The crate (Cargo.toml, Cargo.lock, src/lib.rs) built in Docker, with clang
for ring's C and assembly. The site serves it beside the BEAM
(r/RID/tls.wasm), and a process fetches it once it first connects with TLS.
"""

import hashlib
import os
import shutil
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "target", "tls")
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
# rust:1.99-slim, as tools/coreutils/build.py's.
IMAGE = "rust@sha256:4df2ae8cfdfebdfc13a65da7f253b73d68983dc0339f2719bc17a279c913b13d"
SOURCES = ["Cargo.toml", "Cargo.lock", "src/lib.rs"]


def stamp():
    """What the build is made from: the image and the crate's files."""
    hashed = hashlib.sha256(f"{IMAGE}\0".encode())
    for name in SOURCES:
        with open(os.path.join(HERE, name), "rb") as f:
            hashed.update(name.encode() + b"\0" + f.read())
    return hashed.hexdigest()


def main():
    os.makedirs(OUT, exist_ok=True)
    built = os.path.join(OUT, "stamp")
    wasm = os.path.join(OUT, "tls.wasm")
    if os.path.exists(wasm) and os.path.exists(built):
        with open(built) as f:
            if f.read() == stamp():
                return
    # Cargo's registry and build, kept between builds.
    cargo = os.path.join(OUT, "cargo")
    build = os.path.join(OUT, "cargo-target")
    os.makedirs(cargo, exist_ok=True)
    os.makedirs(build, exist_ok=True)
    # As root, for apt and rustup's target in the image; the files back to us.
    script = (
        "apt-get update -qq >/dev/null && apt-get install -y -qq clang llvm >/dev/null\n"
        "rustup target add wasm32-wasip1 >/dev/null\n"
        "CC_wasm32_wasip1=clang AR_wasm32_wasip1=llvm-ar "
        "cargo build -q --locked --release --target wasm32-wasip1\n"
        f"chown -R {os.getuid()}:{os.getgid()} /cargo /build\n"
    )
    subprocess.run(DOCKER + [
        "run", "--rm", "-e", "DEBIAN_FRONTEND=noninteractive", "-e", "CARGO_HOME=/cargo",
        "-e", "CARGO_TARGET_DIR=/build",
        "-v", f"{HERE}:/src:ro", "-v", f"{cargo}:/cargo", "-v", f"{build}:/build", "-w", "/src",
        IMAGE, "sh", "-ec", script,
    ], check=True)
    shutil.copy(os.path.join(build, "wasm32-wasip1", "release", "tls.wasm"), wasm)
    with open(built, "w") as f:
        f.write(stamp())
    print(f"{wasm}: {os.path.getsize(wasm) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
