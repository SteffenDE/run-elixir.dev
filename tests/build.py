"""The site build's fs layers and boot images: the same files make the same
bytes, whatever their mtimes and owners here, so a package keeps its
directory's name across builds (runtime/build.py MTIME, header).

    python3 -I tests/build.py
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


def build_module():
    spec = importlib.util.spec_from_file_location("build", ROOT / "runtime" / "build.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = build_module()


def tree(directory, mtime):
    """A few files below `directory`, each with `mtime`: (path in the
    node, path here), as build.py gathers them."""
    directory = Path(directory)
    files = {"lib/app/ebin/a.beam": b"a" * 10, "lib/app/ebin/b.beam": b"b" * 20, "bin/run": b"#!/bin/sh\n"}
    out = []
    for name, data in files.items():
        path = directory / name
        path.mkdir(parents=True, exist_ok=True)
        path.rmdir()
        path.write_bytes(data)
        os.chmod(path, 0o755 if name == "bin/run" else 0o640)
        os.utime(path, (mtime, mtime))
        out.append(("rotp/" + name, str(path)))
    return out


def layer_bytes(fs):
    return {path.relative_to(fs): path.read_bytes() for path in sorted(Path(fs).rglob("*")) if path.is_file()}


class Deterministic(unittest.TestCase):
    def test_layers_and_images_do_not_depend_on_mtimes(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            first = tree(Path(a) / "files", 1_700_000_000)
            second = tree(Path(b) / "files", 1_800_000_000)
            layer_a = build.write_layer(Path(a) / "fs", first)
            layer_b = build.write_layer(Path(b) / "fs", second)
            self.assertEqual(layer_a, layer_b)
            self.assertEqual(layer_bytes(Path(a) / "fs"), layer_bytes(Path(b) / "fs"))
            self.assertEqual(build.tree_digest(Path(a) / "fs"), build.tree_digest(Path(b) / "fs"))
            build.write_image(Path(a) / "boot.tar.gz", first)
            build.write_image(Path(b) / "boot.tar.gz", second)
            self.assertEqual((Path(a) / "boot.tar.gz").read_bytes(), (Path(b) / "boot.tar.gz").read_bytes())

    def test_manifest_has_the_fixed_mtime(self):
        with tempfile.TemporaryDirectory() as a:
            build.write_layer(Path(a) / "fs", tree(Path(a) / "files", 1_700_000_000))
            manifest = json.loads((Path(a) / "fs" / "manifest.json").read_text())
            self.assertEqual({entry[2] for entry in manifest}, {build.MTIME})
            self.assertTrue(build.MTIME > 0)

    def test_layer_version_ignores_mtimes(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            self.assertEqual(build.layer_version(tree(a, 1_700_000_000)), build.layer_version(tree(b, 1_800_000_000)))

    def test_header_keeps_only_the_executable_bit(self):
        import tarfile
        info = tarfile.TarInfo("x")
        info.mode, info.uid, info.gid, info.uname, info.gname, info.mtime = 0o640, 1000, 1000, "me", "us", 5
        build.header(info)
        self.assertEqual((info.mode, info.uid, info.gid, info.uname, info.gname, info.mtime),
                         (0o644, 0, 0, "", "", build.MTIME))
        info.mode = 0o700
        self.assertEqual(build.header(info).mode, 0o755)


if __name__ == "__main__":
    unittest.main()
