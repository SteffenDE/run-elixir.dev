// Node's process in the worker: its arguments, environment and directory,
// stdout and stderr (to the page), stdin (the terminal's typing or a
// pipe's bytes, `input`), and its end. The worker ends the process when nothing keeps it alive, as Node's
// event loop does: timers, intervals, immediates and the operations it
// holds (`hold`) are its handles; promises are not.
import { Buffer } from './buffer';
import { EventEmitter } from 'events';
import * as streams from 'readable-stream';
import { formatWithOptions, inspect } from './util';

export const VERSION = 'v24.11.0';

export interface Io {
  // Bytes on fd 1 or 2.
  write(fd: number, bytes: Uint8Array): void;
  // The process ends (the page stops the worker).
  exit(code: number): never;
}

export function createProcess(options: {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  io: Io;
  tty: boolean;
  columns: number;
  rows?: number;
  // Whether stdin is the terminal, and how it asks for raw input.
  stdinTty?: boolean;
  raw?: (on: boolean) => void;
  // A worker thread's uncaught error: its parent's 'error' (Node prints
  // nothing in the thread).
  report?: (error: unknown) => void;
}) {
  const { io } = options;
  let cwd = options.cwd;
  let active = 0;
  let exiting = false;
  let checking = false;
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const nativeSetInterval = globalThis.setInterval.bind(globalThis);
  const nativeClearInterval = globalThis.clearInterval.bind(globalThis);

  const process = new EventEmitter() as EventEmitter & Record<string, unknown>;

  // Whether the loop has run dry: then beforeExit, and the end. Dry for
  // some turns in a row, not one: what the browser does for a script holds
  // nothing here (its streams pass buffered bytes on over a few tasks, as
  // a response's body read through a TextDecoderStream), where Node's
  // native work would hold its loop until done.
  const DRY_TURNS = 8;
  let dry = 0;
  const turn = () => {
    if (active > 0 || exiting) {
      checking = false;
      dry = 0;
      return;
    }
    if (++dry < DRY_TURNS) return void nativeSetTimeout(turn, 0);
    checking = false;
    dry = 0;
    process.emit('beforeExit', process.exitCode ?? 0);
    if (active > 0) return;
    end(Number(process.exitCode ?? 0));
  };
  const check = () => {
    if (checking || exiting) return;
    checking = true;
    nativeSetTimeout(turn, 0);
  };
  const hold = () => {
    active++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      active--;
      check();
    };
  };

  const end = (code: number): never => {
    if (!exiting) {
      exiting = true;
      try {
        process.emit('exit', code);
      } catch (error) {
        io.write(2, encode(`${inspect(error)}\n`));
      }
    }
    return io.exit(code);
  };

  // Node's Timeout: ref and unref decide whether it keeps the loop alive.
  class Timeout {
    private release: (() => void) | null;
    constructor(
      public id: ReturnType<typeof nativeSetTimeout>,
      private repeat: boolean,
      private restart: () => ReturnType<typeof nativeSetTimeout>,
    ) {
      this.release = hold();
    }
    ref() {
      this.release ??= hold();
      return this;
    }
    unref() {
      this.release?.();
      this.release = null;
      return this;
    }
    hasRef() {
      return this.release !== null;
    }
    refresh() {
      (this.repeat ? nativeClearInterval : nativeClearTimeout)(this.id);
      this.id = this.restart();
      return this;
    }
    close() {
      (this.repeat ? nativeClearInterval : nativeClearTimeout)(this.id);
      this.unref();
      return this;
    }
    done() {
      if (!this.repeat) this.unref();
    }
    [Symbol.toPrimitive]() {
      return Number(this.id);
    }
  }
  const timers = new Map<number, Timeout>();
  const guard = (fn: () => void) => () => {
    try {
      fn();
    } catch (error) {
      fail(error);
    }
  };
  const setTimeout = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => {
    const start = () =>
      nativeSetTimeout(
        guard(() => {
          timers.delete(Number(timer.id));
          timer.done();
          fn(...args);
        }),
        ms,
      );
    const timer: Timeout = new Timeout(start(), false, start);
    timers.set(Number(timer.id), timer);
    return timer;
  };
  const setInterval = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => {
    const start = () =>
      nativeSetInterval(
        guard(() => fn(...args)),
        ms,
      );
    const timer: Timeout = new Timeout(start(), true, start);
    timers.set(Number(timer.id), timer);
    return timer;
  };
  const clear = (timer: unknown) => {
    const found = timer instanceof Timeout ? timer : timers.get(Number(timer));
    if (!found) return;
    timers.delete(Number(found.id));
    found.close();
  };
  const setImmediate = (fn: (...a: unknown[]) => void, ...args: unknown[]) =>
    setTimeout(fn, 0, ...args);

  const encode = (text: string) => new TextEncoder().encode(text);

  // stdout and stderr: what they write goes to the page at once.
  let size = [options.columns, options.rows ?? 24];
  const stream = (fd: number) => {
    const out = new EventEmitter() as EventEmitter & Record<string, unknown>;
    Object.assign(out, {
      fd,
      isTTY: options.tty,
      columns: options.columns,
      rows: options.rows ?? 24,
      writable: true,
      _isStdio: true,
      write(chunk: string | Uint8Array, encoding?: unknown, callback?: () => void) {
        if (typeof encoding === 'function') callback = encoding as () => void;
        const bytes =
          typeof chunk === 'string'
            ? Buffer.from(
                chunk,
                typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8',
              )
            : chunk;
        io.write(fd, bytes);
        if (callback) queueMicrotask(callback);
        return true;
      },
      end(chunk?: string | Uint8Array, encoding?: unknown, callback?: () => void) {
        if (chunk) (out.write as (c: unknown, e: unknown) => void)(chunk, encoding);
        if (typeof callback === 'function') queueMicrotask(callback);
      },
      cork() {},
      uncork() {},
      setDefaultEncoding: () => out,
      getColorDepth: () => (options.tty ? 8 : 1),
      hasColors: (count = 16) => options.tty && count <= 256,
      getWindowSize: () => [...size],
      // ANSI's, as a TTY WriteStream's.
      cursorTo(x: number, y?: number | (() => void), callback?: () => void) {
        if (typeof y === 'function') [callback, y] = [y, undefined];
        io.write(fd, encode(y === undefined ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`));
        if (callback) queueMicrotask(callback);
        return true;
      },
      moveCursor(dx: number, dy: number, callback?: () => void) {
        let text = '';
        if (dx) text += dx < 0 ? `\x1b[${-dx}D` : `\x1b[${dx}C`;
        if (dy) text += dy < 0 ? `\x1b[${-dy}A` : `\x1b[${dy}B`;
        if (text) io.write(fd, encode(text));
        if (callback) queueMicrotask(callback);
        return true;
      },
      clearLine(dir = 0, callback?: () => void) {
        io.write(fd, encode(dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K'));
        if (callback) queueMicrotask(callback);
        return true;
      },
      clearScreenDown(callback?: () => void) {
        io.write(fd, encode('\x1b[0J'));
        if (callback) queueMicrotask(callback);
        return true;
      },
      _writableState: { needDrain: false, length: 0 },
      writableLength: 0,
      writableHighWaterMark: 16384,
      writableNeedDrain: false,
      destroyed: false,
      destroy: () => out,
    });
    return out;
  };
  const stdout = stream(1);
  const stderr = stream(2);

  // stdin: what is typed at the terminal (or a pipe's bytes, `input`), and
  // its end (Ctrl+D, the pipe's). It holds the loop while something reads
  // it (flowing, or a 'readable' listener), unless unref'd, as Node's does:
  // a process that never reads it ends as before.
  const { Readable } = streams as typeof import('node:stream');
  const stdin = new Readable({ read() {} }) as InstanceType<typeof Readable> &
    Record<string, unknown>;
  let reading: (() => void) | null = null;
  let referenced = true;
  const update = () => {
    const wanted =
      referenced &&
      !stdin.readableEnded &&
      !stdin.destroyed &&
      (stdin.readableFlowing === true || stdin.listenerCount('readable') > 0);
    if (wanted) reading ??= hold();
    else {
      reading?.();
      reading = null;
    }
  };
  const later = () => queueMicrotask(update);
  for (const event of ['resume', 'pause', 'end', 'close']) stdin.on(event, later);
  stdin.on('newListener', later);
  stdin.on('removeListener', later);
  Object.assign(stdin, {
    fd: 0,
    isTTY: options.stdinTty ?? false,
    isRaw: false,
    // Keys as typed, Ctrl+C one of them, or lines again.
    setRawMode(on: boolean) {
      if (!stdin.isTTY) return stdin;
      stdin.isRaw = Boolean(on);
      options.raw?.(Boolean(on));
      return stdin;
    },
    ref() {
      referenced = true;
      update();
      return stdin;
    },
    unref() {
      referenced = false;
      update();
      return stdin;
    },
  });
  // What the process reads (null: its end).
  const input = (bytes: Uint8Array | null) => {
    if (bytes === null) stdin.push(null);
    else stdin.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  };
  // The terminal's size changed: stdout's and stderr's, and SIGWINCH.
  const resized = (columns: number, rows: number) => {
    size = [columns, rows];
    for (const out of [stdout, stderr]) {
      out.columns = columns;
      out.rows = rows;
      out.emit('resize');
    }
    process.emit('SIGWINCH');
  };

  const fail = (error: unknown) => {
    if (process.listenerCount('uncaughtException')) {
      process.emit('uncaughtException', error, 'uncaughtException');
      return;
    }
    if (options.report) {
      options.report(error);
      end(1);
    }
    const text = error instanceof Error ? inspect(error) : `Uncaught ${inspect(error)}`;
    io.write(2, encode(`${text}\n\nNode.js ${VERSION}\n`));
    end(1);
  };

  const start = performance.now();
  const hrtime = (previous?: [number, number]): [number, number] => {
    const now = performance.now() + performance.timeOrigin;
    let seconds = Math.floor(now / 1000);
    let nanos = Math.floor((now % 1000) * 1e6);
    if (previous) {
      seconds -= previous[0];
      nanos -= previous[1];
      if (nanos < 0) {
        seconds--;
        nanos += 1e9;
      }
    }
    return [seconds, nanos];
  };
  hrtime.bigint = () => BigInt(Math.floor((performance.now() + performance.timeOrigin) * 1e6));

  Object.assign(process, {
    title: 'node',
    version: VERSION,
    versions: { node: VERSION.slice(1), v8: '13.6.233.10-node.30', uv: '1.51.0', modules: '137' },
    release: { name: 'node', lts: 'Krypton' },
    arch: 'x64',
    platform: 'linux',
    argv: options.argv,
    argv0: 'node',
    execArgv: [],
    execPath: '/usr/bin/node',
    env: options.env,
    pid: 42,
    ppid: 1,
    exitCode: undefined,
    features: { inspector: false, typescript: 'strip' },
    config: { variables: {} },
    stdout,
    stderr,
    stdin,
    cwd: () => cwd,
    chdir(dir: string) {
      cwd = dir;
    },
    exit: (code?: number) => end(Number(code ?? process.exitCode ?? 0)),
    reallyExit: (code?: number) => io.exit(Number(code ?? 0)),
    abort: () => end(134),
    kill: () => true,
    nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) =>
      queueMicrotask(() => fn(...args)),
    hrtime,
    uptime: () => (performance.now() - start) / 1000,
    memoryUsage: Object.assign(
      () => ({ rss: 50e6, heapTotal: 30e6, heapUsed: 20e6, external: 1e6, arrayBuffers: 1e6 }),
      { rss: () => 50e6 },
    ),
    cpuUsage: () => ({ user: Math.round((performance.now() - start) * 1000), system: 0 }),
    resourceUsage: () => ({}),
    umask: () => 0o22,
    getuid: () => 1000,
    getgid: () => 1000,
    geteuid: () => 1000,
    getegid: () => 1000,
    getgroups: () => [1000],
    emitWarning(warning: string | Error, type?: string | { type?: string }) {
      const name = typeof type === 'string' ? type : (type?.type ?? 'Warning');
      const text =
        warning instanceof Error ? `${warning.name}: ${warning.message}` : `${name}: ${warning}`;
      io.write(2, encode(`(node:42) ${text}\n`));
    },
    binding: () => {
      throw new Error('process.binding is not supported');
    },
    report: { getReport: () => ({ header: { glibcVersionRuntime: '2.39' } }) },
    allowedNodeEnvironmentFlags: new Set(),
    setUncaughtExceptionCaptureCallback: () => {},
    hasUncaughtExceptionCaptureCallback: () => false,
    setSourceMapsEnabled: () => {},
    sourceMapsEnabled: false,
    loadEnvFile: () => {},
    constrainedMemory: () => 0,
    availableMemory: () => 2 ** 31,
  });

  const console = createConsole(
    stdout as unknown as Writable,
    stderr as unknown as Writable,
    options.tty,
  );

  return {
    process,
    console,
    timers: {
      setTimeout,
      setInterval,
      setImmediate,
      clearTimeout: clear,
      clearInterval: clear,
      clearImmediate: clear,
    },
    hold,
    check,
    fail,
    end,
    input,
    resized,
  };
}

type Writable = { write(chunk: string): unknown };

// Node's console over stdout and stderr.
export function createConsole(stdout: Writable, stderr: Writable, colors: boolean) {
  let indent = '';
  const counts = new Map<string, number>();
  const times = new Map<string, number>();
  const print =
    (stream: Writable) =>
    (...args: unknown[]) => {
      const text = formatWithOptions({ colors }, ...args);
      stream.write(`${indent ? text.replace(/^/gm, indent) : text}\n`);
    };
  const log = print(stdout);
  const error = print(stderr);
  return {
    log,
    info: log,
    debug: log,
    error,
    warn: error,
    trace: (...args: unknown[]) =>
      error(
        `Trace: ${formatWithOptions({}, ...args)}\n${new Error().stack?.split('\n').slice(2).join('\n') ?? ''}`,
      ),
    dir: (value: unknown, opts?: { depth?: number }) =>
      stdout.write(`${inspect(value, { colors, ...opts })}\n`),
    dirxml: log,
    table: log,
    assert: (ok: unknown, ...args: unknown[]) => {
      if (!ok) error('Assertion failed', ...(args.length ? [':', ...args] : []));
    },
    count: (label = 'default') => {
      const n = (counts.get(label) ?? 0) + 1;
      counts.set(label, n);
      log(`${label}: ${n}`);
    },
    countReset: (label = 'default') => counts.delete(label),
    time: (label = 'default') => times.set(label, performance.now()),
    timeLog: (label = 'default', ...args: unknown[]) =>
      log(`${label}: ${(performance.now() - (times.get(label) ?? 0)).toFixed(3)}ms`, ...args),
    timeEnd: (label = 'default') => {
      log(`${label}: ${(performance.now() - (times.get(label) ?? 0)).toFixed(3)}ms`);
      times.delete(label);
    },
    group: (...args: unknown[]) => {
      if (args.length) log(...args);
      indent += '  ';
    },
    groupCollapsed: (...args: unknown[]) => {
      if (args.length) log(...args);
      indent += '  ';
    },
    groupEnd: () => {
      indent = indent.slice(2);
    },
    clear: () => {},
    profile: () => {},
    profileEnd: () => {},
    timeStamp: () => {},
  };
}
