"""Build the playground site into target/playground/site, ready to rsync:

    python3 -I playground/runtime/build.py
    python3 -I playground/runtime/build.py app   # just the page and the runtime's JavaScript

The site is the app's Vite build (playground/app, made in Docker), the
runtime's JavaScript, rotp.wasm, and a filesystem under fs/: the
installation (target/rotp) at /rotp and the Phoenix template, a phx.new
app, at /work/playground.

- fs/boot.tar.gz: what IEx reads first, recorded by running it in the
  WebAssembly node under Node (docker run node:24) with every file fetched
  lazily, plus what must be there before (.app, .boot and release files,
  erts's preloaded modules);
- fs/boot-phoenix.tar.gz: what `iex -S mix phx.server` in the template
  reads beyond that, recorded the same way, and the template's .app files;
- fs/manifest.json: every file not in boot.tar.gz (so also those of
  boot-phoenix.tar.gz, for projects that do not unpack it): its path,
  size, mtime and bundle, for stat and readdir;
- fs/bundles/N.tar: those files, a directory's in bundles of up to 512 KB,
  fetched whole by the node when it first opens one of them;
- fs/templates.json: each template's id (a digest of its files, without
  its build) and label; a project notes the template it was made from;
- fs/version: a digest of the above; a project's kept changes note the
  version they were made over.
- playground.json: the project domain, PLAYGROUND_DOMAIN in the build's
  environment (none: projects are paths, /ID/).

The template is generated once into target/playground-cache with the
native Rust-OTP: phx_new (PHX_NEW below), the playground's configuration,
deps fetched and compiled, assets built.
"""
import hashlib
import json
import re
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL = os.path.join(ROOT, "target", "rotp")
CACHE = os.path.join(ROOT, "target", "playground-cache")
RUNTIME = ("wasi.js", "worker.js", "host.js", "terminal.js", "programs.js", "setup.js", "postgres.js", "files.js", "vfs.js",
           "overlay.js", "fetcher.js", "bridge.js", "sw.js", "nif.js", "threads.js", "thread.js")
# Applications by name prefix: Elixir, IEx and Mix, and what they use.
APPS = ("erts-", "kernel-", "stdlib-", "compiler-", "elixir", "iex", "logger", "mix", "eex",
        "ex_unit", "crypto-", "asn1-", "public_key-", "ssl-", "inets-", "runtime_tools-",
        "syntax_tools-", "parsetools-", "sasl-", "tools-", "xmerl-", "os_mon-", "mnesia-")
PHX_NEW = "1.8.15"
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
NODE_IMAGE = "node:24"

# As worker.js launches Elixir, with the page's esbuild and tailwind.
ELIXIR = ["-noshell", "-elixir_root", "/rotp/lib", "-pa", "/rotp/lib/elixir/ebin",
          "-esbuild", "path", '<<"/usr/bin/esbuild">>', "-tailwind", "path", '<<"/usr/bin/tailwind">>']
IEX = ELIXIR + ["-user", "elixir", "-extra", "--no-halt", "+iex"]
# What each boot image records: erl arguments, the working directory, the
# node harness's environment, and standard input.
RECORD = {
    "boot": (IEX, "/work", {}, "1 + 1\n"),
    "boot-phoenix": (IEX + ["/rotp/bin/mix", "phx.server"], "/work/playground",
                     {"HTTP": "4000/", "STOP_SERVED": "5000", "STOP_AFTER": "120000", "NO_EOF": "1"}, ""),
}


# rotp.wasm for wasm32-wasip1, or (directory "wasm-threads") its threaded
# build for wasm32-wasip1-threads, which worker.js prefers where shared
# memory is (threads.js).
def build_wasm(target="wasm32-wasip1", directory="wasm"):
    env = dict(os.environ, CARGO_TARGET_DIR=os.path.join(ROOT, "target", directory),
               CARGO_PROFILE_RELEASE_DEBUG="false", CARGO_PROFILE_RELEASE_STRIP="true")
    subprocess.run(["cargo", "build", "--release", "--target", target, "-p", "rotp"],
                   cwd=ROOT, env=env, check=True)
    return os.path.join(ROOT, "target", directory, target, "release", "rotp.wasm")


# Mozilla's CA certificates (curl.se's extract), where OTP looks for the
# system's on Linux (public_key:cacerts_get/0): clients such as httpc and
# Mint ask for them before connecting, also when the host carries the TLS.
CACERTS = ("https://curl.se/ca/cacert-2026-09-25.pem",
           "a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505")


