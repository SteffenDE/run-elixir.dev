/* fcntl's F_DUPFD and F_DUPFD_CLOEXEC, which wasi-libc's refuses (EINVAL):
   dup, the host's (stubs.c), until the descriptor is at least the one
   asked for. The rest is wasi-libc's. Linked with -Wl,--wrap=fcntl
   (wasi-compat/autoconf.py): gnulib's fts duplicates its directories'
   descriptors so. */
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
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
