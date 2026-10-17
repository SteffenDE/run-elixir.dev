// One node on the Emscripten BEAM (playground/beam), as the browser's
// worker and the Node harness (node.ts) run it: the module from the site,
// the node's tree and the shared directories mounted through PROXYFS
// (treefs.ts, sharedfs.ts), TCP through the Network (playground/beam/
// socket), the terminal through Popcorn's prim_tty (patches 0011, 0017).
//
// The module's main thread is the caller's (a worker, or Node's): with
// PROXY_TO_PTHREAD the node runs in threads of its own, and every file and
// network call they make is proxied here, so this thread must not block
// while the node runs.
import type { Dir } from '../wasi/fs';
import { Process, type Programs } from '../wasi/process';
import { WASI } from '../wasi';
import { Nifs } from '../nif';
import type { Network } from '../wasi/net';
import type { SharedCall } from '../wasi/shared';
import { SharedFs } from './sharedfs';
import { TreeFs } from './treefs';

export interface BeamOptions {
  // beam.mjs's URL; its threads load beam.emu.mjs beside it.
  module: string;
  // The emulator's arguments, `--`, then init's (as erlexec passes them).
  args: string[];
  env: Record<string, string>;
  cwd: string;
  root: Dir;
  fs: TreeFs;
  // Directories files.js holds, and its channel.
  shared?: { prefixes: string[]; call: SharedCall } | null;
  network: Network;
  // The programs ports run (open_port spawn: playground/beam/host).
  programs?: Programs;
  // HTTPS by the page's fetch (network.remote.https): ssl connects through
  // this port of the network (patch 0020, playground/beam/socket).
  httpsGateway?: number;
  // Whether standard input is a terminal (IEx then edits its lines in raw
  // mode); otherwise it is a stream that ends, as a pipe's (node.ts).
  tty: boolean;
  // The terminal's size, and its mode as the shell sets it.
  size: [columns: number, rows: number];
  onMode?: (raw: boolean) => void;
  stdout: (bytes: Uint8Array) => void;
  stderr: (bytes: Uint8Array) => void;
  memory?: WebAssembly.Memory;
  trace?: boolean;
}

export interface BeamNode {
  // The exit status, once the node has halted.
  done: Promise<number>;
  input(bytes: Uint8Array): void;
  // Standard input has ended.
  end(): void;
  resize(columns: number, rows: number): void;
  // Stops the node at once (Ctrl+C), with this status.
  kill(status: number): void;
}

// prim_tty's buffer (patch 0011), which the host keeps from overflowing.
const STDIN_CAPACITY = 64 * 1024;
const encoder = new TextEncoder();

// oxlint-disable-next-line typescript/no-explicit-any -- Emscripten's module.
type Module = any;

