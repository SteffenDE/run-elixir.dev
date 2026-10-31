"""Release preparation, without SSH, rsync or a live server.

    python3 -I tests/deploy.py
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class Prepare(unittest.TestCase):
    def test_missing_seeds_and_existing_package_seeds(self):
        for legacy in (True, False):
            with self.subTest(legacy=legacy), tempfile.TemporaryDirectory() as directory:
                site = Path(directory)
                release = site / "releases/20261027T000000Z-aaaaaaa"
                release.mkdir(parents=True)
                (site / "current").symlink_to(release.relative_to(site))
                if legacy:
                    (release / "b/1234").mkdir(parents=True)
                else:
                    package = release / "npm/@elixir-playground/git@1.0.0+aaaa"
                    package.mkdir(parents=True)
                    (package / "git.wasm").write_bytes(b"old git")
                    (release / "boot/aaaaaaaaaaaa").mkdir(parents=True)
                result = subprocess.run([
                    "bash", str(ROOT / "deploy/server/playground-deploy"), "prepare",
                    "20261028T000000Z-bbbbbbb", "npm/@elixir-playground/otp-29.1.3@1.0.0+bbbb",
                    "npm/@elixir-playground/git@1.0.0+bbbb", "boot/bbbbbbbbbbbb",
                ], env={**os.environ, "SITE": directory,
                        "PLAYGROUND_DEPLOY_CONFIG": str(site / "no-config"),
                        "SSH_ORIGINAL_COMMAND": ""}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                if not legacy:
                    seeded = site / "releases/20261028T000000Z-bbbbbbb.partial/npm/@elixir-playground/git@1.0.0+bbbb/git.wasm"
                    self.assertEqual(seeded.read_bytes(), b"old git")
                    self.assertEqual(seeded.stat().st_ino, (package / "git.wasm").stat().st_ino)


class Activate(unittest.TestCase):
    def release(self, site, rid, bridge):
        """An uploaded release (RID.partial) with what activate checks, its
        _usercontent/bridge.json naming `bridge`."""
        partial = site / f"releases/{rid}.partial"
        runtime = partial / "npm/@elixir-playground/runtime@1.2.0+aaaa"
        runtime.mkdir(parents=True)
        for name in ("worker.js", "exec.html"):
            (runtime / name).write_text("x")
        (partial / "site").mkdir()
        (partial / "site/aaaa.json").write_text("{}")
        (partial / "index.html").write_text(
            '<meta name="playground-runtime" content="/npm/@elixir-playground/runtime@1.2.0+aaaa/">'
            '<meta name="playground-site" content="/site/aaaa.json">\n')
        for name in ("preview.html", "storage.html", "licenses/index.html"):
            (partial / name).parent.mkdir(parents=True, exist_ok=True)
            (partial / name).write_text("x")
        (partial / "playground.json").write_text(
            '{"domain": "run-elixir.dev", "usercontent": "run-elixir-usercontent.org"}')
        (partial / "_usercontent").mkdir()
        for name in ("bridge.html", "sw.js"):
            (partial / "_usercontent" / name).write_text("x")
        (partial / "_usercontent/bridge.json").write_text(f'{{"bridge": "{bridge}"}}')

    def activate(self, directory, rid):
        return subprocess.run(
            ["bash", str(ROOT / "deploy/server/playground-deploy"), "activate", rid],
            env={**os.environ, "SITE": directory, "DOMAIN": "run-elixir.dev",
                 "USERCONTENT": "run-elixir-usercontent.org", "CHECK_RESOLVE": "",
                 "PLAYGROUND_DEPLOY_CONFIG": str(Path(directory) / "no-config"),
                 "SSH_ORIGINAL_COMMAND": ""}, capture_output=True, text=True)

    def test_the_usercontent_domains_files_name_it(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            self.release(site, "20261030T000000Z-aaaaaaa", "other.example")
            result = self.activate(directory, "20261030T000000Z-aaaaaaa")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("_usercontent/bridge.json does not name run-elixir-usercontent.org",
                          result.stderr)
            self.release(site, "20261030T000001Z-bbbbbbb", "run-elixir-usercontent.org")
            result = self.activate(directory, "20261030T000001Z-bbbbbbb")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((site / "current/_usercontent/bridge.html").exists())


if __name__ == "__main__":
    unittest.main()
