// A playground node in a Web Worker: the Emscripten BEAM (beam.ts), as one
// command or under a small shell. host/ is the page's side: frames come
// in through its SharedArrayBuffer ring (the worker sleeps on the ring's
// write count, so a frame wakes it) and everything goes back as messages.
//
// The shell runs each node command (elixir, iex, mix, erl) as a fresh
// instance over the same filesystem, as a Unix shell runs processes, and
// has the few builtins a playground needs; the page's programs (git, …)
// run as they would for a node. Ctrl+C (an interrupt frame) stops the
// node or the program. With `files`, /work and /tmp are files.js's, which
// every shell (each in its own worker) and the page share.
import { Dir, File, untar, mount, bundled, fetchBundle, type Manifest } from '../wasi/fs';
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

// What the shell does itself, coreutils.wasm or not.
const SHELL_BUILTINS = new Set(['help', 'pwd', 'echo', 'clear', 'cd']);

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

// A command that is an escript on PATH (mix escript.install's, in
// $MIX_HOME/escripts), as a shell finds it: escript's command line for it.
function escriptOnPath(
  name: string,
  args: string[],
  env: Record<string, string>,
  read: (path: string) => Uint8Array | null,
): string[] | null {
  if (name.includes('/')) return null;
  for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
    const path = `${dir}/${name}`;
    const head = read(path)?.subarray(0, 64);
    if (head && new TextDecoder().decode(head).match(/^#!.*\bescript\b/))
      return command('escript', [path, ...args], read);
  }
  return null;
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

const HELP = `Commands: iex, elixir, mix, erl (each runs OTP), git (clone,
pull), coreutils' ls, cp, mv, rm, mkdir, cat, head, tail, sort, wc, … and
cd, pwd, echo, clear, help. Ctrl+C stops what is running.
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
  },
}: MessageEvent<Start>) => {
  setRuntime(runtimeUrl);
  try {
    say('status', 'Loading OTP and Elixir…');
    // The emulator (beam.mjs) loads itself as a node starts.
    const [images, manifest, brushModule] = await Promise.all([
      Promise.all(
        boots.map((boot) => fetch(runtime(`fs/${boot}.tar.gz`)).then((r) => r.arrayBuffer())),
      ),
      fetch(runtime('fs/manifest.json')).then((r) => r.json() as Promise<Manifest>),
      // The shell (brush.ts), if the site has it.
      shell ? loadModule(runtime('brush.wasm')) : null,
    ]);
    // What files.js holds stays out of this worker's tree.
    const local = (path: string) =>
      !files || !SHARED.some((prefix) => `/${path}`.startsWith(`${prefix}/`));
    const root = new Dir();
    mount(
      manifest.filter(([path]) => local(path)),
      root,
    );
    for (const image of images) await untar(new Uint8Array(image), root, local);
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
    // coreutils.wasm (coreutils.ts), fetched and compiled once a tool
    // first runs; null when the site has none.
    let compiled: WebAssembly.Module | null | undefined;
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
        if (channel.interrupted) {
          channel.interrupted = false;
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
    let cwd = fs.stat(start)?.dir ? start : '/work';
    if (!initial.length) text(HELP);
    if (brushModule) {
      // What brush runs (brush.ts): a node command as this shell ran it, a
      // page program, or a coreutils tool.
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
      // The page's first commands, as if typed.
      const typed = (more: boolean) => {
        const first = initial.shift();
        if (first === undefined) {
          if (more) text('> ');
          return channel.line();
        }
        text(`${more ? '> ' : ''}${first}\n`);
        return first;
      };
      // A line ending in \ goes on in the next, which brush's line reader
      // (without readline) does not do itself.
      const line = () => {
        let whole = typed(false);
        while (whole !== null && whole.endsWith('\\')) {
          const more = typed(true);
          whole = more === null ? null : `${whole.slice(0, -1)} ${more}`;
        }
        return whole;
      };
      // Its prompt, as the playground's shell had it (the directory, ~ for
      // $HOME), and its directory: WASI has none, so brush starts in / (and
      // sets PWD so).
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      const rc = [
        "__home='~'",
        // oxlint-disable-next-line no-template-curly-in-string -- the shell's ${…}.
        "PS1='\\[\\e[1;35m\\]${PWD/#$HOME/$__home}\\[\\e[0m\\] $ '",
        `cd ${quote(cwd)}`,
      ];
      root.put('etc/brushrc', new File(new TextEncoder().encode(rc.join('\n') + '\n')));
      for (;;) {
        await brush({
          module: brushModule,
          args: ['--rcfile', '/etc/brushrc', '--noprofile', '-i'],
          env: { ...ENV, ...env, PWD: cwd },
          root,
          fetch: fetchFile,
          shared: sharedFs,
          line,
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
    }
    for (;;) {
      text(`\x1b[1;35m${cwd.replace(/^\/home\/user(?=\/|$)/, '~')}\x1b[0m $ `);
      // The page's first commands run as if typed.
      let line: string | null;
      if (initial.length) {
        line = initial.shift()!;
        text(line + '\n');
      } else line = channel.line();
      // A line ending in \ goes on in the next one, as in sh.
      while (line !== null && line.endsWith('\\')) {
        let more: string | null;
        if (initial.length) {
          more = initial.shift()!;
          text(`> ${more}\n`);
        } else {
          text('> ');
          more = channel.line();
        }
        line = more === null ? null : `${line.slice(0, -1)} ${more}`;
      }
      if (line === null) {
        text('^C\n');
        continue;
      }
      // NAME=value before a command: in its environment, as in sh; alone,
      // in the shell's from then on.
      const parts = words(line);
      const assigned: Record<string, string> = {};
      while (parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0])) {
        const assignment = parts.shift()!;
        const at = assignment.indexOf('=');
        assigned[assignment.slice(0, at)] = assignment.slice(at + 1);
      }
      const [name, ...rest] = parts;
      if (!name) {
        Object.assign(env, assigned);
        continue;
      }
      try {
        const read = (path: string) => fs.read(join(cwd, path));
        const argv =
          command(name, rest, read) ??
          escriptOnPath(name, rest, { ...ENV, ...env, ...assigned }, read);
        if (argv) {
          const status = await run(argv, cwd, assigned);
          if (status === 130) text('\n');
          continue;
        }
        if (pagePrograms.includes(name)) {
          if (runOnPage(name, rest, cwd) === 130) text('^C\n');
          continue;
        }
        // coreutils' tools, on the terminal; the builtins below without
        // coreutils.wasm.
        const tool =
          !SHELL_BUILTINS.has(name) &&
          TOOLS.has(name) &&
          module() &&
          coreutils({ ...tools, terminal: () => channel.size }, name);
        if (tool) {
          const process = new Process();
          tool(process, { args: rest, cwd, env: { ...ENV, ...env, ...assigned }, root });
          for (const bytes of process.output) say('out', bytes);
          continue;
        }
        switch (name) {
          case 'help':
            text(HELP);
            break;
          case 'pwd':
            text(cwd + '\n');
            break;
          case 'echo':
            text(rest.join(' ') + '\n');
            break;
          case 'clear':
            text('\x1b[2J\x1b[H');
            break;
          case 'cd': {
            const target = join(cwd, rest[0] ?? '/work');
            if (fs.stat(target)?.dir) cwd = target;
            else text(`cd: ${rest[0]}: no such directory\n`);
            break;
          }
          case 'ls': {
            const paths = rest.filter((a) => !a.startsWith('-'));
            const all = rest.includes('-a');
            for (const path of paths.length ? paths : ['.']) {
              const full = join(cwd, path);
              const status = fs.stat(full);
              if (!status) text(`ls: ${path}: no such file or directory\n`);
              else if (status.dir) {
                const entries = (fs.list(full) ?? [])
                  .filter((e) => all || !e.name.startsWith('.'))
                  .sort((a, b) => a.name.localeCompare(b.name));
                text(
                  entries.map((e) => (e.dir ? `\x1b[1;34m${e.name}\x1b[0m` : e.name)).join('  ') +
                    (entries.length ? '\n' : ''),
                );
              } else text(path + '\n');
            }
            break;
          }
          case 'cat':
            for (const path of rest) {
              const bytes = fs.read(join(cwd, path));
              if (!bytes) text(`cat: ${path}: not a file\n`);
              else say('out', bytes.slice());
            }
            break;
          case 'mkdir':
            for (const path of rest.filter((a) => a !== '-p')) {
              const full = join(cwd, path);
              if (fs.stat(full)) {
                if (!rest.includes('-p')) text(`mkdir: ${path}: exists\n`);
              } else if (fs.stat(join(full, '..'))?.dir || rest.includes('-p')) fs.mkdir(full);
              else text(`mkdir: ${path}: no such directory\n`);
            }
            break;
          case 'rm':
            for (const path of rest.filter((a) => !a.startsWith('-'))) {
              const full = join(cwd, path);
              const status = fs.stat(full);
              if (!status) text(`rm: ${path}: no such file or directory\n`);
              else if (status.dir && !rest.some((a) => /^-r|^-rf|^-fr/.test(a)))
                text(`rm: ${path}: is a directory\n`);
              else fs.remove(full);
            }
            break;
          default:
            text(`${name}: command not found (try help)\n`);
        }
      } catch (error) {
        text(`${name}: ${(error as Error).message}\n`);
      }
    }
  } catch (error) {
    say('status', `failed: ${(error as Error).stack || error}`);
  }
};
