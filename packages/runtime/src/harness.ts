// The Node harness as a library (docs/build.md): one node of the
// Emscripten BEAM (beam/run.ts) under Node, as the browser's worker runs
// it, over installed packages or a site manifest. Its whole tree is local:
// no files.js, no page programs. node.ts is its command line (the
// recording runs, tests/nif/layer.py); an otp package's node.js and its
// erl, and the elixir package's prepare, call it.
//
//   import { start } from '@elixir-playground/runtime/harness';
//   const node = await start({ packages: [otpDirectory], args: ['-noshell', '-eval', '…'] });
//   const { status } = await node.done;
import { readFile } from 'node:fs/promises';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { resolve } from 'node:path';
import { rootCertificates } from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Dir, File, untar, mount, bundled, type FsNode } from './wasi/fs';
import { Network } from './wasi/net';
import { environment, prepare, programs as nodePrograms } from './setup';
import { register } from './coreutils';
import { Site, type SiteManifest, type SiteRef } from './packages/manifest';
import { withLayer } from './packages/layer';
import type { FsLayer, PackageEntry } from './packages/types';
import { beamArgs } from './beam/args';
import { startBeam } from './beam/run';
import { TreeFs } from './beam/treefs';
import { vfs } from './vfs';
import { GIT_DASHED } from './git-remote';
import { fetcher } from './fetcher';
import { Processes, portProgram, wasmProgram } from './processes';
import type { Served } from './host/node';
import type { Programs } from './wasi/process';

// A package: its installed directory (with its package.json), or a
// descriptor of one (an otp package's index.js; `base` its directory's
// URL).
export type HarnessPackage = string | URL | (PackageEntry & { name: string });

export interface HarnessOptions {
  // The packages the node runs on, in order (OTP's among them), or a site
  // manifest: its file, or a site build.py made (target/site, whose
  // index.html names it).
  packages?: HarnessPackage[];
  site?: string;
  // erl's arguments.
  args: string[];
  // The working directory (default /work), and variables over the
  // packages' and the runtime's own.
  cwd?: string;
  env?: Record<string, string>;
  // Host directories in the node's tree ({ '/work/app': '/home/me/app' }):
  // their files, read when first opened. What the node writes stays in
  // memory (snapshot copies it out).
  mounts?: Record<string, string>;
  // The site's boot images to unpack (default: every one it names).
  boot?: string[];
  // Standard input is a terminal (raw input; onMode tells mode changes).
  tty?: boolean;
  size?: [columns: number, rows: number];
  onMode?: (raw: boolean) => void;
  stdout?: (bytes: Uint8Array) => void;
  stderr?: (bytes: Uint8Array) => void;
  // Plain HTTP on the node's ports: a request the node makes to
  // http://localhost:PORT/PATH is answered with Node's fetch of the URL
  // route(PATH) names (null: 404). An installer's mirror (HEX_BUILDS_URL)
  // pointed there reaches the internet without the node's own sockets.
  http?: Record<number, (path: string) => string | null | Promise<string | null>>;
  // Programs the node's ports run besides the runtime's (open_port spawn).
  programs?: Programs;
  // Each file the node fetches lazily, as it does.
  onFetch?: (path: string) => void;
  trace?: boolean;
}

export interface HarnessNode {
  // The node's network: its listeners, and (Network.accepted) connections
  // to them from here.
  network: Network;
  input(bytes: Uint8Array): void;
  end(): void;
  resize(columns: number, rows: number): void;
  signal(signum: number): boolean;
  kill(status: number): void;
  // Once the node has halted: its status, and what it did.
  done: Promise<HarnessResult>;
}

export interface HarnessResult {
  status: number;
  // Files unpacked from boot images, and those fetched lazily (their
  // paths, in order).
  unpacked: number;
  fetched: string[];
  // What the node wrote below `at` in its tree, copied to `host` with
  // modification times; the files' paths below `at`.
  snapshot(at: string, host: string): string[];
}

const local = (url: URL | null) => (url ? fileURLToPath(url) : '');

// A site manifest of installed packages: each one's package.json, its
// files at its directory (a descriptor's `base`), its `layer` read.
export async function packagesSite(packages: HarnessPackage[]): Promise<SiteRef> {
  const entries: [string, PackageEntry][] = [];
  for (const each of packages) {
    let name: string;
    let entry: PackageEntry;
    if (typeof each === 'string' || each instanceof URL) {
      const directory = typeof each === 'string' ? resolve(each) : fileURLToPath(each);
      const json = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'));
      if (!json.playground) continue;
      name = json.name;
      entry = {
        version: json.version,
        base: pathToFileURL(`${directory}/`).href,
        files: {},
        ...(json.peerDependencies ? { peerDependencies: json.peerDependencies } : {}),
        playground: json.playground,
      };
    } else ({ name, ...entry } = each);
    const base = entry.base;
    entries.push([
      name,
      await withLayer(
        entry,
        async (path) => JSON.parse(await readFile(new URL(path, base), 'utf8')) as FsLayer,
      ),
    ]);
  }
  return {
    url: pathToFileURL(`${process.cwd()}/`).href,
    manifest: { manifest: 2, packages: Object.fromEntries(entries), boot: null },
  };
}

// A site build.py made (its index.html names the manifest), or a manifest.
export function siteFile(site: string): SiteRef {
  const named = site.endsWith('.json')
    ? null
    : readFileSync(`${site}/index.html`, 'utf8').match(
        /<meta name="playground-site" content="([^"]+)"/,
      );
  const json = named ? `${site}${named[1]}` : site;
  return {
    url: pathToFileURL(resolve(json)).href,
    manifest: JSON.parse(readFileSync(json, 'utf8')) as SiteManifest,
  };
}

