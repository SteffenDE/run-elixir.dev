"""The publishing job's versions and staging (runtime/publish.py): the
digest sets the version aside, a changed package gets the next patch, and
a descriptor names the version it is published at.

    python3 -I tests/publish.py
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "runtime"))
spec = importlib.util.spec_from_file_location("publish", ROOT / "runtime" / "publish.py")
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


import build  # noqa: E402

# The site's packages, when a build laid them out (runtime/build.py).
SITE = ROOT / "target" / "site" / "npm" / "@elixir-playground"


def described(name, version, playground):
    """A descriptor as build.py's lay() makes it."""
    return {"name": name, "version": version, "base": f"/npm/{name}@{version}/",
            "files": {"git.wasm": {"size": 4}}, "peerDependencies": {"@elixir-playground/runtime": "^2.0.0"},
            "playground": playground}


def package(directory, version, playground=None, apex=None, builds=False):
    """A descriptor package laid out as build.py does, at `version`: with
    an apex plugin of its own (`apex`, as the elixir package's hex.js), its
    index.js exports it beside the descriptor; `builds`, the elixir
    package's elixir(BUILD) too."""
    os.makedirs(directory)
    manifest = {"name": "@elixir-playground/git", "version": version,
                "playground": playground or {"programs": {"git": {"module": "git.wasm"}}}}
    with open(os.path.join(directory, "package.json"), "w") as f:
        json.dump(manifest, f)
    with open(os.path.join(directory, "git.wasm"), "wb") as f:
        f.write(b"\0asm")
    with open(os.path.join(directory, "index.js"), "w") as f:
        f.write(build.descriptor_module(described(manifest["name"], version, manifest["playground"]), apex,
                                        builds))
    return manifest


def read(path):
    with open(path) as f:
        return f.read()


