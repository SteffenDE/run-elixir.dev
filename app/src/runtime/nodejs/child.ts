// node:child_process: a child is a command line the exec frame's sh runs
// (programs/nodejs.ts, brush in a worker of its own), as the terminal's
// shell would: node, npm, npx, git, mix, coreutils and node_modules/.bin's
// scripts. Without `shell`, the command and its arguments are quoted.
//
// The process asks { kind: 'child', op: 'spawn', id, line, cwd, env },
// { op: 'stdin', id, bytes } (or end) and { op: 'kill', id }; it hears
// { op: 'out', id, bytes } and { op: 'exit', id, code }. A page program has
// one output, so a child's stderr comes on its stdout. The synchronous
// forms (spawnSync, execSync, execFileSync) give a SharedArrayBuffer of
// maxBuffer's size with the spawn, which the exec frame fills, and wait
// on it (Atomics.wait): the process stands still meanwhile, as Node's.
import { EventEmitter } from 'events';
import * as streams from 'readable-stream';
import { Buffer } from './buffer';
import { signalName } from './signals';

const { Readable, Writable } = streams as typeof import('node:stream');

type Hold = () => () => void;
type Stdio = 'pipe' | 'inherit' | 'ignore' | 'overlapped' | null | undefined | number | object;

export type ChildMessage =
  | { kind: 'child'; op: 'out'; id: number; bytes: Uint8Array }
  | { kind: 'child'; op: 'exit'; id: number; code: number };

interface SpawnOptions {
  cwd?: string | URL;
  env?: Record<string, string | undefined>;
  shell?: boolean | string;
  stdio?: Stdio | Stdio[];
  signal?: AbortSignal;
  timeout?: number;
  encoding?: BufferEncoding | 'buffer';
  maxBuffer?: number;
}

const quote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

// A command line for sh: as it is (shell), or the words quoted.
const lineOf = (file: string, args: string[], shell?: boolean | string) =>
  shell ? [file, ...args].join(' ') : [file, ...args].map((word) => quote(String(word))).join(' ');

// A child's arguments and options, as Node takes them: (args, options),
// (options), or (null, options).
const withArgs = <O>(
  args: string[] | O | null | undefined,
  options?: O,
): [string[], O | undefined] =>
  args == null ? [[], options] : Array.isArray(args) ? [args, options] : [[], args as O];

