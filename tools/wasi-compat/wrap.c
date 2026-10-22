/* What wasi-libc does and the autoconf tools need otherwise, over its own
   calls: linked with -Wl,--wrap=NAME for each (tools/wasi-compat/autoconf.py),
   so that gnulib's replacements, which call the system's, get these.

   fcntl's F_DUPFD and F_DUPFD_CLOEXEC, which wasi-libc's refuses (EINVAL):
   dup, the host's (stubs.c), until the descriptor is at least the one
   asked for (gnulib's fts duplicates its directories' descriptors so).

   stat, lstat, fstat and fstatat with a mode's permission bits, which
   WASI's lack: as git's (stubs.c wasi_stat), rw-r--r-- for a file,
   rwxr-xr-x for a directory, rwxrwxrwx for a link (find -perm). */
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <sys/stat.h>
#include <unistd.h>

int __real_fcntl(int, int, ...);

int __wrap_fcntl(int fd, int cmd, ...) {
  va_list ap;
  va_start(ap, cmd);
  int arg = va_arg(ap, int);
  va_end(ap);
  if (cmd != F_DUPFD && cmd != F_DUPFD_CLOEXEC) return __real_fcntl(fd, cmd, arg);
  if (arg < 0) { errno = EINVAL; return -1; }
  int below[64], count = 0, result;
  while ((result = dup(fd)) >= 0 && result < arg && count < 64) below[count++] = result;
  int saved = errno;
  while (count) close(below[--count]);
  if (result >= 0 && result < arg) { close(result); errno = EMFILE; return -1; }
  errno = saved;
  return result;
}

int __real_stat(const char *, struct stat *);
int __real_lstat(const char *, struct stat *);
int __real_fstat(int, struct stat *);
int __real_fstatat(int, const char *, struct stat *, int);

static int moded(int result, struct stat *st) {
  if (result == 0 && !(st->st_mode & 07777)) {
    if (S_ISDIR(st->st_mode)) st->st_mode |= 0755;
    else if (S_ISLNK(st->st_mode)) st->st_mode |= 0777;
    else st->st_mode |= 0644;
  }
  return result;
}
int __wrap_stat(const char *path, struct stat *st) { return moded(__real_stat(path, st), st); }
int __wrap_lstat(const char *path, struct stat *st) { return moded(__real_lstat(path, st), st); }
int __wrap_fstat(int fd, struct stat *st) { return moded(__real_fstat(fd, st), st); }
int __wrap_fstatat(int fd, const char *path, struct stat *st, int flag) {
  return moded(__real_fstatat(fd, path, st, flag), st);
}
