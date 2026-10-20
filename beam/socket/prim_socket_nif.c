/*
 * prim_socket's NIF for the Emscripten BEAM: TCP and UDP over the
 * playground's network (app/src/runtime/wasi/net.ts) instead of esock's
 * system sockets.
 *
 * kernel's socket, gen_tcp_socket and gen_udp_socket (-kernel inet_backend
 * socket) run unchanged above prim_socket; this implements the nif_*
 * functions they reach: open, bind, listen, accept, connect, send, sendto,
 * recv, recvfrom, close, shutdown, the options they set and read, and the
 * select protocol: an operation that would block answers `select` and its
 * caller gets {'$socket', Socket, select, Handle} when to retry.
 *
 * The connections are JavaScript's. Each operation calls into the
 * module's main thread synchronously (socket.js, __proxy: 'sync'), where
 * the playground's Network lives. When a connection or data arrives, the
 * JavaScript side writes the socket's id into a ring here and wakes this
 * library's event thread, which sends the select messages: no C code runs
 * on the main thread, which also serves every thread's file calls.
 *
 * A socket's own address is the node's, 127.0.0.1 (or ::1) and a port. A
 * stream connects to the node's own addresses (127.0.0.0/8, ::1, the
 * unspecified address) at once, as before; to any other it connects
 * through the page (socket.js wasm_socket_dial), which answers `select`
 * until the page has dialed (the playground: through the user's tailnet,
 * docs/tailscale.md), and connect/1 then says how it went. A datagram
 * socket binds a port of the node's network on bind or its first send;
 * its datagrams go to the node's own ports, or through the page.
 */

#define STATIC_ERLANG_NIF 1

#include "config.h"
#include "erl_nif.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/threading.h>

/* socket.js: each returns a socket id, a count or a negative errno. */
extern void wasm_socket_init(int32_t *ring, int capacity, int32_t *control);
extern int wasm_socket_listen(int port, int32_t *bound);
extern int wasm_socket_accept(int id, int32_t *peer);
extern int wasm_socket_connect(int port);
extern int wasm_socket_dial(int family, const unsigned char *address, int port);
extern int wasm_socket_connected(int id);
extern int wasm_socket_local(int id, unsigned char *address, int32_t *port);
extern int wasm_udp_bind(int port, int32_t *bound);
extern int wasm_udp_send(int id, int family, const unsigned char *address, int port,
                         const void *data, int length);
extern int wasm_udp_recv(int id, void *buffer, int max, int32_t *family,
                         unsigned char *address, int32_t *port);
extern int wasm_socket_send(int id, const void *data, int length);
extern int wasm_socket_recv(int id, void *buffer, int max);
extern void wasm_socket_shutdown(int id);
extern void wasm_socket_close(int id);
extern int wasm_socket_pending(int id);

#define WOULD_BLOCK (-6)        /* EAGAIN, as socket.js answers it */
#define ADDRESS_IN_USE (-3)
#define DATAGRAM_MAX 65507      /* an IPv4 UDP datagram's payload */

/* Option numbers this library gives the socket and tcp levels
 * (nif_supports(options)); otp's are prim_socket.erl's. */
#define OPT_SOCKET_REUSEADDR 2
#define OPT_SOCKET_TYPE 3
#define OPT_SOCKET_BROADCAST 6
#define OPT_SOCKET_SNDBUF 7
#define OPT_SOCKET_RCVBUF 8
#define OPT_SOCKET_KEEPALIVE 9
#define OPT_SOCKET_OOBINLINE 10
#define OPT_SOCKET_PRIORITY 12
#define OPT_SOCKET_LINGER 13
#define OPT_SOCKET_REUSEPORT 15
#define OPT_SOCKET_ACCEPTCONN 30
#define OPT_SOCKET_PROTOCOL 38
#define OPT_TCP_NODELAY 1
#define OPT_TCP_CORK 3
#define OPT_TCP_KEEPIDLE 4
#define OPT_TCP_KEEPINTVL 5
#define OPT_TCP_KEEPCNT 6
#define OPT_IP_TOS 1
#define OPT_IP_TTL 2
#define OPT_IPV6_V6ONLY 26
#define LEVEL_IP 0
#define LEVEL_TCP 6
#define LEVEL_UDP 17
#define LEVEL_IPV6 41

#define OPT_OTP_DEBUG 1001
#define OPT_OTP_IOW 1002
#define OPT_OTP_CTRL_PROC 1003
#define OPT_OTP_RCVBUF 1004
#define OPT_OTP_FD 1008
#define OPT_OTP_META 1009
#define OPT_OTP_USE_REGISTRY 1010
#define OPT_OTP_SELECT_READ 1011
#define OPT_OTP_DOMAIN 1999

#define RECV_CHUNK 65536
#define RING 4096

typedef enum { FRESH, BOUND, LISTENING, CONNECTING, CONNECTED, CLOSED } State;

/* A process waiting on an operation: the Handle it gets in its message.
 * An acceptor is `notified` once told a connection waits for it. */
typedef struct Waiter {
    ErlNifPid pid;
    ErlNifEnv *env;
    ERL_NIF_TERM ref;
    int notified;
    struct Waiter *next;
} Waiter;

typedef struct {
    ErlNifMutex *lock;
    int id;                     /* socket.js's, or 0 */
    State state;
    int port, peer_port;
    int inet6;
    int dgram;                  /* a UDP socket: CONNECTED once it has a peer */
    /* The peer's address (4 or 6, in the first 4 or all 16 bytes); a
     * stream's is 0 when it is the node's own. A datagram socket's peer
     * is kept as given, the node's own (peer_local) too. */
    int peer_family, peer_local;
    unsigned char peer_address[16];
    /* Its own end at another host's (the page's tailnet address), when
     * the page says: 4 or 6, else 0 (127.0.0.1 or ::1). */
    int local_family;
    unsigned char local_address[16];
    ErlNifPid owner;
    ErlNifMonitor owner_monitor;
    int monitoring;
    Waiter *readers, *acceptors, *connectors;
    ErlNifEnv *meta_env;        /* {otp, meta}, or NULL */
    ERL_NIF_TERM meta;
    int iow;
    uint64_t read_bytes, read_packets, write_bytes, write_packets;
} Sock;

static ErlNifResourceType *socket_type;
static ErlNifPid registry;
static int have_registry;

/* Sockets by socket.js id, for the event thread. */
static ErlNifMutex *table_lock;
static Sock **table;
static int table_size;

/* socket.js writes ids at control[0] (its count, which it notifies) and
 * reads control[1], this side's count, to see whether the ring is full;
 * control[2] is set when it was. */
static int32_t ring[RING];
static int32_t control[3];

static ERL_NIF_TERM atom_ok, atom_error, atom_select, atom_closed,
    atom_timeout, atom_zero, atom_socket_tag, atom_abort, atom_add, atom_del,
    atom_family, atom_inet, atom_inet6, atom_addr, atom_port, atom_stream,
    atom_true, atom_false, atom_undefined, atom_eafnosupport,
    atom_eprotonosupport, atom_eaddrinuse, atom_econnrefused, atom_einval,
    atom_enotconn, atom_enotsup, atom_not_found, atom_onoff, atom_linger,
    atom_owner, atom_domain, atom_type, atom_protocol, atom_ctype,
    atom_normal, atom_counters, atom_num_readers, atom_num_writers,
    atom_num_acceptors, atom_rstates, atom_wstates, atom_writable,
    atom_readable, atom_use_registry, atom_listening, atom_connected,
    atom_open, atom_read_byte, atom_read_pkg, atom_write_byte,
    atom_write_pkg, atom_read_fails, atom_write_fails, atom_read_tries,
    atom_write_tries, atom_write_waits, atom_acc_success, atom_acc_tries,
    atom_acc_fails, atom_acc_waits, atom_read_waits, atom_read_pkg_max,
    atom_write_pkg_max, atom_socket, atom_dgram, atom_any, atom_loopback, atom_broadcast,
    atom_ehostunreach, atom_enetunreach, atom_etimedout, atom_econnreset,
    atom_econnaborted, atom_eacces, atom_emsgsize, atom_ealready, atom_edestaddrreq;

