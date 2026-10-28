// The Emscripten BEAM (beam/run.ts) in Node, as the browser runs it:
//   node node.mjs SITE [erl args...] < input
// SITE is a site build.py made (target/site: the manifest its index.html
// names), or a site manifest (site/ID.json). Standard input is read whole
// first and then ends.
import { readFile } from 'node:fs/promises';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { Exit } from './wasi';
import { Dir, File, untar, mount, bundled, type FsNode } from './wasi/fs';
import { Network } from './wasi/net';
import { ENV, prepare, programs } from './setup';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from './coreutils';
import { Site, type SiteManifest } from './packages/manifest';
import { beamArgs } from './beam/args';
import { startBeam } from './beam/run';
import { TreeFs } from './beam/treefs';
import { vfs } from './vfs';
import { GIT_DASHED } from './git-remote';
import { Processes, portProgram, wasmProgram } from './processes';

const [site, ...args] = process.argv.slice(2);
// Its packages (the site manifest, build.py): the nodes' files, the BEAM,
// the programs.
const named = site.endsWith('.json')
  ? null
  : readFileSync(`${site}/index.html`, 'utf8').match(
      /<meta name="playground-site" content="([^"]+)"/,
    );
const siteJson = named ? `${site}${named[1]}` : site;
const packages = new Site({
  url: pathToFileURL(siteJson).href,
  manifest: JSON.parse(readFileSync(siteJson, 'utf8')) as SiteManifest,
});
register(packages.programs());
const local = (url: URL | null) => (url ? fileURLToPath(url) : '');
const t0 = performance.now();
let t2 = Infinity;
const root = new Dir();
const hostFiles = new Map<string, string>();
mount(await packages.tree(async (url) => JSON.parse(await readFile(local(url), 'utf8'))), root);
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
// BOOT=NAME,...: the boot images (NAME.tar.gz) to unpack, by default
// every one the site has (none: every file comes lazily).
const boots = process.env.BOOT ? process.env.BOOT.split(',') : packages.boots();
let files = 0;
for (const boot of boots) files += await untar(await readFile(local(packages.boot(boot))), root);
let fetched = 0;
const recorded: string[] = [];
prepare(root);
const t1 = performance.now();
const input: Uint8Array = process.stdin.isTTY ? new Uint8Array(0) : new Uint8Array(readFileSync(0));
// Mounted host files, or the site's bundles.
const fromBundles = bundled(
  (bundle) => new Uint8Array(readFileSync(local(packages.bundle(bundle)))),
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
// The Emscripten BEAM: its threads call back into this one, so the
// harness's own work (pump) runs on a timer.
// VM_NAME=VALUE: NAME=VALUE in the node's environment.
const env: Record<string, string> = {
  ...ENV,
  PWD: process.env.CWD || '/work',
  ERL_INETRC: '/etc/inetrc',
  ...Object.fromEntries(
    Object.entries(process.env)
      .filter(([name]) => name.startsWith('VM_'))
      .map(([name, value]) => [name.slice(3), value ?? '']),
  ),
};
// git itself (git.wasm), as the worker has it: a process of a table of
// its own, its dashed programs too (git-upload-pack).
const gitPath = local(packages.programs().get('git')?.url ?? null);
const gitModule =
  gitPath && existsSync(gitPath) ? new WebAssembly.Module(readFileSync(gitPath)) : null;
const processes: Processes = new Processes((program) => {
  const name = program.split('/').pop()!;
  return gitModule && (name === 'git' || GIT_DASHED.has(name))
    ? wasmProgram(processes, gitModule, {
        root,
        fetch: fetchFile,
        shared: null,
        argv0: name,
        defaults: { GIT_PAGER: 'cat' },
      })
    : null;
});
const beam = startBeam({
  module: packages.beam()!.loader.href,
  args: beamArgs(args, env.HOME),
  env,
  cwd: env.PWD,
  root,
  fs: new TreeFs(root, fetchFile),
  network,
  programs: Object.assign(programs(vfs(root, fetchFile)), { git: portProgram(processes, 'git') }),
  tty: !!process.env.TTY,
  size: [80, 24],
  onMode: process.env.TTY ? (raw) => console.error(`[tty ${raw ? 'raw' : 'cooked'}]`) : undefined,
  stdout: (bytes) => process.stdout.write(bytes),
  stderr: (bytes) => process.stderr.write(bytes),
  trace: !!process.env.TRACE_NET,
});
t2 = performance.now();
if (input.length) beam.input(input);
if (!process.env.NO_EOF) beam.end();
const timer = setInterval(() => {
  try {
    pump();
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    beam.kill(error.code);
  }
}, 5);
let status: number;
try {
  status = await beam.done;
} finally {
  clearInterval(timer);
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
process.exit(status);
