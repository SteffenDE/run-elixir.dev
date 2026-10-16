// The node's tree (wasi/fs.ts) for the Emscripten BEAM: the `node:fs`-like
// object Emscripten's PROXYFS mounts (playground/beam, -lproxyfs.js), so
// the C library's file calls reach the same Dir/File/Symlink tree, lazily
// fetched files and all, that Rust-OTP's WASI shim serves.
//
// PROXYFS calls these on the module's main thread (the worker that loaded
// it: with PROXY_TO_PTHREAD every thread's file calls are proxied there)
// with paths from the mount's root, and reads an error's `code` as an
// errno name.
import { Device, Dir, File, Symlink, load, lookup, now, type Fetch, type FsNode } from '../wasi/fs';
import { E } from '../wasi/abi';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000;

// WASI's errno numbers (abi.ts) by their POSIX names.
const NAMES = new Map<number, string>(Object.entries(E).map(([name, n]) => [n, `E${name}`]));

class FsError extends Error {
  declare code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new FsError(code);
};
const failWith = (errno: number): never => fail(NAMES.get(errno) ?? 'EIO');

export interface Stat {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  blksize: number;
  blocks: number;
}

// An open file: the node, and whether writes go to its end.
interface Open {
  node: File | Dir | Device;
  append: boolean;
}

const O_CREAT = 0o100;
const O_APPEND = 0o2000;

export class TreeFs {
  declare root: Dir;
  declare fetch: Fetch;
  declare opened: Map<number, Open>;
  declare next: number;

  constructor(root: Dir, fetch: Fetch) {
    this.root = root;
    this.fetch = fetch;
    this.opened = new Map();
    this.next = 1;
  }

  // The node at `path`, its last symbolic link not followed.
  private at(path: string): { node: FsNode; parent?: Dir; name?: string } {
    const found = lookup(this.root, this.root, path, false);
    if (!found.node) return failWith(found.error);
    return found;
  }
  // Where `path` would go: its directory and name, which must be free.
  private free(path: string): { parent: Dir; name: string } {
    const found = lookup(this.root, this.root, path, false);
    if (found.node) return fail('EEXIST');
    if (found.error !== E.NOENT || !found.parent) return failWith(found.error);
    return { parent: found.parent, name: found.name! };
  }

  lstat(path: string): Stat {
    const { node } = this.at(path);
    const mode =
      node instanceof Dir
        ? S_IFDIR | 0o755
        : node instanceof Symlink
          ? S_IFLNK | 0o777
          : node instanceof Device
            ? S_IFCHR | 0o666
            : S_IFREG | 0o644;
    const size = node instanceof Dir ? 4096 : node.size;
    const time = new Date(Number(node.mtime / 1000000n));
    return {
      dev: 1,
      ino: Number(node.ino),
      mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size,
      atime: time,
      mtime: time,
      ctime: time,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
    };
  }
  chmod(): void {}
  utime(path: string, _atime: Date, mtime: Date): void {
    this.at(path).node.mtime = BigInt(mtime.getTime()) * 1000000n;
  }
  truncate(path: string, size: number): void {
    const { node } = this.at(path);
    if (!(node instanceof File)) return fail('EISDIR');
    // Emptied, a lazily fetched file need not be fetched.
    if (size === 0) node.source = null;
    else load(node, this.fetch);
    node.truncate(size);
    node.written = true;
  }
  mkdir(path: string): void {
    const { parent, name } = this.free(path);
    const dir = new Dir();
    dir.parent = parent;
    parent.entries.set(name, dir);
    parent.mtime = now();
  }
  writeFile(path: string): void {
    const { parent, name } = this.free(path);
    const file = new File();
    file.written = true;
    parent.entries.set(name, file);
    parent.mtime = now();
  }
  rename(from: string, to: string): void {
    const source = this.at(from);
    const target = lookup(this.root, this.root, to, false);
    if (!target.parent || (target.error && target.error !== E.NOENT))
      failWith(target.error ?? E.NOENT);
    if (target.node instanceof Dir) {
      if (!(source.node instanceof Dir)) fail('EISDIR');
      if (target.node.entries.size) fail('ENOTEMPTY');
    } else if (target.node && source.node instanceof Dir) fail('ENOTDIR');
    source.parent!.entries.delete(source.name!);
    target.parent!.entries.set(target.name!, source.node);
    if (source.node instanceof Dir) source.node.parent = target.parent;
    source.parent!.mtime = target.parent!.mtime = now();
  }
  unlink(path: string): void {
    const { node, parent, name } = this.at(path);
    if (node instanceof Dir) fail('EISDIR');
    parent!.entries.delete(name!);
    parent!.mtime = now();
  }
  rmdir(path: string): void {
    const { node, parent, name } = this.at(path);
    if (!(node instanceof Dir)) return fail('ENOTDIR');
    if (node.entries.size) fail('ENOTEMPTY');
    parent!.entries.delete(name!);
    parent!.mtime = now();
  }
  readdir(path: string): string[] {
    const found = lookup(this.root, this.root, path, true);
    if (!found.node) return failWith(found.error);
    if (!(found.node instanceof Dir)) return fail('ENOTDIR');
    return ['.', '..', ...found.node.entries.keys()];
  }
  symlink(target: string, path: string): void {
    const { parent, name } = this.free(path);
    parent.entries.set(name, new Symlink(target));
    parent.mtime = now();
  }
  readlink(path: string): string {
    const { node } = this.at(path);
    if (!(node instanceof Symlink)) return fail('EINVAL');
    return node.target;
  }

  // Emscripten's FS.open has made the file (mknod) and truncated it
  // (setattr) by now, as O_CREAT, O_EXCL and O_TRUNC ask.
  open(path: string, flags: number): number {
    const found = lookup(this.root, this.root, path, true);
    if (!found.node) {
      if (!(flags & O_CREAT)) return failWith(found.error);
      this.writeFile(path);
      return this.open(path, flags & ~O_CREAT);
    }
    const node = found.node;
    if (node instanceof Symlink) return fail('ELOOP');
    if (node instanceof File) load(node, this.fetch);
    const fd = this.next++;
    this.opened.set(fd, { node, append: !!(flags & O_APPEND) });
    return fd;
  }
  close(fd: number): void {
    this.opened.delete(fd);
  }
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const { node } = this.opened.get(fd) ?? fail('EBADF');
    if (node instanceof Dir) return fail('EISDIR');
    if (node instanceof Device) {
      const bytes = node.read(length);
      buffer.set(bytes, offset);
      return bytes.length;
    }
    const part = node.bytes.subarray(position, position + length);
    buffer.set(part, offset);
    return part.length;
  }
  write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const open = this.opened.get(fd) ?? fail('EBADF');
    const node = open.node;
    if (!(node instanceof File)) return fail('EISDIR');
    load(node, this.fetch);
    const at = open.append ? node.size : position;
    node.reserve(at + length);
    if (at > node.size) node.data.fill(0, node.size, at);
    node.data.set(buffer.subarray(offset, offset + length), at);
    node.size = Math.max(node.size, at + length);
    node.mtime = now();
    node.written = true;
    return length;
  }
}
