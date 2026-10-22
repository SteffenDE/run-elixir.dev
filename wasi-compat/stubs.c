/* What WASI preview 1 lacks and the C tools (git, sed, …) link against:
   processes, users, modes, terminals and sockets. Processes are the
   playground's host's (its `processes` imports:
   app/src/runtime/processes.ts); the rest says so (ENOSYS) or answers as
   a single user would. Built with wasi-compat.h forced in, as git's files
   are; a tool links what it uses (wasm-ld drops the rest, and with it
   imports nothing calls). */
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <pwd.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <wasi/api.h>

#define NOSYS(...) { errno = ENOSYS; return __VA_ARGS__; }

/* The calls themselves (wasi-compat.h renames them), and the permission
   bits a POSIX system would have given. */
#undef stat
#undef lstat
#undef fstat
int stat(const char *, struct stat *);
int lstat(const char *, struct stat *);
int fstat(int, struct stat *);
static int moded(int result, struct stat *st) {
  if (result == 0) {
    if (S_ISDIR(st->st_mode)) st->st_mode |= 0755;
    else if (S_ISLNK(st->st_mode)) st->st_mode |= 0777;
    else st->st_mode |= 0644;
  }
  return result;
}
int wasi_stat(const char *path, struct stat *st) { return moded(stat(path, st), st); }
int wasi_lstat(const char *path, struct stat *st) { return moded(lstat(path, st), st); }
int wasi_fstat(int fd, struct stat *st) { return moded(fstat(fd, st), st); }

#define HOST(name) __attribute__((import_module("processes"), import_name(#name)))
HOST(pipe) int host_pipe(int *fds);
HOST(spawn) int host_spawn(const char *request, size_t length, int in, int out, int err, int *pid);
HOST(wait) int host_wait(int pid, int *status, int nohang);
HOST(kill) int host_kill(int pid, int signal);
HOST(dup) int host_dup(int fd, int *opened);
HOST(dup2) int host_dup2(int fd, int to);
HOST(async_start) int host_async_start(void *async, void *top, int *pid);
HOST(async_current) void *host_async_current(void);
HOST(async_exit) _Noreturn void host_async_exit(int code);

static int answer(int error) {
  if (!error) return 0;
  errno = error;
  return -1;
}

int pipe(int fds[2]) { return answer(host_pipe(fds)); }
int dup(int fd) {
  int opened;
  return answer(host_dup(fd, &opened)) ? -1 : opened;
}
int dup2(int fd, int to) { return answer(host_dup2(fd, to)) ? -1 : to; }
int kill(pid_t pid, int signal) { return answer(host_kill(pid, signal)); }
pid_t waitpid(pid_t pid, int *status, int options) {
  int got = 0;
  int error = host_wait(pid, &got, options & WNOHANG);
  if (error == EAGAIN) return 0;
  if (answer(error)) return -1;
  if (status) *status = got;
  return pid;
}

/* An async's C stack: what sideband_demux and its kind need (git's own
   is 1 MiB, config.mak). */
#define ASYNC_STACK (512 << 10)

pid_t wasi_async_start(void *async, void **stack) {
  int pid;
  char *base = malloc(ASYNC_STACK);
  *stack = base;
  if (!base) return answer(ENOMEM);
  if (answer(host_async_start(async, base + ASYNC_STACK, &pid))) {
    free(base);
    *stack = NULL;
    return -1;
  }
  return pid;
}
void *wasi_async_current(void) { return host_async_current(); }
_Noreturn void wasi_async_exit(int code) { host_async_exit(code); }

/* The host runs argv[0] (by name, as the shell finds it) in `dir` (else
   here), with `env` as its environment and our in, out and err as its
   standard streams: its pid, or -1 (ENOENT: no such program). */
pid_t wasi_spawn(const char **argv, char **env, const char *dir, int in, int out, int err) {
  char here[4096];
  static char joined[8192];
  if (!dir) dir = getcwd(here, sizeof here) ? here : "/";
  else if (dir[0] != '/') {
    snprintf(joined, sizeof joined, "%s/%s", getcwd(here, sizeof here) ? here : "", dir);
    dir = joined;
  }
  /* NUL-separated: program, directory, argc, arguments, envc, environment. */
  size_t argc = 0, envc = 0;
  while (argv[argc]) argc++;
  while (env && env[envc]) envc++;
  char args[24], envs[24];
  snprintf(args, sizeof args, "%zu", argc - 1);
  snprintf(envs, sizeof envs, "%zu", envc);
  size_t length = strlen(dir) + strlen(args) + strlen(envs) + 3;
  for (size_t i = 0; i < argc; i++) length += strlen(argv[i]) + 1;
  for (size_t i = 0; i < envc; i++) length += strlen(env[i]) + 1;
  char *request = malloc(length), *at = request;
  at = stpcpy(at, argv[0]) + 1;
  at = stpcpy(at, dir) + 1;
  at = stpcpy(at, args) + 1;
  for (size_t i = 1; i < argc; i++) at = stpcpy(at, argv[i]) + 1;
  at = stpcpy(at, envs) + 1;
  for (size_t i = 0; i < envc; i++) at = stpcpy(at, env[i]) + 1;
  int pid = -1;
  int error = host_spawn(request, at - request, in, out, err, &pid);
  free(request);
  return answer(error) ? -1 : pid;
}

