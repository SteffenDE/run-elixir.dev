// The calls on the node's own descriptors and paths: the tree's files and
// directories, the standard streams, and the host's files (/.proc/spawn,
// /.tty, /.nif, /.net).
import { E, FDFLAGS, FILETYPE, LOOKUP_SYMLINKS, OFLAGS, type Basic, type Local } from './abi';
import { Device, Dir, File, Symlink, fileType, load, now, type FsNode } from './fs';
import type { Endpoint, Waiting } from './net';
import { spawn, type Process } from './process';
import type { Pipe } from './pipe';
import type { SharedFile } from './shared';
import type { WASI } from '.';

// An open descriptor: a node of the tree, a standard stream, a shared file,
// a pipe's end, or one of the host's files (/.proc/spawn, /.tty, /.nif,
// /.net), by what it holds. A process's descriptors may be its parent's
// (processes.ts): the same object, in both tables, as a Unix process's
// open file descriptions are; `shares` counts the tables beyond the
// first, and closing it there only lets that one go.
export interface Descriptor {
  shares?: number;
  // A pipe's end: its read end, or else its write end.
  pipe?: Pipe;
  reads?: boolean;
  // A stream of its own (else the shim's stdin, stdout and stderr): where
  // what is read comes from (`stdin`'s answers) and what is written goes,
  // and whether it is a terminal (else as the shim says, `tty`).
  source?: (max: number) => Uint8Array | null;
  // For a source with nothing yet (null): when to try again, which a
  // program run under JSPI waits for, suspended (else it is told EAGAIN).
  ready?: () => Promise<unknown>;
  sink?: (bytes: Uint8Array) => void;
  tty?: boolean;
  node?: FsNode;
  position?: number;
  append?: boolean;
  preopen?: string;
  path?: string;
  changed?: boolean;
  stream?: boolean;
  remote?: SharedFile;
  spawn?: boolean;
  process?: Process | null;
  terminal?: boolean;
  nif?: string;
  request?: Uint8Array[];
  answer?: Uint8Array | null;
  listener?: Waiting[];
  port?: number;
  endpoint?: Endpoint;
}

