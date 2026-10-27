"""Build the playground site into target/site, ready to rsync:

    python3 -I runtime/build.py
    python3 -I runtime/build.py app   # just the page and the runtime's JavaScript

The site is the app's Vite build (app/, made in Docker), which bundles
the runtime's workers too, OTP's own emulator built with Emscripten
(beam/build.sh: beam.mjs, beam.emu.mjs and beam.wasm), and a filesystem
under fs/: the installation (target/otp, at /rotp in the node: OTP's
applications from that build, the host's Elixir, Hex, phx_new and
rebar3) and the Phoenix template, a phx.new app, at /work/playground.

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
- fs/version: a digest of the above; a project's kept changes note the
  version they were made over.
- playground.json: the apex and the usercontent domain,
  PLAYGROUND_DOMAIN and PLAYGROUND_USERCONTENT in the build's environment
  (app/src/shared/lib/site.ts, docs/frames.md), and the origins that may
  frame embed.html, PLAYGROUND_EMBEDDERS (docs/embed.md);
- site.json: the site manifest (docs/packages.md): each package's version,
  files, peer dependencies and `playground` field, the fs image and the
  bundled NIF libraries. The runtime finds the BEAM, its programs and the
  fs image through it, and checks the packages against itself as a
  project starts. The OTP and Elixir packages' versions are the
  embedders' contract (docs/embed.md). The packages that map onto the
  site's files are also written to target/packages/NAME/ (a package.json
  and its files), as npm would install them.

Built flat, the site is then versioned: what keeps its name across builds
but the pages, the service worker, playground.json and app/public's files
(icons, the web app manifest, the link preview's image) moves. The BEAM
and what it reads (beam*, fs/, nif/) go to r/RID/, RID a digest of them
alone, so a deploy that changes only JavaScript keeps their URLs and
browsers keep them cached; the runtime's JavaScript goes to b/ID/, ID a
digest of it and RID. Each page names both in <meta name="playground-build">
and <meta name="playground-runtime"> (the app's src/shared/lib/build.ts).
A page loaded before a deploy keeps loading its own build's files while
the server still has them.

The template is generated once into target/cache-otp with the host's
Mix (the same OTP and Elixir): phx_new (PHX_NEW below), the playground's
configuration, deps fetched and compiled, assets built.
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTALL = os.path.join(ROOT, "target", "otp")
CACHE = os.path.join(ROOT, "target", "cache-otp")
# The template's build directory, the host Mix's own (the node runs the
# same OTP and Elixir, so the same code).
BUILD = "_build_otp"
# beam/build.sh's output for the site.
BEAM_DIST = os.path.join(ROOT, "out", "beam-wasm", "site")
# The Node harness, bundled by the Vite build (node.mjs): the recording
# runs and nif/test/test.py run it.
NODE = os.path.join(ROOT, "target", "node")
# The npm packages (docs/packages.md), as package.json and their files.
PACKAGES_OUT = os.path.join(ROOT, "target", "packages")
# Applications by name prefix: Elixir, IEx and Mix, and what they use.
APPS = ("erts-", "kernel-", "stdlib-", "compiler-", "elixir", "iex", "logger", "mix", "eex",
        "ex_unit", "crypto-", "asn1-", "public_key-", "ssl-", "inets-", "runtime_tools-",
        "syntax_tools-", "parsetools-", "sasl-", "tools-", "xmerl-", "os_mon-", "mnesia-")
PHX_NEW = "1.8.15"
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()
NODE_IMAGE = "node:24"

# As worker/index.ts launches Elixir, with the page's esbuild and tailwind.
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
    if parts[0] == "mix":
        # Mix archives (Hex, phx_new), and rebar3.
        return len(parts) > 2 and parts[1] == "archives" or relative == "mix/rebar3"
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
    include}, bin/*.boot, releases/, mix/archives and mix/rebar3."""
    subprocess.run([os.path.join(ROOT, "beam", "build.sh"), "release"], check=True,
                   env=dict(os.environ, OPT="-O2", DIST=BEAM_DIST))
    shutil.rmtree(INSTALL, ignore_errors=True)
    shutil.copytree(os.path.join(BEAM_DIST, "otp", "lib"), os.path.join(INSTALL, "lib"))
    elixir = host_elixir()
    for app in ("elixir", "eex", "ex_unit", "iex", "logger", "mix"):
        for part in ("ebin", "priv", "include"):
            here = os.path.join(elixir, "lib", app, part)
            if os.path.isdir(here):
                shutil.copytree(here, os.path.join(INSTALL, "lib", app, part))
    os.makedirs(os.path.join(INSTALL, "bin"))
    tree = os.path.join(ROOT, "out", "beam-wasm", "releaseO2", "otp")
    for boot in ("start", "start_clean", "no_dot_erlang"):
        shutil.copy(os.path.join(tree, "bootstrap", "bin", f"{boot}.boot"), os.path.join(INSTALL, "bin"))
    with open(os.path.join(tree, "OTP_VERSION")) as f:
        version = f.read().strip()
    os.makedirs(os.path.join(INSTALL, "releases", version.split(".")[0]))
    with open(os.path.join(INSTALL, "releases", version.split(".")[0], "OTP_VERSION"), "w") as f:
        f.write(version + "\n")
    # Mix's archives and rebar3 as the host's Mix installs them (the same
    # OTP runs them).
    host_archives, rebar3 = host_mix()
    archives = os.path.join(INSTALL, "mix", "archives")
    os.makedirs(archives)
    for name in os.listdir(host_archives):
        if name.startswith(("hex-", f"phx_new-{PHX_NEW}")):
            shutil.copytree(os.path.join(host_archives, name), os.path.join(archives, name))
    shutil.copy(rebar3, os.path.join(INSTALL, "mix", "rebar3"))


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
    """(path in the node, path here) for the app at /work/playground: _build
    is BUILD (_build_otp); deps keep only the .git files Mix
    asks git about."""
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
                        out.append((f"work/playground/{relative_dir}/{name}", os.path.join(directory, name)))
                for refs, _, ref_names in os.walk(os.path.join(directory, "refs")):
                    for name in sorted(ref_names):
                        ref = os.path.relpath(os.path.join(refs, name), directory)
                        out.append((f"work/playground/{relative_dir}/{ref}", os.path.join(refs, name)))
                empty = os.path.join(CACHE, "empty")
                open(empty, "w").close()
                out.append((f"work/playground/{relative_dir}/objects/info/packs", empty))
                # A fresh shallow clone has no loose refs, and the node's
                # files make no empty directories: refs/ by a file git
                # skips (a ref's name has no leading dot).
                out.append((f"work/playground/{relative_dir}/refs/.keep", empty))
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
            relative = relative.replace(BUILD + "/", "_build/", 1)
            out.append(("work/playground/" + relative, path))
    return out


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
        command += ["-v", f"{NODE}:/w:ro", "-v", f"{out}:/d:ro", "-v", f"{scratch}:/r",
                    NODE_IMAGE, "node", "/w/node.mjs", "/d", *args]
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


