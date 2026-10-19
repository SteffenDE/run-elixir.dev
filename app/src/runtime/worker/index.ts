// A playground node in a Web Worker: the Emscripten BEAM (beam.ts), as one
// command or under the terminal's shell. host/ is the page's side: frames
// come in through its SharedArrayBuffer ring (the worker sleeps on the
// ring's write count, so a frame wakes it) and everything goes back as
// messages.
//
// The shell is brush (brush.ts). It runs each node command (elixir, iex,
// mix, erl) as a fresh instance over the same filesystem, as a Unix shell
// runs processes; the page's programs (git, …) run as they would for a
// node, and coreutils' tools in the worker. Ctrl+C (an interrupt frame)
// is a node's SIGINT (erts' break menu) and stops a program; a terminate
// frame stops either at once. With `files`, /work and /tmp are files.js's, which
// every shell (each in its own worker) and the page share.
import {
  Dir,
  File,
  untar,
  untarInto,
  mount,
  bundled,
  fetchBundle,
  type Manifest,
} from '../wasi/fs';
import { Network } from '../wasi/net';
import { sharedClient, type Shared } from '../wasi/shared';
import { ENV, prepare, programs } from '../setup';
import { vfs } from '../vfs';
import { words } from '../sh';
import type { NifSource } from '../programs';
import type { FilesChannel } from '../host/files';
import { Channel, onPage } from './channel';
import { Process } from '../wasi/process';
import { backendNif, get, siteNif } from './nif';
import { brush, type Run } from './brush';
import { TOOLS, coreutils, withCoreutils, type CoreutilsOptions } from '../coreutils';
import { runtime, setRuntime } from './site';
import { SCHEDULERS, runBeam, sharedMemory } from './beam';

// A WebAssembly module from the site, compiled; null when the site has none
// (it answers with its page).
async function loadModule(url: URL): Promise<WebAssembly.Module | null> {
  const response = await fetch(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok || bytes[0] !== 0 || bytes[1] !== 0x61) return null;
  return WebAssembly.compile(bytes);
}

// What the page starts a node with (host/node.ts Node.start).
interface Start {
  shared: SharedArrayBuffer;
  // Where the BEAM, the files and the NIF libraries are.
  runtime: string;
  files: FilesChannel | null;
  shell: boolean;
  args?: string[];
  command?: string[];
  env: Record<string, string>;
  ports: number[];
  https?: boolean;
  initial?: string[];
  pagePrograms?: string[];
  cwd?: string;
  boots?: string[];
  // What the page has of them already (host/node.ts Node.start): the boot
  // images gunzipped, the manifest, brush.wasm and coreutils.wasm compiled.
  images?: ArrayBuffer[];
  manifest?: Manifest;
  brush?: WebAssembly.Module;
  coreutils?: WebAssembly.Module;
}

const SHARED = ['/work', '/tmp', '/home'];
const say = (kind: string, payload: unknown) => postMessage({ kind, payload });
const text = (string: string) => say('out', new TextEncoder().encode(string));

