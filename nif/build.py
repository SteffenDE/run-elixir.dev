"""NIF libraries for the playground, built to WebAssembly.

    python3 -I nif/build.py [PACKAGE...]   # → target/nif

Builds the erl_nif layer (beamos_nif.c) with wasi-sdk, then each package in
PACKAGES from its Hex tarball against it, in Docker. Each package's priv
files go into libraries/ABI/NAME-VERSION.tar, ABI the NIF ABI the layer and its
erl_nif.h make (abi(), docs/nif.md: 1-2.18), which the site serves under nif/
and the playground's `make` unpacks into the app's priv directory: the NIF
library is the file ERTS would load (priv/NAME.so), holding WebAssembly.
"""

import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "target", "nif")
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
# wasi-sdk 33 (clang 23).
IMAGE = "ghcr.io/webassembly/wasi-sdk@sha256:52595085a0ffbaf574d8d678a9aa81305f0b3af81c639291f15bc7713e42848e"

# Packages by name: the make targets elixir_make runs (the project's
# make_targets), and their versions, each with the variables its make_env
# gives the Makefile. `headers`: variables naming a Hex package's directory
# (FINE_INCLUDE_DIR: Fine.include_dir()). `prepare(work, env)`: what the
# Makefile would fetch and build itself, done beforehand.
PACKAGES = {
    "bcrypt_elixir": {"targets": ["all"], "versions": {"3.3.2": {}}},
    # Argon2's reference code runs its lanes in threads, which the layer
    # does not have: without them, one after another.
    "argon2_elixir": {"targets": ["all"], "versions": {"4.1.3": {"CFLAGS": "-O2 -DARGON2_NO_THREADS"}}},
    # Its Makefile builds into $(MIX_BUILD_PATH)/lib/picosat_elixir/priv:
    # that is the app's directory here.
    "picosat_elixir": {
        "targets": ["all"],
        # Without getrusage (WASI has no process clocks): its statistics
        # only; its NIF includes signal.h and uses nothing of it.
        "versions": {"0.2.3": {"MIX_BUILD_PATH": "/work/_mix_build",
                               "CC": "/tools/nifcc -DNGETRUSAGE -D_WASI_EMULATED_SIGNAL"}},
        "prepare": lambda work, env: build_path(work, "picosat_elixir"),
    },
    "lazy_html": {
        "targets": [],
        "versions": {"0.1.13": {"LEXBOR_GIT_SHA": "244b84956a6dc7eec293781d051354f351274c46"}},
        "headers": {"FINE_INCLUDE_DIR": ("fine", "0.1.6", "c_include")},
        "prepare": lambda work, env: lexbor(work, env["LEXBOR_GIT_SHA"]),
    },
}


def docker(mounts, script, env=()):
    command = DOCKER + ["run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}"]
    for host, guest, mode in mounts:
        command += ["-v", f"{host}:{guest}:{mode}"]
    for name, value in env:
        command += ["-e", f"{name}={value}"]
    subprocess.run(command + [IMAGE, "sh", "-ec", script], check=True)


def abi():
    """The NIF ABI: the layer's protocol (BEAMOS_NIF_ABI) and the erl_nif.h
    it is compiled with (its ERL_NIF_MAJOR_VERSION.ERL_NIF_MINOR_VERSION),
    as "1-2.18". runtime/build.py and the backend's image work it out the
    same way."""
    with open(os.path.join(HERE, "beamos_nif.c")) as f:
        layer = re.search(r"^#define BEAMOS_NIF_ABI (\d+)$", f.read(), re.M).group(1)
    with open(os.path.join(HERE, "include", "erl_nif.h")) as f:
        header = f.read()
    major, minor = (re.search(rf"^#define ERL_NIF_{part}_VERSION (\d+)$", header, re.M).group(1)
                    for part in ("MAJOR", "MINOR"))
    return f"{layer}-{major}.{minor}"


def layer():
    """erl_nif.h (OTP's, with our sizes) and beamos_nif.o."""
    include = os.path.join(OUT, "include")
    os.makedirs(include, exist_ok=True)
    for name in ("erl_nif.h", "erl_nif_api_funcs.h", "erl_drv_nif.h", "erl_int_sizes_config.h"):
        shutil.copy(os.path.join(HERE, "include", name), include)
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


