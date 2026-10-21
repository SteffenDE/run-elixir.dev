// Node's fs over the shared files (files.js), through the worker's
// synchronous channel (wasi/shared.ts sharedClient): the synchronous calls
// as they are, the callback and promise ones on top of them. Paths are
// absolute or the process's directory's; files.js holds /work and /tmp.
import { Buffer } from './buffer';
import { EventEmitter } from 'events';
import * as streams from 'readable-stream';
import { E } from '../wasi/abi';
import type { SharedCall } from '../wasi/shared';

const { Readable, Writable, finished } = streams as typeof import('node:stream');

const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const CHUNK = 512 * 1024;

// WASI's errno numbers by Node's codes.
const CODES: Record<number, [string, number, string]> = {
  [E.ACCES]: ['EACCES', -13, 'permission denied'],
  [E.BADF]: ['EBADF', -9, 'bad file descriptor'],
  [E.EXIST]: ['EEXIST', -17, 'file already exists'],
  [E.INVAL]: ['EINVAL', -22, 'invalid argument'],
  [E.IO]: ['EIO', -5, 'i/o error'],
  [E.ISDIR]: ['EISDIR', -21, 'illegal operation on a directory'],
  [E.LOOP]: ['ELOOP', -40, 'too many symbolic links encountered'],
  [E.NOENT]: ['ENOENT', -2, 'no such file or directory'],
  [E.NOSYS]: ['ENOSYS', -38, 'function not implemented'],
  [E.NOTDIR]: ['ENOTDIR', -20, 'not a directory'],
  [E.NOTEMPTY]: ['ENOTEMPTY', -39, 'directory not empty'],
  [E.NOTSUP]: ['ENOTSUP', -95, 'operation not supported on socket'],
  [E.PERM]: ['EPERM', -1, 'operation not permitted'],
};

export interface NodeError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path?: string;
  dest?: string;
}

export function fsError(errno: number, syscall: string, path?: string, dest?: string): NodeError {
  const [code, number, text] = CODES[errno] ?? ['EIO', -5, 'i/o error'];
  const error = new Error(
    `${code}: ${text}, ${syscall}${path === undefined ? '' : ` '${path}'`}${dest === undefined ? '' : ` -> '${dest}'`}`,
  ) as NodeError;
  Object.assign(error, { code, errno: number, syscall });
  if (path !== undefined) error.path = path;
  if (dest !== undefined) error.dest = dest;
  return error;
}

export class Stats {
  dev = 1;
  mode: number;
  nlink = 1;
  // The process's own (process.getuid()), as a user's files are.
  uid = 1000;
  gid = 1000;
  rdev = 0;
  blksize = 4096;
  ino: number;
  size: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  constructor(
    private kind: string,
    size: number,
    ino: number,
    mtimeNs: string,
  ) {
    this.mode = kind === 'dir' ? 0o40755 : kind === 'link' ? 0o120777 : 0o100644;
    this.size = size;
    this.ino = ino;
    this.blocks = Math.ceil(size / 512);
    const ms = Number(BigInt(mtimeNs || '0') / 1_000_000n);
    this.atimeMs = this.mtimeMs = this.ctimeMs = this.birthtimeMs = ms;
    this.atime = this.mtime = this.ctime = this.birthtime = new Date(ms);
  }
  isFile = () => this.kind === 'file';
  isDirectory = () => this.kind === 'dir';
  isSymbolicLink = () => this.kind === 'link';
  isBlockDevice = () => false;
  isCharacterDevice = () => false;
  isFIFO = () => false;
  isSocket = () => false;
}

export class Dirent {
  constructor(
    public name: string,
    private kind: string,
    public parentPath: string,
  ) {}
  get path(): string {
    return this.parentPath;
  }
  isFile = () => this.kind === 'file';
  isDirectory = () => this.kind === 'dir';
  isSymbolicLink = () => this.kind === 'link';
  isBlockDevice = () => false;
  isCharacterDevice = () => false;
  isFIFO = () => false;
  isSocket = () => false;
}

type Data = string | ArrayBufferView;
type Encoding = BufferEncoding | null | undefined;
type Options = Encoding | { encoding?: Encoding; flag?: string; recursive?: boolean };

const encodingOf = (options: unknown): Encoding =>
  typeof options === 'string'
    ? (options as BufferEncoding)
    : ((options as { encoding?: Encoding } | undefined)?.encoding ?? null);

const toBytes = (data: Data, encoding?: Encoding): Uint8Array =>
  typeof data === 'string'
    ? Buffer.from(data, encoding ?? 'utf8')
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

// createReadStream's and createWriteStream's options.
interface StreamOptions {
  flags?: string;
  encoding?: BufferEncoding;
  fd?: number | { fd: number } | null;
  mode?: number;
  autoClose?: boolean;
  emitClose?: boolean;
  start?: number;
  end?: number;
  highWaterMark?: number;
  signal?: AbortSignal;
}