function join(cwd: string, path: string): string {
  const parts = (path.startsWith('/') ? path : `${cwd}/${path}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return '/' + out.join('/');
}

// Elixir's launchers' command lines (bin/elixir, bin/iex, bin/mix), and
// escript's (bin/escript, with the flags of the script's %%! line). The Hex
// esbuild and tailwind packages run the page's programs (their :path,
// unless a project's config sets one), so no project downloads them.
const ELIXIR = [
  '-noshell',
  '-elixir_root',
  '/rotp/lib',
  '-pa',
  '/rotp/lib/elixir/ebin',
  '-esbuild',
  'path',
  '<<"/usr/bin/esbuild">>',
  '-tailwind',
  'path',
  '<<"/usr/bin/tailwind">>',
];
// bin/elixir's options, up to the first argument that is none: those for
// erl (--sname a, --cookie c, --hidden, --erl "flags", …) as erl's, and
// the others, with what follows, for Elixir's CLI.
const ELIXIR_TAKES: Record<string, number> = {
  '+elixirc': 0,
  '+iex': 0,
  '-v': 0,
  '--no-halt': 0,
  '--color': 0,
  '--no-color': 0,
  '-e': 1,
  '-r': 1,
  '-pr': 1,
  '-pa': 1,
  '-pz': 1,
  '--eval': 1,
  '--remsh': 1,
  '--dot-iex': 1,
  '--dbg': 1,
  '--rpc-eval': 2,
};
function launcher(args: string[]): { erl: string[]; cli: string[] } {
  const erl: string[] = [];
  const cli: string[] = [];
  let i = 0;
  while (i < args.length) {
    const [arg, value] = [args[i], args[i + 1]];
    if (arg in ELIXIR_TAKES) {
      cli.push(...args.slice(i, i + 1 + ELIXIR_TAKES[arg]));
      i += 1 + ELIXIR_TAKES[arg];
    } else if (arg === '--hidden') {
      erl.push('-hidden');
      i += 1;
    } else if (arg === '--erl' && value !== undefined) {
      erl.push(...words(value));
      i += 2;
    } else if ((arg === '--sname' || arg === '--name') && value !== undefined) {
      erl.push(arg.slice(1), value);
      i += 2;
    } else if (arg === '--cookie' && value !== undefined) {
      erl.push('-setcookie', value);
      i += 2;
    } else if (arg === '--boot' && value !== undefined) {
      erl.push('-boot', value);
      i += 2;
    } else if (arg === '--erl-config' && value !== undefined) {
      erl.push('-config', value);
      i += 2;
    } else if (
      (arg === '--logger-otp-reports' || arg === '--logger-sasl-reports') &&
      value !== undefined
    ) {
      if (value === 'true' || value === 'false')
        erl.push('-logger', `handle_${arg.slice(9, -8)}_reports`, value);
      i += 2;
    } else break;
  }
  return { erl, cli: [...cli, ...args.slice(i)] };
}

// The project's cookie (PLAYGROUND_COOKIE, from the page) for a node whose
// command line names none, so that the project's nodes connect.
function cookie(argv: string[], env: Record<string, string>): string[] {
  const project = env.PLAYGROUND_COOKIE;
  return project && !argv.includes('-setcookie') ? ['-setcookie', project] : [];
}

// An escript's %%! line (its second or third), as erl's flags: Mix
// puts `-escript main MODULE` there, and an app its own (Livebook its
// -epmd_module).
function escriptFlags(script: Uint8Array | null): string[] {
  if (!script) return [];
  const head = new TextDecoder().decode(script.subarray(0, 4096)).split('\n').slice(1, 3);
  const line = head.find((l) => l.startsWith('%%!'));
  return line ? words(line.slice(3).trim()) : [];
}

// read(path): a file's bytes, or null (an escript's, for its %%! line).
function command(
  name: string,
  args: string[],
  read: (path: string) => Uint8Array | null = () => null,
): string[] | null {
  switch (name) {
    case 'erl':
      return args;
    case 'elixir': {
      const { erl, cli } = launcher(args);
      return [...ELIXIR, ...erl, '-s', 'elixir', 'start_cli', '-extra', ...cli];
    }
    case 'mix': {
      const { erl, cli } = launcher(args);
      return [...ELIXIR, ...erl, '-s', 'elixir', 'start_cli', '-extra', '/rotp/bin/mix', ...cli];
    }
    case 'iex': {
      const { erl, cli } = launcher(args);
      // iex -S mix ARGS runs Mix's script under IEx.
      const rest = cli[0] === '-S' && cli[1] === 'mix' ? ['/rotp/bin/mix', ...cli.slice(2)] : cli;
      return [...ELIXIR, ...erl, '-user', 'elixir', '-extra', '--no-halt', '+iex', ...rest];
    }
    case 'escript':
      if (!args.length) return null;
      return [
        '+B',
        '-noshell',
        '-boot',
        '/rotp/bin/no_dot_erlang',
        ...escriptFlags(read(args[0])),
        '-run',
        'escript',
        'start',
        '-extra',
        ...args,
      ];
  }
  return null;
}

// What `help` and a new shell say.
const HELP = `Commands: iex, elixir, mix, erl (each runs OTP), git (clone, pull),
and coreutils' ls, cp, mv, rm, cat, sort, wc, …, in a bash-like shell:
pipes, redirections, $(…), loops. Tab completes, Up recalls, Ctrl+R
searches. Ctrl+C: a node's break menu (a aborts), a program stops.
help NAME: a shell built-in.
`;

// boots: the boot images (fs/NAME.tar.gz) to unpack, the site's first
// commands' files (build.py). command: one command by name, as the shell
// runs it (['mix', 'deps.get']), in place of erl's `args`.
onmessage = async ({
  data: {
    shared,
    runtime: runtimeUrl,
    files,
    shell,
    args,
    command: named,
    env,
    ports,
    https = false,
    initial = [],
    pagePrograms = [],
    cwd: start = '/work',
    boots = ['boot'],
    images: tars,
    manifest: listed,
    brush: shellModule,
    coreutils: toolsModule,
  },
}: MessageEvent<Start>) => {
  setRuntime(runtimeUrl);
  try {
    say('status', 'Loading OTP and Elixir…');
    // The emulator (beam.mjs) loads itself as a node starts.
    const [images, manifest, brushModule] = await Promise.all([
      tars ??
        Promise.all(
          boots.map((boot) => fetch(runtime(`fs/${boot}.tar.gz`)).then((r) => r.arrayBuffer())),
        ),
      listed ?? fetch(runtime('fs/manifest.json')).then((r) => r.json() as Promise<Manifest>),
      // The shell (brush.ts), if the site has it.
      shellModule ?? (shell ? loadModule(runtime('brush.wasm')) : null),
    ]);
    // What files.js holds stays out of this worker's tree.
    const local = (path: string) =>
      !files || !SHARED.some((prefix) => `/${path}`.startsWith(`${prefix}/`));
    const root = new Dir();
    mount(
      manifest.filter(([path]) => local(path)),
      root,
    );
    for (const image of images) {
      if (tars) untarInto(new Uint8Array(image), root, local);
      else await untar(new Uint8Array(image), root, local);
    }
    prepare(root);
    const sharedFs: Shared | null = files
      ? { prefixes: SHARED, call: sharedClient(files.doorbell, files.channel) }
      : null;
    const channel = new Channel(shared);
    // Lazily mounted files come in bundles (fs/bundles/N.tar).
    const fetchFile = bundled((bundle) => fetchBundle(runtime(`fs/bundles/${bundle}.tar`)));
    const fs = vfs(root, fetchFile, sharedFs);
    // A package's NIF library built to WebAssembly (programs.ts make): the
    // site's (nif/NAME-VERSION.tar), else the backend's (/api/nif/, on this
    // origin, which may have to build it first: docs/backend.md).
    const nif: NifSource = (name, version, report) =>
      siteNif(name, version) ?? backendNif(channel, name, version, report);
    // coreutils.wasm (coreutils.ts): the page's, else fetched and compiled
    // once a tool first runs; null when the site has none.
    let compiled: WebAssembly.Module | null | undefined = toolsModule;
    const module = () => {
      if (compiled === undefined) {
        const [status, bytes] = get(runtime('coreutils.wasm'));
        const wasm = status === 200 && bytes?.[0] === 0 && bytes[1] === 0x61;
        compiled = wasm ? new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>) : null;
      }
      return compiled;
    };
    const tools: CoreutilsOptions = { module, fetch: fetchFile, shared: sharedFs };

    // One node, until it halts or is interrupted.
    // extra: a command line's NAME=value assignments, for it alone.
    // stdout: where its output goes, the terminal's by default.
    const run = async (
      argv: string[],
      cwd: string,
      extra: Record<string, string> = {},
      stdout: (bytes: Uint8Array) => void = (bytes) => say('out', bytes),
    ): Promise<number> => {
      const vars = { ...env, ...extra };
      const network = new Network({
        ports,
        https,
        open: (id, port, host) => postMessage({ kind: 'net', op: 'open', id, port, host }),
        send: (id, payload) => postMessage({ kind: 'net', op: 'data', id, payload }),
        end: (id) => postMessage({ kind: 'net', op: 'end', id }),
        close: (id) => postMessage({ kind: 'net', op: 'close', id }),
        listening: (port, on, ephemeral = false) =>
          postMessage({ kind: 'listening', port, on, ephemeral }),
      });
      channel.network = network;
      network.peers = channel.peers;
      channel.interrupted = false;
      channel.terminated = false;
      try {
        return await runBeam({
          module: runtime('beam.mjs').href,
          argv: ['+S', String(SCHEDULERS), ...cookie(argv, vars), ...argv],
          env: { ...ENV, ...vars, PWD: cwd },
          cwd,
          root,
          fetch: fetchFile,
          shared: sharedFs,
          network,
          programs: withCoreutils(
            {
              ...programs(fs, nif),
              ...Object.fromEntries(pagePrograms.map((name) => [name, onPage(channel, name)])),
            },
            tools,
          ),
          channel,
          memory: sharedMemory(),
          stdout,
        });
      } finally {
        channel.interrupted = false;
        channel.terminated = false;
        channel.mode(false);
        channel.network = null;
        for (const port of network.listeners.keys())
          postMessage({ kind: 'listening', port, on: false });
        for (const id of network.endpoints.keys()) postMessage({ kind: 'net', op: 'close', id });
      }
    };

    // A page program (git, tailwind, …) the shell runs, until it exits or
    // Ctrl+C stops it.
    const runOnPage = (
      name: string,
      args: string[],
      cwd: string,
      vars: Record<string, string> = env,
      out: (bytes: Uint8Array) => void = (bytes) => say('out', bytes),
    ): number => {
      const process = new Process();
      onPage(channel, name)(process, { args, cwd, env: { ...ENV, ...vars, PWD: cwd }, root });
      for (;;) {
        channel.pump();
        for (const bytes of process.output.splice(0)) out(bytes);
        if (process.ended) return process.status ?? 1;
        if (channel.interrupted || channel.terminated) {
          channel.interrupted = false;
          channel.terminated = false;
          channel.input = [];
          process.onclose?.();
          return 130;
        }
        channel.sleep(1000);
      }
    };

    say('status', 'running');
    if (!shell) {
      const cwd = env.PWD || start;
      const argv = named
        ? command(named[0], named.slice(1), (path) => fs.read(join(cwd, path)))
        : args;
      if (!argv) {
        text(`${named![0]}: command not found\n`);
        say('exit', 127);
        return;
      }
      say('exit', await run(argv, cwd));
      return;
    }
    // The terminal's shell: brush (brush.ts), which the site has.
    if (!brushModule) throw new Error('the site has no shell (brush.wasm: brush/build.py)');
    const cwd = fs.stat(start)?.dir ? start : '/work';
    if (!initial.length) text(HELP);
    // What brush runs (brush.ts): a node command (or an escript), a page
    // program, or a coreutils tool.
    const external: Run = async (program, given, at, vars, io) => {
      const name = program.split('/').pop()!;
      const read = (path: string) => fs.read(join(at, path));
      const head = program.startsWith('/') ? fs.read(program)?.subarray(0, 64) : null;
      const argv =
        command(name, given, read) ??
        (head && /^#!.*\bescript\b/.test(new TextDecoder().decode(head))
          ? command('escript', [program, ...given], read)
          : null);
      if (argv) {
        const status = await run(argv, at, vars, io.stdout ?? undefined);
        if (status === 130) text('\n');
        return status;
      }
      if (pagePrograms.includes(name))
        return runOnPage(name, given, at, vars, io.stdout ?? undefined);
      if (TOOLS.has(name) && module()) {
        const tool = coreutils(
          {
            ...tools,
            terminal: io.stdout ? undefined : () => channel.size,
            stderr: io.stderr ?? undefined,
          },
          name,
        )!;
        const process = new Process();
        if (io.input) process.input.push(io.input);
        tool(process, { args: given, cwd: at, env: vars, root });
        for (const bytes of process.output) (io.stdout ?? ((b) => say('out', b)))(bytes);
        return process.status ?? 1;
      }
      return null;
    };
    // Its prompt (the directory, ~ for $HOME); its directory, as WASI has
    // none (brush starts in /, and sets PWD so); and `help`, the
    // playground's (brush's `help NAME` for a built-in).
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const rc = [
      "__home='~'",
      // oxlint-disable-next-line no-template-curly-in-string -- the shell's ${…}.
      "PS1='\\[\\e[1;35m\\]${PWD/#$HOME/$__home}\\[\\e[0m\\] $ '",
      'help() { if [ $# -eq 0 ]; then cat /etc/playground-help; else builtin help "$@"; fi; }',
      `cd ${quote(cwd)}`,
    ];
    root.put('etc/brushrc', new File(new TextEncoder().encode(rc.join('\n') + '\n')));
    root.put('etc/playground-help', new File(new TextEncoder().encode(HELP)));
    for (;;) {
      await brush({
        module: brushModule,
        args: ['--rcfile', '/etc/brushrc', '--noprofile', '--enable-highlighting', '-i'],
        env: { ...ENV, ...env, PWD: cwd },
        root,
        fetch: fetchFile,
        shared: sharedFs,
        // A line for what reads the terminal while brush's line editor
        // does not (`read`, as typed).
        line: () => channel.line(),
        out: (bytes) => say('out', bytes),
        terminal: {
          raw: (on) => channel.mode(on),
          size: () => channel.size,
          read: (max, timeout) => {
            // The page's first commands, as if typed.
            const first = initial.shift();
            if (first !== undefined) return new TextEncoder().encode(`${first}\r`);
            const deadline = timeout < 0 ? Infinity : performance.now() + timeout;
            const [columns, rows] = channel.size;
            for (;;) {
              channel.pump();
              if (channel.size[0] !== columns || channel.size[1] !== rows) return null;
              // Ctrl+C, which the page sends as an interrupt.
              if (channel.interrupted) {
                channel.interrupted = false;
                channel.input = [];
                return Uint8Array.of(3);
              }
              // Nothing runs to stop.
              channel.terminated = false;
              const bytes = channel.take(max);
              // Enter: a newline is Ctrl+J to raw input.
              if (bytes.length) return bytes.map((byte) => (byte === 10 ? 13 : byte));
              const left = deadline - performance.now();
              if (left <= 0) return new Uint8Array(0);
              channel.sleep(Math.min(left, 1000));
            }
          },
        },
        run: external,
      });
      text('The shell exited; a new one starts.\n');
    }
  } catch (error) {
    say('status', `failed: ${(error as Error).stack || error}`);
  }
};
