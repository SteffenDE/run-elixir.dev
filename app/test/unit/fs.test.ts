import { describe, expect, test } from 'vitest';
import { createFs } from '../../src/runtime/nodejs/fs';
import { createUtil } from '../../src/runtime/nodejs/util';
import { E } from '../../src/runtime/wasi/abi';

const util = createUtil(() => {});

// files.js's answers, in memory: directories and files by path.
function files() {
  const nodes = new Map<string, { dir: boolean; data: Uint8Array }>([
    ['/', { dir: true, data: new Uint8Array() }],
    ['/work', { dir: true, data: new Uint8Array() }],
  ]);
  const handles = new Map<number, string>();
  let next = 1;
  const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
  const status = (path: string) => {
    const node = nodes.get(path)!;
    return { type: node.dir ? 'dir' : 'file', size: node.data.length, ino: 1, mtime: '0' };
  };
  const answer = (request: Record<string, unknown>, bytes?: Uint8Array) => {
    const path = request.path as string;
    const handle = request.handle as number;
    const node = nodes.get(path ?? handles.get(handle));
    switch (request.op) {
      case 'stat':
        return node ? status(path) : { error: E.NOENT };
      case 'open': {
        const oflags = request.oflags as number;
        if (node && oflags & 1 && oflags & 4) return { error: E.EXIST };
        if (!node) {
          if (!(oflags & 1)) return { error: E.NOENT };
          if (!nodes.get(parent(path))?.dir) return { error: E.NOENT };
          nodes.set(path, { dir: false, data: new Uint8Array() });
        }
        if (oflags & 8) nodes.get(path)!.data = new Uint8Array();
        handles.set(next, path);
        return { handle: next++, ...status(path) };
      }
      case 'read': {
        const offset = request.offset as number;
        return { answer: {}, bytes: node!.data.slice(offset, offset + (request.length as number)) };
      }
      case 'write': {
        const at = request.append ? node!.data.length : (request.offset as number);
        const end = at + bytes!.length;
        const data = new Uint8Array(Math.max(end, node!.data.length));
        data.set(node!.data);
        data.set(bytes!, at);
        node!.data = data;
        return { position: end };
      }
      case 'fstat':
        return status(handles.get(handle)!);
      case 'close':
        handles.delete(handle);
        return {};
      case 'mkdir':
        if (node) return { error: E.EXIST };
        nodes.set(path, { dir: true, data: new Uint8Array() });
        return {};
    }
    return { error: E.INVAL };
  };
  return (request: Record<string, unknown>, bytes?: Uint8Array) => {
    const result = answer(request, bytes) as Record<string, unknown>;
    const out = (result.bytes as Uint8Array) ?? new Uint8Array();
    delete result.bytes;
    return { answer: (result.answer ?? result) as never, bytes: out };
  };
}

// A process's fs over files of its own, in /work.
function makeFs() {
  const resolve = (p: string) => (p.startsWith('/') ? p : `/work/${p}`);
  const made = createFs(files(), () => '/work', resolve);
  made.setLater((fn) => setTimeout(fn, 0));
  return made.module as Record<string, (...args: never[]) => unknown>;
}

// What `f` throws: its code and message.
function thrown(f: () => unknown) {
  try {
    f();
  } catch (error) {
    return `${(error as { code: string }).code} ${(error as Error).message}`;
  }
  return 'nothing';
}

describe('as Node', () => {
  test('copyFileSync with COPYFILE_EXCL refuses a file there', () => {
    const fs = makeFs();
    fs.writeFileSync('f' as never, 'hello' as never);
    fs.writeFileSync('g' as never, 'x' as never);
    expect(thrown(() => fs.copyFileSync('f' as never, 'g' as never, 1 as never))).toBe(
      "EEXIST EEXIST: file already exists, copyfile 'f' -> 'g'",
    );
    expect(fs.readFileSync('g' as never, 'utf8' as never)).toBe('x');
    fs.copyFileSync('f' as never, 'h' as never, 1 as never);
    expect(fs.readFileSync('h' as never, 'utf8' as never)).toBe('hello');
  });

  test('mkdirSync recursive: a file there is EEXIST, a file on the way ENOTDIR', () => {
    const fs = makeFs();
    fs.writeFileSync('f' as never, 'hello' as never);
    const recursive = { recursive: true } as never;
    expect(thrown(() => fs.mkdirSync('f' as never, recursive))).toBe(
      "EEXIST EEXIST: file already exists, mkdir 'f'",
    );
    expect(thrown(() => fs.mkdirSync('f/sub' as never, recursive))).toBe(
      "ENOTDIR ENOTDIR: not a directory, mkdir 'f/sub'",
    );
  });

  test('a position of -1 is the current one', () => {
    const fs = makeFs();
    fs.writeFileSync('f' as never, 'hello world' as never);
    const fd = fs.openSync('f' as never, 'r+' as never) as number;
    const buffer = Buffer.alloc(5);
    const read = () =>
      fs.readSync(fd as never, buffer as never, 0 as never, 5 as never, -1 as never);
    expect([read(), buffer.toString(), read(), buffer.toString()]).toEqual([
      5,
      'hello',
      5,
      ' worl',
    ]);
    fs.writeSync(fd as never, 'D' as never, -1 as never);
    expect(fs.readFileSync('f' as never, 'utf8' as never)).toBe('hello worlD');
  });
});

