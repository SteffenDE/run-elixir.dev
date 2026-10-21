// Node's node:wasi over the runtime's WASI (wasi/index.ts): WebAssembly
// programs and libraries (napi-rs's wasm32-wasi builds) on the shared
// files, which hold every path a project has (/work, /tmp, /home,
// /shared).
import { Exit, WASI as RuntimeWasi } from '../wasi';
import { Dir } from '../wasi/fs';
import type { SharedCall } from '../wasi/shared';

const PREFIXES = ['/work', '/tmp', '/home', '/shared'];

interface NodeWasiOptions {
  version?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  preopens?: Record<string, string>;
  returnOnExit?: boolean;
}

export function createWasi(
  call: SharedCall,
  write: (fd: number, bytes: Uint8Array) => void,
  end: (code: number) => never,
) {
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  class WASI {
    private wasi: RuntimeWasi;
    private returnOnExit: boolean;
    constructor(options: NodeWasiOptions = {}) {
      this.returnOnExit = options.returnOnExit ?? true;
      const env = Object.fromEntries(
        Object.entries(options.env ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      this.wasi = new RuntimeWasi({
        args: options.args ?? [],
        env,
        root: new Dir(),
        stdin: () => new Uint8Array(0),
        stdout: (bytes) => write(1, bytes.slice()),
        stderr: (bytes) => write(2, bytes.slice()),
        sleep,
        fetch: (source) => {
          throw new Error(`${source}: no such file`);
        },
        shared: { prefixes: PREFIXES, call },
      });
    }
    get wasiImport() {
      return this.wasi.imports.wasi_snapshot_preview1;
    }
    getImportObject() {
      return { wasi_snapshot_preview1: this.wasiImport };
    }
    // A command: its exit status (returnOnExit), else the process ends.
    start(instance: WebAssembly.Instance): number {
      const code = this.wasi.start(instance);
      if (!this.returnOnExit && code !== 0) end(code);
      return code;
    }
    // A reactor (a library): its _initialize, if it has one.
    initialize(instance: WebAssembly.Instance): void {
      this.wasi.memory = instance.exports.memory as WebAssembly.Memory;
      try {
        // oxlint-disable-next-line no-underscore-dangle -- WASI's name for a reactor's start.
        (instance.exports._initialize as (() => void) | undefined)?.();
      } catch (error) {
        if (!(error instanceof Exit)) throw error;
      }
    }
  }
  return { WASI };
}
