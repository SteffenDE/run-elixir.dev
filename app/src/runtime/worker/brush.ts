// The shell as brush (brush/build.py): a bash-compatible shell built to
// WebAssembly, on the terminal. It parses and runs command lines; what it
// runs that is not its own (mix, git, ls, …) is the host's: `run`, as the
// playground's own shell ran it. brush waits for it through JSPI
// (WebAssembly.Suspending), so a node runs in this worker, on the
// terminal, while brush is suspended. Its pipes and redirections are in
// its memory: a command's input is what the one before it wrote, and its
// output brush's unless it is the terminal's (brush-core's
// sys/wasm/playground.rs).
import { Exit, WASI } from '../wasi';
import { BufferedOutput, OutputLimitError } from './output';

// JSPI, which TypeScript's DOM library does not have yet.
declare global {
  // oxlint-disable-next-line typescript/no-namespace -- extends the global WebAssembly.
  namespace WebAssembly {
    // oxlint-disable-next-line typescript/no-extraneous-class -- JSPI's wrapper for an import.
    class Suspending {
      constructor(f: (...args: never[]) => Promise<unknown>);
    }
    function promising<A extends unknown[], R>(f: (...args: A) => R): (...args: A) => Promise<R>;
  }
}
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
  // A line typed at the terminal (blocking); null when Ctrl+C dropped it.
  line: () => string | null;
  // The terminal's output.
  out: (bytes: Uint8Array) => void;
  // The terminal as brush's line editor (reedline, over crossterm) has it:
  // raw input on or off, its size, and up to `max` bytes of its input
  // within `timeout` ms (-1: until some come); null when it was resized.
  terminal: {
    raw(on: boolean): void;
    size(): number[];
    read(max: number, timeout: number): Uint8Array | null;
  };
  run: Run;
}

// brush until it exits: its exit status.
export async function brush(options: BrushOptions): Promise<number> {
  let memory: WebAssembly.Memory | null = null;
  const view = (pointer: number, length: number) => new Uint8Array(memory!.buffer, pointer, length);
  // The terminal's input, a line at a time.
  let pending = new Uint8Array(0);
  // What the last command wrote that was not the terminal's.
  let captured = new BufferedOutput();

  const wasi = new WASI({
    args: ['brush', ...options.args],
    env: options.env,
    root: options.root,
    stdin: (max) => {
      if (!pending.length) {
        const line = options.line();
        if (line === null) options.out(new TextEncoder().encode('^C\n'));
        pending = new TextEncoder().encode(`${line ?? ''}\n`);
      }
      const chunk = pending.subarray(0, max);
      pending = pending.subarray(chunk.length);
      return chunk;
    },
    stdout: (bytes) => options.out(bytes.slice()),
    stderr: (bytes) => options.out(bytes.slice()),
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    tty: true,
    fetch: options.fetch,
    shared: options.shared,
  });

  const spawn = new WebAssembly.Suspending(
    async (
      request: number,
      requestLength: number,
      input: number,
      inputLength: number,
      flags: number,
    ) => {
      const fields = new TextDecoder().decode(view(request, requestLength)).split('\0');
      const [program, cwd] = fields;
      const argc = Number(fields[2]);
      const args = fields.slice(3, 3 + argc);
      const envc = Number(fields[3 + argc]);
      const env = Object.fromEntries(
        fields.slice(4 + argc, 4 + argc + envc).map((v) => {
          const at = v.indexOf('=');
          return [v.slice(0, at), v.slice(at + 1)];
        }),
      );
      captured = new BufferedOutput();
      const keep = (stream: number) => (bytes: Uint8Array) => captured.write(stream, bytes);
      try {
        const status = await options.run(program, args, cwd, env, {
          input: flags & 1 ? null : view(input, inputLength).slice(),
          stdout: flags & 2 ? null : keep(1),
          stderr: flags & 4 ? null : keep(2),
        });
        return status ?? -1;
      } catch (error) {
        if (!(error instanceof OutputLimitError)) throw error;
        captured = new BufferedOutput();
        options.out(new TextEncoder().encode(`${error.message}\n`));
        return 125;
      }
    },
  );
  const output = (stream: number, buffer: number, max: number) => {
    return captured.read(stream, view(buffer, max));
  };

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
    read: (buffer: number, max: number, timeout: number) => {
      const bytes = options.terminal.read(max, timeout);
      if (!bytes) return -1;
      view(buffer, bytes.length).set(bytes);
      return bytes.length;
    },
  };
  const instance = new WebAssembly.Instance(options.module, {
    ...wasi.imports,
    playground: { spawn: spawn as unknown as WebAssembly.ImportValue, output },
    crossterm,
  });
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
  }
}