def page(out, wasm):
    """The app's Vite build into `out` (the page, and the runtime's workers
    and service worker), and its Node harness into NODE; `wasm` is
    prebuilt()'s."""
    source = os.path.join(ROOT, "app")
    vite_build(source)
    # What an earlier build left: its assets, and its runtime's scripts.
    for name in ("_playground", "chunks"):
        shutil.rmtree(os.path.join(out, name), ignore_errors=True)
    for name in os.listdir(out) if os.path.isdir(out) else ():
        if name.endswith(".js"):
            os.remove(os.path.join(out, name))
    shutil.copytree(os.path.join(source, "dist"), out, dirs_exist_ok=True)
    shutil.rmtree(NODE, ignore_errors=True)
    shutil.copytree(os.path.join(source, "dist-node"), NODE)
    # Packages' NIF libraries built to WebAssembly (nif/build.py),
    # which the node's make fetches.
    packages = os.path.join(ROOT, "target", "nif", "packages")
    if os.path.isdir(packages):
        shutil.copytree(packages, os.path.join(out, "nif"), dirs_exist_ok=True)
    for name, built in wasm.items():
        shutil.copy(built, os.path.join(out, f"{name}.wasm"))
    # Mozilla's roots (the nodes' /etc/ssl/certs), for a Node.js process's
    # tls.rootCertificates (app/src/runtime/nodejs/tls.ts).
    shutil.copy(cacerts(), os.path.join(out, "roots.pem"))
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


