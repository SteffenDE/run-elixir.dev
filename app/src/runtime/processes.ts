// Processes on one worker's thread, as an OS has them: each a program with
// descriptors of its own, some of them its parent's (pipes, files, the
// terminal), running at once with the others as coroutines under JSPI. A
// program built for WASI asks for processes through the `processes`
// imports (pipe, spawn, wait, kill, dup, dup2; git/wasi/stubs.c), and
// whatever would wait (a pipe empty or full, a child still running)
// suspends it, so the others run meanwhile. The host's own programs (a
// node: `hosted`) takes its input whole and runs to its end, as the shell
// has always run it; a page program streams (`writeAll`, `feed`).
import { Exit, WASI } from './wasi';
import { E } from './wasi/abi';
import type { Descriptor } from './wasi/descriptors';
import type { Dir, Fetch } from './wasi/fs';
import { Device, File } from './wasi/fs';
import { Pipe } from './wasi/pipe';
import type { Shared } from './wasi/shared';
import type { Run } from './worker/brush';
import { OutputLimitError } from './worker/output';

// What a host's program may write to a pipe ahead of its reader (it
// cannot wait): an infinite producer fails instead of exhausting memory.
export const HOSTED_LIMIT = 16 << 20;

// The parent of a process whose parent exited first.
const ORPHAN = -1;

export const SIGINT = 2;
export const SIGKILL = 9;
export const SIGTERM = 15;

// A process's start: its program (as named), arguments, directory,
// environment and standard streams, each a reference of its own (spawn
// takes one more; the caller lets go of its own when done: `release`).
export interface Spawn {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdio: [Descriptor, Descriptor, Descriptor];
}

// A program as the process table runs it: its exit status, 128 + the
// signal's number when one ended it.
export type Program = (child: Child, spawn: Spawn) => Promise<number>;
// The program a name runs, or null when there is none (ENOENT); `env`: its
// environment (its PATH, for a name without a slash).
export type Resolve = (
  program: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
) => Program | null;

export class Child {
  declare pid: number;
  declare parent: number;
  // A program the table did not start (the shell: `adopt`).
  declare adopted: boolean;
  // Its exit status, once it has exited.
  declare status: number | null;
  declare exited: Promise<number>;
  // The signal that is ending it, and what wakes it to notice.
  declare signal: number | null;
  declare woken: Promise<void>;
  declare wake: () => void;

  constructor(pid: number, parent: number) {
    this.pid = pid;
    this.parent = parent;
    this.adopted = false;
    this.status = null;
    this.signal = null;
    this.exited = Promise.resolve(0);
    this.woken = new Promise((resolve) => (this.wake = resolve));
  }

  // The signal ends it at its next call (a WASI program's; `check`), or
  // at once if it waits.
  kill(signal: number): void {
    if (this.status !== null || this.signal !== null) return;
    this.signal = signal;
    this.wake();
  }

  // Throws the signal's end, if one came.
  check(): void {
    if (this.signal !== null) throw new Exit(128 + this.signal);
  }
}

export class Processes {
  declare table: Map<number, Child>;
  declare next: number;
  declare resolve: Resolve;
  // Called now and then while a process waits for a child (the channel,
  // which takes in Ctrl+C: `interrupt`).
  declare idle: () => void;
  // The host's programs running (`hosted`): Ctrl+C is theirs meanwhile (a
  // node's break), as the shell has always given it them.
  declare hosting: number;

  constructor(resolve: Resolve, idle: () => void = () => {}) {
    this.table = new Map();
    this.next = 2;
    this.resolve = resolve;
    this.idle = idle;
    this.hosting = 0;
  }

  // A process for a program already running that the table did not start
  // (the shell), so that what it starts are its children; `forget` it
  // when it ends.
  adopt(): Child {
    const child = new Child(this.next++, 0);
    child.adopted = true;
    this.table.set(child.pid, child);
    return child;
  }

  forget(child: Child): void {
    this.table.delete(child.pid);
  }