static ERL_NIF_TERM error_tuple(ErlNifEnv *env, ERL_NIF_TERM reason)
{
    return enif_make_tuple2(env, atom_error, reason);
}

/* socket.js's negative errnos, as WASI numbers them. */
static ERL_NIF_TERM errno_term(int error)
{
    switch (-error) {
    case 2: return atom_eacces;
    case 3: return atom_eaddrinuse;
    case 13: return atom_econnaborted;
    case 14: return atom_econnrefused;
    case 15: return atom_econnreset;
    case 23: return atom_ehostunreach;
    case 40: return atom_enetunreach;
    case 53: return atom_enotconn;
    case 73: return atom_etimedout;
    default: return atom_closed;
    }
}

/* {'$socket', SockRef}, made in `env`. */
static ERL_NIF_TERM socket_term(ErlNifEnv *env, Sock *sock)
{
    return enif_make_tuple2(env, atom_socket_tag, enif_make_resource(env, sock));
}

static Sock *get_socket(ErlNifEnv *env, ERL_NIF_TERM term)
{
    Sock *sock;
    if (!enif_get_resource(env, term, socket_type, (void **) &sock))
        return NULL;
    return sock;
}

static void table_put(int id, Sock *sock)
{
    enif_mutex_lock(table_lock);
    if (id >= table_size) {
        int size = table_size ? table_size : 64;
        while (size <= id)
            size *= 2;
        table = realloc(table, size * sizeof(Sock *));
        memset(table + table_size, 0, (size - table_size) * sizeof(Sock *));
        table_size = size;
    }
    table[id] = sock;
    enif_keep_resource(sock);
    enif_mutex_unlock(table_lock);
}

static void table_remove(int id)
{
    Sock *sock = NULL;
    enif_mutex_lock(table_lock);
    if (id < table_size) {
        sock = table[id];
        table[id] = NULL;
    }
    enif_mutex_unlock(table_lock);
    if (sock)
        enif_release_resource(sock);
}

static int same_pid(const ErlNifPid *a, const ErlNifPid *b)
{
    return enif_compare(enif_make_pid(NULL, a), enif_make_pid(NULL, b)) == 0;
}

/* The caller waits for `ref`, last in line, or where it already was. */
static void add_waiter(Waiter **list, ErlNifEnv *env, ERL_NIF_TERM ref)
{
    ErlNifPid self;
    enif_self(env, &self);
    Waiter **at = list;
    for (; *at; at = &(*at)->next) {
        if (same_pid(&(*at)->pid, &self)) {
            enif_clear_env((*at)->env);
            (*at)->ref = enif_make_copy((*at)->env, ref);
            (*at)->notified = 0;
            return;
        }
    }
    Waiter *waiter = enif_alloc(sizeof(Waiter));
    waiter->pid = self;
    waiter->env = enif_alloc_env();
    waiter->ref = enif_make_copy(waiter->env, ref);
    waiter->notified = 0;
    waiter->next = NULL;
    *at = waiter;
}

static void free_waiter(Waiter *waiter)
{
    enif_free_env(waiter->env);
    enif_free(waiter);
}

/* Tells the first acceptor a connection waits, once: as esock does, one
 * connection wakes one acceptor (gen_tcp_socket takes a select answering
 * its retry as a timeout). */
static void notify_head(ErlNifEnv *caller, Sock *sock)
{
    Waiter *head = sock->acceptors;
    if (!head || head->notified)
        return;
    head->notified = 1;
    ErlNifEnv *env = enif_alloc_env();
    ERL_NIF_TERM message =
        enif_make_tuple4(env, atom_socket_tag, socket_term(env, sock), atom_select,
                         enif_make_copy(env, head->ref));
    enif_send(caller, &head->pid, env, message);
    enif_free_env(env);
}

/* Sends each waiter {'$socket', Socket, Tag, Info(Ref)} and forgets it.
 * caller: the NIF's or callback's env, NULL on the event thread. */
static void notify_waiters(ErlNifEnv *caller, Sock *sock, Waiter **list, ERL_NIF_TERM tag,
                           ERL_NIF_TERM reason)
{
    Waiter *waiter = *list;
    *list = NULL;
    while (waiter) {
        Waiter *next = waiter->next;
        ErlNifEnv *env = waiter->env;
        ERL_NIF_TERM info = tag == atom_abort
            ? enif_make_tuple2(env, waiter->ref, reason)
            : waiter->ref;
        ERL_NIF_TERM message =
            enif_make_tuple4(env, atom_socket_tag, socket_term(env, sock), tag, info);
        enif_send(caller, &waiter->pid, env, message);
        free_waiter(waiter);
        waiter = next;
    }
}

static int remove_waiter(Waiter **list, ErlNifEnv *env, ERL_NIF_TERM ref)
{
    for (Waiter **at = list; *at; at = &(*at)->next) {
        if (enif_compare((*at)->ref, ref) == 0) {
            Waiter *waiter = *at;
            *at = waiter->next;
            free_waiter(waiter);
            return 1;
        }
    }
    return 0;
}

static void registry_send(ErlNifEnv *caller, Sock *sock, ERL_NIF_TERM what)
{
    if (!have_registry)
        return;
    ErlNifEnv *env = enif_alloc_env();
    enif_send(caller, &registry, env,
              enif_make_tuple3(env, atom_socket_tag, what, socket_term(env, sock)));
    enif_free_env(env);
}

/* Closes `sock`, its lock held: waiters get an abort, JavaScript's side
 * goes, the registry forgets it. */
static void close_locked(ErlNifEnv *caller, Sock *sock)
{
    if (sock->state == CLOSED)
        return;
    sock->state = CLOSED;
    notify_waiters(caller, sock, &sock->readers, atom_abort, atom_closed);
    notify_waiters(caller, sock, &sock->acceptors, atom_abort, atom_closed);
    notify_waiters(caller, sock, &sock->connectors, atom_abort, atom_closed);
    if (sock->id) {
        wasm_socket_close(sock->id);
        table_remove(sock->id);
    }
    registry_send(caller, sock, atom_del);
}

static Sock *new_socket(ErlNifEnv *env, State state)
{
    Sock *sock = enif_alloc_resource(socket_type, sizeof(Sock));
    memset(sock, 0, sizeof(Sock));
    sock->lock = enif_mutex_create("wasm_socket");
    sock->state = state;
    enif_self(env, &sock->owner);
    sock->monitoring =
        enif_monitor_process(env, sock, &sock->owner, &sock->owner_monitor) == 0;
    return sock;
}

/* A new socket's term for its owner: {ok, SockRef}, the registry told. */
static ERL_NIF_TERM opened(ErlNifEnv *env, Sock *sock)
{
    ERL_NIF_TERM ref = enif_make_resource(env, sock);
    registry_send(env, sock, atom_add);
    enif_release_resource(sock);
    return enif_make_tuple2(env, atom_ok, ref);
}

/* Sends `sock`'s waiters their select messages if what they wait for has
 * come (the event thread: an event is a hint, which may be stale). */
