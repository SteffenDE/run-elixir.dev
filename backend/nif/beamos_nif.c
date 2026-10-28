/* erl_nif for NIF libraries built to WebAssembly (wasm32-wasip1), for
   Rust-OTP in the playground.

   A NIF library is linked with this file into a WASI reactor of its own,
   with its own memory. The node calls it through four exports:

     beamos_nif_abi()        this layer's protocol (BEAMOS_NIF_ABI)
     beamos_nif_input(size)  room for a request of `size` bytes
     beamos_nif_run(size)    run the request; the answer's size
     beamos_nif_output()     where the answer is

   The NIF ABI (docs/nif.md) is that protocol and the erl_nif.h it was
   compiled with: "BEAMOS_NIF_ABI-ERL_NIF_MAJOR_VERSION.ERL_NIF_MINOR_VERSION",
   such as 1-2.18. A change to the exports or to the terms below is a new
   BEAMOS_NIF_ABI.

   Requests and answers are external terms (term_to_binary):

     {load, LoadInfo, Self}       -> {ok, Module, [{Name, Arity, Flags}], Messages}
                                   | {error, {load, Status}, Messages}
     {call, Index, Args, Self}    -> {ok, Result, Messages}
                                   | {raise, Reason, Messages}

   Messages are what enif_send sent meanwhile, [{Pid, Message}], for the
   node to send. Terms here are cells in an environment's arena; atoms and
   pids are interned, so equal ones are the same term. A resource crosses
   as a reference on node 'beamos_nif@wasm' that names it, and stays alive
   for the instance's life once it has crossed (the node does not report
   collected references yet). There is one thread: locks do nothing, and
   dirty NIFs run like the others. */

#include "erl_nif.h"

#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>

enum { K_NONE, K_ATOM, K_INT, K_BIG, K_FLOAT, K_BIN, K_NIL, K_CONS, K_TUPLE, K_MAP, K_RAW, K_RES };

typedef struct resource resource;

typedef struct cell {
    uint8_t kind;
    uint8_t tag; /* K_RAW: the external tag; K_BIG: 1 if negative */
    uint32_t n;  /* K_TUPLE: arity; K_MAP: size */
    union {
        int64_t i;
        uint64_t mag;
        double f;
        struct { const unsigned char *data; size_t size; } b; /* K_BIN, K_ATOM (UTF-8), K_RAW */
        struct { ERL_NIF_TERM head, tail; } c;
        ERL_NIF_TERM *t; /* K_TUPLE; K_MAP: n keys, then n values */
        resource *r;
    } u;
} cell;

#define C(term) ((cell *)(uintptr_t)(term))
#define T(c) ((ERL_NIF_TERM)(uintptr_t)(c))

/* ---- Environments ---------------------------------------------------- */

typedef struct chunk {
    struct chunk *next;
    size_t used, size;
    _Alignas(8) unsigned char data[];
} chunk;

struct enif_environment_t {
    chunk *chunks;
    void **owned; /* binaries made from enif_alloc_binary */
    size_t owned_n, owned_cap;
    int has_exception;
    ERL_NIF_TERM exception;
    ERL_NIF_TERM self; /* the calling process, or 0 */
};

static void *env_alloc(ErlNifEnv *env, size_t size) {
    size = (size + 7) & ~(size_t)7;
    if (!env->chunks || env->chunks->used + size > env->chunks->size) {
        size_t room = size > 65536 ? size : 65536;
        chunk *c = malloc(sizeof(chunk) + room);
        if (!c) abort();
        c->next = env->chunks;
        c->used = 0;
        c->size = room;
        env->chunks = c;
    }
    void *at = env->chunks->data + env->chunks->used;
    env->chunks->used += size;
    return at;
}

static void env_own(ErlNifEnv *env, void *block) {
    if (env->owned_n == env->owned_cap) {
        env->owned_cap = env->owned_cap ? 2 * env->owned_cap : 8;
        env->owned = realloc(env->owned, env->owned_cap * sizeof(void *));
        if (!env->owned) abort();
    }
    env->owned[env->owned_n++] = block;
}

static void env_clear(ErlNifEnv *env) {
    while (env->chunks) {
        chunk *next = env->chunks->next;
        free(env->chunks);
        env->chunks = next;
    }
    for (size_t i = 0; i < env->owned_n; i++) free(env->owned[i]);
    env->owned_n = 0;
    env->has_exception = 0;
    env->exception = 0;
}

static cell *new_cell(ErlNifEnv *env, int kind) {
    cell *c = env_alloc(env, sizeof(cell));
    memset(c, 0, sizeof *c);
    c->kind = kind;
    return c;
}

static ErlNifEnv call_env;   /* a call's or a load's */
static ErlNifEnv outbox_env; /* what enif_send sent, until the answer */
static cell none = { .kind = K_NONE };
static cell nil = { .kind = K_NIL };

/* ---- Interned atoms and pids ------------------------------------------ */

static cell **interned;
static size_t interned_n, interned_cap;

static uint32_t fnv(const unsigned char *data, size_t size, uint32_t h) {
    for (size_t i = 0; i < size; i++) h = (h ^ data[i]) * 16777619u;
    return h;
}

static ERL_NIF_TERM intern(int kind, int tag, const unsigned char *data, size_t size) {
    if (2 * (interned_n + 1) > interned_cap) {
        size_t cap = interned_cap ? 2 * interned_cap : 256;
        cell **table = calloc(cap, sizeof(cell *));
        if (!table) abort();
        for (size_t i = 0; i < interned_cap; i++) {
            cell *c = interned[i];
            if (!c) continue;
            size_t at = fnv(c->u.b.data, c->u.b.size, 2166136261u ^ c->kind) & (cap - 1);
            while (table[at]) at = (at + 1) & (cap - 1);
            table[at] = c;
        }
        free(interned);
        interned = table;
        interned_cap = cap;
    }
    size_t at = fnv(data, size, 2166136261u ^ kind) & (interned_cap - 1);
    for (cell *c; (c = interned[at]); at = (at + 1) & (interned_cap - 1))
        if (c->kind == kind && c->u.b.size == size && !memcmp(c->u.b.data, data, size)) return T(c);
    cell *c = calloc(1, sizeof(cell));
    unsigned char *copy = malloc(size ? size : 1);
    if (!c || !copy) abort();
    memcpy(copy, data, size);
    c->kind = kind;
    c->tag = tag;
    c->u.b.data = copy;
    c->u.b.size = size;
    interned[at] = c;
    interned_n++;
    return T(c);
}

static ERL_NIF_TERM atom_utf8(const char *name, size_t size) {
    return intern(K_ATOM, 0, (const unsigned char *)name, size);
}

static ERL_NIF_TERM atom_latin1(const char *name, size_t size) {
    unsigned char small[512];
    unsigned char *out = 2 * size <= sizeof small ? small : malloc(2 * size);
    size_t n = 0;
    for (size_t i = 0; i < size; i++) {
        unsigned char ch = name[i];
        if (ch < 0x80) out[n++] = ch;
        else {
            out[n++] = 0xc0 | (ch >> 6);
            out[n++] = 0x80 | (ch & 0x3f);
        }
    }
    ERL_NIF_TERM atom = intern(K_ATOM, 0, out, n);
    if (out != small) free(out);
    return atom;
}

static ERL_NIF_TERM atom(const char *name) { return atom_utf8(name, strlen(name)); }

/* ---- Resources ------------------------------------------------------- */

struct enif_resource_type_t {
    char *name;
    ErlNifResourceTypeInit init;
    struct enif_resource_type_t *next;
};

struct resource {
    ErlNifResourceType *type;
    size_t size;
    uint32_t id;
    int refs;
    int crossed;
    uint32_t pad;
    /* the object follows, 8-aligned */
};

static ErlNifResourceType *resource_types;
static resource **resources; /* by id */
static uint32_t resources_cap;
static uint32_t next_resource = 1;
static uint32_t nonce; /* this instance's (16 bits), in its references */
static uint64_t next_ref = 1;

/* The references a library makes, resources' and enif_make_ref's, are the
   node's own (Rust-OTP's: nonode@nohost, a 61-bit counter in three words,
   the first of 18 bits and the third of 11), with bit 59 set, which the
   node's counter never reaches, bit 58 set for a plain one, the
   instance's nonce, and a 34-bit id. */
static const char NODE[] = "nonode@nohost";


#define OBJECT(r) ((void *)((r) + 1))
#define HEADER(obj) (((resource *)(obj)) - 1)

static void destroy(resource *r) {
    if (r->type->init.dtor) {
        ErlNifEnv env = { 0 };
        r->type->init.dtor(&env, OBJECT(r));
        env_clear(&env);
    }
    resources[r->id] = NULL;
    free(r);
}

/* ---- External terms: decoding ------------------------------------------ */

typedef struct {
    const unsigned char *p, *end;
    ErlNifEnv *env;
} reader;

static int need(reader *r, size_t n) { return (size_t)(r->end - r->p) >= n; }
static uint32_t be16(const unsigned char *p) { return (uint32_t)p[0] << 8 | p[1]; }
static uint32_t be32(const unsigned char *p) {
    return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}

static int skip(reader *r);

static int skip_atom(reader *r) {
    if (!need(r, 1)) return 0;
    switch (*r->p++) {
    case 100: case 118:
        if (!need(r, 2)) return 0;
        r->p += 2;
        if (!need(r, be16(r->p - 2))) return 0;
        r->p += be16(r->p - 2);
        return 1;
    case 115: case 119:
        if (!need(r, 1)) return 0;
        r->p += 1;
        if (!need(r, r->p[-1])) return 0;
        r->p += r->p[-1];
        return 1;
    default:
        return 0;
    }
}

static int skip_n(reader *r, size_t n) {
    if (!need(r, n)) return 0;
    r->p += n;
    return 1;
}

