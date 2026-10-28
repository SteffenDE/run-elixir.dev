"""Build the playground site into target/site, ready to rsync:

    python3 -I runtime/build.py
    python3 -I runtime/build.py app   # the JavaScript and the WebAssembly tools again

The site is the app's Vite builds (app/, made in Docker): the apex's
pages; and the npm packages of docs/packages.md, each in a directory of
its own, npm/@elixir-playground/NAME@VERSION+ID/ (ID a digest of what is
in it), with its package.json and its files:

- runtime: the runtime's workers and the usercontent domain's frames;
- otp-X: OTP's own emulator built with Emscripten (beam/build.sh:
  beam.mjs, beam.emu.mjs and beam.wasm), and OTP's applications (the
  installation, target/otp) as an fs layer at /opt/otp/X in the node;
- elixir-X: the host's Elixir, Hex, phx_new and rebar3, an fs layer at
  /opt/elixir/X, with Mix's script (bin/mix) as its command;
- phoenix-template: a phx.new app, an fs layer at /work/playground;
- shell, git, ripgrep, gnu-tools, tls, tailscale: the WebAssembly tools,
  built by their own scripts; claude; api (embed.js).

An fs layer is fs/manifest.json (each file's path below the layer's root,
size, mtime and bundle, for stat and readdir) and fs/bundles/N.tar (a
directory's files in bundles of up to 512 KB, fetched whole by the node
when it first opens one of them). Each package's files come from its own
build or installation (fs_layers), and each package says where they go
(PACKAGES' root), which commands it has (bin, linked from /usr/bin) and
which variables name its paths (env). A layer's bundles and the boot images are the same bytes for
the same files (MTIME, header), so a package's directory keeps its name
across builds. Beside the packages:

- boot/ID/: boot.tar.gz, what IEx reads first, recorded by running it in
  the WebAssembly node under Node (docker run node:24) with every file
  fetched lazily, plus what must be there before (.app, .boot and release
  files, erts's preloaded modules); boot-phoenix.tar.gz, what
  `iex -S mix phx.server` in the template reads beyond that, recorded the
  same way, and the template's .app files;
- site/ID.json: the site manifest: each package's version, files, peer
  dependencies and `playground` field (where its fs layer is, its
  programs, its ABIs) and the recordings. The runtime
  finds what it runs through it, and checks the packages against itself
  as a project starts;
- playground.json: the apex and the usercontent domain,
  PLAYGROUND_DOMAIN and PLAYGROUND_USERCONTENT in the build's environment
  (app/src/shared/lib/site.ts, docs/frames.md), and the origins that may
  frame embed.html, PLAYGROUND_EMBEDDERS (docs/embed.md);
- sw.js, one for the site's every version (docs/packages.md: its
  protocol), and embed.js, at the root.

Each page names the runtime package and the site manifest it runs with
(<meta name="playground-runtime"> and <meta name="playground-site">, the
app's src/shared/lib/build.ts). All of these are immutable, so a page
loaded before a deploy keeps loading its own build's files while the
server still has them.

The template is generated once into target/cache-otp with the host's
Mix (the same OTP and Elixir): phx_new (PHX_NEW below), the playground's
configuration, deps fetched and compiled, assets built.
"""
import gzip
import hashlib
import json
import re
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(path):
    """A module of the repository's, by path (python3 -I leaves the
    script's directory off sys.path)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(os.path.splitext(os.path.basename(path))[0],
                                                  os.path.join(ROOT, path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Each package's licenses, and the site's licenses page (docs/licenses.md).
notices = load("runtime/notices.py")
INSTALL = os.path.join(ROOT, "target", "otp")
CACHE = os.path.join(ROOT, "target", "cache-otp")
# The template's build directory, the host Mix's own (the node runs the
# same OTP and Elixir, so the same code).
BUILD = "_build_otp"
# beam/build.sh's output for the site.
BEAM_DIST = os.path.join(ROOT, "out", "beam-wasm", "site")
# The Node harness, bundled by the Vite build (node.mjs): the recording
# runs and tests/nif/layer.py run it.
NODE = os.path.join(ROOT, "target", "node")
# OTP's applications by name prefix: what Elixir, IEx and Mix use (the
# otp-X package's fs layer, otp_files).
APPS = ("erts-", "kernel-", "stdlib-", "compiler-", "crypto-", "asn1-", "public_key-", "ssl-",
        "inets-", "runtime_tools-", "syntax_tools-", "parsetools-", "sasl-", "tools-", "xmerl-",
        "os_mon-", "mnesia-")
# Elixir's applications, the host installation's (the elixir-X package's
# fs layer, elixir_files).
ELIXIR_APPS = ("elixir", "eex", "ex_unit", "iex", "logger", "mix")
# The mtime of every file in an fs layer and a boot image (2000-01-01),
# and of nothing a node writes (now). The same files then make the same
# bundles and images, byte for byte, and a package keeps its directory's
# name (ID) across builds. Mix compares mtimes with > alone (a source
# against its manifest, mix.exs and config/ against what the manifest
# recorded), and the recording run sees this mtime too, so what the
# template's manifests record is what a node finds, and nothing is stale
# at boot. Not 0: the runtime takes 0 for none (wasi/fs.ts mount), and Mix
# takes it for a missing file.
MTIME = 946684800
PHX_NEW = "1.8.15"
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
NODE_IMAGE = "node:24"

# The boot images, and what each records.
RECORD = ("boot", "boot-phoenix")


def root_of(key, versions):
    """Where a package's fs layer goes in the node (PACKAGES' root)."""
    return PACKAGES[key]["root"].format(**versions)


def record_args(boot, versions):
    """What a boot image's command is: erl arguments (as worker/index.ts
    launches IEx, with the page's esbuild and tailwind, from where the
    packages are), the working directory, the node harness's environment,
    and standard input."""
    elixir = root_of("elixir-{elixir}", versions)
    iex = ["-noshell", "-elixir_root", f"{elixir}/lib", "-pa", f"{elixir}/lib/elixir/ebin",
           "-esbuild", "path", '<<"/usr/bin/esbuild">>', "-tailwind", "path", '<<"/usr/bin/tailwind">>',
           "-user", "elixir", "-extra", "--no-halt", "+iex"]
    if boot == "boot":
        return iex, "/work", {}, "1 + 1\n"
    return (iex + [f"{elixir}/bin/mix", "phx.server"], root_of("phoenix-template", versions),
            {"HTTP": "4000/", "STOP_SERVED": "5000", "STOP_AFTER": "120000", "NO_EOF": "1"}, "")


# Mozilla's CA certificates (curl.se's extract), where OTP looks for the
# system's on Linux (public_key:cacerts_get/0): clients such as httpc and
# Mint ask for them before connecting, also when the host carries the TLS.
CACERTS = ("https://curl.se/ca/cacert-2026-10-20.pem",
           "796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe")


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
    if parts[0] == "lib" and len(parts) > 1:
        # The applications' directories are versionless.
        return f"{parts[1]}-".startswith(APPS) or parts[1] in APPS
    if parts[0] == "bin":
        return relative.endswith(".boot")
    if parts[0] == "releases":
        return True
    return False


def mix_env():
    """The environment the template is made in: the host's Elixir with its
    own build directory."""
    return dict(os.environ, MIX_BUILD_ROOT=BUILD)


def host_elixir():
    """The host's Elixir installation (its bin/elixir's parent)."""
    elixir = shutil.which("elixir")
    return os.path.dirname(os.path.dirname(os.path.realpath(elixir)))


def host_mix():
    """Where the host's Mix keeps its archives and its rebar3 (as it says:
    MIX_HOME, MIX_ARCHIVES, ~/.mix), with Hex, phx_new (PHX_NEW) and rebar3
    there: what is missing is installed (a fresh machine, such as the
    deploy's runner, has none of them)."""
    env = mix_env()
    where = subprocess.run(["elixir", "-e", "IO.puts(Mix.path_for(:archives)); "
                            "IO.puts(Mix.Rebar.local_rebar_path(:rebar3))"],
                           check=True, capture_output=True, text=True, env=env).stdout.split("\n")
    archives, rebar3 = where[0], where[1]
    listed = lambda: os.listdir(archives) if os.path.isdir(archives) else []
    run = lambda *args: subprocess.run(["mix", *args, "--force"], check=True, env=env)
    if not any(name.startswith("hex-") for name in listed()):
        run("local.hex")
    if not any(name.startswith(f"phx_new-{PHX_NEW}") for name in listed()):
        run("archive.install", "hex", "phx_new", PHX_NEW)
    if not os.path.isfile(rebar3):
        run("local.rebar")
    return archives, rebar3


def otp_install():
    """The Emscripten BEAM (beam/build.sh, release) and its
    installation in INSTALL: lib/APP/{ebin,priv,
    include}, bin/*.boot and releases/. OTP's alone: Elixir's
    applications and Mix's archives are the host's (elixir_files)."""
    subprocess.run([os.path.join(ROOT, "beam", "build.sh"), "release"], check=True,
                   env=dict(os.environ, OPT="-O2", DIST=BEAM_DIST))
    shutil.rmtree(INSTALL, ignore_errors=True)
    shutil.copytree(os.path.join(BEAM_DIST, "otp", "lib"), os.path.join(INSTALL, "lib"))
    os.makedirs(os.path.join(INSTALL, "bin"))
    tree = os.path.join(ROOT, "out", "beam-wasm", "releaseO2", "otp")
    for boot in ("start", "start_clean", "no_dot_erlang"):
        shutil.copy(os.path.join(tree, "bootstrap", "bin", f"{boot}.boot"), os.path.join(INSTALL, "bin"))
    with open(os.path.join(tree, "OTP_VERSION")) as f:
        version = f.read().strip()
    os.makedirs(os.path.join(INSTALL, "releases", version.split(".")[0]))
    with open(os.path.join(INSTALL, "releases", version.split(".")[0], "OTP_VERSION"), "w") as f:
        f.write(version + "\n")


def walk(top, relative_to=None):
    """Every file below `top`, sorted: (path relative to `relative_to`,
    by default `top`; path here)."""
    out = []
    for directory, dirs, names in os.walk(top):
        dirs.sort()
        for name in sorted(names):
            here = os.path.join(directory, name)
            if os.path.isfile(here):
                out.append((os.path.relpath(here, relative_to or top), here))
    return out


def otp_files():
    """The otp-X package's fs layer, below its root: the installation
    (otp_install), the applications a playground needs (APPS)."""
    return [(relative, here) for relative, here in walk(INSTALL) if installed(relative)]


def elixir_files():
    """The elixir-X package's fs layer, below its root: the host's Elixir
    applications (ELIXIR_APPS: ebin, priv, include) at lib/, Mix's archives
    (Hex, phx_new) and rebar3 as the host's Mix installs them (the same OTP
    runs them) at mix/, and Mix's script, bin/mix (the mix command, which
    the launcher runs with Elixir)."""
    elixir = host_elixir()
    out = []
    for app in ELIXIR_APPS:
        for part in ("ebin", "priv", "include"):
            here = os.path.join(elixir, "lib", app, part)
            if os.path.isdir(here):
                out += [(f"lib/{app}/{part}/{relative}", path) for relative, path in walk(here)]
    archives, rebar3 = host_mix()
    for name in sorted(os.listdir(archives)):
        if name.startswith(("hex-", f"phx_new-{PHX_NEW}")):
            out += [(f"mix/archives/{name}/{relative}", path)
                    for relative, path in walk(os.path.join(archives, name))]
    out.append(("mix/rebar3", rebar3))
    os.makedirs(CACHE, exist_ok=True)
    mix = os.path.join(CACHE, "mix")
    with open(mix, "w") as f:
        f.write("Mix.CLI.main()\n")
    out.append(("bin/mix", mix))
    return out


# The playground's settings for a phx.new app's config/dev.exs: one
# connection to PGlite (one session). configure also sets the watchers
# (WATCHERS). runtime.exs keeps phx.new's live reload: file_system runs the
# page's inotifywait (programs/inotifywait.ts).
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
# A cache from before, whose runtime.exs had live reload taken out: phx.new's
# block back in its place.
NO_LIVE_RELOAD = """# Playground: no live reload; the page reloads the preview.
"""
LIVE_RELOAD = """if config_env() == :dev do
  # Reload browser tabs when matching files change.
  config :playground, PlaygroundWeb.Endpoint,
    live_reload: [
      web_console_logger: true,
      patterns: [
        # Static assets, except user uploads
        ~r"priv/static/(?!uploads/).*\\.(js|css|png|jpeg|jpg|gif|svg)$"E,
        # Gettext translations
        ~r"priv/gettext/.*\\.po$"E,
        # Router, Controllers, LiveViews and LiveComponents
        ~r"lib/playground_web/router\\.ex$"E,
        ~r"lib/playground_web/(controllers|live|components)/.*\\.(ex|heex)$"E
      ]
    ]
end
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
        return text.replace(NO_LIVE_RELOAD, LIVE_RELOAD)
    changed = edit("dev.exs", dev)
    return edit("runtime.exs", runtime) or changed


def compiler_stamp():
    """The host's OTP and Elixir, which compile the template."""
    versions = subprocess.run(["elixir", "--version"], capture_output=True, check=True).stdout
    return hashlib.sha256(versions).hexdigest()


def phoenix_app():
    """The phx.new app, generated once into the cache; its deps locked
    afresh every build (the newest its mix.exs allows, as a new phx.new
    app gets); built again, from nothing when another OTP or Elixir
    compiled it."""
    app = os.path.join(CACHE, "playground")
    env = mix_env()
    stamp = os.path.join(CACHE, "playground.compiler")
    if os.path.exists(os.path.join(app, "priv", "static", "assets", "css", "app.css")):
        os.remove(os.path.join(app, "mix.lock"))
        subprocess.run(["mix", "deps.get"], cwd=app, env=env, check=True)
        subprocess.run(["mix", "deps.clean", "--unused"], cwd=app, env=env, check=True)
        built = open(stamp).read() if os.path.exists(stamp) else None
        if built != compiler_stamp():
            shutil.rmtree(os.path.join(app, BUILD, "dev"), ignore_errors=True)
        configure(app)
        # Without a lock, deps.get fetches the git deps again, which marks
        # their builds outdated even when the lock comes out the same;
        # left so, the node would build them in the recording run.
        subprocess.run(["mix", "compile"], cwd=app, env=env, check=True)
        with open(stamp, "w") as f:
            f.write(compiler_stamp())
        return app
    os.makedirs(CACHE, exist_ok=True)
    shutil.rmtree(app, ignore_errors=True)
    subprocess.run(["mix", "phx.new", "playground", "--no-install"], cwd=CACHE, env=env, check=True,
                   input=b"n\n")
    subprocess.run(["mix", "deps.get"], cwd=app, env=env, check=True)
    # tailwind.install downloads 100 MB through httpc; curl does it.
    with open(os.path.join(app, "config", "config.exs")) as f:
        config = f.read()
    esbuild = config.split("config :esbuild,")[1].split('version: "')[1].split('"')[0]
    tailwind = config.split("config :tailwind,")[1].split('version: "')[1].split('"')[0]
    build = os.path.join(app, BUILD)
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
    """(path below the template's root, path here) for the app: _build is
    BUILD (_build_otp); deps keep only the .git files Mix asks git about."""
    out = []
    # The build links each dependency's priv (and some src) to deps/; WASI has
    # no links, so their files are copied in place.
    for directory, dirs, names in os.walk(app, followlinks=True):
        dirs[:] = sorted(d for d in dirs if d != "node_modules"
                         and (not os.path.islink(os.path.join(directory, d)) or BUILD in directory))
        relative_dir = os.path.relpath(directory, app)
        parts = relative_dir.split(os.sep)
        if parts[0] in ("_build", "_build_rotp", "_build_otp", ".elixir_ls") and parts[0] != BUILD or (len(parts) > 2 and parts[0] == "deps" and parts[2] == ".git"):
            dirs[:] = []
            if len(parts) == 3 and parts[0] == "deps" and parts[2] == ".git":
                # A repository to git, without its objects: its config, HEAD
                # and refs, and an empty objects/info/packs (git takes a
                # directory with objects/ and refs/ for one; Mix's
                # lock_status reads only the origin and HEAD).
                for name in ("config", "HEAD", "packed-refs"):
                    if os.path.exists(os.path.join(directory, name)):
                        out.append((f"{relative_dir}/{name}", os.path.join(directory, name)))
                for refs, _, ref_names in os.walk(os.path.join(directory, "refs")):
                    for name in sorted(ref_names):
                        ref = os.path.relpath(os.path.join(refs, name), directory)
                        out.append((f"{relative_dir}/{ref}", os.path.join(refs, name)))
                empty = os.path.join(CACHE, "empty")
                open(empty, "w").close()
                out.append((f"{relative_dir}/objects/info/packs", empty))
                # A fresh shallow clone has no loose refs, and the node's
                # files make no empty directories: refs/ by a file git
                # skips (a ref's name has no leading dot).
                out.append((f"{relative_dir}/refs/.keep", empty))
            continue
        if parts[0] == BUILD and len(parts) == 1:
            dirs[:] = [d for d in dirs if d == "dev"]
        for name in sorted(names):
            path = os.path.join(directory, name)
            if not os.path.isfile(path):
                continue
            relative = os.path.relpath(path, app)
            if relative.startswith(BUILD + "/") and relative.count("/") == 1:
                # The native esbuild and tailwind: the node runs the page's
                # (their :path, worker/index.ts).
                continue
            out.append((relative.replace(BUILD + "/", "_build/", 1), path))
    return out


def fs_layers(app):
    """Each package's files in the nodes' tree, by key (PACKAGES'), as its
    own build or installation has them: [(path below the package's root,
    path here)]. `app`: the template (phoenix_app)."""
    return {
        "otp-{otp}": otp_files(),
        "elixir-{elixir}": elixir_files(),
        "phoenix-template": app_files(app),
        # git's commands that are shell scripts (tools/git/build.py), at
        # git.wasm's exec path.
        "git": walk(os.path.join(ROOT, "target", "git", "libexec")),
        # The nodes' CA bundle, where OTP looks for the system's.
        "tls": [("certs/ca-certificates.crt", cacerts())],
        # The terminal's terminfo entry (setup.ts sets TERM): IEx's line
        # editing needs it.
        "shell": [("x/xterm-256color", os.path.join(ROOT, "runtime", "terminfo", "x", "xterm-256color"))],
    }


def vite_build(source):
    """A site's Vite app into its dist/, with Node in Docker. Its
    node_modules is installed afresh when package-lock.json changed since
    the last install (a stamp in node_modules has its digest)."""
    with open(os.path.join(source, "package-lock.json"), "rb") as lock:
        digest = hashlib.sha256(lock.read()).hexdigest()
    stamp = os.path.join(source, "node_modules", ".playground-lock")
    try:
        with open(stamp) as f:
            installed = f.read().strip() == digest
    except OSError:
        installed = False
    script = "npm run build"
    if not installed:
        script = f"npm ci --no-audit --no-fund && echo {digest} > node_modules/.playground-lock && {script}"
    subprocess.run(DOCKER + ["run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp",
                             "-v", f"{os.path.dirname(source)}:/p", "-w", f"/p/{os.path.basename(source)}",
                             NODE_IMAGE, "sh", "-c", script], check=True)


def record(out, site, boot, snapshot, versions):
    """The files a boot image's command fetches (their paths in the node),
    run under Node over the site manifest `site` (its path in `out`); what
    it writes below /work goes to `snapshot` (Mix's builds name their
    absolute paths, so the app is compiled once more there, at the
    template's root)."""
    args, cwd, env, stdin = record_args(boot, versions)
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
        command += ["-v", f"{NODE}:/w:ro", "-v", f"{out}:/d:ro", "-v", f"{scratch}:/r",
                    NODE_IMAGE, "node", "/w/node.mjs", f"/d{site}", *args]
        try:
            result = subprocess.run(command, input=stdin.encode(), capture_output=True, timeout=600)
        except subprocess.TimeoutExpired:
            subprocess.run(DOCKER + ["kill", name], capture_output=True)
            raise
        sys.stderr.write(result.stderr.decode(errors="replace")[-2000:])
        with open(listing) as f:
            fetched = {line for line in f.read().split("\n") if line}
        if not fetched:
            sys.exit(f"recording {boot}: the node fetched nothing (exit {result.returncode})")
        # A node that failed (the Phoenix server not starting) recorded
        # what a failing boot reads, and the site would ship it.
        if result.returncode != 0:
            sys.exit(f"recording {boot}: the node exited {result.returncode}")
        return fetched


# The terminal's shell, brush, uutils coreutils (ls, cp, rm, … for the
# shell and the nodes), ripgrep (rg), git (docs/git.md), GNU's text tools
# (docs/tools.md: sed, grep, diff, cmp, diff3, sdiff, gawk, find), the Tailscale node (docs/tailscale.md) and a
# Node.js process's TLS client (docs/nodejs.md), built to WebAssembly by
# their own scripts.
WASM = {"brush": "brush/build.py", "tailscale": "tailscale/build.py", "tls": "tls/build.py",
        "coreutils": "tools/coreutils/build.py", "rg": "tools/ripgrep/build.py", "git": "tools/git/build.py",
        "sed": "tools/sed/build.py", "grep": "tools/grep/build.py", "gawk": "tools/gawk/build.py",
        "findutils/find": "tools/findutils/build.py",
        **{f"diffutils/{name}": "tools/diffutils/build.py" for name in ("diff", "cmp", "diff3", "sdiff")}}


def prebuilt():
    """WASM's builds, {name: target/NAME/NAME.wasm}, or for a key DIR/NAME
    (one build's several programs) {NAME: target/DIR/NAME.wasm}; the build
    stops before it touches the site if any is missing."""
    built = {key.split("/")[-1]: os.path.join(ROOT, "target", *key.split("/")[:1], f"{key.split('/')[-1]}.wasm")
             for key in WASM}
    scripts = {key.split("/")[-1]: script for key, script in WASM.items()}
    missing = [f"{path}: missing (python3 -I {scripts[name]} first)"
               for name, path in built.items() if not os.path.exists(path)]
    if missing:
        raise SystemExit("\n".join(missing))
    return built


def page(out):
    """The app's Vite builds: the apex's pages and assets, embed.js and the
    service worker into `out` (the site's root); the runtime package's
    scripts and frames, whose directory it answers; and the Node harness
    into NODE."""
    source = os.path.join(ROOT, "app")
    vite_build(source)
    # What an earlier build left at the root: its assets and scripts.
    shutil.rmtree(os.path.join(out, "_playground"), ignore_errors=True)
    for name in os.listdir(out) if os.path.isdir(out) else ():
        if name.endswith((".js", ".html")):
            os.remove(os.path.join(out, name))
    shutil.copytree(os.path.join(source, "dist"), out, dirs_exist_ok=True)
    runtime = os.path.join(source, "dist-runtime")
    # One service worker for the site's every version, at the root for its
    # scope (docs/packages.md: its protocol).
    shutil.move(os.path.join(runtime, "sw.js"), os.path.join(out, "sw.js"))
    shutil.rmtree(NODE, ignore_errors=True)
    shutil.copytree(os.path.join(source, "dist-node"), NODE)
    # The apex (PLAYGROUND_DOMAIN, such as run-elixir.dev: every page;
    # app/src/shared/lib/site.ts).
    domain = os.environ.get("PLAYGROUND_DOMAIN") or None
    # And the domain whose subdomains run what a project's code does
    # (PLAYGROUND_USERCONTENT, another site; docs/frames.md).
    usercontent = os.environ.get("PLAYGROUND_USERCONTENT") or None
    # The origins that may frame embed.html and drive it (docs/embed.md),
    # space-separated.
    embedders = (os.environ.get("PLAYGROUND_EMBEDDERS") or EMBEDDERS).split()
    with open(os.path.join(out, "playground.json"), "w") as f:
        json.dump({"domain": domain, "usercontent": usercontent, "embedders": embedders}, f)
    # Link previews want an absolute og:image; a site without a domain
    # keeps the path (most fetchers resolve it against the page).
    if domain:
        index = os.path.join(out, "index.html")
        with open(index) as f:
            text = f.read()
        image = '<meta property="og:image" content="/og.png"'
        assert image in text, index
        with open(index, "w") as f:
            f.write(text.replace(image, f'<meta property="og:image" content="https://{domain}/og.png"'))
    return runtime


# The origins that may embed the site by default (docs/embed.md).
EMBEDDERS = "https://tidewave.ai https://tidewave.steffend.me http://localhost:4000"


def runtime_versions():
    """The installation's OTP version and the host's Elixir's: {otp, elixir}."""
    releases = os.path.join(INSTALL, "releases")
    with open(os.path.join(releases, os.listdir(releases)[0], "OTP_VERSION")) as f:
        otp = f.read().strip()
    with open(os.path.join(host_elixir(), "lib", "elixir", "ebin", "elixir.app")) as f:
        elixir = re.search(r'\{vsn,\s*"([^"]+)"\}', f.read()).group(1)
    return {"otp": otp, "elixir": elixir}


# The npm packages (docs/packages.md). The upstream version is in a name
# ({otp}, {elixir}); a package's own version is our build of it: its major
# an ABI break, its minor a new capability, its patch a rebuild or a fix.
SCOPE = "@elixir-playground"
# The runtime's own version and the ABI seams it speaks, which its
# JavaScript checks a site against (app/src/runtime/packages/check.ts).
HOST = os.path.join(ROOT, "app", "src", "runtime", "packages", "host.json")
# The tools in coreutils.wasm (uutils 0.12.0's feat_wasm: `coreutils --list`).
COREUTILS_TOOLS = (
    "arch b2sum base32 base64 basename basenc cat cksum comm cp csplit cut date dd dir "
    "dircolors dirname echo expand expr factor false fmt fold head hostid join link ln ls "
    "md5sum mkdir mktemp mv nice nl nproc numfmt od paste pathchk pr printenv printf ptx pwd "
    "readlink realpath rm rmdir seq sha1sum sha224sum sha256sum sha384sum sha512sum shred shuf "
    "sleep sort split sum tail tee test touch tr true truncate tsort tty uname unexpand uniq "
    "unlink vdir wc yes").split()
GNU_TOOLS = {"sed": "sed.wasm", "grep": "grep.wasm", "diff": "diff.wasm", "cmp": "cmp.wasm",
             "diff3": "diff3.wasm", "sdiff": "sdiff.wasm", "awk": "gawk.wasm", "gawk": "gawk.wasm",
             "find": "find.wasm"}
# A program of its own module, and one of a multi-call module (its first
# argument names the tool: coreutils.wasm), which the exec frame compiles
# once for every node (manifest.ts Program).
own = lambda module: {"module": module}
multicall = lambda module: {"module": module, "multicall": True}
# Each package: its version, its files (by name: sources()), the packages
# it needs besides the runtime (by key) and its `playground` field. Some
# also have files in the nodes' tree, an fs layer each (fs_layers), whose
# `root` says where: OTP's and Elixir's with the version in the path, so
# that two may be installed side by side one day; the tools' at the fixed
# paths their programs expect. `bin` names a package's commands (files of
# its layer, linked from /usr/bin), `env` the variables that name its paths
# (relative to the root; "." the root).
PACKAGES = {
    "otp-{otp}": {
        "version": "1.0.0",
        "root": "/opt/otp/{otp}",
        "files": ["beam.mjs", "beam.emu.mjs", "beam.wasm"],
        # beam.wasm's imports are its Emscripten glue's (beam.mjs); the
        # runtime meets that glue at the beam seam (beam/run.ts).
        "own": ("env", "wasi_snapshot_preview1"),
        # The loader's glue loads its threads' script (beam.emu.mjs) from
        # beside itself.
        "playground": {"abi": {"beam": 1}, "beam": {"loader": "beam.mjs", "wasm": "beam.wasm"},
                       "env": {"ROOTDIR": "."}},
    },
    "elixir-{elixir}": {
        "version": "1.0.0",
        "root": "/opt/elixir/{elixir}",
        "files": [],
        # Mix's script, and the archives and rebar3 Mix finds by them.
        "playground": {"bin": {"mix": "bin/mix"},
                       "env": {"MIX_ARCHIVES": "mix/archives", "MIX_REBAR3": "mix/rebar3"}},
    },
    "phoenix-template": {"version": "1.0.0", "root": "/work/playground", "files": [],
                         "peers": ["otp-{otp}", "elixir-{elixir}"], "playground": {}},
    "shell": {
        "version": "1.0.0",
        # The terminfo entry.
        "root": "/usr/share/terminfo",
        "files": ["brush.wasm", "coreutils.wasm"],
        "playground": {"abi": {"wasi": 1, "processes": 1, "crossterm": 1},
                       "shell": "brush.wasm",
                       "programs": {name: multicall("coreutils.wasm") for name in COREUTILS_TOOLS}},
    },
    # git.wasm's exec path (its prefix is /usr): its scripts.
    "git": {"version": "1.0.0", "root": "/usr/libexec/git-core", "files": ["git.wasm"],
            "playground": {"abi": {"wasi": 1, "processes": 1}, "programs": {"git": own("git.wasm")}}},
    "ripgrep": {"version": "1.0.0", "files": ["rg.wasm"],
                "playground": {"abi": {"wasi": 1}, "programs": {"rg": own("rg.wasm")}}},
    "gnu-tools": {"version": "1.0.0", "files": sorted(set(GNU_TOOLS.values())),
                  "playground": {"abi": {"wasi": 1, "processes": 1},
                                 "programs": {name: own(module) for name, module in GNU_TOOLS.items()}}},
    # The CA bundle, where OTP looks for the system's (certs/).
    "tls": {"version": "1.0.0", "root": "/etc/ssl", "files": ["tls.wasm", "roots.pem"],
            "playground": {"abi": {"wasi": 1, "tls": 1}, "tls": {"module": "tls.wasm", "roots": "roots.pem"}}},
    # With Go's glue for it: the Go that built it has its own.
    "tailscale": {"version": "1.0.0", "files": ["tailscale.wasm", "wasm_exec.js"],
                  "playground": {"abi": {"tailscale": 1},
                                 "tailscale": {"module": "tailscale.wasm", "glue": "wasm_exec.js"}}},
    "claude": {"version": "1.0.0", "files": [], "playground": {}},
}
# A module's imports, by the seam (host.json's provides) they belong to.
IMPORT_SEAMS = {"wasi_snapshot_preview1": "wasi", "processes": "processes", "crossterm": "crossterm",
                "gojs": "tailscale"}


def wasm_interface(path):
    """A WebAssembly module's imports ([(module, name)]) and exports ([name])."""
    with open(path, "rb") as f:
        data = f.read()

    def leb(at):
        value = shift = 0
        while True:
            byte = data[at]
            at += 1
            value |= (byte & 0x7f) << shift
            shift += 7
            if byte < 0x80:
                return value, at

    def name(at):
        length, at = leb(at)
        return data[at:at + length].decode(), at + length

    def limits(at):
        flags = data[at]
        _, at = leb(at + 1)
        return leb(at)[1] if flags & 1 else at

    imports, exports, at = [], [], 8
    while at < len(data):
        section = data[at]
        size, at = leb(at + 1)
        end = at + size
        if section in (2, 7):
            count, at = leb(at)
            for _ in range(count):
                if section == 2:
                    module, at = name(at)
                    field, at = name(at)
                    kind = data[at]
                    at += 1
                    if kind == 0:
                        at = leb(at)[1]
                    elif kind == 1:
                        at = limits(at + 1)
                    elif kind == 2:
                        at = limits(at)
                    elif kind == 3:
                        at += 2
                    elif kind == 4:
                        at = leb(at + 1)[1]
                    imports.append((module, field))
                else:
                    field, at = name(at)
                    exports.append(field)
                    at = leb(at + 1)[1]
        at = end
    return imports, exports


def beam_abi(wasm):
    """The BEAM build's id: OTP's tag and the patch stack (beam/build.sh's
    stamp), emsdk's version and beam.wasm's imports and exports. What the
    recordings are made for (docs/packages.md); NIF libraries have their
    own ABI (nif_abi)."""
    stamp = os.path.join(ROOT, "out", "beam-wasm", "releaseO2", "otp", ".stamp-patched")
    try:
        emsdk = subprocess.run(["emcc", "--version"], capture_output=True, text=True).stdout.split("\n")[0]
    except OSError:
        emsdk = ""
    imports, exports = wasm_interface(wasm)
    hashed = hashlib.sha256(json.dumps({
        "patches": open(stamp).read().strip() if os.path.exists(stamp) else "",
        "emsdk": emsdk, "imports": sorted(imports), "exports": sorted(exports)}).encode())
    return hashed.hexdigest()[:16]


def nif_abi():
    """The NIF ABI (docs/nif.md) the BEAM build loads libraries of,
    "LAYER-MAJOR.MINOR" (1-2.18): the newest erl_nif layer the runtime
    speaks (host.json's provides.nif: nif.ts and the BEAM's patch 0021)
    and the BEAM build's erl_nif.h. The backend builds for it from its own
    copy of the layer (backend/nif/), and refuses another."""
    erl_nif_h = os.path.join(ROOT, "out", "beam-wasm", "releaseO2", "otp", "erts", "emulator", "beam", "erl_nif.h")
    with open(erl_nif_h) as f:
        text = f.read()
    version = ".".join(re.search(rf"^#define ERL_NIF_{part}_VERSION (\d+)$", text, re.M).group(1)
                       for part in ("MAJOR", "MINOR"))
    with open(HOST) as f:
        layer = max(json.load(f)["provides"]["nif"])
    return f"{layer}-{version}"


def file_entry(path):
    with open(path, "rb") as f:
        return {"size": os.path.getsize(path), "sha256": hashlib.sha256(f.read()).hexdigest()}


def claude_code():
    """The Claude Code version the playground pins (CLAUDE_CODE in the app)."""
    path = os.path.join(ROOT, "app", "src", "project", "lib", "programs", "claude", "build.ts")
    with open(path) as f:
        return re.search(r"CLAUDE_CODE = \{\s*version: '([^']+)'", f.read()).group(1)


# The site's layout (docs/build.md): each package in a directory of its
# own, NAME@VERSION+ID (ID a digest of what is in it: the repository's
# versions are not published, so the same version may be another build),
# the boot recordings in boot/ID/ and the site manifest at site/ID.json.
# Each of them is immutable. NIF libraries are the backend's (/api/v1/nif/).
NPM = os.path.join("npm", SCOPE)


def tree_digest(top, skip=lambda path: False):
    """A digest of the files below `top`: their paths and bytes."""
    hashed = hashlib.sha256()
    for directory, dirs, names in sorted(os.walk(top)):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, top)
            if skip(relative):
                continue
            with open(path, "rb") as f:
                hashed.update(relative.encode() + b"\0" + hashlib.sha256(f.read()).digest())
    return hashed.hexdigest()[:12]


