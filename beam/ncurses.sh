#!/bin/bash
# ncurses' terminfo library (libtinfo) for the Emscripten BEAM's terminal:
# prim_tty takes raw input, which IEx's line editing needs, only with
# termcap. The terminals' descriptions are compiled in (--with-fallbacks),
# so the node needs no terminfo database.
#
# Usage: playground/beam/ncurses.sh [-j N]
# Installs into out/beam-wasm/ncurses (include/, lib/libtinfo.a).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
VERSION="${NCURSES_VERSION:-6.5}"
SRC="${ROOT}/out/beam-wasm/ncurses-${VERSION}"
PREFIX="${ROOT}/out/beam-wasm/ncurses"
JOBS="$(nproc)"
[[ "${1:-}" == -j ]] && JOBS="$2"

log() { echo "ncurses | $*" >&2; }

if [[ -f "${PREFIX}/lib/libtinfo.a" ]]; then
    log "installed in ${PREFIX}"
    exit 0
fi
if ! command -v emconfigure >/dev/null; then
    # shellcheck source=/dev/null
    EMSDK_QUIET=1 source "${HOME}/emsdk/emsdk_env.sh"
fi
if [[ ! -d "${SRC}" ]]; then
    log "downloading ncurses ${VERSION}"
    mkdir -p "${SRC}"
    curl -sSfL "https://invisible-island.net/archives/ncurses/ncurses-${VERSION}.tar.gz" \
        | tar xz -C "${SRC}" --strip-components=1
fi
log "configuring"
(
    cd "${SRC}"
    CFLAGS="-O2 -pthread" emconfigure ./configure --host=wasm32-unknown-emscripten \
        --build="$(./config.guess)" --prefix="${PREFIX}" \
        --without-shared --without-cxx --without-cxx-binding --without-ada \
        --without-progs --without-tests --without-manpages --without-debug \
        --disable-database --with-termlib \
        --with-fallbacks=xterm-256color,xterm,vt100,dumb --enable-widec=no \
        --with-build-cc=gcc
) >"${ROOT}/out/beam-wasm/ncurses.log" 2>&1 || { tail -30 "${ROOT}/out/beam-wasm/ncurses.log"; exit 1; }
log "building"
(cd "${SRC}" && emmake make -j"${JOBS}" libs && emmake make install.libs install.includes) \
    >>"${ROOT}/out/beam-wasm/ncurses.log" 2>&1 \
    || { tail -30 "${ROOT}/out/beam-wasm/ncurses.log"; exit 1; }
log "installed in ${PREFIX}"