static void wake(Sock *sock)
{
    enif_mutex_lock(sock->lock);
    if (sock->state == CONNECTING) {
        if (sock->connectors && wasm_socket_connected(sock->id) != 0)
            notify_waiters(NULL, sock, &sock->connectors, atom_select, 0);
    } else if (sock->state != CLOSED && (sock->readers || sock->acceptors)
               && wasm_socket_pending(sock->id) > 0) {
        notify_waiters(NULL, sock, &sock->readers, atom_select, 0);
        notify_head(NULL, sock);
    }
    enif_mutex_unlock(sock->lock);
}

/* The socket with socket.js's `id`, kept, or NULL. */
static Sock *table_get(int id)
{
    Sock *sock = NULL;
    enif_mutex_lock(table_lock);
    if (id > 0 && id < table_size && (sock = table[id]))
        enif_keep_resource(sock);
    enif_mutex_unlock(table_lock);
    return sock;
}

/* The event thread: wakes each socket socket.js names. A socket's lock
 * is never taken with the table's (the NIFs take them the other way). */
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
            Sock *sock = table_get(ring[(uint32_t) seen % RING]);
            if (sock) {
                wake(sock);
                enif_release_resource(sock);
            }
        }
        __atomic_store_n(&control[1], seen, __ATOMIC_SEQ_CST);
        if (all) {
            /* The ring was full: every waiter retries. */
            enif_mutex_lock(table_lock);
            int size = table_size;
            enif_mutex_unlock(table_lock);
            for (int id = 1; id < size; id++) {
                Sock *sock = table_get(id);
                if (sock) {
                    wake(sock);
                    enif_release_resource(sock);
                }
            }
        }
    }
    return NULL;
}

/* ---- the nif_* functions ---- */

/* nif_open(Domain, Type, Protocol, Opts) */
static ERL_NIF_TERM nif_open4(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    int inet6 = enif_is_identical(argv[0], atom_inet6);
    if (!inet6 && !enif_is_identical(argv[0], atom_inet))
        return error_tuple(env, atom_eafnosupport);
    int dgram = enif_is_identical(argv[1], atom_dgram);
    if (!dgram && !enif_is_identical(argv[1], atom_stream))
        return error_tuple(env, atom_eprotonosupport);
    Sock *sock = new_socket(env, FRESH);
    sock->inet6 = inet6;
    sock->dgram = dgram;
    return opened(env, sock);
}

/* nif_open(FD, Opts): no system descriptors here. */
static ERL_NIF_TERM nif_open2(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc; (void) argv;
    return error_tuple(env, atom_enotsup);
}

static int get_port(ErlNifEnv *env, ERL_NIF_TERM address, int *port)
{
    ERL_NIF_TERM value;
    if (!enif_is_map(env, address)
        || !enif_get_map_value(env, address, atom_port, &value))
        return 0;
    return enif_get_int(env, value, port);
}

/* A sockaddr map's address (family 4 or 6; 4 bytes or 16) and port: a
 * tuple, or any, loopback or broadcast. */
static int get_address(ErlNifEnv *env, ERL_NIF_TERM map, int *family, unsigned char *address,
                       int *port)
{
    ERL_NIF_TERM value;
    if (!get_port(env, map, port))
        return 0;
    *family = enif_get_map_value(env, map, atom_family, &value)
        && enif_is_identical(value, atom_inet6) ? 6 : 4;
    memset(address, 0, 16);
    if (!enif_get_map_value(env, map, atom_addr, &value) || enif_is_identical(value, atom_any))
        return 1;
    if (enif_is_identical(value, atom_loopback)) {
        if (*family == 4)
            address[0] = 127, address[3] = 1;
        else
            address[15] = 1;
        return 1;
    }
    if (enif_is_identical(value, atom_broadcast)) {
        memset(address, 255, 4);
        return *family == 4;
    }
    const ERL_NIF_TERM *parts;
    int arity, part;
    if (!enif_get_tuple(env, value, &arity, &parts) || (arity != 4 && arity != 8))
        return 0;
    *family = arity == 4 ? 4 : 6;
    for (int i = 0; i < arity; i++) {
        if (!enif_get_int(env, parts[i], &part) || part < 0 || part > (arity == 4 ? 255 : 65535))
            return 0;
        if (arity == 4)
            address[i] = part;
        else
            address[2 * i] = part >> 8, address[2 * i + 1] = part & 255;
    }
    return 1;
}

/* The node's own: 127.0.0.0/8, ::1, ::ffff:127.0.0.0/104, and the
 * unspecified address (connecting to it reaches this host). */
static int is_local(int family, const unsigned char *a)
{
    static const unsigned char zero[16];
    static const unsigned char mapped[12] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255};
    if (family == 4)
        return a[0] == 127 || memcmp(a, zero, 4) == 0;
    if (memcmp(a, zero, 15) == 0)
        return a[15] <= 1;
    return memcmp(a, mapped, 12) == 0 && a[12] == 127;
}

/* {family, addr, port}'s map: `address` (4 or 16 bytes) of `family`. */
static ERL_NIF_TERM sockaddr(ErlNifEnv *env, int family, const unsigned char *a, int port)
{
    ERL_NIF_TERM keys[] = {atom_family, atom_addr, atom_port};
    ERL_NIF_TERM values[3];
    values[0] = family == 6 ? atom_inet6 : atom_inet;
    if (family == 6) {
        ERL_NIF_TERM words[8];
        for (int i = 0; i < 8; i++)
            words[i] = enif_make_int(env, (a[2 * i] << 8) | a[2 * i + 1]);
        values[1] = enif_make_tuple_from_array(env, words, 8);
    } else {
        values[1] = enif_make_tuple4(env, enif_make_int(env, a[0]), enif_make_int(env, a[1]),
                                     enif_make_int(env, a[2]), enif_make_int(env, a[3]));
    }
    values[2] = enif_make_int(env, port);
    ERL_NIF_TERM map;
    enif_make_map_from_arrays(env, keys, values, 3, &map);
    return map;
}

/* The node's own address, as `sock` has it (127.0.0.1 or ::1). */
static ERL_NIF_TERM own_sockaddr(ErlNifEnv *env, Sock *sock, int port)
{
    unsigned char a[16] = {0};
    if (sock->inet6)
        a[15] = 1;
    else
        a[0] = 127, a[3] = 1;
    return sockaddr(env, sock->inet6 ? 6 : 4, a, port);
}

/* A datagram socket's port, bound now if it is not yet (an ephemeral one,
 * as a system binds a socket that sends first): 0, or a negative errno. */
static int bind_datagram(Sock *sock, int port)
{
    if (sock->id)
        return 0;
    int32_t bound = 0;
    int id = wasm_udp_bind(port < 0 ? 0 : port, &bound);
    if (id <= 0)
        return id ? id : ADDRESS_IN_USE;
    sock->id = id;
    sock->port = bound;
    if (sock->state == FRESH)
        sock->state = BOUND;
    table_put(id, sock);
    return 0;
}

/* nif_bind(SockRef, SockAddr) */
static ERL_NIF_TERM nif_bind(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    int port;
    if (!sock || !get_port(env, argv[1], &port))
        return enif_make_badarg(env);
    enif_mutex_lock(sock->lock);
    ERL_NIF_TERM result = atom_ok;
    if (sock->state == FRESH && sock->dgram) {
        int error = bind_datagram(sock, port);
        if (error)
            result = error_tuple(env, errno_term(error));
    } else if (sock->state == FRESH) {
        sock->port = port;
        sock->state = BOUND;
    } else
        result = error_tuple(env, sock->state == CLOSED ? atom_closed : atom_einval);
    enif_mutex_unlock(sock->lock);
    return result;
}

