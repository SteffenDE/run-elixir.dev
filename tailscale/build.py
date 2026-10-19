"""The playground's Tailscale node built to WebAssembly (js/wasm), which
the apex's shared worker runs (docs/tailscale.md).

    python3 -I tailscale/build.py   # → target/tailscale/tailscale.wasm

main.go over Tailscale's own client (tailscale.com, go.mod), built in
Docker with Tailscale's features the node does not use left out
(ts_omit_*). The site serves it beside the BEAM (r/RID/tailscale.wasm),
and the worker fetches it once someone sets Tailscale up. Go's
wasm_exec.js, which runs it, is kept here as the image's Go has it (the
app bundles it); a new image whose copy differs stops the build.
"""

import filecmp
import hashlib
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "target", "tailscale")
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
# golang:1.27 (1.27.2).
IMAGE = "golang@sha256:820153096fda4de6ac1b7194d12e416b7dd8f4e9a33d17e0345b111b945162d8"
# What the node needs: control, DERP, netstack, an exit node and its DNS
# (the peer API's client). The rest of a client goes.
OMIT = ["ssh", "taildrop", "drive", "tailnetlock", "capture", "webclient", "serve", "debug",
        "portmapper", "relayserver", "clientupdate", "c2n", "posture", "netlog", "wakeonlan",
        "appconnectors", "advertiseroutes", "advertiseexitnode", "syspolicy", "kube", "aws",
        "tpm", "clientmetrics", "usermetrics", "doctor", "oauthkey", "identityfederation"]
SOURCES = ["go.mod", "go.sum", "main.go", "wasm_exec.js"]


def stamp():
    """What the build is made from: the image, the tags, the sources."""
    hashed = hashlib.sha256(f"{IMAGE}\0{','.join(OMIT)}\0".encode())
    for name in SOURCES:
        with open(os.path.join(HERE, name), "rb") as f:
            hashed.update(name.encode() + b"\0" + f.read())
    return hashed.hexdigest()


def main():
    os.makedirs(OUT, exist_ok=True)
    built = os.path.join(OUT, "stamp")
    wasm = os.path.join(OUT, "tailscale.wasm")
    if os.path.exists(wasm) and os.path.exists(built):
        with open(built) as f:
            if f.read() == stamp():
                return
    # Go's module and build caches, kept between builds.
    cache = os.path.join(OUT, "gomod")
    os.makedirs(cache, exist_ok=True)
    tags = ",".join(f"ts_omit_{name}" for name in OMIT)
    script = (
        f"go build -trimpath -tags {tags} -ldflags='-s -w' -o /out/tailscale.wasm .\n"
        "cp \"$(go env GOROOT)/lib/wasm/wasm_exec.js\" /out/wasm_exec.js\n"
    )
    subprocess.run(DOCKER + [
        "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp",
        "-e", "GOOS=js", "-e", "GOARCH=wasm", "-e", "GOFLAGS=-mod=readonly -modcacherw",
        "-e", "GOMODCACHE=/cache/mod", "-e", "GOCACHE=/cache/build",
        "-v", f"{HERE}:/src:ro", "-v", f"{cache}:/cache", "-v", f"{OUT}:/out", "-w", "/src",
        IMAGE, "sh", "-ec", script,
    ], check=True)
    if not filecmp.cmp(os.path.join(OUT, "wasm_exec.js"), os.path.join(HERE, "wasm_exec.js"), shallow=False):
        raise SystemExit(f"{OUT}/wasm_exec.js: the image's Go has another; copy it to tailscale/wasm_exec.js")
    with open(built, "w") as f:
        f.write(stamp())
    print(f"{wasm}: {os.path.getsize(wasm) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
