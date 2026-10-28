"""What each package bundles, under which licenses (docs/licenses.md), and
the site's licenses page, for runtime/build.py.

Each package's inventory is put together here from what built its files:
the tools' (target/NAME/licenses, tools/licenses.py), the Vite builds'
(dist-licenses/NAME.json, vite-licenses.ts), OTP's sources and
build (out/beam-wasm), the releases of Elixir, Hex, phx_new and rebar3,
and the template's dependencies. lay() writes it into the package:
licenses/ (index.json and the texts), NOTICE.md, LICENSE when the
playground's own code is in it, and source/ when a component's license
asks for its source to go with it. page() writes /licenses/ from the
packages a site has.

Loaded by path, as build.py's tools load tools/licenses.py.
"""

import html
import importlib.util
import io
import json
import os
import re
import shutil
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("licenses", os.path.join(ROOT, "tools", "licenses.py"))
licenses = importlib.util.module_from_spec(spec)
spec.loader.exec_module(licenses)

REPOSITORY = "https://github.com/SteffenDE/run-elixir.dev"
# The playground's own code: Apache-2.0 (LICENSE, NOTICE at the root).
OWN = ("elixir-playground", "playground", "Apache-2.0", REPOSITORY,
       {"LICENSE": os.path.join(ROOT, "LICENSE"), "NOTICE": os.path.join(ROOT, "NOTICE")})
# Popcorn's patches and Emscripten glue, which beam/ starts from (beam/README.md).
POPCORN = "a64cbbc23cf1244a27d69a6d684e10c5040aa0e6"


def own():
    return licenses.Inventory().add(*OWN, note="The playground's own code.")


def tool(name, subdir=None):
    """A tool build's inventory (target/NAME/licenses) and its corresponding
    source (target/NAME/source, for a copyleft one): (inventory, {subdir:
    path}). Its components' `source` names the package's source/SUBDIR/."""
    out = os.path.join(ROOT, "target", name)
    directory = os.path.join(out, "licenses")
    if not os.path.exists(os.path.join(directory, "index.json")):
        raise SystemExit(f"{directory}: no inventory (build the tool again: tools/licenses.py)")
    inventory = licenses.Inventory.read(directory)
    subdir = subdir or name
    sources = {}
    for component in inventory.components:
        if component.get("source") == "source/":
            component["source"] = f"source/{subdir}/"
            sources[subdir] = os.path.join(out, "source")
    return inventory, sources


# npm packages' licenses that are no SPDX expression, as tools/licenses.py
# names them.
NPM_LICENSES = {"Remix Icon License 1.0": "LicenseRef-Remix-Icon-1.0"}


def npm(name):
    """What a Vite build bundled from node_modules (dist-licenses/NAME.json, vite-licenses.ts)."""
    path = os.path.join(ROOT, "dist-licenses", f"{name}.json")
    with open(path) as f:
        listed = json.load(f)
    inventory = licenses.Inventory()
    for c in listed["components"]:
        license = NPM_LICENSES.get(c["license"], c["license"])
        # SPDX ids in another case ("apache-2.0").
        canonical = {name.lower(): name for name in licenses.ALLOWED | licenses.EXCEPTIONS}
        license = re.sub(r"[^\s()]+", lambda m: canonical.get(m.group().lower(), m.group()), license)
        inventory.add(c["name"], c["version"], license, c["url"],
                      {file: text.encode() for file, text in c["texts"].items()})
    return inventory


def release(url, cache):
    """A release tarball's members, {path without its top directory: bytes},
    kept in `cache`."""
    data = licenses.fetch_text(url, cache)
    members = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for member in tar.getmembers():
            if member.isfile() and "/" in member.name:
                members[member.name.split("/", 1)[1]] = member
        return {name: tar.extractfile(member).read() for name, member in members.items()
                if licenses.LICENSE_FILE.match(os.path.basename(name)) or name.startswith("LICENSES/")
                or os.path.basename(name) == "hex_metadata.config"}


