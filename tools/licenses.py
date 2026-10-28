"""What the playground bundles and under which licenses (docs/licenses.md):
an inventory of components, each with its version, its SPDX license
expression, where it comes from, and its license texts.

    inventory = Inventory()
    inventory.add("zlib", "1.3.2", "Zlib", "https://zlib.net", {"LICENSE": path})
    inventory.write(os.path.join(OUT, "licenses"))

An inventory on disk is a directory: index.json, and each component's
texts in a directory of its own (NAME-VERSION/). Each tool's build writes
one beside its module (target/NAME/licenses/), and runtime/build.py puts
them together in each package's licenses/ and in the site's licenses
page. Writing one checks it: every license is one ALLOWED knows, every
component has a text, and every component whose license asks for its
source to go with it names that source.

Loaded by path (python3 -I leaves the script's directory off sys.path),
as tools/wasi-compat/autoconf.py is.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Standard texts and wasi-libc's (tools/license-texts/README.md).
TEXTS = os.path.join(ROOT, "tools", "license-texts")
# The licenses a bundled component may have, by SPDX id. Another stops the
# build until someone has read it and added it here.
PERMISSIVE = {"MIT", "MIT-0", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Zlib", "Unlicense",
              "CC0-1.0", "BSL-1.0", "Unicode-3.0", "Unicode-DFS-2016", "CDLA-Permissive-2.0", "NCSA",
              "X11-distribute-modifications-variant",
              # The Unicode data files' license, as Elixir's LICENSES/ names it.
              "LicenseRef-scancode-unicode"}
# These ask that the source go with the binary (or, MPL-2.0, its files').
COPYLEFT = {"GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "LGPL-2.1-only",
            "LGPL-2.1-or-later", "LGPL-3.0-or-later", "MPL-2.0"}
# Neither: licenses read and allowed for what the playground uses them for.
# Remix Icon's (@remixicon/react, the IDE's icons): icons as parts of a
# larger product, not sold or offered as an icon set, nor as a logo.
OTHER = {"LicenseRef-Remix-Icon-1.0"}
ALLOWED = PERMISSIVE | COPYLEFT | OTHER
EXCEPTIONS = {"LLVM-exception", "Autoconf-exception-generic-3.0"}
# A component's license files, by name.
LICENSE_FILE = re.compile(r"^(LICEN[CS]E|COPYING|COPYRIGHT|NOTICE|UNLICENSE|PATENTS)([-._].*)?$", re.I)
# Not code that happens to be named so (tailscale.com's license_test.go).
CODE = re.compile(r"\.(go|rs|c|h|js|ts|py|ex|exs|erl|sh)$")


def parse(expression):
    """An SPDX license expression as a tree: an id, ("WITH", id, exception),
    ("AND", [...]) or ("OR", [...])."""
    tokens = re.findall(r"\(|\)|[^\s()]+", expression)
    position = 0

    def take():
        nonlocal position
        if position == len(tokens):
            raise ValueError(f"{expression}: ends early")
        position += 1
        return tokens[position - 1]

    def peek():
        return tokens[position] if position < len(tokens) else None

    def atom():
        if peek() == "(":
            take()
            tree = either()
            if take() != ")":
                raise ValueError(f"{expression}: unbalanced")
            return tree
        name = take()
        if peek() == "WITH":
            take()
            return ("WITH", name, take())
        return name

    def both():
        terms = [atom()]
        while peek() == "AND":
            take()
            terms.append(atom())
        return terms[0] if len(terms) == 1 else ("AND", terms)

    def either():
        terms = [both()]
        while peek() == "OR":
            take()
            terms.append(both())
        return terms[0] if len(terms) == 1 else ("OR", terms)

    tree = either()
    if position != len(tokens):
        raise ValueError(f"{expression}: unexpected {tokens[position]}")
    return tree


def ids(expression):
    """The license ids and exceptions an expression names."""
    found = set()

    def walk(tree):
        if isinstance(tree, str):
            found.add(tree)
        elif tree[0] == "WITH":
            found.update(tree[1:])
        else:
            for term in tree[1]:
                walk(term)

    walk(parse(expression))
    return found


def needs_source(expression):
    """Whether every choice the expression offers is a copyleft one."""
    def walk(tree):
        if isinstance(tree, str):
            return tree in COPYLEFT
        if tree[0] == "WITH":
            return tree[1] in COPYLEFT
        if tree[0] == "AND":
            return any(map(walk, tree[1]))
        return all(map(walk, tree[1]))

    return walk(parse(expression))


def normal(expression):
    """An expression in one spelling: the terms of each AND and OR sorted
    and each once ("MIT OR Apache-2.0" is "Apache-2.0 OR MIT")."""
    def render(tree, inside=None):
        if isinstance(tree, str):
            return tree
        if tree[0] == "WITH":
            return f"{tree[1]} WITH {tree[2]}"
        flat = []
        for term in tree[1]:
            flat += term[1] if isinstance(term, tuple) and term[0] == tree[0] else [term]
        terms = sorted({render(term, tree[0]) for term in flat})
        if len(terms) == 1:
            return terms[0]
        text = f" {tree[0]} ".join(terms)
        # AND binds tighter than OR: an OR inside an AND is parenthesized.
        return f"({text})" if inside == "AND" and tree[0] == "OR" else text

    return render(parse(expression))


def conjunction(expressions):
    """The expressions, each once, joined with AND."""
    return normal(" AND ".join(f"({e})" for e in set(expressions)))


def standard_texts(expression):
    """The SPDX standard texts of an expression's licenses, by file name."""
    texts = {}
    for name in sorted(ids(expression)):
        path = os.path.join(TEXTS, "other" if name.startswith("LicenseRef-") else "spdx", f"{name}.txt")
        if not os.path.exists(path):
            raise SystemExit(f"{name}: no standard text in {os.path.relpath(path, ROOT)} "
                             "(add it from spdx/license-list-data)")
        texts[f"{name}.txt"] = path
    return texts