/* Past one term (pids, ports, references, funs, bitstrings, bignums). */
static int skip(reader *r) {
    if (!need(r, 1)) return 0;
    unsigned tag = *r->p;
    switch (tag) {
    case 100: case 115: case 118: case 119: return skip_atom(r);
    case 97: return skip_n(r, 2);
    case 98: return skip_n(r, 5);
    case 70: return skip_n(r, 9);
    case 99: return skip_n(r, 32);
    case 106: return skip_n(r, 1);
    case 103: r->p++; return skip_atom(r) && skip_n(r, 9);
    case 88: r->p++; return skip_atom(r) && skip_n(r, 12);
    case 102: r->p++; return skip_atom(r) && skip_n(r, 5);
    case 89: r->p++; return skip_atom(r) && skip_n(r, 8);
    case 120: r->p++; return skip_atom(r) && skip_n(r, 12);
    case 101: r->p++; return skip_atom(r) && skip_n(r, 5);
    case 114: case 90: {
        if (!skip_n(r, 3)) return 0;
        uint32_t n = be16(r->p - 2);
        return skip_atom(r) && skip_n(r, (tag == 90 ? 4 : 1) + 4 * (size_t)n);
    }
    case 113: r->p++; return skip_atom(r) && skip_atom(r) && skip(r);
    case 112: {
        if (!need(r, 5)) return 0;
        uint32_t size = be32(r->p + 1);
        r->p++;
        return skip_n(r, size);
    }
    case 110: {
        if (!need(r, 2)) return 0;
        size_t n = r->p[1];
        return skip_n(r, 3 + n);
    }
    case 111: {
        if (!need(r, 5)) return 0;
        size_t n = be32(r->p + 1);
        return skip_n(r, 6 + n);
    }
    case 109: {
        if (!need(r, 5)) return 0;
        return skip_n(r, 5 + (size_t)be32(r->p + 1));
    }
    case 77: {
        if (!need(r, 6)) return 0;
        return skip_n(r, 6 + (size_t)be32(r->p + 1));
    }
    case 107: {
        if (!need(r, 3)) return 0;
        return skip_n(r, 3 + be16(r->p + 1));
    }
    case 104: case 105: {
        size_t n;
        if (tag == 104) { if (!skip_n(r, 2)) return 0; n = r->p[-1]; }
        else { if (!skip_n(r, 5)) return 0; n = be32(r->p - 4); }
        for (size_t i = 0; i < n; i++) if (!skip(r)) return 0;
        return 1;
    }
    case 108: {
        if (!skip_n(r, 5)) return 0;
        size_t n = be32(r->p - 4);
        for (size_t i = 0; i <= n; i++) if (!skip(r)) return 0;
        return 1;
    }
    case 116: {
        if (!skip_n(r, 5)) return 0;
        size_t n = be32(r->p - 4);
        for (size_t i = 0; i < 2 * n; i++) if (!skip(r)) return 0;
        return 1;
    }
    default:
        return 0;
    }
}

static ERL_NIF_TERM raw(ErlNifEnv *env, const unsigned char *from, const unsigned char *to) {
    cell *c = new_cell(env, K_RAW);
    c->tag = from[0];
    c->u.b.data = from;
    c->u.b.size = to - from;
    return T(c);
}

static ERL_NIF_TERM make_int(ErlNifEnv *env, int64_t i) {
    cell *c = new_cell(env, K_INT);
    c->u.i = i;
    return T(c);
}

static int decode(reader *r, ERL_NIF_TERM *out);

static int decode_reference(reader *r, const unsigned char *start, ERL_NIF_TERM *out) {
    /* 90, length, node, creation, words: a resource's names it (put_ref). */
    reader at = { start + 1, r->end, r->env };
    if (!skip(r)) return 0;
    uint32_t n = be16(at.p);
    at.p += 2;
    const unsigned char *node = at.p;
    if (!skip_atom(&at)) return 0;
    size_t header = node[0] == 100 || node[0] == 118 ? 3 : 2;
    size_t node_size = at.p - node - header;
    at.p += 4;
    uint32_t w0 = be32(at.p), w1 = be32(at.p + 4), w2 = be32(at.p + 8);
    if (n == 3 && node_size == sizeof NODE - 1 && !memcmp(node + header, NODE, node_size) &&
        (w2 & 0x700) == 0x200 && w1 >> 16 == nonce) {
        uint64_t id = (uint64_t)(w1 & 0xffff) << 18 | w0;
        if (id < resources_cap && resources[id]) {
            cell *c = new_cell(r->env, K_RES);
            c->u.r = resources[id];
            *out = T(c);
            return 1;
        }
    }
    *out = raw(r->env, start, r->p);
    return 1;
}

static int decode(reader *r, ERL_NIF_TERM *out) {
    if (!need(r, 1)) return 0;
    const unsigned char *start = r->p;
    unsigned tag = *r->p++;
    switch (tag) {
    case 97:
        if (!need(r, 1)) return 0;
        *out = make_int(r->env, *r->p++);
        return 1;
    case 98:
        if (!need(r, 4)) return 0;
        *out = make_int(r->env, (int32_t)be32(r->p));
        r->p += 4;
        return 1;
    case 110: case 111: {
        size_t n;
        if (tag == 110) { if (!need(r, 2)) return 0; n = *r->p++; }
        else { if (!need(r, 5)) return 0; n = be32(r->p); r->p += 4; }
        unsigned sign = *r->p++;
        if (!need(r, n)) return 0;
        if (n > 8) {
            r->p += n;
            *out = raw(r->env, start, r->p);
            return 1;
        }
        uint64_t mag = 0;
        for (size_t i = 0; i < n; i++) mag |= (uint64_t)r->p[i] << (8 * i);
        r->p += n;
        if (!sign && mag <= INT64_MAX) *out = make_int(r->env, (int64_t)mag);
        else if (sign && mag <= (uint64_t)INT64_MAX + 1) *out = make_int(r->env, (int64_t)(0 - mag));
        else {
            cell *c = new_cell(r->env, K_BIG);
            c->tag = sign;
            c->u.mag = mag;
            *out = T(c);
        }
        return 1;
    }
    case 70: {
        if (!need(r, 8)) return 0;
        uint64_t bits = (uint64_t)be32(r->p) << 32 | be32(r->p + 4);
        r->p += 8;
        cell *c = new_cell(r->env, K_FLOAT);
        memcpy(&c->u.f, &bits, 8);
        *out = T(c);
        return 1;
    }
    case 99: {
        if (!need(r, 31)) return 0;
        char text[32];
        memcpy(text, r->p, 31);
        text[31] = 0;
        r->p += 31;
        cell *c = new_cell(r->env, K_FLOAT);
        c->u.f = strtod(text, NULL);
        *out = T(c);
        return 1;
    }
    case 100: case 118: case 115: case 119: {
        size_t n;
        if (tag == 100 || tag == 118) { if (!need(r, 2)) return 0; n = be16(r->p); r->p += 2; }
        else { if (!need(r, 1)) return 0; n = *r->p++; }
        if (!need(r, n)) return 0;
        *out = tag == 100 || tag == 115 ? atom_latin1((const char *)r->p, n) : atom_utf8((const char *)r->p, n);
        r->p += n;
        return 1;
    }
    case 104: case 105: {
        size_t n;
        if (tag == 104) { if (!need(r, 1)) return 0; n = *r->p++; }
        else { if (!need(r, 4)) return 0; n = be32(r->p); r->p += 4; }
        if (n > (size_t)(r->end - r->p)) return 0;
        cell *c = new_cell(r->env, K_TUPLE);
        c->n = n;
        c->u.t = env_alloc(r->env, n * sizeof(ERL_NIF_TERM));
        for (size_t i = 0; i < n; i++) if (!decode(r, &c->u.t[i])) return 0;
        *out = T(c);
        return 1;
    }
    case 106:
        *out = T(&nil);
        return 1;
    case 107: {
        if (!need(r, 2)) return 0;
        size_t n = be16(r->p);
        r->p += 2;
        if (!need(r, n)) return 0;
        ERL_NIF_TERM list = T(&nil);
        for (size_t i = n; i-- > 0;) list = enif_make_list_cell(r->env, make_int(r->env, r->p[i]), list);
        r->p += n;
        *out = list;
        return 1;
    }
    case 108: {
        if (!need(r, 4)) return 0;
        size_t n = be32(r->p);
        r->p += 4;
        if (n > (size_t)(r->end - r->p)) return 0;
        cell *first = NULL, *last = NULL;
        for (size_t i = 0; i < n; i++) {
            cell *c = new_cell(r->env, K_CONS);
            if (!decode(r, &c->u.c.head)) return 0;
            if (last) last->u.c.tail = T(c);
            else first = c;
            last = c;
        }
        ERL_NIF_TERM tail;
        if (!decode(r, &tail)) return 0;
        if (!last) { *out = tail; return 1; }
        last->u.c.tail = tail;
        *out = T(first);
        return 1;
    }
    case 109: {
        if (!need(r, 4)) return 0;
        size_t n = be32(r->p);
        r->p += 4;
        if (!need(r, n)) return 0;
        cell *c = new_cell(r->env, K_BIN);
        c->u.b.data = r->p;
        c->u.b.size = n;
        r->p += n;
        *out = T(c);
        return 1;
    }
    case 116: {
        if (!need(r, 4)) return 0;
        size_t n = be32(r->p);
        r->p += 4;
        if (n > (size_t)(r->end - r->p)) return 0;
        cell *c = new_cell(r->env, K_MAP);
        c->n = n;
        c->u.t = env_alloc(r->env, 2 * n * sizeof(ERL_NIF_TERM));
        for (size_t i = 0; i < n; i++)
            if (!decode(r, &c->u.t[i]) || !decode(r, &c->u.t[n + i])) return 0;
        *out = T(c);
        return 1;
    }
    case 90:
        r->p = start;
        return decode_reference(r, start, out);
    case 88: case 103:
        r->p = start;
        if (!skip(r)) return 0;
        *out = intern(K_RAW, tag, start, r->p - start);
        return 1;
    default:
        r->p = start;
        if (!skip(r)) return 0;
        *out = raw(r->env, start, r->p);
        return 1;
    }
}

/* ---- External terms: encoding ------------------------------------------ */

typedef struct {
    unsigned char *data;
    size_t size, cap;
} buffer;

static void put(buffer *b, const void *data, size_t size) {
    if (b->size + size > b->cap) {
        size_t cap = b->cap ? b->cap : 256;
        while (cap < b->size + size) cap *= 2;
        b->data = realloc(b->data, cap);
        if (!b->data) abort();
        b->cap = cap;
    }
    memcpy(b->data + b->size, data, size);
    b->size += size;
}

static void put8(buffer *b, unsigned v) {
    unsigned char c = v;
    put(b, &c, 1);
}

static void put16(buffer *b, uint32_t v) {
    unsigned char c[2] = { v >> 8, v };
    put(b, c, 2);
}

static void put32(buffer *b, uint32_t v) {
    unsigned char c[4] = { v >> 24, v >> 16, v >> 8, v };
    put(b, c, 4);
}

static void put_big(buffer *b, int negative, uint64_t mag) {
    unsigned char digits[8];
    int n = 0;
    while (mag) {
        digits[n++] = mag & 0xff;
        mag >>= 8;
    }
    put8(b, 110);
    put8(b, n);
    put8(b, negative);
    put(b, digits, n);
}

static void put_ref(buffer *b, int plain, uint64_t id) {
    put8(b, 90);
    put16(b, 3);
    put8(b, 119);
    put8(b, sizeof NODE - 1);
    put(b, NODE, sizeof NODE - 1);
    put32(b, 0);
    put32(b, id & 0x3ffff);
    put32(b, nonce << 16 | (id >> 18 & 0xffff));
    put32(b, 0x200 | (plain ? 0x100 : 0));
}