# The origins that may embed the site by default (docs/embed.md).
EMBEDDERS = "https://tidewave.ai https://tidewave.steffend.me http://localhost:4000"


def runtime_versions():
    """The installation's OTP and Elixir versions: {otp, elixir}."""
    releases = os.path.join(INSTALL, "releases")
    with open(os.path.join(releases, os.listdir(releases)[0], "OTP_VERSION")) as f:
        otp = f.read().strip()
    with open(os.path.join(INSTALL, "lib", "elixir", "ebin", "elixir.app")) as f:
        elixir = re.search(r'\{vsn,\s*"([^"]+)"\}', f.read()).group(1)
    return {"otp": otp, "elixir": elixir}


# What stays at the site's root, by name: the pages, the service worker
# (its scope is /), the site's configuration, the content-hashed Vite
# assets, the builds and the runtimes; and what Vite copies from
# app/public (the icons, the manifest, og.png), which the pages name there.
ROOT_NAMES = {"index.html", "preview.html", "relay.html", "exec.html", "claude.html", "storage.html", "sw.js",
              "embed.html", "embed.js",
              "playground.json", "_playground", "b", "r",
              *os.listdir(os.path.join(ROOT, "app", "public"))}
# What goes to r/RID/: the BEAM and what it reads, which the JavaScript
# does not change.
RUNTIME_NAMES = {"beam.mjs", "beam.emu.mjs", "beam.wasm", "fs", "nif", "coreutils.wasm", "brush.wasm",
                 "tailscale.wasm", "tls.wasm", "roots.pem", "rg.wasm", "git.wasm", "sed.wasm",
                 "grep.wasm", "diff.wasm", "cmp.wasm", "diff3.wasm", "sdiff.wasm", "gawk.wasm", "find.wasm",
                 "site.json"}


def unversion(out):
    """A versioned site laid flat again, to build over."""
    for top in ("b", "r"):
        versions = os.path.join(out, top)
        if not os.path.isdir(versions):
            continue
        for version in os.listdir(versions):
            for name in os.listdir(os.path.join(versions, version)):
                shutil.rmtree(os.path.join(out, name), ignore_errors=True)
                os.rename(os.path.join(versions, version, name), os.path.join(out, name))
        shutil.rmtree(versions)


def digest(out, names, extra=b""):
    """A digest of the files below `names` in `out`, their paths with them."""
    hashed = hashlib.sha256(extra)
    for name in names:
        top = os.path.join(out, name)
        paths = [top] if os.path.isfile(top) else sorted(
            os.path.join(directory, file) for directory, _, files in os.walk(top) for file in files)
        for path in paths:
            hashed.update(os.path.relpath(path, out).encode() + b"\0")
            with open(path, "rb") as f:
                hashed.update(f.read())
    return hashed.hexdigest()[:16]


