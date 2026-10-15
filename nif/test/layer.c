/* A NIF library that exercises the erl_nif layer from a node (test.py). */
#include <erl_nif.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
#include <utime.h>
#include <setjmp.h>
#include <signal.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <wasi/api.h>

static ErlNifResourceType *COUNTER;

typedef struct {
    long n;
} counter;

static int load(ErlNifEnv *env, void **priv, ERL_NIF_TERM info) {
    COUNTER = enif_open_resource_type(env, NULL, "counter", NULL, ERL_NIF_RT_CREATE, NULL);
    return COUNTER ? 0 : 1;
}

static ERL_NIF_TERM new_counter(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[]) {
    counter *c = enif_alloc_resource(COUNTER, sizeof(counter));
    if (!enif_get_long(env, argv[0], &c->n)) {
        enif_release_resource(c);
        return enif_make_badarg(env);
    }
    ERL_NIF_TERM term = enif_make_resource(env, c);
    enif_release_resource(c);
    return term;
}

/* Bumps the counter, tells the caller, and answers a map. */
static ERL_NIF_TERM bump(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[]) {
    counter *c;
    if (!enif_get_resource(env, argv[0], COUNTER, (void **)&c)) return enif_make_badarg(env);
    c->n++;
    ErlNifPid self;
    enif_self(env, &self);
    ErlNifEnv *message = enif_alloc_env();
    enif_send(env, &self, message, enif_make_tuple2(message, enif_make_atom(message, "bumped"), enif_make_long(message, c->n)));
    enif_free_env(message);
    ERL_NIF_TERM map = enif_make_new_map(env);
    enif_make_map_put(env, map, enif_make_atom(env, "n"), enif_make_long(env, c->n), &map);
    enif_make_map_put(env, map, enif_make_atom(env, "max"), enif_make_uint64(env, 18446744073709551615ull), &map);
    return map;
}

static ERL_NIF_TERM echo(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[]) { return argv[0]; }

// A file's times set by path (WASI's path_filestat_set_times): :ok, or the
// errno.
static ERL_NIF_TERM touch(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[]) {
    char path[256];
    if (!enif_get_string(env, argv[0], path, sizeof path, ERL_NIF_LATIN1)) return enif_make_badarg(env);
    FILE *file = fopen(path, "w");
    if (!file) return enif_make_int(env, errno);
    fclose(file);
    return utime(path, NULL) == 0 ? enif_make_atom(env, "ok") : enif_make_int(env, errno);
}

// posix_fadvise (WASI's fd_advise, a hint the node takes and ignores):
// what it returns.
static ERL_NIF_TERM advise(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[]) {
    char path[256];
    if (!enif_get_string(env, argv[0], path, sizeof path, ERL_NIF_LATIN1)) return enif_make_badarg(env);
    int fd = open(path, O_RDONLY);
    if (fd < 0) return enif_make_int(env, errno);
    int result = posix_fadvise(fd, 0, 0, POSIX_FADV_NORMAL);
    close(fd);
    return enif_make_int(env, result);
}

static jmp_buf jump;
static volatile sig_atomic_t signalled;

static void jump_back(int value) { longjmp(jump, value); }
static void on_signal(int signal) { signalled = signal == SIGUSR1; }

// What wasi-libc emulates and the node's WASI gives a library, in a tuple:
// setjmp/longjmp's value, a signal handled, anonymous mmap, getpid,
// clock, pwrite then pread (and the position they keep), fd_allocate's
// size, fd_datasync, clock_res_get.
static ERL_NIF_TERM extras(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[]) {
    char path[256];
    if (!enif_get_string(env, argv[0], path, sizeof path, ERL_NIF_LATIN1)) return enif_make_badarg(env);

    volatile int jumped = setjmp(jump);
    if (jumped == 0) jump_back(42);

    signal(SIGUSR1, on_signal);
    raise(SIGUSR1);

    int *mapped = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    int mapped_ok = mapped != MAP_FAILED;
    if (mapped_ok) {
        mapped[100] = 7;
        mapped_ok = mapped[100];
        munmap(mapped, 4096);
    }

    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return enif_make_int(env, errno);
    write(fd, "hello world", 11);
    pwrite(fd, "WASI!", 5, 6);
    char read_back[12] = {0};
    pread(fd, read_back, 11, 0);
    __wasi_filesize_t position = 0;
    if (__wasi_fd_tell(fd, &position) != 0) position = 0;
    int allocated = __wasi_fd_allocate(fd, 0, 100);
    struct stat status;
    fstat(fd, &status);
    int datasync = __wasi_fd_datasync(fd);
    close(fd);
    __wasi_timestamp_t resolution = 0;
    if (__wasi_clock_res_get(__WASI_CLOCKID_MONOTONIC, &resolution) != 0) resolution = 0;

    ERL_NIF_TERM items[] = {
        enif_make_int(env, jumped),
        enif_make_int(env, signalled),
        enif_make_int(env, mapped_ok),
        enif_make_atom(env, getpid() > 0 ? "true" : "false"),
        enif_make_atom(env, clock() >= 0 ? "true" : "false"),
        enif_make_string(env, read_back, ERL_NIF_LATIN1),
        enif_make_int(env, (int)position),
        enif_make_int(env, allocated == 0 ? (int)status.st_size : -allocated),
        enif_make_int(env, datasync),
        enif_make_atom(env, resolution > 0 ? "true" : "false"),
    };
    return enif_make_tuple_from_array(env, items, 10);
}

static ErlNifFunc funcs[] = {
    {"new", 1, new_counter},
    {"bump", 1, bump},
    {"echo", 1, echo},
    {"touch", 1, touch},
    {"advise", 1, advise},
    {"extras", 1, extras},
};

ERL_NIF_INIT(Elixir.Layer, funcs, load, NULL, NULL, NULL)
