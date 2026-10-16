/*
 * The playground's system calls for the Emscripten BEAM, where Emscripten's
 * own (weak stubs in its libc) are not what the playground needs. Linked
 * into erts by patch 0016 (playground/beam/build.sh copies this file to
 * erts/emulator/nifs/wasm).
 */
#include <errno.h>
#include <string.h>
#include <sys/utsname.h>

/* host.js: on the module's main thread, through the mounted file system. */
extern int wasm_host_linkat(int olddirfd, const char *oldpath, int newdirfd,
                            const char *newpath, int flags);

/* Hard links: Emscripten's always fail (EMLINK); the playground's trees
 * have them, and Mix's compile lock takes them. */
int __syscall_linkat(int olddirfd, const char *oldpath, int newdirfd,
                     const char *newpath, int flags)
{
    return wasm_host_linkat(olddirfd, oldpath, newdirfd, newpath, flags);
}

/* The node presents itself as Linux, as Rust-OTP does (os:type() is
 * {unix, linux}): packages choose their paths and tools by it. */
int __syscall_uname(struct utsname *buf)
{
    if (!buf)
        return -EFAULT;
    strcpy(buf->sysname, "Linux");
    strcpy(buf->nodename, "playground");
    strcpy(buf->release, "6.0.0");
    strcpy(buf->version, "#1");
    strcpy(buf->machine, "wasm32");
    return 0;
}
