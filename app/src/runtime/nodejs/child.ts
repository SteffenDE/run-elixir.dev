// node:child_process: a child is a command line the exec frame's sh runs
// (programs/nodejs.ts, brush in a worker of its own), as the terminal's
// shell would: node, npm, npx, git, mix, coreutils and node_modules/.bin's
// scripts. Without `shell`, the command and its arguments are quoted.
//
// The process asks { kind: 'child', op: 'spawn', id, line, cwd, env } and
// { op: 'kill', id }; it hears { op: 'out', id, bytes } and { op: 'exit',
// id, code }. A page program has one output, so a child's stderr comes on
// its stdout; its stdin ends at once. The synchronous forms (spawnSync,
// execSync) are not there yet.
import { EventEmitter } from 'events';
import * as streams from 'readable-stream';
import { Buffer } from './buffer';

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

const notAvailable = (name: string) => () => {
  throw Object.assign(new Error(`child_process.${name} is not available in the playground yet`), {
    code: 'ERR_NOT_AVAILABLE',
  });
};

export function createChildProcess(
  post: (message: unknown) => void,
  hold: Hold,
  own: {
    cwd: () => string;
    env: Record<string, string>;
    write: (fd: number, bytes: Uint8Array) => void;
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
    // fd, 'inherit', process.stdout given as itself) or a stream's.
    declare sink: ((bytes: Uint8Array) => void) | null;
    declare connected: boolean;

    constructor(file: string, args: string[], options: SpawnOptions) {
      super();
      this.id = ++nextId;
      this.pid = nextPid++;
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      this.connected = false;
      this.spawnfile = file;
      this.spawnargs = [file, ...args];
      const stdio = Array.isArray(options.stdio)
        ? options.stdio
        : [options.stdio, options.stdio, options.stdio];
      const out = stdio[1] as Stdio & { fd?: number; write?: (chunk: Uint8Array) => unknown };
      this.sink =
        out === 'inherit' || out === 1 || out === 2
          ? (bytes) => own.write(out === 2 ? 2 : 1, bytes)
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
      this.stdin = piped(stdio[0])
        ? new Writable({ write: (_chunk, _encoding, done) => done() })
        : null;
      this.stdio = [this.stdin, this.stdout, this.stderr];
      this.release = hold();
      children.set(this.id, this);
      const line = options.shell
        ? [file, ...args].join(' ')
        : [file, ...args].map((word) => quote(String(word))).join(' ');
      const cwd = options.cwd instanceof URL ? options.cwd.pathname : (options.cwd ?? own.cwd());
      const env = Object.fromEntries(
        Object.entries(options.env ?? own.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>;
      post({ kind: 'child', op: 'spawn', id: this.id, line, cwd: String(cwd), env });
      options.signal?.addEventListener('abort', () => this.kill('SIGTERM'), { once: true });
      if (options.timeout)
        setTimeout(() => this.exitCode === null && this.kill('SIGTERM'), options.timeout);
      queueMicrotask(() => this.emit('spawn'));
      this.shell = Boolean(options.shell);
    }
    declare shell: boolean;

    // The child's output.
    output(bytes: Uint8Array) {
      if (this.sink) this.sink(bytes);
      else this.stdout?.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    }

    exited(code: number) {
      children.delete(this.id);
      this.release?.();
      this.release = null;
      // A command sh did not find: spawn's ENOENT, as Node says it.
      if (code === 127 && !this.shell) {
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
        return;
      }
      const signal = this.killed && code >= 128 ? 'SIGTERM' : null;
      this.exitCode = signal ? null : code;
      this.signalCode = signal;
      this.stdout?.push(null);
      this.stderr?.push(null);
      this.emit('exit', this.exitCode, signal);
      const closed = () => this.emit('close', this.exitCode, signal);
      // 'close' once its streams have ended, as Node's.
      if (this.stdout && !this.stdout.readableEnded && this.stdout.listenerCount('data'))
        this.stdout.once('end', closed);
      else queueMicrotask(closed);
    }

    kill(signal: string | number = 'SIGTERM') {
      if (this.exitCode !== null || this.signalCode !== null) return false;
      this.killed = true;
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
  function spawn(file: string, args?: string[] | SpawnOptions, options?: SpawnOptions) {
    if (!Array.isArray(args)) [options, args] = [args, []];
    return new ChildProcess(file, args, options ?? {});
  }

  type Done = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void;

  // A child's whole output, then callback(error, stdout, stderr).
  function collect(child: ChildProcess, options: SpawnOptions, callback?: Done) {
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    const encode = (b: Buffer) =>
      options.encoding === 'buffer'
        ? b
        : b.toString((options.encoding as BufferEncoding) ?? 'utf8');
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
    args?: string[] | SpawnOptions | Done,
    options?: SpawnOptions | Done,
    callback?: Done,
  ) {
    if (typeof args === 'function') [callback, args, options] = [args, [], {}];
    else if (!Array.isArray(args)) [callback, options, args] = [options as Done, args, []];
    if (typeof options === 'function') [callback, options] = [options, {}];
    const opts = (options ?? {}) as SpawnOptions;
    return collect(spawn(file, args as string[], opts), opts, callback);
  }

  // A Node.js child, without the IPC channel.
  function fork(module: string, args?: string[] | SpawnOptions, options?: SpawnOptions) {
    if (!Array.isArray(args)) [options, args] = [args, []];
    return spawn('node', [module, ...args], { stdio: 'inherit', ...options });
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
    spawnSync: notAvailable('spawnSync'),
    execSync: notAvailable('execSync'),
    execFileSync: notAvailable('execFileSync'),
  };
  return { module, receive };
}

export type ChildProcesses = ReturnType<typeof createChildProcess>;