static void encode(buffer *b, ERL_NIF_TERM term) {
    cell *c = C(term);
    switch (c->kind) {
    case K_ATOM:
        if (c->u.b.size < 256) { put8(b, 119); put8(b, c->u.b.size); }
        else { put8(b, 118); put16(b, c->u.b.size); }
        put(b, c->u.b.data, c->u.b.size);
        return;
    case K_INT: {
        int64_t i = c->u.i;
        if (i >= 0 && i < 256) { put8(b, 97); put8(b, i); }
        else if (i >= INT32_MIN && i <= INT32_MAX) { put8(b, 98); put32(b, (uint32_t)i); }
        else put_big(b, i < 0, i < 0 ? 0 - (uint64_t)i : (uint64_t)i);
        return;
    }
    case K_BIG:
        put_big(b, c->tag, c->u.mag);
        return;
    case K_FLOAT: {
        uint64_t bits;
        memcpy(&bits, &c->u.f, 8);
        put8(b, 70);
        put32(b, bits >> 32);
        put32(b, (uint32_t)bits);
        return;
    }
    case K_BIN:
        put8(b, 109);
        put32(b, c->u.b.size);
        put(b, c->u.b.data, c->u.b.size);
        return;
    case K_NIL:
        put8(b, 106);
        return;
    case K_CONS: {
        uint32_t n = 0;
        ERL_NIF_TERM at = term;
        for (; C(at)->kind == K_CONS; at = C(at)->u.c.tail) n++;
        put8(b, 108);
        put32(b, n);
        for (at = term; C(at)->kind == K_CONS; at = C(at)->u.c.tail) encode(b, C(at)->u.c.head);
        encode(b, at);
        return;
    }
    case K_TUPLE:
        if (c->n < 256) { put8(b, 104); put8(b, c->n); }
        else { put8(b, 105); put32(b, c->n); }
        for (uint32_t i = 0; i < c->n; i++) encode(b, c->u.t[i]);
        return;
    case K_MAP:
        put8(b, 116);
        put32(b, c->n);
        for (uint32_t i = 0; i < c->n; i++) {
            encode(b, c->u.t[i]);
            encode(b, c->u.t[c->n + i]);
        }
        return;
    case K_RAW:
        put(b, c->u.b.data, c->u.b.size);
        return;
    case K_RES:
        put_ref(b, 0, c->u.r->id);
        return;
    default: /* the exception marker */
        encode(b, atom("badarg"));
        return;
    }
}

/* ---- Comparing ----------------------------------------------------------- */

/* Term order: number < atom < reference < fun < port < pid < tuple < map
   < nil < list < bitstring. */
static int order(cell *c) {
    switch (c->kind) {
    case K_INT: case K_BIG: case K_FLOAT: return 0;
    case K_ATOM: return 1;
    case K_RES: return 2;
    case K_TUPLE: return 6;
    case K_MAP: return 7;
    case K_NIL: return 8;
    case K_CONS: return 9;
    case K_BIN: return 10;
    case K_RAW:
        switch (c->tag) {
        case 110: case 111: return 0;
        case 90: case 101: case 114: return 2;
        case 112: case 113: case 117: return 3;
        case 89: case 102: case 120: return 4;
        case 88: case 103: return 5;
        default: return 10;
        }
    default: return 11;
    }
}

static int compare_bytes(const unsigned char *a, size_t an, const unsigned char *b, size_t bn) {
    int d = memcmp(a, b, an < bn ? an : bn);
    if (d) return d < 0 ? -1 : 1;
    return an < bn ? -1 : an > bn;
}

static long double number(cell *c) {
    if (c->kind == K_INT) return c->u.i;
    if (c->kind == K_FLOAT) return c->u.f;
    if (c->kind == K_BIG) return c->tag ? -(long double)c->u.mag : (long double)c->u.mag;
    return 0;
}

static int compare(ERL_NIF_TERM lhs, ERL_NIF_TERM rhs, int exact) {
    if (lhs == rhs) return 0;
    cell *a = C(lhs), *b = C(rhs);
    int oa = order(a), ob = order(b);
    if (oa != ob) return oa < ob ? -1 : 1;
    switch (oa) {
    case 0:
        if (a->kind == K_RAW || b->kind == K_RAW) {
            if (a->kind == K_RAW && b->kind == K_RAW) return compare_bytes(a->u.b.data, a->u.b.size, b->u.b.data, b->u.b.size);
            cell *big = a->kind == K_RAW ? a : b;
            int sign = big->u.b.data[big->tag == 110 ? 2 : 5] ? -1 : 1;
            return a == big ? sign : -sign;
        }
        if (a->kind == K_INT && b->kind == K_INT) return a->u.i < b->u.i ? -1 : a->u.i > b->u.i;
        if (exact && a->kind != b->kind) return a->kind < b->kind ? -1 : 1;
        {
            long double x = number(a), y = number(b);
            return x < y ? -1 : x > y;
        }
    case 1:
        return compare_bytes(a->u.b.data, a->u.b.size, b->u.b.data, b->u.b.size);
    case 6:
        if (a->n != b->n) return a->n < b->n ? -1 : 1;
        for (uint32_t i = 0; i < a->n; i++) {
            int d = compare(a->u.t[i], b->u.t[i], exact);
            if (d) return d;
        }
        return 0;
    case 7:
        if (a->n != b->n) return a->n < b->n ? -1 : 1;
        for (uint32_t i = 0; i < 2 * a->n; i++) {
            int d = compare(a->u.t[i], b->u.t[i], exact);
            if (d) return d;
        }
        return 0;
    case 8:
        return 0;
    case 9:
        for (;;) {
            int d = compare(a->u.c.head, b->u.c.head, exact);
            if (d) return d;
            ERL_NIF_TERM ta = a->u.c.tail, tb = b->u.c.tail;
            if (C(ta)->kind != K_CONS || C(tb)->kind != K_CONS) return compare(ta, tb, exact);
            a = C(ta);
            b = C(tb);
        }
    case 2:
        if (a->kind == K_RES && b->kind == K_RES) return a->u.r == b->u.r ? 0 : a->u.r->id < b->u.r->id ? -1 : 1;
        if (a->kind == K_RES || b->kind == K_RES) return a->kind == K_RES ? -1 : 1;
        /* fall through */
    default:
        return compare_bytes(a->u.b.data, a->u.b.size, b->u.b.data, b->u.b.size);
    }
}

int enif_is_identical(ERL_NIF_TERM lhs, ERL_NIF_TERM rhs) { return compare(lhs, rhs, 1) == 0; }
int enif_compare(ERL_NIF_TERM lhs, ERL_NIF_TERM rhs) { return compare(lhs, rhs, 0); }

/* ---- Copying ------------------------------------------------------------- */

static ERL_NIF_TERM copy(ErlNifEnv *env, ERL_NIF_TERM term) {
    cell *c = C(term);
    switch (c->kind) {
    case K_ATOM: case K_NIL: case K_NONE:
        return term;
    case K_RAW:
        if (c->tag == 88 || c->tag == 103) return term; /* interned */
        /* fall through */
    case K_BIN: {
        cell *out = new_cell(env, c->kind);
        unsigned char *data = env_alloc(env, c->u.b.size);
        memcpy(data, c->u.b.data, c->u.b.size);
        out->tag = c->tag;
        out->u.b.data = data;
        out->u.b.size = c->u.b.size;
        return T(out);
    }
    case K_CONS: {
        cell *first = NULL, *last = NULL;
        ERL_NIF_TERM at = term;
        for (; C(at)->kind == K_CONS; at = C(at)->u.c.tail) {
            cell *out = new_cell(env, K_CONS);
            out->u.c.head = copy(env, C(at)->u.c.head);
            if (last) last->u.c.tail = T(out);
            else first = out;
            last = out;
        }
        last->u.c.tail = copy(env, at);
        return T(first);
    }
    case K_TUPLE: case K_MAP: {
        cell *out = new_cell(env, c->kind);
        size_t n = c->kind == K_MAP ? 2 * (size_t)c->n : c->n;
        out->n = c->n;
        out->u.t = env_alloc(env, n * sizeof(ERL_NIF_TERM));
        for (size_t i = 0; i < n; i++) out->u.t[i] = copy(env, c->u.t[i]);
        return T(out);
    }
    default: {
        cell *out = new_cell(env, c->kind);
        *out = *c;
        return T(out);
    }
    }
}

ERL_NIF_TERM enif_make_copy(ErlNifEnv *dst_env, ERL_NIF_TERM src_term) { return copy(dst_env, src_term); }

/* ---- Memory -------------------------------------------------------------- */

void *enif_alloc(size_t size) { return malloc(size); }
void enif_free(void *ptr) { free(ptr); }
void *enif_realloc(void *ptr, size_t size) { return realloc(ptr, size); }

ErlNifEnv *enif_alloc_env(void) {
    ErlNifEnv *env = calloc(1, sizeof(ErlNifEnv));
    if (!env) abort();
    return env;
}

void enif_free_env(ErlNifEnv *env) {
    env_clear(env);
    free(env->owned);
    free(env);
}

void enif_clear_env(ErlNifEnv *env) { env_clear(env); }

/* ---- Binaries ------------------------------------------------------------- */

int enif_alloc_binary(size_t size, ErlNifBinary *bin) {
    unsigned char *data = malloc(size ? size : 1);
    if (!data) return 0;
    bin->size = size;
    bin->data = data;
    bin->ref_bin = data; /* ours to free */
    return 1;
}

int enif_realloc_binary(ErlNifBinary *bin, size_t size) {
    if (!bin->ref_bin) {
        ErlNifBinary fresh;
        if (!enif_alloc_binary(size, &fresh)) return 0;
        memcpy(fresh.data, bin->data, bin->size < size ? bin->size : size);
        *bin = fresh;
        return 1;
    }
    unsigned char *data = realloc(bin->data, size ? size : 1);
    if (!data) return 0;
    bin->data = data;
    bin->ref_bin = data;
    bin->size = size;
    return 1;
}

void enif_release_binary(ErlNifBinary *bin) {
    if (bin->ref_bin) free(bin->data);
    bin->ref_bin = NULL;
}

static ERL_NIF_TERM make_bin(ErlNifEnv *env, const unsigned char *data, size_t size) {
    cell *c = new_cell(env, K_BIN);
    c->u.b.data = data;
    c->u.b.size = size;
    return T(c);
}

ERL_NIF_TERM enif_make_binary(ErlNifEnv *env, ErlNifBinary *bin) {
    if (bin->ref_bin) {
        env_own(env, bin->data);
        bin->ref_bin = NULL;
    }
    return make_bin(env, bin->data, bin->size);
}

unsigned char *enif_make_new_binary(ErlNifEnv *env, size_t size, ERL_NIF_TERM *termp) {
    unsigned char *data = env_alloc(env, size ? size : 1);
    *termp = make_bin(env, data, size);
    return data;
}

ERL_NIF_TERM enif_make_sub_binary(ErlNifEnv *env, ERL_NIF_TERM bin_term, size_t pos, size_t size) {
    cell *c = C(bin_term);
    return make_bin(env, c->u.b.data + pos, size);
}

ERL_NIF_TERM enif_make_resource_binary(ErlNifEnv *env, void *obj, const void *data, size_t size) {
    (void)obj;
    ERL_NIF_TERM term;
    memcpy(enif_make_new_binary(env, size, &term), data, size);
    return term;
}

int enif_is_binary(ErlNifEnv *env, ERL_NIF_TERM term) { (void)env; return C(term)->kind == K_BIN; }

int enif_inspect_binary(ErlNifEnv *env, ERL_NIF_TERM term, ErlNifBinary *bin) {
    (void)env;
    cell *c = C(term);
    if (c->kind != K_BIN) return 0;
    memset(bin, 0, sizeof *bin);
    bin->data = (unsigned char *)c->u.b.data;
    bin->size = c->u.b.size;
    return 1;
}

