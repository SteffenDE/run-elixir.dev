"""Publish the site's packages to npm (docs/packages.md, Publishing):

    python3 -I runtime/publish.py             # what it would publish
    python3 -I runtime/publish.py --publish   # publish (npm's credentials)
    python3 -I runtime/publish.py --publish --provenance   # in CI (site.yml)

It reads the packages a build laid out (target/site/npm/@elixir-playground/
NAME@VERSION+ID/, runtime/build.py) and leaves out the playground's own
("private": phoenix-template, tailscale). For each, in dependency order:

- its digest: the package's files with its version set aside (package.json
  and a descriptor's index.js name it), so the same files make the same
  digest whatever version they are published at;
- the registry's latest version, and the digest that version recorded
  (package.json's playgroundDigest);
- unpublished: its own version (the repository's, 1.0.0); the same digest:
  nothing; another: the next patch after the latest, or the repository's
  version if its major or minor is newer.

Each one to publish is staged in target/publish/NAME/ with that version (in
package.json, and in a descriptor's index.js, whose base names it too) and
published from there with `npm publish --access public`. Its dependencies
name ranges of majors (^1.0.0), so a patch of one needs no new version of
another.
"""
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "target", "site", "npm", "@elixir-playground")
STAGE = os.path.join(ROOT, "target", "publish")
SCOPE = "@elixir-playground"
# Set aside while digesting: no published version is this one.
PLACEHOLDER = "0.0.0-digest"
DESCRIPTOR = re.compile(r"^(.*?export default )(\{.*\})(;\s*)$", re.S)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build import tree_digest  # noqa: E402


def laid():
    """The site's packages to publish, by name: their directories."""
    out = {}
    for entry in sorted(os.listdir(SITE)):
        directory = os.path.join(SITE, entry)
        with open(os.path.join(directory, "package.json")) as f:
            package = json.load(f)
        if not package.get("private"):
            out[package["name"]] = (directory, package)
    return out


def order(packages):
    """Dependencies first: a package after those it depends or peer-depends on."""
    done, out = set(), []

    def visit(name):
        if name in done or name not in packages:
            return
        done.add(name)
        package = packages[name][1]
        for dependency in {**package.get("dependencies", {}), **package.get("peerDependencies", {})}:
            visit(dependency)
        out.append(name)

    for name in sorted(packages):
        visit(name)
    return out


def set_version(directory, package, version):
    """The staged package at `version`: package.json, and a descriptor's
    index.js (its version and base)."""
    with open(os.path.join(directory, "package.json"), "w") as f:
        json.dump({**package, "version": version}, f, indent=2)
        f.write("\n")
    index = os.path.join(directory, "index.js")
    if "playground" not in package or not os.path.exists(index):
        return
    with open(index) as f:
        text = f.read()
    found = DESCRIPTOR.match(text)
    if not found:
        return
    descriptor = json.loads(found.group(2))
    descriptor["version"] = version
    descriptor["base"] = f"/npm/{package['name']}@{version}/"
    with open(index, "w") as f:
        f.write(found.group(1) + json.dumps(descriptor, indent=1) + found.group(3))


def stage(name, directory, package):
    """A copy of the package to publish from, and its digest."""
    target = os.path.join(STAGE, name.split("/")[1])
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(directory, target)
    package = {key: value for key, value in package.items() if key != "playgroundDigest"}
    set_version(target, package, PLACEHOLDER)
    return target, package, tree_digest(target)


def registry(name):
    """The registry's latest version of `name` and the digest it recorded,
    or (None, None) when it has none."""
    found = subprocess.run(["npm", "view", f"{name}@latest", "version", "playgroundDigest", "--json"],
                           capture_output=True, text=True)
    if found.returncode != 0:
        if "E404" in found.stderr or "404" in found.stderr:
            return None, None
        sys.exit(f"npm view {name}: {found.stderr.strip()}")
    return viewed(json.loads(found.stdout or "{}"))


def viewed(data):
    """`npm view NAME@latest version playgroundDigest --json`'s answer:
    npm 11 gives the fields as an object (or the version alone, when the
    digest is missing), npm 12 a list of them, one per version matched."""
    if isinstance(data, list):
        data = data[-1] if data else {}
    if isinstance(data, str):
        return data, None
    return data.get("version"), data.get("playgroundDigest")


def parse(version):
    return tuple(int(part) for part in version.split("-")[0].split(".")[:3])


def next_version(ours, latest):
    """The version to publish at: ours unless the registry has it or a newer
    one of the same major and minor, then the next patch after the latest."""
    if latest is None or parse(ours)[:2] > parse(latest)[:2]:
        return ours
    major, minor, patch = parse(latest)
    return f"{major}.{minor}.{patch + 1}"


def main():
    publish = "--publish" in sys.argv[1:]
    # npm's provenance statement, from CI's OIDC token (trusted publishing).
    provenance = ["--provenance"] if "--provenance" in sys.argv[1:] else []
    packages = laid()
    plan = []
    for name in order(packages):
        directory, package = packages[name]
        target, package, digest = stage(name, directory, package)
        latest, recorded = registry(name)
        if recorded == digest:
            print(f"{name}: {latest}, unchanged")
            shutil.rmtree(target)
            continue
        version = next_version(package["version"], latest)
        set_version(target, {**package, "playgroundDigest": digest}, version)
        plan.append((name, version, target))
        print(f"{name}: {latest or 'unpublished'} → {version} ({digest})")
    if not publish:
        print(f"{len(plan)} to publish; staged in {STAGE} (--publish to publish them)")
        return
    for name, version, target in plan:
        subprocess.run(["npm", "publish", "--access", "public", *provenance], cwd=target, check=True)
        print(f"{name}@{version}: published")


if __name__ == "__main__":
    main()
