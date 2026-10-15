// A playground node in a Web Worker: rotp.wasm over wasi.js, as one
// command or under a small shell. host.js is the page's side: frames come
// in through its SharedArrayBuffer ring (the worker sleeps on the ring's
// write count, so a frame wakes it) and everything goes back as messages.
//
// The shell runs each node command (elixir, iex, mix, erl) as a fresh
// instance over the same filesystem, as a Unix shell runs processes, and
// has the few builtins a playground needs. Ctrl+C (an interrupt frame)
// stops the node. With `files`, /work and /tmp are files.js's, which every
// shell (each in its own worker) and the page share.
import { WASI, Dir, Exit, Network, untar, mount, bundled, sharedClient } from './wasi';
import { ENV, prepare, programs } from './setup';
import { channel as threadChannel, Host } from './threads';
import { vfs } from './vfs';

const FRAME = {
  INPUT: 0,
  OPEN: 1,
  DATA: 2,
  END: 3,
  CLOSE: 4,
  INTERRUPT: 5,
  OUTPUT: 7,
  EXIT: 8,
  RESIZE: 9,
};
const RING = 1 << 20;
const SHARED = ['/work', '/tmp'];
const say = (kind, payload) => postMessage({ kind, payload });
const text = (string) => say('out', new TextEncoder().encode(string));

class Interrupted extends Error {}

// A path in the build this worker came from (b/ID/, build.py), or on the
// site for an absolute one. Through a variable: Vite takes
// new URL('…', import.meta.url) with the path written out for an asset of
// the bundle.
const site = (path) => new URL(path, import.meta.url);

// A threaded node's memory: shared, and as large as it may grow here (a
// shared memory reserves its maximum up front, which a phone may not
// have room for), or null where there is no shared memory: the node then
// runs single-threaded (rotp.wasm).
function sharedMemory() {
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
const SCHEDULERS = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1));
let nodes = 0;

// The page's frames: input, connections, interrupts, page programs.
class Channel {
  constructor(shared) {
    this.control = new Int32Array(shared, 0, 2);
    this.ring = new Uint8Array(shared, 8, RING);
    this.input = [];
    this.network = null;
    this.interrupted = false;
    // The terminal's size (RESIZE frames) and whether the node set it to
    // raw input.
    this.size = [80, 24];
    this.raw = false;
    // Programs the page runs (host.js programs), by id.
    this.processes = new Map();
  }
  bytes(from, count) {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = this.ring[(from + i) % RING];
    return out;
  }
  pump() {
    const written = Atomics.load(this.control, 0);
    let read = Atomics.load(this.control, 1);
    while (read !== written) {
      const header = new DataView(this.bytes(read, 9).buffer);
      const kind = header.getUint8(0);
      const id = header.getUint32(1, true);
      const length = header.getUint32(5, true);
      const payload = this.bytes(read + 9, length);
      read += 9 + length;
      const net = this.network;
      if (kind === FRAME.INPUT) this.input.push(payload);
      else if (kind === FRAME.INTERRUPT) this.interrupted = true;
      else if (kind === FRAME.RESIZE) {
        const view = new DataView(payload.buffer);
        this.size = [view.getUint16(0, true), view.getUint16(2, true)];
      } else if (kind === FRAME.OPEN) {
        if (!net || !net.accepted(id, (payload[0] << 8) | payload[1])) {
          postMessage({ kind: 'net', op: 'refused', id });
        }
      } else if (kind === FRAME.OUTPUT) this.processes.get(id)?.write(payload);
      else if (kind === FRAME.EXIT) {
        this.processes.get(id)?.exit(payload[0]);
        this.processes.delete(id);
      } else if (kind === FRAME.DATA) net?.data(id, payload);
      else if (kind === FRAME.END || kind === FRAME.CLOSE) net?.ended(id);
    }
    Atomics.store(this.control, 1, read);
  }
  // Until a frame comes or `ms` pass.
  sleep(ms) {
    Atomics.wait(this.control, 0, Atomics.load(this.control, 1), ms);
  }
  take(max) {
    const out = [];
    let count = 0;
    while (this.input.length && count < max) {
      const chunk = this.input[0];
      const part = chunk.subarray(0, max - count);
      out.push(part);
      count += part.length;
      if (part.length === chunk.length) this.input.shift();
      else this.input[0] = chunk.subarray(part.length);
    }
    const bytes = new Uint8Array(count);
    let at = 0;
    for (const part of out) {
      bytes.set(part, at);
      at += part.length;
    }
    return bytes;
  }
  // The node set the terminal to raw input (IEx's line editing) or back:
  // the page passes keys through instead of editing lines.
  mode(raw) {
    if (raw === this.raw) return;
    this.raw = raw;
    postMessage({ kind: 'tty', raw });
  }
  // A line typed at the shell (blocking).
  line() {
    for (;;) {
      this.pump();
      if (this.interrupted) {
        this.interrupted = false;
        this.input = [];
        return null;
      }
      const all = this.take(Infinity);
      const newline = all.indexOf(10);
      if (newline >= 0) {
        if (newline + 1 < all.length) this.input.unshift(all.subarray(newline + 1));
        return new TextDecoder().decode(all.subarray(0, newline));
      }
      if (all.length) this.input.unshift(all);
      this.sleep(1000);
    }
  }
}

