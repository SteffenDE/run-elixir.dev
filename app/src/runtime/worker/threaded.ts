import { Exit, type WASI } from '../wasi';
import { channel as threadChannel, Host } from '../threads';

// A threaded node's memory: shared, and as large as it may grow here (a
// shared memory reserves its maximum up front, which a phone may not
// have room for), or null where there is no shared memory: the node then
// runs single-threaded (rotp.wasm).
export function sharedMemory(): WebAssembly.Memory | null {
  if (!globalThis.crossOriginIsolated) return null;
  for (const maximum of [65536, 32768, 16384]) {
    try {
      return new WebAssembly.Memory({ initial: 1024, maximum, shared: true });
    } catch {
      // Too large a reservation: a smaller one.
    }
  }
  return null;
}

// How many schedulers a threaded node runs.
export const SCHEDULERS = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1));
let nodes = 0;

// A threaded node: the page runs its threads in workers (host.ts), which
// this worker serves WASI calls for until the node ends; then the page
// stops them.
export function runThreaded(
  wasi: WASI,
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  pump: () => void,
): number {
  wasi.memory = memory;
  const node = ++nodes;
  const chan = threadChannel();
  const names = Object.keys(wasi.imports.wasi_snapshot_preview1);
  const start = (tid: number, startArg: number) =>
    postMessage({
      kind: 'thread',
      node,
      start: { module, memory, chan, slot: tid, names, tid, startArg },
    });
  const host = new Host(wasi, chan, { spawn: start });
  start(0, 0);
  try {
    for (;;) {
      const status = host.wait(5);
      if (status !== null) return status;
      pump();
    }
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  } finally {
    postMessage({ kind: 'threads-end', node });
  }
}