def vendored(otp_tree):
    """OTP's vendored components that beam.wasm and the applications the
    site installs include (vendor.info, OTP's SPDX inventory): erts's zlib,
    pcre2 and ryu, and stdlib's Unicode data. Not asmjit (no JIT), zstd
    (patch 0002 leaves it out), nor what only builds or tests use."""
    wanted = ("erts/emulator/zlib", "erts/emulator/pcre", "erts/emulator/ryu", "lib/stdlib/uc_spec")
    inventory = licenses.Inventory()
    for place in wanted:
        with open(os.path.join(otp_tree, place, "vendor.info")) as f:
            text = re.sub(r"^\s*//.*$", "", f.read(), flags=re.M)
        for entry in json.loads(text):
            directory = os.path.join(otp_tree, place)
            inventory.add(entry["name"], entry["versionInfo"], entry["licenseDeclared"],
                          entry.get("homepage") or entry["downloadLocation"], licenses.license_files(directory),
                          note=f"Vendored in OTP ({place}).")
    return inventory


def emscripten():
    """Emscripten's directory: the emcc on PATH's, else ~/emsdk's, where
    beam/build.sh finds it (CI puts no emsdk on PATH)."""
    emcc = shutil.which("emcc")
    if emcc:
        return os.path.dirname(os.path.realpath(emcc))
    directory = os.path.join(os.path.expanduser("~"), "emsdk", "upstream", "emscripten")
    if not os.path.exists(os.path.join(directory, "emcc")):
        raise SystemExit("emcc: not on PATH, and no ~/emsdk (beam/build.sh's emsdk)")
    return directory


def otp(otp_version):
    """The otp package: beam.wasm and its glue (OTP's erts, with Popcorn's
    and the playground's patches, OpenSSL and ncurses linked in, Emscripten's
    libc and runtime) and OTP's applications."""
    beam = os.path.join(ROOT, "out", "beam-wasm")
    tree = os.path.join(beam, "releaseO2", "otp")
    inventory = licenses.Inventory()
    inventory.add("Erlang/OTP", otp_version, "Apache-2.0", "https://www.erlang.org",
                  {"LICENSE.txt": os.path.join(tree, "LICENSE.txt")},
                  note="Built from OTP's sources with the patches in beam/patches/ of the playground's "
                       "repository (Popcorn's 0001 to 0014, the playground's from 0015).")
    inventory.extend(vendored(tree))
    inventory.add("popcorn", POPCORN[:12], "Apache-2.0", "https://github.com/software-mansion/popcorn", {},
                  note="Software Mansion's patches to OTP and Emscripten glue, which beam/ starts from.")
    inventory.add("OpenSSL", "3.0.15", "Apache-2.0", "https://www.openssl.org",
                  licenses.license_files(os.path.join(beam, "openssl", "licenses")),
                  note="Linked into beam.wasm (crypto, public_key, ssl).")
    inventory.add("ncurses", "6.5", "X11-distribute-modifications-variant", "https://invisible-island.net/ncurses/",
                  licenses.license_files(os.path.join(beam, "ncurses", "licenses")), note="Linked into beam.wasm.")
    em = emscripten()
    with open(os.path.join(em, "emscripten-version.txt")) as f:
        version = f.read().strip().strip('"')
    inventory.add("emscripten", version, "MIT OR NCSA", "https://emscripten.org",
                  licenses.license_files(em), note="beam.mjs and beam.emu.mjs, and its runtime in beam.wasm.")
    inventory.add("musl (Emscripten's)", version, "MIT", "https://musl.libc.org",
                  licenses.license_files(os.path.join(em, "system", "lib", "libc", "musl")),
                  note="Emscripten's libc, linked into beam.wasm.")
    inventory.add("compiler-rt (Emscripten's)", version, "Apache-2.0 WITH LLVM-exception", "https://llvm.org",
                  licenses.license_files(os.path.join(em, "system", "lib", "compiler-rt")),
                  note="Linked into beam.wasm.")
    return inventory.extend(own())