/* The size of an iolist's bytes, or -1. */
static long long iolist_size(ERL_NIF_TERM term) {
    cell *c = C(term);
    if (c->kind == K_BIN) return c->u.b.size;
    if (c->kind == K_NIL) return 0;
    if (c->kind != K_CONS) return -1;
    long long size = 0;
    for (; c->kind == K_CONS; c = C(c->u.c.tail)) {
        cell *head = C(c->u.c.head);
        if (head->kind == K_INT) {
            if (head->u.i < 0 || head->u.i > 255) return -1;
            size++;
        } else {
            long long n = iolist_size(c->u.c.head);
            if (n < 0 || head->kind == K_ATOM) return -1;
            size += n;
        }
    }
    if (c->kind == K_NIL) return size;
    if (c->kind == K_BIN) return size + c->u.b.size;
    return -1;
}

static unsigned char *iolist_fill(ERL_NIF_TERM term, unsigned char *at) {
    cell *c = C(term);
    if (c->kind == K_BIN) {
        memcpy(at, c->u.b.data, c->u.b.size);
        return at + c->u.b.size;
    }
    for (; c->kind == K_CONS; c = C(c->u.c.tail)) {
        cell *head = C(c->u.c.head);
        if (head->kind == K_INT) *at++ = head->u.i;
        else at = iolist_fill(c->u.c.head, at);
    }
    if (c->kind == K_BIN) {
        memcpy(at, c->u.b.data, c->u.b.size);
        at += c->u.b.size;
    }
    return at;
}

int enif_inspect_iolist_as_binary(ErlNifEnv *env, ERL_NIF_TERM term, ErlNifBinary *bin) {
    if (C(term)->kind == K_BIN) return enif_inspect_binary(env, term, bin);
    long long size = iolist_size(term);
    if (size < 0) return 0;
    memset(bin, 0, sizeof *bin);
    bin->data = env_alloc(env, size ? size : 1);
    bin->size = size;
    iolist_fill(term, bin->data);
    return 1;
}

int enif_term_to_binary(ErlNifEnv *env, ERL_NIF_TERM term, ErlNifBinary *bin) {
    (void)env;
    buffer b = { 0 };
    put8(&b, 131);
    encode(&b, term);
    bin->data = b.data;
    bin->size = b.size;
    bin->ref_bin = b.data;
    return 1;
}

size_t enif_binary_to_term(ErlNifEnv *env, const unsigned char *data, size_t sz, ERL_NIF_TERM *term, unsigned opts) {
    (void)opts;
    if (sz < 2 || data[0] != 131) return 0;
    unsigned char *copied = env_alloc(env, sz);
    memcpy(copied, data, sz);
    reader r = { copied + 1, copied + sz, env };
    if (!decode(&r, term)) return 0;
    return r.p - copied;
}

/* ---- Atoms ----------------------------------------------------------------- */

int enif_is_atom(ErlNifEnv *env, ERL_NIF_TERM term) { (void)env; return C(term)->kind == K_ATOM; }

ERL_NIF_TERM enif_make_atom(ErlNifEnv *env, const char *name) {
    (void)env;
    return atom_latin1(name, strlen(name));
}

ERL_NIF_TERM enif_make_atom_len(ErlNifEnv *env, const char *name, size_t len) {
    (void)env;
    return atom_latin1(name, len);
}

int enif_make_existing_atom_len(ErlNifEnv *env, const char *name, size_t len, ERL_NIF_TERM *atom, ErlNifCharEncoding enc) {
    (void)env;
    *atom = enc == ERL_NIF_UTF8 ? atom_utf8(name, len) : atom_latin1(name, len);
    return 1;
}

int enif_make_existing_atom(ErlNifEnv *env, const char *name, ERL_NIF_TERM *atom, ErlNifCharEncoding enc) {
    return enif_make_existing_atom_len(env, name, strlen(name), atom, enc);
}

int enif_make_new_atom_len(ErlNifEnv *env, const char *name, size_t len, ERL_NIF_TERM *atom, ErlNifCharEncoding enc) {
    return enif_make_existing_atom_len(env, name, len, atom, enc);
}

int enif_make_new_atom(ErlNifEnv *env, const char *name, ERL_NIF_TERM *atom, ErlNifCharEncoding enc) {
    return enif_make_existing_atom_len(env, name, strlen(name), atom, enc);
}

/* An atom's name in `enc`: its length, or -1 when it does not fit Latin-1. */
static long atom_text(cell *c, char *out, ErlNifCharEncoding enc) {
    if (enc == ERL_NIF_UTF8) {
        if (out) memcpy(out, c->u.b.data, c->u.b.size);
        return c->u.b.size;
    }
    long n = 0;
    for (size_t i = 0; i < c->u.b.size; i++) {
        unsigned ch = c->u.b.data[i];
        if (ch >= 0x80) {
            if ((ch & 0xe0) != 0xc0 || i + 1 >= c->u.b.size) return -1;
            ch = (ch & 0x1f) << 6 | (c->u.b.data[++i] & 0x3f);
            if (ch > 0xff) return -1;
        }
        if (out) out[n] = ch;
        n++;
    }
    return n;
}

int enif_get_atom(ErlNifEnv *env, ERL_NIF_TERM term, char *buf, unsigned len, ErlNifCharEncoding enc) {
    (void)env;
    cell *c = C(term);
    if (c->kind != K_ATOM) return 0;
    long n = atom_text(c, NULL, enc);
    if (n < 0 || (unsigned long)n + 1 > len) return 0;
    atom_text(c, buf, enc);
    buf[n] = 0;
    return n + 1;
}

int enif_get_atom_length(ErlNifEnv *env, ERL_NIF_TERM term, unsigned *len, ErlNifCharEncoding enc) {
    (void)env;
    cell *c = C(term);
    if (c->kind != K_ATOM) return 0;
    long n = atom_text(c, NULL, enc);
    if (n < 0) return 0;
    *len = n;
    return 1;
}

/* ---- Numbers --------------------------------------------------------------- */

int enif_is_number(ErlNifEnv *env, ERL_NIF_TERM term) { (void)env; return order(C(term)) == 0; }

ERL_NIF_TERM enif_make_int(ErlNifEnv *env, int i) { return make_int(env, i); }
ERL_NIF_TERM enif_make_uint(ErlNifEnv *env, unsigned i) { return make_int(env, i); }
ERL_NIF_TERM enif_make_long(ErlNifEnv *env, long i) { return make_int(env, i); }
ERL_NIF_TERM enif_make_ulong(ErlNifEnv *env, unsigned long i) { return make_int(env, i); }
ERL_NIF_TERM enif_make_int64(ErlNifEnv *env, ErlNifSInt64 i) { return make_int(env, i); }

ERL_NIF_TERM enif_make_uint64(ErlNifEnv *env, ErlNifUInt64 i) {
    if (i <= INT64_MAX) return make_int(env, (int64_t)i);
    cell *c = new_cell(env, K_BIG);
    c->u.mag = i;
    return T(c);
}

ERL_NIF_TERM enif_make_double(ErlNifEnv *env, double d) {
    if (d != d || d - d != 0) return enif_make_badarg(env);
    cell *c = new_cell(env, K_FLOAT);
    c->u.f = d;
    return T(c);
}

static int get_signed(ERL_NIF_TERM term, int64_t min, int64_t max, int64_t *out) {
    cell *c = C(term);
    if (c->kind != K_INT || c->u.i < min || c->u.i > max) return 0;
    *out = c->u.i;
    return 1;
}

static int get_unsigned(ERL_NIF_TERM term, uint64_t max, uint64_t *out) {
    cell *c = C(term);
    if (c->kind == K_INT && c->u.i >= 0 && (uint64_t)c->u.i <= max) *out = c->u.i;
    else if (c->kind == K_BIG && !c->tag && c->u.mag <= max) *out = c->u.mag;
    else return 0;
    return 1;
}

int enif_get_int(ErlNifEnv *env, ERL_NIF_TERM term, int *ip) {
    (void)env;
    int64_t v;
    if (!get_signed(term, INT32_MIN, INT32_MAX, &v)) return 0;
    *ip = v;
    return 1;
}

int enif_get_long(ErlNifEnv *env, ERL_NIF_TERM term, long *ip) {
    (void)env;
    int64_t v;
    if (!get_signed(term, LONG_MIN, LONG_MAX, &v)) return 0;
    *ip = v;
    return 1;
}

int enif_get_int64(ErlNifEnv *env, ERL_NIF_TERM term, ErlNifSInt64 *ip) {
    (void)env;
    int64_t v;
    if (!get_signed(term, INT64_MIN, INT64_MAX, &v)) return 0;
    *ip = v;
    return 1;
}

int enif_get_uint(ErlNifEnv *env, ERL_NIF_TERM term, unsigned *ip) {
    (void)env;
    uint64_t v;
    if (!get_unsigned(term, UINT32_MAX, &v)) return 0;
    *ip = v;
    return 1;
}

int enif_get_ulong(ErlNifEnv *env, ERL_NIF_TERM term, unsigned long *ip) {
    (void)env;
    uint64_t v;
    if (!get_unsigned(term, ULONG_MAX, &v)) return 0;
    *ip = v;
    return 1;
}

int enif_get_uint64(ErlNifEnv *env, ERL_NIF_TERM term, ErlNifUInt64 *ip) {
    (void)env;
    uint64_t v;
    if (!get_unsigned(term, UINT64_MAX, &v)) return 0;
    *ip = v;
    return 1;
}

int enif_get_double(ErlNifEnv *env, ERL_NIF_TERM term, double *dp) {
    (void)env;
    cell *c = C(term);
    if (c->kind != K_FLOAT) return 0;
    *dp = c->u.f;
    return 1;
}

/* ---- Lists and strings ------------------------------------------------------ */

int enif_is_list(ErlNifEnv *env, ERL_NIF_TERM term) {
    (void)env;
    return C(term)->kind == K_CONS || C(term)->kind == K_NIL;
}

int enif_is_empty_list(ErlNifEnv *env, ERL_NIF_TERM term) { (void)env; return C(term)->kind == K_NIL; }

ERL_NIF_TERM enif_make_list_cell(ErlNifEnv *env, ERL_NIF_TERM car, ERL_NIF_TERM cdr) {
    cell *c = new_cell(env, K_CONS);
    c->u.c.head = car;
    c->u.c.tail = cdr;
    return T(c);
}

ERL_NIF_TERM enif_make_list_from_array(ErlNifEnv *env, const ERL_NIF_TERM arr[], unsigned cnt) {
    ERL_NIF_TERM list = T(&nil);
    for (unsigned i = cnt; i-- > 0;) list = enif_make_list_cell(env, arr[i], list);
    return list;
}

ERL_NIF_TERM enif_make_list(ErlNifEnv *env, unsigned cnt, ...) {
    ERL_NIF_TERM *items = env_alloc(env, (cnt ? cnt : 1) * sizeof(ERL_NIF_TERM));
    va_list ap;
    va_start(ap, cnt);
    for (unsigned i = 0; i < cnt; i++) items[i] = va_arg(ap, ERL_NIF_TERM);
    va_end(ap);
    return enif_make_list_from_array(env, items, cnt);
}

