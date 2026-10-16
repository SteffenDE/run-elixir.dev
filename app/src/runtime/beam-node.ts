// The Emscripten BEAM (playground/beam) under Node, over the playground's
// tree (wasi/fs.ts) as the browser will run it:
//   node beam-node.mjs BEAM [beam args...] < input
// BEAM is a dist build.sh wrote (beam.mjs, beam.wasm, otp/); the beam
// args are the emulator's flags, `--`, then init's (as erlexec passes
// them). MOUNT=VFSDIR:HOSTDIR,... puts host directories in the tree, read
// when first opened; BEAM's otp/ is mounted at /otp. CWD is the working
// directory (default /work).
import { existsSync, readFileSync, readdirSync, statSync, type Stats } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Dir, mount } from './wasi/fs';
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
let t2 = Infinity;
const status = await new Promise<number>((resolve) => {
  createModule({
    arguments: args,
    wasmMemory,
    print: (line: string) => process.stdout.write(line + '\n'),
    printErr: (line: string) => {
      if (!line.includes('Heap resize call')) process.stderr.write(line + '\n');
    },
    onExit: resolve,
    preRun: [
      // The tree's top directories, each a PROXYFS mount over `fs`.
      // oxlint-disable-next-line typescript/no-explicit-any -- Emscripten's module.
      (module: any) => {
        const { FS } = module;
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