/* nif_listen(SockRef, Backlog) */
static ERL_NIF_TERM nif_listen(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    if (!sock)
        return enif_make_badarg(env);
    enif_mutex_lock(sock->lock);
    ERL_NIF_TERM result = atom_ok;
    if (sock->dgram) {
        result = error_tuple(env, atom_enotsup);
    } else if (sock->state == FRESH || sock->state == BOUND) {
        int32_t bound = 0;
        int id = wasm_socket_listen(sock->port, &bound);
        if (id > 0) {
            sock->id = id;
            sock->port = bound;
            sock->state = LISTENING;
            table_put(id, sock);
        } else
            result = error_tuple(env, errno_term(id));
    } else if (sock->state != LISTENING)
        result = error_tuple(env, sock->state == CLOSED ? atom_closed : atom_einval);
    enif_mutex_unlock(sock->lock);
    return result;
}

/* nif_accept(LSockRef, AccRef): {ok, SockRef}, or select. Acceptors take
 * connections in turn: a caller behind another waits. */
static ERL_NIF_TERM nif_accept(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *listener = get_socket(env, argv[0]);
    if (!listener)
        return enif_make_badarg(env);
    ErlNifPid self;
    enif_self(env, &self);
    enif_mutex_lock(listener->lock);
    ERL_NIF_TERM result;
    Waiter *head = listener->acceptors;
    if (listener->state != LISTENING) {
        result = error_tuple(env, listener->state == CLOSED ? atom_closed : atom_einval);
    } else if (head && !same_pid(&head->pid, &self)) {
        add_waiter(&listener->acceptors, env, argv[1]);
        result = atom_select;
    } else {
        int32_t peer = 0;
        int id = wasm_socket_accept(listener->id, &peer);
        if (id > 0) {
            if (head) {
                listener->acceptors = head->next;
                free_waiter(head);
            }
            Sock *sock = new_socket(env, CONNECTED);
            sock->id = id;
            sock->port = listener->port;
            sock->peer_port = peer;
            sock->inet6 = listener->inet6;
            table_put(id, sock);
            result = opened(env, sock);
            if (listener->acceptors && wasm_socket_pending(listener->id) > 0)
                notify_head(env, listener);
        } else if (id == WOULD_BLOCK) {
            add_waiter(&listener->acceptors, env, argv[1]);
            result = atom_select;
        } else
            result = error_tuple(env, errno_term(id));
    }
    enif_mutex_unlock(listener->lock);
    return result;
}

/* A dialed connection's end (state CONNECTING, its lock held): ok, or why
 * not; a socket that did not connect can connect again. */
static ERL_NIF_TERM finish_connect(ErlNifEnv *env, Sock *sock)
{
    int status = wasm_socket_connected(sock->id);
    if (status > 0) {
        int32_t port = 0;
        sock->local_family = wasm_socket_local(sock->id, sock->local_address, &port);
        if (sock->local_family)
            sock->port = port;
        sock->state = CONNECTED;
        return atom_ok;
    }
    if (status == 0)
        return error_tuple(env, atom_ealready);
    wasm_socket_close(sock->id);
    table_remove(sock->id);
    sock->id = 0;
    sock->peer_family = 0;
    sock->state = FRESH;
    return error_tuple(env, errno_term(status));
}

/* nif_connect(SockRef, ConnectRef, SockAddr): at once to the node's own
 * addresses; select while the page dials another host's, and again
 * (gen_tcp_socket's retry after the select) how it went. A datagram
 * socket only takes the peer it sends to and receives from. */
static ERL_NIF_TERM nif_connect3(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    int port, family;
    unsigned char address[16];
    if (!sock || !get_address(env, argv[2], &family, address, &port))
        return enif_make_badarg(env);
    int local = is_local(family, address);
    enif_mutex_lock(sock->lock);
    ERL_NIF_TERM result = atom_ok;
    if (sock->dgram) {
        int error = sock->state == CLOSED ? -8 : bind_datagram(sock, 0);
        if (error) {
            result = error_tuple(env, sock->state == CLOSED ? atom_closed : errno_term(error));
        } else {
            sock->peer_port = port;
            sock->peer_family = family;
            sock->peer_local = local;
            memcpy(sock->peer_address, address, 16);
            sock->state = CONNECTED;
        }
    } else if ((sock->state == FRESH || sock->state == BOUND) && !local) {
        int id = wasm_socket_dial(family, address, port);
        if (id > 0) {
            sock->id = id;
            sock->peer_port = port;
            sock->peer_family = family;
            memcpy(sock->peer_address, address, 16);
            if (!sock->port)
                sock->port = 49152 + id % 16384;
            sock->state = CONNECTING;
            table_put(id, sock);
            add_waiter(&sock->connectors, env, argv[1]);
            result = atom_select;
            /* Already settled (no way there, or the page was quick): the
             * select now, as the event thread may not have seen it. */
            if (wasm_socket_connected(id) != 0)
                notify_waiters(env, sock, &sock->connectors, atom_select, 0);
        } else
            result = error_tuple(env, errno_term(id));
    } else if (sock->state == CONNECTING) {
        /* Again after its select (gen_tcp_socket does so): how it went,
         * or select again while the page still dials. */
        if (wasm_socket_connected(sock->id) == 0) {
            add_waiter(&sock->connectors, env, argv[1]);
            result = atom_select;
            if (wasm_socket_connected(sock->id) != 0)
                notify_waiters(env, sock, &sock->connectors, atom_select, 0);
        } else
            result = finish_connect(env, sock);
    } else if (sock->state == FRESH || sock->state == BOUND) {
        int id = wasm_socket_connect(port);
        if (id > 0) {
            sock->id = id;
            sock->peer_port = port;
            if (!sock->port)
                sock->port = 49152 + id % 16384;
            sock->state = CONNECTED;
            table_put(id, sock);
        } else
            result = error_tuple(env, errno_term(id));
    } else
        result = error_tuple(env, sock->state == CLOSED ? atom_closed : atom_einval);
    enif_mutex_unlock(sock->lock);
    return result;
}

/* nif_connect(SockRef): after a connect's select, how it went. */
static ERL_NIF_TERM nif_connect1(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    if (!sock)
        return enif_make_badarg(env);
    enif_mutex_lock(sock->lock);
    ERL_NIF_TERM result;
    if (sock->state == CONNECTING)
        result = finish_connect(env, sock);
    else
        result = sock->state == CONNECTED ? atom_ok : error_tuple(env, atom_enotconn);
    enif_mutex_unlock(sock->lock);
    return result;
}

/* A datagram to (family, address, port), bound first if need be. */
static ERL_NIF_TERM send_datagram(ErlNifEnv *env, Sock *sock, int family,
                                  const unsigned char *address, int port,
                                  const unsigned char *data, size_t size)
{
    if (size > DATAGRAM_MAX)
        return error_tuple(env, atom_emsgsize);
    int error = bind_datagram(sock, 0);
    if (error)
        return error_tuple(env, errno_term(error));
    int sent = wasm_udp_send(sock->id, family, address, port, data, (int) size);
    if (sent < 0)
        return error_tuple(env, errno_term(sent));
    sock->write_bytes += size;
    sock->write_packets++;
    return atom_ok;
}

/* The next datagram for `sock` into `bin` (resized to what was kept, at
 * most `want` bytes), its source in `family`, `address` and `port`: 1, or
 * 0 when none has come. A connected socket drops what is not its peer's. */
