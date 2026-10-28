/*
 * NIF libraries built to WebAssembly for the Emscripten BEAM, as Rust-OTP
 * runs them in the playground: each library is a WASI reactor of its own
 * (nif/: its C or C++ against nif/beamos_nif.c's
 * erl_nif), in an instance beside the node, which the host keeps
 * (packages/runtime/src/nif.ts, through nifs.js on the module's main thread).
 * Requests and answers cross as external terms:
 *
 *   {load, LoadInfo, Self}    -> {ok, Module, [{Name, Arity, Flags}], Messages}
 *   {call, Index, Args, Self} -> {ok, Result, Messages} | {raise, Reason, Messages}
 *
 * Messages are what the library sent meanwhile, [{Pid, Message}].
 *
 * erts_load_nif (patch 0021) asks erts_wasm_nif_entry for a library it
 * cannot link: the library's own answer to `load` makes an ErlNifEntry
 * whose every function is wasm_nif_call. That one function serves them
 * all: erts sets the process's current function before calling a NIF, and
 * the library is the NIF's private data. Dirty NIFs run as the others
 * (the library has one thread).
 */
#ifdef HAVE_CONFIG_H
#  include "config.h"
#endif
#include "sys.h"
#include "global.h"
#include "erl_nif.h"

#include <pthread.h>
#include <string.h>

/* nifs.js: an instance for the library at `path` (its id, or 0), whose
 * error is then wasm_nif_error's; a request, whose answer's size it
 * answers (negative: none) and which wasm_nif_answer copies out. */
extern int wasm_nif_open(const char *path);
extern int wasm_nif_error(char *buffer, int size);
extern int wasm_nif_request(int id, const void *data, int size);
extern void wasm_nif_answer(void *buffer);

typedef struct {
    int id;
    ErlNifEntry entry;
    ERL_NIF_TERM *names;        /* atoms, by index */
} WasmLibrary;

/* nifs.js keeps one answer, from a request until wasm_nif_answer copies
 * it out: one thread at a time, else another's request replaced it. */
static pthread_mutex_t asking = PTHREAD_MUTEX_INITIALIZER;

/* The library erts_load_nif is loading: its entry's load sets it as the
 * NIF's private data, on the same thread. */
static __thread WasmLibrary *loading;

static int sends(ErlNifEnv *caller, ErlNifEnv *env, ERL_NIF_TERM messages)
{
    ERL_NIF_TERM head;
    while (enif_get_list_cell(env, messages, &head, &messages)) {
        const ERL_NIF_TERM *pair;
        int arity;
        ErlNifPid pid;
        if (enif_get_tuple(env, head, &arity, &pair) && arity == 2
            && enif_get_local_pid(env, pair[0], &pid)) {
            ErlNifEnv *message = enif_alloc_env();
            enif_send(caller, &pid, message, enif_make_copy(message, pair[1]));
            enif_free_env(message);
        }
    }
    return 1;
}

/* The library's answer to `request` (an external term), in `env`; zero
 * when it has none. */
static int ask(WasmLibrary *library, ErlNifEnv *env, ERL_NIF_TERM request,
               ERL_NIF_TERM *answer)
{
    ErlNifBinary bin;
    if (!enif_term_to_binary(env, request, &bin))
        return 0;
    pthread_mutex_lock(&asking);
    int size = wasm_nif_request(library->id, bin.data, (int) bin.size);
    unsigned char *data = size < 0 ? NULL : enif_alloc(size ? size : 1);
    if (data)
        wasm_nif_answer(data);
    pthread_mutex_unlock(&asking);
    enif_release_binary(&bin);
    if (size < 0)
        return 0;
    int ok = enif_binary_to_term(env, data, size, answer, 0) > 0;
    enif_free(data);
    return ok;
}

static ERL_NIF_TERM wasm_nif_call(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    WasmLibrary *library = enif_priv_data(env);
    const ErtsCodeMFA *mfa = env->proc->current;
    int index = -1;
    for (int i = 0; i < library->entry.num_of_funcs; i++) {
        if (library->names[i] == mfa->function
            && library->entry.funcs[i].arity == (unsigned) argc) {
            index = i;
            break;
        }
    }
    ErlNifPid self;
    enif_self(env, &self);
    ERL_NIF_TERM request = enif_make_tuple4(
        env, enif_make_atom(env, "call"), enif_make_int(env, index),
        enif_make_list_from_array(env, argv, argc), enif_make_pid(env, &self));
    ERL_NIF_TERM answer;
    const ERL_NIF_TERM *fields;
    int arity;
    if (index < 0 || !ask(library, env, request, &answer)
        || !enif_get_tuple(env, answer, &arity, &fields) || arity != 3)
        return enif_raise_exception(env, enif_make_atom(env, "nif_library_failed"));
    sends(env, env, fields[2]);
    if (enif_is_identical(fields[0], enif_make_atom(env, "raise")))
        return enif_raise_exception(env, fields[1]);
    return fields[1];
}

