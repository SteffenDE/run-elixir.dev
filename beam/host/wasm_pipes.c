/*
 * Pipes that block, for erts on Emscripten, whose own pipes (PIPEFS) never
 * do: a read of an empty one fails with EAGAIN. erts waits on pipes for
 * signals (its signal-dispatcher thread reads the pipe its handlers write
 * to) and for its poll set's wakeups, so here a pipe() is ours: the bytes
 * in memory, a reader on a thread of its own sleeps until a writer (or a
 * signal handler, run on the main thread: run.ts) wakes it, and poll()
 * waits on them as on any descriptor. Linked with
 * -Wl,--wrap=pipe,--wrap=pipe2,--wrap=read,--wrap=write,--wrap=close,
 * --wrap=fcntl,--wrap=poll (build.sh); what is not one of our pipes goes
 * on to Emscripten. Emscripten's pipe() still makes the descriptors, so
 * their numbers are taken.
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAX_FDS 1024

struct pipe_buf {
    unsigned char *data;
    size_t start, size, capacity;
    int readers, writers;
};

/* A descriptor that is an end of one of our pipes. */
struct end {
    struct pipe_buf *pipe;
    int reading;
    int nonblocking;
};

static struct end *ends[MAX_FDS];
/* One lock for all of them; `changed` is broadcast at every write and
 * close, which a reader or a poll() waits for. */
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;

int __real_pipe(int fds[2]);
int __real_pipe2(int fds[2], int flags);
ssize_t __real_read(int fd, void *buf, size_t count);
ssize_t __real_write(int fd, const void *buf, size_t count);
int __real_close(int fd);
int __real_fcntl(int fd, int cmd, ...);
int __real_poll(struct pollfd *fds, nfds_t n, int timeout);

static struct end *end_of(int fd) {
    return fd >= 0 && fd < MAX_FDS ? ends[fd] : NULL;
}

static int make(int fds[2], int flags) {
    if (__real_pipe(fds) < 0)
        return -1;
    if (fds[0] >= MAX_FDS || fds[1] >= MAX_FDS)
        return 0; /* Beyond the table: Emscripten's. */
    struct pipe_buf *p = calloc(1, sizeof(*p));
    struct end *r = calloc(1, sizeof(*r)), *w = calloc(1, sizeof(*w));
    if (!p || !r || !w) {
        free(p);
        free(r);
        free(w);
        __real_close(fds[0]);
        __real_close(fds[1]);
        errno = ENOMEM;
        return -1;
    }
    p->readers = p->writers = 1;
    r->pipe = w->pipe = p;
    r->reading = 1;
    r->nonblocking = w->nonblocking = (flags & O_NONBLOCK) != 0;
    pthread_mutex_lock(&lock);
    ends[fds[0]] = r;
    ends[fds[1]] = w;
    pthread_mutex_unlock(&lock);
    return 0;
}

int __wrap_pipe(int fds[2]) {
    return make(fds, 0);
}

int __wrap_pipe2(int fds[2], int flags) {
    return make(fds, flags);
}

/* Bytes waiting in `p`, or its end (no writer left). Under the lock. */
static int readable(struct pipe_buf *p) {
    return p->size > 0 || p->writers == 0;
}

ssize_t __wrap_read(int fd, void *buf, size_t count) {
    pthread_mutex_lock(&lock);
    struct end *e = end_of(fd);
    if (!e) {
        pthread_mutex_unlock(&lock);
        return __real_read(fd, buf, count);
    }
    if (!e->reading) {
        pthread_mutex_unlock(&lock);
        errno = EBADF;
        return -1;
    }
    struct pipe_buf *p = e->pipe;
    while (!readable(p)) {
        if (e->nonblocking) {
            pthread_mutex_unlock(&lock);
            errno = EAGAIN;
            return -1;
        }
        pthread_cond_wait(&changed, &lock);
    }
    size_t n = count < p->size ? count : p->size;
    for (size_t i = 0; i < n; i++)
        ((unsigned char *)buf)[i] = p->data[(p->start + i) % p->capacity];
    p->start = p->capacity ? (p->start + n) % p->capacity : 0;
    p->size -= n;
    pthread_mutex_unlock(&lock);
    return (ssize_t)n;
}

ssize_t __wrap_write(int fd, const void *buf, size_t count) {
    pthread_mutex_lock(&lock);
    struct end *e = end_of(fd);
    if (!e) {
        pthread_mutex_unlock(&lock);
        return __real_write(fd, buf, count);
    }
    struct pipe_buf *p = e->pipe;
    if (e->reading || p->readers == 0) {
        pthread_mutex_unlock(&lock);
        errno = e->reading ? EBADF : EPIPE;
        return -1;
    }
    if (p->size + count > p->capacity) {
        size_t capacity = p->capacity ? p->capacity : 512;
        while (capacity < p->size + count)
            capacity *= 2;
        unsigned char *data = malloc(capacity);
        if (!data) {
            pthread_mutex_unlock(&lock);
            errno = ENOMEM;
            return -1;
        }
        for (size_t i = 0; i < p->size; i++)
            data[i] = p->data[(p->start + i) % p->capacity];
        free(p->data);
        p->data = data;
        p->start = 0;
        p->capacity = capacity;
    }
    for (size_t i = 0; i < count; i++)
        p->data[(p->start + p->size + i) % p->capacity] = ((const unsigned char *)buf)[i];
    p->size += count;
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&lock);
    return (ssize_t)count;
}