def hex_name(name):
    """A Hex or rebar3 app's license name as SPDX has it."""
    names = {"Apache": "Apache-2.0", "Apache2": "Apache-2.0", "Apache 2.0": "Apache-2.0",
             "Apache License 2.0": "Apache-2.0", "MIT License": "MIT"}
    return names.get(name, name)


def elixir(versions, rebar3, cache):
    """The elixir package: Elixir, and Mix's Hex, phx_new and rebar3 (with
    the applications rebar3 vendors)."""
    version = versions["elixir"]
    inventory = licenses.Inventory()
    texts = release(f"https://github.com/elixir-lang/elixir/archive/refs/tags/v{version}.tar.gz", cache)
    inventory.add("elixir", version, "Apache-2.0 AND LicenseRef-scancode-unicode", "https://elixir-lang.org",
                  {os.path.basename(name): text for name, text in texts.items()},
                  note="Elixir, EEx, ExUnit, IEx, Logger and Mix. LICENSES/ has its Unicode data's license "
                       "and the Elixir trademark policy.")
    hex_version = versions["hex"]
    inventory.add("hex", hex_version, "Apache-2.0", "https://hex.pm", {},
                  note="Mix's Hex archive (with hex_core, Apache-2.0). Its repository ships no license file.")
    phx = versions["phx_new"]
    package = licenses.fetch_text(f"https://repo.hex.pm/tarballs/phx_new-{phx}.tar", cache)
    with tarfile.open(fileobj=io.BytesIO(package)) as outer:
        metadata = licenses.hex_metadata(outer.extractfile("metadata.config").read().decode())
    inventory.add("phx_new", phx, " AND ".join(map(hex_name, metadata["licenses"])),
                  "https://www.phoenixframework.org", {}, note="Mix's phx_new archive.")
    with open(rebar3, "rb") as f:
        head = f.read(200).decode(errors="replace")
    rebar_version = re.search(r"Rebar3 (\S+)", head).group(1)
    texts = release(f"https://github.com/erlang/rebar3/archive/refs/tags/{rebar_version}.tar.gz", cache)
    inventory.add("rebar3", rebar_version, "Apache-2.0", "https://rebar3.org", {"LICENSE": texts["LICENSE"]})
    for app in sorted({name.split("/")[1] for name in texts if name.startswith("vendor/")}):
        found = {os.path.basename(name): text for name, text in texts.items()
                 if name.startswith(f"vendor/{app}/") and name.count("/") == 2}
        metadata = found.pop("hex_metadata.config", None)
        kinds = {licenses.classify(text.decode(errors="replace")) for text in found.values()} - {None}
        note = "Vendored in rebar3."
        if not kinds and metadata:
            # No license file: what its Hex metadata declares.
            kinds = set(map(hex_name, licenses.hex_metadata(metadata.decode())["licenses"]))
            note += " Its license as its Hex metadata declares it."
        if not kinds:
            raise SystemExit(f"rebar3's {app}: no license text tools/licenses.py recognizes")
        inventory.add(app, f"rebar3 {rebar_version}", licenses.conjunction(kinds), "https://rebar3.org", found,
                      note=note)
    return inventory