static int wasm_nif_load(ErlNifEnv *env, void **priv, ERL_NIF_TERM info)
{
    (void) env; (void) info;
    *priv = loading;
    loading = NULL;
    return 0;
}

/* An entry for the library at `path` (with ".so"), loaded with `args`, or
 * NULL with why in `error`. */
ErlNifEntry *erts_wasm_nif_entry(Process *c_p, const char *path, Eterm args,
                                 char *error, size_t error_size)
{
    char *file = erts_alloc(ERTS_ALC_T_TMP, strlen(path) + 4);
    strcpy(file, path);
    strcat(file, ".so");
    int id = wasm_nif_open(file);
    erts_free(ERTS_ALC_T_TMP, file);
    if (id <= 0) {
        wasm_nif_error(error, (int) error_size);
        return NULL;
    }
    WasmLibrary *library = erts_alloc(ERTS_ALC_T_NIF, sizeof(WasmLibrary));
    memset(library, 0, sizeof(WasmLibrary));
    library->id = id;

    ErlNifEnv *env = enif_alloc_env();
    ErlNifPid self;
    self.pid = c_p->common.id;
    ERL_NIF_TERM request = enif_make_tuple3(env, enif_make_atom(env, "load"),
                                            enif_make_copy(env, args),
                                            enif_make_pid(env, &self));
    ERL_NIF_TERM answer, list, head;
    const ERL_NIF_TERM *fields = NULL;
    int arity = 0, count = 0;
    char name[256];
    if (!ask(library, env, request, &answer)
        || !enif_get_tuple(env, answer, &arity, &fields)
        || arity != 4 || !enif_is_identical(fields[0], enif_make_atom(env, "ok"))
        || !enif_get_atom(env, fields[1], name, sizeof(name), ERL_NIF_LATIN1)
        || !enif_get_list_length(env, fields[2], (unsigned *) &count)) {
        erts_snprintf(error, error_size, "the NIF library's load failed: %T",
                      arity >= 2 ? fields[1] : answer);
        enif_free_env(env);
        erts_free(ERTS_ALC_T_NIF, library);
        return NULL;
    }
    sends(NULL, env, arity == 4 ? fields[3] : enif_make_list(env, 0));

    ErlNifFunc *funcs = erts_alloc(ERTS_ALC_T_NIF, (count ? count : 1) * sizeof(ErlNifFunc));
    library->names = erts_alloc(ERTS_ALC_T_NIF, (count ? count : 1) * sizeof(ERL_NIF_TERM));
    list = fields[2];
    for (int i = 0; enif_get_list_cell(env, list, &head, &list); i++) {
        const ERL_NIF_TERM *f;
        int n;
        unsigned fn_arity = 0;
        char fn[256] = "";
        if (enif_get_tuple(env, head, &n, &f) && n == 3) {
            enif_get_atom(env, f[0], fn, sizeof(fn), ERL_NIF_LATIN1);
            enif_get_uint(env, f[1], &fn_arity);
        }
        char *copy = erts_alloc(ERTS_ALC_T_NIF, strlen(fn) + 1);
        strcpy(copy, fn);
        funcs[i].name = copy;
        funcs[i].arity = fn_arity;
        funcs[i].fptr = wasm_nif_call;
        funcs[i].flags = 0;
        library->names[i] = erts_atom_put((const byte *) fn, strlen(fn),
                                          ERTS_ATOM_ENC_LATIN1, 1);
    }
    char *module = erts_alloc(ERTS_ALC_T_NIF, strlen(name) + 1);
    strcpy(module, name);
    enif_free_env(env);

    ErlNifEntry *entry = &library->entry;
    entry->major = ERL_NIF_MAJOR_VERSION;
    entry->minor = ERL_NIF_MINOR_VERSION;
    entry->name = module;
    entry->num_of_funcs = count;
    entry->funcs = funcs;
    entry->load = wasm_nif_load;
    entry->vm_variant = ERL_NIF_VM_VARIANT;
    entry->options = 1;
    entry->sizeof_ErlNifResourceTypeInit = sizeof(ErlNifResourceTypeInit);
    entry->min_erts = ERL_NIF_MIN_ERTS_VERSION;
    loading = library;
    return entry;
}