def cacerts():
    url, digest = CACERTS
    path = os.path.join(CACHE, os.path.basename(url))
    if not os.path.exists(path) or hashlib.sha256(open(path, "rb").read()).hexdigest() != digest:
        os.makedirs(CACHE, exist_ok=True)
        data = subprocess.run(["curl", "-sSfL", url], check=True, capture_output=True).stdout
        if hashlib.sha256(data).hexdigest() != digest:
            sys.exit(f"{url}: unexpected SHA-256")
        with open(path, "wb") as f:
            f.write(data)
    return path


def installed(relative):
    parts = relative.split("/")
    if parts[0] == "bin":
        return relative.endswith(".boot")
    if parts[0] == "releases":
        return True
    if parts[0] == "mix":
        # Mix archives built for Rust-OTP (Hex, phx_new), and rebar3.
        return len(parts) > 2 and parts[1] == "archives" or relative == "mix/rebar3"
    if parts[0] == "lib" and len(parts) > 1:
        return parts[1].startswith(APPS) and (len(parts) < 3 or parts[2] in ("ebin", "priv", "include"))
    return False


def rotp_env():
    return dict(os.environ, PATH=os.path.join(INSTALL, "bin") + os.pathsep + os.environ["PATH"])


# The playground's settings for a phx.new app's config/dev.exs: one
# connection to PGlite (one session). configure also sets the watchers
# (WATCHERS) and takes live reload out of runtime.exs (its socket needs a
# WebSocket, which the preview cannot open; the page reloads the preview).
DEV_EXS = """
# Playground: PGlite in the browser is one session.
config :playground, Playground.Repo, database: "postgres", pool_size: 1
"""
# phx.new's watchers; both run on the page (programs/esbuild.ts and
# tailwind.ts). The app's assets are built natively first, so the
# template starts with them.
WATCHERS = """  watchers: [
    esbuild: {Esbuild, :install_and_run, [:playground, ~w(--sourcemap=inline --watch)]},
    tailwind: {Tailwind, :install_and_run, [:playground, ~w(--watch)]}
  ]"""
RUNTIME_EXS = """# Playground: no live reload; the page reloads the preview.
"""


def configure(app):
    """The playground's settings in the app's config; whether they changed
    it."""
    def edit(name, change):
        path = os.path.join(app, "config", name)
        with open(path) as f:
            before = f.read()
        after = change(before)
        if after != before:
            with open(path, "w") as f:
                f.write(after)
        return after != before

    def dev(text):
        # Keyword lists merge in config, so the watchers are set in place.
        text = re.sub(r"  watchers: \[(?:\]|\n.*?\n  \])", WATCHERS, text, count=1, flags=re.S)
        if DEV_EXS not in text:
            text = text.split("\n# Playground:")[0].rstrip("\n") + "\n" + DEV_EXS
        return text

    def runtime(text):
        return re.sub(r"if config_env\(\) == :dev do\n  # Reload browser tabs.*?\nend\n", RUNTIME_EXS,
                      text, flags=re.S)
    changed = edit("dev.exs", dev)
    return edit("runtime.exs", runtime) or changed


