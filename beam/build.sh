#!/bin/bash
# Build the real BEAM (OTP's erts) for wasm32-emscripten with Popcorn's
# patch stack (see README.md).
#
# Usage: playground/beam/build.sh [debug|release] [-j N]
#
# Sources and build output live under out/beam-wasm:
#   otp/        patched OTP checkout (git, one commit per patch)
#   dist/       beam.wasm, beam.mjs, beam.emu.mjs
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
OTP_TAG="${OTP_TAG:-OTP-29.1.1}"
WORK="${ROOT}/out/beam-wasm"
OTP_DIR="${WORK}/otp"
DIST="${WORK}/dist"
MODE=debug
JOBS="$(nproc)"

while [[ $# -gt 0 ]]; do
    case "$1" in
        debug|release) MODE="$1"; shift ;;
        -j) JOBS="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

log() { echo "beam-wasm | $*" >&2; }

if ! command -v emconfigure >/dev/null; then
    if [[ -f "${HOME}/emsdk/emsdk_env.sh" ]]; then
        # shellcheck source=/dev/null
        EMSDK_QUIET=1 source "${HOME}/emsdk/emsdk_env.sh"
    else
        echo "emscripten not found (expected ~/emsdk)" >&2
        exit 1
    fi
fi

GIT=(git -C "${OTP_DIR}" -c user.name=beam-wasm -c user.email=beam-wasm@localhost)