def license_files(directory):
    """A directory's license files: {name: path}."""
    return {name: os.path.join(directory, name) for name in sorted(os.listdir(directory))
            if LICENSE_FILE.match(name) and not CODE.search(name) and os.path.isfile(os.path.join(directory, name))}


def wasi_libc():
    """wasi-libc's texts (every wasm32-wasip1 module links it)."""
    directory = os.path.join(TEXTS, "wasi-libc")
    return {name: os.path.join(directory, name) for name in sorted(os.listdir(directory))}


# Phrases that tell a license text apart, for components that ship texts
# but no SPDX id (Go modules). The first match wins.
CLASSIFY = [
    # (relx's LICENSE.md underlines its title.)
    ("Apache-2.0", r"Apache License,?[\s=]+Version 2\.0"),
    ("MPL-2.0", r"Mozilla Public License,?\s+(Version|v\.)\s*2\.0"),
    ("GPL-3.0-or-later", r"GNU GENERAL PUBLIC LICENSE\s+Version 3"),
    ("GPL-2.0-only", r"GNU GENERAL PUBLIC LICENSE\s+Version 2"),
    ("Unlicense", r"This is free and unencumbered software released into the public domain"),
    ("CC0-1.0", r"CC0 1\.0 Universal"),
    ("BSD-3-Clause", r"Redistribution and use in source and binary forms(.|\n)*Neither the name"),
    ("BSD-2-Clause", r"Redistribution and use in source and binary forms"),
    ("MIT", r"Permission is hereby granted, free of charge, to any person"),
    ("ISC", r"Permission to use, copy, modify, and(/or)? distribute this software for any"),
    ("Zlib", r"This software is provided 'as-is', without any express or implied"),
]


def classify(text):
    """The SPDX id of a license text, or None."""
    for name, pattern in CLASSIFY:
        if re.search(pattern, text):
            return name
    return None


