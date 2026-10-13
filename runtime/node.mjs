// rotp.wasm under wasi.js in Node, as the browser runs it:
//   node node.mjs DIR [erl args...] < input
// DIR is a site build.py made (target/playground/elixir). Standard
// input is read whole first and then ends.
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { WASI, Dir, File, untar, mount, urandom } from './wasi.js';
import { git } from './programs.js';

const [dir, ...args] = process.argv.slice(2);
const t0 = performance.now();
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
root.mkdirs('work');
root.mkdirs('tmp');
root.put('dev/urandom', urandom());
root.put('usr/bin/git', new File());
root.put('rotp/bin/mix', new File(new TextEncoder().encode('Mix.CLI.main()\n')));
const t1 = performance.now();
const module = await WebAssembly.compile(await readFile(`${dir}/rotp.wasm`));
let input = process.stdin.isTTY ? new Uint8Array(0) : new Uint8Array(readFileSync(0));
const wait = new Int32Array(new SharedArrayBuffer(4));
const wasi = new WASI({
  args: ['erl', ...args],
  env: { ROOTDIR: '/rotp', HOME: '/work', LANG: 'C.UTF-8', PWD: process.env.CWD || '/work', MIX_HOME: '/work/.mix', PATH: '/usr/bin:/rotp/bin', MIX_ARCHIVES: '/rotp/mix/archives', ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ROTP_'))) },
  root,
  stdin(max) {
    const part = input.subarray(0, max);
    input = input.subarray(part.length);
    return part;
  },
  stdout: (bytes) => process.stdout.write(bytes),
  stderr: (bytes) => process.stderr.write(bytes),
  sleep: (ms) => Atomics.wait(wait, 0, 0, ms),
  programs: { git: git((source) => new Uint8Array(readFileSync(hostFiles.get(source) ?? `${dir}/fs/files/${source}`))) },
  fetch: (source) => (fetched++, process.env.SHOW_FETCH && console.error("fetch", source), new Uint8Array(readFileSync(hostFiles.get(source) ?? `${dir}/fs/files/${source}`))),
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
const t2 = performance.now();
const status = wasi.start(instance);
console.error(`[${files} files + ${fetched} fetched in ${Math.round(t1 - t0)} ms, compiled in ${Math.round(t2 - t1)} ms, ran ${Math.round(performance.now() - t2)} ms, exit ${status}]`);
process.exit(status);
