// A playground node in a Web Worker: rotp.wasm over wasi/, as one
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
import { WASI } from '../wasi';
import { Dir, untar, mount, bundled, fetchBundle, type Manifest } from '../wasi/fs';
import { Network } from '../wasi/net';
import { sharedClient, type Shared } from '../wasi/shared';
import { ENV, prepare, programs } from '../setup';
import { vfs } from '../vfs';
import type { NifSource } from '../programs';
import type { FilesChannel } from '../host/files';
import { Channel, onPage } from './channel';
import { Process } from '../wasi/process';
import { backendNif, siteNif } from './nif';
import { site } from './site';
import { SCHEDULERS, runThreaded, sharedMemory } from './threaded';
import { runBeam } from './beam';

// What the page starts a node with (host/node.ts Node.start).
interface Start {
  shared: SharedArrayBuffer;
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

const SHARED = ['/work', '/tmp'];
const say = (kind: string, payload: unknown) => postMessage({ kind, payload });
const text = (string: string) => say('out', new TextEncoder().encode(string));

class Interrupted extends Error {}

// Words, with '' and "" quoting.
function words(line: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null;
      else word! += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? '') + c;
  }
  if (word !== null) out.push(word);
  return out;
}

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
// escript's (bin/escript; a script's %%! flags are not read). The Hex
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
function command(name: string, args: string[]): string[] | null {
  switch (name) {
    case 'erl':
      return args;
    case 'elixir':
      return [...ELIXIR, '-s', 'elixir', 'start_cli', '-extra', ...args];
    case 'mix':
      return [...ELIXIR, '-s', 'elixir', 'start_cli', '-extra', '/rotp/bin/mix', ...args];
    case 'iex': {
      // iex -S mix ARGS runs Mix's script under IEx.
      const rest =
        args[0] === '-S' && args[1] === 'mix' ? ['/rotp/bin/mix', ...args.slice(2)] : args;
      return [...ELIXIR, '-user', 'elixir', '-extra', '--no-halt', '+iex', ...rest];
    }
    case 'escript':
      if (!args.length) return null;
      return [
        '+B',
        '-noshell',
        '-boot',
        '/rotp/bin/no_dot_erlang',
        '-run',
        'escript',
        'start',
        '-extra',
        ...args,
      ];
  }
  return null;
}

const HELP = `Commands: iex, elixir, mix, erl (each runs Rust-OTP), git (clone,
pull), and cd, pwd, ls, cat, mkdir [-p], rm [-r], echo, clear, help.
Ctrl+C stops what is running.
`;

