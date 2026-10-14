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
import { WASI, Dir, Network, untar, mount, bundled, sharedClient } from './wasi.js';
import { ENV, prepare, programs } from './setup.js';
import { vfs } from './vfs.js';

const FRAME = { INPUT: 0, OPEN: 1, DATA: 2, END: 3, CLOSE: 4, INTERRUPT: 5, OUTPUT: 7, EXIT: 8 };
const RING = 1 << 20;
const SHARED = ['/work', '/tmp'];
const say = (kind, payload) => postMessage({ kind, payload });
const text = (string) => say('out', new TextEncoder().encode(string));

class Interrupted extends Error {}

// The page's frames: input, connections, interrupts, page programs.
class Channel {
  constructor(shared) {
    this.control = new Int32Array(shared, 0, 2);
    this.ring = new Uint8Array(shared, 8, RING);
    this.input = [];
    this.network = null;
    this.interrupted = false;
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
      else if (kind === FRAME.OPEN) {
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
// escript's (bin/escript; a script's %%! flags are not read).
const ELIXIR = ['-noshell', '-elixir_root', '/rotp/lib', '-pa', '/rotp/lib/elixir/ebin'];
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
      const rest = args[0] === '-S' && args[1] === 'mix' ? ['/rotp/bin/mix', ...args.slice(2)] : args;
      return [...ELIXIR, '-user', 'elixir', '-extra', '--no-halt', '+iex', ...rest];
    }
    case 'escript':
      if (!args.length) return null;
      return ['+B', '-noshell', '-boot', '/rotp/bin/no_dot_erlang', '-run', 'escript', 'start', '-extra', ...args];
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

// boots: the boot images (fs/NAME.tar.gz) to unpack, the site's first
// commands' files (build.py). command: one command by name, as the shell
// runs it (['mix', 'deps.get']), in place of erl's `args`.
onmessage = async ({ data: { shared, files, shell, args, command: named, env, ports, initial = [], pagePrograms = [], cwd: start = '/work', boots = ['boot'] } }) => {
  try {
    say('status', 'Loading OTP and Elixir…');
    const [images, manifest, module] = await Promise.all([
      Promise.all(boots.map((boot) => fetch(new URL(`fs/${boot}.tar.gz`, import.meta.url)).then((r) => r.arrayBuffer()))),
      fetch(new URL('fs/manifest.json', import.meta.url)).then((r) => r.json()),
      WebAssembly.compileStreaming(fetch(new URL('rotp.wasm', import.meta.url))),
    ]);
    // What files.js holds stays out of this worker's tree.
    const local = (path) => !files || !SHARED.some((prefix) => `/${path}`.startsWith(`${prefix}/`));
    const root = new Dir();
    mount(manifest.filter(([path]) => local(path)), root);
    for (const image of images) await untar(new Uint8Array(image), root, local);
    prepare(root);
    const sharedFs = files ? { prefixes: SHARED, call: sharedClient(files.doorbell, files.channel) } : null;
    const channel = new Channel(shared);
    // Lazily mounted files come in bundles (fs/bundles/N.tar).
    const fetchFile = bundled((bundle) => {
      const request = new XMLHttpRequest();
      request.open('GET', new URL(`fs/bundles/${bundle}.tar`, import.meta.url), false);
      request.responseType = 'arraybuffer';
      request.send();
      if (request.status !== 200) throw new Error(`bundle ${bundle}: ${request.status}`);
      return new Uint8Array(request.response);
    });
    const fs = vfs(root, fetchFile, sharedFs);

    // One node, until it halts or is interrupted.
    const run = async (argv, cwd) => {
      const network = new Network({
        ports,
        open: (id, port) => postMessage({ kind: 'net', op: 'open', id, port }),
        send: (id, payload) => postMessage({ kind: 'net', op: 'data', id, payload }),
        end: (id) => postMessage({ kind: 'net', op: 'end', id }),
        close: (id) => postMessage({ kind: 'net', op: 'close', id }),
        listening: (port, on, ephemeral = false) => postMessage({ kind: 'listening', port, on, ephemeral }),
      });
      channel.network = network;
      channel.interrupted = false;
      const pump = () => {
        channel.pump();
        if (channel.interrupted) throw new Interrupted();
      };
      const wasi = new WASI({
        args: ['erl', ...argv],
        env: { ...ENV, ...env, PWD: cwd },
        root,
        tty: true,
        network,
        pump,
        fetch: fetchFile,
        shared: sharedFs,
        programs: {
          ...programs(fs),
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
      const instance = await WebAssembly.instantiate(module, wasi.imports);
      try {
        return wasi.start(instance);
      } catch (error) {
        if (error instanceof Interrupted) return 130;
        throw error;
      } finally {
        channel.network = null;
        for (const port of network.listeners.keys()) postMessage({ kind: 'listening', port, on: false });
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
                text(entries.map((e) => (e.dir ? `\x1b[1;34m${e.name}\x1b[0m` : e.name)).join('  ') + (entries.length ? '\n' : ''));
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
              else if (status.dir && !rest.some((a) => /^-r|^-rf|^-fr/.test(a))) text(`rm: ${path}: is a directory\n`);
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