  // Starts `spawn.program` (the caller's own references to its streams
  // stay its own); null when there is no such program.
  spawn(spawn: Spawn, parent = 0): Child | null {
    const program = this.resolve(spawn.program, spawn.args, spawn.cwd, spawn.env);
    if (!program) return null;
    for (const entry of spawn.stdio) share(entry);
    const child = new Child(this.next++, parent);
    this.table.set(child.pid, child);
    child.exited = (async () => {
      // A microtask later: the parent goes on until it waits.
      await Promise.resolve();
      try {
        child.status = (await program(child, spawn)) & 0xff;
      } catch (error) {
        if (error instanceof Exit) child.status = error.code & 0xff;
        else {
          // A host's program that failed (or wrote past HOSTED_LIMIT).
          if (!(error instanceof OutputLimitError)) console.error(error);
          const message = `${spawn.program}: ${(error as Error).message}\n`;
          sinkOf(spawn.stdio[2])?.(new TextEncoder().encode(message));
          child.status = 1;
        }
      } finally {
        for (const entry of spawn.stdio) release(entry);
        this.ended(child);
      }
      return child.status;
    })();
    // An orphan's failure is nobody's to hear.
    child.exited.catch(() => {});
    return child;
  }

  // A process that is a function of `parent`'s own (git's start_async),
  // run from the next microtask: it shares its parent's descriptors, so it
  // has no streams of its own.
  task(parent: number, run: () => Promise<number>): Child {
    const child = new Child(this.next++, parent);
    this.table.set(child.pid, child);
    child.exited = (async () => {
      await Promise.resolve();
      try {
        child.status = (await run()) & 0xff;
      } catch (error) {
        if (error instanceof Exit) child.status = error.code & 0xff;
        else {
          console.error(error);
          child.status = 1;
        }
      }
      this.ended(child);
      return child.status;
    })();
    child.exited.catch(() => {});
    return child;
  }

  // `child` exited: what it did not wait for is nobody's to (an orphan,
  // as init reaps them), nor is it once it was orphaned itself.
  ended(child: Child): void {
    for (const other of this.table.values())
      if (other.parent === child.pid) {
        if (other.status !== null) this.table.delete(other.pid);
        else other.parent = ORPHAN;
      }
    if (child.parent === ORPHAN) this.table.delete(child.pid);
  }

  // Every process but the shell: Ctrl+C at the terminal. (Not only the
  // foreground's, yet: a job in the background is stopped too.)
  interrupt(signal = SIGINT): void {
    for (const child of this.table.values()) if (!child.adopted) child.kill(signal);
  }

  // Waits for `pid`, a child of `parent`, and forgets it: its status, or
  // null when there is no such child.
  async wait(pid: number, parent: number): Promise<number | null> {
    const child = this.table.get(pid);
    if (!child || child.parent !== parent) return null;
    const status = await child.exited;
    this.table.delete(pid);
    return status;
  }

  // Runs `spawn` to its end: its status, or null when there is no such
  // program. The caller's references to its streams are let go of.
  async run(spawn: Spawn): Promise<number | null> {
    const child = this.spawn(spawn);
    for (const entry of spawn.stdio) release(entry);
    if (!child) return null;
    return this.wait(child.pid, 0);
  }
}

// Another reference to `entry` (a second table, or a process's start).
export function share(entry: Descriptor): Descriptor {
  entry.shares = (entry.shares ?? 0) + 1;
  return entry;
}

// One reference to `entry` gone; with the last, a pipe's end closes.
export function release(entry: Descriptor): void {
  if (entry.shares) entry.shares--;
  else if (entry.pipe) entry.pipe.close(!!entry.reads);
}

// A pipe's two ends, each a reference of its own.
export function pipe(): [read: Descriptor, write: Descriptor] {
  const between = new Pipe();
  between.open(true);
  between.open(false);
  return [
    { pipe: between, reads: true },
    { pipe: between, reads: false },
  ];
}

