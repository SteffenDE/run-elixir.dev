// The shim's shared files (wasi/shared.ts) over the host's: files.ts's
// requests answered with node:fs, synchronously, at the same paths, so that
// a program built for WASI and a host's program see one tree.
import * as fs from 'node:fs';
import { E, OFLAGS } from '@/runtime/wasi/abi';
import type { SharedAnswer, SharedCall } from '@/runtime/wasi/shared';

const ERRNO: Record<string, number> = {
  ENOENT: E.NOENT,
  EEXIST: E.EXIST,
  ENOTDIR: E.NOTDIR,
  EISDIR: E.ISDIR,
  ENOTEMPTY: E.NOTEMPTY,
  ELOOP: E.LOOP,
  EINVAL: E.INVAL,
  EPERM: E.PERM,
  EACCES: E.ACCES,
  EXDEV: E.XDEV,
};

const kind = (stats: fs.BigIntStats) =>
  stats.isDirectory() ? 'dir' : stats.isSymbolicLink() ? 'link' : 'file';
const status = (stats: fs.BigIntStats) => ({
  type: kind(stats),
  size: stats.isDirectory() ? 0 : Number(stats.size),
  ino: Number(stats.ino & 0xffffffffn),
  mtime: String(stats.mtimeNs),
});

export function hostFiles(): SharedCall {
  // What open gave: a file's descriptor, or a directory's path.
  const handles = new Map<number, { fd: number | null; path: string }>();
  let next = 1;
  const answer = (out: SharedAnswer, bytes = new Uint8Array(0)) => ({ answer: out, bytes });
  return (request, bytes) => {
    const {
      op,
      path,
      to,
      target,
      handle,
      offset,
      length,
      oflags = 0,
      append,
      size,
    } = request as Record<string, never>;
    const follow = (request.follow as boolean | undefined) ?? true;
    try {
      switch (op as string) {
        case 'stat':
          return answer(
            status(
              follow ? fs.statSync(path, { bigint: true }) : fs.lstatSync(path, { bigint: true }),
            ),
          );
        case 'open': {
          let stats = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
          if (stats?.isSymbolicLink() && follow) stats = fs.statSync(path, { bigint: true });
          if (stats && oflags & OFLAGS.CREAT && oflags & OFLAGS.EXCL)
            return answer({ error: E.EXIST });
          if (stats?.isSymbolicLink()) return answer({ error: E.LOOP });
          if (stats?.isDirectory()) {
            const id = next++;
            handles.set(id, { fd: null, path });
            return answer({ handle: id, ...status(stats) });
          }
          if (oflags & OFLAGS.DIRECTORY) return answer({ error: stats ? E.NOTDIR : E.NOENT });
          let flags = fs.constants.O_RDWR;
          if (oflags & OFLAGS.CREAT) flags |= fs.constants.O_CREAT;
          if (oflags & OFLAGS.TRUNC) flags |= fs.constants.O_TRUNC;
          let fd: number;
          try {
            fd = fs.openSync(path, flags, 0o644);
          } catch (error) {
            // A file it may only read.
            if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
            fd = fs.openSync(path, fs.constants.O_RDONLY);
          }
          const id = next++;
          handles.set(id, { fd, path });
          return answer({ handle: id, ...status(fs.fstatSync(fd, { bigint: true })) });
        }
        case 'read': {
          const entry = handles.get(handle);
          if (!entry) return answer({ error: E.INVAL });
          if (entry.fd === null) return answer({ error: E.ISDIR });
          const out = new Uint8Array(length);
          const count = fs.readSync(entry.fd, out, 0, length, offset);
          return answer({}, out.subarray(0, count));
        }
        case 'write': {
          const entry = handles.get(handle);
          if (!entry) return answer({ error: E.INVAL });
          if (entry.fd === null) return answer({ error: E.ISDIR });
          const at = append ? Number(fs.fstatSync(entry.fd).size) : (offset as number);
          fs.writeSync(entry.fd, bytes!, 0, bytes!.length, at);
          return answer({ position: at + bytes!.length });
        }
        case 'truncate': {
          const entry = handles.get(handle);
          if (!entry || entry.fd === null) return answer({ error: E.INVAL });
          fs.ftruncateSync(entry.fd, size);
          return answer({});
        }
        case 'fstat': {
          const entry = handles.get(handle);
          if (!entry) return answer({ error: E.INVAL });
          return answer(
            status(
              entry.fd === null
                ? fs.statSync(entry.path, { bigint: true })
                : fs.fstatSync(entry.fd, { bigint: true }),
            ),
          );
        }
        case 'readdir': {
          const entry = handles.get(handle);
          if (!entry || entry.fd !== null) return answer({ error: E.NOTDIR });
          const entries = fs.readdirSync(entry.path).map((name) => {
            const stats = fs.lstatSync(`${entry.path}/${name}`, { bigint: true });
            return [name, kind(stats), Number(stats.ino & 0xffffffffn)];
          });
          return answer({ entries });
        }
        case 'close': {
          const entry = handles.get(handle);
          handles.delete(handle);
          if (entry?.fd != null) fs.closeSync(entry.fd);
          return answer({});
        }
        case 'mkdir':
          fs.mkdirSync(path);
          return answer({});
        case 'rmdir':
          fs.rmdirSync(path);
          return answer({});
        case 'unlink':
          if (fs.lstatSync(path).isDirectory()) return answer({ error: E.ISDIR });
          fs.unlinkSync(path);
          return answer({});
        case 'rename':
          fs.renameSync(path, to);
          return answer({});
        case 'link':
          fs.linkSync(path, to);
          return answer({});
        case 'symlink':
          fs.symlinkSync(target, path);
          return answer({});
        case 'readlink':
          return answer({ target: fs.readlinkSync(path) });
      }
      return answer({ error: E.INVAL });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      return answer({ error: ERRNO[code] ?? E.IO });
    }
  };
}
