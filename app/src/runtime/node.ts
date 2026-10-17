// rotp.wasm under wasi/ in Node, as the browser runs it:
//   node node.mjs SITE [erl args...] < input
// SITE is a site build.py made (target/playground/site), or one of its
// builds (b/ID). Standard input is read whole first and then ends.
// A site built for the Emscripten BEAM (beam.mjs, PLAYGROUND_RUNTIME=otp)
// runs that instead (beam/run.ts), with the same erl arguments.
import { readFile } from 'node:fs/promises';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { WASI, Exit } from './wasi';
import { Dir, File, untar, mount, bundled, type FsNode } from './wasi/fs';
import { Network } from './wasi/net';
import { ENV, prepare, programs } from './setup';
import { beamArgs } from './beam/args';
import { vfs } from './vfs';

const [site, ...args] = process.argv.slice(2);
// A versioned site's build (b/ID/, build.py), or a flat one.
const builds = existsSync(`${site}/fs`) ? [] : readdirSync(`${site}/b`);
const dir = builds.length ? `${site}/b/${builds[0]}` : site;
const t0 = performance.now();
let t2 = Infinity;
const root = new Dir();
const hostFiles = new Map<string, string>();
mount(JSON.parse(await readFile(`${dir}/fs/manifest.json`, 'utf8')), root);
// MOUNT=VFSDIR:HOSTDIR (comma-separated): a host directory's files, read
// when first opened.
for (const pair of (process.env.MOUNT || '').split(',').filter(Boolean)) {
  const [at, host] = pair.split(':');
  const walk = (from: string, rel: string) => {
    for (const name of readdirSync(from)) {
      const full = `${from}/${name}`;
      let stat: Stats;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        root.mkdirs(`${at}/${rel}${name}`);
        walk(full, `${rel}${name}/`);
      } else {
        mount([[`${at.replace(/^\//, '')}/${rel}${name}`, stat.size]], root);
        hostFiles.set(`${at.replace(/^\//, '')}/${rel}${name}`, full);
      }
    }
  };
  walk(host, '');
}
// BOOT=NAME,...: the boot images (fs/NAME.tar.gz) to unpack, by default
// every one the site has.
const boots = process.env.BOOT
  ? process.env.BOOT.split(',')
  : readdirSync(`${dir}/fs`)
      .filter((name) => /^boot.*\.tar\.gz$/.test(name))
      .map((name) => name.slice(0, -7));
let files = 0;
for (const boot of boots) files += await untar(await readFile(`${dir}/fs/${boot}.tar.gz`), root);
let fetched = 0;
const recorded: string[] = [];
prepare(root);
const t1 = performance.now();
const beam = existsSync(`${dir}/beam.mjs`);
const module = beam ? null : await WebAssembly.compile(await readFile(`${dir}/rotp.wasm`));
let input: Uint8Array = process.stdin.isTTY ? new Uint8Array(0) : new Uint8Array(readFileSync(0));
const wait = new Int32Array(new SharedArrayBuffer(4));
// Mounted host files, or the site's bundles.
const fromBundles = bundled(
  (bundle) => new Uint8Array(readFileSync(`${dir}/fs/bundles/${bundle}.tar`)),
);
function fetchFile(source: string, bundle: number): Uint8Array {
  fetched++;
  recorded.push(source);
  if (process.env.SHOW_FETCH) console.error('fetch', source);
  const host = hostFiles.get(source);
  return host ? new Uint8Array(readFileSync(host)) : fromBundles(source, bundle);
}
// HTTP=PORT/PATH,...: once the node listens on PORT, GET each PATH from it
// (one after another) and print the response's status line. STOP_AFTER
// (ms): interrupt the node then (a server never halts by itself).
// STOP_SERVED (ms): interrupt it that long after the last response.
const network = new Network();
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
const pump = () => {
  if (process.env.STOP_AFTER && performance.now() - t2 > Number(process.env.STOP_AFTER))
    throw new Exit(0);
  if (served !== null && performance.now() - served > Number(process.env.STOP_SERVED))
    throw new Exit(0);
  if (current) {
    if (!current.done) return;
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
  if (!next || !network.listeners.has(next.port)) return;
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
};
const wasi = new WASI({
  args: ['erl', ...args],
  env: {
    ...ENV,
    PWD: process.env.CWD || '/work',
    ...(Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k.startsWith('ROTP_')),
    ) as Record<string, string>),
  },
  root,
  // TTY=1: the standard streams are an 80x24 terminal that takes raw
  // input; its mode changes go to standard error.
  ...(process.env.TTY
    ? {
        tty: true,
        terminal: { mode: (mode) => console.error(`[tty ${mode}]`), size: () => [80, 24] },
      }
    : {}),
  // NO_EOF=1: once read, standard input waits instead of ending (IEx
  // halts at its end).
  stdin(max) {
    if (!input.length && process.env.NO_EOF) return null;
    const part = input.subarray(0, max);
    input = input.subarray(part.length);
    return part;
  },
  stdout: (bytes) => process.stdout.write(bytes),
  stderr: (bytes) => process.stderr.write(bytes),
  sleep: (ms) => Atomics.wait(wait, 0, 0, Math.min(ms, 5)),
  network,
  pump,
  programs: programs(vfs(root, fetchFile), (name, version) => {
    const path = `${dir}/nif/${name}-${version}.tar`;
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }),
  fetch: fetchFile,
});
// TRACE_WASI=1: every WASI call and its result, on standard error.
if (process.env.TRACE_WASI) {
  const calls = wasi.imports.wasi_snapshot_preview1;
  for (const [name, fn] of Object.entries(calls)) {
    calls[name] = (...a) => {
      const r = fn(...a);
      console.error(`wasi ${name}(${a.join(',')}) = ${r}`);
      return r;
    };
  }
}
// A threaded node (rotp.wasm for wasm32-wasip1-threads, which imports its
// memory) runs its threads in workers on a shared memory, and this thread
// serves their WASI calls (threads.ts); otherwise the node runs here.
const threaded =
  !!module &&
  WebAssembly.Module.imports(module).some((i) => i.module === 'env' && i.name === 'memory');