// A pipe already written and ended: `bytes` as a process's input.
export function inputPipe(bytes: Uint8Array): Descriptor {
  const [read, write] = pipe();
  write.pipe!.write(bytes, false);
  release(write);
  return read;
}

// What to call with what is written to `entry` from the host: null when it
// is the terminal itself, which the host's programs write to as they do.
function sinkOf(
  entry: Descriptor,
  shared: Shared | null = null,
): ((bytes: Uint8Array) => void) | null {
  if (entry.sink) return entry.tty ? null : entry.sink;
  if (entry.pipe)
    return (bytes) => {
      if (entry.pipe!.size + bytes.length > HOSTED_LIMIT) throw new OutputLimitError();
      entry.pipe!.write(bytes, false);
    };
  if (entry.remote && shared) {
    const remote = entry.remote;
    return (bytes) => {
      const { answer } = shared.call(
        { op: 'write', handle: remote.handle, offset: remote.position, append: remote.append },
        bytes,
      );
      if (!answer.error) remote.position = answer.position;
    };
  }
  if (entry.node instanceof File) {
    const file = entry.node;
    return (bytes) => {
      if (entry.append) entry.position = file.size;
      const end = entry.position! + bytes.length;
      file.reserve(end);
      file.data.set(bytes, entry.position);
      file.size = Math.max(file.size, end);
      file.written = true;
      entry.position = end;
    };
  }
  return () => {};
}

// All that `entry` will give from the host, to its end: null when it is
// the input itself (the terminal's, a node's), which the host's programs
// read as they come.
async function readAll(entry: Descriptor, shared: Shared | null): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  if (entry.source || (entry.stream && !entry.sink)) return null;
  if (entry.pipe) {
    // What never ends (`yes | mix …`) fails at HOSTED_LIMIT.
    let size = 0;
    for (;;) {
      const bytes = entry.pipe.read(65536);
      if (!bytes) await entry.pipe.changed();
      else if (!bytes.length) break;
      else if ((size += bytes.length) > HOSTED_LIMIT) throw new OutputLimitError();
      else parts.push(bytes);
    }
  } else if (entry.remote && shared) {
    for (;;) {
      const { answer, bytes } = shared.call({
        op: 'read',
        handle: entry.remote.handle,
        offset: entry.remote.position,
        length: 65536,
      });
      if (answer.error || !bytes.length) break;
      entry.remote.position += bytes.length;
      parts.push(bytes);
    }
  } else if (entry.node instanceof File) {
    parts.push(entry.node.bytes.slice(entry.position));
  } else if (!(entry.node instanceof Device)) return null;
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// Writes `bytes` to `entry` for a host's program, as a process would:
// waiting while a pipe is full. False once nothing reads it (EPIPE) or
// `child` has a signal to end it.
export async function writeAll(
  entry: Descriptor,
  bytes: Uint8Array,
  child: Child,
  shared: Shared | null,
): Promise<boolean> {
  const between = entry.pipe;
  if (!between) {
    (entry.tty && entry.sink ? entry.sink : sinkOf(entry, shared))?.(bytes);
    return true;
  }
  let at = 0;
  while (at < bytes.length) {
    if (child.signal !== null) return false;
    const took = between.write(bytes.subarray(at));
    if (took === -1) return false;
    if (took === null) await Promise.race([between.changed(), child.woken]);
    else at += took;
  }
  return true;
}

// Gives what `entry` has for a host's program to `send` as it comes, then
// null at its end; a pipe's as it is written (once `room()` says the
// program took enough of what it was sent), anything else's whole. Stops
// early once `done()`.
export async function feed(
  entry: Descriptor,
  send: (bytes: Uint8Array | null) => void,
  room: () => Promise<void>,
  done: () => boolean,
  shared: Shared | null,
): Promise<void> {
  const between = entry.pipe;
  if (between)
    for (;;) {
      await room();
      if (done()) return;
      const bytes = between.read(65536);
      if (!bytes) await between.changed();
      else if (!bytes.length) break;
      else send(bytes);
    }
  else {
    const bytes = await readAll(entry, shared);
    if (done()) return;
    if (bytes?.length) send(bytes);
  }
  send(null);
}