def lexbor(work, sha):
    """lexbor at a commit, built for wasm32-wasip1 where lazy_html's Makefile
    looks for it (it would clone and build it itself)."""
    archive = os.path.join(OUT, "src", f"lexbor-{sha}.tar.gz")
    if not os.path.exists(archive):
        os.makedirs(os.path.dirname(archive), exist_ok=True)
        urllib.request.urlretrieve(f"https://github.com/lexbor/lexbor/archive/{sha}.tar.gz", archive + ".partial")
        os.rename(archive + ".partial", archive)
    directory = os.path.join(work, "_build", "c", "third_party", "lexbor", sha)
    os.makedirs(directory)
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            member.name = member.name.split("/", 1)[1] if "/" in member.name else ""
        tar.extractall(directory, members=[m for m in tar.getmembers() if m.name], filter="data")
    docker([(work, "/work", "rw")],
           f"cd /work/_build/c/third_party/lexbor/{sha} && "
           "cmake -S . -B build -G Ninja -DCMAKE_TOOLCHAIN_FILE=/opt/wasi-sdk/share/cmake/wasi-sdk-p1.cmake "
           "-DCMAKE_BUILD_TYPE=Release -DLEXBOR_BUILD_SHARED=OFF -DLEXBOR_BUILD_STATIC=ON "
           "-DLEXBOR_BUILD_SEPARATELY=OFF >/dev/null && cmake --build build >/dev/null && ls -la build/*.a")


def build_path(work, name):
    """A MIX_BUILD_PATH in the work tree whose lib/NAME is the app's
    directory (/app in the build's container)."""
    lib = os.path.join(work, "_mix_build", "lib")
    os.makedirs(lib)
    os.symlink("/app", os.path.join(lib, name))


def package(name, version, about):
    source = fetch(name, version)
    build = os.path.join(OUT, "build", f"{name}-{version}")
    shutil.rmtree(build, ignore_errors=True)
    work = os.path.join(build, "src")
    shutil.copytree(source, work)
    app = os.path.join(build, "app")
    os.makedirs(app)
    # elixir_make's environment, as far as Makefiles use it.
    # (A recipe's variables replace these.)
    env = {"CC": "/tools/nifcc", "CXX": "/tools/nifc++", "CFLAGS": "-O2", "CXXFLAGS": "-O2",
           "ERTS_INCLUDE_DIR": "/nif/include", "MIX_APP_PATH": "/app", "MIX_ENV": "prod",
           "MIX_TARGET": "host", "CROSSCOMPILE": "wasm32-wasip1"}
    variables = about["versions"][version]
    env.update(variables)
    for variable, (dep, dep_version, subdirectory) in about.get("headers", {}).items():
        fetch(dep, dep_version)
        env[variable] = f"/deps/{dep}-{dep_version}/{subdirectory}"
    if "prepare" in about:
        about["prepare"](work, variables)
    tools = os.path.join(OUT, "tools")
    os.makedirs(tools, exist_ok=True)
    for tool in ("nifcc", "nifc++"):
        shutil.copy(os.path.join(HERE, "nifcc"), os.path.join(tools, tool))
        os.chmod(os.path.join(tools, tool), 0o755)
    docker([(work, "/work", "rw"), (app, "/app", "rw"), (OUT, "/nif", "ro"), (tools, "/tools", "ro"),
            (os.path.join(OUT, "src"), "/deps", "ro")],
           f"cd /work && make {' '.join(about['targets'])}", env.items())
    os.makedirs(os.path.join(OUT, "libraries", abi()), exist_ok=True)
    out = os.path.join(OUT, "libraries", abi(), f"{name}-{version}.tar")
    with tarfile.open(out, "w", format=tarfile.USTAR_FORMAT) as tar:
        tar.add(os.path.join(app, "priv"), arcname="priv")
    print(f"{out}: {os.path.getsize(out)} bytes")


def main():
    layer()
    only = sys.argv[1:]
    for name, about in PACKAGES.items():
        if only and name not in only:
            continue
        for version in about["versions"]:
            package(name, version, about)


if __name__ == "__main__":
    main()