def version(out):
    """The flat site's runtime into r/RID/ and its JavaScript into b/ID/,
    and both into each page: (ID, RID)."""
    names = sorted(name for name in os.listdir(out) if name not in ROOT_NAMES)
    runtime = [name for name in names if name in RUNTIME_NAMES]
    scripts = [name for name in names if name not in RUNTIME_NAMES]
    rid = digest(out, runtime)
    build = digest(out, scripts, rid.encode())
    for top, version, moved in (("r", rid, runtime), ("b", build, scripts)):
        os.makedirs(os.path.join(out, top, version))
        for name in moved:
            os.rename(os.path.join(out, name), os.path.join(out, top, version, name))
    for name in os.listdir(out):
        if name.endswith(".html"):
            path = os.path.join(out, name)
            with open(path) as f:
                text = f.read()
            assert "<head>" in text, path
            with open(path, "w") as f:
                f.write(text.replace("<head>", f'<head>\n    <meta name="playground-build" content="{build}" />'
                                     f'\n    <meta name="playground-runtime" content="{rid}" />', 1))
    return build, rid


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
# Each package: its version, its files in the flat site, the packages it
# needs besides the runtime (by key), its `playground` field, and whether
# target/packages gets it (False: its files are only in the fs image, or
# in the app's own build).
PACKAGES = {
    "otp-{otp}": {
        "version": "1.0.0",
        "files": ["beam.mjs", "beam.emu.mjs", "beam.wasm"],
        # beam.wasm's imports are its Emscripten glue's (beam.mjs); the
        # runtime meets that glue at the beam seam (beam/run.ts).
        "own": ("env", "wasi_snapshot_preview1"),
        "playground": {"abi": {"beam": 1},
                       "beam": {"loader": "beam.mjs", "threads": "beam.emu.mjs", "wasm": "beam.wasm"}},
    },
    "elixir-{elixir}": {"version": "1.0.0", "files": [], "write": False, "playground": {}},
    "phoenix-template": {"version": "1.0.0", "files": [], "write": False,
                         "peers": ["otp-{otp}", "elixir-{elixir}"], "playground": {}},
    "shell": {
        "version": "1.0.0",
        "files": ["brush.wasm", "coreutils.wasm"],
        "playground": {"abi": {"wasi": 1, "processes": 1, "crossterm": 1},
                       "shell": "brush.wasm", "tools": "coreutils.wasm",
                       "programs": {name: "coreutils.wasm" for name in COREUTILS_TOOLS}},
    },
    "git": {"version": "1.0.0", "files": ["git.wasm"],
            "playground": {"abi": {"wasi": 1, "processes": 1}, "programs": {"git": "git.wasm"}}},
    "ripgrep": {"version": "1.0.0", "files": ["rg.wasm"],
                "playground": {"abi": {"wasi": 1}, "programs": {"rg": "rg.wasm"}}},
    "gnu-tools": {"version": "1.0.0", "files": sorted(set(GNU_TOOLS.values())),
                  "playground": {"abi": {"wasi": 1, "processes": 1}, "programs": GNU_TOOLS}},
    "tls": {"version": "1.0.0", "files": ["tls.wasm", "roots.pem"],
            "playground": {"abi": {"wasi": 1, "tls": 1}, "tls": {"module": "tls.wasm", "roots": "roots.pem"}}},
    "tailscale": {"version": "1.0.0", "files": ["tailscale.wasm"],
                  "playground": {"abi": {"tailscale": 1}, "tailscale": "tailscale.wasm"}},
    "claude": {"version": "1.0.0", "files": [], "write": False, "playground": {}},
}
# The packages whose files the fs image holds (fs_package).
FS_PACKAGES = ("otp-{otp}", "elixir-{elixir}", "phoenix-template", "git", "tls", "shell")
# A module's imports, by the seam (host.json's provides) they belong to.
IMPORT_SEAMS = {"wasi_snapshot_preview1": "wasi", "processes": "processes", "crossterm": "crossterm",
                "gojs": "tailscale"}


