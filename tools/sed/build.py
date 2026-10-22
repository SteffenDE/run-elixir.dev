"""GNU sed built to WebAssembly (wasm32-wasip1): the shell's sed, and
git's scripts' (docs/tools.md).

    python3 -I tools/sed/build.py   # → target/sed/sed.wasm

sed's release built with wasi-sdk in Docker over tools/wasi-compat/
(tools/wasi-compat/autoconf.py, as grep's and diffutils' are). Its `e` command
and `s///e` run sh -c through popen: stubs.c's, a process of the
playground's host's (the `processes` imports,
app/src/runtime/processes.ts). Without ACLs or SELinux (WASI has
neither); config.site answers what configure cannot learn here.
"""

import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SED = ("4.10", "https://ftp.gnu.org/gnu/sed/sed-4.10.tar.xz",
       "b8e72182b2ec96a3574e2998c47b7aaa64cc20ce000d8e9ac313cc07cecf28c7")


def main():
    path = os.path.join(os.path.dirname(HERE), "wasi-compat", "autoconf.py")
    spec = importlib.util.spec_from_file_location("autoconf", path)
    autoconf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(autoconf)
    autoconf.build(HERE, "sed", SED, {"sed": "sed/sed"}, ["--disable-acl", "--without-selinux"])


if __name__ == "__main__":
    main()
