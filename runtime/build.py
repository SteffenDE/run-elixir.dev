"""Build a playground site into target/playground/SITE, ready to rsync:

    python3 -I playground/runtime/build.py elixir

The site's own files (playground/SITE), the runtime (wasi.js, worker.js),
rotp.wasm, and the installation (target/rotp) under fs/:

- fs/boot.tar.gz: what an IEx boot reads, recorded by booting IEx on the
  native rotp and listing code:all_loaded(), plus the preloaded erts
  modules and every .app, .boot and release file;
- fs/manifest.json: every other file's path and size, for stat and
  readdir;
- fs/files/PATH: those files, fetched by the node when it first opens one.
"""
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL = os.path.join(ROOT, "target", "rotp")
# Applications by name prefix: Elixir, IEx and Mix, and what they use.
APPS = ("erts-", "kernel-", "stdlib-", "compiler-", "elixir", "iex", "logger", "mix", "eex",
        "ex_unit", "crypto-", "asn1-", "public_key-", "ssl-", "inets-", "runtime_tools-",
        "syntax_tools-", "parsetools-", "sasl-", "tools-", "xmerl-")


def build_wasm():
    env = dict(os.environ, CARGO_TARGET_DIR=os.path.join(ROOT, "target", "wasm"),
               CARGO_PROFILE_RELEASE_DEBUG="false", CARGO_PROFILE_RELEASE_STRIP="true")
    subprocess.run(["cargo", "build", "--release", "--target", "wasm32-wasip1", "-p", "rotp"],
                   cwd=ROOT, env=env, check=True)
    return os.path.join(ROOT, "target", "wasm", "wasm32-wasip1", "release", "rotp.wasm")


def wanted(relative):
    parts = relative.split("/")
    if parts[0] == "bin":
        return relative.endswith(".boot")
    if parts[0] == "releases":
        return True
    if parts[0] == "lib" and len(parts) > 1:
        return parts[1].startswith(APPS) and (len(parts) < 3 or parts[2] in ("ebin", "priv"))
    return False


def booted():
    """The files (relative to the installation) an IEx boot loads."""
    with tempfile.TemporaryDirectory() as scratch:
        listing = os.path.join(scratch, "loaded")
        dump = os.path.join(scratch, "dump.exs")
        with open(dump, "w") as f:
            f.write(f"""spawn(fn -> Process.sleep(1000)
  files = for {{_, f}} <- :code.all_loaded(), is_list(f), do: Path.expand(List.to_string(f))
  File.write!({json.dumps(listing)}, Enum.join(files, "\\n")) end)
""")
        env = dict(os.environ, PATH=os.path.join(INSTALL, "bin") + os.pathsep + os.environ["PATH"])
        subprocess.run(["sh", "-c", f"(echo '1 + 1'; sleep 3) | iex --dot-iex {dump}"],
                       env=env, check=True, capture_output=True, timeout=120)
        with open(listing) as f:
            return {os.path.relpath(p, INSTALL) for p in f.read().split("\n") if p}


def main():
    site = sys.argv[1] if len(sys.argv) > 1 else "elixir"
    out = os.path.join(ROOT, "target", "playground", site)
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(os.path.join(ROOT, "playground", site), out)
    for name in ("wasi.js", "worker.js"):
        shutil.copy(os.path.join(HERE, name), os.path.join(out, name))
    shutil.copy(build_wasm(), os.path.join(out, "rotp.wasm"))
    boot = booted()
    files = []
    for directory, dirs, names in os.walk(INSTALL):
        dirs.sort()
        for name in sorted(names):
            relative = os.path.relpath(os.path.join(directory, name), INSTALL)
            if wanted(relative):
                files.append(relative)
    # rotp preloads all of erts's ebin (code:all_loaded() names no files
    # for preloaded modules).
    eager = [f for f in files if f in boot or f.endswith((".app", ".boot"))
             or f.startswith(("releases/", "lib/erts-"))]
    lazy = [f for f in files if f not in set(eager)]
    fs = os.path.join(out, "fs")
    with tarfile.open(os.path.join(fs + "-boot.tar.gz"), "w:gz", format=tarfile.USTAR_FORMAT) as tar:
        for relative in eager:
            tar.add(os.path.join(INSTALL, relative), arcname=os.path.join("rotp", relative), recursive=False)
    os.makedirs(fs)
    os.rename(fs + "-boot.tar.gz", os.path.join(fs, "boot.tar.gz"))
    manifest = []
    for relative in lazy:
        target = os.path.join(fs, "files", "rotp", relative)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy(os.path.join(INSTALL, relative), target)
        manifest.append(["rotp/" + relative, os.path.getsize(target)])
    with open(os.path.join(fs, "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    mb = lambda path: f"{os.path.getsize(path) / 1e6:.1f} MB"
    print(f"{out}: rotp.wasm {mb(os.path.join(out, 'rotp.wasm'))}; boot {len(eager)} files, "
          f"{mb(os.path.join(fs, 'boot.tar.gz'))}; {len(lazy)} lazy files")


main()
