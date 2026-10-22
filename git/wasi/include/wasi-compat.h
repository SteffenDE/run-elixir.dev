/* What git asks of POSIX that WASI preview 1 lacks: declared here,
   defined in stubs.c. */
#pragma once
#include <sys/types.h>
pid_t fork(void);
int execv(const char *, char *const []);
int execvp(const char *, char *const []);
int execve(const char *, char *const [], char *const []);
uid_t getuid(void); uid_t geteuid(void); gid_t getgid(void); gid_t getegid(void);
pid_t getppid(void);
mode_t umask(mode_t);
int chmod(const char *, mode_t);
int fchmod(int, mode_t);
int dup(int); int dup2(int, int);
int pipe(int [2]);
/* The host's spawn (stubs.c; run-command.c's WASI branch). */
pid_t wasi_spawn(const char **argv, char **env, const char *dir, int in, int out, int err);
/* The host's coroutines for start_async (run-command.c's WASI branch):
   one runs wasi_run_async(async) on a stack of its own (*stack, for the
   caller to free once it waited for the pid); the async that runs now
   (NULL: git's own); and ending it. */
pid_t wasi_async_start(void *async, void **stack);
void *wasi_async_current(void);
_Noreturn void wasi_async_exit(int code);
unsigned alarm(unsigned);
int kill(pid_t, int);
pid_t setsid(void);
int chown(const char *, uid_t, gid_t);
int execl(const char *, const char *, ...);
int execlp(const char *, const char *, ...);
pid_t getpgid(pid_t);
pid_t tcgetpgrp(int);
char *getpass(const char *);
char *mkdtemp(char *);
int mkstemp(char *);

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