int enif_get_list_cell(ErlNifEnv *env, ERL_NIF_TERM term, ERL_NIF_TERM *head, ERL_NIF_TERM *tail) {
    (void)env;
    cell *c = C(term);
    if (c->kind != K_CONS) return 0;
    *head = c->u.c.head;
    *tail = c->u.c.tail;
    return 1;
}

int enif_get_list_length(ErlNifEnv *env, ERL_NIF_TERM term, unsigned *len) {
    (void)env;
    unsigned n = 0;
    cell *c = C(term);
    for (; c->kind == K_CONS; c = C(c->u.c.tail)) n++;
    if (c->kind != K_NIL) return 0;
    *len = n;
    return 1;
}

int enif_make_reverse_list(ErlNifEnv *env, ERL_NIF_TERM term, ERL_NIF_TERM *list) {
    ERL_NIF_TERM out = T(&nil);
    cell *c = C(term);
    for (; c->kind == K_CONS; c = C(c->u.c.tail)) out = enif_make_list_cell(env, c->u.c.head, out);
    if (c->kind != K_NIL) return 0;
    *list = out;
    return 1;
}

static size_t utf8_put(unsigned char *out, uint32_t cp) {
    if (cp < 0x80) { out[0] = cp; return 1; }
    if (cp < 0x800) { out[0] = 0xc0 | cp >> 6; out[1] = 0x80 | (cp & 0x3f); return 2; }
    if (cp < 0x10000) {
        out[0] = 0xe0 | cp >> 12; out[1] = 0x80 | (cp >> 6 & 0x3f); out[2] = 0x80 | (cp & 0x3f);
        return 3;
    }
    out[0] = 0xf0 | cp >> 18; out[1] = 0x80 | (cp >> 12 & 0x3f);
    out[2] = 0x80 | (cp >> 6 & 0x3f); out[3] = 0x80 | (cp & 0x3f);
    return 4;
}

/* A charlist's bytes in `enc` (to `buf`, when there is one): its length, or -1. */
static long string_bytes(ERL_NIF_TERM list, char *buf, size_t room, ErlNifCharEncoding enc, int *truncated) {
    long n = 0;
    cell *c = C(list);
    for (; c->kind == K_CONS; c = C(c->u.c.tail)) {
        cell *head = C(c->u.c.head);
        if (head->kind != K_INT || head->u.i < 0) return -1;
        int64_t cp = head->u.i;
        unsigned char bytes[4];
        size_t size;
        if (enc == ERL_NIF_UTF8) {
            if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return -1;
            size = utf8_put(bytes, cp);
        } else {
            if (cp > 255) return -1;
            bytes[0] = cp;
            size = 1;
        }
        if (buf && !*truncated) {
            if ((size_t)n + size < room) memcpy(buf + n, bytes, size);
            else *truncated = 1;
        }
        if (!buf || !*truncated) n += size;
    }
    return c->kind == K_NIL ? n : -1;
}

int enif_get_string(ErlNifEnv *env, ERL_NIF_TERM list, char *buf, unsigned len, ErlNifCharEncoding enc) {
    (void)env;
    if (len < 1) return 0;
    int truncated = 0;
    long n = string_bytes(list, buf, len, enc, &truncated);
    if (n < 0) return 0;
    buf[n] = 0;
    return truncated ? -(int)len : (int)n + 1;
}

int enif_get_string_length(ErlNifEnv *env, ERL_NIF_TERM list, unsigned *len, ErlNifCharEncoding enc) {
    (void)env;
    int truncated = 0;
    long n = string_bytes(list, NULL, 0, enc, &truncated);
    if (n < 0) return 0;
    *len = n;
    return 1;
}

ERL_NIF_TERM enif_make_string_len(ErlNifEnv *env, const char *string, size_t len, ErlNifCharEncoding enc) {
    const unsigned char *s = (const unsigned char *)string;
    ERL_NIF_TERM *items = env_alloc(env, (len ? len : 1) * sizeof(ERL_NIF_TERM));
    unsigned n = 0;
    for (size_t i = 0; i < len;) {
        uint32_t cp = s[i++];
        if (enc == ERL_NIF_UTF8 && cp >= 0x80) {
            int more = cp >= 0xf0 ? 3 : cp >= 0xe0 ? 2 : 1;
            cp &= 0x3f >> more;
            for (int k = 0; k < more && i < len; k++) cp = cp << 6 | (s[i++] & 0x3f);
        }
        items[n++] = make_int(env, cp);
    }
    return enif_make_list_from_array(env, items, n);
}

ERL_NIF_TERM enif_make_string(ErlNifEnv *env, const char *string, ErlNifCharEncoding enc) {
    return enif_make_string_len(env, string, strlen(string), enc);
}

/* ---- Tuples and maps ----------------------------------------------------------- */

int enif_is_tuple(ErlNifEnv *env, ERL_NIF_TERM term) { (void)env; return C(term)->kind == K_TUPLE; }

ERL_NIF_TERM enif_make_tuple_from_array(ErlNifEnv *env, const ERL_NIF_TERM arr[], unsigned cnt) {
    cell *c = new_cell(env, K_TUPLE);
    c->n = cnt;
    c->u.t = env_alloc(env, (cnt ? cnt : 1) * sizeof(ERL_NIF_TERM));
    memcpy(c->u.t, arr, cnt * sizeof(ERL_NIF_TERM));
    return T(c);
}

ERL_NIF_TERM enif_make_tuple(ErlNifEnv *env, unsigned cnt, ...) {
    cell *c = new_cell(env, K_TUPLE);
    c->n = cnt;
    c->u.t = env_alloc(env, (cnt ? cnt : 1) * sizeof(ERL_NIF_TERM));
    va_list ap;
    va_start(ap, cnt);
    for (unsigned i = 0; i < cnt; i++) c->u.t[i] = va_arg(ap, ERL_NIF_TERM);
    va_end(ap);
    return T(c);
}

int enif_get_tuple(ErlNifEnv *env, ERL_NIF_TERM tpl, int *arity, const ERL_NIF_TERM **array) {
    (void)env;
    cell *c = C(tpl);
    if (c->kind != K_TUPLE) return 0;
    *arity = c->n;
    *array = c->u.t;
    return 1;
}

int enif_is_map(ErlNifEnv *env, ERL_NIF_TERM term) { (void)env; return C(term)->kind == K_MAP; }

static ERL_NIF_TERM make_map(ErlNifEnv *env, size_t n) {
    cell *c = new_cell(env, K_MAP);
    c->n = n;
    c->u.t = env_alloc(env, (n ? 2 * n : 1) * sizeof(ERL_NIF_TERM));
    return T(c);
}

static long map_find(cell *map, ERL_NIF_TERM key) {
    for (uint32_t i = 0; i < map->n; i++)
        if (enif_is_identical(map->u.t[i], key)) return i;
    return -1;
}

ERL_NIF_TERM enif_make_new_map(ErlNifEnv *env) { return make_map(env, 0); }

int enif_get_map_size(ErlNifEnv *env, ERL_NIF_TERM term, size_t *size) {
    (void)env;
    if (C(term)->kind != K_MAP) return 0;
    *size = C(term)->n;
    return 1;
}

int enif_get_map_value(ErlNifEnv *env, ERL_NIF_TERM map, ERL_NIF_TERM key, ERL_NIF_TERM *value) {
    (void)env;
    cell *m = C(map);
    if (m->kind != K_MAP) return 0;
    long at = map_find(m, key);
    if (at < 0) return 0;
    *value = m->u.t[m->n + at];
    return 1;
}

int enif_make_map_put(ErlNifEnv *env, ERL_NIF_TERM map_in, ERL_NIF_TERM key, ERL_NIF_TERM value, ERL_NIF_TERM *map_out) {
    cell *m = C(map_in);
    if (m->kind != K_MAP) return 0;
    long at = map_find(m, key);
    size_t n = m->n + (at < 0);
    cell *out = C(make_map(env, n));
    for (uint32_t i = 0; i < m->n; i++) {
        out->u.t[i] = m->u.t[i];
        out->u.t[n + i] = (long)i == at ? value : m->u.t[m->n + i];
    }
    if (at < 0) {
        out->u.t[n - 1] = key;
        out->u.t[2 * n - 1] = value;
    }
    *map_out = T(out);
    return 1;
}

int enif_make_map_update(ErlNifEnv *env, ERL_NIF_TERM map_in, ERL_NIF_TERM key, ERL_NIF_TERM value, ERL_NIF_TERM *map_out) {
    if (C(map_in)->kind != K_MAP || map_find(C(map_in), key) < 0) return 0;
    return enif_make_map_put(env, map_in, key, value, map_out);
}

int enif_make_map_remove(ErlNifEnv *env, ERL_NIF_TERM map_in, ERL_NIF_TERM key, ERL_NIF_TERM *map_out) {
    cell *m = C(map_in);
    if (m->kind != K_MAP) return 0;
    long at = map_find(m, key);
    if (at < 0) {
        *map_out = map_in;
        return 1;
    }
    size_t n = m->n - 1;
    cell *out = C(make_map(env, n));
    for (uint32_t i = 0, j = 0; i < m->n; i++) {
        if ((long)i == at) continue;
        out->u.t[j] = m->u.t[i];
        out->u.t[n + j] = m->u.t[m->n + i];
        j++;
    }
    *map_out = T(out);
    return 1;
}

int enif_make_map_from_arrays(ErlNifEnv *env, ERL_NIF_TERM keys[], ERL_NIF_TERM values[], size_t cnt, ERL_NIF_TERM *map_out) {
    cell *out = C(make_map(env, cnt));
    for (size_t i = 0; i < cnt; i++) {
        out->n = i;
        if (map_find(out, keys[i]) >= 0) return 0;
        out->u.t[i] = keys[i];
    }
    out->n = cnt;
    memcpy(out->u.t + cnt, values, cnt * sizeof(ERL_NIF_TERM));
    *map_out = T(out);
    return 1;
}

/* idx runs from -1 (before the head) to size (past the tail). */
int enif_map_iterator_create(ErlNifEnv *env, ERL_NIF_TERM map, ErlNifMapIterator *iter, ErlNifMapIteratorEntry entry) {
    (void)env;
    if (C(map)->kind != K_MAP) return 0;
    memset(iter, 0, sizeof *iter);
    iter->map = map;
    iter->size = C(map)->n;
    iter->idx = entry == ERL_NIF_MAP_ITERATOR_LAST ? iter->size - 1 : 0;
    return 1;
}

void enif_map_iterator_destroy(ErlNifEnv *env, ErlNifMapIterator *iter) { (void)env; (void)iter; }

int enif_map_iterator_is_head(ErlNifEnv *env, ErlNifMapIterator *iter) {
    (void)env;
    return iter->idx == (ERL_NIF_UINT)-1;
}

int enif_map_iterator_is_tail(ErlNifEnv *env, ErlNifMapIterator *iter) {
    (void)env;
    return iter->idx == iter->size;
}

