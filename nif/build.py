"""NIF libraries for the playground, built to WebAssembly.

    python3 -I playground/nif/build.py   # → target/playground/nif

Builds the erl_nif layer (beamos_nif.c) with wasi-sdk, then each package in
PACKAGES from its Hex tarball against it, in Docker. Each package's priv
files go into packages/NAME-VERSION.tar, which the site serves under nif/
and the playground's `make` unpacks into the app's priv directory: the NIF
library is the file ERTS would load (priv/NAME.so), holding WebAssembly.
"""

import io
import os
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "target", "playground", "nif")
OTP_HEADERS = os.path.join(ROOT, "third_party", "otp", "erts", "emulator", "beam")
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
# wasi-sdk 33 (clang 23).
IMAGE = "ghcr.io/webassembly/wasi-sdk@sha256:52595085a0ffbaf574d8d678a9aa81305f0b3af81c639291f15bc7713e42848e"

# Packages by name: their versions and the make targets elixir_make runs
# (the project's make_targets).
PACKAGES = {
    "bcrypt_elixir": {"versions": ["3.3.2"], "targets": ["all"]},
}


def docker(mounts, script, env=()):
    command = DOCKER + ["run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}"]
    for host, guest, mode in mounts:
        command += ["-v", f"{host}:{guest}:{mode}"]
    for name, value in env:
        command += ["-e", f"{name}={value}"]
    subprocess.run(command + [IMAGE, "sh", "-ec", script], check=True)


def layer():
    """erl_nif.h (OTP's, with our sizes) and beamos_nif.o."""
    include = os.path.join(OUT, "include")
    os.makedirs(include, exist_ok=True)
    for name in ("erl_nif.h", "erl_nif_api_funcs.h", "erl_drv_nif.h"):
        shutil.copy(os.path.join(OTP_HEADERS, name), include)
    shutil.copy(os.path.join(HERE, "include", "erl_int_sizes_config.h"), include)
    os.makedirs(os.path.join(OUT, "lib"), exist_ok=True)
    docker([(HERE, "/src", "ro"), (OUT, "/nif", "rw")],
           "/opt/wasi-sdk/bin/clang -O2 -Wall -Wextra -Wno-unused-parameter -I/nif/include "
           "-c /src/beamos_nif.c -o /nif/lib/beamos_nif.o")


def fetch(name, version):
    """The package's sources (its Hex tarball's contents), cached."""
    source = os.path.join(OUT, "src", f"{name}-{version}")
    if os.path.isdir(source):
        return source
    url = f"https://repo.hex.pm/tarballs/{name}-{version}.tar"
    with urllib.request.urlopen(url) as response:
        outer = tarfile.open(fileobj=io.BytesIO(response.read()))
    contents = outer.extractfile("contents.tar.gz").read()
    partial = source + ".partial"
    shutil.rmtree(partial, ignore_errors=True)
    with tarfile.open(fileobj=io.BytesIO(contents), mode="r:gz") as inner:
        inner.extractall(partial, filter="data")
    os.rename(partial, source)
    return source


def package(name, version, targets):
    source = fetch(name, version)
    build = os.path.join(OUT, "build", f"{name}-{version}")
    shutil.rmtree(build, ignore_errors=True)
    work = os.path.join(build, "src")
    shutil.copytree(source, work)
    app = os.path.join(build, "app")
    os.makedirs(app)
    # elixir_make's environment, as far as Makefiles use it.
    env = [("CC", "/tools/nifcc"), ("CXX", "/tools/nifc++"), ("CFLAGS", "-O2"), ("CXXFLAGS", "-O2"),
           ("ERTS_INCLUDE_DIR", "/nif/include"), ("MIX_APP_PATH", "/app"), ("MIX_ENV", "prod"),
           ("MIX_TARGET", "host"), ("CROSSCOMPILE", "wasm32-wasip1")]
    tools = os.path.join(OUT, "tools")
    os.makedirs(tools, exist_ok=True)
    for tool in ("nifcc", "nifc++"):
        shutil.copy(os.path.join(HERE, "nifcc"), os.path.join(tools, tool))
        os.chmod(os.path.join(tools, tool), 0o755)
    docker([(work, "/work", "rw"), (app, "/app", "rw"), (OUT, "/nif", "ro"), (tools, "/tools", "ro")],
           f"cd /work && make {' '.join(targets)}", env)
    os.makedirs(os.path.join(OUT, "packages"), exist_ok=True)
    out = os.path.join(OUT, "packages", f"{name}-{version}.tar")
    with tarfile.open(out, "w", format=tarfile.USTAR_FORMAT) as tar:
        tar.add(os.path.join(app, "priv"), arcname="priv")
    print(f"{out}: {os.path.getsize(out)} bytes")


def main():
    layer()
    for name, about in PACKAGES.items():
        for version in about["versions"]:
            package(name, version, about["targets"])


if __name__ == "__main__":
    main()