class Inventory:
    """Components: {name, version, license, url, texts: {file: path or
    bytes}, source?, note?}."""

    def __init__(self, components=()):
        self.components = list(components)

    def add(self, name, version, license, url, texts, source=None, note=None):
        """A component; `texts` empty: the license's standard texts, and a
        note that the component ships none."""
        if not texts:
            texts = standard_texts(license)
            note = " ".join(filter(None, [note, "Ships no license file: the SPDX standard text of its license."]))
        component = {"name": name, "version": version, "license": normal(license), "url": url,
                     "texts": dict(texts)}
        if source:
            component["source"] = source
        if note:
            component["note"] = note
        self.components.append(component)
        return self

    def extend(self, other):
        """Another inventory's components that are not here yet (by name and
        version)."""
        seen = {(c["name"], c["version"]) for c in self.components}
        self.components += [c for c in other.components if (c["name"], c["version"]) not in seen]
        return self

    def expression(self):
        """What a package of these components is under: each license once."""
        return conjunction(c["license"] for c in self.components)

    def check(self):
        problems = []
        for c in self.components:
            label = f"{c['name']} {c['version']}"
            try:
                named = ids(c["license"])
            except (ValueError, IndexError) as error:
                problems.append(f"{label}: {c['license']}: {error}")
                continue
            for name in sorted(named - ALLOWED - EXCEPTIONS):
                problems.append(f"{label}: {name} is not an allowed license (tools/licenses.py ALLOWED)")
            if not c["texts"]:
                problems.append(f"{label}: no license text")
            if needs_source(c["license"]) and not c.get("source"):
                problems.append(f"{label}: {c['license']} needs its source with it, and none is named")
        if problems:
            raise SystemExit("licenses:\n  " + "\n  ".join(problems))

    def write(self, directory):
        """index.json and the texts into `directory` (replacing it)."""
        self.check()
        shutil.rmtree(directory, ignore_errors=True)
        os.makedirs(directory)
        index = []
        for c in sorted(self.components, key=lambda c: (c["name"].lower(), c["version"])):
            folder = re.sub(r"[^A-Za-z0-9._+-]", "_", f"{c['name']}-{c['version']}".lstrip("@"))
            os.makedirs(os.path.join(directory, folder), exist_ok=True)
            texts = []
            for file, text in sorted(c["texts"].items()):
                if isinstance(text, str):
                    with open(text, "rb") as f:
                        text = f.read()
                with open(os.path.join(directory, folder, file), "wb") as f:
                    f.write(text)
                texts.append(f"{folder}/{file}")
            entry = {key: c[key] for key in ("name", "version", "license", "url")}
            entry["texts"] = texts
            entry.update({key: c[key] for key in ("source", "note") if key in c})
            index.append(entry)
        with open(os.path.join(directory, "index.json"), "w") as f:
            json.dump({"format": 1, "components": index}, f, indent=1)
            f.write("\n")

    @classmethod
    def read(cls, directory):
        """An inventory written to `directory`, its texts read back."""
        with open(os.path.join(directory, "index.json")) as f:
            index = json.load(f)
        components = []
        for entry in index["components"]:
            texts = {}
            for path in entry["texts"]:
                with open(os.path.join(directory, path), "rb") as f:
                    texts[os.path.basename(path)] = f.read()
            components.append({**entry, "texts": texts})
        return cls(components)


def digest(*parts):
    """A stamp's digest: this file's bytes, the texts' and `parts`."""
    hashed = hashlib.sha256()
    with open(os.path.abspath(__file__), "rb") as f:
        hashed.update(f.read())
    for directory, _, names in sorted(os.walk(TEXTS)):
        for name in sorted(names):
            with open(os.path.join(directory, name), "rb") as f:
                hashed.update(name.encode() + b"\0" + f.read())
    for part in parts:
        hashed.update(b"\0" + part.encode())
    return hashed.hexdigest()


def current(out, *parts):
    """Whether out/licenses was written from these parts (and this file)."""
    try:
        with open(os.path.join(out, "licenses", "stamp")) as f:
            return f.read() == digest(*parts)
    except OSError:
        return False


def finish(inventory, out, *parts):
    """The inventory into out/licenses, stamped with `parts`."""
    inventory.write(os.path.join(out, "licenses"))
    with open(os.path.join(out, "licenses", "stamp"), "w") as f:
        f.write(digest(*parts))


