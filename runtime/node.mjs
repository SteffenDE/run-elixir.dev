// rotp.wasm under wasi.js in Node, as the browser runs it:
//   node node.mjs DIR [erl args...] < input
// DIR is a site build.py made (target/playground/elixir). Standard
// input is read whole first and then ends.
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { WASI, Dir, File, Network, Exit, untar, mount, urandom } from './wasi.js';
import { ENV, prepare, programs } from './setup.js';

const [dir, ...args] = process.argv.slice(2);
const t0 = performance.now();
let t2 = Infinity;
const root = new Dir();
const hostFiles = new Map();
mount(JSON.parse(await readFile(`${dir}/fs/manifest.json`, 'utf8')), root);
// MOUNT=VFSDIR:HOSTDIR (comma-separated): a host directory's files, read
// when first opened.
import { readdirSync, statSync } from 'node:fs';
for (const pair of (process.env.MOUNT || '').split(',').filter(Boolean)) {
  const [at, host] = pair.split(':');
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const full = `${dir}/${name}`;
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) { root.mkdirs(`${at}/${rel}${name}`); walk(full, `${rel}${name}/`); }
      else mount([[`${at.replace(/^\//, '')}/${rel}${name}`, stat.size]], root), hostFiles.set(`${at.replace(/^\//, '')}/${rel}${name}`, full);
    }
  };
  walk(host, '');
}
const files = await untar(await readFile(`${dir}/fs/boot.tar.gz`), root);
let fetched = 0;
const recorded = [];
prepare(root);
const t1 = performance.now();
const module = await WebAssembly.compile(await readFile(`${dir}/rotp.wasm`));
let input = process.stdin.isTTY ? new Uint8Array(0) : new Uint8Array(readFileSync(0));
const wait = new Int32Array(new SharedArrayBuffer(4));
// HTTP=PORT/PATH,...: once the node listens on PORT, GET each PATH from it
// (one after another) and print the response's status line. STOP_AFTER
// (ms): interrupt the node then (a server never halts by itself).
const network = new Network();
const requests = (process.env.HTTP || '').split(',').filter(Boolean).map((r) => {
  const at = r.indexOf('/');
  return { port: Number(r.slice(0, at)), path: r.slice(at) };
});
let current = null;
let nextId = 1;
const pump = () => {
  if (process.env.STOP_AFTER && performance.now() - t2 > Number(process.env.STOP_AFTER)) throw new Exit(0);
  if (current) {
    if (!current.done) return;
    const text = new TextDecoder().decode(current.response);
    console.error(`[GET ${current.path}: ${text.split('\r\n')[0]} (${current.response.length} bytes, ${Math.round(performance.now() - current.t0)} ms)]`);
    // HTTP_HEADERS=1: the response's headers too.
    if (process.env.HTTP_HEADERS) console.error(text.slice(0, text.indexOf('\r\n\r\n')));
    // HTTP_BODY=FILE: the last response's body.
    if (process.env.HTTP_BODY) writeFileSync(process.env.HTTP_BODY, current.response.subarray(text.indexOf('\r\n\r\n') + 4));
    current = null;
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
    end: () => { request.done = true; },
    close: () => { request.done = true; },
    open() {},
  };
  network.accepted(id, next.port);
  network.data(id, new TextEncoder().encode(`GET ${next.path} HTTP/1.1\r\nhost: localhost:${next.port}\r\nconnection: close\r\n\r\n`));
  current = request;
};
const wasi = new WASI({
  args: ['erl', ...args],
  env: { ...ENV, PWD: process.env.CWD || '/work', ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ROTP_'))) },
  root,
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
  programs: programs((source) => new Uint8Array(readFileSync(hostFiles.get(source) ?? `${dir}/fs/files/${source}`))),
  fetch: (source) => (fetched++, process.env.SHOW_FETCH && console.error("fetch", source), recorded.push(source), new Uint8Array(readFileSync(hostFiles.get(source) ?? `${dir}/fs/files/${source}`))),
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
const instance = await WebAssembly.instantiate(module, wasi.imports);
t2 = performance.now();
const status = wasi.start(instance);
// SNAPSHOT=VFSDIR:HOSTDIR: what the node wrote below VFSDIR, copied to
// HOSTDIR with its modification times.
if (process.env.SNAPSHOT) {
  const fs = await import('node:fs');
  const [at, host] = process.env.SNAPSHOT.split(':');
  let start = root;
  for (const part of at.split('/').filter(Boolean)) start = start?.entries.get(part);
  const walk = (dir, rel) => {
    for (const [name, node] of dir.entries) {
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
if (process.env.RECORD) (await import('node:fs')).writeFileSync(process.env.RECORD, recorded.join('\n'));
console.error(`[${files} files + ${fetched} fetched in ${Math.round(t1 - t0)} ms, compiled in ${Math.round(t2 - t1)} ms, ran ${Math.round(performance.now() - t2)} ms, exit ${status}]`);
process.exit(status);
