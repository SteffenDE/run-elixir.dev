"""GNU awk (gawk) built to WebAssembly (wasm32-wasip1): the shell's awk,
and git's scripts' (docs/tools.md).

    python3 -I tools/gawk/build.py   # → target/gawk/gawk.wasm

gawk's release with patches/ applied, built with wasi-sdk in Docker over
tools/wasi-compat/ (tools/wasi-compat/autoconf.py, as sed's is). Without fork, its
pipes (`cmd | getline`, `print | cmd`), coprocesses (`|&`) and system()
start sh -c through wasi_spawn: a process of the playground's host's (the
`processes` imports, packages/runtime/src/processes.ts). Without dynamic
extensions (WASI has no dlopen), MPFR (-M) or the persistent memory
allocator. config.site answers what configure cannot learn here.
"""

import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GAWK = ("5.4.1", "https://ftp.gnu.org/gnu/gawk/gawk-5.4.1.tar.xz",
        "07f6f7342b7febe4313fc2c2542ad93d64fe20ad8717200109f105a826f5fd37")


def main():
    path = os.path.join(os.path.dirname(HERE), "wasi-compat", "autoconf.py")
    spec = importlib.util.spec_from_file_location("autoconf", path)
    autoconf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(autoconf)
    autoconf.build(HERE, "gawk", GAWK, {"gawk": "gawk"},
                   ["--disable-extensions", "--disable-mpfr", "--disable-pma", "--without-readline"])


if __name__ == "__main__":
    main()
