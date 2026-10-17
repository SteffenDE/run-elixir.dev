// A node on the Emscripten BEAM in this worker (a build for
// PLAYGROUND_RUNTIME=otp, runtime.json): beam/run.ts with the page's
// frames, which Rust-OTP's node reads as it runs (channel.pump in its WASI
// calls). This one runs in threads of its own, whose file and network
// calls this worker serves, so the frames are taken here as they come
// (Atomics.waitAsync on the ring's write count) and the worker never
// blocks while the node runs.
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
  stdout: (bytes: Uint8Array) => void;
}

// Atomics.waitAsync (ES2024; not in the library this targets).
const waitAsync = (
  Atomics as unknown as {
    waitAsync?: (
      array: Int32Array,
      index: number,
      value: number,
      timeout: number,
    ) => { async: boolean; value: Promise<string> | string };
  }
).waitAsync;

// Until the node halts (its status) or Ctrl+C stops it (130).
export async function runBeam(run: BeamRun): Promise<number> {
  const { channel } = run;
  const node = startBeam({
    module: run.module,
    args: beamArgs(run.argv, run.env.HOME),
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
    stderr: run.stdout,
    memory: run.memory ?? undefined,
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
    if (channel.interrupted) {
      channel.interrupted = false;
      channel.input = [];
      status = 130;
      node.kill(130);
    }
  };
  const control = channel.control;
  const watch = async () => {
    while (watching.on) {
      take();
      const seen = Atomics.load(control, 0);
      if (waitAsync) {
        const wait = waitAsync(control, 0, seen, 1000);
        if (wait.async) await wait.value;
      } else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  void watch();
  try {
    const exit = await node.done;
    return status ?? exit;
  } finally {
    watching.on = false;
    Atomics.notify(control, 0);
  }
}
