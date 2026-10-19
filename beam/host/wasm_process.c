/*
 * The process's end and its idle wait, for erts on Emscripten. Linked with
 * -Wl,--wrap=exit,--wrap=_exit,--wrap=select (build.sh).
 *
 * exit: erts exits from whichever thread halts it (a scheduler for
 * erlang:halt, the break menu's (a)bort). On a pthread Emscripten passes
 * an exit to the main thread, which keeps running while the runtime is
 * kept alive (as PROXY_TO_PTHREAD's is): emscripten_force_exit ends it
 * there from any thread.
 *
 * select: erts' main thread, having started the others, waits for nothing
 * (no descriptors, no timeout), which Emscripten answers at once; here it
 * waits for good, as on Unix until a signal (a handler runs on the main
 * browser thread instead: run.ts).
 */
#include <emscripten.h>
#include <pthread.h>
#include <stdlib.h>
#include <sys/select.h>
#include <unistd.h>

int __real_select(int n, fd_set *r, fd_set *w, fd_set *e, struct timeval *timeout);

void __wrap_exit(int status) {
    emscripten_force_exit(status);
    abort();
}

void __wrap__exit(int status) {
    emscripten_force_exit(status);
    abort();
}

int __wrap_select(int n, fd_set *r, fd_set *w, fd_set *e, struct timeval *timeout) {
    if (n == 0 && timeout == NULL) {
        static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
        static pthread_cond_t never = PTHREAD_COND_INITIALIZER;
        pthread_mutex_lock(&lock);
        for (;;)
            pthread_cond_wait(&never, &lock);
    }
    return __real_select(n, r, w, e, timeout);
}