int __wrap_close(int fd) {
    pthread_mutex_lock(&lock);
    struct end *e = end_of(fd);
    if (e) {
        struct pipe_buf *p = e->pipe;
        if (e->reading)
            p->readers--;
        else
            p->writers--;
        ends[fd] = NULL;
        free(e);
        if (p->readers == 0 && p->writers == 0) {
            free(p->data);
            free(p);
        }
        pthread_cond_broadcast(&changed);
    }
    pthread_mutex_unlock(&lock);
    return __real_close(fd);
}

int __wrap_fcntl(int fd, int cmd, ...) {
    va_list va;
    va_start(va, cmd);
    int arg = va_arg(va, int);
    va_end(va);
    pthread_mutex_lock(&lock);
    struct end *e = end_of(fd);
    if (e && (cmd == F_GETFL || cmd == F_SETFL)) {
        int result = 0;
        if (cmd == F_GETFL)
            result = (e->reading ? O_RDONLY : O_WRONLY) | (e->nonblocking ? O_NONBLOCK : 0);
        else
            e->nonblocking = (arg & O_NONBLOCK) != 0;
        pthread_mutex_unlock(&lock);
        return result;
    }
    pthread_mutex_unlock(&lock);
    return __real_fcntl(fd, cmd, arg);
}

/* How many of our ends among `fds` are ready (and how many there are).
 * Under the lock. */
static int ours_ready(struct pollfd *fds, nfds_t n, int *ours) {
    int count = 0;
    *ours = 0;
    for (nfds_t i = 0; i < n; i++) {
        struct end *e = end_of(fds[i].fd);
        if (!e)
            continue;
        (*ours)++;
        fds[i].revents = 0;
        if (e->reading) {
            if (e->pipe->size > 0)
                fds[i].revents |= fds[i].events & POLLIN;
            if (e->pipe->writers == 0)
                fds[i].revents |= POLLHUP;
        } else {
            fds[i].revents |= e->pipe->readers ? (fds[i].events & POLLOUT) : POLLERR;
        }
        if (fds[i].revents)
            count++;
    }
    return count;
}

/* How many of the others are ready, from Emscripten without waiting. Not
 * under the lock: Emscripten's poll runs on the main thread, which may be
 * writing to one of our pipes (a signal handler) meanwhile. */
static int others_ready(struct pollfd *fds, nfds_t n) {
    int count = 0;
    for (nfds_t i = 0; i < n; i++) {
        if (fds[i].fd < 0)
            continue;
        pthread_mutex_lock(&lock);
        int ours = end_of(fds[i].fd) != NULL;
        pthread_mutex_unlock(&lock);
        if (ours)
            continue;
        fds[i].revents = 0;
        if (__real_poll(&fds[i], 1, 0) > 0)
            count++;
    }
    return count;
}

static int before(const struct timespec *a, const struct timespec *b) {
    return a->tv_sec < b->tv_sec || (a->tv_sec == b->tv_sec && a->tv_nsec < b->tv_nsec);
}

static void add_ms(struct timespec *t, long ms) {
    t->tv_sec += ms / 1000;
    t->tv_nsec += (ms % 1000) * 1000000L;
    if (t->tv_nsec >= 1000000000L) {
        t->tv_sec++;
        t->tv_nsec -= 1000000000L;
    }
}

/* With one of our pipes in the set, it waits on them; the others in the
 * set are looked at again every 10 ms (only our pipes wake a poll()). */
int __wrap_poll(struct pollfd *fds, nfds_t n, int timeout) {
    int ours;
    pthread_mutex_lock(&lock);
    int count = ours_ready(fds, n, &ours);
    pthread_mutex_unlock(&lock);
    if (!ours)
        return __real_poll(fds, n, timeout);
    int others = (nfds_t)ours < n;
    if (others)
        count += others_ready(fds, n);
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    add_ms(&deadline, timeout > 0 ? timeout : 0);
    while (count == 0 && timeout != 0) {
        struct timespec until;
        clock_gettime(CLOCK_REALTIME, &until);
        if (timeout > 0 && !before(&until, &deadline))
            break;
        add_ms(&until, others ? 10 : 1000);
        if (timeout > 0 && before(&deadline, &until))
            until = deadline;
        pthread_mutex_lock(&lock);
        count = ours_ready(fds, n, &ours);
        if (count == 0)
            pthread_cond_timedwait(&changed, &lock, &until);
        count = ours_ready(fds, n, &ours);
        pthread_mutex_unlock(&lock);
        if (others)
            count += others_ready(fds, n);
    }
    return count;
}