static int take_datagram(Sock *sock, ErlNifBinary *bin, int want, int *family,
                         unsigned char *address, int *port)
{
    for (;;) {
        int32_t from_family = 0, from_port = 0;
        enif_realloc_binary(bin, RECV_CHUNK);
        int n = wasm_udp_recv(sock->id, bin->data, RECV_CHUNK, &from_family, address,
                              &from_port);
        if (n < 0)
            return 0;
        if (sock->state == CONNECTED && from_port != sock->peer_port)
            continue;
        /* The node's own ports answer from 127.0.0.1, the page's from the
         * address it was sent to: a local peer is told by its port. */
        if (sock->state == CONNECTED && !sock->peer_local
            && (from_family != sock->peer_family
                || memcmp(address, sock->peer_address, from_family == 4 ? 4 : 16) != 0))
            continue;
        enif_realloc_binary(bin, n < want ? n : want);
        sock->read_bytes += bin->size;
        sock->read_packets++;
        *family = from_family;
        *port = from_port;
        return 1;
    }
}

/* nif_sendto(SockRef, Bin, Dest, Flags, SendRef) */
static ERL_NIF_TERM nif_sendto(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    ErlNifBinary bin;
    int family, port;
    unsigned char address[16];
    if (!sock || !enif_inspect_iolist_as_binary(env, argv[1], &bin))
        return enif_make_badarg(env);
    if (!get_address(env, argv[2], &family, address, &port))
        return enif_make_tuple2(env, enif_make_atom(env, "invalid"),
                                enif_make_atom(env, "sockaddr"));
    enif_mutex_lock(sock->lock);
    ERL_NIF_TERM result;
    if (sock->state == CLOSED)
        result = error_tuple(env, atom_closed);
    else if (!sock->dgram)
        result = error_tuple(env, atom_enotsup);
    else
        result = send_datagram(env, sock, family, address, port, bin.data, bin.size);
    enif_mutex_unlock(sock->lock);
    return result;
}

/* nif_recvfrom(SockRef, Length, Flags, Handle): {ok, {Source, Bin}}, the
 * next datagram (cut to Length, if not 0); select when none has come, or
 * timeout for Handle `zero`. */
static ERL_NIF_TERM nif_recvfrom(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    int length;
    if (!sock || !enif_get_int(env, argv[1], &length) || length < 0)
        return enif_make_badarg(env);
    enif_mutex_lock(sock->lock);
    ERL_NIF_TERM result;
    if (sock->state == CLOSED) {
        result = error_tuple(env, atom_closed);
    } else if (!sock->dgram) {
        result = error_tuple(env, atom_enotsup);
    } else if (!sock->id && bind_datagram(sock, 0)) {
        result = error_tuple(env, atom_eaddrinuse);
    } else {
        ErlNifBinary bin;
        enif_alloc_binary(RECV_CHUNK, &bin);
        int family, port;
        unsigned char address[16];
        if (take_datagram(sock, &bin, length ? length : RECV_CHUNK, &family, address, &port)) {
            /* As it came (inet_res checks that its nameserver answered),
             * the node's own as the socket's family has it. */
            ERL_NIF_TERM source = is_local(family, address) && (family == 6) != sock->inet6
                ? own_sockaddr(env, sock, port) : sockaddr(env, family, address, port);
            result = enif_make_tuple2(
                env, atom_ok, enif_make_tuple2(env, source, enif_make_binary(env, &bin)));
        } else {
            enif_release_binary(&bin);
            if (enif_is_identical(argv[3], atom_zero)) {
                result = atom_timeout;
            } else {
                add_waiter(&sock->readers, env, argv[3]);
                result = atom_select;
            }
        }
    }
    enif_mutex_unlock(sock->lock);
    return result;
}

static ERL_NIF_TERM send_bytes(ErlNifEnv *env, Sock *sock, const unsigned char *data,
                               size_t size)
{
    enif_mutex_lock(sock->lock);
    ERL_NIF_TERM result = atom_ok;
    if (sock->state != CONNECTED)
        result = error_tuple(env, sock->state == CLOSED ? atom_closed
                             : sock->dgram ? atom_edestaddrreq : atom_enotconn);
    else if (sock->dgram)
        result = send_datagram(env, sock, sock->peer_family, sock->peer_address, sock->peer_port,
                               data, size);
    else if (size > 0) {
        int sent = wasm_socket_send(sock->id, data, (int) size);
        if (sent < 0)
            result = error_tuple(env, atom_closed);
        else {
            sock->write_bytes += size;
            sock->write_packets++;
        }
    }
    enif_mutex_unlock(sock->lock);
    return result;
}

/* nif_send(SockRef, Bin, Flags, SendRef): all of it, always. */
static ERL_NIF_TERM nif_send(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    ErlNifBinary bin;
    if (!sock || !enif_inspect_iolist_as_binary(env, argv[1], &bin))
        return enif_make_badarg(env);
    return send_bytes(env, sock, bin.data, bin.size);
}

/* nif_sendv(SockRef, IOV, SendRef) */
static ERL_NIF_TERM nif_sendv(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    ErlNifBinary bin;
    if (!sock || !enif_inspect_iolist_as_binary(env, argv[1], &bin))
        return enif_make_badarg(env);
    return send_bytes(env, sock, bin.data, bin.size);
}

/* nif_recv(SockRef, Length, Flags, Handle): {ok, Bin} with Length bytes
 * (any, for 0); select (with what came, if some) when they have not come;
 * Handle `zero` polls: timeout instead of select. */
static ERL_NIF_TERM nif_recv(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    int length;
    if (!sock || !enif_get_int(env, argv[1], &length) || length < 0)
        return enif_make_badarg(env);
    int poll = enif_is_identical(argv[3], atom_zero);
    enif_mutex_lock(sock->lock);
    ERL_NIF_TERM result;
    if (sock->dgram && sock->state != CLOSED) {
        /* A datagram, a connected socket's peer's or any. */
        ErlNifBinary bin;
        int family, port;
        unsigned char address[16];
        enif_alloc_binary(RECV_CHUNK, &bin);
        if (!sock->id && bind_datagram(sock, 0)) {
            enif_release_binary(&bin);
            result = error_tuple(env, atom_eaddrinuse);
        } else if (take_datagram(sock, &bin, length ? length : RECV_CHUNK, &family, address,
                                 &port)) {
            result = enif_make_tuple2(env, atom_ok, enif_make_binary(env, &bin));
        } else {
            enif_release_binary(&bin);
            if (poll) {
                result = atom_timeout;
            } else {
                add_waiter(&sock->readers, env, argv[3]);
                result = atom_select;
            }
        }
        goto done;
    }
    if (sock->state != CONNECTED) {
        result = error_tuple(env, sock->state == CLOSED ? atom_closed : atom_enotconn);
        goto done;
    }
    int want = length ? length : RECV_CHUNK;
    ErlNifBinary bin;
    enif_alloc_binary(want, &bin);
    int got = 0;
    while (got < want) {
        int n = wasm_socket_recv(sock->id, bin.data + got, want - got);
        if (n <= 0) {
            if (n == 0 && got == 0) {
                /* The peer has ended, nothing left. */
                enif_release_binary(&bin);
                result = error_tuple(env, atom_closed);
                goto done;
            }
            if (n == 0) {
                enif_realloc_binary(&bin, got);
                result = error_tuple(
                    env, enif_make_tuple2(env, atom_closed, enif_make_binary(env, &bin)));
                goto done;
            }
            break;
        }
        got += n;
        if (!length)
            break;
    }
    if (got > 0) {
        sock->read_bytes += got;
        sock->read_packets++;
    }
    if (got == want || (!length && got > 0)) {
        enif_realloc_binary(&bin, got);
        result = enif_make_tuple2(env, atom_ok, enif_make_binary(env, &bin));
    } else if (poll) {
        if (got == 0) {
            enif_release_binary(&bin);
            result = atom_timeout;
        } else {
            enif_realloc_binary(&bin, got);
            result = enif_make_tuple2(env, atom_timeout, enif_make_binary(env, &bin));
        }
    } else {
        add_waiter(&sock->readers, env, argv[3]);
        if (got == 0) {
            enif_release_binary(&bin);
            result = atom_select;
        } else {
            enif_realloc_binary(&bin, got);
            result = enif_make_tuple2(env, atom_select, enif_make_binary(env, &bin));
        }
    }
done:
    enif_mutex_unlock(sock->lock);
    return result;
}