def template(app, phx_new, cache):
    """The phoenix-template package: phx.new's app (`app`, at /work/playground)
    and its dependencies' sources and builds."""
    inventory = licenses.Inventory()
    inventory.add("phx.new app", phx_new, "MIT", "https://www.phoenixframework.org", {},
                  note="The app phx.new generated, and its assets/vendor/heroicons.js.")
    inventory.add("topbar", "3.0.0", "MIT", "https://buunguyen.github.io/topbar", {},
                  note="assets/vendor/topbar.js; its copyright notice is in the file's header.")
    with open(os.path.join(app, "mix.lock")) as f:
        lock = f.read()
    deps = os.path.join(app, "deps")
    for name in sorted(os.listdir(deps)):
        directory = os.path.join(deps, name)
        metadata = os.path.join(directory, "hex_metadata.config")
        if os.path.exists(metadata):
            with open(metadata) as f:
                about = licenses.hex_metadata(f.read())
            about["licenses"] = [hex_name(n) for n in about["licenses"]]
            inventory.extend(licenses.hex_component(directory, about))
            continue
        # A git dependency, checked out sparsely: its license from its
        # repository at the locked commit.
        locked = re.search(rf'"{name}": \{{:git, "https://github.com/([^"]+?)(?:\.git)?", "([0-9a-f]+)", '
                           r'\[tag: "([^"]+)"', lock)
        if not locked:
            raise SystemExit(f"{name}: neither a Hex package nor a GitHub dependency in mix.lock")
        repo, commit, tag = locked.groups()
        text = licenses.fetch_text(f"https://raw.githubusercontent.com/{repo}/{commit}/LICENSE", cache)
        kind = licenses.classify(text.decode(errors="replace"))
        if not kind:
            raise SystemExit(f"{name}: its LICENSE is no license tools/licenses.py recognizes")
        inventory.add(name, tag, kind, f"https://github.com/{repo}", {"LICENSE": text})
    return inventory


def tls(roots):
    """The tls package: tls.wasm (the playground's, with rustls) and
    Mozilla's root certificates (roots.pem, and the nodes' CA bundle)."""
    inventory, sources = tool("tls")
    name = os.path.basename(roots)
    inventory.add("Mozilla CA certificate store", re.sub(r"^cacert-|\.pem$", "", name), "MPL-2.0",
                  "https://curl.se/docs/caextract.html", {}, source="roots.pem",
                  note="curl's extract of Mozilla's root certificates: roots.pem, and "
                       "/etc/ssl/certs/ca-certificates.crt in the nodes' files. The file is its own source.")
    return inventory.extend(own()), sources


def shell():
    """The shell package: brush and coreutils, and the terminal's terminfo
    entry (ncurses's)."""
    inventory, sources = tool("brush")
    inventory.extend(tool("coreutils")[0])
    inventory.add("ncurses terminfo", "6.5", "X11-distribute-modifications-variant",
                  "https://invisible-island.net/ncurses/",
                  {"COPYING": os.path.join(ROOT, "runtime", "terminfo", "COPYING")},
                  note="usr/share/terminfo/x/xterm-256color in the nodes' files.")
    return inventory, sources


def gnu_tools(names):
    inventory, sources = licenses.Inventory(), {}
    for name in names:
        found, source = tool(name)
        inventory.extend(found)
        sources.update(source)
    return inventory, sources


def write(scratch, name, inventory, sources):
    """A package's licenses into its directory `scratch`: licenses/,
    NOTICE.md, LICENSE (with the playground's own code) and source/. The
    files it added, and the package's license expression."""
    for component in inventory.components:
        if licenses.needs_source(component["license"]):
            path = component.get("source", "")
            subdir = path.split("/")[1] if path.startswith("source/") else None
            if not (subdir in sources or os.path.exists(os.path.join(scratch, path.rstrip("/")))):
                raise SystemExit(f"{name}: {component['name']} needs its source in the package ({path})")
    inventory.write(os.path.join(scratch, "licenses"))
    for subdir, path in sorted(sources.items()):
        shutil.copytree(path, os.path.join(scratch, "source", subdir))
    added = ["NOTICE.md", "licenses", *(["source"] if sources else [])]
    if any(c["name"] == OWN[0] for c in inventory.components):
        shutil.copy(os.path.join(ROOT, "LICENSE"), os.path.join(scratch, "LICENSE"))
        added.append("LICENSE")
    expression = inventory.expression()
    rows = "\n".join(
        f"| [{c['name']}]({c['url']}) | {c['version']} | {c['license']} |"
        + (f" [source]({c['source']})" if c.get("source") else "") + " |"
        for c in sorted(inventory.components, key=lambda c: (c["name"].lower(), c["version"])))
    with open(os.path.join(scratch, "NOTICE.md"), "w") as f:
        source = ("`source/` has the source of those whose license asks for it to go with them."
                  if sources else "")
        f.write(f"""# {name}

Part of the Elixir Playground ({REPOSITORY}). Its files are under

    {expression}

each component under its own license, as listed here. `licenses/` has
their texts, and `licenses/index.json` lists them. {source}

| Component | Version | License | Source |
| --- | --- | --- | --- |
{rows}
""")
    return added, expression


