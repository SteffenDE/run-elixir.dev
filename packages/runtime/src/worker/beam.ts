// A node on the Emscripten BEAM in this worker: beam/run.ts with the
// page's frames. It runs in threads of its own, whose file and network
// calls this worker serves, so the frames are taken here as they come
// (Channel.rest) and the worker never blocks while the node runs.
import { beamArgs } from '../beam/args';
import { startBeam } from '../beam/run';
import { TreeFs } from '../beam/treefs';
import type { Dir, Fetch } from '../wasi/fs';
import type { Network } from '../wasi/net';
import type { Programs } from '../wasi/process';
import type { Shared } from '../wasi/shared';
import type { Channel } from './channel';

export interface BeamRun {
  module: string;
  // OTP's root in the tree (Site.otp): erl's -root.
  root_otp: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  root: Dir;
  fetch: Fetch;
  shared: Shared | null;
  network: Network;
  programs: Programs;
  channel: Channel;
  memory: WebAssembly.Memory | null;
  // beam.wasm compiled on the page, if it was.
  wasm?: WebAssembly.Module;
  stdout: (bytes: Uint8Array) => void;
  // Its standard error (default: stdout).
  stderr?: (bytes: Uint8Array) => void;
}

// The node's memory: shared, and as large as it may grow here (a shared
// memory reserves its maximum up front, which a phone may not have room
// for), or null where there is no shared memory.
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

// How many schedulers a node runs.
export const SCHEDULERS = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1));

// Until the node halts (its status) or Ctrl+C stops it (130).
export async function runBeam(run: BeamRun): Promise<number> {
  const { channel } = run;
  const node = startBeam({
    module: run.module,
    args: beamArgs(run.argv, { home: run.env.HOME, root: run.root_otp }),
    env: { ...run.env, ERL_INETRC: '/etc/inetrc' },
    cwd: run.cwd,
    root: run.root,
    fs: new TreeFs(run.root, run.fetch),
    shared: run.shared,
    network: run.network,
    programs: run.programs,
    // A port no program listens on (one below Network's ephemeral ones).
    httpsGateway: 49151,
    tty: true,
    size: [channel.size[0], channel.size[1]],
    onMode: (raw) => channel.mode(raw),
    stdout: run.stdout,
    stderr: run.stderr ?? run.stdout,
    memory: run.memory ?? undefined,
    wasm: run.wasm,
  });
  // Cleared once the node has halted.
  const watching = { on: true };
  let size = channel.size;
  let status: number | null = null;
  // The page's frames, as they come.
  const take = () => {
    channel.pump();
    if (channel.input.length) node.input(channel.take(Infinity));
    if (channel.size !== size) {
      size = channel.size;
      node.resize(size[0], size[1]);
    }
    // Ctrl+C: SIGINT, as a terminal sends it (erts' break menu); before
    // the node is there, it stops.
    if (channel.interrupted) {
      channel.interrupted = false;
      if (!node.signal(2)) channel.terminated = true;
    }
    if (channel.terminated) {
      channel.terminated = false;
      channel.input = [];
      status = 130;
      node.kill(130);
    }
  };
  const watch = async () => {
    while (watching.on) {
      take();
      // Until the page writes a frame (one written since take() wakes it
      // at once).
      await channel.rest(1000);
    }
  };
  void watch();
  try {
    const exit = await node.done;
    return status ?? exit;
  } finally {
    watching.on = false;
    // The watch's rest ends at once.
    Atomics.notify(channel.control, 0);
  }
}