def cargo(docker, image, mounts, workdir, args, own=(), patched=None):
    """The crates a Rust build links (its normal dependencies, without
    proc macros: those run at build time only), with the Rust standard
    library and wasi-libc. `mounts` maps a host path to the container's
    (/cargo, CARGO_HOME, among them: the registry the build fetched);
    `args` are the build's own (package, features). `own`: the crates that
    are the playground's (the package's own license covers them);
    `patched`: {directory in the container: note} for the crates below it
    that the build patched."""
    with tempfile.TemporaryDirectory() as scratch:
        script = "\n".join([
            f"cargo tree -q --locked --target wasm32-wasip1 {args} "
            "-e normal,no-proc-macro --prefix none -f '{p}' > /licenses/tree.txt",
            "cargo metadata -q --locked --format-version 1 --filter-platform wasm32-wasip1 > /licenses/metadata.json",
            "rustc --version > /licenses/rustc.txt",
            "cp -r \"$(rustc --print sysroot)/share/doc/rust\" /licenses/rust",
            f"chown -R {os.getuid()}:{os.getgid()} /licenses",
        ])
        volumes = [arg for host, there in mounts.items() for arg in ("-v", f"{host}:{there}")]
        subprocess.run(docker + ["run", "--rm", "-e", "CARGO_HOME=/cargo", *volumes,
                                 "-v", f"{scratch}:/licenses", "-w", workdir, image, "sh", "-ec", script],
                       check=True)
        here = lambda path: next((host + path[len(there):] for host, there in mounts.items()
                                  if path == there or path.startswith(there + "/")), None)
        with open(os.path.join(scratch, "metadata.json")) as f:
            metadata = json.load(f)
        by = {(p["name"], p["version"]): p for p in metadata["packages"]}
        inventory = Inventory()
        seen = set()
        with open(os.path.join(scratch, "tree.txt")) as f:
            lines = f.read().splitlines()
        for line in lines:
            words = line.split()
            if len(words) < 2 or not words[1].startswith("v"):
                continue
            key = (words[0], words[1][1:])
            if key in seen or key[0] in own:
                continue
            seen.add(key)
            package = by[key]
            note = next((note for top, note in (patched or {}).items()
                         if package["manifest_path"].startswith(top + "/")), None)
            directory = here(os.path.dirname(package["manifest_path"]))
            texts = {}
            # A workspace's crates keep their license files at its root.
            while directory and not texts:
                texts = license_files(directory)
                root = any(directory == host for host in mounts)
                directory = None if root else os.path.dirname(directory)
            license = package.get("license")
            if not license and package.get("license_file"):
                with open(here(os.path.join(os.path.dirname(package["manifest_path"]),
                                            package["license_file"]))) as f:
                    license = classify(f.read())
            if not license:
                raise SystemExit(f"{key[0]} {key[1]}: no license in its Cargo.toml")
            # Cargo.toml's old "MIT/Apache-2.0" is "MIT OR Apache-2.0".
            license = re.sub(r"\s*/\s*", " OR ", license)
            url = package.get("repository") or f"https://crates.io/crates/{key[0]}"
            inventory.add(key[0], key[1], license, url, texts, note=note)
        with open(os.path.join(scratch, "rustc.txt")) as f:
            rust = f.read().split()[1]
        # Read now: the scratch directory goes.
        docs = os.path.join(scratch, "rust")
        paths = [os.path.join(docs, "COPYRIGHT-library.html"),
                 *(os.path.join(docs, "licenses", name) for name in sorted(os.listdir(os.path.join(docs, "licenses"))))]
        texts = {}
        for path in paths:
            with open(path, "rb") as f:
                texts[os.path.basename(path)] = f.read()
        inventory.add("rust-std", rust, "MIT OR Apache-2.0", "https://github.com/rust-lang/rust", texts,
                      note="Rust's standard library, linked into the module: COPYRIGHT-library.html "
                           "lists what it includes and under which licenses.")
    return inventory.add(*WASI_LIBC)