def compiler_stamp():
    """The Rust-OTP that compiles the template: its backend decides the code."""
    with open(os.path.join(INSTALL, "bin", "rotp"), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def phoenix_app():
    """The phx.new app, generated once into the cache; built again when
    configure changes it or another Rust-OTP compiled it."""
    app = os.path.join(CACHE, "playground")
    env = rotp_env()
    stamp = os.path.join(CACHE, "playground.compiler")
    if os.path.exists(os.path.join(app, "priv", "static", "assets", "css", "app.css")):
        built = open(stamp).read() if os.path.exists(stamp) else None
        if built != compiler_stamp():
            shutil.rmtree(os.path.join(app, "_build_rotp", "dev"), ignore_errors=True)
            configure(app)
            subprocess.run(["mix", "compile"], cwd=app, env=env, check=True)
            with open(stamp, "w") as f:
                f.write(compiler_stamp())
        elif configure(app):
            subprocess.run(["mix", "compile"], cwd=app, env=env, check=True)
        return app
    os.makedirs(CACHE, exist_ok=True)
    if not os.path.isdir(os.path.join(INSTALL, "mix", "archives", f"phx_new-{PHX_NEW}")):
        subprocess.run(["mix", "archive.install", "hex", "phx_new", PHX_NEW, "--force"],
                       cwd=CACHE, env=env, check=True)
    shutil.rmtree(app, ignore_errors=True)
    subprocess.run(["mix", "phx.new", "playground", "--no-install"], cwd=CACHE, env=env, check=True,
                   input=b"n\n")
    subprocess.run(["mix", "deps.get"], cwd=app, env=env, check=True)
    # tailwind.install downloads 100 MB through httpc; curl does it.
    with open(os.path.join(app, "config", "config.exs")) as f:
        config = f.read()
    esbuild = config.split("config :esbuild,")[1].split('version: "')[1].split('"')[0]
    tailwind = config.split("config :tailwind,")[1].split('version: "')[1].split('"')[0]
    build = os.path.join(app, "_build_rotp")
    os.makedirs(build, exist_ok=True)
    binary = os.path.join(build, f"tailwind-linux-x64-{tailwind}")
    subprocess.run(["curl", "-sSfL", "-o", binary, "https://github.com/tailwindlabs/tailwindcss/releases/"
                    f"download/v{tailwind}/tailwindcss-linux-x64"], check=True)
    os.chmod(binary, 0o755)
    binary = os.path.join(build, "esbuild-linux-x64")
    package = subprocess.run(["curl", "-sSfL", f"https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-{esbuild}.tgz"],
                             check=True, capture_output=True).stdout
    with tarfile.open(fileobj=__import__("io").BytesIO(package)) as tar:
        with open(binary, "wb") as f:
            f.write(tar.extractfile("package/bin/esbuild").read())
    os.chmod(binary, 0o755)
    subprocess.run(["mix", "assets.build"], cwd=app, env=env, check=True)
    configure(app)
    subprocess.run(["mix", "compile"], cwd=app, env=env, check=True)
    with open(stamp, "w") as f:
        f.write(compiler_stamp())
    return app


def app_files(app):
    """(path in the node, path here) for the app at /work/playground: _build
    is _build_rotp; deps keep only the .git files Mix asks git about."""
    out = []
    # The build links each dependency's priv (and some src) to deps/; WASI has
    # no links, so their files are copied in place.
    for directory, dirs, names in os.walk(app, followlinks=True):
        dirs[:] = sorted(d for d in dirs if d != "node_modules"
                         and (not os.path.islink(os.path.join(directory, d)) or "_build_rotp" in directory))
        relative_dir = os.path.relpath(directory, app)
        parts = relative_dir.split(os.sep)
        if parts[0] in ("_build", ".elixir_ls") or (len(parts) > 2 and parts[0] == "deps" and parts[2] == ".git"):
            dirs[:] = []
            if len(parts) == 3 and parts[0] == "deps" and parts[2] == ".git":
                for name in ("config", "HEAD"):
                    if os.path.exists(os.path.join(directory, name)):
                        out.append((f"work/playground/{relative_dir}/{name}", os.path.join(directory, name)))
            continue
        if parts[0] == "_build_rotp" and len(parts) == 1:
            dirs[:] = [d for d in dirs if d == "dev"]
        for name in sorted(names):
            path = os.path.join(directory, name)
            if not os.path.isfile(path):
                continue
            relative = os.path.relpath(path, app)
            if relative.startswith("_build_rotp/") and relative.count("/") == 1:
                # The native esbuild and tailwind: the node runs the page's
                # (their :path, worker.js).
                continue
            relative = relative.replace("_build_rotp/", "_build/", 1)
            out.append(("work/playground/" + relative, path))
    return out


def vite_build(source):
    """A site's Vite app into its dist/, with Node in Docker."""
    script = "npm ci --no-audit --no-fund && npm run build"
    if os.path.isdir(os.path.join(source, "node_modules")):
        script = "npm run build"
    subprocess.run(DOCKER + ["run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp",
                             "-v", f"{os.path.dirname(source)}:/p", "-w", f"/p/{os.path.basename(source)}",
                             NODE_IMAGE, "sh", "-c", script], check=True)


def record(out, boot, snapshot):
    """The files a boot image's command fetches, run under Node; what it
    writes below /work goes to `snapshot` (Mix's builds name their absolute
    paths, so the app is compiled once more there, at /work/playground)."""
    args, cwd, env, stdin = RECORD[boot]
    with tempfile.TemporaryDirectory(dir=os.path.join(ROOT, "target")) as scratch:
        listing = os.path.join(scratch, "fetched")
        open(listing, "w").close()
        os.makedirs(snapshot)
        for path in (scratch, snapshot):
            os.chmod(path, 0o777)
        os.chmod(listing, 0o666)
        # Named, so a timeout stops the container itself: killing the docker
        # client leaves it running (one went on for an hour, its snapshot
        # directory deleted under it by the next build).
        name = f"playground-record-{boot}-{os.getpid()}"
        command = DOCKER + ["run", "--rm", "-i", "--name", name, "--user", f"{os.getuid()}:{os.getgid()}",
                            "-e", f"CWD={cwd}", "-e", "RECORD=/r/fetched",
                            "-e", "SNAPSHOT=/work:/s", "-v", f"{snapshot}:/s"]
        for name, value in env.items():
            command += ["-e", f"{name}={value}"]
        command += ["-v", f"{HERE}:/w:ro", "-v", f"{out}:/d:ro", "-v", f"{scratch}:/r",
                    NODE_IMAGE, "node", "/w/node.mjs", "/d", *args]
        try:
            result = subprocess.run(command, input=stdin.encode(), capture_output=True, timeout=600)
        except subprocess.TimeoutExpired:
            subprocess.run(DOCKER + ["kill", name], capture_output=True)
            raise
        sys.stderr.write(result.stderr.decode(errors="replace")[-2000:])
        with open(listing) as f:
            return {line for line in f.read().split("\n") if line}


def page(out):
    """The app's Vite build and the runtime's JavaScript into `out`."""
    source = os.path.join(ROOT, "playground", "app")
    vite_build(source)
    shutil.rmtree(os.path.join(out, "_playground"), ignore_errors=True)
    shutil.copytree(os.path.join(source, "dist"), out, dirs_exist_ok=True)
    for name in RUNTIME:
        shutil.copy(os.path.join(HERE, name), os.path.join(out, name))
    # Packages' NIF libraries built to WebAssembly (playground/nif/build.py),
    # which the node's make fetches.
    packages = os.path.join(ROOT, "target", "playground", "nif", "packages")
    if os.path.isdir(packages):
        shutil.copytree(packages, os.path.join(out, "nif"), dirs_exist_ok=True)
    # The project domain, if the site has one (PLAYGROUND_DOMAIN, such as
    # run-elixir.dev: projects at ID.run-elixir.dev; app/src/shared/lib/site.ts).
    with open(os.path.join(out, "playground.json"), "w") as f:
        json.dump({"domain": os.environ.get("PLAYGROUND_DOMAIN") or None}, f)


def main():
    out = os.path.join(ROOT, "target", "playground", "site")
    if sys.argv[1:] == ["app"]:
        page(out)
        return
    shutil.rmtree(out, ignore_errors=True)
    page(out)
    shutil.copy(build_wasm(), os.path.join(out, "rotp.wasm"))
    shutil.copy(build_wasm("wasm32-wasip1-threads", "wasm-threads"), os.path.join(out, "rotp-threads.wasm"))

    files = []  # (path in the node, path here)
    for directory, dirs, names in os.walk(INSTALL):
        dirs.sort()
        for name in sorted(names):
            relative = os.path.relpath(os.path.join(directory, name), INSTALL)
            if installed(relative):
                files.append(("rotp/" + relative, os.path.join(INSTALL, relative)))
    files.append(("etc/ssl/certs/ca-certificates.crt", cacerts()))
    files += app_files(phoenix_app())

    # Everything lazy first, to record what each boot image's command
    # fetches; only the Phoenix run's writes (the template, built at
    # /work/playground) are kept.
    fs = os.path.join(out, "fs")
    os.makedirs(fs)
    write_lazy(fs, files)
    for boot in RECORD:
        with tarfile.open(os.path.join(fs, f"{boot}.tar.gz"), "w:gz", format=tarfile.USTAR_FORMAT):
            pass
    fetched = {}
    for boot in RECORD:
        snapshot = os.path.join(CACHE, f"{boot}-snapshot")
        shutil.rmtree(snapshot, ignore_errors=True)
        fetched[boot] = record(out, boot, snapshot)
    # What the Phoenix run wrote replaces what was there.
    written = {}
    for directory, _, names in os.walk(os.path.join(CACHE, "boot-phoenix-snapshot")):
        for name in names:
            here = os.path.join(directory, name)
            written["work/" + os.path.relpath(here, os.path.join(CACHE, "boot-phoenix-snapshot"))] = here
    files = [(path, written.get(path, here)) for path, here in files] + sorted(
        (path, here) for path, here in written.items() if path not in {p for p, _ in files})

    # The template's files go only in the Phoenix image; an empty project
    # has none of them.
    needed = lambda path: path.endswith((".app", ".boot")) or path.startswith(("rotp/releases/", "rotp/lib/erts-"))
    images = {
        "boot": [(path, here) for path, here in files
                 if not path.startswith("work/") and (path in fetched["boot"] or needed(path))],
    }
    taken = {path for path, _ in images["boot"]}
    images["boot-phoenix"] = [(path, here) for path, here in files if path not in taken
                              and (path in fetched["boot-phoenix"] or needed(path))]
    for boot, eager in images.items():
        with tarfile.open(os.path.join(fs, f"{boot}.tar.gz"), "w:gz", format=tarfile.USTAR_FORMAT) as tar:
            for path, here in eager:
                tar.add(here, arcname=path, recursive=False)
    # Every project unpacks the first image; what the others hold stays
    # fetchable for projects that do not unpack them.
    lazy = [(path, here) for path, here in files if path not in taken]
    bundles = write_lazy(fs, lazy)
    # Which template a project was made from: its files (not its build,
    # which changes with the runtime), and what it is.
    template = hashlib.sha256()
    for path, here in sorted(files):
        if path.startswith("work/playground/") and not path.startswith("work/playground/_build/"):
            template.update(path.encode() + b"\0")
            with open(here, "rb") as f:
                template.update(f.read())
    with open(os.path.join(fs, "templates.json"), "w") as f:
        json.dump({"phoenix": {"id": template.hexdigest()[:12], "label": f"phx.new {PHX_NEW}"}}, f)
    # What a project's kept changes were made over (files.js).
    digest = hashlib.sha256()
    for name in sorted(os.listdir(fs)):
        if os.path.isfile(os.path.join(fs, name)):
            with open(os.path.join(fs, name), "rb") as f:
                digest.update(f.read())
    with open(os.path.join(fs, "version"), "w") as f:
        f.write(digest.hexdigest()[:16] + "\n")
    mb = lambda path: f"{os.path.getsize(path) / 1e6:.1f} MB"
    print(f"{out}: rotp.wasm {mb(os.path.join(out, 'rotp.wasm'))}, "
          f"rotp-threads.wasm {mb(os.path.join(out, 'rotp-threads.wasm'))}; " + "; ".join(
        f"{boot} {len(images[boot])} files ({len(fetched[boot])} recorded), {mb(os.path.join(fs, boot + '.tar.gz'))}"
        for boot in RECORD) + f"; {len(lazy)} lazy files in {bundles} bundles")


# A lazily fetched bundle holds files of one directory, up to this many
# bytes (one file may be bigger): a miss fetches its neighbours too, which
# a module's are likely to be needed next.
BUNDLE = 512 * 1024


def write_lazy(fs, files):
    """files in fs/bundles/N.tar (uncompressed: the server compresses, and
    the node reads them synchronously), and fs/manifest.json listing each
    with its size, mtime and bundle. The number of bundles."""
    shutil.rmtree(os.path.join(fs, "bundles"), ignore_errors=True)
    os.makedirs(os.path.join(fs, "bundles"))
    groups = []
    for path, here in sorted(files):
        size = os.path.getsize(here)
        group = groups[-1] if groups else None
        if not group or group["dir"] != os.path.dirname(path) or group["size"] + size > BUNDLE:
            group = {"dir": os.path.dirname(path), "size": 0, "files": []}
            groups.append(group)
        group["size"] += size
        group["files"].append((path, here))
    manifest = []
    for number, group in enumerate(groups):
        with tarfile.open(os.path.join(fs, "bundles", f"{number}.tar"), "w", format=tarfile.USTAR_FORMAT) as tar:
            for path, here in group["files"]:
                tar.add(here, arcname=path, recursive=False)
                manifest.append([path, os.path.getsize(here), int(os.path.getmtime(here)), number])
    with open(os.path.join(fs, "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    return len(groups)


main()
