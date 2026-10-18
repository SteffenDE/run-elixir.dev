/*
 * The spawn driver for the Emscripten BEAM: open_port({spawn, ...}) and
 * {spawn_executable, ...} run the playground's programs (git, esbuild,
 * tailwind, make, sh, child nodes: app/src/runtime/programs.ts and the
 * page's) instead of OS processes, which Emscripten has none of. Patch
 * 0018 puts this entry in place of sys_drivers.c's.
 *
 * {spawn, Command} runs `/bin/sh -c Command`, as ERTS does; a program is
 * found by its base name. A program's output and exit are JavaScript's
 * (spawn.js); when they come, spawn.js writes the port's id into a ring
 * here and wakes this driver's event thread, which tells the process
 * erl_init starts (wasm_port_pump), and that process calls
 * erlang:port_control(Port, 1, []): the port's output, exit status and
 * end are delivered in `control`, in the port's own context.
 * With {packet, N}, as ERTS's spawn driver does: what the port is sent
 * goes to the program behind an N-byte length, and the program's output
 * comes to the port a packet at a time.
 */
#ifdef HAVE_CONFIG_H
#  include "config.h"
#endif
#include "sys.h"
#include "erl_osenv.h"
#include "erl_vm.h"
#include "global.h"
#include "erl_sys_driver.h"
#include "register.h"
#include "atom.h"

#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <emscripten/threading.h>

/* spawn.js: each returns an id, a count or a negative errno. */
extern void wasm_spawn_init(int32_t *ring, int capacity, int32_t *control);
extern int wasm_spawn_start(const char *program, const char *args, int argc,
                            const char *cwd, const char *env, int envc);
/* Output into `buffer`: a count, 0 for none yet, -1 once it has ended. */
extern int wasm_spawn_read(int id, void *buffer, int max);
/* The exit status, or -1 while the program runs. */
extern int wasm_spawn_status(int id);
extern void wasm_spawn_write(int id, const void *data, int length);
extern void wasm_spawn_kill(int id);

#define RING 1024
#define CHUNK 65536
#define PUMP_OP 1

typedef struct {
    ErlDrvPort port;
    ErlDrvTermData port_term;
    int id;
    int exit_status;            /* report it ({exit_status, N}) */
    int reported;
    int ended;
    int packet;                 /* {packet, N}: N, or 0 */
    char *pending;              /* output not yet a whole packet */
    size_t pending_length, pending_capacity;
} Spawned;

/* Ports by spawn.js id, for the event thread. */
static erts_mtx_t table_lock;
static ErlDrvTermData *table;
static int table_size;
static int32_t ring[RING];
static int32_t control[3];

static void table_put(int id, ErlDrvTermData port)
{
    erts_mtx_lock(&table_lock);
    if (id >= table_size) {
        int size = table_size ? table_size : 64;
        while (size <= id)
            size *= 2;
        table = erts_realloc(ERTS_ALC_T_DRV, table, size * sizeof(ErlDrvTermData));
        memset(table + table_size, 0, (size - table_size) * sizeof(ErlDrvTermData));
        table_size = size;
    }
    table[id] = port;
    erts_mtx_unlock(&table_lock);
}

static ErlDrvTermData table_get(int id)
{
    ErlDrvTermData port = 0;
    erts_mtx_lock(&table_lock);
    if (id > 0 && id < table_size)
        port = table[id];
    erts_mtx_unlock(&table_lock);
    return port;
}

/* Asks wasm_port_pump to pump `port` ({ready, Port}). */
static void pump(ErlDrvTermData port)
{
    Eterm pid = erts_whereis_name_to_id(NULL, am_atom_put("wasm_port_pump", 14));
    if (is_not_internal_pid(pid))
        return;
    ErlDrvTermData spec[] = {
        ERL_DRV_ATOM, driver_mk_atom("ready"),
        ERL_DRV_PORT, port,
        ERL_DRV_TUPLE, 2,
    };
    erl_drv_send_term(port, (ErlDrvTermData) pid, spec, sizeof(spec) / sizeof(spec[0]));
}