const toBytes = (data: string | Uint8Array | ArrayBufferView) =>
  typeof data === 'string'
    ? new TextEncoder().encode(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

// What a synchronous child's output is: a Buffer, or text in `encoding`.
const encoded = (bytes: Uint8Array, encoding?: string) => {
  const buffer = Buffer.from(bytes);
  return encoding && encoding !== 'buffer' ? buffer.toString(encoding as BufferEncoding) : buffer;
};

// Whether a child's output is sh saying its program is not there
// (brush's error; the Node harness's sh's), not the program's own 127.
const notFound = (output: string, file: string) => {
  // oxlint-disable-next-line no-control-regex -- its colors, if any.
  const said = output.replace(/\x1b\[[0-9;]*m/g, '').trim();
  return (
    said === `error: command not found: ${file}` ||
    said === `sh: ${file}: not found in the playground`
  );
};

export function createChildProcess(
  post: (message: unknown) => void,
  hold: Hold,
  own: {
    cwd: () => string;
    env: Record<string, string>;
    // To its stdout, its stderr, or a file it opened.
    write: (fd: number, bytes: Uint8Array) => void;
    // A file it opened as a child's own fd (and its closing), and a path
    // through one (/proc/self/fd/N): fs.ts.
    files?: {
      dup(fd: number): number;
      close(fd: number): void;
      throughFd(path: string): string;
    };
  },
) {
  const children = new Map<number, ChildProcess>();
  let nextId = 0;
  let nextPid = 1000 + Math.floor(Math.random() * 1000);

  class ChildProcess extends EventEmitter {
    declare id: number;
    declare pid: number;
    declare stdin: InstanceType<typeof Writable> | null;
    declare stdout: InstanceType<typeof Readable> | null;
    declare stderr: InstanceType<typeof Readable> | null;
    declare stdio: unknown[];
    declare exitCode: number | null;
    declare signalCode: string | null;
    declare killed: boolean;
    declare spawnfile: string;
    declare spawnargs: string[];
    declare release: (() => void) | null;
    // Where its output goes when it is not piped: the process's own (an
    // fd, 'inherit', process.stdout given as itself), a file the process
    // opened (its fd: Claude Code's shell writes to one), or a stream's.
    declare sink: ((bytes: Uint8Array) => void) | null;
    declare connected: boolean;
    // The start of its output (notFound).
    declare said: string;
    declare unwatch: () => void;
    // The signal kill() sent, which it says it ended by (the exec frame
    // ends a child the same way, whichever).
    declare killedBy: string;

    constructor(file: string, args: string[], options: SpawnOptions) {
      super();
      // An fd it inherits, named by /proc/self/fd/N (Claude Code runs rg by
      // one): the file's path, as a child sees it.
      const through = (path: string) => own.files?.throughFd(path) ?? path;
      file = through(file);
      args = args.map((arg) => through(String(arg)));
      this.id = ++nextId;
      this.pid = nextPid++;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      this.connected = false;
      this.said = '';
      this.spawnfile = file;
      this.spawnargs = [file, ...args];
      const stdio = Array.isArray(options.stdio)
        ? options.stdio
        : [options.stdio, options.stdio, options.stdio];
      const out = stdio[1] as Stdio & { fd?: number; write?: (chunk: Uint8Array) => unknown };
      // A file's fd: its own copy, which outlives the process's closing it.
      this.copy = typeof out === 'number' && out > 2 && own.files ? own.files.dup(out) : null;
      const copy = this.copy;
      this.sink =
        out === 'inherit'
          ? (bytes) => own.write(1, bytes)
          : copy !== null
            ? (bytes) => own.write(copy, bytes)
            : typeof out === 'number' && out > 0
              ? (bytes) => own.write(out, bytes)
              : out && typeof out === 'object' && typeof out.write === 'function'
                ? out.fd === 1 || out.fd === 2
                  ? (bytes) => own.write(out.fd!, bytes)
                  : (bytes) => out.write!(bytes)
                : null;
      const piped = (s: Stdio) =>
        s === undefined || s === null || s === 'pipe' || s === 'overlapped';
      this.stdout = piped(stdio[1]) ? new Readable({ read() {} }) : null;
      // Its stderr comes on its stdout: an empty stream that ends with it.
      this.stderr = piped(stdio[2]) ? new Readable({ read() {} }) : null;
      // What the program writes to it, and its end.
      this.stdin = piped(stdio[0])
        ? new Writable({
            write: (chunk: Uint8Array, _encoding, done) => {
              post({ kind: 'child', op: 'stdin', id: this.id, bytes: new Uint8Array(chunk) });
              done();
            },
            final: (done) => {
              post({ kind: 'child', op: 'stdin', id: this.id, end: true });
              done();
            },
          })
        : null;
      this.stdio = [this.stdin, this.stdout, this.stderr];
      this.release = hold();
      children.set(this.id, this);
      const line = lineOf(file, args, options.shell);
      const cwd = through(
        options.cwd instanceof URL ? options.cwd.pathname : String(options.cwd ?? own.cwd()),
      );
      const env = Object.fromEntries(
        Object.entries(options.env ?? own.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>;
      post({ kind: 'child', op: 'spawn', id: this.id, line, cwd: String(cwd), env });
      // Its abort signal and timeout, which hold nothing once it has exited.
      const { signal, timeout } = options;
      const abort = () => this.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      const timer = timeout ? setTimeout(abort, timeout) : undefined;
      this.unwatch = () => {
        signal?.removeEventListener('abort', abort);
        clearTimeout(timer);
      };
      queueMicrotask(() => this.emit('spawn'));
      this.shell = Boolean(options.shell);
    }
    declare shell: boolean;
    // Its own fd on the file its output goes to, if one.
    declare copy: number | null;

    // The child's output.
    output(bytes: Uint8Array) {
      if (this.said.length < 256) this.said += new TextDecoder().decode(bytes);
      if (this.sink) this.sink(bytes);
      else this.stdout?.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    }

    exited(code: number) {
      children.delete(this.id);
      this.unwatch();
      if (this.copy !== null) own.files?.close(this.copy);
      this.copy = null;
      // The loop is held until 'close', which may wait for its stdout's end.
      const release = () => {
        this.release?.();
        this.release = null;
      };
      // A command sh did not find: spawn's ENOENT, as Node says it.
      if (code === 127 && !this.shell && notFound(this.said, this.spawnfile)) {
        const error = Object.assign(new Error(`spawn ${this.spawnfile} ENOENT`), {
          errno: -2,
          code: 'ENOENT',
          syscall: `spawn ${this.spawnfile}`,
          path: this.spawnfile,
          spawnargs: this.spawnargs.slice(1),
        });
        this.stdout?.push(null);
        this.stderr?.push(null);
        this.emit('error', error);
        this.emit('close', -2, null);
        release();
        return;
      }
      const signal = this.killed && code >= 128 ? this.killedBy : null;
      this.exitCode = signal ? null : code;
      this.signalCode = signal;
      this.stdout?.push(null);
      this.stderr?.push(null);
      this.emit('exit', this.exitCode, signal);
      const closed = () => {
        this.emit('close', this.exitCode, signal);
        release();
      };
      // 'close' once its streams have ended, as Node's.
      if (this.stdout && !this.stdout.readableEnded && this.stdout.listenerCount('data'))
        this.stdout.once('end', closed);
      else queueMicrotask(closed);
    }

    kill(signal: string | number = 'SIGTERM') {
      if (this.exitCode !== null || this.signalCode !== null) return false;
      this.killed = true;
      this.killedBy = signalName(signal);
      post({ kind: 'child', op: 'kill', id: this.id, signal });
      return true;
    }

    ref() {
      this.release ??= hold();
    }
    unref() {
      this.release?.();
      this.release = null;
    }
    disconnect() {}
    send() {
      return false;
    }
  }

  // spawn(command, args?, options?)
  function spawn(file: string, args?: string[] | SpawnOptions | null, options?: SpawnOptions) {
    [args, options] = withArgs(args, options);
    return new ChildProcess(file, args, options ?? {});
  }

  type Done = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void;

  // A child's whole output, then callback(error, stdout, stderr).
  function collect(child: ChildProcess, options: SpawnOptions, callback?: Done) {
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    // Text in its encoding (utf8 unless given), else (null, 'buffer') a Buffer.
    const encoding = options.encoding === undefined ? 'utf8' : options.encoding;
    const encode = (b: Buffer) =>
      encoding && encoding !== 'buffer' && Buffer.isEncoding(encoding) ? b.toString(encoding) : b;
    child.on('error', (error: Error) =>
      callback?.(error, encode(Buffer.alloc(0)), encode(Buffer.alloc(0))),
    );
    child.on('close', (code: number, signal: string | null) => {
      if (code === -2) return;
      const out = Buffer.concat(chunks);
      const error =
        code === 0
          ? null
          : Object.assign(new Error(`Command failed: ${child.spawnargs.join(' ')}\n${out}`), {
              code,
              killed: child.killed,
              signal,
              cmd: child.spawnargs.join(' '),
            });
      callback?.(error, encode(out), encode(Buffer.alloc(0)));
    });
    return child;
  }

  function exec(command: string, options?: SpawnOptions | Done, callback?: Done) {
    if (typeof options === 'function') [callback, options] = [options, {}];
    const opts = options ?? {};
    return collect(spawn(command, [], { ...opts, shell: true }), opts, callback);
  }

  function execFile(
    file: string,
    args?: string[] | SpawnOptions | Done | null,
    options?: SpawnOptions | Done,
    callback?: Done,
  ) {
    if (typeof args === 'function') [callback, args, options] = [args, [], {}];
    else if (args == null) args = [];
    else if (!Array.isArray(args)) [callback, options, args] = [options as Done, args, []];
    if (typeof options === 'function') [callback, options] = [options, {}];
    const opts = (options ?? {}) as SpawnOptions;
    return collect(spawn(file, args as string[], opts), opts, callback);
  }

  // A Node.js child, without the IPC channel.
  function fork(module: string, args?: string[] | SpawnOptions | null, options?: SpawnOptions) {
    [args, options] = withArgs(args, options);
    return spawn('node', [module, ...args], { stdio: 'inherit', ...options });
  }

  type SyncOptions = SpawnOptions & { input?: string | Uint8Array | ArrayBufferView };
  type SyncResult = {
    pid: number;
    output: [null, Buffer | string, Buffer | string];
    stdout: Buffer | string;
    stderr: Buffer | string;
    status: number | null;
    signal: string | null;
    error?: Error;
  };

  // spawnSync(command, args?, options?): the child run to its end, the
  // process waiting.
  function spawnSync(
    file: string,
    args?: string[] | SyncOptions | null,
    options?: SyncOptions,
  ): SyncResult {
    [args, options] = withArgs(args, options);
    const opts = options ?? {};
    // maxBuffer: Node's 1 MiB by default; Infinity, as much as 64 MiB.
    const room = Math.min(
      opts.maxBuffer === undefined
        ? 1 << 20
        : opts.maxBuffer === Infinity
          ? 64 << 20
          : opts.maxBuffer,
      256 << 20,
    );
    const shared = new SharedArrayBuffer(12 + room);
    const header = new Int32Array(shared, 0, 3);
    const stdio = Array.isArray(opts.stdio) ? opts.stdio : [opts.stdio, opts.stdio, opts.stdio];
    const inherit = stdio[1] === 'inherit' || stdio[1] === 1;
    const cwd = opts.cwd instanceof URL ? opts.cwd.pathname : (opts.cwd ?? own.cwd());
    const env = Object.fromEntries(
      Object.entries(opts.env ?? own.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;
    const id = ++nextId;
    const pid = nextPid++;
    post({
      kind: 'child',
      op: 'spawn',
      id,
      line: lineOf(file, args, opts.shell),
      cwd: String(cwd),
      env,
      input: opts.input === undefined ? new Uint8Array(0) : toBytes(opts.input),
      shared,
      inherit,
    });
    // Until it ends, or its time is up (then it is stopped, and waited for).
    const deadline = opts.timeout ? Date.now() + opts.timeout : Infinity;
    let timedOut = false;
    while (Atomics.load(header, 0) === 0) {
      const left = deadline - Date.now();
      if (left <= 0 && !timedOut) {
        timedOut = true;
        post({ kind: 'child', op: 'kill', id, signal: 'SIGTERM' });
      }
      Atomics.wait(header, 0, 0, timedOut || left === Infinity ? undefined : left);
    }
    const status = Atomics.load(header, 1);
    const length = Atomics.load(header, 2);
    const bytes = new Uint8Array(shared, 12, Math.max(0, length)).slice();
    const out = encoded(bytes, opts.encoding);
    const none = encoded(new Uint8Array(0), opts.encoding);
    const result: SyncResult = {
      pid,
      output: [null, out, none],
      stdout: out,
      stderr: none,
      status: timedOut ? null : status,
      signal: timedOut ? 'SIGTERM' : null,
    };
    if (length < 0)
      result.error = Object.assign(new Error(`spawnSync ${file} ENOBUFS`), {
        code: 'ENOBUFS',
        errno: -105,
        syscall: `spawnSync ${file}`,
      });
    else if (timedOut)
      result.error = Object.assign(new Error(`spawnSync ${file} ETIMEDOUT`), {
        code: 'ETIMEDOUT',
        errno: -110,
        syscall: `spawnSync ${file}`,
      });
    else if (status === 127 && !opts.shell && notFound(new TextDecoder().decode(bytes), file)) {
      result.status = null;
      result.error = Object.assign(new Error(`spawnSync ${file} ENOENT`), {
        code: 'ENOENT',
        errno: -2,
        syscall: `spawnSync ${file}`,
        path: file,
        spawnargs: args,
      });
    }
    return result;
  }

  // execSync's and execFileSync's: the output, or (failed) a throw with
  // the result on it, as Node's.
  function checked(result: SyncResult, command: string) {
    if (result.error) throw Object.assign(result.error, result);
    if (result.status !== 0)
      throw Object.assign(
        new Error(`Command failed: ${command}\n${String(result.stdout)}`),
        result,
      );
    return result.stdout;
  }

  function execSync(command: string, options?: SyncOptions) {
    return checked(spawnSync(command, [], { ...options, shell: true }), command);
  }

  function execFileSync(file: string, args?: string[] | SyncOptions | null, options?: SyncOptions) {
    [args, options] = withArgs(args, options);
    return checked(spawnSync(file, args, options), [file, ...args].join(' '));
  }

  // What the exec frame says.
  const receive = (message: ChildMessage) => {
    const child = children.get(message.id);
    if (!child) return;
    if (message.op === 'out') child.output(message.bytes);
    else child.exited(message.code);
  };

  // promisify(exec) and promisify(execFile) answer { stdout, stderr }.
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const promised =
    (f: (...args: never[]) => ChildProcess) =>
    (...args: unknown[]) =>
      new Promise((resolve, reject) =>
        (f as (...a: unknown[]) => ChildProcess)(
          ...args,
          (error: Error | null, stdout: unknown, stderr: unknown) =>
            error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
        ),
      );
  Object.assign(exec, { [custom]: promised(exec as never) });
  Object.assign(execFile, { [custom]: promised(execFile as never) });

  const module = {
    ChildProcess,
    spawn,
    exec,
    execFile,
    fork,
    spawnSync,
    execSync,
    execFileSync,
  };
  return { module, receive };
}

export type ChildProcesses = ReturnType<typeof createChildProcess>;
