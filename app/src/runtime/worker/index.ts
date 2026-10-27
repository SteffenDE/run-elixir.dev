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
import { Channel, END, onPage } from './channel';
import { Process } from '../wasi/process';
import { backendNif, get, siteNif } from './nif';
import { brush, type BrushOptions, type Run } from './brush';
import { REGISTRY, isProgram, isTool, withCoreutils, type CoreutilsOptions } from '../coreutils';
import { GIT_CONFIG, GIT_DASHED, remoteHelper, throughProxy } from '../git-remote';
import { UTILITIES } from '../utilities';
import {
  HOSTED_LIMIT,
  Processes,
  feed,
  hosted,
  portProgram,
  wasmProgram,
  writeAll,
  type Program,
} from '../processes';
import { OutputLimitError } from './output';
import type { Descriptor } from '../wasi/descriptors';
import { artifacts, setSite } from './site';
import type { SiteRef } from '../packages/manifest';
import { SCHEDULERS, runBeam, sharedMemory } from './beam';

// A WebAssembly module from the site, compiled; null when the site has none
// (it answers with its page).
async function loadModule(url: URL | null): Promise<WebAssembly.Module | null> {
  if (!url) return null;
  const response = await fetch(url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok || bytes[0] !== 0 || bytes[1] !== 0x61) return null;
  return WebAssembly.compile(bytes);
}

// What the page starts a node with (host/node.ts Node.start).
interface Start {
  shared: SharedArrayBuffer;
  // The site manifest: where the BEAM, the files, the programs and the
  // NIF libraries are.
  site: SiteRef;
  files: FilesChannel | null;
  shell: boolean;
  args?: string[];
  command?: string[];
  env: Record<string, string>;
  ports: number[];
  // The page's UDP ports (53: DNS), and whether it dials other hosts.
  udpPorts?: number[];
  outbound?: boolean;
  https?: boolean;
  initial?: string[];
  pagePrograms?: string[];
  // Whether the node's input and output are a terminal (default both: a
  // shell's; a program's sh -c may say no, its page programs then too).
  tty?: boolean[];
  cwd?: string;
  boots?: string[];
  // What the page has of them already (host/node.ts Node.start): the boot
  // images gunzipped, the manifest, brush.wasm, coreutils.wasm and
  // beam.wasm compiled.
  images?: ArrayBuffer[];
  manifest?: Manifest;
  brush?: WebAssembly.Module;
  coreutils?: WebAssembly.Module;
  beam?: WebAssembly.Module;
}

