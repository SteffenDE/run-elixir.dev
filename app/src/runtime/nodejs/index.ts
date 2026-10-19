// nodejs.js: a Node.js process in a worker of its own (the page program
// `node`, programs/nodejs.ts), or one of its worker threads in a worker
// nested in it (threads.ts). Scripts run on the browser's own JavaScript
// engine; Node's modules are this directory's, over the shared files
// (files.js, reached synchronously as a node reaches them; a process's
// threads share its channel, by its lock).
//
// The page (or the parent thread) sends { kind: 'start', args, cwd, env,
// doorbell, channel, lock?, thread? } and then a thread's messages as
// { kind: 'message', data }; a process also hears the page's net messages
// (net.ts) and { kind: 'changed', paths } for its files' watchers. The
// worker answers { kind: 'out', fd, bytes } as it writes, a thread's
// messages and its uncaught error, and { kind: 'exit', code } at its end,
// then waits to be stopped.
import { Buffer } from './buffer';
import { createBuiltins, BUILTINS } from './builtins';
import { createFs } from './fs';
import { createLoader } from './loader';
import { createNet, type Net, type NetMessage } from './net';
import { createPath } from './path';
import { createProcess, VERSION } from './process';
import { createThreads, nodeMessageChannel, type ThreadStart } from './threads';
import { inspect } from './util';
import { createWasi } from './wasi';
import { sharedClient } from '../wasi/shared';

interface Start {
  kind: 'start';
  args: string[];
  cwd: string;
  env: Record<string, string>;
  doorbell: SharedArrayBuffer;
  channel: SharedArrayBuffer;
  // The channel's lock, which a process's threads share; made by the
  // process.
  lock?: SharedArrayBuffer;
  tty?: boolean;
  columns?: number;
  thread?: ThreadStart;
}

const USAGE = `Usage: node [options] [ script.js | -e "script" ] [arguments]

  -e, --eval script     evaluate script
  -p, --print script    evaluate script and print the result
  -r, --require module  require a module first
  -v, --version         print Node.js's version
  -h, --help            print this help

The playground's Node runs scripts on the browser's JavaScript engine; it
has no REPL or child processes yet.
`;

const encoder = new TextEncoder();
// The worker's own postMessage: a script may put its own in the global's
// place (napi-rs's threads do).
const post = globalThis.postMessage.bind(globalThis) as (
  message: unknown,
  transfer?: Transferable[],
) => void;

// Bytes to the page (or the parent); the worker's end, after which nothing
// runs.
const io = {
  write(fd: number, bytes: Uint8Array) {
    post({ kind: 'out', fd, bytes: bytes.slice() });
  },
  exit(code: number): never {
    post({ kind: 'exit', code: code & 255 });
    // The page stops the worker; until then, nothing more of the script.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('stopped');
  },
};

// node's own flags, the script (or -e), and the script's arguments.
function parse(args: string[]) {
  const out = {
    eval: null as string | null,
    print: false,
    script: null as string | null,
    rest: [] as string[],
    requires: [] as string[],
    version: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      out.script = args[i + 1] ?? null;
      out.rest = args.slice(i + 2);
      break;
    }
    if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print' || arg === '-pe') {
      out.eval = args[++i] ?? '';
      out.print = arg !== '-e' && arg !== '--eval';
      out.rest = args.slice(i + 1);
      break;
    }
    if (arg.startsWith('--eval=') || arg.startsWith('--print=')) {
      out.eval = arg.slice(arg.indexOf('=') + 1);
      out.print = arg.startsWith('--print=');
      out.rest = args.slice(i + 1);
      break;
    }
    if (arg === '-r' || arg === '--require' || arg === '--import') {
      out.requires.push(args[++i]);
      continue;
    }
    if (arg === '-v' || arg === '--version') out.version = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg.startsWith('-')) {
      // Flags that take a value as the next argument.
      if (
        /^--(stack-size|max-old-space-size|input-type|conditions|loader|experimental-loader|title)$/.test(
          arg,
        )
      )
        i++;
    } else {
      out.script = arg;
      out.rest = args.slice(i + 1);
      break;
    }
  }
  return out;
}

// The thread's worker_threads, for its parent's messages; the process's
// net and its files' watchers, for the page's.
let threads: ReturnType<typeof createThreads> | null = null;
let net: Net | null = null;
let watched: ((paths: string[]) => void) | null = null;