// The calls on what is not shared (all of them, when nothing is).
export function descriptors(wasi: WASI): Omit<Local, Basic> {
  const ok = E.SUCCESS;
  return {
    fd_prestat_get(fd, ptr) {
      const entry = wasi.fds.get(fd);
      if (!entry || !entry.preopen) return E.BADF;
      const v = wasi.view();
      v.setUint8(ptr, 0);
      v.setUint32(ptr + 4, new TextEncoder().encode(entry.preopen).length, true);
      return ok;
    },
    fd_prestat_dir_name(fd, ptr, len) {
      const entry = wasi.fds.get(fd);
      if (!entry || !entry.preopen) return E.BADF;
      wasi.bytes(ptr, len).set(new TextEncoder().encode(entry.preopen).subarray(0, len));
      return ok;
    },
    fd_fdstat_get(fd, ptr) {
      const entry = wasi.fds.get(fd);
      if (!entry) return E.BADF;
      const v = wasi.view();
      const type = entry.stream
        ? FILETYPE.CHAR
        : entry.node instanceof Dir
          ? FILETYPE.DIR
          : FILETYPE.REG;
      v.setUint8(ptr, entry.pipe ? FILETYPE.CHAR : type);
      v.setUint16(ptr + 2, entry.append ? FDFLAGS.APPEND : 0, true);
      // wasi-libc's isatty: a character device that cannot seek or tell.
      const tty = entry.stream && (entry.tty ?? wasi.tty);
      const rights = tty ? ~(4n | 32n) & 0xffffffffffffffffn : 0xffffffffffffffffn;
      v.setBigUint64(ptr + 8, rights, true);
      v.setBigUint64(ptr + 16, rights, true);
      return ok;
    },
    fd_fdstat_set_flags: () => ok,
    fd_close(fd) {
      if (!wasi.fds.has(fd) || fd < 3) return fd < 3 ? ok : E.BADF;
      const entry = wasi.fds.get(fd)!;
      if (entry.endpoint) entry.endpoint.peer.close();
      if (entry.listener) {
        wasi.network.listeners.delete(entry.port!);
        wasi.network.remote.listening?.(entry.port!, false);
      }
      if (entry.changed) wasi.onchange(entry.path!);
      // The port closed: a program still running is told (onclose).
      if (entry.process) {
        entry.process.closed = true;
        entry.process.onclose?.();
      }
      wasi.fds.delete(fd);
      return ok;
    },
    fd_sync: () => ok,
    fd_datasync: () => ok,
    // Hints and rights: nothing to do.
    fd_advise: () => ok,
    fd_fdstat_set_rights: () => ok,
    fd_filestat_get(fd, ptr) {
      const entry = wasi.fds.get(fd);
      if (!entry) return E.BADF;
      // A process's size is its exit status + 1 once it has exited.
      if (entry.spawn) {
        const status = entry.process?.status;
        wasi.filestat(ptr, {
          ino: 0n,
          size: status === null || status === undefined ? 0 : status + 1,
          mtime: now(),
        });
        return ok;
      }
      // A listener's size is its port (wasm_net.rs).
      if (entry.listener) {
        wasi.filestat(ptr, { ino: 0n, size: entry.port!, mtime: now() });
        return ok;
      }
      wasi.filestat(ptr, entry.stream || entry.pipe ? null : entry.node);
      return ok;
    },
    fd_filestat_set_size(fd, size) {
      const entry = wasi.fds.get(fd);
      if (entry?.endpoint) {
        entry.endpoint.peer.end();
        return ok;
      }
      if (entry?.process) {
        entry.process.closed = true;
        return ok;
      }
      if (!entry || !(entry.node instanceof File)) return E.BADF;
      entry.node.truncate(Number(size));
      entry.changed = true;
      return ok;
    },
    // posix_fallocate: the file at least offset + length long.
    fd_allocate(fd, offset, length) {
      const entry = wasi.fds.get(fd);
      if (!entry || !(entry.node instanceof File)) return entry ? E.SPIPE : E.BADF;
      const end = Number(offset + length);
      if (end > entry.node.size) {
        entry.node.truncate(end);
        entry.changed = true;
      }
      return ok;
    },
    // Files keep their own times (written ones are now): setting them
    // does nothing, by descriptor or by path (SQLite asks for both).
    fd_filestat_set_times: () => ok,
    path_filestat_set_times: () => ok,
    fd_read(fd, iovs, count, nreadPtr) {
      const entry = wasi.fds.get(fd);
      if (!entry) return E.BADF;
      wasi.pump();
      let total = 0;
      const net = entry.endpoint || entry.listener;
      if (entry.pipe) {
        if (!entry.reads) return E.BADF;
        const want = wasi.iovecs(iovs, count).reduce((n, [, len]) => n + len, 0);
        const bytes = entry.pipe.read(want);
        if (!bytes) return wasi.block(entry.pipe.changed());
        for (const [ptr, len] of wasi.iovecs(iovs, count)) {
          const part = bytes.subarray(total, total + len);
          wasi.bytes(ptr, part.length).set(part);
          total += part.length;
        }
      } else if (entry.nif) {
        // A NIF library's answer (nif.ts), once the request is in.
        if (!entry.answer) {
          const request = new Uint8Array(entry.request!.reduce((n, part) => n + part.length, 0));
          let at = 0;
          for (const part of entry.request!) {
            request.set(part, at);
            at += part.length;
          }
          entry.answer = wasi.nifs.answer(entry.nif, request);
        }
        for (const [ptr, len] of wasi.iovecs(iovs, count)) {
          const part = entry.answer.subarray(entry.position!, entry.position! + len);
          wasi.bytes(ptr, part.length).set(part);
          entry.position! += part.length;
          total += part.length;
          if (part.length < len) break;
        }
      } else if (entry.spawn) {
        const process = entry.process;
        if (!process) return E.BADF;
        const [ptr, len] = wasi.iovecs(iovs, count)[0] || [0, 0];
        if (!process.output.length) {
          if (!process.ended) return E.AGAIN;
        } else {
          const chunk = process.output[0];
          const part = chunk.subarray(0, len);
          wasi.bytes(ptr, part.length).set(part);
          if (part.length === chunk.length) process.output.shift();
          else process.output[0] = chunk.subarray(part.length);
          total = part.length;
        }
      } else if (net) {
        const [ptr, len] = wasi.iovecs(iovs, count)[0] || [0, 0];
        let bytes: Uint8Array;
        if (entry.listener) {
          const next = entry.listener.shift();
          if (!next) return E.AGAIN;
          bytes = new TextEncoder().encode(`${next.id} ${next.ip} ${next.port}`);
        } else {
          if (!entry.endpoint!.inbox.length) {
            if (entry.endpoint!.eof) bytes = new Uint8Array(0);
            else return E.AGAIN;
          } else bytes = entry.endpoint!.take(len);
        }
        wasi.bytes(ptr, bytes.length).set(bytes.subarray(0, len));
        total = Math.min(len, bytes.length);
      } else if (entry.node instanceof Device) {
        for (const [ptr, len] of wasi.iovecs(iovs, count)) {
          const read = entry.node.read(len);
          wasi.bytes(ptr, read.length).set(read);
          total += read.length;
          if (read.length < len) break;
        }
      } else if (entry.stream && (entry.source || fd === 0)) {
        const want = wasi.iovecs(iovs, count).reduce((n, [, len]) => n + len, 0);
        const input = (entry.source ?? wasi.stdin)(want);
        if (input === null) return entry.ready ? wasi.block(entry.ready()) : E.AGAIN;
        let at = 0;
        for (const [ptr, len] of wasi.iovecs(iovs, count)) {
          const part = input.subarray(at, at + len);
          wasi.bytes(ptr, part.length).set(part);
          at += part.length;
        }
        total = at;
      } else {
        const file = entry.node;
        if (!(file instanceof File)) return E.ISDIR;
        for (const [ptr, len] of wasi.iovecs(iovs, count)) {
          const part = file.bytes.subarray(entry.position!, entry.position! + len);
          wasi.bytes(ptr, part.length).set(part);
          entry.position! += part.length;
          total += part.length;
          if (part.length < len) break;
        }
      }
      wasi.view().setUint32(nreadPtr, total, true);
      return ok;
    },
    fd_write(fd, iovs, count, nwrittenPtr) {
      const entry = wasi.fds.get(fd);
      if (!entry) return E.BADF;
      let total = 0;
      // A pipe takes what it has room for; with none, the writer waits.
      if (entry.pipe) {
        if (entry.reads) return E.BADF;
        for (const [ptr, len] of wasi.iovecs(iovs, count)) {
          const took = entry.pipe.write(wasi.bytes(ptr, len), wasi.suspending && wasi.bounded);
          if (took === -1 && !total) return E.PIPE;
          if (took === null && !total) return wasi.block(entry.pipe.changed());
          if (took === null || took === -1) break;
          total += took;
          if (took < len) break;
        }
        wasi.view().setUint32(nwrittenPtr, total, true);
        return ok;
      }
      for (const [ptr, len] of wasi.iovecs(iovs, count)) {
        const bytes = wasi.bytes(ptr, len);
        if (entry.nif) {
          entry.request!.push(bytes.slice());
        } else if (entry.terminal) {
          wasi.terminal!.mode(new TextDecoder().decode(bytes.slice()).trim());
        } else if (entry.spawn && !entry.process) {
          const error = spawn(wasi, entry, bytes);
          if (error) return error;
        } else if (entry.spawn) {
          entry.process!.input.push(bytes.slice());
        } else if (entry.endpoint) {
          entry.endpoint.peer.send(bytes.slice());
        } else if (entry.stream) {
          const sink = entry.sink ?? wasi.out[fd];
          if (sink) sink(bytes.slice());
        } else if (entry.node instanceof Device) {
          // A device takes what is written and keeps none of it (/dev/null).
        } else {
          const file = entry.node;
          if (!(file instanceof File)) return E.ISDIR;
          if (entry.append) entry.position = file.size;
          const end = entry.position! + len;
          file.reserve(end);
          file.data.set(bytes, entry.position);
          if (end > file.size) file.size = end;
          file.mtime = now();
          file.written = true;
          entry.changed = true;
          entry.position = end;
        }
        total += len;
      }
      wasi.view().setUint32(nwrittenPtr, total, true);
      return ok;
    },
    fd_seek(fd, offset, whence, ptr) {
      const entry = wasi.fds.get(fd);
      if (!entry) return E.BADF;
      if (entry.stream || entry.pipe) return E.SPIPE;
      const size = entry.node instanceof File ? entry.node.size : 0;
      const base = [0, entry.position, size][whence];
      if (base === undefined) return E.INVAL;
      const position = base + Number(offset);
      if (position < 0) return E.INVAL;
      entry.position = position;
      wasi.view().setBigUint64(ptr, BigInt(position), true);
      return ok;
    },
    fd_readdir(fd, buf, len, cookie, usedPtr) {
      const entry = wasi.fds.get(fd);
      if (!entry || !(entry.node instanceof Dir)) return E.NOTDIR;
      const v = wasi.view();
      const names = [...entry.node.entries.entries()];
      let used = 0;
      for (let i = Number(cookie); i < names.length && used < len; i++) {
        const [name, node] = names[i];
        const encoded = new TextEncoder().encode(name);
        const header = new Uint8Array(24);
        const h = new DataView(header.buffer);
        h.setBigUint64(0, BigInt(i + 1), true);
        h.setBigUint64(8, node.ino, true);
        h.setUint32(16, encoded.length, true);
        h.setUint8(20, fileType(node));
        const record = new Uint8Array(24 + encoded.length);
        record.set(header);
        record.set(encoded, 24);
        const room = Math.min(record.length, len - used);
        wasi.bytes(buf + used, room).set(record.subarray(0, room));
        used += room;
      }
      v.setUint32(usedPtr, used, true);
      return ok;
    },
    path_open(fd, dirflags, pathPtr, pathLen, oflags, _base, _inheriting, fdflags, fdPtr) {
      const path = wasi.string(pathPtr, pathLen).replace(/^\/+/, '');
      if (path === '.proc/spawn') {
        const opened = wasi.next++;
        wasi.fds.set(opened, { spawn: true, process: null });
        wasi.view().setUint32(fdPtr, opened, true);
        return ok;
      }
      // The terminal: writing `raw` or `cooked` to /.tty/mode sets its
      // input mode; /.tty/size reads as `COLUMNS ROWS`.
      if (path.startsWith('.tty/')) {
        let entry: Descriptor;
        if (!wasi.terminal) return E.NOENT;
        if (path === '.tty/mode') entry = { terminal: true, node: new File() };
        else if (path === '.tty/size') {
          entry = {
            node: new File(new TextEncoder().encode(wasi.terminal.size().join(' '))),
            position: 0,
          };
        } else return E.NOENT;
        const opened = wasi.next++;
        wasi.fds.set(opened, entry);
        wasi.view().setUint32(fdPtr, opened, true);
        return ok;
      }
      // A NIF library: /.nif/new loads one, /.nif/ID calls it (nif.ts).
      if (path.startsWith('.nif/')) {
        const opened = wasi.next++;
        wasi.fds.set(opened, { nif: path.slice(5), request: [], answer: null, position: 0 });
        wasi.view().setUint32(fdPtr, opened, true);
        return ok;
      }
      if (path.startsWith('.net/')) {
        const [, op, a, b] = path.split('/');
        const net = wasi.network;
        let entry: Descriptor;
        if (op === 'listen') {
          const listening = net.listen(Number(b));
          if (!listening) return E.ADDRINUSE;
          entry = { listener: listening.queue, port: listening.port };
        } else if (op === 'conn') {
          const endpoint = net.waiting.get(Number(a));
          if (!endpoint) return E.NOENT;
          net.waiting.delete(Number(a));
          entry = { endpoint };
        } else if (op === 'connect') {
          const endpoint = net.connect(Number(b));
          if (!endpoint) return E.CONNREFUSED;
          entry = { endpoint };
        } else if (op === 'https') {
          const endpoint = net.https(a, Number(b));
          if (!endpoint) return E.NOENT;
          entry = { endpoint };
        } else return E.NOENT;
        const opened = wasi.next++;
        wasi.fds.set(opened, entry);
        wasi.view().setUint32(fdPtr, opened, true);
        return ok;
      }
      const found = wasi.resolve(fd, wasi.string(pathPtr, pathLen), !!(dirflags & LOOKUP_SYMLINKS));
      let node = found.node;
      let changed = false;
      if (node && oflags & OFLAGS.CREAT && oflags & OFLAGS.EXCL) return E.EXIST;
      // O_NOFOLLOW on a symbolic link.
      if (node instanceof Symlink) return E.LOOP;
      if (!node) {
        if (!(oflags & OFLAGS.CREAT) || !found.parent) return found.error!;
        node = new File();
        node.written = true;
        changed = true;
        found.parent.entries.set(found.name!, node);
        found.parent.mtime = now();
      }
      if (oflags & OFLAGS.DIRECTORY && !(node instanceof Dir)) return E.NOTDIR;
      try {
        load(node, wasi.fetch);
      } catch {
        return E.IO;
      }
      if (node instanceof File && oflags & OFLAGS.TRUNC) {
        node.truncate(0);
        node.written = true;
        changed = true;
      }
      const opened = wasi.next++;
      wasi.fds.set(opened, {
        node,
        position: 0,
        append: !!(fdflags & FDFLAGS.APPEND),
        path: wasi.absolute(fd, wasi.string(pathPtr, pathLen)),
        changed,
      });
      wasi.view().setUint32(fdPtr, opened, true);
      return ok;
    },
    path_filestat_get(fd, flags, pathPtr, pathLen, ptr) {
      const found = wasi.resolve(fd, wasi.string(pathPtr, pathLen), !!(flags & LOOKUP_SYMLINKS));
      if (!found.node) return found.error;
      wasi.filestat(ptr, found.node);
      return ok;
    },
    path_create_directory(fd, pathPtr, pathLen) {
      const found = wasi.resolve(fd, wasi.string(pathPtr, pathLen));
      if (found.node) return E.EXIST;
      if (!found.parent) return found.error;
      const dir = new Dir();
      dir.parent = found.parent;
      found.parent.entries.set(found.name!, dir);
      wasi.onchange(wasi.absolute(fd, wasi.string(pathPtr, pathLen)));
      return ok;
    },
    path_remove_directory(fd, pathPtr, pathLen) {
      const found = wasi.resolve(fd, wasi.string(pathPtr, pathLen));
      if (!found.node) return found.error;
      if (!(found.node instanceof Dir)) return E.NOTDIR;
      if (found.node.entries.size) return E.NOTEMPTY;
      found.parent!.entries.delete(found.name!);
      wasi.onchange(wasi.absolute(fd, wasi.string(pathPtr, pathLen)));
      return ok;
    },
    path_unlink_file(fd, pathPtr, pathLen) {
      const found = wasi.resolve(fd, wasi.string(pathPtr, pathLen));
      if (!found.node) return found.error;
      if (found.node instanceof Dir) return E.ISDIR;
      found.parent!.entries.delete(found.name!);
      wasi.onchange(wasi.absolute(fd, wasi.string(pathPtr, pathLen)));
      return ok;
    },
    path_rename(fd, oldPtr, oldLen, fd2, newPtr, newLen) {
      const from = wasi.resolve(fd, wasi.string(oldPtr, oldLen));
      if (!from.node) return from.error;
      const to = wasi.resolve(fd2, wasi.string(newPtr, newLen));
      if (!to.parent) return to.error!;
      if (to.node instanceof Dir && to.node.entries.size) return E.NOTEMPTY;
      from.parent!.entries.delete(from.name!);
      to.parent.entries.set(to.name!, from.node);
      if (from.node instanceof Dir) from.node.parent = to.parent;
      wasi.onchange(wasi.absolute(fd, wasi.string(oldPtr, oldLen)));
      wasi.onchange(wasi.absolute(fd2, wasi.string(newPtr, newLen)));
      return ok;
    },
    // A hard link: the same file under a second name.
    path_link(fd, flags, oldPtr, oldLen, fd2, newPtr, newLen) {
      const from = wasi.resolve(fd, wasi.string(oldPtr, oldLen), !!(flags & LOOKUP_SYMLINKS));
      if (!from.node) return from.error;
      if (from.node instanceof Dir) return E.PERM;
      const to = wasi.resolve(fd2, wasi.string(newPtr, newLen));
      if (to.node) return E.EXIST;
      if (!to.parent) return to.error;
      to.parent.entries.set(to.name!, from.node);
      wasi.onchange(wasi.absolute(fd2, wasi.string(newPtr, newLen)));
      return ok;
    },
    path_symlink(targetPtr, targetLen, fd, pathPtr, pathLen) {
      const found = wasi.resolve(fd, wasi.string(pathPtr, pathLen));
      if (found.node) return E.EXIST;
      if (!found.parent) return found.error;
      found.parent.entries.set(found.name!, new Symlink(wasi.string(targetPtr, targetLen)));
      found.parent.mtime = now();
      wasi.onchange(wasi.absolute(fd, wasi.string(pathPtr, pathLen)));
      return ok;
    },
    path_readlink(fd, pathPtr, pathLen, buf, bufLen, usedPtr) {
      const found = wasi.resolve(fd, wasi.string(pathPtr, pathLen));
      if (!found.node) return found.error;
      if (!(found.node instanceof Symlink)) return E.INVAL;
      const target = new TextEncoder().encode(found.node.target).subarray(0, bufLen);
      wasi.bytes(buf, target.length).set(target);
      wasi.view().setUint32(usedPtr, target.length, true);
      return ok;
    },
    sock_accept: () => E.NOSYS,
    sock_shutdown: () => E.NOSYS,
  };
}
