// uutils coreutils built to WebAssembly (coreutils/build.py): ls, cp, rm,
// … for the shell and the nodes, as an OS has them. One module holds them
// all; its first argument names the tool. Each run is an instance of its
// own over the node's files (wasi/), run to its end on the caller's thread:
// a node's port or the shell waits for it, as for a quick command.
import { WASI } from './wasi';
import type { Fetch } from './wasi/fs';
import { Process, type Program, type Programs } from './wasi/process';
import type { Shared } from './wasi/shared';
import { commands } from './sh';

// The tools in coreutils.wasm (uutils 0.12.0's feat_wasm: `coreutils --list`).
export const TOOLS = new Set(
  (
    'arch b2sum base32 base64 basename basenc cat cksum comm cp csplit cut date dd dir ' +
    'dircolors dirname echo expand expr factor false fmt fold head hostid join link ln ls ' +
    'md5sum mkdir mktemp mv nice nl nproc numfmt od paste pathchk pr printenv printf ptx pwd ' +
    'readlink realpath rm rmdir seq sha1sum sha224sum sha256sum sha384sum sha512sum shred shuf ' +
    'sleep sort split sum tail tee test touch tr true truncate tsort tty uname unexpand uniq ' +
    'unlink vdir wc yes'
  ).split(' '),
);

export interface CoreutilsOptions {
  // coreutils.wasm, compiled; null when the site has none.
  module: () => WebAssembly.Module | null;
  fetch: Fetch;
  shared: Shared | null;
  // The standard streams are a terminal's (the shell's), this wide.
  terminal?: () => number[] | null;
  // Where its errors go, if not with its output.
  stderr?: (bytes: Uint8Array) => void;
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The program for tool `name`, or undefined (not one, or no coreutils.wasm).
export function coreutils(options: CoreutilsOptions, name: string): Program | undefined {
  if (!TOOLS.has(name)) return undefined;
  return (process, { args, cwd, env, root }) => {
    const module = options.module();
    if (!module) {
      process.write(`${name}: not in this site (coreutils.wasm)\n`);
      return process.exit(127);
    }
    const size = options.terminal?.() ?? null;
    // What the node sent the program before it ran, then its end.
    const input = process.input.splice(0);
    const wasi = new WASI({
      args: [name, ...args],
      env: { ...env, PWD: cwd, ...(size ? { COLUMNS: String(size[0]) } : {}) },
      root,
      stdin: (max) => {
        const chunk = input[0];
        if (!chunk) return new Uint8Array(0);
        if (chunk.length <= max) return input.shift()!;
        input[0] = chunk.subarray(max);
        return chunk.subarray(0, max);
      },
      stdout: (bytes) => process.write(bytes.slice()),
      stderr: (bytes) => (options.stderr ?? process.write.bind(process))(bytes.slice()),
      sleep,
      tty: Boolean(size),
      fetch: options.fetch,
      shared: options.shared,
    });
    const instance = new WebAssembly.Instance(module, wasi.imports);
    process.exit(wasi.start(instance));
  };
}

// sh -c LINE: the page's sh (programs/node.ts, brush in a worker of its
// own) when there is one. Without (the Node harness), as far as coreutils
// runs it: its tools here, one after another while they succeed (&&),
// and cd.
export function shWith(options: CoreutilsOptions, page: Program | undefined): Program {
  return (process, context) => {
    if (page) return page(process, context);
    const [flag, line = ''] = context.args;
    const queue = flag === '-c' ? commands(line) : [];
    if (!queue.some((command) => TOOLS.has(command[0]))) {
      process.write('sh: only sh -c runs here\n');
      return process.exit(127);
    }
    let cwd = context.cwd;
    const next = (code: number): void => {
      const command = queue.shift();
      if (code !== 0 || !command) return process.exit(code);
      const [name, ...args] = command;
      if (!name) return next(0);
      if (name === 'cd') {
        cwd = join(cwd, args[0] ?? context.env.HOME ?? '/work');
        return next(0);
      }
      const tool = coreutils(options, name);
      if (tool) {
        const inner = new Process();
        tool(inner, { ...context, args, cwd });
        for (const bytes of inner.output) process.write(bytes);
        return next(inner.status ?? 1);
      }
      process.write(`sh: ${name}: not found in the playground\n`);
      return process.exit(127);
    };
    next(0);
  };
}

// The programs a node runs with coreutils': its tools by name, and sh.
export function withCoreutils(programs: Programs, options: CoreutilsOptions): Programs {
  const out = { ...programs } as Programs;
  out.sh = shWith(options, programs.sh);
  for (const name of TOOLS) out[name] ??= coreutils(options, name)!;
  return out;
}

function join(cwd: string, path: string): string {
  const out: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return '/' + out.join('/');
}