/* popen and system: `sh -c COMMAND` (the host's sh, brush), its output
   or input a pipe of ours. */
static struct { FILE *file; pid_t pid; } opened[16];
FILE *popen(const char *command, const char *mode) {
  int reading = mode[0] == 'r', fds[2], slot = 0;
  while (slot < 16 && opened[slot].file) slot++;
  if (slot == 16) { errno = EMFILE; return NULL; }
  if ((mode[0] != 'r' && mode[0] != 'w') || pipe(fds)) {
    if (mode[0] != 'r' && mode[0] != 'w') errno = EINVAL;
    return NULL;
  }
  const char *argv[] = {"sh", "-c", command, NULL};
  extern char **environ;
  pid_t pid = reading ? wasi_spawn(argv, environ, NULL, 0, fds[1], 2)
                      : wasi_spawn(argv, environ, NULL, fds[0], 1, 2);
  close(fds[reading]);
  FILE *file = pid < 0 ? NULL : fdopen(fds[!reading], mode);
  if (!file) {
    close(fds[!reading]);
    if (pid >= 0) waitpid(pid, NULL, 0);
    return NULL;
  }
  opened[slot].file = file;
  opened[slot].pid = pid;
  return file;
}
int pclose(FILE *file) {
  int slot = 0, status;
  while (slot < 16 && opened[slot].file != file) slot++;
  if (slot == 16) { errno = ECHILD; return -1; }
  pid_t pid = opened[slot].pid;
  opened[slot].file = NULL;
  fclose(file);
  return waitpid(pid, &status, 0) < 0 ? -1 : status;
}
int system(const char *command) {
  if (!command) return 1;
  const char *argv[] = {"sh", "-c", command, NULL};
  extern char **environ;
  int status;
  pid_t pid = wasi_spawn(argv, environ, NULL, 0, 1, 2);
  if (pid < 0) return -1;
  return waitpid(pid, &status, 0) < 0 ? -1 : status;
}

pid_t fork(void) NOSYS(-1)
int execv(const char *p, char *const a[]) NOSYS(-1)
int execvp(const char *p, char *const a[]) NOSYS(-1)
int execve(const char *p, char *const a[], char *const e[]) NOSYS(-1)
int execl(const char *p, const char *a, ...) NOSYS(-1)
int execlp(const char *p, const char *a, ...) NOSYS(-1)
unsigned alarm(unsigned s) { return 0; }
/* No rlimits: as many descriptors as a POSIX system's default. */
int getdtablesize(void) { return 1024; }
pid_t getppid(void) { return 1; }
pid_t getpgid(pid_t p) NOSYS(-1)
pid_t tcgetpgrp(int fd) NOSYS(-1)
pid_t setsid(void) NOSYS(-1)
int tcgetattr(int fd, struct termios *t) { errno = ENOTTY; return -1; }
int tcsetattr(int fd, int a, const struct termios *t) { errno = ENOTTY; return -1; }
char *getpass(const char *prompt) NOSYS(NULL)

int sigaction(int n, const struct sigaction *act, struct sigaction *old) {
  void (*was)(int) = act ? signal(n, act->sa_handler) : SIG_DFL;
  if (old) { old->sa_handler = was; old->sa_mask = 0; old->sa_flags = 0; }
  return 0;
}
static int member(int n, sigset_t *bit) {
  if (n <= 0 || n > 64) { errno = EINVAL; return -1; }
  *bit = 1ULL << (n - 1);
  return 0;
}
int sigemptyset(sigset_t *s) { *s = 0; return 0; }
int sigfillset(sigset_t *s) { *s = ~0ULL; return 0; }
int sigaddset(sigset_t *s, int n) { sigset_t bit; if (member(n, &bit)) return -1; *s |= bit; return 0; }
int sigdelset(sigset_t *s, int n) { sigset_t bit; if (member(n, &bit)) return -1; *s &= ~bit; return 0; }
int sigismember(const sigset_t *s, int n) { sigset_t bit; if (member(n, &bit)) return -1; return (*s & bit) != 0; }
static sigset_t blocked;
int sigprocmask(int how, const sigset_t *set, sigset_t *old) {
  if (old) *old = blocked;
  if (!set) return 0;
  if (how == SIG_BLOCK) blocked |= *set;
  else if (how == SIG_UNBLOCK) blocked &= ~*set;
  else if (how == SIG_SETMASK) blocked = *set;
  else { errno = EINVAL; return -1; }
  return 0;
}