// A host directory's files below `at` in `root`, each read when first
// opened (`files`: their paths in the tree, without the leading slash, to
// the host's).
function mountHost(root: Dir, at: string, host: string, files: Map<string, string>): void {
  const top = at.replace(/^\/|\/$/g, '');
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
        root.mkdirs(`${top}/${rel}${name}`);
        walk(full, `${rel}${name}/`);
      } else {
        mount([[`${top}/${rel}${name}`, stat.size]], root);
        files.set(`${top}/${rel}${name}`, full);
      }
    }
  };
  root.mkdirs(top);
  walk(host, '');
}

// The node's connections to the harness's ports (`http`): each a Served
// connection that fetcher answers.
function httpRemote(network: Network, http: NonNullable<HarnessOptions['http']>): void {
  const open = new Map<number, Served>();
  const ports = Object.keys(http).map(Number);
  network.remote = {
    ports,
    open(id, port) {
      const connection: Served = {
        node: network,
        id,
        ondata: () => {},
        onend: () => {},
        onclose: () => {},
        write: (bytes) => network.data(id, bytes),
        end: () => network.ended(id),
        close: () => {
          open.delete(id);
          network.ended(id);
        },
      };
      open.set(id, connection);
      fetcher({ route: http[port], cache: null })(connection);
    },
    send: (id, bytes) => open.get(id)?.ondata(bytes),
    end: (id) => open.get(id)?.onend(),
    close: (id) => {
      open.get(id)?.onclose();
      open.delete(id);
    },
  };
}

export async function start(options: HarnessOptions): Promise<HarnessNode> {
  const ref = options.site ? siteFile(options.site) : await packagesSite(options.packages ?? []);
  const packages = new Site(ref);
  if (!packages.beam() || !packages.otp()) throw new Error('no OTP package among the packages');
  register(packages.programs());
  const root = new Dir();
  const hostFiles = new Map<string, string>();
  mount(await packages.tree(async (url) => JSON.parse(await readFile(local(url), 'utf8'))), root);
  for (const [at, host] of Object.entries(options.mounts ?? {}))
    mountHost(root, at, host, hostFiles);
  let unpacked = 0;
  for (const boot of packages.boots(options.boot))
    unpacked += await untar(await readFile(local(packages.boot(boot))), root);
  const fetched: string[] = [];
  prepare(root, { bin: packages.bin(), pagePrograms: Object.keys(options.programs ?? {}) });
  // Where OTP looks for the system's CA certificates (httpc asks for them
  // for any URL): the tls package's, else Node's own.
  if (!root.mkdirs('etc/ssl/certs').entries.has('ca-certificates.crt'))
    root.put(
      'etc/ssl/certs/ca-certificates.crt',
      new File(new TextEncoder().encode(rootCertificates.join('\n'))),
    );
  // Mounted host files, or the packages' bundles.
  const fromBundles = bundled(
    (bundle) => new Uint8Array(readFileSync(local(packages.bundle(bundle)))),
  );
  const fetchFile = (source: string, bundle: number): Uint8Array => {
    fetched.push(source);
    options.onFetch?.(source);
    const host = hostFiles.get(source);
    return host ? new Uint8Array(readFileSync(host)) : fromBundles(source, bundle);
  };
  const network = new Network();
  if (options.http) httpRemote(network, options.http);
  const env: Record<string, string> = {
    ...environment(packages),
    PWD: options.cwd ?? '/work',
    ERL_INETRC: '/etc/inetrc',
    ...options.env,
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
    args: beamArgs(options.args, { home: env.HOME, root: packages.otp()!.root }),
    env,
    cwd: env.PWD,
    root,
    fs: new TreeFs(root, fetchFile),
    network,
    programs: Object.assign(nodePrograms(vfs(root, fetchFile)), {
      git: portProgram(processes, 'git'),
      ...options.programs,
    }),
    tty: !!options.tty,
    size: options.size ?? [80, 24],
    onMode: options.onMode,
    stdout: options.stdout ?? ((bytes) => process.stdout.write(bytes)),
    stderr: options.stderr ?? ((bytes) => process.stderr.write(bytes)),
    trace: options.trace,
  });
  const snapshot = (at: string, host: string): string[] => {
    let from: FsNode | undefined = root;
    for (const part of at.split('/').filter(Boolean))
      from = (from as Dir | undefined)?.entries.get(part);
    const written: string[] = [];
    const walk = (dir: Dir, rel: string) => {
      for (const [name, node] of dir.entries) {
        if (node instanceof Dir) walk(node, `${rel}${name}/`);
        else if (node instanceof File && node.written) {
          const path = `${host}/${rel}${name}`;
          mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
          writeFileSync(path, node.bytes);
          const seconds = Number(node.mtime / 1000000000n);
          utimesSync(path, seconds, seconds);
          written.push(`${rel}${name}`);
        }
      }
    };
    if (from instanceof Dir) walk(from, '');
    return written;
  };
  return {
    network,
    input: (bytes) => beam.input(bytes),
    end: () => beam.end(),
    resize: (columns, rows) => beam.resize(columns, rows),
    signal: (signum) => beam.signal(signum),
    kill: (status) => beam.kill(status),
    done: beam.done.then((status) => ({ status, unpacked, fetched, snapshot })),
  };
}
