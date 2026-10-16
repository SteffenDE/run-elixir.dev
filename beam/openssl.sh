#!/bin/bash
# OpenSSL for the Emscripten BEAM's crypto (static, no assembly), as
# Popcorn's scripts/build-openssl.sh configures it (README.md).
#
# Usage: playground/beam/openssl.sh [-j N]
# Installs into out/beam-wasm/openssl (include/, lib/libcrypto.a).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
TAG="${OPENSSL_TAG:-3.0.15}"
SRC="${ROOT}/out/beam-wasm/openssl-${TAG}"
PREFIX="${ROOT}/out/beam-wasm/openssl"
JOBS="$(nproc)"
[[ "${1:-}" == -j ]] && JOBS="$2"

log() { echo "openssl | $*" >&2; }

if [[ -f "${PREFIX}/lib/libcrypto.a" ]]; then
    log "installed in ${PREFIX}"
    exit 0
fi
if ! command -v emconfigure >/dev/null; then
    # shellcheck source=/dev/null
    EMSDK_QUIET=1 source "${HOME}/emsdk/emsdk_env.sh"
fi
if [[ ! -d "${SRC}" ]]; then
    log "cloning OpenSSL ${TAG}"
    git clone --quiet --depth 1 --branch "openssl-${TAG}" \
        https://github.com/openssl/openssl.git "${SRC}"
fi
log "configuring"
(
    cd "${SRC}"
    CC=emcc AR=emar RANLIB=emranlib CFLAGS="-O2 -pthread" ./Configure linux-generic32 \
        no-shared no-dso no-module no-asm no-afalgeng no-devcryptoeng no-tests \
        no-cms no-ct no-ocsp no-ts no-sock no-dgram no-srtp no-comp no-cast \
        no-idea no-seed no-camellia no-whirlpool no-siphash no-ec2m \
        no-ui-console no-sm2 no-sm3 no-sm4 no-blake2 no-bf no-rc2 no-rc4 \
        no-rmd160 no-md4 no-engine no-srp no-dsa no-legacy \
        --prefix="${PREFIX}" --openssldir="${PREFIX}/ssl"
) >"${ROOT}/out/beam-wasm/openssl.log" 2>&1
log "building"
(cd "${SRC}" && emmake make build_libs -j"${JOBS}" && emmake make install_dev) \
    >>"${ROOT}/out/beam-wasm/openssl.log" 2>&1 \
    || { tail -30 "${ROOT}/out/beam-wasm/openssl.log"; exit 1; }
log "installed in ${PREFIX}"