// A host's program that cannot wait (brush's Run: a node) as a process:
// its input whole first, then to its end.
export function hosted(processes: Processes, run: Run, shared: Shared | null): Program {
  return async (_child, { program, args, cwd, env, stdio }) => {
    const bytes = await readAll(stdio[0], shared);
    processes.hosting++;
    try {
      const status = await run(program, args, cwd, env, {
        input: bytes,
        stdout: sinkOf(stdio[1], shared),
        stderr: sinkOf(stdio[2], shared),
      });
      return status ?? 127;
    } finally {
      processes.hosting--;
    }
  };
}

export interface WasmOptions {
  root: Dir;
  fetch: Fetch;
  shared: Shared | null;
  // Its own argv[0] (coreutils': the tool), else the program's base name.
  argv0?: string;
  // Called at its calls (a node's channel, which takes in Ctrl+C).
  pump?: () => void;
  // Variables it has unless it was given them (git's GIT_PAGER).
  defaults?: Record<string, string>;
  // The terminal's width: COLUMNS, when its output is the terminal.
  columns?: () => number;
}

// A program built for WASI as a process: an instance of `module` with the
// standard streams it was given, its start run under JSPI, and the
// `processes` imports for children of its own.
export function wasmProgram(
  processes: Processes,
  module: WebAssembly.Module,
  options: WasmOptions,
): Program {
  return async (child, spawn) => {
    const wasi = new WASI({
      args: [options.argv0 ?? spawn.program.split('/').pop()!, ...spawn.args],
      env: {
        ...options.defaults,
        ...spawn.env,
        PWD: spawn.cwd,
        ...(spawn.stdio[1].tty && options.columns ? { COLUMNS: String(options.columns()) } : {}),
      },
      root: options.root,
      stdin: () => new Uint8Array(0),
      stdout: () => {},
      stderr: () => {},
      sleep: () => {},
      fetch: options.fetch,
      shared: options.shared,
      suspending: true,
      pump: () => {
        options.pump?.();
        child.check();
      },
    });
    wasi.interrupt = child.woken;
    spawn.stdio.forEach((entry, fd) => wasi.fds.set(fd, share(entry)));
    const instance = new WebAssembly.Instance(module, {
      ...wasi.imports,
      processes: processCalls(wasi, processes, child),
    } as WebAssembly.Imports);
    wasi.memory = instance.exports.memory as WebAssembly.Memory;
    wasi.exports = instance.exports;
    // oxlint-disable-next-line no-underscore-dangle -- the C stack's own name.
    wasi.stack = (instance.exports.__stack_pointer as WebAssembly.Global | undefined) ?? null;
    // oxlint-disable-next-line no-underscore-dangle -- WASI's name for a program's start.
    const start = WebAssembly.promising(instance.exports._start as () => void);
    try {
      await start();
      return 0;
    } catch (error) {
      if (error instanceof Exit) return error.code;
      throw error;
    } finally {
      wasi.release();
    }
  };
}