/* nif_close(SockRef) */
static ERL_NIF_TERM nif_close(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    if (!sock)
        return enif_make_badarg(env);
    enif_mutex_lock(sock->lock);
    ERL_NIF_TERM result = sock->state == CLOSED ? error_tuple(env, atom_closed) : atom_ok;
    close_locked(env, sock);
    if (sock->monitoring) {
        enif_demonitor_process(env, sock, &sock->owner_monitor);
        sock->monitoring = 0;
    }
    enif_mutex_unlock(sock->lock);
    return result;
}

/* nif_finalize_close(SockRef) */
static ERL_NIF_TERM nif_finalize_close(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) env; (void) argc; (void) argv;
    return atom_ok;
}

/* nif_shutdown(SockRef, How): ending what this side writes. */
static ERL_NIF_TERM nif_shutdown(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    if (!sock)
        return enif_make_badarg(env);
    enif_mutex_lock(sock->lock);
    ERL_NIF_TERM result = atom_ok;
    if (sock->state != CONNECTED)
        result = error_tuple(env, sock->state == CLOSED ? atom_closed : atom_enotconn);
    else if (!sock->dgram && !enif_is_identical(argv[1], enif_make_atom(env, "read")))
        wasm_socket_shutdown(sock->id);
    enif_mutex_unlock(sock->lock);
    return result;
}


/* nif_sockname(SockRef) */
static ERL_NIF_TERM nif_sockname(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    if (!sock)
        return enif_make_badarg(env);
    if (sock->state == CLOSED)
        return error_tuple(env, atom_closed);
    return enif_make_tuple2(env, atom_ok, sock->local_family
                            ? sockaddr(env, sock->local_family, sock->local_address, sock->port)
                            : own_sockaddr(env, sock, sock->port));
}

/* nif_peername(SockRef) */
static ERL_NIF_TERM nif_peername(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    if (!sock)
        return enif_make_badarg(env);
    enif_mutex_lock(sock->lock);
    ERL_NIF_TERM result = sock->state != CONNECTED
        ? error_tuple(env, sock->state == CLOSED ? atom_closed : atom_enotconn)
        : enif_make_tuple2(env, atom_ok, sock->peer_family && (sock->dgram || !sock->peer_local)
                           ? sockaddr(env, sock->peer_family, sock->peer_address, sock->peer_port)
                           : own_sockaddr(env, sock, sock->peer_port));
    enif_mutex_unlock(sock->lock);
    return result;
}

/* nif_cancel(SockRef, Op, Handle) */
static ERL_NIF_TERM nif_cancel(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    if (!sock)
        return enif_make_badarg(env);
    enif_mutex_lock(sock->lock);
    int found = remove_waiter(&sock->readers, env, argv[2])
        || remove_waiter(&sock->acceptors, env, argv[2])
        || remove_waiter(&sock->connectors, env, argv[2]);
    /* The next acceptor, if the one told went. */
    if (found && sock->state == LISTENING && sock->acceptors
        && wasm_socket_pending(sock->id) > 0)
        notify_head(env, sock);
    enif_mutex_unlock(sock->lock);
    return found ? atom_ok : error_tuple(env, atom_not_found);
}

static ERL_NIF_TERM ok_int(ErlNifEnv *env, int value)
{
    return enif_make_tuple2(env, atom_ok, enif_make_int(env, value));
}

/* nif_getopt(SockRef, Level, Opt): what a system socket would say. */
static ERL_NIF_TERM nif_getopt3(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    int level = -1, opt;
    if (!sock || !enif_get_int(env, argv[2], &opt))
        return enif_make_badarg(env);
    int otp = enif_is_identical(argv[1], enif_make_atom(env, "otp"));
    int socket_level = enif_is_identical(argv[1], atom_socket);
    if (!otp && !socket_level && !enif_get_int(env, argv[1], &level))
        return enif_make_badarg(env);
    ERL_NIF_TERM result;
    enif_mutex_lock(sock->lock);
    if (otp) {
        switch (opt) {
        case OPT_OTP_DOMAIN:
            result = enif_make_tuple2(env, atom_ok, sock->inet6 ? atom_inet6 : atom_inet);
            break;
        case OPT_OTP_META:
            result = enif_make_tuple2(
                env, atom_ok,
                sock->meta_env ? enif_make_copy(env, sock->meta) : atom_undefined);
            break;
        case OPT_OTP_CTRL_PROC:
            result = enif_make_tuple2(env, atom_ok, enif_make_pid(env, &sock->owner));
            break;
        case OPT_OTP_IOW:
            result = enif_make_tuple2(env, atom_ok, sock->iow ? atom_true : atom_false);
            break;
        case OPT_OTP_USE_REGISTRY:
            result = enif_make_tuple2(env, atom_ok, atom_true);
            break;
        case OPT_OTP_DEBUG:
        case OPT_OTP_SELECT_READ:
            result = enif_make_tuple2(env, atom_ok, atom_false);
            break;
        case OPT_OTP_RCVBUF:
            result = ok_int(env, RECV_CHUNK);
            break;
        case OPT_OTP_FD:
            result = ok_int(env, -1);
            break;
        default:
            result = error_tuple(env, atom_einval);
        }
    } else if (socket_level) {
        switch (opt) {
        case OPT_SOCKET_TYPE:
            result = enif_make_tuple2(env, atom_ok, sock->dgram ? atom_dgram : atom_stream);
            break;
        case OPT_SOCKET_PROTOCOL:
            result = ok_int(env, sock->dgram ? LEVEL_UDP : LEVEL_TCP);
            break;
        case OPT_SOCKET_ACCEPTCONN:
            result = enif_make_tuple2(env, atom_ok,
                                      sock->state == LISTENING ? atom_true : atom_false);
            break;
        case OPT_SOCKET_SNDBUF:
        case OPT_SOCKET_RCVBUF:
            result = ok_int(env, RECV_CHUNK);
            break;
        case OPT_SOCKET_LINGER: {
            ERL_NIF_TERM keys[] = {atom_onoff, atom_linger};
            ERL_NIF_TERM values[] = {atom_false, enif_make_int(env, 0)};
            ERL_NIF_TERM map;
            enif_make_map_from_arrays(env, keys, values, 2, &map);
            result = enif_make_tuple2(env, atom_ok, map);
            break;
        }
        case OPT_SOCKET_PRIORITY:
            result = ok_int(env, 0);
            break;
        default:
            result = enif_make_tuple2(env, atom_ok, atom_false);
        }
    } else if (level == LEVEL_TCP && (opt == OPT_TCP_NODELAY || opt == OPT_TCP_CORK)) {
        result = enif_make_tuple2(env, atom_ok, atom_false);
    } else {
        result = ok_int(env, 0);
    }
    enif_mutex_unlock(sock->lock);
    return result;
}