int enif_map_iterator_next(ErlNifEnv *env, ErlNifMapIterator *iter) {
    (void)env;
    if (iter->idx == iter->size) return 0;
    iter->idx++;
    return iter->idx != iter->size;
}

int enif_map_iterator_prev(ErlNifEnv *env, ErlNifMapIterator *iter) {
    (void)env;
    if (iter->idx == (ERL_NIF_UINT)-1) return 0;
    iter->idx--;
    return iter->idx != (ERL_NIF_UINT)-1;
}

int enif_map_iterator_get_pair(ErlNifEnv *env, ErlNifMapIterator *iter, ERL_NIF_TERM *key, ERL_NIF_TERM *value) {
    (void)env;
    if (iter->idx == (ERL_NIF_UINT)-1 || iter->idx >= iter->size) return 0;
    cell *m = C(iter->map);
    *key = m->u.t[iter->idx];
    *value = m->u.t[m->n + iter->idx];
    return 1;
}

/* ---- Pids, ports, references, funs ------------------------------------------- */

static int is_raw(ERL_NIF_TERM term, int a, int b, int c) {
    cell *x = C(term);
    return x->kind == K_RAW && (x->tag == a || x->tag == b || x->tag == c);
}

int enif_is_pid(ErlNifEnv *env, ERL_NIF_TERM term) { (void)env; return is_raw(term, 88, 103, 0); }
int enif_is_port(ErlNifEnv *env, ERL_NIF_TERM term) { (void)env; return is_raw(term, 89, 102, 120); }
int enif_is_fun(ErlNifEnv *env, ERL_NIF_TERM term) { (void)env; return is_raw(term, 112, 113, 117); }

int enif_is_ref(ErlNifEnv *env, ERL_NIF_TERM term) {
    (void)env;
    return C(term)->kind == K_RES || is_raw(term, 90, 101, 114);
}

int enif_get_local_pid(ErlNifEnv *env, ERL_NIF_TERM term, ErlNifPid *pid) {
    (void)env;
    if (!enif_is_pid(env, term)) return 0;
    pid->pid = term;
    return 1;
}

int enif_get_local_port(ErlNifEnv *env, ERL_NIF_TERM term, ErlNifPort *port) {
    (void)env;
    if (!enif_is_port(env, term)) return 0;
    port->port_id = term;
    return 1;
}

ErlNifPid *enif_self(ErlNifEnv *env, ErlNifPid *pid) {
    if (!env || !env->self) return NULL;
    pid->pid = env->self;
    return pid;
}

void enif_set_pid_undefined(ErlNifPid *pid) { pid->pid = 0; }
int enif_is_pid_undefined(const ErlNifPid *pid) { return pid->pid == 0; }
int enif_is_process_alive(ErlNifEnv *env, ErlNifPid *pid) { (void)env; return pid && pid->pid; }
int enif_is_current_process_alive(ErlNifEnv *env) { (void)env; return 1; }
int enif_is_port_alive(ErlNifEnv *env, ErlNifPort *port) { (void)env; (void)port; return 0; }
int enif_whereis_pid(ErlNifEnv *env, ERL_NIF_TERM name, ErlNifPid *pid) { (void)env; (void)name; (void)pid; return 0; }
int enif_whereis_port(ErlNifEnv *env, ERL_NIF_TERM name, ErlNifPort *port) { (void)env; (void)name; (void)port; return 0; }

int enif_port_command(ErlNifEnv *env, const ErlNifPort *to_port, ErlNifEnv *msg_env, ERL_NIF_TERM msg) {
    (void)env; (void)to_port; (void)msg_env; (void)msg;
    return 0;
}

static ERL_NIF_TERM make_ref(ErlNifEnv *env, uint64_t id) {
    buffer out = { 0 };
    put_ref(&out, 1, id);
    unsigned char *data = env_alloc(env, out.size);
    memcpy(data, out.data, out.size);
    free(out.data);
    return raw(env, data, data + out.size);
}

ERL_NIF_TERM enif_make_ref(ErlNifEnv *env) { return make_ref(env, next_ref++); }

/* Monitors: accepted, and never fire. */
int enif_monitor_process(ErlNifEnv *env, void *obj, const ErlNifPid *pid, ErlNifMonitor *monitor) {
    (void)env; (void)obj; (void)pid;
    if (monitor) {
        memset(monitor, 0, sizeof *monitor);
        uint64_t id = next_ref++;
        memcpy(monitor->data, &id, sizeof id);
    }
    return 0;
}

int enif_demonitor_process(ErlNifEnv *env, void *obj, const ErlNifMonitor *monitor) {
    (void)env; (void)obj; (void)monitor;
    return 0;
}

int enif_compare_monitors(const ErlNifMonitor *a, const ErlNifMonitor *b) {
    int d = memcmp(a->data, b->data, sizeof a->data);
    return d < 0 ? -1 : d > 0;
}

ERL_NIF_TERM enif_make_monitor_term(ErlNifEnv *env, const ErlNifMonitor *monitor) {
    uint64_t id;
    memcpy(&id, monitor->data, sizeof id);
    return make_ref(env, id);
}

int enif_select(ErlNifEnv *env, ErlNifEvent e, enum ErlNifSelectFlags flags, void *obj, const ErlNifPid *pid, ERL_NIF_TERM ref) {
    (void)env; (void)e; (void)flags; (void)obj; (void)pid; (void)ref;
    return ERL_NIF_SELECT_NOTSUP | ERL_NIF_SELECT_FAILED;
}

int enif_select_x(ErlNifEnv *env, ErlNifEvent e, enum ErlNifSelectFlags flags, void *obj, const ErlNifPid *pid, ERL_NIF_TERM msg, ErlNifEnv *msg_env) {
    (void)env; (void)e; (void)flags; (void)obj; (void)pid; (void)msg; (void)msg_env;
    return ERL_NIF_SELECT_NOTSUP | ERL_NIF_SELECT_FAILED;
}

/* ---- Sending ----------------------------------------------------------------- */

static ERL_NIF_TERM outbox; /* [{Pid, Message}], newest first; 0 when empty */

int enif_send(ErlNifEnv *env, const ErlNifPid *to_pid, ErlNifEnv *msg_env, ERL_NIF_TERM msg) {
    (void)env;
    if (!to_pid || !to_pid->pid) return 0;
    ERL_NIF_TERM pair = enif_make_tuple(&outbox_env, 2, to_pid->pid, copy(&outbox_env, msg));
    outbox = enif_make_list_cell(&outbox_env, pair, outbox ? outbox : T(&nil));
    if (msg_env) env_clear(msg_env);
    return 1;
}

/* ---- Exceptions ----------------------------------------------------------------- */

ERL_NIF_TERM enif_raise_exception(ErlNifEnv *env, ERL_NIF_TERM reason) {
    env->has_exception = 1;
    env->exception = reason;
    return T(&none);
}

ERL_NIF_TERM enif_make_badarg(ErlNifEnv *env) { return enif_raise_exception(env, atom("badarg")); }

int enif_has_pending_exception(ErlNifEnv *env, ERL_NIF_TERM *reason) {
    if (env->has_exception && reason) *reason = env->exception;
    return env->has_exception;
}

int enif_is_exception(ErlNifEnv *env, ERL_NIF_TERM term) { (void)env; return term == T(&none); }

/* ---- Resources ------------------------------------------------------------------ */

static ErlNifResourceType *open_type(const char *name, const ErlNifResourceTypeInit *init, ErlNifResourceFlags flags, ErlNifResourceFlags *tried) {
    ErlNifResourceType *type = resource_types;
    while (type && strcmp(type->name, name)) type = type->next;
    if (type && !(flags & ERL_NIF_RT_TAKEOVER)) return NULL;
    if (!type) {
        if (!(flags & ERL_NIF_RT_CREATE)) return NULL;
        type = calloc(1, sizeof *type);
        type->name = strdup(name);
        type->next = resource_types;
        resource_types = type;
    }
    type->init = *init;
    if (tried) *tried = flags;
    return type;
}

ErlNifResourceType *enif_open_resource_type(ErlNifEnv *env, const char *module_str, const char *name_str, void (*dtor)(ErlNifEnv *, void *), ErlNifResourceFlags flags, ErlNifResourceFlags *tried) {
    (void)env; (void)module_str;
    ErlNifResourceTypeInit init = { 0 };
    init.dtor = dtor;
    return open_type(name_str, &init, flags, tried);
}

ErlNifResourceType *enif_open_resource_type_x(ErlNifEnv *env, const char *name_str, const ErlNifResourceTypeInit *init, ErlNifResourceFlags flags, ErlNifResourceFlags *tried) {
    (void)env;
    ErlNifResourceTypeInit copied = { 0 };
    copied.dtor = init->dtor;
    copied.stop = init->stop;
    copied.down = init->down;
    return open_type(name_str, &copied, flags, tried);
}

ErlNifResourceType *enif_init_resource_type(ErlNifEnv *env, const char *name_str, const ErlNifResourceTypeInit *init, ErlNifResourceFlags flags, ErlNifResourceFlags *tried) {
    (void)env;
    ErlNifResourceTypeInit copied = { 0 };
    copied.dtor = init->dtor;
    copied.stop = init->stop;
    copied.down = init->down;
    if (init->members >= 5) copied.dyncall = init->dyncall;
    return open_type(name_str, &copied, flags, tried);
}

void *enif_alloc_resource(ErlNifResourceType *type, size_t size) {
    resource *r = malloc(sizeof(resource) + size);
    if (!r) return NULL;
    if (next_resource >= resources_cap) {
        uint32_t cap = resources_cap ? 2 * resources_cap : 64;
        resources = realloc(resources, cap * sizeof(resource *));
        if (!resources) abort();
        memset(resources + resources_cap, 0, (cap - resources_cap) * sizeof(resource *));
        resources_cap = cap;
    }
    r->type = type;
    r->size = size;
    r->id = next_resource++;
    r->refs = 1;
    r->crossed = 0;
    resources[r->id] = r;
    return OBJECT(r);
}

void enif_keep_resource(void *obj) { HEADER(obj)->refs++; }

void enif_release_resource(void *obj) {
    resource *r = HEADER(obj);
    if (--r->refs == 0) destroy(r);
}

size_t enif_sizeof_resource(void *obj) { return HEADER(obj)->size; }

ERL_NIF_TERM enif_make_resource(ErlNifEnv *env, void *obj) {
    resource *r = HEADER(obj);
    if (!r->crossed) {
        r->crossed = 1;
        r->refs++;
    }
    cell *c = new_cell(env, K_RES);
    c->u.r = r;
    return T(c);
}

int enif_get_resource(ErlNifEnv *env, ERL_NIF_TERM term, ErlNifResourceType *type, void **objp) {
    (void)env;
    cell *c = C(term);
    if (c->kind != K_RES || c->u.r->type != type) return 0;
    *objp = OBJECT(c->u.r);
    return 1;
}

int enif_dynamic_resource_call(ErlNifEnv *env, ERL_NIF_TERM mod, ERL_NIF_TERM name, ERL_NIF_TERM rsrc, void *call_data) {
    (void)env; (void)mod; (void)name; (void)rsrc; (void)call_data;
    return 1;
}

