// The shared files (files.ts) from a node: its synchronous channel, and
// the WASI calls on shared paths and what they opened.
import { E, FDFLAGS, FILETYPE, LOOKUP_SYMLINKS, type Local } from './abi';
import type { WASI } from '.';

// A node's synchronous channel to the shared filesystem (files.js): send a
// request and its bytes, wait for the answer.
// files.js's answer: an errno in `error`, or what the request asked for.
// oxlint-disable-next-line typescript/no-explicit-any -- each op's own.
export type SharedAnswer = { error?: number; [field: string]: any };
export type SharedCall = (
  request: Record<string, unknown>,
  bytes?: Uint8Array,
) => { answer: SharedAnswer; bytes: Uint8Array };
// Paths another worker holds (files.js), and the way to it.
export interface Shared {
  prefixes: string[];
  call: SharedCall;
}

export function sharedClient(doorbell: SharedArrayBuffer, channel: SharedArrayBuffer): SharedCall {
  const bell = new Int32Array(doorbell);
  const control = new Int32Array(channel, 0, 2);
  const data = new Uint8Array(channel, 8);
  const view = new DataView(channel, 8);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return (request, bytes = new Uint8Array(0)) => {
    const header = encoder.encode(JSON.stringify(request));
    view.setUint32(0, header.length, true);
    data.set(header, 4);
    data.set(bytes, 4 + header.length);
    Atomics.store(control, 1, 4 + header.length + bytes.length);
    Atomics.store(control, 0, 1);
    Atomics.add(bell, 0, 1);
    Atomics.notify(bell, 0);
    while (Atomics.load(control, 0) === 1) Atomics.wait(control, 0, 1, 1000);
    const length = view.getUint32(0, true);
    const total = Atomics.load(control, 1);
    const answer = JSON.parse(decoder.decode(data.slice(4, 4 + length)));
    const out = data.slice(4 + length, total);
    Atomics.store(control, 0, 0);
    return { answer, bytes: out };
  };
}

// The most a shared read or write moves at once (the channel's size, less
// room for headers).
const SHARED_CHUNK = 512 * 1024;

function sharedType(type: string): number {
  return type === 'dir' ? FILETYPE.DIR : type === 'link' ? FILETYPE.SYMLINK : FILETYPE.REG;
}

// A shared file open in the node (files.js's handle).
export interface SharedFile {
  handle: number;
  position: number;
  append: boolean;
  dir: boolean;
  listing: [name: string, type: string, ino: number][] | null;
}