def layer_version(files):
    """A digest of a layer's files ((path in the node, path here)), their
    paths and bytes. Not Mix's own records of the template's compile
    (_build/ENV/lib/APP/.mix/): they are of the recording run, not of what
    a project is made over."""
    hashed = hashlib.sha256()
    for path, here in sorted(files):
        if re.search(r"/_build/[^/]+/lib/[^/]+/\.mix/", path):
            continue
        with open(here, "rb") as f:
            hashed.update(path.encode() + b"\0" + hashlib.sha256(f.read()).digest())
    return hashed.hexdigest()[:16]


def write_layer(fs, files, root):
    """A package's files below its `root` in the nodes' tree (fs format 3)
    into `fs`:
    bundles/N.tar (uncompressed: the server compresses, and the node reads
    them synchronously), a directory's files in tars of up to BUNDLE bytes,
    and manifest.json listing each (its path below the root) with its
    size, mtime and bundle. Its `playground` field (manifest.ts FsLayer)."""
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
                tar.add(here, arcname=path, recursive=False, filter=header)
                manifest.append([path, os.path.getsize(here), MTIME, number])
    with open(os.path.join(fs, "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    return {"format": 3, "root": root, "manifest": "fs/manifest.json", "bundles": "fs/bundles/",
            "count": len(groups), "version": layer_version(files)}


def lay(out, name, version, files, playground, peers, layer=None, own=(), licensed=None, root=None):
    """A package's directory, npm/@elixir-playground/NAME@VERSION+ID/: its
    `files` ({name: path here}, a directory too), its fs layer (`layer`: the
    files below `root` in the nodes' tree, [(path there, path here)], or a
    directory that holds one already, with its `playground` field), its licenses
    (`licensed`: (inventory, sources), notices.write) and its package.json.
    Each module's imports must belong to a seam `playground` names (`own`:
    what its own glue answers). Its site manifest entry."""
    for file, here in files.items():
        if file.endswith(".wasm"):
            imports, _ = wasm_interface(here)
            for module in sorted({module for module, _ in imports} - set(own)):
                if IMPORT_SEAMS.get(module) not in playground.get("abi", {}):
                    sys.exit(f"{name}: {file} imports {module}, which its abi does not name")
    scratch = os.path.join(out, NPM, f".{name}.partial")
    shutil.rmtree(scratch, ignore_errors=True)
    os.makedirs(scratch)
    for file, here in files.items():
        if os.path.isdir(here):
            shutil.copytree(here, os.path.join(scratch, file), copy_function=link_or_copy)
        else:
            link_or_copy(here, os.path.join(scratch, file))
    playground = dict(playground)
    if isinstance(layer, list):
        playground["fs"] = write_layer(os.path.join(scratch, "fs"), layer, root)
    elif layer:
        path, playground["fs"] = layer
        shutil.copytree(path, os.path.join(scratch, "fs"), copy_function=link_or_copy)
    inventory, sources = licensed
    added, expression = notices.write(scratch, f"{SCOPE}/{name}", inventory, sources)
    package = {"name": f"{SCOPE}/{name}", "version": version, "license": expression,
               "files": sorted([*files, *(["fs"] if layer else []), *added]),
               **({"peerDependencies": peers} if peers else {}), "playground": playground,
               # Not for publishing yet (docs/packages.md).
               "private": True}
    with open(os.path.join(scratch, "package.json"), "w") as f:
        json.dump(package, f, indent=2)
        f.write("\n")
    directory = os.path.join(NPM, f"{name}@{version}+{tree_digest(scratch)}")
    if os.path.isdir(os.path.join(out, directory)):
        shutil.rmtree(scratch)
    else:
        os.rename(scratch, os.path.join(out, directory))
    entry = {"version": version, "base": f"../{directory}/",
             "files": {file: file_entry(os.path.join(out, directory, file))
                       for file in files if not os.path.isdir(os.path.join(out, directory, file))},
             "playground": playground}
    if peers:
        entry["peerDependencies"] = peers
    return directory, entry


def write_site(out, packages, boot, name=None):
    """The site manifest, site/ID.json (`name`: another name, such as the
    recording runs'), its bases relative to it; its path from the root."""
    site = {
        "manifest": 2,
        "packages": dict(sorted(packages.items())),
        "boot": boot,
    }
    data = json.dumps(site, indent=1).encode() + b"\n"
    os.makedirs(os.path.join(out, "site"), exist_ok=True)
    path = f"site/{name or hashlib.sha256(data).hexdigest()[:12]}.json"
    with open(os.path.join(out, path), "wb") as f:
        f.write(data)
    return "/" + path


def lay_packages(out, versions, facts, sources, layers, licensed):
    """Every package of PACKAGES: `sources` names each file's path here,
    `layers` each package's fs layer (lay's `layer`), `licensed` its
    licenses (lay's), by key; `facts` what a full build found (beamAbi, the
    template's id). Their site manifest entries, by name."""
    with open(HOST) as f:
        host = json.load(f)
    otp, elixir = versions["otp"], versions["elixir"]
    named = lambda key: key.format(otp=otp, elixir=elixir)
    filled = {
        "otp-{otp}": {"otp": otp, "beamAbi": facts["beamAbi"], "nifAbi": facts["nifAbi"]},
        "elixir-{elixir}": {"elixir": elixir, "requires": {"otp": "^%s.0.0" % otp.split(".")[0]}},
        "phoenix-template": {"template": {"kind": "phoenix", "id": facts["template"],
                                          "label": f"phx.new {PHX_NEW}", "otp": otp, "elixir": elixir}},
        # The newest version tested is the upper bound (docs/packages.md).
        "claude": {"claudeCode": f">={claude_code()} <={claude_code()}"},
    }
    entries = {}
    for key, package in PACKAGES.items():
        peers = {host["name"]: "^%s.0.0" % host["version"].split(".")[0]}
        for peer in package.get("peers", ()):
            peers[f"{SCOPE}/{named(peer)}"] = "^%s" % PACKAGES[peer]["version"].split(".")[0]
        _, entries[f"{SCOPE}/{named(key)}"] = lay(
            out, named(key), package["version"], {file: sources[file] for file in package["files"]},
            {**package["playground"], **filled.get(key, {})}, peers, layers.get(key), package.get("own", ()),
            licensed[key], package.get("root", "").format(**versions) or None)
    return entries


def lay_runtime(out, runtime):
    """The runtime package (the Vite build's dist-runtime: its scripts and
    frames) and the api package (embed.js, which also stays at the root
    for its stable URL); the runtime's path."""
    with open(HOST) as f:
        host = json.load(f)
    name = host["name"].split("/")[1]
    files = {file: os.path.join(runtime, file) for file in sorted(os.listdir(runtime))}
    # The runtime's scripts and frames, and embed.js: the playground's own,
    # with what their Vite builds bundled (app/vite-licenses.ts).
    runtime_licensed = notices.own().extend(notices.npm("runtime")).extend(notices.npm("frames"))
    directory, _ = lay(out, name, host["version"], files, {"provides": host["provides"]}, {},
                       licensed=(runtime_licensed, {}))
    api, _ = lay(out, "api", "1.0.0", {"embed.js": os.path.join(out, "embed.js")}, {"apiVersions": [2]},
                 {host["name"]: "^%s.0.0" % host["version"].split(".")[0]},
                 licensed=(notices.own().extend(notices.npm("embed")), {}))
    return f"/{directory}/", api


def tool_notices():
    """The licenses of the packages of tools (lay's `licensed`, by key):
    each tool build's inventory (target/NAME/licenses) and source."""
    return {
        "shell": notices.shell(),
        "git": notices.tool("git"),
        "ripgrep": notices.tool("rg", "ripgrep"),
        "gnu-tools": notices.gnu_tools(["sed", "grep", "diffutils", "gawk", "findutils"]),
        "tls": notices.tls(cacerts()),
        "tailscale": (notices.tool("tailscale")[0].extend(notices.own()), {}),
        # Only its package.json: Claude Code comes from npm (docs/packages.md).
        "claude": (notices.own(), {}),
    }


def licenses_page(out):
    """/licenses/: the site's pages and every package it has (prune has
    left those its manifest and pages name)."""
    top = os.path.join(out, NPM)
    packages = [os.path.join(NPM, name) for name in sorted(os.listdir(top)) if not name.startswith(".")]
    notices.page(out, packages, notices.own().extend(notices.npm("apex")))


def name_pages(out, runtime, site):
    """Each page at the root names the runtime package and the site
    manifest it runs with (app/src/shared/lib/build.ts)."""
    for name in os.listdir(out):
        if name.endswith(".html"):
            path = os.path.join(out, name)
            with open(path) as f:
                text = f.read()
            assert "<head>" in text, path
            with open(path, "w") as f:
                f.write(text.replace("<head>", f'<head>\n    <meta name="playground-runtime" content="{runtime}" />'
                                     f'\n    <meta name="playground-site" content="{site}" />', 1))


def prune(out, laid, site):
    """What the site manifest and the runtime do not name goes: the
    packages, recordings and manifests of the builds before (a deploy keeps
    those its live releases name: deploy/server/playground-deploy)."""
    with open(os.path.join(out, site.lstrip("/"))) as f:
        manifest = json.load(f)
    named = {os.path.normpath(os.path.join("site", entry["base"])) for entry in manifest["packages"].values()}
    named.update(path.strip("/") for path in laid)
    named.add(os.path.normpath(os.path.join("site", manifest["boot"]["base"])))
    for top in (NPM, "boot"):
        for name in os.listdir(os.path.join(out, top)) if os.path.isdir(os.path.join(out, top)) else ():
            if os.path.join(top, name) not in named:
                shutil.rmtree(os.path.join(out, top, name))
    for name in os.listdir(os.path.join(out, "site")):
        if f"/site/{name}" != site:
            os.remove(os.path.join(out, "site", name))
    # NIF libraries an older build bundled.
    shutil.rmtree(os.path.join(out, "nif"), ignore_errors=True)


def sources(wasm):
    """Where each package's files are here, by name (PACKAGES' files)."""
    return {**{f"{name}.wasm": path for name, path in wasm.items()},
            # Mozilla's roots (the nodes' /etc/ssl/certs), for a Node.js
            # process's tls.rootCertificates (app/src/runtime/nodejs/tls.ts).
            "roots.pem": cacerts(),
            # tailscale/build.py's, the Go it built with has it.
            "wasm_exec.js": os.path.join(ROOT, "target", "tailscale", "wasm_exec.js"),
            **{name: os.path.join(BEAM_DIST, name) for name in ("beam.mjs", "beam.emu.mjs", "beam.wasm")}}


def page_meta(out, name):
    """What the site's index.html names (<meta name="playground-NAME">)."""
    with open(os.path.join(out, "index.html")) as f:
        found = re.search(rf'<meta name="playground-{name}" content="([^"]+)"', f.read())
    return found.group(1) if found else None


def app(out, wasm):
    """build.py app: the JavaScript and the WebAssembly tools again, over a
    site a full build made, whose fs layers (the installation's, the
    template's) and recordings stay as they are."""
    site = page_meta(out, "site")
    if not site:
        sys.exit(f"{out}: no site to build over (python3 -I runtime/build.py first)")
    with open(os.path.join(out, site.lstrip("/"))) as f:
        before = json.load(f)
    runtime = page(out)
    by = {name: entry for name, entry in before["packages"].items()}
    otp_entry = next(entry for entry in by.values() if "beamAbi" in entry["playground"])
    versions = {"otp": otp_entry["playground"]["otp"],
                "elixir": next(entry["playground"]["elixir"] for entry in by.values()
                               if "elixir" in entry["playground"])}
    template = next(entry for entry in by.values() if "template" in entry["playground"])
    # The emulator's, as a full build found them.
    facts = {"beamAbi": otp_entry["playground"]["beamAbi"], "nifAbi": otp_entry["playground"]["nifAbi"],
             "template": template["playground"]["template"]["id"]}
    here = lambda entry: os.path.normpath(os.path.join(out, "site", entry["base"]))
    found = sources(wasm)
    # The emulator a full build recorded with, not one built since.
    for name in ("beam.mjs", "beam.emu.mjs", "beam.wasm"):
        found[name] = os.path.join(here(otp_entry), name)
    layers = {}
    for key in PACKAGES:
        entry = by.get(f"{SCOPE}/{key.format(**versions)}")
        if entry and "fs" in entry["playground"]:
            if entry["playground"]["fs"].get("format") != 3:
                sys.exit(f"{out}: {key.format(**versions)}'s layer is fs format "
                         f"{entry['playground']['fs'].get('format')}, not 3: python3 -I runtime/build.py")
            layers[key] = (os.path.join(here(entry), "fs"), entry["playground"]["fs"])
    # The full build's packages' licenses, as their fs layers: theirs, or
    # (a site from before licenses/) worked out again.
    licensed = tool_notices()
    for key, compute in full_notices(versions).items():
        directory = os.path.join(here(by[f"{SCOPE}/{key.format(**versions)}"]), "licenses")
        licensed[key] = ((notices.licenses.Inventory.read(directory), {}) if os.path.isdir(directory)
                         else compute())
    entries = lay_packages(out, versions, facts, found, layers, licensed)
    site = write_site(out, entries, before["boot"])
    runtime, api = lay_runtime(out, runtime)
    name_pages(out, runtime, site)
    prune(out, (runtime, api), site)
    licenses_page(out)
    print(f"{out}: runtime {runtime}, site {site}")


def full_notices(versions):
    """The licenses of the packages a full build makes (lay's `licensed`,
    by key, each a function): OTP's, Elixir's and the template's."""
    archives, rebar3 = host_mix()
    hex_version = next(name.split("-", 1)[1] for name in os.listdir(archives) if name.startswith("hex-"))
    licensed = os.path.join(CACHE, "licenses")
    return {
        "otp-{otp}": lambda: (notices.otp(versions["otp"]), {}),
        "elixir-{elixir}": lambda: (notices.elixir({**versions, "hex": hex_version, "phx_new": PHX_NEW},
                                                   rebar3, licensed), {}),
        "phoenix-template": lambda: (notices.template(os.path.join(CACHE, "playground"), PHX_NEW, licensed), {}),
    }


def main():
    out = os.path.join(ROOT, "target", "site")
    wasm = prebuilt()
    if sys.argv[1:] == ["app"]:
        return app(out, wasm)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    # The installation first: the packages name its versions.
    otp_install()
    versions = runtime_versions()
    runtime = page(out)

    # Each package's files in the nodes' tree, from its own build or
    # installation.
    layers = fs_layers(phoenix_app())

    # Every package laid out, its files lazy, to record what each boot
    # image's command fetches; only the Phoenix run's writes (the template,
    # built at its root) are kept, and the template laid again.
    licensed = {**tool_notices(), **{key: compute() for key, compute in full_notices(versions).items()}}
    found = sources(wasm)
    facts = {"beamAbi": beam_abi(found["beam.wasm"]), "nifAbi": nif_abi(), "template": ""}
    entries = lay_packages(out, versions, facts, found, layers, licensed)
    recording = write_site(out, entries, None, name="recording")
    fetched = {}
    for boot in RECORD:
        snapshot = os.path.join(CACHE, f"{boot}-snapshot")
        shutil.rmtree(snapshot, ignore_errors=True)
        fetched[boot] = record(out, recording, boot, snapshot, versions)
    os.remove(os.path.join(out, recording.lstrip("/")))
    # What the Phoenix run wrote below the template's root replaces what
    # was there.
    template_root = root_of("phoenix-template", versions)
    assert template_root.startswith("/work/"), template_root
    snapshot = os.path.join(CACHE, "boot-phoenix-snapshot", os.path.relpath(template_root, "/work"))
    written = dict(walk(snapshot)) if os.path.isdir(snapshot) else {}
    template_files = layers["phoenix-template"]
    layers["phoenix-template"] = [(path, written.get(path, here)) for path, here in template_files] + sorted(
        (path, here) for path, here in written.items() if path not in {p for p, _ in template_files})
    # Which template a project was made from: its files (not its build,
    # which changes with the runtime), and what it is.
    template = hashlib.sha256()
    for path, here in sorted(layers["phoenix-template"]):
        if not path.startswith("_build/"):
            template.update(path.encode() + b"\0")
            with open(here, "rb") as f:
                template.update(f.read())
    facts["template"] = template.hexdigest()[:12]
    entries = lay_packages(out, versions, facts, found, layers, licensed)
    # Every file by its path in the node (below its package's root, as the
    # node's tree and the recordings name it), with its package.
    files = [(f"{root_of(key, versions).lstrip('/')}/{path}", here, key)
             for key, layer in layers.items() for path, here in layer]

    # The boot images: what each run fetched, and what must be there before
    # (.app, .boot and release files, erts's preloaded modules). The
    # template's files go only in the Phoenix image; an empty project has
    # none of them.
    otp_root = root_of("otp-{otp}", versions).lstrip("/")
    needed = lambda path: path.endswith((".app", ".boot")) or path.startswith(
        (f"{otp_root}/releases/", f"{otp_root}/lib/erts/"))
    images = {
        "boot": [(path, here) for path, here, key in files
                 if key != "phoenix-template" and (path in fetched["boot"] or needed(path))],
    }
    taken = {path for path, _ in images["boot"]}
    images["boot-phoenix"] = [(path, here) for path, here, key in files if path not in taken
                              and (path in fetched["boot-phoenix"] or needed(path))]
    scratch = os.path.join(out, "boot", ".partial")
    os.makedirs(scratch)
    for boot, eager in images.items():
        write_image(os.path.join(scratch, f"{boot}.tar.gz"), eager)
    boot = os.path.join("boot", tree_digest(scratch))
    os.rename(scratch, os.path.join(out, boot))
    # Made with exactly these packages.
    made = {f"{SCOPE}/{key.format(**versions)}": PACKAGES[key]["version"] for key in layers}
    site = write_site(out, entries, {"base": f"../{boot}/", "images": list(RECORD), "packages": made})
    runtime, api = lay_runtime(out, runtime)
    name_pages(out, runtime, site)
    prune(out, (runtime, api), site)
    licenses_page(out)

    mb = lambda path: f"{os.path.getsize(path) / 1e6:.1f} MB"
    print(f"{out}: " + "; ".join(
        f"{name} {len(images[name])} files ({len(fetched[name])} recorded), "
        f"{mb(os.path.join(out, boot, name + '.tar.gz'))}" for name in RECORD))
    print(f"{out}: fs layers' files by package: " + ", ".join(
        f"{key.format(**versions)} {len(layer)}" for key, layer in sorted(layers.items())))
    print(f"{out}: runtime {runtime}, site {site}")


# A lazily fetched bundle holds files of one directory, up to this many
# bytes (one file may be bigger): a miss fetches its neighbours too, which
# a module's are likely to be needed next.
BUNDLE = 512 * 1024


def header(info):
    """A tar entry's header as every fs layer and boot image has it
    (write_layer, write_image): MTIME, no owner, and of its mode the
    executable bit alone. The same files then make the same tar."""
    info.mtime = MTIME
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mode = 0o755 if info.mode & 0o111 else 0o644
    return info


def write_image(path, files):
    """A boot image: a gzipped tar of `files` ((path in the node, path here)),
    the same bytes for the same files (gzip's header has no time, the
    tar's entries are header's)."""
    with open(path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as zipped, \
            tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name, here in files:
            tar.add(here, arcname=name, recursive=False, filter=header)


def link_or_copy(source, target):
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)



if __name__ == "__main__":
    main()