/* nif_getopt(SockRef, Level, Opt, ValueSpec, Value): native, none here. */
static ERL_NIF_TERM nif_getopt5(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc; (void) argv;
    return error_tuple(env, atom_enotsup);
}

/* nif_setopt(SockRef, Level, Opt, Value, NativeValue): the controlling
 * process and meta are kept; the rest has no effect here. */
static ERL_NIF_TERM nif_setopt(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    int opt;
    if (!sock || !enif_get_int(env, argv[2], &opt))
        return enif_make_badarg(env);
    if (!enif_is_identical(argv[1], enif_make_atom(env, "otp")))
        return atom_ok;
    ERL_NIF_TERM result = atom_ok;
    enif_mutex_lock(sock->lock);
    if (sock->state == CLOSED) {
        result = error_tuple(env, atom_closed);
    } else if (opt == OPT_OTP_CTRL_PROC) {
        ErlNifPid pid;
        if (!enif_get_local_pid(env, argv[3], &pid)) {
            result = error_tuple(env, atom_einval);
        } else {
            if (sock->monitoring)
                enif_demonitor_process(env, sock, &sock->owner_monitor);
            sock->owner = pid;
            sock->monitoring =
                enif_monitor_process(env, sock, &sock->owner, &sock->owner_monitor) == 0;
        }
    } else if (opt == OPT_OTP_META) {
        if (sock->meta_env)
            enif_clear_env(sock->meta_env);
        else
            sock->meta_env = enif_alloc_env();
        sock->meta = enif_make_copy(sock->meta_env, argv[3]);
    } else if (opt == OPT_OTP_IOW) {
        sock->iow = enif_is_identical(argv[3], atom_true);
    }
    enif_mutex_unlock(sock->lock);
    return result;
}

static ERL_NIF_TERM counter_map(ErlNifEnv *env, Sock *sock)
{
    ERL_NIF_TERM keys[] = {atom_read_byte, atom_read_pkg, atom_write_byte,
                           atom_write_pkg, atom_read_fails, atom_write_fails,
                           atom_read_tries, atom_write_tries, atom_write_waits,
                           atom_acc_success, atom_acc_tries, atom_acc_fails,
                           atom_acc_waits, atom_read_waits, atom_read_pkg_max,
                           atom_write_pkg_max};
    ERL_NIF_TERM values[16];
    values[0] = enif_make_uint64(env, sock->read_bytes);
    values[1] = enif_make_uint64(env, sock->read_packets);
    values[2] = enif_make_uint64(env, sock->write_bytes);
    values[3] = enif_make_uint64(env, sock->write_packets);
    for (int i = 4; i < 16; i++)
        values[i] = enif_make_int(env, 0);
    ERL_NIF_TERM map;
    enif_make_map_from_arrays(env, keys, values, 16, &map);
    return map;
}

/* nif_supports(Key): what prim_socket.erl makes its tables of; ip, tcp
 * and udp by number, and the options above by level and number. */
static ERL_NIF_TERM option(ErlNifEnv *env, const char *name, int number)
{
    return enif_make_tuple2(env, enif_make_atom(env, name), enif_make_int(env, number));
}

static ERL_NIF_TERM level(ErlNifEnv *env, const char *name, int number,
                          ERL_NIF_TERM *options, unsigned count)
{
    return enif_make_tuple3(env, enif_make_atom(env, name), enif_make_int(env, number),
                            enif_make_list_from_array(env, options, count));
}

static ERL_NIF_TERM protocol(ErlNifEnv *env, const char *name, const char *upper, int number)
{
    return enif_make_tuple2(env,
                            enif_make_list2(env, enif_make_atom(env, name),
                                            enif_make_atom(env, upper)),
                            enif_make_int(env, number));
}

static ERL_NIF_TERM nif_supports1(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    if (enif_is_identical(argv[0], enif_make_atom(env, "protocols"))) {
        ERL_NIF_TERM protocols[] = {
            protocol(env, "ip", "IP", 0),
            protocol(env, "tcp", "TCP", LEVEL_TCP),
            protocol(env, "udp", "UDP", 17),
        };
        return enif_make_list_from_array(env, protocols, 3);
    }
    if (enif_is_identical(argv[0], enif_make_atom(env, "options"))) {
        ERL_NIF_TERM socket[] = {
            option(env, "reuseaddr", OPT_SOCKET_REUSEADDR),
            option(env, "type", OPT_SOCKET_TYPE),
            option(env, "broadcast", OPT_SOCKET_BROADCAST),
            option(env, "sndbuf", OPT_SOCKET_SNDBUF),
            option(env, "rcvbuf", OPT_SOCKET_RCVBUF),
            option(env, "keepalive", OPT_SOCKET_KEEPALIVE),
            option(env, "oobinline", OPT_SOCKET_OOBINLINE),
            option(env, "priority", OPT_SOCKET_PRIORITY),
            option(env, "linger", OPT_SOCKET_LINGER),
            option(env, "reuseport", OPT_SOCKET_REUSEPORT),
            option(env, "acceptconn", OPT_SOCKET_ACCEPTCONN),
            option(env, "protocol", OPT_SOCKET_PROTOCOL),
        };
        ERL_NIF_TERM tcp[] = {
            option(env, "nodelay", OPT_TCP_NODELAY),
            option(env, "cork", OPT_TCP_CORK),
            option(env, "keepidle", OPT_TCP_KEEPIDLE),
            option(env, "keepintvl", OPT_TCP_KEEPINTVL),
            option(env, "keepcnt", OPT_TCP_KEEPCNT),
        };
        ERL_NIF_TERM ip[] = {
            option(env, "tos", OPT_IP_TOS),
            option(env, "ttl", OPT_IP_TTL),
        };
        ERL_NIF_TERM ipv6[] = {
            option(env, "v6only", OPT_IPV6_V6ONLY),
        };
        ERL_NIF_TERM levels[] = {
            level(env, "socket", 1, socket, sizeof(socket) / sizeof(*socket)),
            level(env, "tcp", LEVEL_TCP, tcp, sizeof(tcp) / sizeof(*tcp)),
            level(env, "ip", LEVEL_IP, ip, sizeof(ip) / sizeof(*ip)),
            level(env, "ipv6", LEVEL_IPV6, ipv6, sizeof(ipv6) / sizeof(*ipv6)),
        };
        return enif_make_list_from_array(env, levels, 4);
    }
    /* msg_flags, ioctl_requests, ioctl_flags: none. */
    return enif_make_list(env, 0);
}

/* nif_info(): the library's, as socket:info/0 and gen_tcp_socket read it
 * (counters' num_cnt_bits); no counts are kept. */
static ERL_NIF_TERM nif_info0(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    (void) argv;
    const char *counter_names[] = {
        "num_cnt_bits", "num_sockets", "num_tdgrams", "num_tstreams", "num_tseqpkgs",
        "num_dlocal", "num_dinet", "num_dinet6", "num_pip", "num_ptcp", "num_pudp",
        "num_psctp",
    };
    ERL_NIF_TERM keys[12], values[12], counters, info;
    for (unsigned i = 0; i < 12; i++) {
        keys[i] = enif_make_atom(env, counter_names[i]);
        values[i] = enif_make_uint(env, i == 0 ? 64 : 0);
    }
    enif_make_map_from_arrays(env, keys, values, 12, &counters);
    ERL_NIF_TERM info_keys[] = {
        enif_make_atom(env, "debug"), enif_make_atom(env, "socket_debug"),
        enif_make_atom(env, "eei"), enif_make_atom(env, "use_registry"),
        enif_make_atom(env, "iow"), enif_make_atom(env, "counters"),
        enif_make_atom(env, "iov_max"),
    };
    ERL_NIF_TERM info_values[] = {
        atom_false, atom_false, atom_false, have_registry ? atom_true : atom_false,
        atom_false, counters, enif_make_int(env, 1024),
    };
    enif_make_map_from_arrays(env, info_keys, info_values, 7, &info);
    return info;
}

