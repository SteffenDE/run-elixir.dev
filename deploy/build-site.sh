#!/bin/bash
# The site from this checkout, as a deploy builds it (deploy.md): the
# WebAssembly tools, then the site into target/site, with the Emscripten BEAM
# (beam/build.sh, emsdk at ~/emsdk) and the host's Erlang and Elixir
# (mise's, the versions the BEAM is built from). PLAYGROUND_DOMAIN names
# the apex, PLAYGROUND_USERCONTENT the usercontent domain (frames.md).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
if command -v mise >/dev/null 2>&1; then
  PATH="$(dirname "$(mise which erl)"):$(dirname "$(mise which elixir)"):$PATH"
fi
python3 -I tools/coreutils/build.py
python3 -I brush/build.py
python3 -I tailscale/build.py
python3 -I tools/ripgrep/build.py
python3 -I tls/build.py
python3 -I tools/git/build.py
python3 -I tools/sed/build.py
python3 -I tools/grep/build.py
python3 -I tools/diffutils/build.py
python3 -I tools/gawk/build.py
python3 -I tools/findutils/build.py
python3 -I runtime/build.py
