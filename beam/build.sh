#!/bin/bash
# Build the real BEAM (OTP's erts) for wasm32-emscripten with Popcorn's
# patch stack (see README.md).
#
# Usage: beam/build.sh [debug|release] [-j N]
#
# Environment:
#   OPT          release optimisation level (default -Os, as Popcorn)
#   EXTRA_LINK   further emcc link flags, e.g. -sNODERAWFS=1 for Node runs
#                with the host's file system
#   DIST         output directory (default <tree>/dist)
#
# Each mode builds in its own tree, out/beam-wasm/debug or
# out/beam-wasm/release<OPT without its dash> (releaseOs, releaseO2):
#   otp/        patched OTP checkout (git, one commit per patch)
#   dist/       beam.wasm, beam.mjs, beam.emu.mjs, vm.boot, and otp/: the
#               applications' ebin and priv (otp/lib/APP), otp/bin/start.boot
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
OTP_TAG="${OTP_TAG:-OTP-29.1.2}"
MODE=debug
JOBS="$(nproc)"
OPT="${OPT:--Os}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        debug|release) MODE="$1"; shift ;;
        -j) JOBS="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [[ "${MODE}" == release ]]; then
    # No -O2 in the path: erts/emulator/zlib/zlib.mk rewrites -O2 in CFLAGS.
    WORK="${ROOT}/out/beam-wasm/release${OPT#-}"
else
    WORK="${ROOT}/out/beam-wasm/debug"
fi
OTP_DIR="${WORK}/otp"
DIST="${DIST:-${WORK}/dist}"

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

