// The Node harness's command line (harness.ts; docs/build.md):
//   node node.mjs SITE [erl args...] < input
// SITE is a site build.py made (target/site: the manifest its index.html
// names), or a site manifest (site/ID.json). Standard input is read whole
// first and then ends.
import { readFileSync, writeFileSync } from 'node:fs';
import { start } from './harness';
import type { Process, ProgramContext } from './wasi/process';

// The recording's stand-ins for the page's esbuild and tailwind (the
// esbuild and tailwind packages', at their tools' versions).
const ESBUILD_VERSION = '0.25.4';
const TAILWIND_VERSION = '4.3.3';

function esbuild(process: Process, { args }: ProgramContext): void {
  if (args[0] === '--version') {
    process.write(ESBUILD_VERSION + '\n');
    return process.exit(0);
  }
  process.write('esbuild: not yet available in the playground\n');
  process.exit(1);
}

function tailwind(process: Process, { args }: ProgramContext): void {
  if (args[0] === '--help') {
    process.write(`≈ tailwindcss v${TAILWIND_VERSION}\n`);
    return process.exit(0);
  }
  process.write('tailwind: not yet available in the playground\n');
  process.exit(1);
}

const [site, ...args] = process.argv.slice(2);
const t0 = performance.now();
const input: Uint8Array = process.stdin.isTTY ? new Uint8Array(0) : new Uint8Array(readFileSync(0));
// MOUNT=VFSDIR:HOSTDIR (comma-separated): a host directory's files, read
// when first opened.
const mounts = Object.fromEntries(
  (process.env.MOUNT || '')
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split(':')),
);
// VM_NAME=VALUE: NAME=VALUE in the node's environment.
const env = Object.fromEntries(
  Object.entries(process.env)
    .filter(([name]) => name.startsWith('VM_'))
    .map(([name, value]) => [name.slice(3), value ?? '']),
);
const node = await start({
  site,
  args,
  cwd: process.env.CWD,
  env,
  mounts,
  // BOOT=NAME,...: the boot images (NAME.tar.gz) to unpack, by default
  // every one the site has (none: every file comes lazily).
  boot: process.env.BOOT ? process.env.BOOT.split(',') : undefined,
  // The page's esbuild and tailwind (their packages' page programs) are
  // none here: stand-ins that say their versions (the Hex packages ask at
  // boot) and fail otherwise.
  programs: { esbuild, tailwind },
  tty: !!process.env.TTY,
  onMode: process.env.TTY ? (raw) => console.error(`[tty ${raw ? 'raw' : 'cooked'}]`) : undefined,
  onFetch: process.env.SHOW_FETCH ? (source) => console.error('fetch', source) : undefined,
  trace: !!process.env.TRACE_NET,
});
const t2 = performance.now();
// HTTP=PORT/PATH,...: once the node listens on PORT, GET each PATH from it
// (one after another) and print the response's status line. STOP_AFTER
// (ms): interrupt the node then (a server never halts by itself).
// STOP_SERVED (ms): interrupt it that long after the last response.
const network = node.network;
const requests = (process.env.HTTP || '')
  .split(',')
  .filter(Boolean)
  .map((r) => {
    const at = r.indexOf('/');
    return { port: Number(r.slice(0, at)), path: r.slice(at) };
  });
let current: {
  port: number;
  path: string;
  response: Uint8Array;
  done: boolean;
  t0: number;
} | null = null;
let nextId = 1;
let served: number | null = null;
// Whether the node should stop now.
const pump = (): boolean => {
  if (process.env.STOP_AFTER && performance.now() - t2 > Number(process.env.STOP_AFTER))
    return true;
  if (served !== null && performance.now() - served > Number(process.env.STOP_SERVED)) return true;
  if (current) {
    if (!current.done) return false;
    const text = new TextDecoder().decode(current.response);
    console.error(
      `[GET ${current.path}: ${text.split('\r\n')[0]} (${current.response.length} bytes, ${Math.round(performance.now() - current.t0)} ms)]`,
    );
    // HTTP_HEADERS=1: the response's headers too.
    if (process.env.HTTP_HEADERS) console.error(text.slice(0, text.indexOf('\r\n\r\n')));
    // HTTP_BODY=FILE: the last response's body.
    if (process.env.HTTP_BODY)
      writeFileSync(process.env.HTTP_BODY, current.response.subarray(text.indexOf('\r\n\r\n') + 4));
    current = null;
    if (!requests.length && process.env.STOP_SERVED) served = performance.now();
  }
  const next = requests[0];
  if (!next || !network.listeners.has(next.port)) return false;
  requests.shift();
  const request = { ...next, response: new Uint8Array(0), done: false, t0: performance.now() };
  const id = (nextId += 2);
  network.remote = {
    ports: [],
    send: (_, bytes) => {
      const joined = new Uint8Array(request.response.length + bytes.length);
      joined.set(request.response);
      joined.set(bytes, request.response.length);
      request.response = joined;
    },
    end: () => {
      request.done = true;
    },
    close: () => {
      request.done = true;
    },
    open() {},
  };
  network.accepted(id, next.port);
  network.data(
    id,
    new TextEncoder().encode(
      `GET ${next.path} HTTP/1.1\r\nhost: localhost:${next.port}\r\nconnection: close\r\n\r\n`,
    ),
  );
  current = request;
  return false;
};
if (input.length) node.input(input);
if (!process.env.NO_EOF) node.end();
// The Emscripten BEAM: its threads call back into this one, so the
// harness's own work (pump) runs on a timer.
const timer = setInterval(() => {
  if (pump()) node.kill(0);
}, 5);
let result;
try {
  result = await node.done;
} finally {
  clearInterval(timer);
}
// SNAPSHOT=VFSDIR:HOSTDIR: what the node wrote below VFSDIR, copied to
// HOSTDIR with its modification times.
if (process.env.SNAPSHOT) {
  const [at, host] = process.env.SNAPSHOT.split(':');
  result.snapshot(at, host);
}
// RECORD=FILE: the files fetched, one per line.
if (process.env.RECORD) writeFileSync(process.env.RECORD, result.fetched.join('\n'));
console.error(
  `[${result.unpacked} files + ${result.fetched.length} fetched, started in ${Math.round(t2 - t0)} ms, ran ${Math.round(performance.now() - t2)} ms, exit ${result.status}]`,
);
process.exit(result.status);