PAGE_STYLE = """
body { font: 14px/1.5 system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 32px 16px 64px;
       color: #1f2328; background: #fff; }
h1 { font-size: 24px; } h2 { font-size: 17px; margin-top: 36px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #d0d7de; vertical-align: top; }
td.note { color: #59636e; } code { font-size: 12px; }
@media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; }
  th, td { border-color: #30363d; } td.note { color: #9198a1; } a { color: #4493f8; } }
"""


def section(title, about, index, base):
    """A package's table on the page: its index.json's components, texts at `base`."""
    rows = []
    for c in index["components"]:
        texts = " ".join(f'<a href="{html.escape(base + path)}">{html.escape(os.path.basename(path))}</a>'
                         for path in c["texts"])
        source = c.get("source")
        if source:
            texts += f' · <a href="{html.escape(base[:-len("licenses/")] + source)}">source</a>'
        rows.append(f'<tr><td><a href="{html.escape(c["url"])}">{html.escape(c["name"])}</a></td>'
                    f'<td>{html.escape(c["version"])}</td><td><code>{html.escape(c["license"])}</code></td>'
                    f'<td>{texts}</td><td class="note">{html.escape(c.get("note", ""))}</td></tr>')
    return (f'<h2 id="{html.escape(title)}">{html.escape(title)}</h2><p>{about}</p>'
            '<table><tr><th>Component</th><th>Version</th><th>License</th><th>Texts</th><th>Notes</th></tr>'
            + "".join(rows) + "</table>")


def page(out, packages, apex):
    """/licenses/: the site's pages (`apex`, an inventory, whose texts go in
    licenses/apex/) and each package's components (`packages`, their
    directories in `out`), with links to their texts and sources."""
    directory = os.path.join(out, "licenses")
    shutil.rmtree(directory, ignore_errors=True)
    apex.write(os.path.join(directory, "apex"))
    with open(os.path.join(directory, "apex", "index.json")) as f:
        sections = [section("The playground's pages", "What this site's pages (the IDE) bundle.",
                            json.load(f), "/licenses/apex/")]
    for package in sorted(packages):
        with open(os.path.join(out, package, "package.json")) as f:
            manifest = json.load(f)
        with open(os.path.join(out, package, "licenses", "index.json")) as f:
            index = json.load(f)
        about = (f'<code>{html.escape(manifest["license"])}</code>. '
                 f'<a href="/{html.escape(package)}/NOTICE.md">NOTICE.md</a>')
        sections.append(section(f'{manifest["name"]}@{manifest["version"]}', about, index,
                                f"/{package}/licenses/"))
    with open(os.path.join(directory, "index.html"), "w") as f:
        f.write(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Licenses · Elixir Playground</title><style>{PAGE_STYLE}</style></head><body>
<h1>Licenses</h1>
<p>The Elixir Playground's own code is under the Apache License 2.0
(<a href="{REPOSITORY}">its repository</a>). What this site serves bundles other software, each
under its own license, as listed here for this deploy: the pages, then each package the
playground runs with. Each package's <code>licenses/</code> has the texts, and its
<code>source/</code> the source of components whose license asks for it to go with them.</p>
{"".join(sections)}
</body></html>
""")
