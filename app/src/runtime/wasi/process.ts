// The node's child processes (/.proc/spawn): the programs that run them,
// as the host has them, and the terminal the node may set to raw input.
import { E } from './abi';
import type { Dir } from './fs';
import type { Descriptor } from './descriptors';
import type { WASI } from '.';

// A program the host runs for the node (crates/rotp/src/host/wasm_proc.rs):
// what it wrote, whether its output has ended, its exit status, and its
// input.
export class Process {
  declare output: Uint8Array[];
  declare ended: boolean;
  declare status: number | null;
  declare input: Uint8Array[];
  declare closed: boolean;
  // How much of what was sent it the page's program took (TAKEN frames).
  declare taken: number;
  // The node closed its port.
  declare onclose?: () => void;
  // What the node sends the program, as it comes; without it, `input`
  // keeps it.
  declare oninput?: (bytes: Uint8Array) => void;
  // Told when the program writes or exits (the Emscripten BEAM's ports:
  // beam/host/spawn.js).
  declare notify?: (() => void) | null;

  constructor() {
    this.output = [];
    this.ended = false;
    this.status = null;
    this.input = [];
    this.closed = false;
    this.taken = 0;
  }
  write(bytes: string | Uint8Array): void {
    this.output.push(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
    this.notify?.();
  }
  exit(status: number): void {
    this.ended = true;
    this.status = status;
    this.notify?.();
  }
}

// A program the node may spawn (wasm_proc.rs).
export interface ProgramContext {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  root: Dir;
  // The node's memory, where the program may look (memsup).
  memory?: WebAssembly.Memory;
}
export type Program = (process: Process, context: ProgramContext) => void;
// '*': a program for any other name, or none.
export type Programs = Record<string, Program> & { '*'?: (name: string) => Program | undefined };

// The terminal the node may set to raw input (/.tty).
export interface Terminal {
  mode(mode: string): void;
  size(): number[];
}

// A spawn request (wasm_proc.rs): run the program it names.
export function spawn(wasi: WASI, entry: Descriptor, bytes: Uint8Array): number | null {
  const fields = new TextDecoder().decode(bytes.slice()).split('\0');
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
  // By base name, or its first part: _build/esbuild-linux-x64 is esbuild.
  const base = program.split('/').pop()!;
  const run =
    wasi.programs[base] ?? wasi.programs[base.split('-')[0]] ?? wasi.programs['*']?.(base);
  if (!run) return E.NOENT;
  const process = new Process();
  entry.process = process;
  try {
    run(process, { args, cwd: cwd || env.PWD || '/', env, root: wasi.root });
  } catch (error) {
    process.write(`${program}: ${(error as Error).message}\n`);
    process.exit(1);
  }
  return null;
}