def fs_package(path):
    """The package (PACKAGES' key) a file of the fs image comes from."""
    if path.startswith("work/playground/"):
        return "phoenix-template"
    if path.startswith(("rotp/lib/elixir/", "rotp/lib/eex/", "rotp/lib/ex_unit/", "rotp/lib/iex/",
                        "rotp/lib/logger/", "rotp/lib/mix/", "rotp/mix/")):
        return "elixir-{elixir}"
    if path.startswith("rotp/"):
        return "otp-{otp}"
    if path.startswith("usr/libexec/git-core/"):
        return "git"
    if path.startswith("etc/ssl/"):
        return "tls"
    if path.startswith("usr/share/terminfo/"):
        return "shell"
    sys.exit(f"{path}: no package's (fs_package)")


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


def beam_abi(out):
    """The BEAM build's id: OTP's tag and the patch stack (beam/build.sh's
    stamp), emsdk's version and beam.wasm's imports and exports. What a NIF
    build and a recording are keyed by (docs/packages.md)."""
    stamp = os.path.join(ROOT, "out", "beam-wasm", "releaseO2", "otp", ".stamp-patched")
    try:
        emsdk = subprocess.run(["emcc", "--version"], capture_output=True, text=True).stdout.split("\n")[0]
    except OSError:
        emsdk = ""
    imports, exports = wasm_interface(os.path.join(out, "beam.wasm"))
    hashed = hashlib.sha256(json.dumps({
        "patches": open(stamp).read().strip() if os.path.exists(stamp) else "",
        "emsdk": emsdk, "imports": sorted(imports), "exports": sorted(exports)}).encode())
    return hashed.hexdigest()[:16]


def file_entry(path):
    with open(path, "rb") as f:
        return {"size": os.path.getsize(path), "sha256": hashlib.sha256(f.read()).hexdigest()}


def claude_code():
    """The Claude Code version the playground pins (CLAUDE_CODE in the app)."""
    path = os.path.join(ROOT, "app", "src", "project", "lib", "programs", "claude", "build.ts")
    with open(path) as f:
        return re.search(r"CLAUDE_CODE = \{\s*version: '([^']+)'", f.read()).group(1)


def site_manifest(out, facts):
    """The flat site's site.json (docs/packages.md), and its packages'
    package.json files by key. `facts`: what only a full build knows (the
    BEAM's id, the template's, the fs image's version), from it or from
    the site.json before."""
    with open(HOST) as f:
        host = json.load(f)
    runtime_range = "^%s.0.0" % host["version"].split(".")[0]
    versions = runtime_versions()
    otp, elixir = versions["otp"], versions["elixir"]
    named = lambda key: f"{SCOPE}/" + key.format(otp=otp, elixir=elixir)
    filled = {
        "otp-{otp}": {"otp": otp, "beamAbi": facts["beamAbi"]},
        "elixir-{elixir}": {"elixir": elixir, "requires": {"otp": "^%s.0.0" % otp.split(".")[0]}},
        "phoenix-template": {"template": {"kind": "phoenix", "id": facts["template"],
                                          "label": f"phx.new {PHX_NEW}", "otp": otp, "elixir": elixir}},
        # The newest version tested is the upper bound (docs/packages.md).
        "claude": {"claudeCode": f">={claude_code()} <={claude_code()}"},
    }
    packages, manifests = {}, {}
    for key, package in PACKAGES.items():
        playground = {**package["playground"], **filled.get(key, {})}
        peers = {f"{SCOPE}/runtime": runtime_range}
        for peer in package.get("peers", ()):
            peers[named(peer)] = "^%s" % PACKAGES[peer]["version"].split(".")[0]
        files = {}
        for name in package["files"]:
            path = os.path.join(out, name)
            files[name] = file_entry(path)
            if name.endswith(".wasm"):
                imports, _ = wasm_interface(path)
                for module in sorted({module for module, _ in imports} - set(package.get("own", ()))):
                    seam = IMPORT_SEAMS.get(module)
                    if seam not in playground.get("abi", {}):
                        sys.exit(f"{key}: {name} imports {module}, which its abi does not name")
        packages[named(key)] = {"version": package["version"], "base": "./", "files": files,
                                "peerDependencies": peers, "playground": playground}
        manifests[key] = {"name": named(key), "version": package["version"], "files": sorted(files),
                          "peerDependencies": peers, "playground": playground}
    fs = os.path.join(out, "fs")
    nif = os.path.join(out, "nif")
    site = {
        "manifest": 1,
        "packages": packages,
        "fs": {"base": "fs/", "format": 1, "version": facts["fs"],
               "boots": sorted(name[:-7] for name in os.listdir(fs) if re.match(r"boot.*\.tar\.gz$", name)),
               "packages": {named(key): PACKAGES[key]["version"] for key in FS_PACKAGES}},
        "nif": {"base": "nif/", "beamAbi": facts["beamAbi"],
                "libraries": sorted(name[:-4] for name in os.listdir(nif) if name.endswith(".tar"))}
        if os.path.isdir(nif) else None,
    }
    with open(os.path.join(out, "site.json"), "w") as f:
        json.dump(site, f, indent=1, sort_keys=True)
    return manifests, host


