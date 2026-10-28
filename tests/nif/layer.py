"""The erl_nif layer from a node: layer.c's library (tests/nif/build.py
builds it with the backend's toolchain), loaded and called by layer.exs in
the Node harness (src/runtime/node.ts, which runtime/build.py bundles) over
the built site.

    python3 -I runtime/build.py && python3 -I tests/nif/build.py
    python3 -I tests/nif/layer.py
"""

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SITE = os.path.join(ROOT, "target", "site")
HARNESS = os.path.join(ROOT, "target", "node")
BUILT = os.path.join(ROOT, "target", "test-nif")
DOCKER = os.environ.get("DOCKER", "sudo -n docker").split()

EXPECTED = """resource: {true, true}
bump: %{max: 18446744073709551615, n: 42}
bump: %{max: 18446744073709551615, n: 43}
message: {:bumped, 42}
echo: true
badarg: %ArgumentError{message: "argument error"}
not a counter: %ArgumentError{message: "argument error"}
touch: :ok
advise: 0
extras: {42, 1, 7, true, true, ~c"hello WASI!", 11, 100, 0, true}
"""


def main():
    with tempfile.TemporaryDirectory() as work:
        shutil.copy(os.path.join(BUILT, "layer.so"), work)
        shutil.copy(os.path.join(HERE, "layer.exs"), work)
        result = subprocess.run(DOCKER + ["run", "--rm", "-i", "-e", "CWD=/work/layer", "-e", "MOUNT=/work/layer:/layer",
                                          "-e", "BOOT=boot", "-v", f"{work}:/layer:ro",
                                          "-v", f"{HARNESS}:/w:ro",
                                          "-v", f"{SITE}:/d:ro", "node:24", "node", "/w/node.mjs", "/d", "-noshell",
                                          "-elixir_root", "/rotp/lib", "-pa", "/rotp/lib/elixir/ebin", "-user", "elixir",
                                          "-extra", "/work/layer/layer.exs"],
                                stdin=subprocess.DEVNULL, capture_output=True, text=True)
    output = "".join(line + "\n" for line in result.stdout.splitlines() if ": " in line and not line.startswith("["))
    if result.returncode != 0 or output != EXPECTED:
        sys.exit(f"failed (status {result.returncode}):\n{result.stdout}{result.stderr}")
    print("erl_nif layer: ok")


if __name__ == "__main__":
    main()
