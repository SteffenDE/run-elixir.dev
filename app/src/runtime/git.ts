// git for the IDE itself (its changes view, the baseline commit): git.wasm
// as the shell has it, in a worker of its own over the project's files
// (files.js), with no node. One command at a time, its output whole; git's
// own locks (index.lock) are then never the IDE's own to race.
import { GIT_CONFIG, GIT_DASHED } from './git-remote';
import type { FilesChannel } from './host/files';
import { Processes, inputPipe, release, wasmProgram } from './processes';
import { ENV } from './setup';
import type { Descriptor } from './wasi/descriptors';
import { Dir, devnull, urandom } from './wasi/fs';
import { sharedClient } from './wasi/shared';

export interface GitStart {
  kind: 'start';
  files: FilesChannel;
  git: WebAssembly.Module;
}

export interface GitRun {
  kind: 'run';
  id: number;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: Uint8Array | null;
}

export interface GitResult {
  id: number;
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

// What files.js holds (worker/index.ts SHARED): the rest of the tree is this
// worker's own, and git needs little of it.
const SHARED = ['/work', '/tmp', '/home', '/shared'];

let processes: Processes | null = null;
const queue: GitRun[] = [];
let running = false;

const concat = (chunks: Uint8Array[]) => {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
};

// A stream that keeps what is written to it.
const collect = (chunks: Uint8Array[]): Descriptor => ({
  stream: true,
  sink: (bytes) => void chunks.push(bytes.slice()),
});

async function run({ id, args, cwd, env, stdin }: GitRun): Promise<GitResult> {
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  const input: Descriptor = inputPipe(stdin ?? new Uint8Array(0));
  const child = processes!.spawn({
    program: 'git',
    args,
    cwd,
    env: { ...ENV, ...env, PWD: cwd },
    stdio: [input, collect(out), collect(err)],
  });
  release(input);
  if (!child) return { id, code: 127, stdout: new Uint8Array(0), stderr: new Uint8Array(0) };
  // Reaped, so the table forgets it.
  const code = (await processes!.wait(child.pid, 0)) ?? 1;
  return { id, code, stdout: concat(out), stderr: concat(err) };
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const next = queue.shift()!;
    let result: GitResult;
    try {
      result = await run(next);
    } catch (error) {
      const message = new TextEncoder().encode(`git: ${String(error)}\n`);
      result = { id: next.id, code: 1, stdout: new Uint8Array(0), stderr: message };
    }
    postMessage(result, { transfer: [result.stdout.buffer, result.stderr.buffer] });
  }
  running = false;
}

onmessage = ({ data }: MessageEvent<GitStart | GitRun>) => {
  if (data.kind === 'start') {
    const root = new Dir();
    for (const dir of [...SHARED.map((path) => path.slice(1)), 'home/user']) root.mkdirs(dir);
    // git's templates (setup.ts prepare): init warns without the directory.
    root.mkdirs('usr/share/git-core/templates');
    root.put('dev/urandom', urandom());
    root.put('dev/null', devnull());
    const shared = {
      prefixes: SHARED,
      call: sharedClient(data.files.doorbell, data.files.channel),
    };
    // Nothing is lazily mounted here: every file git reads is files.js's.
    const fetch = () => new Uint8Array(0);
    processes = new Processes((program) => {
      const name = program.split('/').pop()!;
      if (name !== 'git' && !GIT_DASHED.has(name)) return null;
      return wasmProgram(processes!, data.git, {
        root,
        fetch,
        shared,
        argv0: name,
        defaults: { GIT_PAGER: 'cat', ...GIT_CONFIG },
      });
    });
    return;
  }
  queue.push(data);
  void drain();
};
