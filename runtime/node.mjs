// rotp.wasm under wasi.js in Node, as the browser runs it:
//   node node.mjs DIR [erl args...] < input
// DIR is a site build.py made (target/playground/elixir). Standard
// input is read whole first and then ends.
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { WASI, Dir, untar, mount, urandom } from './wasi.js';

const [dir, ...args] = process.argv.slice(2);
const t0 = performance.now();
const root = new Dir();
mount(JSON.parse(await readFile(`${dir}/fs/manifest.json`, 'utf8')), root);
const files = await untar(await readFile(`${dir}/fs/boot.tar.gz`), root);
let fetched = 0;
root.mkdirs('work');
root.mkdirs('tmp');
root.put('dev/urandom', urandom());
const t1 = performance.now();
const module = await WebAssembly.compile(await readFile(`${dir}/rotp.wasm`));
let input = process.stdin.isTTY ? new Uint8Array(0) : new Uint8Array(readFileSync(0));
const wait = new Int32Array(new SharedArrayBuffer(4));
const wasi = new WASI({
  args: ['erl', ...args],
  env: { ROOTDIR: '/rotp', HOME: '/work', LANG: 'C.UTF-8', PWD: '/work', ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ROTP_'))) },
  root,
  stdin(max) {
    const part = input.subarray(0, max);
    input = input.subarray(part.length);
    return part;
  },
  stdout: (bytes) => process.stdout.write(bytes),
  stderr: (bytes) => process.stderr.write(bytes),
  sleep: (ms) => Atomics.wait(wait, 0, 0, ms),
  fetch: (source) => (fetched++, process.env.SHOW_FETCH && console.error("fetch", source), new Uint8Array(readFileSync(`${dir}/fs/files/${source}`))),
});
const instance = await WebAssembly.instantiate(module, wasi.imports);
const t2 = performance.now();
const status = wasi.start(instance);
console.error(`[${files} files + ${fetched} fetched in ${Math.round(t1 - t0)} ms, compiled in ${Math.round(t2 - t1)} ms, ran ${Math.round(performance.now() - t2)} ms, exit ${status}]`);
process.exit(status);