export function isShared(wasi: WASI, path: string): boolean {
  return wasi.shared!.prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

// A filestat for a shared node (files.js status).
export function sharedFilestat(
  wasi: WASI,
  ptr: number,
  { type, size, ino, mtime }: SharedAnswer,
): void {
  const v = wasi.view();
  v.setBigUint64(ptr, 2n, true);
  v.setBigUint64(ptr + 8, BigInt(ino), true);
  v.setUint8(ptr + 16, sharedType(type));
  v.setBigUint64(ptr + 24, 1n, true);
  v.setBigUint64(ptr + 32, BigInt(size), true);
  v.setBigUint64(ptr + 40, BigInt(mtime), true);
  v.setBigUint64(ptr + 48, BigInt(mtime), true);
  v.setBigUint64(ptr + 56, BigInt(mtime), true);
}

// The WASI calls on shared paths and their descriptors, in front of the
// local ones (`local`), which take everything else.
export function sharedCalls(wasi: WASI, local: Local): Partial<Local> {
  const call: SharedCall = (request, bytes) => wasi.shared!.call(request, bytes);
  const ask = (request: Record<string, unknown>, bytes?: Uint8Array) => call(request, bytes).answer;
  const path = (fd: number, ptr: number, len: number) => wasi.absolute(fd, wasi.string(ptr, len));
  const remoteOf = (fd: number) => wasi.fds.get(fd)?.remote;
  const simple =
    (op: string, name: 'path_create_directory' | 'path_remove_directory' | 'path_unlink_file') =>
    (fd: number, ptr: number, len: number) => {
      const target = path(fd, ptr, len);
      if (!isShared(wasi, target)) return local[name](fd, ptr, len);
      return ask({ op, path: target }).error ?? E.SUCCESS;
    };
  return {
    path_open(fd, dirflags, pathPtr, pathLen, oflags, base, inheriting, fdflags, fdPtr) {
      const target = path(fd, pathPtr, pathLen);
      if (!isShared(wasi, target))
        return local.path_open(
          fd,
          dirflags,
          pathPtr,
          pathLen,
          oflags,
          base,
          inheriting,
          fdflags,
          fdPtr,
        );
      const opened = ask({
        op: 'open',
        path: target,
        oflags,
        follow: !!(dirflags & LOOKUP_SYMLINKS),
      });
      if (opened.error) return opened.error;
      const id = wasi.next++;
      wasi.fds.set(id, {
        path: target,
        remote: {
          handle: opened.handle,
          position: 0,
          append: !!(fdflags & FDFLAGS.APPEND),
          dir: opened.type === 'dir',
          listing: null,
        },
      });
      wasi.view().setUint32(fdPtr, id, true);
      return E.SUCCESS;
    },
    path_filestat_get(fd, flags, pathPtr, pathLen, ptr) {
      const target = path(fd, pathPtr, pathLen);
      if (!isShared(wasi, target)) return local.path_filestat_get(fd, flags, pathPtr, pathLen, ptr);
      const status = ask({ op: 'stat', path: target, follow: !!(flags & LOOKUP_SYMLINKS) });
      if (status.error) return status.error;
      sharedFilestat(wasi, ptr, status);
      return E.SUCCESS;
    },
    path_symlink(targetPtr, targetLen, fd, pathPtr, pathLen) {
      const at = path(fd, pathPtr, pathLen);
      if (!isShared(wasi, at))
        return local.path_symlink(targetPtr, targetLen, fd, pathPtr, pathLen);
      return (
        ask({ op: 'symlink', path: at, target: wasi.string(targetPtr, targetLen) }).error ??
        E.SUCCESS
      );
    },
    path_readlink(fd, pathPtr, pathLen, buf, bufLen, usedPtr) {
      const at = path(fd, pathPtr, pathLen);
      if (!isShared(wasi, at))
        return local.path_readlink(fd, pathPtr, pathLen, buf, bufLen, usedPtr);
      const answer = ask({ op: 'readlink', path: at });
      if (answer.error) return answer.error;
      const target = new TextEncoder().encode(answer.target).subarray(0, bufLen);
      wasi.bytes(buf, target.length).set(target);
      wasi.view().setUint32(usedPtr, target.length, true);
      return E.SUCCESS;
    },
    path_create_directory: simple('mkdir', 'path_create_directory'),
    path_remove_directory: simple('rmdir', 'path_remove_directory'),
    path_unlink_file: simple('unlink', 'path_unlink_file'),
    path_rename(fd, oldPtr, oldLen, fd2, newPtr, newLen) {
      const from = path(fd, oldPtr, oldLen);
      const to = path(fd2, newPtr, newLen);
      if (!isShared(wasi, from) && !isShared(wasi, to))
        return local.path_rename(fd, oldPtr, oldLen, fd2, newPtr, newLen);
      if (isShared(wasi, from) !== isShared(wasi, to)) return 75; // EXDEV
      return ask({ op: 'rename', path: from, to }).error ?? E.SUCCESS;
    },
    path_link(fd, flags, oldPtr, oldLen, fd2, newPtr, newLen) {
      const from = path(fd, oldPtr, oldLen);
      const to = path(fd2, newPtr, newLen);
      if (!isShared(wasi, from) && !isShared(wasi, to))
        return local.path_link(fd, flags, oldPtr, oldLen, fd2, newPtr, newLen);
      if (isShared(wasi, from) !== isShared(wasi, to)) return 75; // EXDEV
      return (
        ask({ op: 'link', path: from, to, follow: !!(flags & LOOKUP_SYMLINKS) }).error ?? E.SUCCESS
      );
    },
    fd_read(fd, iovs, count, nreadPtr) {
      const remote = remoteOf(fd);
      if (!remote) return local.fd_read(fd, iovs, count, nreadPtr);
      if (remote.dir) return E.ISDIR;
      let total = 0;
      for (const [ptr, len] of wasi.iovecs(iovs, count)) {
        let filled = 0;
        while (filled < len) {
          const want = Math.min(len - filled, SHARED_CHUNK);
          const { answer, bytes } = call({
            op: 'read',
            handle: remote.handle,
            offset: remote.position,
            length: want,
          });
          if (answer.error) return answer.error;
          wasi.bytes(ptr + filled, bytes.length).set(bytes);
          filled += bytes.length;
          remote.position += bytes.length;
          if (bytes.length < want) break;
        }
        total += filled;
        if (filled < len) break;
      }
      wasi.view().setUint32(nreadPtr, total, true);
      return E.SUCCESS;
    },
    fd_write(fd, iovs, count, nwrittenPtr) {
      const remote = remoteOf(fd);
      if (!remote) return local.fd_write(fd, iovs, count, nwrittenPtr);
      let total = 0;
      for (const [ptr, len] of wasi.iovecs(iovs, count)) {
        for (let at = 0; at < len; at += SHARED_CHUNK) {
          const bytes = wasi.bytes(ptr + at, Math.min(SHARED_CHUNK, len - at)).slice();
          const answer = ask(
            {
              op: 'write',
              handle: remote.handle,
              offset: remote.position,
              append: remote.append,
            },
            bytes,
          );
          if (answer.error) return answer.error;
          remote.position = answer.position;
        }
        total += len;
      }
      wasi.view().setUint32(nwrittenPtr, total, true);
      return E.SUCCESS;
    },
    fd_seek(fd, offset, whence, ptr) {
      const remote = remoteOf(fd);
      if (!remote) return local.fd_seek(fd, offset, whence, ptr);
      const size = whence === 2 ? ask({ op: 'fstat', handle: remote.handle }).size : 0;
      const base = [0, remote.position, size][whence];
      if (base === undefined) return E.INVAL;
      const position = base + Number(offset);
      if (position < 0) return E.INVAL;
      remote.position = position;
      wasi.view().setBigUint64(ptr, BigInt(position), true);
      return E.SUCCESS;
    },
    fd_filestat_get(fd, ptr) {
      const remote = remoteOf(fd);
      if (!remote) return local.fd_filestat_get(fd, ptr);
      const status = ask({ op: 'fstat', handle: remote.handle });
      if (status.error) return status.error;
      sharedFilestat(wasi, ptr, status);
      return E.SUCCESS;
    },
    fd_filestat_set_size(fd, size) {
      const remote = remoteOf(fd);
      if (!remote) return local.fd_filestat_set_size(fd, size);
      return ask({ op: 'truncate', handle: remote.handle, size: Number(size) }).error ?? E.SUCCESS;
    },
    fd_allocate(fd, offset, length) {
      const remote = remoteOf(fd);
      if (!remote) return local.fd_allocate(fd, offset, length);
      const status = ask({ op: 'fstat', handle: remote.handle });
      if (status.error) return status.error;
      const end = Number(offset + length);
      if (end <= status.size) return E.SUCCESS;
      return ask({ op: 'truncate', handle: remote.handle, size: end }).error ?? E.SUCCESS;
    },
    fd_fdstat_get(fd, ptr) {
      const remote = remoteOf(fd);
      if (!remote) return local.fd_fdstat_get(fd, ptr);
      const v = wasi.view();
      v.setUint8(ptr, remote.dir ? FILETYPE.DIR : FILETYPE.REG);
      v.setUint16(ptr + 2, remote.append ? FDFLAGS.APPEND : 0, true);
      v.setBigUint64(ptr + 8, 0xffffffffffffffffn, true);
      v.setBigUint64(ptr + 16, 0xffffffffffffffffn, true);
      return E.SUCCESS;
    },
    fd_readdir(fd, buf, len, cookie, usedPtr) {
      const remote = remoteOf(fd);
      if (!remote) return local.fd_readdir(fd, buf, len, cookie, usedPtr);
      if (!remote.dir) return E.NOTDIR;
      if (!remote.listing || cookie === 0n) {
        const answer = ask({ op: 'readdir', handle: remote.handle });
        if (answer.error) return answer.error;
        remote.listing = answer.entries;
      }
      let used = 0;
      for (let i = Number(cookie); i < remote.listing!.length && used < len; i++) {
        const [name, type, ino] = remote.listing![i];
        const encoded = new TextEncoder().encode(name);
        const record = new Uint8Array(24 + encoded.length);
        const h = new DataView(record.buffer);
        h.setBigUint64(0, BigInt(i + 1), true);
        h.setBigUint64(8, BigInt(ino), true);
        h.setUint32(16, encoded.length, true);
        h.setUint8(20, sharedType(type));
        record.set(encoded, 24);
        const room = Math.min(record.length, len - used);
        wasi.bytes(buf + used, room).set(record.subarray(0, room));
        used += room;
      }
      wasi.view().setUint32(usedPtr, used, true);
      return E.SUCCESS;
    },
    fd_close(fd) {
      const remote = remoteOf(fd);
      if (!remote) return local.fd_close(fd);
      wasi.fds.delete(fd);
      return ask({ op: 'close', handle: remote.handle }).error ?? E.SUCCESS;
    },
  };
}
