# git's build for wasm32-wasip1 (tools/git/build.py copies this into the source
# as config.mak). WASI preview 1 has no processes, threads, users, modes,
# terminals or sockets: what git would ask of them, tools/wasi-compat/ declares and
# stubs; what has a compat fallback in git (regex, mmap, poll) uses it.
CC = /opt/wasi-sdk/bin/clang --target=wasm32-wasip1 --sysroot=/opt/wasi-sdk/share/wasi-sysroot
AR = /opt/wasi-sdk/bin/llvm-ar
CFLAGS = -Oz -Wno-macro-redefined -I/zlib/include -I/wasi/include -include /wasi/include/wasi-compat.h \
	-Dchmod=wasi_chmod -Dfchmod=wasi_fchmod \
	-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN
# A stack of 1 MiB (wasm-ld's default is 64 KiB): history walks recurse.
# The stack pointer exported: the host switches it between git and an
# async's coroutine (stubs.c wasi_async_start).
LDFLAGS = -L/zlib/lib -Wl,-z,stack-size=1048576 -Wl,--export=__stack_pointer \
	-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman
LIB_OBJS += /wasi/stubs.o

prefix = /usr
NO_RUST = YesPlease
NO_PTHREADS = YesPlease
NO_CURL = YesPlease
NO_EXPAT = YesPlease
NO_GETTEXT = YesPlease
NO_ICONV = YesPlease
NO_OPENSSL = YesPlease
NO_PERL = YesPlease
NO_PYTHON = YesPlease
NO_TCLTK = YesPlease
NO_REGEX = YesPlease
NO_MMAP = YesPlease
NO_UNIX_SOCKETS = YesPlease
NO_IPV6 = YesPlease
NO_SETITIMER = YesPlease
NO_STRUCT_ITIMERVAL = YesPlease
NO_INITGROUPS = YesPlease
NO_GECOS_IN_PWENT = YesPlease
NO_TRUSTABLE_FILEMODE = YesPlease
NO_SYMLINK_HEAD = YesPlease
NO_INSTALL_HARDLINKS = YesPlease
NO_POSIX_GOODIES = UnfortunatelyYes
SKIP_DASHED_BUILT_INS = YesPlease
CSPRNG_METHOD = getentropy
HAVE_DEV_TTY =
