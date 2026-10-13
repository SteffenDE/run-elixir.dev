// A playground node in a Web Worker: rotp.wasm over wasi.js, as one
// command or under a small shell. host.js is the page's side: frames come
// in through its SharedArrayBuffer ring (the worker sleeps on the ring's
// write count, so a frame wakes it) and everything goes back as messages.
//
// The shell runs each node command (elixir, iex, mix, erl) as a fresh
// instance over the same filesystem, as a Unix shell runs processes, and
// has the few builtins a playground needs. Ctrl+C (an interrupt frame)
// stops the node.
import { WASI, Dir, File, Network, untar, mount, urandom } from './wasi.js';
import { git } from './programs.js';

const FRAME = { INPUT: 0, OPEN: 1, DATA: 2, END: 3, CLOSE: 4, INTERRUPT: 5 };
const RING = 1 << 20;
const say = (kind, payload) => postMessage({ kind, payload });
const text = (string) => say('out', new TextEncoder().encode(string));

class Interrupted extends Error {}

// The page's frames: input, connections, interrupts.
class Channel {
  constructor(shared) {
    this.control = new Int32Array(shared, 0, 2);
    this.ring = new Uint8Array(shared, 8, RING);
    this.input = [];
    this.network = null;
    this.interrupted = false;
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

function lookup(root, path) {
  let node = root;
  for (const part of path.split('/').filter(Boolean)) {
    if (!(node instanceof Dir)) return null;
    node = node.entries.get(part);
    if (!node) return null;
  }
  return node;
}

// Elixir's launchers' command lines (bin/elixir, bin/iex, bin/mix).
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
  }
  return null;
}

const HELP = `Commands: iex, elixir, mix, erl (each runs Rust-OTP), and
cd, pwd, ls, cat, mkdir [-p], rm [-r], echo, clear, help.
Ctrl+C stops what is running.
`;

onmessage = async ({ data: { shared, shell, args, env, ports } }) => {
  try {
    say('status', 'Loading OTP and Elixir…');
    const [image, manifest, module] = await Promise.all([
      fetch('fs/boot.tar.gz').then((r) => r.arrayBuffer()),
      fetch('fs/manifest.json').then((r) => r.json()),
      WebAssembly.compileStreaming(fetch('rotp.wasm')),
    ]);
    const root = new Dir();
    mount(manifest, root);
    await untar(new Uint8Array(image), root);
    root.mkdirs('work');
    root.mkdirs('tmp');
    root.put('dev/urandom', urandom());
    root.put('usr/bin/git', new File());
    root.put('rotp/bin/mix', new File(new TextEncoder().encode('Mix.CLI.main()\n')));
    const channel = new Channel(shared);
    const fetchFile = (source) => {
      const request = new XMLHttpRequest();
      request.open('GET', `fs/files/${source}`, false);
      request.responseType = 'arraybuffer';
      request.send();
      if (request.status !== 200) throw new Error(`${source}: ${request.status}`);
      return new Uint8Array(request.response);
    };

    // One node, until it halts or is interrupted.
    const run = async (argv, cwd) => {
      const network = new Network({
        ports,
        open: (id, port) => postMessage({ kind: 'net', op: 'open', id, port }),
        send: (id, payload) => postMessage({ kind: 'net', op: 'data', id, payload }),
        end: (id) => postMessage({ kind: 'net', op: 'end', id }),
        close: (id) => postMessage({ kind: 'net', op: 'close', id }),
      });
      channel.network = network;
      channel.interrupted = false;
      const pump = () => {
        channel.pump();
        if (channel.interrupted) throw new Interrupted();
      };
      const wasi = new WASI({
        args: ['erl', ...argv],
        env: { ROOTDIR: '/rotp', HOME: '/work', LANG: 'C.UTF-8', TERM: 'xterm-256color',
          MIX_HOME: '/work/.mix', PATH: '/usr/bin:/rotp/bin', MIX_ARCHIVES: '/rotp/mix/archives', ...env, PWD: cwd },
        root,
        tty: true,
        network,
        pump,
        fetch: fetchFile,
        programs: { git: git(fetchFile) },
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
        for (const id of network.endpoints.keys()) postMessage({ kind: 'net', op: 'close', id });
      }
    };

    say('status', 'running');
    if (!shell) {
      say('exit', await run(args, env.PWD || '/work'));
      return;
    }
    let cwd = '/work';
    text(HELP);
    for (;;) {
      text(`\x1b[1;35m${cwd.replace(/^\/work/, '~')}\x1b[0m $ `);
      const line = channel.line();
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
            if (lookup(root, target) instanceof Dir) cwd = target;
            else text(`cd: ${rest[0]}: no such directory\n`);
            break;
          }
          case 'ls': {
            const paths = rest.filter((a) => !a.startsWith('-'));
            const all = rest.includes('-a');
            for (const path of paths.length ? paths : ['.']) {
              const node = lookup(root, join(cwd, path));
              if (!node) text(`ls: ${path}: no such file or directory\n`);
              else if (node instanceof Dir) {
                const names = [...node.entries.keys()].filter((n) => all || !n.startsWith('.')).sort();
                text(names.map((n) => (node.entries.get(n) instanceof Dir ? `\x1b[1;34m${n}\x1b[0m` : n)).join('  ') + (names.length ? '\n' : ''));
              } else text(path + '\n');
            }
            break;
          }
          case 'cat':
            for (const path of rest) {
              const node = lookup(root, join(cwd, path));
              if (!(node instanceof File)) text(`cat: ${path}: not a file\n`);
              else {
                if (node.source) {
                  node.data = fetchFile(node.source);
                  node.size = node.data.length;
                  node.source = null;
                }
                say('out', node.bytes.slice());
              }
            }
            break;
          case 'mkdir':
            for (const path of rest.filter((a) => a !== '-p')) {
              const full = join(cwd, path);
              const parent = lookup(root, join(full, '..'));
              if (lookup(root, full)) {
                if (!rest.includes('-p')) text(`mkdir: ${path}: exists\n`);
              } else if (parent instanceof Dir || rest.includes('-p')) root.mkdirs(full);
              else text(`mkdir: ${path}: no such directory\n`);
            }
            break;
          case 'rm':
            for (const path of rest.filter((a) => !a.startsWith('-'))) {
              const full = join(cwd, path);
              const node = lookup(root, full);
              const parent = lookup(root, join(full, '..'));
              if (!node) text(`rm: ${path}: no such file or directory\n`);
              else if (node instanceof Dir && !rest.some((a) => /^-r|^-rf|^-fr/.test(a))) text(`rm: ${path}: is a directory\n`);
              else parent.entries.delete(full.split('/').pop());
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