// The `processes` imports, for a WASI program that is process `self`.
// Status as waitpid has it: the exit status << 8, or the signal. The
// program's standard streams, where it has the shim's own (the shell's),
// are `standard`'s to what it starts (the terminal).
export function processCalls(
  wasi: WASI,
  processes: Processes,
  self: Child,
  standard: Descriptor[] = [],
): Record<string, unknown> {
  const fields = (ptr: number, len: number) => wasi.string(ptr, len).split('\0');
  return {
    // pipe(fds): its read end at fds[0], its write end at fds[1].
    pipe(fdsPtr: number) {
      const [read, write] = pipe();
      const r = wasi.next++;
      const w = wasi.next++;
      wasi.fds.set(r, read);
      wasi.fds.set(w, write);
      wasi.view().setUint32(fdsPtr, r, true);
      wasi.view().setUint32(fdsPtr + 4, w, true);
      return E.SUCCESS;
    },
    // spawn(request, length, in, out, err, pid): `request` NUL-separated
    // program, directory, argc, arguments, envc, environment; its standard
    // streams this process's descriptors in, out and err.
    spawn(request: number, length: number, fd0: number, fd1: number, fd2: number, pidPtr: number) {
      const list = fields(request, length);
      const [program, cwd] = list;
      const argc = Number(list[2]);
      const args = list.slice(3, 3 + argc);
      const envc = Number(list[3 + argc]);
      const env = Object.fromEntries(
        list.slice(4 + argc, 4 + argc + envc).map((v) => {
          const at = v.indexOf('=');
          return [v.slice(0, at), v.slice(at + 1)];
        }),
      );
      const stdio = [fd0, fd1, fd2].map((fd) => {
        const entry = wasi.fds.get(fd);
        const own = entry?.stream && !entry.source && !entry.sink;
        return own && standard[fd] ? standard[fd] : entry;
      });
      if (stdio.some((entry) => !entry)) return E.BADF;
      const child = processes.spawn(
        { program, args, cwd, env, stdio: stdio as Spawn['stdio'] },
        self.pid,
      );
      if (!child) return E.NOENT;
      wasi.view().setUint32(pidPtr, child.pid, true);
      return E.SUCCESS;
    },
    // wait(pid, status, mode): until it exits (mode 0), or not (1), or a
    // little (2: a few milliseconds, or until it exits); EAGAIN while it
    // runs, ECHILD when it is no child of this one.
    wait: new WebAssembly.Suspending(async (pid: number, statusPtr: number, mode: number) => {
      const child = processes.table.get(pid);
      if (!child || child.parent !== self.pid) return E.CHILD;
      if (child.status === null && mode === 1) return E.AGAIN;
      if (child.status === null && mode === 2) {
        await wasi.suspended(
          Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 10))]),
        );
        if (child.status === null) return E.AGAIN;
      }
      while (child.status === null) {
        const tick = new Promise((resolve) => setTimeout(resolve, 50));
        await wasi.suspended(Promise.race([child.exited, self.woken, tick]));
        processes.idle();
        self.check();
      }
      const status = (await wasi.suspended(processes.wait(pid, self.pid)))!;
      const signaled = child.signal !== null && status === 128 + child.signal;
      wasi.view().setInt32(statusPtr, signaled ? child.signal! : status << 8, true);
      return E.SUCCESS;
    }),
    // async_start(async, top, pid): wasi_run_async(async) as a coroutine
    // of this instance beside its own (git's start_async), its C stack
    // below `top`, from once this one waits; a process of this one's to
    // wait for.
    async_start(asyncPtr: number, top: number, pidPtr: number) {
      const run = wasi.exports?.wasi_run_async as ((async: number) => number) | undefined;
      const stack = wasi.stack;
      if (!run || !stack) return E.NOSYS;
      const task = processes.task(self.pid, async () => {
        stack.value = top;
        wasi.strand = asyncPtr;
        return WebAssembly.promising(run)(asyncPtr);
      });
      wasi.view().setUint32(pidPtr, task.pid, true);
      return E.SUCCESS;
    },
    async_current: () => wasi.strand,
    async_exit(code: number) {
      throw new Exit(code);
    },
    kill(pid: number, signal: number) {
      const child = processes.table.get(pid);
      if (!child) return E.SRCH;
      child.kill(signal);
      return E.SUCCESS;
    },
    dup(fd: number, fdPtr: number) {
      const opened = wasi.dup(fd);
      if (opened === null) return E.BADF;
      wasi.view().setUint32(fdPtr, opened, true);
      return E.SUCCESS;
    },
    dup2(fd: number, to: number) {
      const entry = wasi.fds.get(fd);
      if (!entry) return E.BADF;
      if (fd === to) return E.SUCCESS;
      if (wasi.fds.has(to)) wasi.close(to);
      wasi.fds.set(to, share(entry));
      return E.SUCCESS;
    },
  };
}
