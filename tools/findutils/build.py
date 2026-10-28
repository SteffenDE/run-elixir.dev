"""GNU findutils' find built to WebAssembly (wasm32-wasip1): the shell's
find (docs/tools.md). Its xargs is not taken: the shell's is
packages/runtime/src/utilities.ts's; nor locate.

    python3 -I tools/findutils/build.py   # → target/findutils/find.wasm

findutils' release with patches/ applied, built with wasi-sdk in Docker
over tools/wasi-compat/ (tools/wasi-compat/autoconf.py, as sed's is). It walks with
gnulib's fts from descriptors (FTS_CWDFD: find never changes directory);
-exec and -execdir spawn instead of forking (patches/0001-wasi-exec.patch:
wasi_spawn, a process of the playground's host's, in the directory the
command is for). config.site answers what configure cannot learn here.
"""

import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FINDUTILS = ("4.11.0", "https://ftp.gnu.org/gnu/findutils/findutils-4.11.0.tar.xz",
             "bfd19cb06cc71f3352d567e90284d8cdac02ac89774bbeadf0b533b0c11432fd")


def main():
    path = os.path.join(os.path.dirname(HERE), "wasi-compat", "autoconf.py")
    spec = importlib.util.spec_from_file_location("autoconf", path)
    autoconf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(autoconf)
    autoconf.build(HERE, "findutils", FINDUTILS, {"find": "find/find"}, ["--without-selinux"])


if __name__ == "__main__":
    main()