/* ---- Time, system, scheduling ------------------------------------------------------- */

static int64_t clock_ns(clockid_t id) {
    struct timespec ts;
    clock_gettime(id, &ts);
    return (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
}

static const int64_t PER_SECOND[] = { 1, 1000, 1000000, 1000000000 };

static int64_t floor_div(int64_t a, int64_t b) {
    int64_t q = a / b;
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q;
}

ErlNifTime enif_convert_time_unit(ErlNifTime val, ErlNifTimeUnit from, ErlNifTimeUnit to) {
    if (from < ERL_NIF_SEC || from > ERL_NIF_NSEC || to < ERL_NIF_SEC || to > ERL_NIF_NSEC) return ERL_NIF_TIME_ERROR;
    if (from == to) return val;
    if (from < to) return val * (PER_SECOND[to] / PER_SECOND[from]);
    return floor_div(val, PER_SECOND[from] / PER_SECOND[to]);
}

ErlNifTime enif_monotonic_time(ErlNifTimeUnit unit) {
    return enif_convert_time_unit(clock_ns(CLOCK_MONOTONIC), ERL_NIF_NSEC, unit);
}

ErlNifTime enif_time_offset(ErlNifTimeUnit unit) {
    return enif_convert_time_unit(clock_ns(CLOCK_REALTIME) - clock_ns(CLOCK_MONOTONIC), ERL_NIF_NSEC, unit);
}

static ERL_NIF_TERM now_tuple(ErlNifEnv *env, int64_t us) {
    return enif_make_tuple(env, 3, make_int(env, us / 1000000000000), make_int(env, us / 1000000 % 1000000), make_int(env, us % 1000000));
}

ERL_NIF_TERM enif_now_time(ErlNifEnv *env) { return now_tuple(env, clock_ns(CLOCK_REALTIME) / 1000); }
ERL_NIF_TERM enif_cpu_time(ErlNifEnv *env) { return now_tuple(env, clock_ns(CLOCK_MONOTONIC) / 1000); }

ERL_NIF_TERM enif_make_unique_integer(ErlNifEnv *env, ErlNifUniqueInteger properties) {
    static int64_t next = 1;
    (void)properties;
    return make_int(env, next++);
}

void enif_system_info(ErlNifSysInfo *sip, size_t si_size) {
    ErlNifSysInfo info = { 0 };
    info.driver_major_version = 3;
    info.driver_minor_version = 3;
    info.erts_version = "16.1.1";
    info.otp_release = "29";
    info.thread_support = 0;
    info.smp_support = 1;
    info.async_threads = 0;
    info.scheduler_threads = 1;
    info.nif_major_version = ERL_NIF_MAJOR_VERSION;
    info.nif_minor_version = ERL_NIF_MINOR_VERSION;
    info.dirty_scheduler_support = 1;
    memcpy(sip, &info, si_size < sizeof info ? si_size : sizeof info);
}

int enif_getenv(const char *key, char *value, size_t *value_size) {
    const char *found = getenv(key);
    if (!found) return -1;
    size_t n = strlen(found);
    if (n + 1 > *value_size) {
        *value_size = n + 1;
        return 1;
    }
    memcpy(value, found, n + 1);
    *value_size = n;
    return 0;
}

int enif_consume_timeslice(ErlNifEnv *env, int percent) { (void)env; (void)percent; return 0; }

static int thread_type = ERL_NIF_THR_NORMAL_SCHEDULER;
int enif_thread_type(void) { return thread_type; }

ERL_NIF_TERM enif_schedule_nif(ErlNifEnv *env, const char *name, int flags, ERL_NIF_TERM (*fp)(ErlNifEnv *, int, const ERL_NIF_TERM[]), int argc, const ERL_NIF_TERM argv[]) {
    (void)name;
    int saved = thread_type;
    thread_type = flags & ERL_NIF_DIRTY_JOB_IO_BOUND ? ERL_NIF_THR_DIRTY_IO_SCHEDULER
        : flags & ERL_NIF_DIRTY_JOB_CPU_BOUND ? ERL_NIF_THR_DIRTY_CPU_SCHEDULER : ERL_NIF_THR_NORMAL_SCHEDULER;
    ERL_NIF_TERM result = fp(env, argc, argv);
    thread_type = saved;
    return result;
}

int enif_set_option(ErlNifEnv *env, ErlNifOption opt, ...) { (void)env; (void)opt; return 0; }

void *enif_dlopen(const char *lib, void (*err_handler)(void *, const char *), void *err_arg) {
    (void)lib;
    if (err_handler) err_handler(err_arg, "dynamic loading is not supported in WebAssembly");
    return NULL;
}

void *enif_dlsym(void *handle, const char *symbol, void (*err_handler)(void *, const char *), void *err_arg) {
    (void)handle; (void)symbol;
    if (err_handler) err_handler(err_arg, "dynamic loading is not supported in WebAssembly");
    return NULL;
}

ErlNifUInt64 enif_hash(ErlNifHash type, ERL_NIF_TERM term, ErlNifUInt64 salt) {
    (void)type;
    buffer b = { 0 };
    encode(&b, term);
    uint64_t h = 14695981039346656037ull ^ salt;
    for (size_t i = 0; i < b.size; i++) h = (h ^ b.data[i]) * 1099511628211ull;
    free(b.data);
    return type == ERL_NIF_PHASH2 ? h & ((1u << 27) - 1) : h;
}

size_t enif_term_size(ERL_NIF_TERM term) {
    buffer b = { 0 };
    encode(&b, term);
    free(b.data);
    return b.size;
}

ErlNifTermType enif_term_type(ErlNifEnv *env, ERL_NIF_TERM term) {
    (void)env;
    switch (order(C(term))) {
    case 0: return C(term)->kind == K_FLOAT ? ERL_NIF_TERM_TYPE_FLOAT : ERL_NIF_TERM_TYPE_INTEGER;
    case 1: return ERL_NIF_TERM_TYPE_ATOM;
    case 2: return ERL_NIF_TERM_TYPE_REFERENCE;
    case 3: return ERL_NIF_TERM_TYPE_FUN;
    case 4: return ERL_NIF_TERM_TYPE_PORT;
    case 5: return ERL_NIF_TERM_TYPE_PID;
    case 6: return ERL_NIF_TERM_TYPE_TUPLE;
    case 7: return ERL_NIF_TERM_TYPE_MAP;
    case 8: case 9: return ERL_NIF_TERM_TYPE_LIST;
    default: return ERL_NIF_TERM_TYPE_BITSTRING;
    }
}

int enif_get_atom_cache_index(ErlNifEnv *env, ERL_NIF_TERM atom, unsigned *index) { (void)env; (void)atom; (void)index; return 0; }
unsigned enif_max_atom_cache_index(void) { return 0; }

/* ---- Threads: one --------------------------------------------------------------- */

struct ErlDrvMutex_ { char *name; };
struct ErlDrvCond_ { char *name; };
struct ErlDrvRWLock_ { char *name; };
struct ErlDrvTid_ { char *name; };

static struct ErlDrvTid_ main_thread = { "main" };

#define LOCK(type, kind)                                                       \
    type *enif_##kind##_create(char *name) {                                   \
        type *lock = calloc(1, sizeof(type));                                  \
        if (lock) lock->name = name;                                           \
        return lock;                                                           \
    }                                                                          \
    void enif_##kind##_destroy(type *lock) { free(lock); }                     \
    char *enif_##kind##_name(type *lock) { return lock->name; }

LOCK(ErlNifMutex, mutex)
LOCK(ErlNifCond, cond)
LOCK(ErlNifRWLock, rwlock)

int enif_mutex_trylock(ErlNifMutex *mtx) { (void)mtx; return 0; }
void enif_mutex_lock(ErlNifMutex *mtx) { (void)mtx; }
void enif_mutex_unlock(ErlNifMutex *mtx) { (void)mtx; }
void enif_cond_signal(ErlNifCond *cnd) { (void)cnd; }
void enif_cond_broadcast(ErlNifCond *cnd) { (void)cnd; }

void enif_cond_wait(ErlNifCond *cnd, ErlNifMutex *mtx) {
    (void)cnd; (void)mtx;
    fprintf(stderr, "enif_cond_wait: there is no other thread to wait for\n");
    abort();
}

int enif_rwlock_tryrlock(ErlNifRWLock *l) { (void)l; return 0; }
void enif_rwlock_rlock(ErlNifRWLock *l) { (void)l; }
void enif_rwlock_runlock(ErlNifRWLock *l) { (void)l; }
int enif_rwlock_tryrwlock(ErlNifRWLock *l) { (void)l; return 0; }
void enif_rwlock_rwlock(ErlNifRWLock *l) { (void)l; }
void enif_rwlock_rwunlock(ErlNifRWLock *l) { (void)l; }

static void *tsd[128];
static int tsd_next;

int enif_tsd_key_create(char *name, ErlNifTSDKey *key) {
    (void)name;
    if (tsd_next >= 128) return ENOMEM;
    *key = tsd_next++;
    return 0;
}

void enif_tsd_key_destroy(ErlNifTSDKey key) { tsd[key] = NULL; }
void enif_tsd_set(ErlNifTSDKey key, void *data) { tsd[key] = data; }
void *enif_tsd_get(ErlNifTSDKey key) { return tsd[key]; }

ErlNifThreadOpts *enif_thread_opts_create(char *name) { (void)name; return calloc(1, sizeof(ErlNifThreadOpts)); }
void enif_thread_opts_destroy(ErlNifThreadOpts *opts) { free(opts); }

int enif_thread_create(char *name, ErlNifTid *tid, void *(*func)(void *), void *args, ErlNifThreadOpts *opts) {
    (void)name; (void)tid; (void)func; (void)args; (void)opts;
    return ENOTSUP;
}

ErlNifTid enif_thread_self(void) { return &main_thread; }
int enif_equal_tids(ErlNifTid a, ErlNifTid b) { return a == b; }
void enif_thread_exit(void *resp) { (void)resp; abort(); }
int enif_thread_join(ErlNifTid tid, void **respp) { (void)tid; (void)respp; return ESRCH; }
char *enif_thread_name(ErlNifTid tid) { return tid->name; }

/* ---- Formatting: printf with %T for terms ----------------------------------------- */

static void print_term(buffer *b, ERL_NIF_TERM term);

static void print_text(buffer *b, const char *text) { put(b, text, strlen(text)); }