// boots: the boot images (fs/NAME.tar.gz) to unpack, the site's first
// commands' files (build.py). command: one command by name, as the shell
// runs it (['mix', 'deps.get']), in place of erl's `args`.
onmessage = async ({
  data: {
    shared,
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
  try {
    say('status', 'Loading OTP and Elixir…');
    // The threaded build where shared memory is; the single-threaded one
    // otherwise, or when the threaded one does not load.
    const compile = (name: string) => WebAssembly.compileStreaming(fetch(site(name)));
    const threaded = sharedMemory() !== null;
    // Which runtime the build runs (build.py): Rust-OTP, or OTP's own
    // emulator (worker/beam.ts), which loads itself as it starts.
    const { runtime } = (await fetch(site('runtime.json')).then(
      (r) => (r.ok ? r.json() : { runtime: 'rotp' }),
      () => ({ runtime: 'rotp' }),
    )) as { runtime: string };
    const beam = runtime === 'otp';
    const [images, manifest, [module, threads]] = await Promise.all([
      Promise.all(
        boots.map((boot) => fetch(site(`fs/${boot}.tar.gz`)).then((r) => r.arrayBuffer())),
      ),
      fetch(site('fs/manifest.json')).then((r) => r.json() as Promise<Manifest>),
      beam
        ? ([null, true] as const)
        : threaded
          ? compile('rotp-threads.wasm').then(
              (m) => [m, true] as const,
              () => compile('rotp.wasm').then((m) => [m, false] as const),
            )
          : compile('rotp.wasm').then((m) => [m, false] as const),
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
    const fetchFile = bundled((bundle) => fetchBundle(site(`fs/bundles/${bundle}.tar`)));
    const fs = vfs(root, fetchFile, sharedFs);
    // A package's NIF library built to WebAssembly (programs.ts make): the
    // site's (nif/NAME-VERSION.tar), else the backend's (/api/nif/, on this
    // origin, which may have to build it first: docs/backend.md).
    const nif: NifSource = (name, version, report) =>
      siteNif(name, version) ?? backendNif(channel, name, version, report);

    // One node, until it halts or is interrupted.
    const run = async (argv: string[], cwd: string): Promise<number> => {
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
      channel.interrupted = false;
      if (beam) {
        try {
          return await runBeam({
            module: site('beam.mjs').href,
            argv: ['+S', String(SCHEDULERS), ...argv],
            env: { ...ENV, ...env, PWD: cwd },
            cwd,
            root,
            fetch: fetchFile,
            shared: sharedFs,
            network,
            programs: {
              ...programs(fs, nif),
              ...Object.fromEntries(pagePrograms.map((name) => [name, onPage(channel, name)])),
            },
            channel,
            memory: sharedMemory(),
            stdout: (bytes) => say('out', bytes),
          });
        } finally {
          channel.interrupted = false;
          channel.mode(false);
          channel.network = null;
          for (const port of network.listeners.keys())
            postMessage({ kind: 'listening', port, on: false });
          for (const id of network.endpoints.keys()) postMessage({ kind: 'net', op: 'close', id });
        }
      }
      const pump = () => {
        channel.pump();
        if (channel.interrupted) throw new Interrupted();
      };
      // A threaded node runs as many schedulers as SCHEDULERS says.
      const memory = threads ? sharedMemory() : null;
      const wasi = new WASI({
        args: memory ? ['erl', '+S', String(SCHEDULERS), ...argv] : ['erl', ...argv],
        env: { ...ENV, ...env, PWD: cwd },
        root,
        tty: true,
        terminal: {
          mode: (mode) => channel.mode(mode === 'raw'),
          size: () => channel.size,
        },
        network,
        pump,
        fetch: fetchFile,
        shared: sharedFs,
        programs: {
          ...programs(fs, nif),
          ...Object.fromEntries(pagePrograms.map((name) => [name, onPage(channel, name)])),
        },
        stdin(max) {
          pump();
          return channel.input.length ? channel.take(max) : null;
        },
        stdout: (bytes) => say('out', bytes),
        stderr: (bytes) => say('out', bytes),
        sleep: (ms) => channel.sleep(ms),
      });
      try {
        if (memory) return runThreaded(wasi, module!, memory, pump);
        if (threads) throw new Error('no room for a shared memory for the node');
        const instance = await WebAssembly.instantiate(module!, wasi.imports);
        return wasi.start(instance);
      } catch (error) {
        if (error instanceof Interrupted) return 130;
        throw error;
      } finally {
        // The interrupt that stopped the node is spent.
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
    const runOnPage = (name: string, args: string[], cwd: string): number => {
      const process = new Process();
      onPage(channel, name)(process, { args, cwd, env: { ...ENV, ...env, PWD: cwd }, root });
      for (;;) {
        channel.pump();
        for (const bytes of process.output.splice(0)) say('out', bytes);
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
      const argv = named ? command(named[0], named.slice(1)) : args;
      if (!argv) {
        text(`${named![0]}: command not found\n`);
        say('exit', 127);
        return;
      }
      say('exit', await run(argv, env.PWD || start));
      return;
    }
    let cwd = fs.stat(start)?.dir ? start : '/work';
    if (!initial.length) text(HELP);
    for (;;) {
      text(`\x1b[1;35m${cwd.replace(/^\/work/, '~')}\x1b[0m $ `);
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
      const [name, ...rest] = words(line);
      if (!name) continue;
      try {
        const argv = command(name, rest);
        if (argv) {
          const status = await run(argv, cwd);
          if (status === 130) text('\n');
          continue;
        }
        if (pagePrograms.includes(name)) {
          if (runOnPage(name, rest, cwd) === 130) text('^C\n');
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
