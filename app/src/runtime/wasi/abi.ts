// WASI preview 1 as the shim speaks it: its integers, errno numbers,
// file types and flags, and the calls' signatures.
// WASI preview 1's integers: i32 (unsigned, see `unsigned`) and i64.
export type I32 = number;
export type I64 = bigint;
// An import as the instance calls it.
export type Syscall = (...args: (number | bigint)[]) => number;
export type Imports = { wasi_snapshot_preview1: Record<string, Syscall> };

export const E = {
  SUCCESS: 0,
  ACCES: 2,
  ADDRINUSE: 3,
  AGAIN: 6,
  CONNREFUSED: 14,
  BADF: 8,
  CHILD: 12,
  EXIST: 20,
  INVAL: 28,
  IO: 29,
  ISDIR: 31,
  LOOP: 32,
  NOENT: 44,
  NOSYS: 52,
  NOTDIR: 54,
  NOTEMPTY: 55,
  NOTSUP: 58,
  PERM: 63,
  PIPE: 64,
  SPIPE: 70,
  SRCH: 71,
};
export const FILETYPE = { CHAR: 2, DIR: 3, REG: 4, SYMLINK: 7 };
// path_open's and path_filestat_get's dirflags: follow a last symbolic link.
export const LOOKUP_SYMLINKS = 1;
export const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
export const FDFLAGS = { APPEND: 1 };

// The calls of WASI preview 1 this shim has, as the instance makes them.
export interface Preview1 {
  args_sizes_get(countPtr: I32, sizePtr: I32): number;
  args_get(ptrs: I32, buf: I32): number;
  environ_sizes_get(countPtr: I32, sizePtr: I32): number;
  environ_get(ptrs: I32, buf: I32): number;
  clock_res_get(id: I32, ptr: I32): number;
  clock_time_get(id: I32, precision: I64, ptr: I32): number;
  random_get(ptr: I32, len: I32): number;
  proc_exit(code: I32): never;
  proc_raise(signal: I32): never;
  sched_yield(): number;
  poll_oneoff(inPtr: I32, outPtr: I32, count: I32, eventsPtr: I32): number;
  fd_prestat_get(fd: I32, ptr: I32): number;
  fd_prestat_dir_name(fd: I32, ptr: I32, len: I32): number;
  fd_fdstat_get(fd: I32, ptr: I32): number;
  fd_fdstat_set_flags(fd: I32, flags: I32): number;
  fd_close(fd: I32): number;
  fd_sync(fd: I32): number;
  fd_datasync(fd: I32): number;
  fd_advise(fd: I32, offset: I64, len: I64, advice: I32): number;
  fd_fdstat_set_rights(fd: I32, base: I64, inheriting: I64): number;
  fd_filestat_get(fd: I32, ptr: I32): number;
  fd_filestat_set_size(fd: I32, size: I64): number;
  fd_allocate(fd: I32, offset: I64, length: I64): number;
  fd_filestat_set_times(fd: I32, atim: I64, mtim: I64, flags: I32): number;
  path_filestat_set_times(
    fd: I32,
    flags: I32,
    pathPtr: I32,
    pathLen: I32,
    atim: I64,
    mtim: I64,
    fstflags: I32,
  ): number;
  fd_read(fd: I32, iovs: I32, count: I32, nreadPtr: I32): number;
  fd_write(fd: I32, iovs: I32, count: I32, nwrittenPtr: I32): number;
  fd_pread(fd: I32, iovs: I32, count: I32, offset: I64, nreadPtr: I32): number;
  fd_pwrite(fd: I32, iovs: I32, count: I32, offset: I64, nwrittenPtr: I32): number;
  fd_tell(fd: I32, ptr: I32): number;
  fd_seek(fd: I32, offset: I64, whence: I32, ptr: I32): number;
  fd_readdir(fd: I32, buf: I32, len: I32, cookie: I64, usedPtr: I32): number;
  path_open(
    fd: I32,
    dirflags: I32,
    pathPtr: I32,
    pathLen: I32,
    oflags: I32,
    base: I64,
    inheriting: I64,
    fdflags: I32,
    fdPtr: I32,
  ): number;
  path_filestat_get(fd: I32, flags: I32, pathPtr: I32, pathLen: I32, ptr: I32): number;
  path_create_directory(fd: I32, pathPtr: I32, pathLen: I32): number;
  path_remove_directory(fd: I32, pathPtr: I32, pathLen: I32): number;
  path_unlink_file(fd: I32, pathPtr: I32, pathLen: I32): number;
  path_rename(fd: I32, oldPtr: I32, oldLen: I32, fd2: I32, newPtr: I32, newLen: I32): number;
  path_link(
    fd: I32,
    flags: I32,
    oldPtr: I32,
    oldLen: I32,
    fd2: I32,
    newPtr: I32,
    newLen: I32,
  ): number;
  path_symlink(targetPtr: I32, targetLen: I32, fd: I32, pathPtr: I32, pathLen: I32): number;
  path_readlink(fd: I32, pathPtr: I32, pathLen: I32, buf: I32, bufLen: I32, usedPtr: I32): number;
  sock_accept(fd: I32, flags: I32, fdPtr: I32): number;
  sock_shutdown(fd: I32, how: I32): number;
}
export type Local = Omit<Preview1, 'fd_pread' | 'fd_pwrite' | 'fd_tell'>;
// The calls on the process rather than on descriptors (wasi/index.ts).
export type Basic =
  | 'args_sizes_get'
  | 'args_get'
  | 'environ_sizes_get'
  | 'environ_get'
  | 'clock_res_get'
  | 'clock_time_get'
  | 'random_get'
  | 'proc_exit'
  | 'proc_raise'
  | 'sched_yield'
  | 'poll_oneoff';
