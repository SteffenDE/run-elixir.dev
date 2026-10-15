// NIF libraries for the node (/.nif, BeamOS.Nif): WebAssembly modules built
// against playground/nif's erl_nif, each in an instance of its own beside
// the node, with its own memory. The node's WASI serves them too: while a
// library runs, the WASI calls work on its memory, so it reads the node's
// files and environment and writes to its terminal.
import { Exit, type Syscall, type WASI } from './wasi';

// What a library exports (playground/nif's erl_nif).
interface Library {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  beamos_nif_input(length: number): number;
  beamos_nif_run(length: number): number;
  beamos_nif_output(): number;
}

// {error, Reason} as an external term, Reason a binary.
function failure(message: string): Uint8Array {
  const text = new TextEncoder().encode(message);
  const out = new Uint8Array(15 + text.length);
  out.set([131, 104, 2, 119, 5, ...new TextEncoder().encode('error'), 109]);
  new DataView(out.buffer).setUint32(11, text.length);
  out.set(text, 15);
  return out;
}

// The node's WASI for a library, with the functions it imports that
// wasi.ts lacks answering ENOSYS: such a library loads, and only a call
// that needs one fails.
const ENOSYS = 52;

function wasiFor(
  module: WebAssembly.Module,
  wasi: Record<string, Syscall>,
): Record<string, Syscall> {
  const missing = WebAssembly.Module.imports(module)
    .filter(
      ({ module: name, kind, name: fn }) =>
        name === 'wasi_snapshot_preview1' && kind === 'function' && !(fn in wasi),
    )
    .map(({ name }): [string, Syscall] => [name, () => ENOSYS]);
  return missing.length ? { ...wasi, ...Object.fromEntries(missing) } : wasi;
}

export class Nifs {
  declare wasi: WASI;
  declare instances: Map<number, WebAssembly.Instance>;
  declare next: number;

  constructor(wasi: WASI) {
    this.wasi = wasi;
    this.instances = new Map();
    this.next = 1;
  }

  // While `run` runs, the node's WASI works on the library's memory.
  within<T>(instance: WebAssembly.Instance, run: () => T): T {
    const saved = this.wasi.memory;
    this.wasi.memory = instance.exports.memory as WebAssembly.Memory;
    try {
      return run();
    } finally {
      this.wasi.memory = saved;
    }
  }

  // /.nif/new: the request is a library's bytes, the answer its id.
  create(bytes: Uint8Array<ArrayBuffer>): Uint8Array {
    try {
      const module = new WebAssembly.Module(bytes);
      const instance = new WebAssembly.Instance(module, {
        wasi_snapshot_preview1: wasiFor(module, this.wasi.imports.wasi_snapshot_preview1),
      });
      // oxlint-disable-next-line no-underscore-dangle -- WASI's name for a library's start.
      this.within(instance, () => (instance.exports as unknown as Library)._initialize?.());
      const id = this.next++;
      this.instances.set(id, instance);
      return new TextEncoder().encode(String(id));
    } catch (error) {
      return new TextEncoder().encode(`error ${(error as Error).message}`);
    }
  }

  // /.nif/ID: a request (an external term) to the library, its answer.
  call(id: number, request: Uint8Array): Uint8Array {
    const instance = this.instances.get(id);
    if (!instance) return failure('no such NIF library');
    try {
      return this.within(instance, () => {
        const { memory, beamos_nif_input, beamos_nif_run, beamos_nif_output } =
          instance.exports as unknown as Library;
        new Uint8Array(memory.buffer, beamos_nif_input(request.length) >>> 0, request.length).set(
          request,
        );
        const size = beamos_nif_run(request.length);
        return new Uint8Array(memory.buffer, beamos_nif_output() >>> 0, size >>> 0).slice();
      });
    } catch (error) {
      // A trap or an abort leaves the library unusable.
      this.instances.delete(id);
      if (error instanceof Exit) return failure(`the NIF library exited (${error.code})`);
      if (error instanceof WebAssembly.RuntimeError)
        return failure(`the NIF library crashed: ${error.message}`);
      throw error;
    }
  }

  // An open /.nif file's answer, once its request is in.
  answer(target: string, request: Uint8Array<ArrayBuffer>): Uint8Array {
    return target === 'new' ? this.create(request) : this.call(Number(target), request);
  }
}