// Words, with '' and "" quoting.
function words(line) {
  const out = [];
  let word = null;
  let quote = null;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
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

function join(cwd, path) {
  const parts = (path.startsWith('/') ? path : `${cwd}/${path}`).split('/');
  const out = [];
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
function command(name, args) {
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

const HELP = `Commands: iex, elixir, mix, erl (each runs Rust-OTP), and
cd, pwd, ls, cat, mkdir [-p], rm [-r], echo, clear, help.
Ctrl+C stops what is running.
`;

// A program the page runs (host.js programs): its output and exit come back
// as frames; it is told when the node closes its port.
let processes = 0;
function onPage(channel, name) {
  return (process, { args, cwd, env }) => {
    const id = (processes += 1);
    channel.processes.set(id, process);
    process.onclose = () => {
      channel.processes.delete(id);
      postMessage({ kind: 'kill', id });
    };
    postMessage({ kind: 'spawn', id, name, args, cwd, env });
  };
}

// A threaded node: the page runs its threads in workers (host.js), which
// this worker serves WASI calls for until the node ends; then the page
// stops them.
function runThreaded(wasi, module, memory, pump) {
  wasi.memory = memory;
  const node = ++nodes;
  const chan = threadChannel();
  const names = Object.keys(wasi.imports.wasi_snapshot_preview1);
  const start = (tid, startArg) =>
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

// GET url, synchronously: [status, bytes] (status 0 when it failed).
function get(url, binary = true) {
  const request = new XMLHttpRequest();
  request.open('GET', url, false);
  if (binary) request.responseType = 'arraybuffer';
  try {
    request.send();
  } catch {
    return [0, null];
  }
  return [request.status, binary ? new Uint8Array(request.response) : request.responseText];
}

// A tar (ustar), and not the page a site answers a path it lacks with.
const isTar = (bytes) =>
  bytes?.length > 262 && new TextDecoder().decode(bytes.subarray(257, 262)) === 'ustar';

// The site's own build of a package's NIF library, or null.
function siteNif(name, version) {
  const [status, tar] = get(site(`nif/${name}-${version}.tar`));
  return status === 200 && isTar(tar) ? tar : null;
}

// What a backend build's status means, for the terminal.
const NIF_STATUS = {
  queued: 'waiting for a build machine',
  running: 'building in a VM',
  setting_up: 'no recipe builds it yet: an agent is working one out (this can take minutes)',
};

// The backend's build of a package's NIF library: asks until it is built
// or failed, every 2 s, telling the terminal (say) and the page (a 'nif'
// message: { name, version, status, error }) when its status changes.
// Ctrl-C stops waiting (the node stops as it would). A tar, or why not.
function backendNif(channel, name, version, say) {
  const api = site(`/api/nif/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
  const tell = (status, error = null) => postMessage({ kind: 'nif', name, version, status, error });
  let last = null;
  for (;;) {
    const [code, text] = get(api, false);
    let answer = null;
    try {
      answer = JSON.parse(text);
    } catch {}
    if (code === 200 && answer?.url) {
      const [status, tar] = get(new URL(answer.url, api));
      if (status === 200 && isTar(tar)) {
        if (last) say(`${name} ${version} is built`);
        tell('succeeded');
        return tar;
      }
      tell('failed', `the library did not download (${status})`);
      return `the playground's build of ${name} ${version} did not download (${status})`;
    }
    if (code !== 202) {
      const error =
        answer?.error ??
        (code
          ? `the playground's backend answered ${code}`
          : "the playground's backend could not be reached");
      // A site without a backend answers its page: no build, as before.
      if (code === 200 || (code === 404 && !answer)) return null;
      tell(answer?.status ?? 'failed', error);
      return `${name} ${version} could not be built for the playground: ${error}`;
    }
    if (answer?.status !== last) {
      last = answer?.status;
      say(`${name} ${version}: ${NIF_STATUS[last] ?? last}…`);
      tell(last);
    }
    for (let waited = 0; waited < 2000; waited += 200) {
      channel.sleep(200);
      channel.pump();
      if (channel.interrupted) {
        tell('interrupted');
        return `stopped waiting for ${name} ${version}'s build`;
      }
    }
  }
}

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
}) => {
  try {
    say('status', 'Loading OTP and Elixir…');
    // The threaded build where shared memory is; the single-threaded one
    // otherwise, or when the threaded one does not load.
    const compile = (name) => WebAssembly.compileStreaming(fetch(site(name)));
    const threaded = sharedMemory() !== null;
    const [images, manifest, [module, threads]] = await Promise.all([
      Promise.all(
        boots.map((boot) => fetch(site(`fs/${boot}.tar.gz`)).then((r) => r.arrayBuffer())),
      ),
      fetch(site('fs/manifest.json')).then((r) => r.json()),
      threaded
        ? compile('rotp-threads.wasm').then(
            (m) => [m, true],
            () => compile('rotp.wasm').then((m) => [m, false]),
          )
        : compile('rotp.wasm').then((m) => [m, false]),
    ]);
    // What files.js holds stays out of this worker's tree.
    const local = (path) => !files || !SHARED.some((prefix) => `/${path}`.startsWith(`${prefix}/`));
    const root = new Dir();
    mount(
      manifest.filter(([path]) => local(path)),
      root,
    );
    for (const image of images) await untar(new Uint8Array(image), root, local);
    prepare(root);
    const sharedFs = files
      ? { prefixes: SHARED, call: sharedClient(files.doorbell, files.channel) }
      : null;
    const channel = new Channel(shared);
    // Lazily mounted files come in bundles (fs/bundles/N.tar).
    const fetchFile = bundled((bundle) => {
      const request = new XMLHttpRequest();
      request.open('GET', site(`fs/bundles/${bundle}.tar`), false);
      request.responseType = 'arraybuffer';
      request.send();
      if (request.status !== 200) throw new Error(`bundle ${bundle}: ${request.status}`);
      return new Uint8Array(request.response);
    });
    const fs = vfs(root, fetchFile, sharedFs);
    // A package's NIF library built to WebAssembly (programs.js make): the
    // site's (nif/NAME-VERSION.tar), else the backend's (/api/nif/, on this
    // origin, which may have to build it first: docs/backend.md).
    const nif = (name, version, say) =>
      siteNif(name, version) ?? backendNif(channel, name, version, say);

    // One node, until it halts or is interrupted.
    const run = async (argv, cwd) => {
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
        if (memory) return runThreaded(wasi, module, memory, pump);
        if (threads) throw new Error('no room for a shared memory for the node');
        const instance = await WebAssembly.instantiate(module, wasi.imports);
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

    say('status', 'running');
    if (!shell) {
      const argv = named ? command(named[0], named.slice(1)) : args;
      if (!argv) {
        text(`${named[0]}: command not found\n`);
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
      let line;
      if (initial.length) {
        line = initial.shift();
        text(line + '\n');
      } else line = channel.line();
      // A line ending in \ goes on in the next one, as in sh.
      while (line !== null && line.endsWith('\\')) {
        let more;
        if (initial.length) {
          more = initial.shift();
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
        text(`${name}: ${error.message}\n`);
      }
    }
  } catch (error) {
    say('status', `failed: ${error.stack || error}`);
  }
};
