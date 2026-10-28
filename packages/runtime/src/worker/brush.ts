// The shell as brush (brush/build.py): a bash-compatible shell built to
// WebAssembly, on the terminal. It parses and runs command lines; what it
// runs that is not its own (mix, git, ls, …) is a process of the worker's
// (processes.ts), which runs while brush goes on: a pipeline's commands at
// once, connected by pipes, and a command with `&` while brush reads the
// next line (brush-core's sys/wasm/playground.rs). brush runs under JSPI:
// what would wait (a child, a pipe, the terminal's next key) suspends it,
// and the worker's processes run meanwhile.
import { Exit, WASI } from '../wasi/index';
import { processCalls, share, type Child, type Processes } from '../processes';
import type { Descriptor } from '../wasi/descriptors';
import type { Dir, Fetch } from '../wasi/fs';
import type { Shared } from '../wasi/shared';

// How a command runs: its input (null: the terminal), and where its output
// and errors go (null: the terminal). Its exit status, or null when there
// is no such command.
export type Run = (
  program: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  io: {
    input: Uint8Array | null;
    stdout: ((bytes: Uint8Array) => void) | null;
    stderr: ((bytes: Uint8Array) => void) | null;
  },
) => Promise<number | null>;

export interface BrushOptions {
  module: WebAssembly.Module;
  args: string[];
  env: Record<string, string>;
  root: Dir;
  fetch: Fetch;
  shared: Shared | null;
  // The terminal's output, and brush's own errors (default: the output).
  out: (bytes: Uint8Array) => void;
  err?: (bytes: Uint8Array) => void;
  // The terminal as brush's line editor (reedline, over crossterm) has it:
  // raw input on or off, its size, and up to `max` bytes of its input
  // within `timeout` ms (-1: until some come); null when it was resized.
  terminal: {
    raw(on: boolean): void;
    size(): number[];
    read(max: number, timeout: number): Promise<Uint8Array | null>;
  };
  // The worker's processes, and the standard streams of what brush starts
  // where it has the terminal's: its input and output.
  processes: Processes;
  standard: [Descriptor, Descriptor, Descriptor];
  // As a process of the table (sh -c from git): its standard streams, the
  // process it is, and what takes in signals at its calls.
  stdio?: [Descriptor, Descriptor, Descriptor];
  self?: Child;
  pump?: () => void;
}

// brush until it exits: its exit status.
export async function brush(options: BrushOptions): Promise<number> {
  let memory: WebAssembly.Memory | null = null;
  const view = (pointer: number, length: number) => new Uint8Array(memory!.buffer, pointer, length);

  const wasi = new WASI({
    args: ['brush', ...options.args],
    env: options.env,
    root: options.root,
    stdin: () => new Uint8Array(0),
    stdout: (bytes) => options.out(bytes.slice()),
    stderr: (bytes) => (options.err ?? options.out)(bytes.slice()),
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    tty: !options.stdio,
    fetch: options.fetch,
    shared: options.shared,
    suspending: true,
    // A pipeline's input, which brush writes before its reader starts.
    bounded: false,
    pump: () => {
      options.pump?.();
      options.self?.check();
    },
  });
  const self = options.self ?? options.processes.adopt();
  if (options.stdio) {
    options.stdio.forEach((entry, fd) => wasi.fds.set(fd, share(entry)));
    wasi.interrupt = self.woken;
  } else {
    // What brush reads itself (`read`): the terminal's typing, or a node's
    // input, as it comes, suspended while none has (the worker's processes
    // run meanwhile: a job's).
    wasi.fds.set(0, { ...options.standard[0] });
  }

  // crossterm's WASI backend (brush/crossterm/patches).
  const crossterm = {
    raw_mode: (on: number) => {
      options.terminal.raw(on !== 0);
      return 0;
    },
    size: (columns: number, rows: number) => {
      const [width, height] = options.terminal.size();
      const data = new DataView(memory!.buffer);
      data.setUint16(columns, width, true);
      data.setUint16(rows, height, true);
      return 0;
    },
    read: new WebAssembly.Suspending(async (buffer: number, max: number, timeout: number) => {
      const bytes = await options.terminal.read(max, timeout);
      if (!bytes) return -1;
      view(buffer, bytes.length).set(bytes);
      return bytes.length;
    }),
  };
  const instance = new WebAssembly.Instance(options.module, {
    ...wasi.imports,
    processes: processCalls(wasi, options.processes, self, options.stdio ? [] : options.standard),
    crossterm,
  } as unknown as WebAssembly.Imports);
  memory = instance.exports.memory as WebAssembly.Memory;
  wasi.memory = memory;
  // oxlint-disable-next-line no-underscore-dangle -- WASI's name for a program's start.
  const start = WebAssembly.promising(instance.exports._start as () => void);
  try {
    await start();
    return 0;
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  } finally {
    if (options.stdio) wasi.release();
    else options.processes.forget(self);
  }
}