let status: number | null;
if (beam) {
  // The Emscripten BEAM: its threads call back into this one, so the
  // harness's own work (pump) runs on a timer.
  const { startBeam } = await import('./beam/run');
  const { TreeFs } = await import('./beam/treefs');
  const { pathToFileURL } = await import('node:url');
  const env = {
    ...ENV,
    PWD: process.env.CWD || '/work',
    ERL_INETRC: '/etc/inetrc',
  };
  const node = startBeam({
    module: pathToFileURL(`${dir}/beam.mjs`).href,
    args: beamArgs(args, env.HOME),
    env,
    cwd: env.PWD,
    root,
    fs: new TreeFs(root, fetchFile),
    network,
    programs: programs(vfs(root, fetchFile), (name, version) => {
      const path = `${dir}/nif/${name}-${version}.tar`;
      return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
    }),
    tty: !!process.env.TTY,
    size: [80, 24],
    onMode: process.env.TTY ? (raw) => console.error(`[tty ${raw ? 'raw' : 'cooked'}]`) : undefined,
    stdout: (bytes) => process.stdout.write(bytes),
    stderr: (bytes) => process.stderr.write(bytes),
    trace: !!process.env.TRACE_NET,
  });
  t2 = performance.now();
  if (input.length) node.input(input);
  if (!process.env.NO_EOF) node.end();
  const timer = setInterval(() => {
    try {
      pump();
    } catch (error) {
      if (!(error instanceof Exit)) throw error;
      node.kill(error.code);
    }
  }, 5);
  try {
    status = await node.done;
  } finally {
    clearInterval(timer);
  }
} else if (threaded) {
  const { Worker } = await import('node:worker_threads');
  const { channel, Host } = await import('./threads');
  const memory = new WebAssembly.Memory({ initial: 1024, maximum: 65536, shared: true });
  wasi.memory = memory;
  const chan = channel();
  const names = Object.keys(wasi.imports.wasi_snapshot_preview1);
  const start = (tid: number, startArg: number) =>
    new Worker(new URL('./thread-node.mjs', import.meta.url), {
      workerData: { module, memory, chan, slot: tid, names, tid, startArg },
    });
  const host = new Host(wasi, chan, { spawn: start });
  t2 = performance.now();
  start(0, 0);
  try {
    for (;;) {
      status = host.wait(5);
      if (status !== null) break;
      pump();
    }
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    status = error.code;
  }
} else {
  const instance = await WebAssembly.instantiate(module!, wasi.imports);
  t2 = performance.now();
  status = wasi.start(instance);
}
// SNAPSHOT=VFSDIR:HOSTDIR: what the node wrote below VFSDIR, copied to
// HOSTDIR with its modification times.
if (process.env.SNAPSHOT) {
  const fs = await import('node:fs');
  const [at, host] = process.env.SNAPSHOT.split(':');
  let start: FsNode | undefined = root;
  for (const part of at.split('/').filter(Boolean))
    start = (start as Dir | undefined)?.entries.get(part);
  const walk = (from: Dir, rel: string) => {
    for (const [name, node] of from.entries) {
      if (node instanceof Dir) walk(node, `${rel}${name}/`);
      else if (node instanceof File && node.written) {
        const path = `${host}/${rel}${name}`;
        fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
        fs.writeFileSync(path, node.bytes);
        const seconds = Number(node.mtime / 1000000000n);
        fs.utimesSync(path, seconds, seconds);
      }
    }
  };
  if (start instanceof Dir) walk(start, '');
}
// RECORD=FILE: the files fetched, one per line.
if (process.env.RECORD)
  (await import('node:fs')).writeFileSync(process.env.RECORD, recorded.join('\n'));
console.error(
  `[${files} files + ${fetched} fetched in ${Math.round(t1 - t0)} ms, compiled in ${Math.round(t2 - t1)} ms, ran ${Math.round(performance.now() - t2)} ms, exit ${status}]`,
);
process.exit(status!);
