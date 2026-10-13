// The node in a Web Worker: rotp.wasm over wasi.js. The page shares
// standard input as a ring of bytes in a SharedArrayBuffer: control[0]
// counts bytes written (the node sleeps on it, so input wakes it),
// control[1] bytes read. Output goes back as messages.
import { WASI, Dir, untar, mount, urandom } from './wasi.js';

const RING = 1 << 16;

onmessage = async ({ data: { args, env, shared } }) => {
  const control = new Int32Array(shared, 0, 2);
  const ring = new Uint8Array(shared, 8, RING);
  const say = (kind, payload) => postMessage({ kind, payload });
  try {
    say('status', 'Loading OTP and Elixir…');
    const [image, manifest, module] = await Promise.all([
      fetch('fs/boot.tar.gz').then((r) => r.arrayBuffer()),
      fetch('fs/manifest.json').then((r) => r.json()),
      WebAssembly.compileStreaming(fetch('rotp.wasm')),
    ]);
    const root = new Dir();
    mount(manifest, root);
    const files = await untar(new Uint8Array(image), root);
    root.mkdirs('work');
    root.mkdirs('tmp');
    root.put('dev/urandom', urandom());
    say('status', `Booting (${files} files)…`);
    const wasi = new WASI({
      args,
      env,
      root,
      tty: true,
      fetch(source) {
        const request = new XMLHttpRequest();
        request.open('GET', `fs/files/${source}`, false);
        request.responseType = 'arraybuffer';
        request.send();
        if (request.status !== 200) throw new Error(`${source}: ${request.status}`);
        return new Uint8Array(request.response);
      },
      stdin(max) {
        const written = Atomics.load(control, 0);
        const read = Atomics.load(control, 1);
        if (written === read) return null;
        const count = Math.min(max, written - read);
        const bytes = new Uint8Array(count);
        for (let i = 0; i < count; i++) bytes[i] = ring[(read + i) % RING];
        Atomics.store(control, 1, read + count);
        return bytes;
      },
      stdout: (bytes) => say('out', bytes),
      stderr: (bytes) => say('out', bytes),
      sleep: (ms) => Atomics.wait(control, 0, Atomics.load(control, 1), ms),
    });
    const instance = await WebAssembly.instantiate(module, wasi.imports);
    say('status', 'running');
    say('exit', wasi.start(instance));
  } catch (error) {
    say('status', `failed: ${error.stack || error}`);
  }
};