static void *events(void *arg)
{
    (void) arg;
    int32_t seen = 0;
    for (;;) {
        int32_t written = __atomic_load_n(&control[0], __ATOMIC_SEQ_CST);
        if (written == seen) {
            emscripten_futex_wait(&control[0], seen, 1e9);
            continue;
        }
        int all = __atomic_exchange_n(&control[2], 0, __ATOMIC_SEQ_CST);
        for (; seen != written; seen++) {
            ErlDrvTermData port = table_get(ring[(uint32_t) seen % RING]);
            if (port)
                pump(port);
        }
        __atomic_store_n(&control[1], seen, __ATOMIC_SEQ_CST);
        if (all) {
            for (int id = 1; id < table_size; id++) {
                ErlDrvTermData port = table_get(id);
                if (port)
                    pump(port);
            }
        }
    }
    return NULL;
}

static int spawn_init(void)
{
    erts_mtx_init(&table_lock, "wasm_spawn_table", NIL,
                  ERTS_LOCK_FLAGS_PROPERTY_STATIC | ERTS_LOCK_FLAGS_CATEGORY_IO);
    wasm_spawn_init(ring, RING, control);
    ErlDrvTid tid;
    return erl_drv_thread_create("wasm_spawn_events", &tid, events, NULL, NULL);
}

/* NUL-separated strings, and how many. */
typedef struct {
    char *data;
    size_t size, used;
    int count;
} Strings;

static void add(Strings *s, const void *bytes, size_t length, int terminate)
{
    if (s->used + length + 1 > s->size) {
        s->size = (s->used + length + 1) * 2;
        s->data = erts_realloc(ERTS_ALC_T_TMP, s->data, s->size);
    }
    memcpy(s->data + s->used, bytes, length);
    s->used += length;
    if (terminate) {
        s->data[s->used++] = '\0';
        s->count++;
    }
}

static void add_variable(void *state, const erts_osenv_data_t *key,
                         const erts_osenv_data_t *value)
{
    Strings *env = state;
    add(env, key->data, key->length, 0);
    add(env, "=", 1, 0);
    add(env, value->data, value->length, 1);
}

static ErlDrvData spawn_start(ErlDrvPort port, char *name, SysDriverOpts *opts)
{
    Strings args = {0}, env = {0};
    const char *program;
    if (opts->spawn_type == ERTS_SPAWN_EXECUTABLE) {
        program = name;
        if (opts->argv)
            for (int i = 1; opts->argv[i]; i++)
                add(&args, opts->argv[i], strlen(opts->argv[i]), 1);
    } else {
        program = "/bin/sh";
        add(&args, "-c", 2, 1);
        add(&args, name, strlen(name), 1);
    }
    erts_osenv_foreach_native(&opts->envir, &env, add_variable);
    add(&args, "", 0, 0);
    add(&env, "", 0, 0);
    /* Without {cd, Dir}, where the node is (file:set_cwd), as a child
     * process starts in its parent's directory. */
    char cwd[PATH_MAX];
    const char *wd = opts->wd ? opts->wd : getcwd(cwd, sizeof(cwd)) ? cwd : "";
    int id = wasm_spawn_start(program, args.data, args.count, wd, env.data, env.count);
    erts_free(ERTS_ALC_T_TMP, args.data);
    erts_free(ERTS_ALC_T_TMP, env.data);
    if (id < 0) {
        errno = -id;
        return ERL_DRV_ERROR_ERRNO;
    }
    Spawned *spawned = driver_alloc(sizeof(Spawned));
    memset(spawned, 0, sizeof(Spawned));
    spawned->port = port;
    spawned->port_term = driver_mk_port(port);
    spawned->id = id;
    spawned->exit_status = opts->exit_status;
    spawned->packet = opts->packet_bytes;
    table_put(id, spawned->port_term);
    /* What the program did before the table had it. */
    pump(spawned->port_term);
    return (ErlDrvData) spawned;
}

