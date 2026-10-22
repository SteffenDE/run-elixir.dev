/* What a C tool asks of POSIX that WASI preview 1 lacks: declarations of
   what stubs.c defines (wasi-libc declares some of them, defines none).
   Processes are the host's (wasi_spawn and the `processes` imports);
   users, modes and terminals answer as one user's would. Declarations
   only, so that a tool's own portability layer (gnulib) keeps its
   types: an autoconf build appends `#include <wasi-posix.h>` to its
   config.h, git's wasi-compat.h includes it. */
#pragma once
#include <stdio.h>
#include <sys/types.h>
pid_t fork(void);
int execv(const char *, char *const []);
int execvp(const char *, char *const []);
int execve(const char *, char *const [], char *const []);
int execl(const char *, const char *, ...);
int execlp(const char *, const char *, ...);
uid_t getuid(void); uid_t geteuid(void); gid_t getgid(void); gid_t getegid(void);
pid_t getppid(void);
pid_t getpgid(pid_t);
pid_t getpgrp(void);
pid_t setsid(void);
pid_t tcgetpgrp(int);
mode_t umask(mode_t);
int chmod(const char *, mode_t);
int fchmod(int, mode_t);
int chown(const char *, uid_t, gid_t);
int fchown(int, uid_t, gid_t);
int dup(int); int dup2(int, int);
int pipe(int [2]);
int kill(pid_t, int);
unsigned alarm(unsigned);
int getdtablesize(void);
char *getpass(const char *);
char *mkdtemp(char *);
int mkstemp(char *);
/* The host's spawn: argv[0] found by name as the shell finds it, in `dir`
   (NULL: here), its standard streams our descriptors in, out and err; its
   pid, or -1 (errno ENOENT: no such program). */
pid_t wasi_spawn(const char **argv, char **env, const char *dir, int in, int out, int err);
/* sh -c COMMAND (brush, a process of the host's) over wasi_spawn. */
FILE *popen(const char *, const char *);
int pclose(FILE *);
int system(const char *);

/* Signals: wasi-libc emulates signal() and raise() (-D_WASI_EMULATED_SIGNAL),
   and its sigset_t is a placeholder of one byte. Sets of 64 signals,
   masks kept and never applied (no signal arrives but raise()'s and the
   host's kill, which ends a process), sigaction over signal() (stubs.c).
   As POSIX's, gnulib has no blocking of its own to emulate (its emulation
   wants NSIG <= 32; wasi-libc's is 65). */
#include <__typedef_sigset_t.h>
typedef unsigned long long wasi_sigset_t;
#define sigset_t wasi_sigset_t
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#define SA_RESTART 0x10000000
struct sigaction { void (*sa_handler)(int); sigset_t sa_mask; int sa_flags; };
int sigaction(int, const struct sigaction *, struct sigaction *);
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
int sigdelset(sigset_t *, int);
int sigismember(const sigset_t *, int);
int sigprocmask(int, const sigset_t *, sigset_t *);

/* No time zones (WASI has no tables): UTC, and tzset does nothing. */
void tzset(void);

/* wasi-libc has an opendirat(fd, path) of its own; gnulib's (fts, for
   grep -r and find) takes four arguments, so is gnulib's by another name
   from here on. */
#include <dirent.h>
#define opendirat gnulib_opendirat