/* nif_supports(): no optional features. */
static ERL_NIF_TERM nif_supports0(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    (void) argv;
    return enif_make_list(env, 0);
}

/* nif_info(SockRef) */
static ERL_NIF_TERM nif_info1(ErlNifEnv *env, int argc, const ERL_NIF_TERM argv[])
{
    (void) argc;
    Sock *sock = get_socket(env, argv[0]);
    if (!sock)
        return enif_make_badarg(env);
    enif_mutex_lock(sock->lock);
    ERL_NIF_TERM state = sock->state == LISTENING ? atom_listening
        : sock->state == CONNECTED ? atom_connected
        : sock->state == CONNECTING ? enif_make_atom(env, "connecting")
        : sock->state == CLOSED ? atom_closed : atom_open;
    ERL_NIF_TERM keys[] = {atom_domain, atom_type, atom_protocol, atom_ctype,
                           atom_counters, atom_num_readers, atom_num_writers,
                           atom_num_acceptors, atom_writable, atom_readable,
                           atom_rstates, atom_wstates, atom_owner,
                           atom_use_registry};
    ERL_NIF_TERM values[] = {
        sock->inet6 ? atom_inet6 : atom_inet, sock->dgram ? atom_dgram : atom_stream,
        enif_make_int(env, sock->dgram ? LEVEL_UDP : LEVEL_TCP),
        atom_normal, counter_map(env, sock), enif_make_int(env, sock->readers != NULL),
        enif_make_int(env, 0), enif_make_int(env, sock->acceptors != NULL),
        sock->state == CONNECTED || sock->dgram ? atom_true : atom_false,
        sock->state == CONNECTED || (sock->dgram && sock->id) ? atom_true : atom_false,
        enif_make_list1(env, state), enif_make_list1(env, state),
        enif_make_pid(env, &sock->owner), atom_true};
    ERL_NIF_TERM map;
    enif_make_map_from_arrays(env, keys, values, 14, &map);
    enif_mutex_unlock(sock->lock);
    return map;
}

/* ---- the resource ---- */

static void socket_dtor(ErlNifEnv *env, void *object)
{
    (void) env;
    Sock *sock = object;
    if (sock->state != CLOSED && sock->id)
        wasm_socket_close(sock->id);
    if (sock->meta_env)
        enif_free_env(sock->meta_env);
    enif_mutex_destroy(sock->lock);
}

/* The owner died: as esock does, the socket closes. */
static void socket_down(ErlNifEnv *env, void *object, ErlNifPid *pid, ErlNifMonitor *mon)
{
    (void) pid; (void) mon;
    Sock *sock = object;
    enif_mutex_lock(sock->lock);
    sock->monitoring = 0;
    close_locked(env, sock);
    enif_mutex_unlock(sock->lock);
}

#define ATOM(name) atom_##name = enif_make_atom(env, #name)

static int load(ErlNifEnv *env, void **priv, ERL_NIF_TERM info)
{
    (void) priv;
    ErlNifResourceTypeInit init = {socket_dtor, NULL, socket_down, 3, NULL};
    socket_type = enif_init_resource_type(env, "wasm_socket", &init,
                                          ERL_NIF_RT_CREATE, NULL);
    if (!socket_type)
        return 1;
    ATOM(ok); ATOM(error); ATOM(select); ATOM(closed); ATOM(timeout); ATOM(zero);
    atom_socket_tag = enif_make_atom(env, "$socket");
    ATOM(abort); ATOM(add); ATOM(del); ATOM(family); ATOM(inet); ATOM(inet6);
    ATOM(addr); ATOM(port); ATOM(stream); ATOM(true); ATOM(false); ATOM(undefined);
    ATOM(eafnosupport); ATOM(eprotonosupport); ATOM(eaddrinuse); ATOM(econnrefused);
    ATOM(einval); ATOM(enotconn); ATOM(enotsup); ATOM(not_found); ATOM(onoff);
    ATOM(linger); ATOM(owner); ATOM(domain); ATOM(type); ATOM(protocol); ATOM(ctype);
    ATOM(normal); ATOM(counters); ATOM(num_readers); ATOM(num_writers);
    ATOM(num_acceptors); ATOM(rstates); ATOM(wstates); ATOM(writable); ATOM(readable);
    ATOM(use_registry); ATOM(listening); ATOM(connected); ATOM(open); ATOM(read_byte);
    ATOM(read_pkg); ATOM(write_byte); ATOM(write_pkg); ATOM(read_fails);
    ATOM(write_fails); ATOM(read_tries); ATOM(write_tries); ATOM(write_waits);
    ATOM(acc_success); ATOM(acc_tries); ATOM(acc_fails); ATOM(acc_waits);
    ATOM(read_waits); ATOM(read_pkg_max); ATOM(write_pkg_max); ATOM(socket);
    ATOM(dgram); ATOM(any); ATOM(loopback); ATOM(broadcast); ATOM(ehostunreach);
    ATOM(enetunreach); ATOM(etimedout); ATOM(econnreset); ATOM(econnaborted); ATOM(eacces);
    ATOM(emsgsize); ATOM(ealready); ATOM(edestaddrreq);

    ERL_NIF_TERM pid;
    have_registry = enif_is_map(env, info)
        && enif_get_map_value(env, info, enif_make_atom(env, "registry"), &pid)
        && enif_get_local_pid(env, pid, &registry);

    table_lock = enif_mutex_create("wasm_socket_table");
    wasm_socket_init(ring, RING, control);
    ErlNifTid tid;
    ErlNifThreadOpts *opts = enif_thread_opts_create("wasm_socket_events");
    int failed = enif_thread_create("wasm_socket_events", &tid, events, NULL, opts);
    enif_thread_opts_destroy(opts);
    return failed;
}

static ErlNifFunc nif_funcs[] = {
    {"nif_supports", 0, nif_supports0, 0},
    {"nif_supports", 1, nif_supports1, 0},
    {"nif_open", 2, nif_open2, 0},
    {"nif_open", 4, nif_open4, 0},
    {"nif_bind", 2, nif_bind, 0},
    {"nif_listen", 2, nif_listen, 0},
    {"nif_accept", 2, nif_accept, 0},
    {"nif_connect", 1, nif_connect1, 0},
    {"nif_connect", 3, nif_connect3, 0},
    {"nif_send", 4, nif_send, 0},
    {"nif_sendto", 5, nif_sendto, 0},
    {"nif_recvfrom", 4, nif_recvfrom, 0},
    {"nif_sendv", 3, nif_sendv, 0},
    {"nif_recv", 4, nif_recv, 0},
    {"nif_close", 1, nif_close, 0},
    {"nif_finalize_close", 1, nif_finalize_close, 0},
    {"nif_shutdown", 2, nif_shutdown, 0},
    {"nif_sockname", 1, nif_sockname, 0},
    {"nif_peername", 1, nif_peername, 0},
    {"nif_cancel", 3, nif_cancel, 0},
    {"nif_getopt", 3, nif_getopt3, 0},
    {"nif_getopt", 5, nif_getopt5, 0},
    {"nif_setopt", 5, nif_setopt, 0},
    {"nif_info", 0, nif_info0, 0},
    {"nif_info", 1, nif_info1, 0},
};

ERL_NIF_INIT(prim_socket, nif_funcs, load, NULL, NULL, NULL)