static void spawn_stop(ErlDrvData data)
{
    Spawned *spawned = (Spawned *) data;
    table_put(spawned->id, 0);
    wasm_spawn_kill(spawned->id);
    if (spawned->pending)
        driver_free(spawned->pending);
    driver_free(spawned);
}

static void spawn_output(ErlDrvData data, char *buffer, ErlDrvSizeT length)
{
    Spawned *spawned = (Spawned *) data;
    if (spawned->packet) {
        unsigned char header[4];
        for (int i = 0; i < spawned->packet; i++)
            header[i] = (unsigned char) (length >> (8 * (spawned->packet - 1 - i)));
        wasm_spawn_write(spawned->id, header, spawned->packet);
    }
    wasm_spawn_write(spawned->id, buffer, (int) length);
}

/* The program's output: as it comes, or with {packet, N} each whole packet. */
static void deliver(Spawned *spawned, const char *data, size_t length)
{
    if (!spawned->packet) {
        driver_output(spawned->port, (char *) data, length);
        return;
    }
    if (spawned->pending_length + length > spawned->pending_capacity) {
        size_t capacity = spawned->pending_capacity ? spawned->pending_capacity : CHUNK;
        while (capacity < spawned->pending_length + length)
            capacity *= 2;
        spawned->pending = spawned->pending ? driver_realloc(spawned->pending, capacity)
                                            : driver_alloc(capacity);
        spawned->pending_capacity = capacity;
    }
    memcpy(spawned->pending + spawned->pending_length, data, length);
    spawned->pending_length += length;
    size_t at = 0;
    for (;;) {
        size_t n = (size_t) spawned->packet;
        if (spawned->pending_length - at < n)
            break;
        size_t size = 0;
        for (size_t i = 0; i < n; i++)
            size = (size << 8) | (unsigned char) spawned->pending[at + i];
        if (spawned->pending_length - at - n < size)
            break;
        driver_output(spawned->port, spawned->pending + at + n, size);
        at += n + size;
    }
    memmove(spawned->pending, spawned->pending + at, spawned->pending_length - at);
    spawned->pending_length -= at;
}

/* PUMP_OP: the program's output, then its exit status and end. */
static ErlDrvSSizeT spawn_control(ErlDrvData data, unsigned int command, char *buffer,
                                  ErlDrvSizeT length, char **result, ErlDrvSizeT result_size)
{
    (void) buffer; (void) length; (void) result; (void) result_size;
    Spawned *spawned = (Spawned *) data;
    if (command != PUMP_OP || spawned->ended)
        return 0;
    char *chunk = driver_alloc(CHUNK);
    int n;
    while ((n = wasm_spawn_read(spawned->id, chunk, CHUNK)) > 0)
        deliver(spawned, chunk, (size_t) n);
    driver_free(chunk);
    if (n < 0) {
        int status = wasm_spawn_status(spawned->id);
        if (status >= 0) {
            spawned->ended = 1;
            if (spawned->exit_status && !spawned->reported) {
                spawned->reported = 1;
                driver_report_exit(spawned->port, status);
            }
            driver_failure_eof(spawned->port);
        }
    }
    return 0;
}

struct erl_drv_entry spawn_driver_entry = {
    spawn_init,
    spawn_start,
    spawn_stop,
    spawn_output,
    NULL,
    NULL,
    "spawn",
    NULL,
    NULL,
    spawn_control,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    ERL_DRV_EXTENDED_MARKER,
    ERL_DRV_EXTENDED_MAJOR_VERSION,
    ERL_DRV_EXTENDED_MINOR_VERSION,
    ERL_DRV_FLAG_USE_PORT_LOCKING,
    NULL, NULL,
    NULL
};