test("readFileSync(fd) reads from the file's position on, and moves it", () => {
  const fs = makeFs();
  fs.writeFileSync('f' as never, 'hello world' as never);
  const fd = fs.openSync('f' as never, 'r' as never) as number;
  fs.readSync(fd as never, Buffer.alloc(6) as never, 0 as never, 6 as never, null as never);
  expect(fs.readFileSync(fd as never, 'utf8' as never)).toBe('world');
  expect(fs.readFileSync(fd as never, 'utf8' as never)).toBe('');
});

describe('promisify', () => {
  test('exists resolves whether the file is there', async () => {
    const fs = makeFs();
    fs.writeFileSync('/work/a' as never, 'x' as never);
    const exists = util.promisify(fs.exists as never) as (p: string) => Promise<unknown>;
    expect(await exists('/work/a')).toBe(true);
    expect(await exists('/work/b')).toBe(false);
  });

  test('read and write resolve how much and the buffer', async () => {
    const fs = makeFs();
    const fd = fs.openSync('/work/a' as never, 'w+' as never) as number;
    const write = util.promisify(fs.write as never) as (...a: unknown[]) => Promise<unknown>;
    const data = Buffer.from('hello');
    expect(await write(fd, data, 0, 5, 0)).toEqual({ bytesWritten: 5, buffer: data });
    const read = util.promisify(fs.read as never) as (...a: unknown[]) => Promise<unknown>;
    const into = Buffer.alloc(5);
    expect(await read(fd, into, 0, 5, 0)).toEqual({ bytesRead: 5, buffer: into });
    expect(into.toString()).toBe('hello');
  });
});

describe('streams', () => {
  const nodeFs = () => makeFs() as unknown as typeof import('node:fs');
  // A stream's events in order, and what it read.
  const events = (stream: NodeJS.EventEmitter) =>
    new Promise<string[]>((resolve) => {
      const seen: string[] = [];
      for (const event of ['open', 'ready', 'data', 'end', 'finish', 'error', 'close'])
        stream.on(event, (value?: unknown) => {
          seen.push(
            event === 'data'
              ? `data ${value}`
              : event === 'error'
                ? `error ${(value as { code: string }).code}`
                : event === 'open'
                  ? `open ${typeof value}`
                  : event,
          );
          if (event === 'close') resolve(seen);
        });
    });

  test('a read stream from start to end, as Node', async () => {
    const fs = nodeFs();
    fs.writeFileSync('f', 'hello world');
    const stream = fs.createReadStream('f', {
      start: 1,
      end: 7,
      encoding: 'utf8',
      highWaterMark: 4,
    });
    expect(stream.path).toBe('f');
    expect(stream.pending).toBe(true);
    expect(await events(stream)).toEqual([
      'open number',
      'ready',
      'data ello',
      'data  wo',
      'end',
      'close',
    ]);
    expect(stream.bytesRead).toBe(7);
  });

  test("a missing file's read stream errs, then closes", async () => {
    const fs = nodeFs();
    expect(await events(fs.createReadStream('missing'))).toEqual(['error ENOENT', 'close']);
  });

  test('a write stream, as Node', async () => {
    const fs = nodeFs();
    const stream = fs.createWriteStream('g');
    stream.write('abc');
    stream.end('def');
    expect(await events(stream)).toEqual(['open number', 'ready', 'finish', 'close']);
    expect(stream.bytesWritten).toBe(6);
    expect(fs.readFileSync('g', 'utf8')).toBe('abcdef');
    const appended = fs.createWriteStream('g', { flags: 'a' });
    appended.end('!');
    await events(appended);
    expect(fs.readFileSync('g', 'utf8')).toBe('abcdef!');
  });

  test('piped from one file to another', async () => {
    const fs = nodeFs();
    const text = 'x'.repeat(200_000);
    fs.writeFileSync('f', text);
    const out = fs.createWriteStream('g');
    fs.createReadStream('f').pipe(out);
    await events(out);
    expect(fs.readFileSync('g', 'utf8')).toBe(text);
  });

  test("a FileHandle's, which it closes", async () => {
    const fs = nodeFs();
    fs.writeFileSync('f', 'hello');
    const handle = await fs.promises.open('f', 'r');
    const stream = handle.createReadStream({ encoding: 'utf8' });
    expect(await events(stream)).toEqual(['data hello', 'end', 'close']);
    expect(() => fs.fstatSync(handle.fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });

  test("graceful-fs's: ReadStream applied to its own, whose open() opens", async () => {
    const fs = nodeFs();
    fs.writeFileSync('f', 'hello');
    // As graceful-fs makes its ReadStream.
    function Legacy(this: object, ...args: unknown[]) {
      return ((fs.ReadStream as unknown as Function).apply(this, args), this);
    }
    Legacy.prototype = Object.create(fs.ReadStream.prototype);
    Legacy.prototype.open = function (this: import('node:fs').ReadStream) {
      fs.open(this.path, 'r', (error, fd) => {
        if (error) return this.emit('error', error);
        (this as unknown as { fd: number }).fd = fd;
        this.emit('open', fd);
      });
    };
    type Made = new (p: string, o: object) => import('node:fs').ReadStream;
    const stream = new (Legacy as unknown as Made)('f', { encoding: 'utf8' });
    expect(await events(stream)).toEqual(['open number', 'data hello', 'end', 'close']);
    expect((fs.ReadStream as unknown as (p: string) => object)('f')).toBeInstanceOf(fs.ReadStream);
  });
});
