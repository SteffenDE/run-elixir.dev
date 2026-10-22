"""GNU diffutils built to WebAssembly (wasm32-wasip1): diff, cmp, diff3
and sdiff for the shell, and git's tests' test_cmp (docs/tools.md).

    python3 -I diffutils/build.py   # → target/diffutils/{diff,cmp,diff3,sdiff}.wasm

diffutils' release built with wasi-sdk in Docker over wasi-compat/
(wasi-compat/autoconf.py, as sed's is). Without fork, diff3 runs diff,
sdiff its editor and diff --paginate pr through popen and system:
stubs.c's, sh -c as a process of the playground's host's.
config.site answers what configure cannot learn here.
"""

import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DIFFUTILS = ("3.12", "https://ftp.gnu.org/gnu/diffutils/diffutils-3.12.tar.xz",
             "7c8b7f9fc8609141fdea9cece85249d308624391ff61dedaf528fcb337727dfd")


def main():
    path = os.path.join(os.path.dirname(HERE), "wasi-compat", "autoconf.py")
    spec = importlib.util.spec_from_file_location("autoconf", path)
    autoconf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(autoconf)
    autoconf.build(HERE, "diffutils", DIFFUTILS,
                   {name: f"src/{name}" for name in ("diff", "cmp", "diff3", "sdiff")})


if __name__ == "__main__":
    main()