// A ReadStream or a WriteStream: its file and where it is in it.
interface FileStream extends EventEmitter {
  path?: unknown;
  fd: number | null;
  flags: string;
  mode: number;
  start?: number;
  pos?: number;
  autoClose: boolean;
  open(): void;
}
type ReadFile = InstanceType<typeof Readable> & FileStream & { end: number; bytesRead: number };
type WriteFile = InstanceType<typeof Writable> & FileStream & { bytesWritten: number };
type Made = new (path: unknown, options?: unknown) => FileStream;
type Base = (this: unknown, options: object) => void;

// A read's or write's position, or null for the file's own (null, -1).
const positionOf = (position: unknown): number | null =>
  typeof position === 'bigint'
    ? Number(position)
    : typeof position === 'number' && position >= 0
      ? position
      : null;

// An open file: files.js's handle and where it reads and writes next.
interface Open {
  handle: number;
  path: string;
  position: number;
  append: boolean;
}

// fs.constants' open flags (Linux's), and flag strings as open takes them.
const O = {
  RDONLY: 0,
  WRONLY: 1,
  RDWR: 2,
  CREAT: 64,
  EXCL: 128,
  TRUNC: 512,
  APPEND: 1024,
  DIRECTORY: 65536,
  NOFOLLOW: 131072,
};
const FLAGS: Record<string, number> = {
  r: O.RDONLY,
  'r+': O.RDWR,
  rs: O.RDONLY,
  'rs+': O.RDWR,
  w: O.WRONLY | O.CREAT | O.TRUNC,
  wx: O.WRONLY | O.CREAT | O.TRUNC | O.EXCL,
  'w+': O.RDWR | O.CREAT | O.TRUNC,
  'wx+': O.RDWR | O.CREAT | O.TRUNC | O.EXCL,
  a: O.WRONLY | O.CREAT | O.APPEND,
  ax: O.WRONLY | O.CREAT | O.APPEND | O.EXCL,
  'a+': O.RDWR | O.CREAT | O.APPEND,
  'ax+': O.RDWR | O.CREAT | O.APPEND | O.EXCL,
};