// files.ts's SHARED (that module is files.js's worker, not one to import).
const SHARED = ['/work', '/tmp', '/home', '/shared'];
// What a page program may have been sent of its input and not yet taken.
const INPUT_WINDOW = 1 << 20;
const say = (kind: string, payload: unknown) => postMessage({ kind, payload });
const text = (string: string) => say('out', new TextEncoder().encode(string));
// The node's standard error, apart from its output (the page may merge
// them: a terminal's).
const errorText = (string: string) => say('err', new TextEncoder().encode(string));
// sh and bash (a stand-in for it, Claude Code's shell): brush's -c.
const isSh = (name?: string) =>
  name !== undefined && /^(sh|bash)$/.test(name.slice(name.lastIndexOf('/') + 1));

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
    site: siteRef,
    files,
    shell,
    args: erlArgs,
    command: named,
    env,
    ports,
    udpPorts = [],
    outbound = false,
    https = false,
    initial = [],
    pagePrograms = [],
    tty = [true, true],
    cwd: start = '/work',
    boots = ['boot'],
    images: tars,
    manifest: listed,
    brush: shellModule,
    coreutils: toolsModule,
    beam: beamModule,
  },
}: MessageEvent<Start>) => {
  setSite(siteRef);
  const packages = artifacts();
  try {
    say('status', 'Loading OTP and Elixir…');
    // The emulator (beam.mjs) loads itself as a node starts.
    const [images, manifest, brushModule] = await Promise.all([
      tars ??
        Promise.all(
          boots.map((boot) => fetch(packages.fs(`${boot}.tar.gz`)).then((r) => r.arrayBuffer())),
        ),
      listed ?? fetch(packages.fs('manifest.json')).then((r) => r.json() as Promise<Manifest>),
      // The shell (brush.ts), if the site has it: the terminal's, or a
      // node's sh -c.
      shellModule ?? (shell || isSh(named?.[0]) ? loadModule(packages.shell()) : null),
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
    prepare(root, {
      dns: udpPorts.includes(53),
      inotifywait: pagePrograms.includes('inotifywait'),
    });
    const sharedFs: Shared | null = files
      ? { prefixes: SHARED, call: sharedClient(files.doorbell, files.channel) }
      : null;
    const channel = new Channel(shared);
    channel.tty = tty;
    // Lazily mounted files come in bundles (fs/bundles/N.tar).
    const fetchFile = bundled((bundle) => fetchBundle(packages.fs(`bundles/${bundle}.tar`)));
    const fs = vfs(root, fetchFile, sharedFs);
    // A package's NIF library built to WebAssembly (programs.ts make): the
    // site's (nif/NAME-VERSION.tar), else the backend's (/api/v1/nif/, on this
    // origin, which may have to build it first: docs/backend.md).
    const nif: NifSource = (name, version, report) =>
      siteNif(name, version) ?? backendNif(channel, name, version, report);
    // coreutils.wasm (coreutils.ts): the page's, else fetched and compiled
    // once a tool first runs; null when the site has none.
    let compiled: WebAssembly.Module | null | undefined = toolsModule;
    const module = () => {
      if (compiled === undefined) {
        const url = packages.tools();
        const [status, bytes] = url ? get(url) : [0, null];
        const wasm = status === 200 && bytes?.[0] === 0 && bytes[1] === 0x61;
        compiled = wasm ? new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>) : null;
      }
      return compiled;
    };
    // The site's other WASI programs (coreutils.ts REGISTRY: rg.wasm), by
    // name, each module fetched and compiled once one of its programs first
    // runs.
    const others = new Map<string, WebAssembly.Module | null>();
    const load = (name: string) => {
      const url = REGISTRY.get(name)?.url;
      if (!url) return null;
      if (!others.has(url.href)) {
        const [status, bytes] = get(url);
        const wasm = status === 200 && bytes?.[0] === 0 && bytes[1] === 0x61;
        others.set(
          url.href,
          wasm ? new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>) : null,
        );
      }
      return others.get(url.href)!;
    };
    const tools: CoreutilsOptions = { module, load, fetch: fetchFile, shared: sharedFs };

    // One node, until it halts or is interrupted.
    // extra: a command line's NAME=value assignments, for it alone.
    // stdout, stderr: where its output and errors go, the node's own by
    // default.
    const run = async (
      argv: string[],
      cwd: string,
      extra: Record<string, string> = {},
      stdout: (bytes: Uint8Array) => void = (bytes) => say('out', bytes),
      stderr: (bytes: Uint8Array) => void = (bytes) => say('err', bytes),
    ): Promise<number> => {
      const vars = { ...env, ...extra };
      const network = new Network({
        ports,
        udpPorts,
        https,
        open: (id, port, host) => postMessage({ kind: 'net', op: 'open', id, port, host }),
        dial: outbound
          ? (id, address, port) => postMessage({ kind: 'net', op: 'dial', id, port, host: address })
          : undefined,
        datagram: (from, address, port, payload) =>
          postMessage({ kind: 'udp', from, address, port, payload }),
        bound: (port) => postMessage({ kind: 'udp', from: port, bound: true }),
        unbound: (port) => postMessage({ kind: 'udp', from: port, closed: true }),
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
      // Ctrl+C is the node's while it runs (its break), not its processes'.
      processes.hosting++;
      try {
        return await runBeam({
          module: packages.beam()!.loader.href,
          argv: ['+S', String(SCHEDULERS), ...cookie(argv, vars), ...argv],
          env: { ...ENV, ...vars, PWD: cwd },
          cwd,
          root,
          fetch: fetchFile,
          shared: sharedFs,
          network,
          programs: withCoreutils(
            Object.assign(
              {
                ...programs(fs, nif),
                ...Object.fromEntries(pagePrograms.map((name) => [name, onPage(channel, name)])),
              },
              // The site's WASI programs (git.wasm, sed.wasm, …) as processes
              // of the worker's table: they take the `processes` imports
              // (git's transport and children, sed's `e`, gnulib's dup2);
              // and the shell's own utilities (env, xargs, chmod).
              Object.fromEntries(
                [...[...REGISTRY.keys()].filter(isProgram), ...Object.keys(UTILITIES)].map(
                  (name) => [name, portProgram(processes, name)],
                ),
              ),
            ),
            tools,
          ),
          channel,
          memory: sharedMemory(),
          wasm: beamModule,
          stdout,
          stderr,
        });
      } finally {
        processes.hosting--;
        channel.interrupted = false;
        channel.terminated = false;
        channel.mode(false);
        channel.network = null;
        for (const port of network.listeners.keys())
          postMessage({ kind: 'listening', port, on: false });
        for (const id of network.endpoints.keys()) postMessage({ kind: 'net', op: 'close', id });
      }
    };

    // A page program (git, tailwind, node, …) as a process, until it exits
    // or a signal stops it. Its input: a pipe's or a file's, as it comes;
    // else the terminal's as it is typed (Ctrl+D its end), as a node's own
    // is. Its output goes to its stdout as it comes, waiting while a pipe
    // is full: once nothing reads it, the program stops (SIGPIPE's 141).
    // The terminal's mode, which it may set (Node's setRawMode), is the
    // shell's again after it.
    const pageProgram =
      (name: string, args: string[]): Program =>
      async (child, { cwd, env: vars, stdio: [input, output, errors] }) => {
        const process = new Process();
        // Its standard error to the process's own (a pipe's, the node's).
        process.errors = [];
        let wake = () => {};
        // What the input waits on: the program to take what it was sent.
        let taken = () => {};
        process.notify = () => {
          wake();
          taken();
        };
        // Without a pipe or a file, the node's input is the program's (the
        // terminal's typing, or what a program's child_process writes to
        // its child).
        const forward = !!input.source;
        let id = 0;
        onPage(channel, name, {
          input: null,
          tty: [forward && channel.tty[0], !!output.tty],
          started: (started) => (id = started),
        })(process, { args, cwd, env: { ...ENV, ...vars, PWD: cwd }, root });
        const mode = [channel.raw, channel.signals] as const;
        let done = false;
        let sent = 0;
        const send = (bytes: Uint8Array | null) => {
          sent += bytes?.length ?? 0;
          postMessage(bytes ? { kind: 'stdin', id, bytes } : { kind: 'stdin', id, end: true });
        };
        // At most INPUT_WINDOW bytes on their way to it.
        const room = async () => {
          for (;;) {
            if (done || sent - process.taken < INPUT_WINDOW) return;
            await Promise.race([
              new Promise<void>((resolve) => (taken = resolve)),
              child.woken,
              channel.rest(1000).then(() => channel.pump()),
            ]);
          }
        };
        if (forward) channel.reading = id;
        else void feed(input, send, room, () => done, sharedFs);
        try {
          for (;;) {
            const changed = new Promise<void>((resolve) => (wake = resolve));
            channel.pump();
            if (forward)
              for (const bytes of channel.input.splice(0)) send(bytes === END ? null : bytes);
            // What it wrote ahead of a reader too slow for it (it cannot
            // wait) is bounded.
            if (process.output.reduce((size, bytes) => size + bytes.length, 0) > HOSTED_LIMIT)
              throw new OutputLimitError();
            // Whether it had ended before what it wrote is taken: more may
            // come while a pipe is full (other processes take in frames),
            // and its end after all it wrote.
            const ended = process.ended;
            // What reads its errors may be gone: they are dropped then.
            for (const bytes of process.errors.splice(0))
              await writeAll(errors, bytes, child, sharedFs);
            for (const bytes of process.output.splice(0))
              if (!(await writeAll(output, bytes, child, sharedFs))) {
                process.onclose?.();
                return child.signal === null ? 141 : 128 + child.signal;
              }
            if (ended) return process.status ?? 1;
            if (child.signal !== null) {
              process.onclose?.();
              return 128 + child.signal;
            }
            await Promise.race([changed, child.woken, channel.rest(1000)]);
          }
        } finally {
          done = true;
          if (forward) {
            channel.reading = null;
            channel.input = [];
          }
          channel.mode(...mode);
        }
      };

    // The node's input for a tool that reads it (no pipe's): the
    // terminal's typing (Ctrl+D its end) or what its process writes it, as
    // it comes; none after its end, or once Ctrl+C or a stop came. Null
    // while nothing came: the reader waits for a frame (`ready`), and the
    // worker's other processes run meanwhile.
    const readInput = (max: number): Uint8Array | null => {
      channel.pump();
      if (channel.interrupted || channel.terminated) return new Uint8Array(0);
      const bytes = channel.takeInput(max);
      channel.reading = bytes ? null : 0;
      return bytes;
    };
    const inputReady = () => channel.rest(1000);

    say('status', 'running');
    // What the shell runs for `program`: a node (its argv: a node command,
    // an escript), a page program (a
    // script for node, #!/usr/bin/env node, a package's bin in
    // node_modules/.bin), a program built for WASI (coreutils' tools, the
    // site's REGISTRY), or nothing.
    type Found =
      | { node: string[] }
      | { page: string; args: string[] }
      | { script: string[] }
      | { wasm: WebAssembly.Module };
    const find = (
      program: string,
      given: string[],
      at: string,
      vars: Record<string, string> = env,
    ): Found | null => {
      const name = program.split('/').pop()!;
      const read = (path: string) => fs.read(join(at, path));
      // A path's first bytes (a relative one's from `at`: git's hooks; a
      // name's, a script's on PATH, as execvp finds it: ~/bin's, the
      // stubs are empty).
      const path = program.startsWith('/')
        ? program
        : program.includes('/')
          ? join(at, program)
          : ((vars.PATH ?? '')
              .split(':')
              .filter(Boolean)
              .map((dir) => join(at, `${dir}/${program}`))
              .find((candidate) => (fs.read(candidate)?.length ?? 0) > 2) ?? null);
      const head = path ? fs.read(path)?.subarray(0, 64) : null;
      const shebang = head ? new TextDecoder().decode(head) : '';
      const argv =
        command(name, given, read) ??
        (/^#!.*\bescript\b/.test(shebang) ? command('escript', [program, ...given], read) : null);
      if (argv) return { node: argv };
      // A script for sh (a git hook, #!/bin/sh or #!/usr/bin/env bash).
      if (/^#!.*\b(sh|bash)\b/.test(shebang)) return { script: [path!, ...given] };
      // git's dashed commands (git starts them by name): its scripts from its
      // exec path (git-submodule), and git.wasm as a transport's other end
      // (git-upload-pack); another git-NAME is none (an alias's, then).
      if (name.startsWith('git-')) {
        const exec = path ?? `/usr/libexec/git-core/${name}`;
        const script = fs.read(exec)?.subarray(0, 64);
        if (script && /^#!.*\b(sh|bash)\b/.test(new TextDecoder().decode(script)))
          return { script: [exec, ...given] };
        const git = GIT_DASHED.has(name) ? load('git') : null;
        if (git) return { wasm: git };
        return null;
      }
      const own = isProgram(name) ? load(name) : null;
      if (own) return { wasm: own };
      if (pagePrograms.includes(name)) return { page: name, args: given };
      if (/^#!.*\bnode\b/.test(shebang) && pagePrograms.includes('node'))
        return { page: 'node', args: [program, ...given] };
      const tool = isTool(name) ? module() : null;
      return tool ? { wasm: tool } : null;
    };
    // Ctrl+C for the processes: the channel takes in the page's frames.
    // While a node or a page program runs, it is theirs.
    const check = () => {
      channel.pump();
      if (processes.hosting) return;
      if (channel.interrupted || channel.terminated) {
        channel.interrupted = false;
        channel.terminated = false;
        processes.interrupt();
      }
    };
    // What brush starts, and what that starts in turn (processes.ts):
    // programs built for WASI as processes of their own, page programs
    // streaming to and from them, and nodes as the shell has always run
    // them (`external`), their input whole.
    // sh as a process (below: it needs the shell's options).
    let shProgram: Program = async () => 127;
    const processes: Processes = new Processes((program, given, at, vars) => {
      if (isSh(program)) return (child, spawn) => shProgram(child, spawn);
      const utility = UTILITIES[program.split('/').pop()!];
      if (utility) return utility(processes, (path) => fs.stat(path));
      // git's transport for a remote (git.wasm starts it): HTTPS through
      // the site's proxy.
      if (program.split('/').pop() === 'git' && /^remote-https?$/.test(given[0] ?? ''))
        return remoteHelper(throughProxy(location.origin));
      const found = find(program, given, at, vars);
      if (!found) return null;
      if ('page' in found) return pageProgram(found.page, found.args);
      if ('script' in found)
        return (child, spawn) => shProgram(child, { ...spawn, args: found.script });
      if ('node' in found) return hosted(processes, external, sharedFs);
      const argv0 = program.split('/').pop()!;
      return wasmProgram(processes, found.wasm, {
        root,
        fetch: fetchFile,
        shared: sharedFs,
        argv0,
        pump: check,
        // git's pager would be another process; `cat` is none to git.
        defaults: /^git(-|$)/.test(argv0) ? { GIT_PAGER: 'cat', ...GIT_CONFIG } : {},
        columns: () => channel.size[0],
      });
    }, check);
    // A node, as `find` has it, to its end.
    const external: Run = async (program, given, at, vars, io) => {
      const found = find(program, given, at);
      if (!found || !('node' in found)) return null;
      const status = await run(
        found.node,
        at,
        vars,
        io.stdout ?? undefined,
        io.stderr ?? undefined,
      );
      if (status === 130) text('\n');
      return status;
    };
    // The standard streams of what the shell starts, where they are the
    // shell's own: the node's input (the terminal's typing) and output.
    const standard: [Descriptor, Descriptor, Descriptor] = [
      { stream: true, source: readInput, ready: inputReady, tty: channel.tty[0] },
      { stream: true, sink: (bytes) => say('out', bytes), tty: channel.tty[1] },
      { stream: true, sink: (bytes) => say('err', bytes), tty: channel.tty[1] },
    ];
    // One node, not under a shell: its command, to its end (its git and
    // the like are processes of the table above).
    const sh = isSh(named?.[0]);
    if (!shell && !sh) {
      const cwd = env.PWD || start;
      const argv = named
        ? command(named[0], named.slice(1), (path) => fs.read(join(cwd, path)))
        : erlArgs;
      if (!argv) {
        errorText(`${named![0]}: command not found\n`);
        say('exit', 127);
        return;
      }
      say('exit', await run(argv, cwd));
      return;
    }
    // The terminal's shell, or a node's sh -c: brush (brush.ts), which the
    // site has.
    if (!brushModule) throw new Error('the site has no shell (brush.wasm: brush/build.py)');
    // The terminal as brush's line editor has it. Waiting for a key holds
    // nothing: the worker's processes (a job with `&`) run meanwhile.
    const terminal: BrushOptions['terminal'] = {
      raw: (on) => channel.mode(on),
      size: () => channel.size,
      read: async (max, timeout) => {
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
          await channel.rest(Math.min(left, 1000));
        }
      },
    };
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const shellOptions = (cwd: string) => ({
      module: brushModule,
      env: { ...ENV, ...env, PWD: cwd },
      root,
      fetch: fetchFile,
      shared: sharedFs,
      out: (bytes: Uint8Array) => say('out', bytes),
      err: (bytes: Uint8Array) => say('err', bytes),
      terminal,
      processes,
      standard,
    });

    // sh -c LINE [NAME ARGS…] as brush's arguments, without its line editor
    // or rc files, from `cwd` (WASI has none: brush starts in /); else
    // what sh says instead, and its status. bash -c -l LINE (Claude
    // Code's) is sh -c LINE: brush has no profile to log in with. The rest
    // are $0, $1, … as sh's.
    const shArgs = (
      given: string[],
      cwd: string,
    ): { args: string[] } | { message: string; status: number } => {
      const args = [...given];
      const login = (a: string | undefined) => a === '-l' || a === '--login';
      while (login(args[0])) args.shift();
      if (args[0] === '-c') while (login(args[1])) args.splice(1, 1);
      // sh FILE ARGS…: the script, sourced (its $0 the file).
      if (args[0] && !args[0].startsWith('-')) args.unshift('-c', `. ${quote(args[0])}`);
      const [flag, line = '', ...rest] = args;
      // What a program probes a shell with (Claude Code's, for bash).
      if (flag === '--version')
        return {
          message: 'GNU bash, version 5.2.0 compatible (brush, the playground)\n',
          status: 0,
        };
      if (flag !== '-c')
        return { message: 'sh: only sh -c LINE runs in the playground\n', status: 2 };
      return {
        args: ['--norc', '--noprofile', '-c', `cd ${quote(cwd)} || exit 1\n${line}`, ...rest],
      };
    };
    // sh (or bash) as a process of the table: brush with the streams it
    // was given (git's `sh -c`, a hook, an alias's `!`).
    shProgram = async (child, { args: given, cwd, env: vars, stdio }) => {
      const parsed = shArgs(given, cwd);
      if ('message' in parsed) {
        await writeAll(stdio[1], new TextEncoder().encode(parsed.message), child, sharedFs);
        return parsed.status;
      }
      return brush({
        ...shellOptions(cwd),
        env: { ...ENV, ...vars, PWD: cwd },
        args: parsed.args,
        stdio,
        self: child,
        pump: check,
      });
    };

    // sh -c LINE [NAME ARGS…], as a node's sh runs it (System.shell,
    // open_port's spawn, npm's scripts): brush, without its line editor or
    // rc files, from the port's directory (WASI has none: brush starts in
    // /).
    if (sh) {
      const cwd = env.PWD || start;
      const parsed = shArgs(named!.slice(1), cwd);
      if ('message' in parsed) {
        (parsed.status ? errorText : text)(parsed.message);
        say('exit', parsed.status);
        return;
      }
      say('exit', await brush({ ...shellOptions(cwd), args: parsed.args }));
      return;
    }

    // The terminal's shell: its prompt (the directory, ~ for $HOME); its
    // directory, as WASI has none (brush starts in /, and sets PWD so);
    // and `help`, the playground's (brush's `help NAME` for a built-in).
    const cwd = fs.stat(start)?.dir ? start : '/work';
    if (!initial.length) text(HELP);
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
        ...shellOptions(cwd),
        args: ['--rcfile', '/etc/brushrc', '--noprofile', '--enable-highlighting', '-i'],
      });
      text('The shell exited; a new one starts.\n');
    }
  } catch (error) {
    say('status', `failed: ${(error as Error).stack || error}`);
  }
};
