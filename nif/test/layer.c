/* A NIF library that exercises the erl_nif layer from a node (test.py). */
#include <erl_nif.h>

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

static ErlNifFunc funcs[] = {
    {"new", 1, new_counter},
    {"bump", 1, bump},
    {"echo", 1, echo},
};

ERL_NIF_INIT(Elixir.Layer, funcs, load, NULL, NULL, NULL)
