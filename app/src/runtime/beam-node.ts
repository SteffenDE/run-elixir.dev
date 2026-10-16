// The Emscripten BEAM (playground/beam) under Node, over the playground's
// tree (wasi/fs.ts) as the browser will run it:
//   node beam-node.mjs BEAM [beam args...] < input
// BEAM is a dist build.sh wrote (beam.mjs, beam.wasm, otp/); the beam
// args are the emulator's flags, `--`, then init's (as erlexec passes
// them). MOUNT=VFSDIR:HOSTDIR,... puts host directories in the tree, read
// when first opened; BEAM's otp/ is mounted at /otp. CWD is the working
// directory (default /work); VM_NAME=VALUE sets NAME in the node's
// environment.
//
// TCP is the playground's Network (wasi/net.ts), as Module.beamNetwork
// (playground/beam/socket); start the node with -kernel inet_backend
// socket. HTTP=PORT/PATH,... GETs each path once the node listens on the
// port, prints each response's status line, and STOP_SERVED=MS stops the
// node that long after the last.
import { existsSync, readFileSync, readdirSync, statSync, type Stats } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Dir, File, mount } from './wasi/fs';
import { Network } from './wasi/net';
import { TreeFs } from './beam/treefs';

const [dist, ...args] = process.argv.slice(2);
const t0 = performance.now();
const root = new Dir();
const hostFiles = new Map<string, string>();
const mounts = [`/otp:${dist}/otp`, ...(process.env.MOUNT || '').split(',').filter(Boolean)];
for (const pair of mounts) {
  const [at, host] = pair.split(':');
  const base = at.replace(/^\//, '');
  root.mkdirs(base);
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
        root.mkdirs(`${base}/${rel}${name}`);
        walk(full, `${rel}${name}/`);
      } else {
        mount([[`${base}/${rel}${name}`, stat.size, Math.floor(stat.mtimeMs / 1000)]], root);
        hostFiles.set(`${base}/${rel}${name}`, full);
      }
    }
  };
  walk(host, '');
}
root.mkdirs('work');
root.mkdirs('tmp');
// Names from the hosts file only: there is no inet_gethost.
const textFile = (string: string) => new File(new TextEncoder().encode(string));
root.put('etc/hosts', textFile('127.0.0.1 localhost\n::1 localhost\n'));
root.put('etc/inetrc', textFile('{lookup, [file]}.\n'));
let fetched = 0;
const fs = new TreeFs(root, (source) => {
  fetched++;
  if (process.env.SHOW_FETCH) console.error('fetch', source);
  return new Uint8Array(readFileSync(hostFiles.get(source)!));
});
const t1 = performance.now();

if (!existsSync(`${dist}/beam.mjs`)) throw new Error(`${dist}: no beam.mjs`);
const { default: createModule } = await import(
  /* @vite-ignore */ pathToFileURL(`${dist}/beam.mjs`).href
);
const wasmMemory = new WebAssembly.Memory({ initial: 1024, maximum: 65536, shared: true });

const network = new Network();
const requests = (process.env.HTTP || '')
  .split(',')
  .filter(Boolean)
  .map((r) => ({ port: Number(r.slice(0, r.indexOf('/'))), path: r.slice(r.indexOf('/')) }));
let nextId = 1;
// One request at a time, each once its port listens.
const ask = () => {
  const next = requests[0];
  if (!next || !network.listeners.has(next.port)) return setTimeout(ask, 50);
  requests.shift();
  const started = performance.now();
  let response = new Uint8Array(0);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const text = new TextDecoder().decode(response);
    console.error(
      `[GET ${next.path}: ${text.split('\r\n')[0]} (${response.length} bytes, ${Math.round(performance.now() - started)} ms)]`,
    );
    if (process.env.HTTP_HEADERS) console.error(text.slice(0, text.indexOf('\r\n\r\n')));
    if (requests.length) ask();
    else if (process.env.STOP_SERVED)
      setTimeout(() => process.exit(0), Number(process.env.STOP_SERVED));
  };
  const id = (nextId += 2);
  network.remote = {
    ports: [],
    send: (_, bytes) => {
      const joined = new Uint8Array(response.length + bytes.length);
      joined.set(response);
      joined.set(bytes, response.length);
      response = joined;
    },
    end: finish,
    close: finish,
    open() {},
  };
  network.accepted(id, next.port);
  network.data(
    id,
    new TextEncoder().encode(
      `GET ${next.path} HTTP/1.1\r\nhost: localhost:${next.port}\r\nconnection: close\r\n\r\n`,
    ),
  );
};
if (requests.length) ask();
let t2 = Infinity;
const status = await new Promise<number>((resolve) => {
  createModule({
    arguments: args,
    wasmMemory,
    beamNetwork: network,
    // TRACE_NET=1: socket.js's calls and events, on standard error.
    beamSocketTrace: !!process.env.TRACE_NET,
    print: (line: string) => process.stdout.write(line + '\n'),
    printErr: (line: string) => {
      if (!line.includes('Heap resize call')) process.stderr.write(line + '\n');
    },
    onExit: resolve,
    preRun: [
      // The tree's top directories, each a PROXYFS mount over `fs`.
      // oxlint-disable-next-line typescript/no-explicit-any -- Emscripten's module.
      (module: any) => {
        const { FS, ENV } = module;
        ENV.ERL_INETRC = '/etc/inetrc';
        // VM_NAME=VALUE: NAME=VALUE in the node's environment.
        for (const [name, value] of Object.entries(process.env))
          if (name.startsWith('VM_')) ENV[name.slice(3)] = value;
        for (const name of root.entries.keys()) {
          const at = `/${name}`;
          if (!FS.analyzePath(at).exists) FS.mkdir(at);
          FS.mount(FS.filesystems.PROXYFS, { root: at, fs }, at);
        }
        FS.chdir(process.env.CWD || '/work');
        t2 = performance.now();
      },
    ],
  });
});
console.error(
  `[${fetched} fetched, tree in ${Math.round(t1 - t0)} ms, started in ${Math.round(t2 - t1)} ms, ran ${Math.round(performance.now() - t2)} ms, exit ${status}]`,
);
process.exit(status);