async function run(start: Start) {
  const thread = start.thread ?? null;
  const lock = start.lock ?? new SharedArrayBuffer(4);
  const call = sharedClient(start.doorbell, start.channel, lock);
  const options = thread
    ? {
        eval: thread.code,
        print: false,
        script: thread.file,
        rest: thread.argv,
        requires: [],
        version: false,
        help: false,
      }
    : parse(start.args);
  if (options.version) {
    io.write(1, encoder.encode(`${VERSION}\n`));
    io.exit(0);
  }
  if (options.help) {
    io.write(1, encoder.encode(USAGE));
    io.exit(0);
  }
  if (options.eval === null && options.script === null) {
    io.write(2, encoder.encode('node: the playground has no REPL yet: run a file, or -e "code"\n'));
    io.exit(9);
  }

  const env = { ...(thread?.env ?? start.env), PWD: start.cwd };
  let proc: ReturnType<typeof createProcess>;
  const path = createPath(() => (proc ? (proc.process.cwd as () => string)() : start.cwd));
  const files = createFs(
    call,
    () => path.resolve('.'),
    (p) => path.resolve(p),
  );
  const script = options.script ? path.resolve(options.script) : '[eval]';
  proc = createProcess({
    argv: ['/usr/bin/node', ...(options.script ? [script] : []), ...options.rest],
    env,
    cwd: start.cwd,
    io,
    tty: start.tty ?? false,
    columns: start.columns ?? 80,
    report: thread ? (error) => post({ kind: 'error', error }) : undefined,
  });
  const { process, console, timers, hold, fail } = proc;
  files.setStdio((fd, bytes) => io.write(fd, bytes));
  files.setLater((fn) => (timers.setImmediate as (f: () => void) => void)(fn));
  files.setHold(hold);
  watched = files.changed;

  threads = createThreads({
    script: import.meta.url,
    shared: {
      args: [],
      env: start.env,
      doorbell: start.doorbell,
      channel: start.channel,
      lock,
      tty: start.tty,
      columns: start.columns,
    },
    cwd: () => (process.cwd as () => string)(),
    env,
    write: (fd, bytes) => io.write(fd, bytes),
    hold,
    resolve: (file) => path.resolve(file),
    self: thread,
    post,
  });
  const ownThreads = threads;
  const wasi = createWasi(call, (fd, bytes) => io.write(fd, bytes), proc.end);
  net = thread ? null : createNet(post, hold);

  let loader: ReturnType<typeof createLoader>;
  const builtin = createBuiltins({
    fs: files.module,
    fsPromises: files.promises,
    path: path as unknown as Record<string, unknown>,
    process: process as never,
    console,
    timers,
    module: () => loader.moduleBuiltin(),
    env,
    tty: start.tty ?? false,
    wasi: () => wasi,
    threads: () => ownThreads,
    net,
  });
  loader = createLoader({
    fs: files.module as never,
    path,
    builtin,
    builtins: BUILTINS,
    env,
    hold,
  });
  loader.setProcess(() => ({ cwd: process.cwd as () => string }));

  // Node's MessageChannel, whose ports hold the process as Node's do.
  globalThis.MessageChannel = nodeMessageChannel(hold);

  // Node's globals over the worker's. self and navigator are the worker
  // scope's getters, which scripts assign as Node lets them (napi-rs's
  // threads set self): plain properties here.
  Object.assign(globalThis, {
    global: globalThis,
    process,
    Buffer,
    console,
    ...timers,
  });
  for (const [name, value] of [
    ['self', globalThis],
    ['navigator', globalThis.navigator],
  ] as const)
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });

  addEventListener('error', (event) => {
    event.preventDefault();
    fail(event.error ?? event.message);
  });
  addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    if (process.listenerCount('unhandledRejection')) {
      process.emit('unhandledRejection', event.reason, event.promise);
      return;
    }
    if (thread) return fail(event.reason);
    const reason = event.reason;
    const text = reason instanceof Error ? inspect(reason) : `Uncaught ${inspect(reason)}`;
    io.write(2, encoder.encode(`${text}\n\nNode.js ${VERSION}\n`));
    proc.end(1);
  });

  // The script's own turn holds the loop until it has run.
  const release = hold();
  try {
    for (const name of options.requires) loader.createRequire(`${start.cwd}/`)(name);
    if (options.eval !== null) {
      const result = loader.evaluate(options.eval, start.cwd);
      if (options.print)
        console.log(typeof result === 'string' ? result : inspect(result, { colors: start.tty }));
    } else await loader.runMain(script);
  } catch (error) {
    fail(error);
  } finally {
    release();
  }
}

addEventListener(
  'message',
  (
    event: MessageEvent<
      Start | { kind: 'message'; data: unknown } | NetMessage | { kind: 'changed'; paths: string[] }
    >,
  ) => {
    const data = event.data;
    if (data?.kind === 'start') void run(data);
    else if (data?.kind === 'message') threads?.deliver(data.data);
    else if (data?.kind === 'net') net?.receive(data);
    else if (data?.kind === 'changed') watched?.(data.paths);
  },
);
