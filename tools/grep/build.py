"""GNU grep built to WebAssembly (wasm32-wasip1): the shell's grep, and
git's scripts' (docs/tools.md).

    python3 -I tools/grep/build.py   # → target/grep/grep.wasm

grep's release built with wasi-sdk in Docker over tools/wasi-compat/
(tools/wasi-compat/autoconf.py, as sed's is). Without -P (PCRE2, a library of
its own: not yet); -r walks with gnulib's fts from descriptors (openat),
as WASI has them. config.site answers what configure cannot learn here.
"""

import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GREP = ("3.12", "https://ftp.gnu.org/gnu/grep/grep-3.12.tar.xz",
        "2649b27c0e90e632eadcd757be06c6e9a4f48d941de51e7c0f83ff76408a07b9")


def main():
    path = os.path.join(os.path.dirname(HERE), "wasi-compat", "autoconf.py")
    spec = importlib.util.spec_from_file_location("autoconf", path)
    autoconf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(autoconf)
    autoconf.build(HERE, "grep", GREP, {"grep": "src/grep"}, ["--disable-perl-regexp"])


if __name__ == "__main__":
    main()
