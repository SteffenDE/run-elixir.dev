"""NIF libraries for the playground's tests, built as the backend builds
them: the backend's build.sh and recipes (backend/priv/nif/), run in its
guest's userspace (the Dockerfile's sandbox-image stage), with the
environment Playground.Nif.Runner gives a job.

    python3 -I tests/nif/build.py   # → target/test-nif/

The site bundles no NIF libraries: a page asks the backend (/api/v1/nif/,
docs/backend.md). In the tests, runtime/serve.py --nif answers from what
this builds into libraries/ABI/NAME-VERSION.tar: nif_fixture
(tests/nif/nif_fixture/, a NIF package of our own, in C++) and lazy_html
(the Phoenix template's, for mix test). And layer.so, layer.c's library,
which tests/nif/layer.py loads.
"""

import io
import os
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BACKEND = os.path.join(ROOT, "backend")
OUT = os.path.join(ROOT, "target", "test-nif")
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
IMAGE = "playground-sandbox-image"

# What each library is built from: its sources (a directory here, or a Hex
# package's), and its recipe.
LIBRARIES = {
    ("nif_fixture", "0.1.0"): {"source": os.path.join(HERE, "nif_fixture"), "recipe": "make all"},
    ("lazy_html", "0.1.13"): {"recipe": os.path.join(BACKEND, "priv", "nif", "recipes", "lazy_html.sh")},
}


def image():
    """The guest's userspace, from the backend's Dockerfile, and the NIF
    ABI its toolchain builds for."""
    subprocess.run(DOCKER + ["buildx", "build", "--load", "--quiet", "-t", IMAGE, "--target", "sandbox-image",
                             BACKEND], check=True, stdout=subprocess.DEVNULL)
    return subprocess.run(DOCKER + ["run", "--rm", IMAGE, "cat", "/nif/abi"], check=True, capture_output=True,
                          text=True).stdout.strip()


def hex_sources(name, version, into):
    """A Hex package's sources (its tarball's contents.tar.gz)."""
    with urllib.request.urlopen(f"https://repo.hex.pm/tarballs/{name}-{version}.tar") as response:
        outer = tarfile.open(fileobj=io.BytesIO(response.read()))
    with tarfile.open(fileobj=io.BytesIO(outer.extractfile("contents.tar.gz").read()), mode="r:gz") as inner:
        inner.extractall(into, filter="data")


def environment(name, version):
    """Playground.Nif.Runner's environment/2."""
    return {"SRC": "/workspace/src", "APP": "/workspace/app", "PKG_NAME": name, "PKG_VERSION": version,
            "CC": "/tools/nifcc", "CXX": "/tools/nifc++", "CFLAGS": "-O2", "CXXFLAGS": "-O2",
            "ERTS_INCLUDE_DIR": "/nif/include", "MIX_APP_PATH": "/workspace/app", "MIX_ENV": "prod",
            "MIX_TARGET": "host", "CROSSCOMPILE": "wasm32-wasip1", "HOME": "/workspace"}


def build(name, version, about, out):
    with tempfile.TemporaryDirectory(dir=os.path.join(ROOT, "target")) as workspace:
        source = os.path.join(workspace, "src")
        if "source" in about:
            shutil.copytree(about["source"], source)
        else:
            hex_sources(name, version, source)
        shutil.copy(os.path.join(BACKEND, "priv", "nif", "build.sh"), workspace)
        recipe = about["recipe"]
        if os.path.exists(recipe):
            shutil.copy(recipe, os.path.join(workspace, "recipe.sh"))
        else:
            with open(os.path.join(workspace, "recipe.sh"), "w") as f:
                f.write(recipe + "\n")
        command = DOCKER + ["run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
                            "-v", f"{workspace}:/workspace"]
        for variable, value in environment(name, version).items():
            command += ["-e", f"{variable}={value}"]
        result = subprocess.run(command + [IMAGE, "sh", "-eu", "/workspace/build.sh"], stdout=subprocess.PIPE)
        if result.returncode != 0:
            raise SystemExit(f"{name} {version}: the build failed ({result.returncode})")
        # The archive as the backend writes it anew: priv's regular files, ustar.
        built = tarfile.open(fileobj=io.BytesIO(result.stdout))
        partial = out + ".partial"
        with tarfile.open(partial, "w", format=tarfile.USTAR_FORMAT) as tar:
            for member in built.getmembers():
                if member.isdir() or member.isfile():
                    tar.addfile(member, built.extractfile(member) if member.isfile() else None)
        os.replace(partial, out)
        print(f"{out}: {os.path.getsize(out)} bytes")


def layer():
    """layer.c, built with nifcc as a recipe's Makefile would."""
    subprocess.run(DOCKER + ["run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
                             "-v", f"{HERE}:/src:ro", "-v", f"{OUT}:/out", IMAGE,
                             "/tools/nifcc", "-O2", "-I/nif/include", "-shared", "/src/layer.c",
                             "-o", "/out/layer.so"], check=True)
    print(f"{os.path.join(OUT, 'layer.so')}: built")


def main():
    abi = image()
    os.makedirs(OUT, exist_ok=True)
    layer()
    libraries = os.path.join(OUT, "libraries", abi)
    os.makedirs(libraries, exist_ok=True)
    for (name, version), about in LIBRARIES.items():
        out = os.path.join(libraries, f"{name}-{version}.tar")
        # The fixture's own sources change with the tests: always built.
        if "source" in about or not os.path.exists(out):
            build(name, version, about, out)


if __name__ == "__main__":
    main()
