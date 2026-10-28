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


if __name__ == "__main__":
    unittest.main()