checkout_and_patch() {
    if [[ -d "${OTP_DIR}/.git" ]]; then
        local want have
        want=$(cat "${HERE}"/patches/*.patch | git hash-object --stdin)
        have=$(cat "${OTP_DIR}/.stamp-patched" 2>/dev/null || true)
        if [[ "${want}" == "${have}" ]]; then
            log "patches up to date"
            return
        fi
        log "patches changed; recreate ${OTP_DIR}"
        rm -rf "${OTP_DIR}"
    fi
    mkdir -p "${WORK}"
    if [[ -n "${OTP_SOURCE:-}" ]]; then
        log "cloning ${OTP_SOURCE} at ${OTP_TAG}"
        git clone --quiet --branch "${OTP_TAG}" "${OTP_SOURCE}" "${OTP_DIR}"
    else
        log "cloning OTP ${OTP_TAG}"
        git clone --quiet --depth 1 --branch "${OTP_TAG}" \
            https://github.com/erlang/otp.git "${OTP_DIR}"
    fi
    for patch in "${HERE}"/patches/*.patch; do
        log "applying $(basename "${patch}")"
        git -C "${OTP_DIR}" apply --index "${patch}"
        "${GIT[@]}" commit --quiet -m "beam-wasm: $(basename "${patch}" .patch)"
    done
    cat "${HERE}"/patches/*.patch | git hash-object --stdin > "${OTP_DIR}/.stamp-patched"
}

autoconf_once() {
    [[ -f "${OTP_DIR}/.stamp-autoconf" ]] && return
    log "regenerating configure scripts"
    (cd "${OTP_DIR}" && ./otp_build update_configure --no-commit >/dev/null)
    touch "${OTP_DIR}/.stamp-autoconf"
}

# The native bootstrap embeds erts/preloaded/ebin/*.beam, including the
# patch stack's new wasm and erl_init modules, so compile those first with
# the host erlc, then again with the bootstrap's.
compile_preloaded() {
    local erlc="$1"
    for module in wasm erl_init prim_inet; do
        "${erlc}" +deterministic \
            -I "${OTP_DIR}/lib/kernel/src" -I "${OTP_DIR}/lib/kernel/include" \
            -o "${OTP_DIR}/erts/preloaded/ebin" \
            "${OTP_DIR}/erts/preloaded/src/${module}.erl"
    done
}

bootstrap() {
    [[ -x "${OTP_DIR}/bootstrap/bin/erlc" ]] && return
    compile_preloaded "$(command -v erlc)"
    log "building native bootstrap"
    (cd "${OTP_DIR}" && ./configure --enable-bootstrap-only >/dev/null && make -j"${JOBS}" >/dev/null)
    compile_preloaded "${OTP_DIR}/bootstrap/bin/erlc"
}

configure_wasm() {
    local stamp="${OTP_DIR}/.stamp-configure-${MODE}"
    [[ -f "${stamp}" ]] && return
    rm -f "${OTP_DIR}"/.stamp-configure-*
    log "configuring for emscripten (${MODE})"
    if [[ "${MODE}" == debug ]]; then
        export CFLAGS="-O0 -g -pthread"
    else
        export CFLAGS="-Os -flto -pthread"
    fi
    export LDFLAGS="-pthread -flto"
    export ac_cv_func_pthread_create=yes ac_cv_header_pthread_h=yes
    export ac_cv_sizeof_short=2 ac_cv_sizeof_int=4 ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8 ac_cv_sizeof_void_p=4 ac_cv_c_bigendian=no
    local without=(common_test diameter edoc eldap eunit ftp jinterface reltool
        snmp tftp tools termcap wx debugger dialyzer et megaco observer odbc
        os_mon parsetools ssh mnesia xmerl runtime_tools crypto asn1 ssl javac
        threadnames dynamic-trace)
    local args=(--host=wasm32-unknown-emscripten
        --build="$("${OTP_DIR}/make/autoconf/config.guess")"
        --prefix=/otp --disable-jit --disable-sctp --disable-kernel-poll
        --disable-security-hardening-flags --disable-vm-probes
        --enable-builtin-zlib --disable-esock --disable-largefile)
    for app in "${without[@]}"; do args+=("--without-${app}"); done
    (cd "${OTP_DIR}" && emconfigure ./configure "${args[@]}" >"${WORK}/configure.log" 2>&1) \
        || { tail -40 "${WORK}/configure.log"; exit 1; }
    touch "${stamp}"
}

build() {
    local flags="-sUSE_PTHREADS=1 -sPTHREAD_POOL_SIZE=8 -sPROXY_TO_PTHREAD=1"
    flags+=" -sENVIRONMENT=worker,node -sEXPORT_ES6=1"
    flags+=" -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=2GB -sALLOW_MEMORY_GROWTH=1"
    flags+=" -sINCOMING_MODULE_JS_API=arguments,wasmMemory,preRun,print,printErr,onExit,onAbort,locateFile"
    flags+=" -sEXPORTED_RUNTIME_METHODS=ENV,FS,ccall,stringToNewUTF8,lengthBytesUTF8,FS_mkdirTree,FS_createDataFile"
    flags+=" -sEXPORTED_FUNCTIONS=['_main','_malloc','_free']"
    flags+=" -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=1 -sMALLOC=emmalloc"
    flags+=" --js-library ${HERE}/emscripten/monotonic-clock.js"
    flags+=" --pre-js ${OTP_DIR}/erts/emulator/js_bridge/beam-bridge.pre.js"
    flags+=" --js-library ${OTP_DIR}/erts/emulator/js_bridge/js_bridge.js"
    if [[ "${MODE}" == debug ]]; then
        flags+=" -sASSERTIONS=2"
    else
        flags+=" -sASSERTIONS=0 -Oz"
    fi
    export EXTRA_EMCC_LINK_FLAGS="${flags}"
    log "building erts and libraries (${MODE}, -j${JOBS})"
    (
        cd "${OTP_DIR}"
        export ERL_TOP="${OTP_DIR}"
        if [[ ! -d erts/lib_src/wasm32-unknown-emscripten ]]; then
            emmake make -C erts/lib_src TARGET=wasm32-unknown-emscripten
        fi
        emmake make TARGET=wasm32-unknown-emscripten -j"${JOBS}"
    ) >"${WORK}/build.log" 2>&1 || { tail -60 "${WORK}/build.log"; exit 1; }

    local bin="${OTP_DIR}/bin/wasm32-unknown-emscripten"
    mkdir -p "${DIST}"
    cp "${bin}/beam.wasm" "${DIST}/"
    sed 's/"beam\.emu"/"beam.emu.mjs"/g' "${bin}/beam.smp" > "${DIST}/beam.mjs"
    sed 's/"beam\.emu"/"beam.emu.mjs"/g' "${bin}/beam.emu" > "${DIST}/beam.emu.mjs"
    cp "${OTP_DIR}/bootstrap/bin/no_dot_erlang.boot" "${DIST}/vm.boot"
    log "wrote ${DIST} (beam.wasm $(du -h "${DIST}/beam.wasm" | cut -f1))"
}

checkout_and_patch
autoconf_once
bootstrap
configure_wasm
build
