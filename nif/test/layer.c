/* A NIF library that exercises the erl_nif layer from a node (test.py). */
#include <erl_nif.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
#include <utime.h>

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

// posix_fadvise (WASI's fd_advise, which the node's WASI lacks): what it
// returns.
static ERL_NIF_TERM advise(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[]) {
    char path[256];
    if (!enif_get_string(env, argv[0], path, sizeof path, ERL_NIF_LATIN1)) return enif_make_badarg(env);
    int fd = open(path, O_RDONLY);
    if (fd < 0) return enif_make_int(env, errno);
    int result = posix_fadvise(fd, 0, 0, POSIX_FADV_NORMAL);
    close(fd);
    return enif_make_int(env, result);
}

static ErlNifFunc funcs[] = {
    {"new", 1, new_counter},
    {"bump", 1, bump},
    {"echo", 1, echo},
    {"touch", 1, touch},
    {"advise", 1, advise},
};

ERL_NIF_INIT(Elixir.Layer, funcs, load, NULL, NULL, NULL)
