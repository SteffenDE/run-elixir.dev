"""Release preparation, without SSH, rsync or a live server.

    python3 -I tests/deploy.py
"""
import os
from pathlib import Path
import subprocess
import sys
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

    def activate(self, directory, rid, **env):
        return subprocess.run(
            ["bash", str(ROOT / "deploy/server/playground-deploy"), "activate", rid],
            env={**os.environ, "SITE": directory, "DOMAIN": "run-elixir.dev",
                 "USERCONTENT": "run-elixir-usercontent.org", "CHECK_RESOLVE": "",
                 "PLAYGROUND_DEPLOY_CONFIG": str(Path(directory) / "no-config"),
                 "SSH_ORIGINAL_COMMAND": "", **env}, capture_output=True, text=True)

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

    def test_health_check_keeps_page_and_package_cache_policies_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            rid = "20261030T000000Z-aaaaaaa"
            self.release(site, rid, "run-elixir-usercontent.org")
            # A healthy server: immutable package files, revalidated pages.
            # Substitute curl so activation checks every endpoint without TLS
            # setup or a production server.
            bin_dir = site / "bin"
            bin_dir.mkdir()
            curl = bin_dir / "curl"
            curl.write_text(f"#!{sys.executable}\n" + r'''
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit
args = sys.argv[1:]
url = urlsplit(args[-1])
path = url.path
root = Path(os.environ["SITE"]) / "current"
if url.hostname.endswith(".run-elixir-usercontent.org"):
    root /= "_usercontent"
file = root / path.lstrip("/")
if file.is_dir():
    file /= "index.html"
exists = file.is_file() and not path.startswith("/_usercontent/")
if "-w" in args:
    value = args[args.index("-w") + 1]
    print(value.replace("%{http_code}", "200" if exists else "404")
          .replace("%{content_type}", "application/wasm"), end="")
if "-D" in args:
    cache = "immutable" if path.startswith(("/npm/", "/site/")) else os.environ["PAGE_CACHE"]
    print("Cache-Control: " + cache)
    print("Cross-Origin-Opener-Policy: same-origin")
    print("Cross-Origin-Embedder-Policy: require-corp")
    print("Cross-Origin-Resource-Policy: cross-origin")
    print("Access-Control-Allow-Origin: *")
    print("Content-Security-Policy: frame-ancestors 'self'")
if "-o" in args:
    output = args[args.index("-o") + 1]
    if output != "/dev/null":
        Path(output).write_bytes(file.read_bytes())
elif exists:
    sys.stdout.flush()
    sys.stdout.buffer.write(file.read_bytes())
''')
            curl.chmod(0o755)
            partial = site / f"releases/{rid}.partial"
            (partial / "site/aaaa.json").write_text(
                '{"base": "../npm/@elixir-playground/otp-29@1.0.0/"}\n')
            beam = partial / "npm/@elixir-playground/otp-29@1.0.0/beam.wasm"
            beam.parent.mkdir(parents=True)
            beam.write_bytes(b"wasm")
            (partial / "licenses/index.html").write_text("<title>Licenses</title>")
            env = {"PATH": f"{bin_dir}:{os.environ['PATH']}", "CHECK_RESOLVE": "127.0.0.1"}
            # A page accidentally served immutable must still be rejected.
            result = self.activate(directory, rid, **env, PAGE_CACHE="immutable")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("check: / is not no-cache", result.stderr)
            (site / f"releases/{rid}").rename(partial)
            result = self.activate(directory, rid, **env, PAGE_CACHE="no-cache")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((site / "current").exists())


if __name__ == "__main__":
    unittest.main()