# The tree's stamp: the tag it was cloned at and the patches applied over it.
patched_stamp() {
    { echo "${OTP_TAG}"; cat "${HERE}"/patches/*.patch; } | git hash-object --stdin
}

checkout_and_patch() {
    if [[ -d "${OTP_DIR}/.git" ]]; then
        local want have
        want=$(patched_stamp)
        have=$(cat "${OTP_DIR}/.stamp-patched" 2>/dev/null || true)
        if [[ "${want}" == "${have}" ]]; then
            log "${OTP_TAG} and patches up to date"
            return
        fi
        log "${OTP_TAG} or patches changed; recreate ${OTP_DIR}"
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
    patched_stamp > "${OTP_DIR}/.stamp-patched"
}

autoconf_once() {
    [[ -f "${OTP_DIR}/.stamp-autoconf" ]] && return
    log "regenerating configure scripts"
    (cd "${OTP_DIR}" && ./otp_build update_configure --no-commit >/dev/null)
    touch "${OTP_DIR}/.stamp-autoconf"
}

# The native bootstrap embeds erts/preloaded/ebin/*.beam, including the
# patch stack's new wasm and erl_init modules and those it changes, so
# compile those first with the host erlc, then again with the bootstrap's.
compile_preloaded() {
    local erlc="$1"
    for module in wasm erl_init prim_inet prim_socket prim_net erlang; do
        local beam="${OTP_DIR}/erts/preloaded/ebin/${module}.beam"
        local src="${OTP_DIR}/erts/preloaded/src/${module}.erl"
        [[ "${beam}" -nt "${src}" && "${beam}" -nt "${erlc}" ]] && continue
        "${erlc}" +deterministic \
            -I "${OTP_DIR}/lib/kernel/src" -I "${OTP_DIR}/lib/kernel/include" \
            -o "${OTP_DIR}/erts/preloaded/ebin" \
            "${OTP_DIR}/erts/preloaded/src/${module}.erl"
    done
}

bootstrap() {
    if [[ -x "${OTP_DIR}/bootstrap/bin/erlc" ]]; then
        compile_preloaded "${OTP_DIR}/bootstrap/bin/erlc"
        return
    fi
    compile_preloaded "$(command -v erlc)"
    log "building native bootstrap"
    (cd "${OTP_DIR}" && ./configure --enable-bootstrap-only >/dev/null && make -j"${JOBS}" >/dev/null)
    compile_preloaded "${OTP_DIR}/bootstrap/bin/erlc"
}

configure_wasm() {
    local stamp="${OTP_DIR}/.stamp-configure"
    local openssl="${ROOT}/out/beam-wasm/openssl"
    # termcap from ncurses.sh's libtinfo: prim_tty's raw input (IEx's line
    # editing) needs it.
    local ncurses="${ROOT}/out/beam-wasm/ncurses"
    if [[ "${MODE}" == debug ]]; then
        export CFLAGS="-O0 -g -pthread"
    else
        export CFLAGS="${OPT} -flto -pthread"
    fi
    CFLAGS+=" -I${ncurses}/include/ncurses -I${ncurses}/include"
    export LDFLAGS="-pthread -flto -L${ncurses}/lib"
    export ac_cv_func_pthread_create=yes ac_cv_header_pthread_h=yes
    export ac_cv_sizeof_short=2 ac_cv_sizeof_int=4 ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8 ac_cv_sizeof_void_p=4 ac_cv_c_bigendian=no
    # Kept: what projects start or compile with (runtime_tools for
    # phx.new's apps, mnesia for Ash's, parsetools for yecc and leex,
    # os_mon for Livebook's memsup, whose port program is the page's).
    local without=(common_test diameter edoc eldap eunit ftp jinterface reltool
        snmp tftp wx debugger dialyzer et megaco observer odbc
        ssh javac threadnames dynamic-trace)
    local args=(--host=wasm32-unknown-emscripten
        --build="$("${OTP_DIR}/make/autoconf/config.guess")"
        --prefix=/otp --disable-jit --disable-sctp --disable-kernel-poll
        --disable-security-hardening-flags --disable-vm-probes
        --enable-builtin-zlib --disable-esock --disable-largefile)
    for app in "${without[@]}"; do args+=("--without-${app}"); done
    # crypto (and asn1's) NIFs linked in, over openssl.sh's OpenSSL.
    args+=(--with-ssl="${openssl}" --disable-dynamic-ssl-lib --enable-static-nifs=yes)
    local key="${MODE} ${OPT} ${args[*]}"
    [[ -f "${stamp}" && "$(cat "${stamp}")" == "${key}" ]] && return
    log "configuring for emscripten (${MODE})"
    (cd "${OTP_DIR}" \
        && export erl_xcomp_sysroot="${openssl}" erl_xcomp_isysroot="${openssl}" \
            LIBS="-L${openssl}/lib -lcrypto -ldl -lm" \
        && emconfigure ./configure "${args[@]}" >"${WORK}/configure.log" 2>&1) \
        || { tail -40 "${WORK}/configure.log"; exit 1; }
    echo "${key}" > "${stamp}"
}

build() {
    local flags="-sUSE_PTHREADS=1 -sPTHREAD_POOL_SIZE=8 -sPROXY_TO_PTHREAD=1"
    flags+=" -sENVIRONMENT=worker,node -sEXPORT_ES6=1"
    # mimalloc and 4 GB: emmalloc's heap fragmented past Popcorn's 2 GB
    # compiling Ash (README.md).
    flags+=" -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sALLOW_MEMORY_GROWTH=1"
    # instantiateWasm: a node's worker instantiates beam.wasm as the page
    # compiled it once (beam/run.ts), rather than fetching and compiling it.
    flags+=" -sINCOMING_MODULE_JS_API=arguments,wasmMemory,preRun,print,printErr,onExit,onAbort,locateFile,stdin,instantiateWasm"
    flags+=" -sEXPORTED_RUNTIME_METHODS=ENV,FS,TTY,ccall,stringToNewUTF8,lengthBytesUTF8,FS_mkdirTree,FS_createDataFile"
    # popcorn*: patch 0011's and 0017's terminal; emscripten_force_exit
    # stops a node (Ctrl+C).
    # raise: a signal for the node (Ctrl+C is SIGINT), its handler run on
    # the main thread (beam/run.ts).
    flags+=" -sEXPORTED_FUNCTIONS=['_main','_malloc','_free','_emscripten_force_exit','_popcornStdinEnqueue','_popcornStdinEof','_popcornTtyResize','_raise','_popcornStdinTake']"
    flags+=" -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=1 -sMALLOC=mimalloc"
    # PROXYFS mounts the playground's tree (packages/runtime/src/beam/treefs.ts).
    flags+=" -lproxyfs.js"
    flags+=" --js-library ${HERE}/emscripten/monotonic-clock.js"
    # prim_socket over the playground's network (socket/, patch 0016).
    flags+=" --js-library ${HERE}/socket/socket.js"
    flags+=" --js-library ${HERE}/emscripten/tty.js"
    flags+=" --js-library ${HERE}/host/host.js"
    flags+=" --js-library ${HERE}/host/spawn.js"
    flags+=" --js-library ${HERE}/host/nifs.js"
    flags+=" --pre-js ${OTP_DIR}/erts/emulator/js_bridge/beam-bridge.pre.js"
    flags+=" --js-library ${OTP_DIR}/erts/emulator/js_bridge/js_bridge.js"
    if [[ "${MODE}" == debug ]]; then
        flags+=" -sASSERTIONS=2"
    else
        flags+=" -sASSERTIONS=0 ${OPT}"
    fi
    # What erts needs of a Unix process that Emscripten does not give,
    # with erts unpatched for it: pipes that block (host/wasm_pipes.c:
    # erts' signal dispatcher and poll set wait on them), and an exit from
    # any thread and an idle main thread (host/wasm_process.c).
    mkdir -p "${WORK}"
    emcc ${OPT} -pthread -c "${HERE}/host/wasm_pipes.c" -o "${WORK}/wasm_pipes.o"
    emcc ${OPT} -pthread -c "${HERE}/host/wasm_process.c" -o "${WORK}/wasm_process.o"
    flags+=" ${WORK}/wasm_pipes.o ${WORK}/wasm_process.o"
    flags+=" -Wl,--wrap=pipe,--wrap=pipe2,--wrap=read,--wrap=write,--wrap=close,--wrap=fcntl,--wrap=poll"
    flags+=" -Wl,--wrap=exit,--wrap=_exit,--wrap=select"
    flags+=" ${EXTRA_LINK:-}"
    # The emulator's link does not depend on these flags; relink.
    rm -f "${OTP_DIR}"/bin/wasm32-unknown-emscripten/beam.{emu,smp,wasm}
    export EXTRA_EMCC_LINK_FLAGS="${flags}"
    mkdir -p "${OTP_DIR}/erts/emulator/nifs/wasm"
    cp -p "${HERE}/socket/prim_socket_nif.c" "${HERE}/host/wasm_host.c" "${HERE}/host/wasm_spawn.c" \
        "${HERE}/host/wasm_nifs.c" \
        "${OTP_DIR}/erts/emulator/nifs/wasm/"
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
    module_js "${bin}/beam.smp" "${DIST}/beam.mjs"
    module_js "${bin}/beam.emu" "${DIST}/beam.emu.mjs"
    cp "${OTP_DIR}/bootstrap/bin/no_dot_erlang.boot" "${DIST}/vm.boot"
    install_libs
    log "wrote ${DIST} (beam.wasm $(du -h "${DIST}/beam.wasm" | cut -f1))"
}

# Emscripten's module script $1, as the site serves it ($2): its threads'
# script by its .mjs name, and a thread's worker from Module.beamThreadUrl
# when given (run.ts: a blob of beam.emu.mjs), as WebKit's page crashes
# when many workers fetch their module script at once.
module_js() {
    sed -e 's/"beam\.emu"/"beam.emu.mjs"/g' \
        -e 's/new Worker(new URL("beam\.emu\.mjs",import\.meta\.url)/new Worker(Module["beamThreadUrl"]??new URL("beam.emu.mjs",import.meta.url)/' \
        "$1" > "$2"
    grep -q 'Module\["beamThreadUrl"\]' "$2" || { echo "$1: no thread worker to patch" >&2; exit 1; }
}

# An installation to mount: each application's ebin, priv and include under
# otp/lib, without its version (the boot script's paths have none), and the
# boot script as otp/bin/start.boot.
install_libs() {
    rm -rf "${DIST}/otp"
    for app in "${OTP_DIR}"/lib/*/ "${OTP_DIR}/erts/preloaded/"; do
        [[ -d "${app}ebin" ]] || continue
        local name
        name="$(basename "${app}")"
        [[ "${name}" == preloaded ]] && name=erts
        mkdir -p "${DIST}/otp/lib/${name}"
        cp -r "${app}ebin" "${DIST}/otp/lib/${name}/"
        for part in priv include; do
            if [[ -d "${app}${part}" ]]; then cp -r "${app}${part}" "${DIST}/otp/lib/${name}/"; fi
        done
    done
    mkdir -p "${DIST}/otp/bin"
    cp "${DIST}/vm.boot" "${DIST}/otp/bin/start.boot"
}

"${HERE}/openssl.sh" -j "${JOBS}"
"${HERE}/ncurses.sh" -j "${JOBS}"
checkout_and_patch
autoconf_once
bootstrap
configure_wasm
build
