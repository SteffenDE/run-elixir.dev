// The shared directories (/work, /tmp: files.ts) for the Emscripten BEAM:
// the `node:fs`-like object PROXYFS mounts, as treefs.ts is for the
// node's own tree, over files.js's synchronous channel (wasi/shared.ts).
// files.js answers WASI errno numbers; its handles are this object's
// descriptors. It keeps no access times, so utime has no effect.
import { OFLAGS } from '../wasi/abi';
import type { SharedAnswer, SharedCall } from '../wasi/shared';
import { errnoName, type Stat } from './treefs';

const CHUNK = 512 * 1024;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

class FsError extends Error {
  declare code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export class SharedFs {
  declare call: SharedCall;

  constructor(call: SharedCall) {
    this.call = call;
  }
  private ask(request: Record<string, unknown>, bytes?: Uint8Array): SharedAnswer {
    const { answer } = this.call(request, bytes);
    if (answer.error) throw new FsError(errnoName(answer.error));
    return answer;
  }

  lstat(path: string): Stat {
    const { type, size, ino, mtime } = this.ask({ op: 'stat', path, follow: false });
    const mode =
      type === 'dir' ? S_IFDIR | 0o755 : type === 'link' ? S_IFLNK | 0o777 : S_IFREG | 0o755;
    const time = new Date(Number(BigInt(mtime) / 1000000n));
    return {
      dev: 2,
      ino,
      mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size: type === 'dir' ? 4096 : size,
      atime: time,
      mtime: time,
      ctime: time,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
    };
  }
  chmod(): void {}
  utime(): void {}
  truncate(path: string, size: number): void {
    const { handle } = this.ask({ op: 'open', path });
    try {
      this.ask({ op: 'truncate', handle, size });
    } finally {
      this.ask({ op: 'close', handle });
    }
  }
  mkdir(path: string): void {
    this.ask({ op: 'mkdir', path });
  }
  writeFile(path: string): void {
    const { handle } = this.ask({ op: 'open', path, oflags: OFLAGS.CREAT | OFLAGS.EXCL });
    this.ask({ op: 'close', handle });
  }
  rename(from: string, to: string): void {
    this.ask({ op: 'rename', path: from, to });
  }
  unlink(path: string): void {
    this.ask({ op: 'unlink', path });
  }
  rmdir(path: string): void {
    this.ask({ op: 'rmdir', path });
  }
  readdir(path: string): string[] {
    const { handle } = this.ask({ op: 'open', path, oflags: OFLAGS.DIRECTORY });
    try {
      const { entries = [] } = this.ask({ op: 'readdir', handle });
      return ['.', '..', ...entries.map(([name]: [string]) => name)];
    } finally {
      this.ask({ op: 'close', handle });
    }
  }
  symlink(target: string, path: string): void {
    this.ask({ op: 'symlink', path, target });
  }
  readlink(path: string): string {
    return this.ask({ op: 'readlink', path }).target;
  }
  link(from: string, to: string): void {
    this.ask({ op: 'link', path: from, to, follow: false });
  }

  open(path: string): number {
    return this.ask({ op: 'open', path }).handle;
  }
  close(fd: number): void {
    this.ask({ op: 'close', handle: fd });
  }
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    let done = 0;
    while (done < length) {
      const want = Math.min(length - done, CHUNK);
      const { answer, bytes } = this.call({
        op: 'read',
        handle: fd,
        offset: position + done,
        length: want,
      });
      if (answer.error) throw new FsError(errnoName(answer.error));
      buffer.set(bytes, offset + done);
      done += bytes.length;
      if (bytes.length < want) break;
    }
    return done;
  }
  write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    for (let at = 0; at < length; at += CHUNK) {
      const part = buffer.slice(offset + at, offset + Math.min(length, at + CHUNK));
      this.ask({ op: 'write', handle: fd, offset: position + at }, part);
    }
    return length;
  }
}