/* One user, uid 0, who owns every file (WASI's st_uid is 0). */
uid_t getuid(void) { return 0; }
uid_t geteuid(void) { return 0; }
gid_t getgid(void) { return 0; }
gid_t getegid(void) { return 0; }
static struct passwd user;
struct passwd *getpwuid(uid_t uid) {
  user.pw_name = "user";
  user.pw_passwd = "";
  user.pw_gecos = "";
  user.pw_dir = getenv("HOME") ? getenv("HOME") : "/";
  user.pw_shell = "/bin/sh";
  return &user;
}
struct passwd *getpwnam(const char *name) { return getpwuid(0); }
struct group *getgrgid(gid_t gid) { return NULL; }
int initgroups(const char *u, gid_t g) { return 0; }
int chown(const char *p, uid_t u, gid_t g) { return 0; }
int fchown(int fd, uid_t u, gid_t g) { return 0; }

/* No time zones: UTC. */
void tzset(void) {}

/* No umask (wasi-libc has chmod, which fails). */
mode_t umask(mode_t m) { return 022; }


static void fill(char *x) {
  static const char letters[] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  unsigned char bytes[6];
  arc4random_buf(bytes, sizeof bytes);
  for (int i = 0; i < 6; i++) x[i] = letters[bytes[i] % (sizeof letters - 1)];
}
static char *xxxxxx(char *template) {
  size_t n = strlen(template);
  if (n < 6 || strcmp(template + n - 6, "XXXXXX")) { errno = EINVAL; return NULL; }
  return template + n - 6;
}
char *mkdtemp(char *template) {
  char *x = xxxxxx(template);
  if (!x) return NULL;
  for (int tries = 0; tries < 100; tries++) {
    fill(x);
    if (!mkdir(template, 0700)) return template;
    if (errno != EEXIST) return NULL;
  }
  return NULL;
}
int mkstemp(char *template) {
  char *x = xxxxxx(template);
  if (!x) return -1;
  for (int tries = 0; tries < 100; tries++) {
    fill(x);
    int fd = open(template, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd >= 0 || errno != EEXIST) return fd;
  }
  return -1;
}

/* No sockets. */
int h_errno;
const char *hstrerror(int e) { return "no network on WASI"; }
struct hostent *gethostbyname(const char *n) { h_errno = 1; return NULL; }
struct servent *getservbyname(const char *n, const char *p) { return NULL; }
int socket(int d, int t, int p) NOSYS(-1)
int connect(int s, const struct sockaddr *a, socklen_t l) NOSYS(-1)
int setsockopt(int s, int l, int n, const void *v, socklen_t len) NOSYS(-1)

/* No modes: chmod succeeds and changes nothing (wasi-libc's fails). */
#undef chmod
#undef fchmod
int wasi_chmod(const char *p, mode_t m) { return 0; }
int wasi_fchmod(int fd, mode_t m) { return 0; }

/* The program's name (program_invocation_name, gnulib's getprogname and
   error()), which wasi-libc has and never sets: argv[0], as musl's start
   sets it. */
extern char *__progname, *__progname_full;
__attribute__((constructor)) static void program_name(void) {
  __wasi_size_t argc, size;
  if (__wasi_args_sizes_get(&argc, &size) || !argc) return;
  char **argv = malloc(argc * sizeof *argv), *strings = malloc(size);
  if (argv && strings && !__wasi_args_get((uint8_t **)argv, (uint8_t *)strings)) {
    char *slash = strrchr(argv[0], '/');
    __progname_full = argv[0];
    __progname = slash ? slash + 1 : argv[0];
    strings = NULL;
  }
  free(argv);
  free(strings);
}

/* WASI has no working directory: the host's PWD is it (wasi-libc keeps
   one for chdir, relative to the preopen). */
__attribute__((constructor)) static void working_directory(void) {
  const char *pwd = getenv("PWD");
  if (pwd && *pwd) chdir(pwd);
}