# wasi-libc, as every wasm32-wasip1 module links it (tools/license-texts).
WASI_LIBC = ("wasi-libc", "2e6fb9d8ee0c",
             "(Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT) AND MIT AND BSD-2-Clause AND BSD-3-Clause",
             "https://github.com/WebAssembly/wasi-libc", wasi_libc(),
             None, "Its musl (MIT), cloudlibc (BSD-2-Clause) and musl-fts (BSD-3-Clause) parts: "
             "musl-COPYRIGHT, cloudlibc-LICENSE, musl-fts-COPYING.")


def wasi_libc_component():
    """wasi-libc, for a C tool built with wasi-sdk."""
    return Inventory().add(*WASI_LIBC)


def go(docker, image, mounts, env, workdir, tags, gomodcache, own):
    """The Go modules a Go build links (the modules of the packages it
    compiles: `go list -deps` with the build's GOOS, GOARCH and tags), with
    Go's standard library and runtime. `env` is the build's environment,
    `gomodcache` the module cache's path in the container, `own` the main
    module's path (the playground's: not listed)."""
    with tempfile.TemporaryDirectory() as scratch:
        listed = "{{with .Module}}{{.Path}} {{.Version}}{{with .Replace}} => {{.Path}} {{.Version}}{{end}}{{end}}"
        script = "\n".join([
            f"go list -deps -tags {tags} -f '{listed}' . | sort -u > /licenses/modules.txt",
            "go env GOVERSION > /licenses/go.txt",
            "cp \"$(go env GOROOT)/LICENSE\" \"$(go env GOROOT)/PATENTS\" /licenses/",
        ])
        volumes = [arg for host, there in mounts.items() for arg in ("-v", f"{host}:{there}")]
        environment = [arg for name, value in env.items() for arg in ("-e", f"{name}={value}")]
        subprocess.run(docker + ["run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp",
                                 *environment, *volumes, "-v", f"{scratch}:/licenses", "-w", workdir, image,
                                 "sh", "-ec", script], check=True)
        cache = next(host + gomodcache[len(there):] for host, there in mounts.items()
                     if gomodcache.startswith(there))
        inventory = Inventory()
        with open(os.path.join(scratch, "modules.txt")) as f:
            lines = f.read().splitlines()
        modules = []
        for line in lines:
            words = line.split()
            # A replaced module's code is its replacement's.
            path, version = (words[3], words[4]) if "=>" in words else (words[0], words[1] if len(words) > 1 else "")
            if path != own:
                modules.append((path, version))
        for path, version in sorted(set(modules)):
            # The module cache's escaping: an upper-case letter is !lower.
            escaped = re.sub(r"[A-Z]", lambda m: "!" + m.group().lower(), path)
            directory = os.path.join(cache, f"{escaped}@{version}")
            texts = license_files(directory)
            found = set()
            for name, file in texts.items():
                with open(file, errors="replace") as f:
                    kind = classify(f.read())
                if kind and not name.upper().startswith(("NOTICE", "PATENTS")):
                    found.add(kind)
            if not found:
                raise SystemExit(f"{path} {version}: no license text tools/licenses.py recognizes "
                                 f"in {directory}")
            license = conjunction(found)
            source = f"https://pkg.go.dev/{path}@{version}" if needs_source(license) else None
            inventory.add(path, version, license, f"https://pkg.go.dev/{path}@{version}", texts, source)
        with open(os.path.join(scratch, "go.txt")) as f:
            version = f.read().strip()
        texts = {}
        for name in ("LICENSE", "PATENTS"):
            with open(os.path.join(scratch, name), "rb") as f:
                texts[name] = f.read()
        inventory.add("go", version, "BSD-3-Clause", "https://go.dev", texts,
                      note="Go's standard library and runtime, linked into the module, and wasm_exec.js.")
    return inventory