static void print_term(buffer *b, ERL_NIF_TERM term) {
    cell *c = C(term);
    char text[64];
    switch (c->kind) {
    case K_ATOM: put(b, c->u.b.data, c->u.b.size); return;
    case K_INT: snprintf(text, sizeof text, "%lld", (long long)c->u.i); print_text(b, text); return;
    case K_BIG: snprintf(text, sizeof text, "%s%llu", c->tag ? "-" : "", (unsigned long long)c->u.mag); print_text(b, text); return;
    case K_FLOAT: snprintf(text, sizeof text, "%g", c->u.f); print_text(b, text); return;
    case K_NIL: print_text(b, "[]"); return;
    case K_BIN:
        print_text(b, "<<");
        for (size_t i = 0; i < c->u.b.size; i++) {
            snprintf(text, sizeof text, i ? ",%u" : "%u", c->u.b.data[i]);
            print_text(b, text);
        }
        print_text(b, ">>");
        return;
    case K_CONS:
        put8(b, '[');
        for (;;) {
            print_term(b, c->u.c.head);
            cell *tail = C(c->u.c.tail);
            if (tail->kind == K_NIL) break;
            if (tail->kind != K_CONS) {
                put8(b, '|');
                print_term(b, T(tail));
                break;
            }
            put8(b, ',');
            c = tail;
        }
        put8(b, ']');
        return;
    case K_TUPLE: case K_MAP: {
        print_text(b, c->kind == K_MAP ? "#{" : "{");
        for (uint32_t i = 0; i < c->n; i++) {
            if (i) put8(b, ',');
            print_term(b, c->u.t[i]);
            if (c->kind == K_MAP) {
                print_text(b, " => ");
                print_term(b, c->u.t[c->n + i]);
            }
        }
        put8(b, '}');
        return;
    }
    case K_RES: snprintf(text, sizeof text, "#Ref<resource.%u>", c->u.r->id); print_text(b, text); return;
    default:
        print_text(b, order(c) == 5 ? "<pid>" : order(c) == 4 ? "#Port<>" : order(c) == 3 ? "#Fun<>" : order(c) == 2 ? "#Ref<>" : "<term>");
        return;
    }
}

static void format(buffer *b, const char *fmt, va_list *ap) {
    while (*fmt) {
        if (*fmt != '%') {
            put8(b, *fmt++);
            continue;
        }
        const char *start = fmt++;
        if (*fmt == '%') {
            put8(b, '%');
            fmt++;
            continue;
        }
        char spec[64];
        size_t n = 0;
        spec[n++] = '%';
        while (*fmt && strchr("-+ #0'", *fmt) && n < 40) spec[n++] = *fmt++;
        if (*fmt == '*') {
            n += snprintf(spec + n, sizeof spec - n, "%d", va_arg(*ap, int));
            fmt++;
        } else while (*fmt >= '0' && *fmt <= '9' && n < 50) spec[n++] = *fmt++;
        if (*fmt == '.') {
            spec[n++] = *fmt++;
            if (*fmt == '*') {
                n += snprintf(spec + n, sizeof spec - n, "%d", va_arg(*ap, int));
                fmt++;
            } else while (*fmt >= '0' && *fmt <= '9' && n < 58) spec[n++] = *fmt++;
        }
        int length = 0; /* 1 h, 2 hh, 3 l, 4 ll, 5 j, 6 z, 7 t, 8 L */
        if (fmt[0] == 'h') length = fmt[1] == 'h' ? (fmt++, 2) : 1;
        else if (fmt[0] == 'l') length = fmt[1] == 'l' ? (fmt++, 4) : 3;
        else if (fmt[0] == 'j') length = 5;
        else if (fmt[0] == 'z') length = 6;
        else if (fmt[0] == 't') length = 7;
        else if (fmt[0] == 'L') length = 8;
        if (length) fmt++;
        char conv = *fmt;
        if (!conv) {
            put(b, start, fmt - start);
            return;
        }
        fmt++;
        if (conv == 'T') {
            print_term(b, va_arg(*ap, ERL_NIF_TERM));
            continue;
        }
        static const char *lengths[] = { "", "h", "hh", "l", "ll", "j", "z", "t", "L" };
        n += snprintf(spec + n, sizeof spec - n, "%s%c", lengths[length], conv);
        char small[128];
        int size;
        char *text = small;
#define EMIT(value)                                                            \
    do {                                                                       \
        size = snprintf(small, sizeof small, spec, value);                     \
        if (size >= (int)sizeof small) {                                       \
            text = malloc(size + 1);                                           \
            snprintf(text, size + 1, spec, value);                             \
        }                                                                      \
    } while (0)
        switch (conv) {
        case 'd': case 'i':
            if (length == 3) EMIT(va_arg(*ap, long));
            else if (length == 4) EMIT(va_arg(*ap, long long));
            else if (length == 5) EMIT(va_arg(*ap, intmax_t));
            else if (length == 6 || length == 7) EMIT(va_arg(*ap, long));
            else EMIT(va_arg(*ap, int));
            break;
        case 'u': case 'o': case 'x': case 'X':
            if (length == 3) EMIT(va_arg(*ap, unsigned long));
            else if (length == 4) EMIT(va_arg(*ap, unsigned long long));
            else if (length == 5) EMIT(va_arg(*ap, uintmax_t));
            else if (length == 6 || length == 7) EMIT(va_arg(*ap, unsigned long));
            else EMIT(va_arg(*ap, unsigned));
            break;
        case 'c': EMIT(va_arg(*ap, int)); break;
        case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': case 'a': case 'A':
            if (length == 8) EMIT(va_arg(*ap, long double));
            else EMIT(va_arg(*ap, double));
            break;
        case 's': EMIT(va_arg(*ap, char *)); break;
        case 'p': EMIT(va_arg(*ap, void *)); break;
        case 'n': (void)va_arg(*ap, int *); size = 0; break;
        default: size = 0; put(b, start, fmt - start); break;
        }
#undef EMIT
        if (size > 0) put(b, text, size);
        if (text != small) free(text);
    }
}

int enif_vsnprintf(char *buffer_, size_t size, const char *fmt, va_list ap) {
    buffer b = { 0 };
    va_list copy_;
    va_copy(copy_, ap);
    format(&b, fmt, &copy_);
    va_end(copy_);
    if (size) {
        size_t n = b.size < size - 1 ? b.size : size - 1;
        memcpy(buffer_, b.data, n);
        buffer_[n] = 0;
    }
    int written = b.size;
    free(b.data);
    return written;
}

int enif_snprintf(char *buffer_, size_t size, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = enif_vsnprintf(buffer_, size, fmt, ap);
    va_end(ap);
    return n;
}

int enif_vfprintf(FILE *file, const char *fmt, va_list ap) {
    buffer b = { 0 };
    va_list copy_;
    va_copy(copy_, ap);
    format(&b, fmt, &copy_);
    va_end(copy_);
    size_t n = fwrite(b.data, 1, b.size, file);
    free(b.data);
    return n;
}

int enif_fprintf(FILE *file, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = enif_vfprintf(file, fmt, ap);
    va_end(ap);
    return n;
}

/* ---- The node's side ------------------------------------------------------------- */

ErlNifEntry *nif_init(void);

static ErlNifEntry *entry;
static void *priv_data;
static unsigned char *input;
static size_t input_cap;
static buffer output;

void *enif_priv_data(ErlNifEnv *env) { (void)env; return priv_data; }

/* The layer's protocol: the exports and the terms they exchange. */
#define BEAMOS_NIF_ABI 1

__attribute__((export_name("beamos_nif_abi")))
int beamos_nif_abi(void) { return BEAMOS_NIF_ABI; }

__attribute__((export_name("beamos_nif_input")))
unsigned char *beamos_nif_input(size_t size) {
    if (size > input_cap) {
        free(input);
        input = malloc(size);
        input_cap = input ? size : 0;
    }
    return input;
}

__attribute__((export_name("beamos_nif_output")))
unsigned char *beamos_nif_output(void) { return output.data; }

static ERL_NIF_TERM reply(ErlNifEnv *env, ERL_NIF_TERM tag, ERL_NIF_TERM a, ERL_NIF_TERM b) {
    ERL_NIF_TERM messages;
    enif_make_reverse_list(env, outbox ? outbox : T(&nil), &messages);
    if (b) return enif_make_tuple(env, 4, tag, a, b, messages);
    return enif_make_tuple(env, 3, tag, a, messages);
}

static ERL_NIF_TERM load(ErlNifEnv *env, ERL_NIF_TERM info) {
    entry = nif_init();
    if (entry->major != ERL_NIF_MAJOR_VERSION || entry->minor > ERL_NIF_MINOR_VERSION)
        return reply(env, atom("error"), enif_make_tuple(env, 3, atom("bad_lib"), make_int(env, entry->major), make_int(env, entry->minor)), 0);
    int status = entry->load ? entry->load(env, &priv_data, info) : 0;
    if (status) return reply(env, atom("error"), enif_make_tuple(env, 2, atom("load"), make_int(env, status)), 0);
    ERL_NIF_TERM functions = T(&nil);
    for (int i = entry->num_of_funcs; i-- > 0;) {
        ErlNifFunc *f = &entry->funcs[i];
        ERL_NIF_TERM about = enif_make_tuple(env, 3, atom_latin1(f->name, strlen(f->name)), make_int(env, f->arity), make_int(env, f->flags));
        functions = enif_make_list_cell(env, about, functions);
    }
    return reply(env, atom("ok"), atom_latin1(entry->name, strlen(entry->name)), functions);
}

static ERL_NIF_TERM call(ErlNifEnv *env, ERL_NIF_TERM index, ERL_NIF_TERM args) {
    int64_t i;
    unsigned argc;
    if (!entry || !get_signed(index, 0, entry->num_of_funcs - 1, &i) || !enif_get_list_length(env, args, &argc) ||
        argc != entry->funcs[i].arity)
        return reply(env, atom("error"), atom("badcall"), 0);
    ERL_NIF_TERM *argv = env_alloc(env, (argc ? argc : 1) * sizeof(ERL_NIF_TERM));
    cell *at = C(args);
    for (unsigned k = 0; k < argc; k++, at = C(at->u.c.tail)) argv[k] = at->u.c.head;
    ErlNifFunc *f = &entry->funcs[i];
    ERL_NIF_TERM result = enif_schedule_nif(env, f->name, f->flags, f->fptr, argc, argv);
    if (env->has_exception) return reply(env, atom("raise"), env->exception, 0);
    if (result == T(&none)) return reply(env, atom("raise"), atom("badarg"), 0);
    return reply(env, atom("ok"), result, 0);
}

__attribute__((export_name("beamos_nif_run")))
size_t beamos_nif_run(size_t size) {
    ErlNifEnv *env = &call_env;
    env_clear(env);
    env->self = 0;
    if (!nonce) {
        while (!nonce) {
            getentropy(&nonce, sizeof nonce);
            nonce &= 0xffff;
        }
    }
    reader r = { input + 1, input + size, env };
    ERL_NIF_TERM request, answer;
    const ERL_NIF_TERM *fields;
    int arity;
    if (size < 1 || input[0] != 131 || !decode(&r, &request) || !enif_get_tuple(env, request, &arity, &fields) || arity < 1)
        answer = reply(env, atom("error"), atom("badrequest"), 0);
    else if (fields[0] == atom("load") && arity == 3) {
        env->self = fields[2];
        answer = load(env, fields[1]);
    } else if (fields[0] == atom("call") && arity == 4) {
        env->self = fields[3];
        answer = call(env, fields[1], fields[2]);
    } else
        answer = reply(env, atom("error"), atom("badrequest"), 0);
    output.size = 0;
    put8(&output, 131);
    encode(&output, answer);
    env_clear(&outbox_env);
    outbox = 0;
    return output.size;
}