def previous_facts(out):
    """What a full build found (site_manifest's facts), from the flat site's
    site.json, or from a site built before it had one."""
    try:
        with open(os.path.join(out, "site.json")) as f:
            site = json.load(f)
        template = next(entry["playground"]["template"]["id"] for entry in site["packages"].values()
                        if "template" in entry["playground"])
        otp = next(entry["playground"]["beamAbi"] for entry in site["packages"].values()
                   if "beamAbi" in entry["playground"])
        return {"beamAbi": otp, "template": template, "fs": site["fs"]["version"]}
    except (OSError, KeyError, StopIteration):
        templates = os.path.join(out, "fs", "templates.json")
        with open(os.path.join(out, "fs", "version")) as f:
            fs = f.read().strip()
        template = json.load(open(templates))["phoenix"]["id"] if os.path.exists(templates) else ""
        return {"beamAbi": beam_abi(out), "template": template, "fs": fs}


# The runtime package's files: the build's scripts (b/ID) and the service
# worker. The frames' pages are the app's (Vite's _playground/ assets,
# shared with the IDE), so they are not in it yet.
RUNTIME_SCRIPTS = ("worker.js", "files.js", "git.js", "nodejs.js", "tailscale.js", "chunks", "sw.js")


def write_packages(out, manifests, host):
    """target/packages/NAME/: each package's package.json and its files
    (linked to the site's), for the packages that map onto the site's
    files; the runtime's and the api's from the build."""
    shutil.rmtree(PACKAGES_OUT, ignore_errors=True)
    runtime_range = "^%s.0.0" % host["version"].split(".")[0]
    packages = {
        "runtime": ({"name": host["name"], "version": host["version"], "files": list(RUNTIME_SCRIPTS),
                     "playground": {"provides": host["provides"]}}, RUNTIME_SCRIPTS),
        "api": ({"name": f"{SCOPE}/api", "version": "1.0.0", "files": ["embed.js"], "exports": "./embed.js",
                 "peerDependencies": {host["name"]: runtime_range},
                 "playground": {"apiVersions": [1]}}, ("embed.js",)),
    }
    for key, manifest in manifests.items():
        if PACKAGES[key].get("write", True):
            packages[manifest["name"].split("/")[1]] = (manifest, manifest["files"])
    for directory, (manifest, files) in packages.items():
        target = os.path.join(PACKAGES_OUT, directory)
        os.makedirs(target)
        for name in files:
            here = os.path.join(out, name)
            if os.path.isdir(here):
                shutil.copytree(here, os.path.join(target, name), copy_function=link_or_copy)
            else:
                link_or_copy(here, os.path.join(target, name))
        with open(os.path.join(target, "package.json"), "w") as f:
            # Not for publishing yet (docs/packages.md).
            json.dump({**manifest, "private": True}, f, indent=2)
            f.write("\n")
    return sorted(packages)