export function startBeam(options: BeamOptions): BeamNode {
  const memory =
    options.memory ?? new WebAssembly.Memory({ initial: 1024, maximum: 65536, shared: true });
  let module: Module = null;
  let exited = false;
  // Standard input not yet in prim_tty's buffer, and what is there.
  const pending: Uint8Array[] = [];
  let buffered = 0;
  let ended = false;
  let endSent = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  // A C function the module exports (Emscripten names them _name).
  const c = (name: string, ...args: number[]): number => module[`_${name}`](...args);
  const later = () => {
    retry ??= setTimeout(() => {
      retry = null;
      flush();
    }, 20);
  };
  // What fits into prim_tty's buffer, once it exists; then the end.
  const flush = () => {
    if (!module || exited) return;
    while (pending.length) {
      const room = STDIN_CAPACITY - buffered;
      if (room <= 0) return;
      let chunk = pending[0];
      if (chunk.length > room) {
        pending[0] = chunk.subarray(room);
        chunk = chunk.subarray(0, room);
      } else pending.shift();
      const at = c('malloc', chunk.length);
      new Uint8Array(memory.buffer).set(chunk, at);
      const status = c('popcornStdinEnqueue', at, chunk.length);
      c('free', at);
      if (status < 0) {
        // prim_tty is not loaded yet.
        pending.unshift(chunk);
        return later();
      }
      buffered += chunk.length;
    }
    if (ended && !endSent) {
      if (c('popcornStdinEof') < 0) return later();
      endSent = true;
    }
  };
  let size = options.size;

  const done = new Promise<number>((resolve, reject) => {
    const finish = (status: number) => {
      if (exited) return;
      exited = true;
      if (retry) clearTimeout(retry);
      resolve(status);
    };
    import(/* @vite-ignore */ options.module)
      .then(({ default: createModule }) =>
        createModule({
          arguments: options.args,
          // Not a terminal: /dev/stdin a device of its own (prim_tty reads
          // through Popcorn's buffer either way).
          ...(options.tty ? {} : { stdin: () => null }),
          wasmMemory: memory,
          beamNetwork: options.network,
          beamHttpsGateway: options.httpsGateway,
          beamNifs: nifHost(options),
          beamSocketTrace: options.trace,
          onTtyChunk: (fd: number, chunk: Uint8Array) =>
            (fd === 2 ? options.stderr : options.stdout)(chunk),
          print: (line: string) => options.stdout(encoder.encode(line + '\n')),
          printErr: (line: string) => {
            if (!line.includes('Heap resize call')) options.stderr(encoder.encode(line + '\n'));
          },
          onTtyMode: (raw: boolean) => options.onMode?.(raw),
          onStdinConsumed: (count: number) => {
            buffered -= count;
            flush();
          },
          beamSpawn: (
            program: string,
            args: string[],
            cwd: string,
            env: Record<string, string>,
            notify: () => void,
          ) => spawn(options, program, args, cwd, env, notify),
          onExit: finish,
          onAbort: (what: unknown) => reject(new Error(`the node aborted: ${what}`)),
          preRun: [
            (instance: Module) => {
              module = instance;
              const { FS, ENV } = instance;
              const proxyfs = FS.filesystems.PROXYFS;
              const shared = options.shared;
              // Emscripten's ErrnoError says only its number.
              const step = (what: string, run: () => void) => {
                try {
                  run();
                } catch (error) {
                  throw new Error(`${what}: errno ${(error as { errno?: number }).errno}`, {
                    cause: error,
                  });
                }
              };
              const mount = (at: string, fs: TreeFs | SharedFs) =>
                step(`mounting ${at}`, () => {
                  if (!FS.analyzePath(at).exists) FS.mkdir(at);
                  FS.mount(proxyfs, { root: at, fs }, at);
                });
              // Emscripten's own /dev (the standard streams, /dev/urandom)
              // and /proc stay.
              for (const name of options.root.entries.keys()) {
                if (name === 'dev' || name === 'proc') continue;
                if (!shared?.prefixes.includes(`/${name}`)) mount(`/${name}`, options.fs);
              }
              if (shared) {
                const fs = new SharedFs(shared.call);
                for (const at of shared.prefixes) mount(at, fs);
              }
              Object.assign(ENV, options.env, {
                COLUMNS: String(size[0]),
                LINES: String(size[1]),
              });
              if (options.httpsGateway && options.network.remote.https)
                ENV.PLAYGROUND_HTTPS_GATEWAY = String(options.httpsGateway);
              step(`changing to ${options.cwd}`, () => FS.chdir(options.cwd));
            },
          ],
        }).then(() => flush()),
      )
      .catch(reject);
  });

  return {
    done,
    input(bytes) {
      pending.push(bytes);
      flush();
    },
    end() {
      ended = true;
      flush();
    },
    resize(columns, rows) {
      size = [columns, rows];
      if (module && !exited) c('popcornTtyResize', columns, rows);
    },
    kill(status) {
      if (!module || exited) return;
      try {
        c('emscripten_force_exit', status);
      } catch (error) {
        // Emscripten unwinds by throwing its ExitStatus; onExit has run.
        if ((error as Error).name !== 'ExitStatus') throw error;
      }
    },
  };
}

// A port's program, by its base name or the first part of it, as Rust-OTP
// finds it (wasi/process.ts): its output to read (null once it has ended),
// its exit status, its input, and how to stop it. null: no such program.
const EMPTY = new Uint8Array(0);
function spawn(
  options: BeamOptions,
  program: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  notify: () => void,
) {
  const programs = options.programs ?? {};
  const base = program.split('/').pop()!;
  const run = programs[base] ?? programs[base.split('-')[0]] ?? programs['*']?.(base);
  if (!run) return null;
  const process = new Process();
  process.notify = notify;
  try {
    run(process, { args, cwd: cwd || env.PWD || '/', env, root: options.root });
  } catch (error) {
    process.write(`${program}: ${(error as Error).message}\n`);
    process.exit(1);
  }
  return {
    read(max: number): Uint8Array | null {
      const chunk = process.output[0];
      if (!chunk) return process.ended ? null : EMPTY;
      if (chunk.length <= max) {
        process.output.shift();
        return chunk;
      }
      process.output[0] = chunk.subarray(max);
      return chunk.subarray(0, max);
    },
    status: () => process.status ?? -1,
    write: (bytes: Uint8Array) => process.input.push(bytes),
    kill() {
      process.notify = null;
      process.closed = true;
      process.onclose?.();
    },
  };
}

// NIF libraries built to WebAssembly (playground/beam/host/wasm_nifs.c):
// each an instance as Rust-OTP's are (nif.ts), with a WASI of their own
// over the node's files. open answers an id, or why not.
function nifHost(options: BeamOptions) {
  let nifs: Nifs | null = null;
  const get = () => {
    nifs ??= new Nifs(
      new WASI({
        args: ['nif'],
        env: options.env,
        root: options.root,
        stdin: () => new Uint8Array(0),
        stdout: options.stdout,
        stderr: options.stderr,
        sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
        fetch: options.fs.fetch,
        shared: options.shared ?? null,
      }),
    );
    return nifs;
  };
  return {
    open(bytes: Uint8Array<ArrayBuffer>): number | string {
      const text = new TextDecoder().decode(get().create(bytes));
      return text.startsWith('error ') ? text.slice(6) : Number(text);
    },
    call: (id: number, request: Uint8Array) => get().call(id, request),
  };
}
