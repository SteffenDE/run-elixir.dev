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


def package(directory, version, playground=None):
    """A descriptor package laid out as build.py does, at `version`."""
    os.makedirs(directory)
    manifest = {"name": "@elixir-playground/git", "version": version,
                "playground": playground or {"programs": {"git": {"module": "git.wasm"}}}}
    with open(os.path.join(directory, "package.json"), "w") as f:
        json.dump(manifest, f)
    with open(os.path.join(directory, "git.wasm"), "wb") as f:
        f.write(b"\0asm")
    descriptor = {"name": manifest["name"], "version": version,
                  "base": f"/npm/@elixir-playground/git@{version}/", "playground": manifest["playground"]}
    with open(os.path.join(directory, "index.js"), "w") as f:
        f.write(f"// The package.\nexport default {json.dumps(descriptor, indent=1)};\n")
    return manifest


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
        with tempfile.TemporaryDirectory() as top:
            publish.STAGE = os.path.join(top, "stage")
            manifest = package(os.path.join(top, "a"), "1.0.0")
            target, staged, _ = publish.stage(manifest["name"], os.path.join(top, "a"), manifest)
            publish.set_version(target, staged, "1.0.3")
            with open(os.path.join(target, "package.json")) as f:
                self.assertEqual(json.load(f)["version"], "1.0.3")
            with open(os.path.join(target, "index.js")) as f:
                text = f.read()
            descriptor = json.loads(publish.DESCRIPTOR.match(text).group(2))
            self.assertEqual(descriptor["version"], "1.0.3")
            self.assertEqual(descriptor["base"], "/npm/@elixir-playground/git@1.0.3/")
            self.assertTrue(text.startswith("// The package.\nexport default {"))

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