def source_bundle(out, files, readme):
    """The corresponding source of a copyleft build into out/source:
    `files` {name: path, a directory too}, and README (`readme`)."""
    source = os.path.join(out, "source")
    shutil.rmtree(source, ignore_errors=True)
    os.makedirs(source)
    for name, path in files.items():
        target = os.path.join(source, name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if os.path.isdir(path):
            shutil.copytree(path, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        else:
            shutil.copy(path, target)
    with open(os.path.join(source, "README.md"), "w") as f:
        f.write(readme)


def wasi_compat():
    """tools/wasi-compat, which every C tool links: the playground's, MIT
    (GPL-2.0's git links it too, which Apache-2.0 would not allow)."""
    directory = os.path.join(ROOT, "tools", "wasi-compat")
    return Inventory().add("wasi-compat", "playground", "MIT",
                           "https://github.com/SteffenDE/run-elixir.dev/tree/main/tools/wasi-compat",
                           license_files(directory),
                           note="The playground's POSIX stubs and wrappers for WASI (tools/wasi-compat/).")


def archive_texts(archive, top, names):
    """License files from a release tarball: {name: bytes}."""
    import tarfile
    texts = {}
    with tarfile.open(archive) as tar:
        for name in names:
            texts[name] = tar.extractfile(f"{top}/{name}").read()
    return texts


def c_tool(out, name, version, license, url, archive, texts, sources, script, extra=()):
    """A C tool's inventory (it, `extra`, wasi-libc and wasi-compat) and,
    for a copyleft one, its corresponding source in out/source: `sources`
    {name: path} (the release, the patches, the build's files), which
    `script` (a path among them) builds."""
    inventory = Inventory()
    copyleft = needs_source(license)
    inventory.add(name, version, license, url, archive_texts(archive, f"{name}-{version}", texts),
                  source="source/" if copyleft else None)
    for other in extra:
        inventory.extend(other)
    inventory.extend(wasi_libc_component()).extend(wasi_compat())
    if copyleft:
        listed = "\n".join(f"- `{name}`" for name in sorted(sources))
        source_bundle(out, sources, f"""# {name} {version}: corresponding source

The source of the WebAssembly build of {name} {version} in this package,
under {license} (its COPYING): what the build is made from, as the
playground's repository has it.

{listed}

The build applies `patches/` to the release, links `wasi-compat/` (MIT)
and wasi-libc, and compiles with the wasi-sdk Docker image its script
names by digest. From a checkout of the playground's repository, with
these files in their places there, `python3 -I {script}` builds it.
""")
    return inventory


def hex_metadata(text):
    """A Hex package's metadata (hex_metadata.config, or a tarball's
    metadata.config): {name, version, licenses, links}."""
    top = lambda key: re.search(rf'^\{{<<"{key}">>,(.*?)\}}\.\s*$', text, re.M | re.S)
    binaries = lambda found: re.findall(r'<<"((?:[^"\\]|\\.)*)">>', found.group(1)) if found else []
    links = binaries(top("links"))
    return {"name": binaries(top("name"))[0], "version": binaries(top("version"))[0],
            "licenses": binaries(top("licenses")), "links": dict(zip(links[::2], links[1::2]))}


def hex_component(directory, metadata, note=None):
    """A Hex package's component: its declared licenses (all of them: Hex
    lists what applies, not a choice) and its license files."""
    license = " AND ".join(f"({name})" if " " in name else name for name in metadata["licenses"])
    if not license:
        raise SystemExit(f"{metadata['name']} {metadata['version']}: its Hex metadata names no license")
    url = next(iter(metadata["links"].values()), f"https://hex.pm/packages/{metadata['name']}")
    return Inventory().add(metadata["name"], metadata["version"], license, url, license_files(directory),
                           note=note)


def fetch_text(url, cache):
    """A file by URL, kept in `cache` (license texts at tags)."""
    import urllib.request
    path = os.path.join(cache, hashlib.sha256(url.encode()).hexdigest()[:16])
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        with urllib.request.urlopen(url) as response:
            data = response.read()
        with open(path + ".part", "wb") as f:
            f.write(data)
        os.rename(path + ".part", path)
    with open(path, "rb") as f:
        return f.read()
