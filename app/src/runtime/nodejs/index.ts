// nodejs.js: a Node.js process in a worker of its own (the page program
// `node`, programs/nodejs.ts). Scripts run on the browser's own JavaScript
// engine; Node's modules are this directory's, over the shared files
// (files.js, reached synchronously as a node reaches them).
//
// The page sends { kind: 'start', args, cwd, env, doorbell, channel }; the
// worker answers { kind: 'out', fd, bytes } as the process writes and
// { kind: 'exit', code } at its end, then waits to be stopped.
import { Buffer } from 'buffer';
import { createBuiltins, BUILTINS } from './builtins';
import { createFs } from './fs';
import { createLoader } from './loader';
import { createPath } from './path';
import { createProcess, VERSION } from './process';
import { inspect } from './util';
import { sharedClient } from '../wasi/shared';

interface Start {
  kind: 'start';
  args: string[];
  cwd: string;
  env: Record<string, string>;
  doorbell: SharedArrayBuffer;
  channel: SharedArrayBuffer;
  tty?: boolean;
  columns?: number;
}

const USAGE = `Usage: node [options] [ script.js | -e "script" ] [arguments]

  -e, --eval script     evaluate script
  -p, --print script    evaluate script and print the result
  -r, --require module  require a module first
  -v, --version         print Node.js's version
  -h, --help            print this help

The playground's Node runs scripts on the browser's JavaScript engine; it
has no REPL, network or child processes yet.
`;

const encoder = new TextEncoder();

// Bytes to the page; the worker's end, after which nothing runs.
const io = {
  write(fd: number, bytes: Uint8Array) {
    postMessage({ kind: 'out', fd, bytes: bytes.slice() });
  },
  exit(code: number): never {
    postMessage({ kind: 'exit', code: code & 255 });
    // The page stops the worker; until then, nothing more of the script.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('stopped');
  },
};

// node's own flags, the script (or -e), and the script's arguments.
function parse(args: string[]) {
  const out = { eval: null as string | null, print: false, script: null as string | null, rest: [] as string[], requires: [] as string[], version: false, help: false };
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
      if (/^--(stack-size|max-old-space-size|input-type|conditions|loader|experimental-loader|title)$/.test(arg)) i++;
    } else {
      out.script = arg;
      out.rest = args.slice(i + 1);
      break;
    }
  }
  return out;
}

async function run(start: Start) {
  const call = sharedClient(start.doorbell, start.channel);
  const options = parse(start.args);
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

  const env = { ...start.env, PWD: start.cwd };
  let proc: ReturnType<typeof createProcess>;
  const path = createPath(() => (proc ? (proc.process.cwd as () => string)() : start.cwd));
  const files = createFs(call, () => path.resolve('.'), (p) => path.resolve(p));
  const script = options.script ? path.resolve(options.script) : '[eval]';
  proc = createProcess({
    argv: ['/usr/bin/node', ...(options.script ? [script] : []), ...options.rest],
    env,
    cwd: start.cwd,
    io,
    tty: start.tty ?? false,
    columns: start.columns ?? 80,
  });
  const { process, console, timers, hold, fail } = proc;
  files.setStdio((fd, bytes) => io.write(fd, bytes));
  files.setLater((fn) => (timers.setImmediate as (f: () => void) => void)(fn));

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
  });
  loader = createLoader({ fs: files.module as never, path, builtin, builtins: BUILTINS, env });
  loader.setProcess(() => ({ cwd: process.cwd as () => string }));

  // Node's globals over the worker's.
  Object.assign(globalThis, {
    global: globalThis,
    process,
    Buffer,
    console,
    ...timers,
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
      if (options.print) console.log(typeof result === 'string' ? result : inspect(result, { colors: start.tty }));
    } else await loader.runMain(script);
  } catch (error) {
    fail(error);
  } finally {
    release();
  }
}

addEventListener('message', (event: MessageEvent<Start>) => {
  if (event.data?.kind === 'start') void run(event.data);
});