// The process's fs module: { cwd } is read at each call.
export function createFs(call: SharedCall, cwd: () => string, resolvePath: (p: string) => string) {
  const files = new Map<number, Open>();
  // 0-2 are the process's stdio.
  let nextFd = 3;

  const pathOf = (p: unknown): string => {
    if (p instanceof URL) p = decodeURIComponent(p.pathname);
    else if (p instanceof Uint8Array) p = Buffer.from(p).toString();
    if (typeof p !== 'string') {
      const error = new TypeError(
        `The "path" argument must be of type string. Received ${typeof p}`,
      ) as TypeError & { code: string };
      error.code = 'ERR_INVALID_ARG_TYPE';
      throw error;
    }
    return throughFd(resolvePath(p));
  };

  // /proc/self/fd/N (and /dev/fd/N): the file or directory open as fd N,
  // and what is below it, as on Linux (Claude Code writes its output into
  // a directory it holds open, by such a path).
  const FD_PATH = /^\/(?:proc\/self|dev)\/fd\/(\d+)(\/.*)?$/;
  const throughFd = (path: string): string => {
    const match = FD_PATH.exec(path);
    const open = match ? files.get(Number(match[1])) : undefined;
    return open ? `${open.path}${match![2] ?? ''}` : path;
  };

  const ask = (
    syscall: string,
    path: string | undefined,
    request: Record<string, unknown>,
    bytes?: Uint8Array,
  ) => {
    const result = call(request, bytes);
    if (result.answer.error) throw fsError(result.answer.error, syscall, path);
    return result;
  };

  const stat = (
    p: unknown,
    follow: boolean,
    syscall: string,
    throwIfNoEntry = true,
  ): Stats | undefined => {
    const path = pathOf(p);
    const { answer } = call({ op: 'stat', path, follow });
    if (answer.error) {
      if (!throwIfNoEntry && (answer.error === E.NOENT || answer.error === E.NOTDIR))
        return undefined;
      throw fsError(answer.error, syscall, String(p));
    }
    return new Stats(answer.type, answer.size, answer.ino, answer.mtime);
  };

  const openFd = (p: unknown, flags: string | number = 'r'): number => {
    const path = pathOf(p);
    const f = typeof flags === 'number' ? flags : FLAGS[flags];
    if (f === undefined) throw fsError(E.INVAL, 'open', String(p));
    // A directory opens read-only, as a handle for fstat and close alone.
    if (f & (O.DIRECTORY | O.NOFOLLOW) || !(f & (O.WRONLY | O.RDWR | O.CREAT))) {
      const kind = stat(p, !(f & O.NOFOLLOW), 'open', false);
      if (f & O.NOFOLLOW && kind?.isSymbolicLink()) throw fsError(E.LOOP, 'open', String(p));
      if (f & O.DIRECTORY && kind && !kind.isDirectory())
        throw fsError(E.NOTDIR, 'open', String(p));
      if (kind?.isDirectory()) {
        const fd = nextFd++;
        files.set(fd, { handle: -1, path, position: 0, append: false });
        return fd;
      }
    }
    let oflags = 0;
    if (f & O.CREAT) oflags |= OFLAGS.CREAT;
    if (f & O.EXCL) oflags |= OFLAGS.EXCL;
    if (f & O.TRUNC) oflags |= OFLAGS.TRUNC;
    const { answer } = ask('open', String(p), { op: 'open', path, oflags });
    const fd = nextFd++;
    files.set(fd, { handle: answer.handle, path, position: 0, append: Boolean(f & O.APPEND) });
    return fd;
  };

  const opened = (fd: number, syscall: string): Open => {
    const file = files.get(fd);
    if (!file) throw fsError(E.BADF, syscall);
    return file;
  };

  const readAll = (handle: number, from = 0): Uint8Array => {
    const chunks: Uint8Array[] = [];
    let offset = from;
    for (;;) {
      const { bytes } = call({ op: 'read', handle, offset, length: CHUNK });
      chunks.push(bytes);
      offset += bytes.length;
      if (bytes.length < CHUNK) break;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  };

  // Where the write ended.
  const writeAt = (file: Open, bytes: Uint8Array, offset: number): number => {
    let end = offset;
    for (let at = 0; at < bytes.length; at += CHUNK) {
      const request = {
        op: 'write',
        handle: file.handle,
        offset: offset + at,
        append: file.append,
      };
      end = ask('write', file.path, request, bytes.subarray(at, at + CHUNK)).answer.position;
    }
    return end;
  };

  const sync = {
    existsSync(p: unknown): boolean {
      try {
        return stat(p, true, 'stat', false) !== undefined;
      } catch {
        return false;
      }
    },
    statSync: (p: unknown, options?: { throwIfNoEntry?: boolean }) =>
      stat(p, true, 'stat', options?.throwIfNoEntry ?? true),
    lstatSync: (p: unknown, options?: { throwIfNoEntry?: boolean }) =>
      stat(p, false, 'lstat', options?.throwIfNoEntry ?? true),
    fstatSync(fd: number): Stats {
      if (fd <= 2) return new Stats('file', 0, fd, '0');
      const file = opened(fd, 'fstat');
      if (file.handle === -1) return stat(file.path, true, 'fstat')!;
      const { answer } = ask('fstat', undefined, { op: 'fstat', handle: file.handle });
      return new Stats(answer.type, answer.size, answer.ino, answer.mtime);
    },
    accessSync(p: unknown): void {
      stat(p, true, 'access');
    },
    openSync: (p: unknown, flags?: string | number) => openFd(p, flags),
    closeSync(fd: number): void {
      const file = files.get(fd);
      if (!file) return;
      files.delete(fd);
      if (file.handle !== -1) call({ op: 'close', handle: file.handle });
    },
    readSync(
      fd: number,
      buffer: ArrayBufferView,
      offsetOrOptions?: number | { offset?: number; length?: number; position?: number | null },
      length?: number,
      position?: number | null,
    ): number {
      let offset = 0;
      if (typeof offsetOrOptions === 'object' && offsetOrOptions) {
        ({ offset = 0, length, position } = offsetOrOptions);
      } else offset = offsetOrOptions ?? 0;
      const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      length ??= view.length - offset;
      if (fd === 0) return 0;
      const file = opened(fd, 'read');
      const given = positionOf(position);
      const at = given ?? file.position;
      const { bytes } = ask('read', file.path, {
        op: 'read',
        handle: file.handle,
        offset: at,
        length: Math.min(length, CHUNK),
      });
      view.set(bytes, offset);
      if (given === null) file.position = at + bytes.length;
      return bytes.length;
    },
    writeSync(
      fd: number,
      data: Data,
      offsetOrPosition?: unknown,
      lengthOrEncoding?: unknown,
      position?: number | null,
    ): number {
      let bytes: Uint8Array;
      let at: number | null | undefined;
      if (typeof data === 'string') {
        bytes = Buffer.from(data, (lengthOrEncoding as BufferEncoding) ?? 'utf8');
        at = offsetOrPosition as number | null | undefined;
      } else {
        const view = toBytes(data);
        const offset = (offsetOrPosition as number) ?? 0;
        const length = (lengthOrEncoding as number) ?? view.length - offset;
        bytes = view.subarray(offset, offset + length);
        at = position;
      }
      if (fd === 1 || fd === 2) {
        stdio(fd, bytes);
        return bytes.length;
      }
      const file = opened(fd, 'write');
      const given = positionOf(at);
      const end = writeAt(file, bytes, given ?? file.position);
      if (given === null) file.position = end;
      return bytes.length;
    },
    ftruncateSync(fd: number, size = 0): void {
      const file = opened(fd, 'ftruncate');
      ask('ftruncate', file.path, { op: 'truncate', handle: file.handle, size });
    },
    truncateSync(p: unknown, size = 0): void {
      const fd = openFd(p, 'r+');
      try {
        sync.ftruncateSync(fd, size);
      } finally {
        sync.closeSync(fd);
      }
    },
    fsyncSync(): void {},
    fdatasyncSync(): void {},
    readFileSync(p: unknown, options?: Options): string | Buffer {
      const encoding = encodingOf(options);
      // An open file's from its position on, which moves.
      if (typeof p === 'number') {
        const file = opened(p, 'read');
        const bytes = readAll(file.handle, file.position);
        file.position += bytes.length;
        return decode(bytes, encoding);
      }
      const path = pathOf(p);
      const { answer } = ask('open', String(p), { op: 'open', path });
      if (answer.type === 'dir') {
        call({ op: 'close', handle: answer.handle });
        throw fsError(E.ISDIR, 'read');
      }
      try {
        return decode(readAll(answer.handle), encoding);
      } finally {
        call({ op: 'close', handle: answer.handle });
      }
    },
    writeFileSync(p: unknown, data: Data, options?: Options): void {
      const flag = (typeof options === 'object' && options?.flag) || 'w';
      const fd = typeof p === 'number' ? p : openFd(p, flag);
      try {
        sync.writeSync(fd, toBytes(data, encodingOf(options)));
      } finally {
        if (typeof p !== 'number') sync.closeSync(fd);
      }
    },
    appendFileSync(p: unknown, data: Data, options?: Options): void {
      sync.writeFileSync(p, data, { encoding: encodingOf(options), flag: 'a' });
    },
    readdirSync(p: unknown, options?: Options & { withFileTypes?: boolean; recursive?: boolean }) {
      const path = pathOf(p);
      const withTypes = typeof options === 'object' && options?.withFileTypes;
      const recursive = typeof options === 'object' && options?.recursive;
      const list = (dir: string, prefix: string): (string | Dirent)[] => {
        const { answer } = ask('scandir', String(p), {
          op: 'open',
          path: dir,
          oflags: OFLAGS.DIRECTORY,
        });
        let entries: [string, string][];
        try {
          entries = ask('scandir', String(p), { op: 'readdir', handle: answer.handle }).answer
            .entries;
        } finally {
          call({ op: 'close', handle: answer.handle });
        }
        const out: (string | Dirent)[] = [];
        for (const [name, kind] of entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          out.push(withTypes ? new Dirent(name, kind, dir) : prefix + name);
          if (recursive && kind === 'dir') out.push(...list(`${dir}/${name}`, `${prefix}${name}/`));
        }
        return out;
      };
      return list(path, '');
    },
    mkdirSync(
      p: unknown,
      options?: number | { recursive?: boolean; mode?: number },
    ): string | undefined {
      const path = pathOf(p);
      if (typeof options === 'object' && options?.recursive) {
        let first: string | undefined;
        let at = '';
        for (const part of path.split('/').filter(Boolean)) {
          at += `/${part}`;
          const { answer } = call({ op: 'stat', path: at, follow: true });
          if (!answer.error) {
            // A file there is EEXIST, one on the way ENOTDIR.
            if (answer.type !== 'dir')
              throw fsError(
                at === path.replace(/\/+$/, '') ? E.EXIST : E.NOTDIR,
                'mkdir',
                String(p),
              );
            continue;
          }
          ask('mkdir', String(p), { op: 'mkdir', path: at });
          first ??= at;
        }
        return first;
      }
      ask('mkdir', String(p), { op: 'mkdir', path });
      return undefined;
    },
    mkdtempSync(prefix: string): string {
      for (;;) {
        const path = prefix + Math.random().toString(36).slice(2, 8);
        try {
          sync.mkdirSync(path);
          return path;
        } catch (error) {
          if ((error as NodeError).code !== 'EEXIST') throw error;
        }
      }
    },
    rmdirSync(p: unknown, options?: { recursive?: boolean }): void {
      if (options?.recursive) return sync.rmSync(p, { recursive: true, force: true });
      ask('rmdir', String(p), { op: 'rmdir', path: pathOf(p) });
    },
    unlinkSync(p: unknown): void {
      ask('unlink', String(p), { op: 'unlink', path: pathOf(p) });
    },
    rmSync(p: unknown, options?: { recursive?: boolean; force?: boolean }): void {
      const path = pathOf(p);
      const found = stat(path, false, 'rm', false);
      if (!found) {
        if (options?.force) return;
        throw fsError(E.NOENT, 'rm', String(p));
      }
      if (found.isDirectory()) {
        if (!options?.recursive) throw fsError(E.ISDIR, 'rm', String(p));
        for (const name of sync.readdirSync(path) as string[])
          sync.rmSync(`${path}/${name}`, options);
        ask('rmdir', String(p), { op: 'rmdir', path });
      } else ask('unlink', String(p), { op: 'unlink', path });
    },
    renameSync(from: unknown, to: unknown): void {
      ask('rename', String(from), { op: 'rename', path: pathOf(from), to: pathOf(to) });
    },
    copyFileSync(from: unknown, to: unknown, mode = 0): void {
      const data = sync.readFileSync(from) as Buffer;
      // COPYFILE_EXCL: not over a file there.
      if (mode & 1 && sync.existsSync(to))
        throw fsError(E.EXIST, 'copyfile', String(from), String(to));
      sync.writeFileSync(to, data);
    },
    cpSync(from: unknown, to: unknown, options?: { recursive?: boolean }): void {
      const source = pathOf(from);
      const target = pathOf(to);
      if (sync.statSync(source)!.isDirectory()) {
        if (!options?.recursive) throw fsError(E.ISDIR, 'cp', String(from));
        sync.mkdirSync(target, { recursive: true });
        for (const name of sync.readdirSync(source) as string[])
          sync.cpSync(`${source}/${name}`, `${target}/${name}`, options);
      } else sync.copyFileSync(source, target);
    },
    symlinkSync(target: string, p: unknown): void {
      ask('symlink', String(p), { op: 'symlink', path: pathOf(p), target });
    },
    linkSync(from: unknown, to: unknown): void {
      ask('link', String(from), { op: 'link', path: pathOf(from), to: pathOf(to) });
    },
    readlinkSync(p: unknown): string {
      // An fd's link: the path it was opened by.
      const fd = typeof p === 'string' ? /^\/(?:proc\/self|dev)\/fd\/(\d+)$/.exec(p) : null;
      const open = fd ? files.get(Number(fd[1])) : undefined;
      if (open) return open.path;
      return ask('readlink', String(p), { op: 'readlink', path: pathOf(p) }).answer.target;
    },
    realpathSync(p: unknown): string {
      let path = pathOf(p);
      // Each component, its symbolic link (if one) followed.
      for (let hops = 0; hops < 40; hops++) {
        const parts = path.split('/').filter(Boolean);
        let at = '';
        let changed = false;
        for (let i = 0; i < parts.length; i++) {
          const next = `${at}/${parts[i]}`;
          const { answer } = call({ op: 'stat', path: next, follow: false });
          if (answer.error) throw fsError(answer.error, 'realpath', String(p));
          if (answer.type === 'link') {
            const target = call({ op: 'readlink', path: next }).answer.target as string;
            const base = target.startsWith('/') ? target : `${at}/${target}`;
            path = resolvePath([base, ...parts.slice(i + 1)].join('/'));
            changed = true;
            break;
          }
          at = next;
        }
        if (!changed) return at || '/';
      }
      throw fsError(E.LOOP, 'realpath', String(p));
    },
    chmodSync(): void {},
    fchmodSync(): void {},
    lchmodSync(): void {},
    chownSync(): void {},
    fchownSync(): void {},
    lchownSync(): void {},
    utimesSync(): void {},
    futimesSync(): void {},
    lutimesSync(): void {},
  };
  (sync.realpathSync as unknown as { native: unknown }).native = sync.realpathSync;

  // Output on 1 and 2 goes where the process's stdout and stderr go.
  let stdio: (fd: number, bytes: Uint8Array) => void = () => {};

  // The callback forms: the synchronous call, its answer later.
  const callbacks: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(sync)) {
    if (!name.endsWith('Sync')) continue;
    const base = name.slice(0, -4);
    callbacks[base] = (...args: unknown[]) => {
      const done =
        typeof args[args.length - 1] === 'function'
          ? (args.pop() as (...a: unknown[]) => void)
          : null;
      let result: unknown;
      let error: unknown = null;
      try {
        result = (fn as (...a: unknown[]) => unknown)(...args);
      } catch (e) {
        error = e;
      }
      if (done) later(() => (base === 'exists' ? done(result) : done(error, result)));
    };
  }
  (callbacks.realpath as { native?: unknown }).native = callbacks.realpath;
  // read and write answer how much, and the buffer.
  callbacks.read = (fd: number, buffer: ArrayBufferView, ...rest: unknown[]) => {
    const done = rest.pop() as (e: unknown, n?: number, b?: ArrayBufferView) => void;
    try {
      const n = sync.readSync(fd, buffer, ...(rest as [number, number, number]));
      later(() => done(null, n, buffer));
    } catch (e) {
      later(() => done(e));
    }
  };
  callbacks.write = (fd: number, data: Data, ...rest: unknown[]) => {
    const done =
      typeof rest[rest.length - 1] === 'function'
        ? (rest.pop() as (e: unknown, n?: number, d?: Data) => void)
        : () => {};
    try {
      const n = sync.writeSync(fd, data, ...(rest as [number]));
      later(() => done(null, n, data));
    } catch (e) {
      later(() => done(e));
    }
  };
  // What util.promisify makes of them, as Node's.
  const promisified = Symbol.for('nodejs.util.promisify.custom');
  Object.assign(callbacks.exists as object, {
    [promisified]: async (p: unknown) => sync.existsSync(p),
  });
  Object.assign(callbacks.read as object, {
    [promisified]: async (fd: number, buffer: ArrayBufferView, ...rest: unknown[]) => ({
      bytesRead: sync.readSync(fd, buffer, ...(rest as [number, number, number])),
      buffer,
    }),
  });
  Object.assign(callbacks.write as object, {
    [promisified]: async (fd: number, data: Data, ...rest: unknown[]) => ({
      bytesWritten: sync.writeSync(fd, data, ...(rest as [number])),
      buffer: data,
    }),
  });

  // The promise forms.
  const promises: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(sync)) {
    if (!name.endsWith('Sync') || name === 'existsSync') continue;
    promises[name.slice(0, -4)] = async (...args: unknown[]) =>
      (fn as (...a: unknown[]) => unknown)(...args);
  }
  promises.open = async (p: unknown, flags?: string) => fileHandle(sync.openSync(p, flags));
  promises.rm = async (p: unknown, options?: { recursive?: boolean; force?: boolean }) =>
    sync.rmSync(p, options);
  const fileHandle = (fd: number) => ({
    fd,
    readFile: async (options?: Options) => sync.readFileSync(fd, options),
    writeFile: async (data: Data, options?: Options) => sync.writeFileSync(fd, data, options),
    read: async (buffer: ArrayBufferView, offset?: number, length?: number, position?: number) => ({
      bytesRead: sync.readSync(fd, buffer, offset, length, position),
      buffer,
    }),
    write: async (data: Data, ...rest: unknown[]) => ({
      bytesWritten: sync.writeSync(fd, data, ...(rest as [number])),
      buffer: data,
    }),
    stat: async () => sync.fstatSync(fd),
    truncate: async (size?: number) => sync.ftruncateSync(fd, size),
    sync: async () => undefined,
    datasync: async () => undefined,
    chmod: async () => undefined,
    chown: async () => undefined,
    utimes: async () => undefined,
    close: async () => sync.closeSync(fd),
    createReadStream: (options?: StreamOptions) =>
      new (ReadStream as unknown as Made)(undefined, { ...options, fd }),
    createWriteStream: (options?: StreamOptions) =>
      new (WriteStream as unknown as Made)(undefined, { ...options, fd }),
    [Symbol.asyncDispose]: async () => sync.closeSync(fd),
  });

  // fs.ReadStream and fs.WriteStream, over openSync, readSync, writeSync
  // and closeSync. Functions, as Node's are: graceful-fs applies them to
  // its own, whose open() (if it has one) opens the file, saying so by
  // 'open' or 'error'.
  const streamOptions = (options: unknown): StreamOptions =>
    typeof options === 'string'
      ? { encoding: options as BufferEncoding }
      : ((options ?? {}) as StreamOptions);
  const setUp = (stream: FileStream, path: unknown, o: StreamOptions, flags: string) => {
    stream.fd =
      o.fd === undefined || o.fd === null ? null : typeof o.fd === 'number' ? o.fd : o.fd.fd;
    if (stream.fd === null)
      stream.path = path instanceof URL ? decodeURIComponent(path.pathname) : path;
    stream.flags = o.flags ?? flags;
    stream.mode = o.mode ?? 0o666;
    stream.start = o.start;
    stream.pos = o.start;
    stream.autoClose = o.autoClose ?? true;
  };
  // Node's own open(): none to call, the stream opens its file itself.
  function openFile() {}
  function construct(this: FileStream, callback: (error?: Error | null) => void) {
    if (typeof this.fd === 'number') return callback();
    if (this.open !== openFile) {
      const emit = this.emit;
      this.emit = function (this: FileStream, event: string | symbol, ...args: unknown[]) {
        if (event === 'open' || event === 'error') this.emit = emit;
        if (event === 'error') return (callback(args[0] as Error), true);
        if (event === 'open') callback();
        return emit.apply(this, [event, ...args]);
      };
      return this.open();
    }
    let fd: number;
    try {
      fd = sync.openSync(this.path, this.flags);
    } catch (error) {
      return callback(error as Error);
    }
    this.fd = fd;
    callback();
    this.emit('open', fd);
    this.emit('ready');
  }
  function destroy(this: FileStream, error: Error | null, callback: (e: Error | null) => void) {
    const fd = this.fd;
    if (fd !== null && this.autoClose) {
      this.fd = null;
      sync.closeSync(fd);
    }
    callback(error);
  }
  const pending = {
    get(this: FileStream) {
      return this.fd === null;
    },
  };

  function ReadStream(this: ReadFile, path: unknown, options?: unknown) {
    if (!(this instanceof ReadStream)) return new (ReadStream as unknown as Made)(path, options);
    const o = streamOptions(options);
    (Readable as unknown as Base).call(this, {
      highWaterMark: o.highWaterMark ?? 64 * 1024,
      encoding: o.encoding,
      emitClose: o.emitClose ?? true,
      autoDestroy: o.autoClose ?? true,
      signal: o.signal,
    });
    setUp(this, path, o, 'r');
    this.end = o.end ?? Infinity;
    this.bytesRead = 0;
  }
  Object.setPrototypeOf(ReadStream.prototype, Readable.prototype);
  Object.setPrototypeOf(ReadStream, Readable);
  Object.defineProperty(ReadStream.prototype, 'pending', pending);
  Object.assign(ReadStream.prototype, {
    open: openFile,
    _construct: construct,
    _destroy: destroy,
    // Up to `end` (inclusive), from `start` or where the file is.
    _read(this: ReadFile, n: number) {
      n = Math.min(
        n,
        (this.pos !== undefined ? this.end - this.pos : this.end - this.bytesRead) + 1,
      );
      if (n <= 0) return void this.push(null);
      const buffer = Buffer.alloc(n);
      later(() => {
        let read: number;
        try {
          read = sync.readSync(this.fd!, buffer, 0, n, this.pos ?? null);
        } catch (error) {
          return void this.destroy(error as Error);
        }
        if (!read) return void this.push(null);
        if (this.pos !== undefined) this.pos += read;
        this.bytesRead += read;
        this.push(read === n ? buffer : buffer.subarray(0, read));
      });
    },
    close(this: ReadFile, callback?: (error?: Error | null) => void) {
      if (typeof callback === 'function') finished(this, callback);
      this.destroy();
    },
  });

  function WriteStream(this: WriteFile, path: unknown, options?: unknown) {
    if (!(this instanceof WriteStream)) return new (WriteStream as unknown as Made)(path, options);
    const o = streamOptions(options);
    (Writable as unknown as Base).call(this, {
      highWaterMark: o.highWaterMark,
      decodeStrings: true,
      emitClose: o.emitClose ?? true,
      autoDestroy: o.autoClose ?? true,
      signal: o.signal,
    });
    setUp(this, path, o, 'w');
    this.bytesWritten = 0;
    if (o.encoding) this.setDefaultEncoding(o.encoding);
  }
  Object.setPrototypeOf(WriteStream.prototype, Writable.prototype);
  Object.setPrototypeOf(WriteStream, Writable);
  Object.defineProperty(WriteStream.prototype, 'pending', pending);
  Object.assign(WriteStream.prototype, {
    open: openFile,
    _construct: construct,
    _destroy: destroy,
    // At `start` on, or where the file is.
    _write(this: WriteFile, chunk: Buffer, _encoding: string, callback: (e?: Error) => void) {
      let written: number;
      try {
        written = sync.writeSync(this.fd!, chunk, 0, chunk.length, this.pos ?? null);
      } catch (error) {
        return callback(error as Error);
      }
      if (this.pos !== undefined) this.pos += written;
      this.bytesWritten += written;
      callback();
    },
    // Ended, then closed.
    close(this: WriteFile, callback?: () => void) {
      if (callback) {
        if (this.closed) return void queueMicrotask(callback);
        this.on('close', callback);
      }
      if (!this.autoClose) this.on('finish', () => this.destroy());
      this.end();
    },
    destroySoon(this: WriteFile) {
      return this.end();
    },
  });

  // Run `fn` after this turn, as a callback's answer comes.
  let later: (fn: () => void) => void = (fn) => setTimeout(fn, 0);
  // A handle that keeps the process's loop alive until released.
  let hold: () => () => void = () => () => {};

  // Watchers: told what changed (the page passes on what files.js
  // reports, `changed`), as Node's are by the system. A path's own change
  // is 'change'; one that is gone, or was not there, is 'rename'.
  const watches = new Set<Watch>();
  const kind = (path: string) => {
    try {
      return sync.statSync(path)!.isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  };
  class FSWatcher extends EventEmitter {
    declare watch: Watch;
    constructor(entry: Watch) {
      super();
      this.watch = entry;
    }
    close() {
      if (!watches.delete(this.watch)) return;
      this.watch.release?.();
      this.watch.release = null;
      queueMicrotask(() => this.emit('close'));
    }
    ref() {
      this.watch.release ??= hold();
      return this;
    }
    unref() {
      this.watch.release?.();
      this.watch.release = null;
      return this;
    }
  }
  const watch = (
    p: unknown,
    options?:
      | string
      | { persistent?: boolean; recursive?: boolean; encoding?: string; signal?: AbortSignal }
      | ((event: string, name: string) => void),
    listener?: (event: string, name: string) => void,
  ) => {
    if (typeof options === 'function') [listener, options] = [options, undefined];
    const settings = typeof options === 'object' && options ? options : {};
    const path = pathOf(p);
    const is = kind(path);
    if (!is) throw fsError(E.NOENT, 'watch', String(p));
    const entry: Watch = {
      path,
      dir: is === 'dir',
      recursive: Boolean(settings.recursive),
      release: settings.persistent === false ? null : hold(),
      known: new Set(is === 'dir' ? (sync.readdirSync(path) as string[]) : []),
      tell: () => {},
    };
    const watcher = new FSWatcher(entry);
    entry.tell = (event, name) => watcher.emit('change', event, name);
    if (listener) watcher.on('change', listener);
    settings.signal?.addEventListener('abort', () => watcher.close(), { once: true });
    watches.add(entry);
    return watcher;
  };
  // watchFile: a file's stats before and after each change.
  const polled = new Map<string, { watcher: FSWatcher; listeners: Set<Function>; last: Stats }>();
  const emptyStats = () => new Stats('file', 0, 0, '0');
  const watchFile = (p: unknown, options?: unknown, listener?: unknown) => {
    if (typeof options === 'function') [listener, options] = [options, undefined];
    const path = pathOf(p);
    let entry = polled.get(path);
    if (!entry) {
      const polling: Watch = {
        path,
        dir: false,
        recursive: false,
        release: (options as { persistent?: boolean })?.persistent === false ? null : hold(),
        known: new Set(),
        tell: () => {},
      };
      const last = (sync.statSync(path, { throwIfNoEntry: false }) as Stats) ?? emptyStats();
      const made = { watcher: new FSWatcher(polling), listeners: new Set<Function>(), last };
      polling.tell = () => {
        const now = (sync.statSync(path, { throwIfNoEntry: false }) as Stats) ?? emptyStats();
        const before = made.last;
        made.last = now;
        for (const fn of made.listeners) fn(now, before);
      };
      watches.add(polling);
      polled.set(path, (entry = made));
    }
    entry.listeners.add(listener as Function);
    return entry.watcher;
  };
  const unwatchFile = (p: unknown, listener?: Function) => {
    const path = pathOf(p);
    const entry = polled.get(path);
    if (!entry) return;
    if (listener) entry.listeners.delete(listener);
    else entry.listeners.clear();
    if (entry.listeners.size) return;
    entry.watcher.close();
    polled.delete(path);
  };
  // fs.promises.watch: the events as an async iterator.
  promises.watch = (p: unknown, options: { signal?: AbortSignal } = {}) => {
    const queue: { eventType: string; filename: string }[] = [];
    let wake: (() => void) | null = null;
    const watcher = watch(p, options, (eventType, filename) => {
      queue.push({ eventType, filename });
      wake?.();
    });
    let closed = false;
    watcher.on('close', () => {
      closed = true;
      wake?.();
    });
    return {
      async next(): Promise<IteratorResult<{ eventType: string; filename: string }>> {
        for (;;) {
          if (queue.length || closed) break;
          await new Promise<void>((r) => (wake = r));
        }
        wake = null;
        return queue.length
          ? { value: queue.shift()!, done: false }
          : { value: undefined, done: true };
      },
      async return() {
        watcher.close();
        return { value: undefined, done: true as const };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  const changed = (paths: string[]) => {
    for (const entry of [...watches])
      for (const path of paths) {
        if (path === entry.path) {
          entry.tell(kind(path) ? 'change' : 'rename', basename(path));
          continue;
        }
        const inside = entry.dir && path.startsWith(`${entry.path === '/' ? '' : entry.path}/`);
        if (!inside) continue;
        const name = path.slice(entry.path.length + (entry.path === '/' ? 0 : 1));
        if (name.includes('/') && !entry.recursive) continue;
        const there = kind(path) !== null;
        const top = name.split('/')[0];
        const event = there && entry.known.has(top) ? 'change' : 'rename';
        if (there) entry.known.add(top);
        else if (!name.includes('/')) entry.known.delete(top);
        entry.tell(event, name);
      }
  };

  return {
    module: {
      ...sync,
      ...callbacks,
      promises,
      Stats,
      Dirent,
      constants: {
        F_OK: 0,
        R_OK: 4,
        W_OK: 2,
        X_OK: 1,
        O_RDONLY: O.RDONLY,
        O_WRONLY: O.WRONLY,
        O_RDWR: O.RDWR,
        O_CREAT: O.CREAT,
        O_EXCL: O.EXCL,
        O_TRUNC: O.TRUNC,
        O_APPEND: O.APPEND,
        O_DIRECTORY: O.DIRECTORY,
        O_NOFOLLOW: O.NOFOLLOW,
        S_IFMT: 0o170000,
        S_IFREG: 0o100000,
        S_IFDIR: 0o40000,
        S_IFLNK: 0o120000,
        COPYFILE_EXCL: 1,
      },
      F_OK: 0,
      R_OK: 4,
      W_OK: 2,
      X_OK: 1,
      watch,
      watchFile,
      unwatchFile,
      FSWatcher,
      ReadStream,
      WriteStream,
      createReadStream: (p: unknown, options?: unknown) =>
        new (ReadStream as unknown as Made)(p, options),
      createWriteStream: (p: unknown, options?: unknown) =>
        new (WriteStream as unknown as Made)(p, options),
    } as Record<string, unknown>,
    promises,
    cwd,
    // A path as /proc/self/fd/N names it: the open file's (child.ts: a
    // child's program, arguments and directory, as a child that inherits
    // the fd sees them).
    throughFd,
    // Another fd on `fd`'s file, from its position: a child's output (its
    // own, as an inherited fd is, which the parent may close at once).
    dup(fd: number): number {
      const file = opened(fd, 'dup');
      const copy = openFd(file.path, file.append ? 'a' : 'r+');
      files.get(copy)!.position = file.position;
      return copy;
    },
    setStdio(write: (fd: number, bytes: Uint8Array) => void) {
      stdio = write;
    },
    setLater(fn: (fn: () => void) => void) {
      later = fn;
    },
    setHold(fn: () => () => void) {
      hold = fn;
    },
    // What changed in the files (files.js's report): for the watchers.
    changed,
  };
}

function decode(bytes: Uint8Array, encoding: Encoding): string | Buffer {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return encoding ? buffer.toString(encoding) : buffer;
}

interface Watch {
  path: string;
  dir: boolean;
  recursive: boolean;
  release: (() => void) | null;
  // A directory's names, so a new one is 'rename' and a changed one
  // 'change'.
  known: Set<string>;
  tell(event: string, name: string): void;
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
