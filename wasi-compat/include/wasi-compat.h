/* What git asks of POSIX that WASI preview 1 lacks, forced into each of
   its files (config.mak's -include): wasi-posix.h's declarations, and
   what git wants of stat, signals and sockets beyond them. A tool built
   with autoconf and gnulib takes wasi-posix.h alone, after its config.h
   (gnulib's replacement headers want config.h first, and bring their own
   signals). */
#pragma once
#include "wasi-posix.h"
/* stat, lstat and fstat with a mode's permission bits (stubs.c): WASI's
   have the type alone, and git takes a mode of S_IFDIR alone for a sparse
   index's directory, not a directory (a submodule's gitlink). Function-like,
   so that `struct stat` stays itself. */
struct stat;
int wasi_stat(const char *, struct stat *);
int wasi_lstat(const char *, struct stat *);
int wasi_fstat(int, struct stat *);
#define stat(path, st) wasi_stat(path, st)
#define lstat(path, st) wasi_lstat(path, st)
#define fstat(fd, st) wasi_fstat(fd, st)
/* The host's coroutines for start_async (run-command.c's WASI branch):
   one runs wasi_run_async(async) on a stack of its own (*stack, for the
   caller to free once it waited for the pid); the async that runs now
   (NULL: git's own); and ending it. */
pid_t wasi_async_start(void *async, void **stack);
void *wasi_async_current(void);
_Noreturn void wasi_async_exit(int code);

/* Signals: wasi-libc's emulation has signal() and raise(), no masks. */
#include <signal.h>
typedef unsigned long sigset_t_;
#define sigset_t sigset_t_
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#define SA_RESTART 0x10000000
struct sigaction { void (*sa_handler)(int); sigset_t sa_mask; int sa_flags; };
int sigaction(int, const struct sigaction *, struct sigaction *);
static inline int sigemptyset(sigset_t *s) { *s = 0; return 0; }
static inline int sigfillset(sigset_t *s) { *s = ~0UL; return 0; }
static inline int sigaddset(sigset_t *s, int n) { *s |= 1UL << n; return 0; }
static inline int sigprocmask(int h, const sigset_t *s, sigset_t *o) { (void)h; (void)s; if (o) *o = 0; return 0; }
#define ITIMER_REAL 0

/* Sockets: none (git://, ssh go through the host or not at all). */
#include <sys/socket.h>
#define SO_KEEPALIVE 9
struct servent { char *s_name; char **s_aliases; int s_port; char *s_proto; };
struct servent *getservbyname(const char *, const char *);
int socket(int, int, int);
int connect(int, const struct sockaddr *, socklen_t);
int setsockopt(int, int, int, const void *, socklen_t);