class Publish(unittest.TestCase):
    def test_versions(self):
        self.assertEqual(publish.next_version("1.0.0", None), "1.0.0")
        self.assertEqual(publish.next_version("1.0.0", "1.0.0"), "1.0.1")
        self.assertEqual(publish.next_version("1.0.0", "1.0.7"), "1.0.8")
        # The repository's minor or major is newer than the registry's.
        self.assertEqual(publish.next_version("1.1.0", "1.0.7"), "1.1.0")
        self.assertEqual(publish.next_version("2.0.0", "1.4.2"), "2.0.0")

    def test_digest_sets_the_version_aside(self):
        with tempfile.TemporaryDirectory() as top:
            publish.STAGE = os.path.join(top, "stage")
            one = package(os.path.join(top, "a"), "1.0.0")
            two = package(os.path.join(top, "b"), "1.0.4")
            _, _, first = publish.stage(one["name"], os.path.join(top, "a"), one)
            _, _, second = publish.stage(two["name"], os.path.join(top, "b"), two)
            self.assertEqual(first, second)
            # Its playground field is part of what it is.
            three = package(os.path.join(top, "c"), "1.0.0", {"programs": {}})
            _, _, third = publish.stage(three["name"], os.path.join(top, "c"), three)
            self.assertNotEqual(first, third)

    def test_a_descriptor_names_its_published_version(self):
        # Each index.js build.py writes: the descriptor alone, and the
        # descriptor beside its plugin. Only the version and base change.
        for apex, builds in ((None, False), ("hex.js", False), ("hex.js", True)):
            with self.subTest(apex=apex, builds=builds), tempfile.TemporaryDirectory() as top:
                publish.STAGE = os.path.join(top, "stage")
                manifest = package(os.path.join(top, "a"), "1.0.0", apex=apex, builds=builds)
                target, staged, _ = publish.stage(manifest["name"], os.path.join(top, "a"), manifest)
                publish.set_version(target, staged, "1.0.3")
                with open(os.path.join(target, "package.json")) as f:
                    self.assertEqual(json.load(f)["version"], "1.0.3")
                text = read(os.path.join(target, "index.js"))
                descriptor, _, _ = publish.descriptor(text)
                self.assertEqual(descriptor["version"], "1.0.3")
                self.assertEqual(descriptor["base"], "/npm/@elixir-playground/git@1.0.3/")
                self.assertEqual(text, build.descriptor_module(
                    described(manifest["name"], "1.0.3", manifest["playground"]), apex, builds))

    def test_the_digest_sets_a_plugin_descriptors_version_aside(self):
        with tempfile.TemporaryDirectory() as top:
            publish.STAGE = os.path.join(top, "stage")
            one = package(os.path.join(top, "a"), "2.0.0", apex="hex.js")
            two = package(os.path.join(top, "b"), "2.0.1", apex="hex.js")
            _, _, first = publish.stage(one["name"], os.path.join(top, "a"), one)
            _, _, second = publish.stage(two["name"], os.path.join(top, "b"), two)
            self.assertEqual(first, second)

    def test_staging_keeps_what_npm_publishes(self):
        # The elixir package's site directory has the layer the site's
        # build made (versions/): not published, and not in the digest.
        with tempfile.TemporaryDirectory() as top:
            publish.STAGE = os.path.join(top, "stage")
            manifest = {**package(os.path.join(top, "a"), "3.0.0", apex="hex.js", builds=True),
                        "files": ["git.wasm", "index.js"]}
            _, _, first = publish.stage(manifest["name"], os.path.join(top, "a"), manifest)
            os.makedirs(os.path.join(top, "a", "versions", "1.20.4-otp-29", "fs"))
            Path(top, "a", "versions", "1.20.4-otp-29", "fs.json").write_text("{}")
            target, _, second = publish.stage(manifest["name"], os.path.join(top, "a"), manifest)
            self.assertEqual(first, second)
            self.assertEqual(sorted(os.listdir(target)), ["git.wasm", "index.js", "package.json"])

    def test_a_descriptor_it_cannot_find_stops_it(self):
        for text in ("export const descriptor = {};\n", "export default [{\"name\": 1}];\n",
                     "export default {\"a\": 1};\nexport default {\"b\": 2};\n", "export default {oops};\n"):
            with self.subTest(text=text), tempfile.TemporaryDirectory() as top:
                manifest = package(os.path.join(top, "a"), "1.0.0")
                with open(os.path.join(top, "a", "index.js"), "w") as f:
                    f.write(text)
                with self.assertRaises(SystemExit):
                    publish.set_version(os.path.join(top, "a"), manifest, "1.0.3")
                self.assertEqual(read(os.path.join(top, "a", "index.js")), text)

    @unittest.skipUnless(SITE.is_dir(), "no site build (python3 -I runtime/build.py)")
    def test_every_laid_descriptor(self):
        # The index.js of each package the last build laid out that has
        # one: the version and base change, nothing else.
        checked = 0
        for entry in sorted(os.listdir(SITE)):
            directory = SITE / entry
            manifest = json.loads(read(directory / "package.json"))
            if "playground" not in manifest or not (directory / "index.js").exists():
                continue
            with self.subTest(package=entry), tempfile.TemporaryDirectory() as top:
                (Path(top) / "index.js").write_text(read(directory / "index.js"))
                before = read(directory / "index.js")
                publish.set_version(top, manifest, "9.9.9")
                after = read(Path(top) / "index.js")
                descriptor, start, end = publish.descriptor(after)
                self.assertEqual((descriptor["version"], descriptor["base"]),
                                 ("9.9.9", f"/npm/{manifest['name']}@9.9.9/"))
                old, old_start, old_end = publish.descriptor(before)
                self.assertEqual((before[:old_start], before[old_end:]), (after[:start], after[end:]))
                self.assertEqual({**old, "version": "9.9.9", "base": descriptor["base"]}, descriptor)
                checked += 1
        self.assertGreater(checked, 0)

    def test_registry_answers(self):
        # npm 11: an object, or the version alone; npm 12: a list of them.
        self.assertEqual(publish.viewed({"version": "1.0.0", "playgroundDigest": "d1"}), ("1.0.0", "d1"))
        self.assertEqual(publish.viewed("1.0.0"), ("1.0.0", None))
        self.assertEqual(publish.viewed([{"version": "1.0.0", "playgroundDigest": "d1"}]), ("1.0.0", "d1"))
        self.assertEqual(publish.viewed(["1.0.0"]), ("1.0.0", None))
        self.assertEqual(publish.viewed([]), (None, None))

    def test_dependencies_first(self):
        packages = {
            "@elixir-playground/standard": (None, {"dependencies": {"@elixir-playground/shell": "^1.0.0"}}),
            "@elixir-playground/shell": (None, {"peerDependencies": {"@elixir-playground/runtime": "^1.0.0"}}),
            "@elixir-playground/runtime": (None, {}),
        }
        self.assertEqual(publish.order(packages), [
            "@elixir-playground/runtime", "@elixir-playground/shell", "@elixir-playground/standard"])


if __name__ == "__main__":
    unittest.main()