def link_or_copy(source, target):
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def main():
    out = os.path.join(ROOT, "target", "site")
    wasm = prebuilt()
    if sys.argv[1:] == ["app"]:
        unversion(out)
        facts = previous_facts(out)
        page(out, wasm)
        print(f"{out}: packages " + ", ".join(write_packages(out, *site_manifest(out, facts))))
        print(f"{out}: build %s, runtime %s" % version(out))
        return
    shutil.rmtree(out, ignore_errors=True)
    # The installation first: site.json names its versions.
    otp_install()
    page(out, wasm)
    for name in ("beam.mjs", "beam.emu.mjs", "beam.wasm"):
        shutil.copy(os.path.join(BEAM_DIST, name), os.path.join(out, name))

    files = []  # (path in the node, path here)
    for directory, dirs, names in os.walk(INSTALL):
        dirs.sort()
        for name in sorted(names):
            relative = os.path.relpath(os.path.join(directory, name), INSTALL)
            if installed(relative):
                files.append(("rotp/" + relative, os.path.join(INSTALL, relative)))
    files.append(("etc/ssl/certs/ca-certificates.crt", cacerts()))
    # The terminal's terminfo entry (setup.ts sets TERM): IEx's line
    # editing needs it.
    files.append(("usr/share/terminfo/x/xterm-256color",
                  os.path.join(ROOT, "runtime", "terminfo", "x", "xterm-256color")))
    # git's commands that are shell scripts (tools/git/build.py), at git.wasm's
    # exec path (its prefix is /usr).
    libexec = os.path.join(ROOT, "target", "git", "libexec")
    for name in sorted(os.listdir(libexec)):
        files.append(("usr/libexec/git-core/" + name, os.path.join(libexec, name)))
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
    # The recording runs find the programs through site.json too; what only
    # this build will know comes after them.
    facts = {"beamAbi": beam_abi(out), "template": "", "fs": ""}
    site_manifest(out, facts)
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
    needed = lambda path: path.endswith((".app", ".boot")) or path.startswith(
        ("rotp/releases/", "rotp/lib/erts/"))
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
    template_id = template.hexdigest()[:12]
    # What a project's kept changes were made over (files.js).
    digest = hashlib.sha256()
    for name in sorted(os.listdir(fs)):
        if os.path.isfile(os.path.join(fs, name)):
            with open(os.path.join(fs, name), "rb") as f:
                digest.update(f.read())
    with open(os.path.join(fs, "version"), "w") as f:
        f.write(digest.hexdigest()[:16] + "\n")
    facts.update(template=template_id, fs=digest.hexdigest()[:16])
    print(f"{out}: packages " + ", ".join(write_packages(out, *site_manifest(out, facts))))
    # Which package each of the fs image's files is from (docs/packages.md).
    owners = {}
    for path, _ in files:
        owner = fs_package(path).format(**runtime_versions())
        owners[owner] = owners.get(owner, 0) + 1
    print(f"{out}: fs image files by package: " + ", ".join(f"{key} {n}" for key, n in sorted(owners.items())))
    mb = lambda path: f"{os.path.getsize(path) / 1e6:.1f} MB"
    print(f"{out}: " + ", ".join(f"{name} {mb(os.path.join(out, name))}" for name in ("beam.wasm",)) + "; " + "; ".join(
        f"{boot} {len(images[boot])} files ({len(fetched[boot])} recorded), {mb(os.path.join(fs, boot + '.tar.gz'))}"
        for boot in RECORD) + f"; {len(lazy)} lazy files in {bundles} bundles")
    print(f"{out}: build %s, runtime %s" % version(out))


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
