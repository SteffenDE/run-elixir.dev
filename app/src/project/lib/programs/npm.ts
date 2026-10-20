// npm and npx on the page: packages from the npm registry, fetched by the
// page (registry.npmjs.org sends CORS headers; no request of ours needs a
// preflight, which it does not answer), checked against their integrity,
// kept in Cache Storage (playground-npm) and unpacked into node_modules
// over the node's files. `npm run` runs a script with the page's sh
// (brush), node_modules/.bin on PATH; npx runs a package's bin, installed
// first into ~/.npm/_npx when the project has none. Packages' install
// scripts do not run.
//
// The tree is laid out as npm lays it out: each package as high as it can
// go without another version of it in the way, nested under what needs it
// otherwise. A package-lock.json's versions are kept where they still
// satisfy, and one is written (lockfileVersion 3).
import { maxSatisfying, satisfies, valid, validRange } from 'semver';
import type { Files } from '@/runtime/host/files';
import { entries, gunzip } from '@/runtime/wasi/fs';
import type { Context, Process } from './tailwind';

const REGISTRY = 'https://registry.npmjs.org/';
const CACHE = 'playground-npm';
export const NPM_VERSION = '11.6.2';
// What packages' os and cpu fields are matched against: a WebAssembly
// build (napi-rs's wasm32-wasi packages) is taken, native ones are not.
const PLATFORM = { os: 'linux', cpu: 'wasm32' };

export type Program = (process: Process, context: Context) => void | Promise<void>;

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: string | Record<string, string>;
  os?: string[];
  cpu?: string[];
  engines?: Record<string, string>;
  hasInstallScript?: boolean;
  deprecated?: string;
  license?: string;
  dist: { tarball: string; integrity?: string; shasum?: string };
}

interface Packument {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, Manifest>;
}

// A package where it goes in the tree: `location` below the project
// ('node_modules/a', 'node_modules/a/node_modules/b').
interface Placed {
  location: string;
  manifest: Manifest;
  dev: boolean;
  optional: boolean;
}

interface Lock {
  packages?: Record<
    string,
    { version?: string; resolved?: string; integrity?: string; link?: boolean }
  >;
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
  [field: string]: unknown;
}

class NpmError extends Error {}

const decoder = new TextDecoder();

// The registry's metadata of a package, abbreviated (as npm install asks
// for it), each once per page.
const packuments = new Map<string, Promise<Packument>>();
function packument(name: string): Promise<Packument> {
  let found = packuments.get(name);
  if (!found) {
    found = fetch(`${REGISTRY}${name.replace('/', '%2f')}`, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
    }).then(async (response) => {
      if (response.status === 404)
        throw new NpmError(`${name}: no such package in the npm registry`);
      if (!response.ok) throw new NpmError(`${name}: the registry answered ${response.status}`);
      return response.json() as Promise<Packument>;
    });
    found.catch(() => packuments.delete(name));
    packuments.set(name, found);
  }
  return found;
}

// A dependency's spec: its package (an alias's own: npm:other@range) and
// its range, or what the playground cannot install.
function parseSpec(name: string, spec: string): { name: string; range: string } {
  if (spec.startsWith('npm:')) {
    const rest = spec.slice(4);
    const at = rest.lastIndexOf('@');
    return at > 0
      ? { name: rest.slice(0, at), range: rest.slice(at + 1) || '*' }
      : { name: rest, range: '*' };
  }
  if (
    /^(file:|link:|workspace:|git\+|git:|github:|https?:)/.test(spec) ||
    /^[\w-]+\/[\w.-]+(#.*)?$/.test(spec)
  )
    throw new NpmError(`${name}@${spec}: only registry versions install in the playground`);
  return { name, range: spec.trim() || '*' };
}

// The version a range (or a tag) takes from a package's versions: the
// latest tag's if it satisfies, else the highest that does.
function pick(doc: Packument, range: string): Manifest | null {
  const tagged = doc['dist-tags'][range];
  if (tagged) return doc.versions[tagged] ?? null;
  if (!validRange(range)) return null;
  const latest = doc['dist-tags'].latest;
  if (latest && satisfies(latest, range)) return doc.versions[latest];
  const best = maxSatisfying(Object.keys(doc.versions), range);
  return best ? doc.versions[best] : null;
}

// Whether an os or cpu field lets this platform in ("!x" excludes x).
function allows(list: string[] | undefined, value: string): boolean {
  if (!list?.length) return true;
  const excluded = list.filter((v) => v.startsWith('!')).map((v) => v.slice(1));
  const included = list.filter((v) => !v.startsWith('!'));
  return !excluded.includes(value) && (!included.length || included.includes(value));
}
const fits = (m: Manifest) => allows(m.os, PLATFORM.os) && allows(m.cpu, PLATFORM.cpu);

// napi-rs packages name their native builds as optional dependencies
// (PREFIX-linux-x64-gnu, PREFIX-darwin-arm64, …) but not their WebAssembly
// one, PREFIX-wasm32-wasi, which is the one that runs here: it, at their
// version, as one more optional dependency (left out if there is none).
const NATIVE = /^(.+)-(?:darwin|linux|win32|freebsd|android|openharmony|sunos|aix)-[\w-]+$/;
function wasmSibling(manifest: Manifest): Record<string, string> | null {
  const optional = manifest.optionalDependencies ?? {};
  for (const [name, version] of Object.entries(optional)) {
    const prefix = NATIVE.exec(name)?.[1];
    if (prefix && !(`${prefix}-wasm32-wasi` in optional))
      return { [`${prefix}-wasm32-wasi`]: version };
  }
  return null;
}

// A package's bins by name.
function bins(name: string, bin: PackageJson['bin']): Record<string, string> {
  if (!bin) return {};
  if (typeof bin === 'string') return { [name.split('/').pop()!]: bin };
  return bin;
}

// Where `name` is looked up from a package at `from` (its own
// node_modules, then each one above): the locations in that order.
function lookups(from: string, name: string): string[] {
  const out: string[] = [];
  for (let dir = from; ;) {
    out.push(`${dir ? `${dir}/` : ''}node_modules/${name}`);
    if (!dir) break;
    const at = dir.lastIndexOf('/node_modules/');
    dir = at === -1 ? '' : dir.slice(0, at);
  }
  return out;
}

interface Want {
  from: string;
  name: string;
  spec: string;
  dev: boolean;
  optional: boolean;
}

// The tree for a package.json, with what a lock had where it still fits.
async function resolveTree(pkg: PackageJson, lock: Lock | null, warn: (text: string) => void) {
  const tree = new Map<string, Placed>();
  let queue: Want[] = [];
  const want = (
    from: string,
    deps: Record<string, string> | undefined,
    dev: boolean,
    optional: boolean,
  ) => {
    for (const [name, spec] of Object.entries(deps ?? {}))
      queue.push({ from, name, spec, dev, optional });
  };
  want('', pkg.dependencies, false, false);
  want('', pkg.devDependencies, true, false);
  want('', pkg.optionalDependencies, false, true);

  while (queue.length) {
    const batch = queue;
    queue = [];
    // The metadata of this round's packages, together.
    await Promise.all(
      batch.map((w) => {
        try {
          return packument(parseSpec(w.name, w.spec).name).catch(() => null);
        } catch {
          return null;
        }
      }),
    );
    for (const w of batch) {
      let target: { name: string; range: string };
      let doc: Packument;
      try {
        target = parseSpec(w.name, w.spec);
        doc = await packument(target.name);
      } catch (error) {
        if (w.optional) continue;
        throw error;
      }
      const path = lookups(w.from, w.name);
      // What is in the way: the nearest copy that does not satisfy.
      let blocked = path.length;
      let found: Placed | null = null;
      for (let i = 0; i < path.length; i++) {
        const there = tree.get(path[i]);
        if (!there) continue;
        const range = doc['dist-tags'][target.range] ?? target.range;
        if (
          there.manifest.name === target.name &&
          satisfies(there.manifest.version, range, { includePrerelease: true })
        )
          found = there;
        else blocked = i;
        break;
      }
      if (found) {
        found.dev &&= w.dev;
        found.optional &&= w.optional;
        continue;
      }
      const location = path[Math.max(0, blocked - 1)] ?? path[path.length - 1];
      const locked = lock?.packages?.[location];
      const manifest =
        (locked?.version &&
        doc.versions[locked.version] &&
        satisfies(locked.version, doc['dist-tags'][target.range] ?? target.range, {
          includePrerelease: true,
        })
          ? doc.versions[locked.version]
          : null) ?? pick(doc, target.range);
      if (!manifest) {
        if (w.optional) continue;
        throw new NpmError(`${w.name}@${w.spec}: no version of ${target.name} matches`);
      }
      if (!fits(manifest)) {
        if (!w.optional)
          warn(
            `npm warn ${manifest.name}@${manifest.version}: not for this platform (${PLATFORM.os}, ${PLATFORM.cpu}); skipped\n`,
          );
        continue;
      }
      if (manifest.deprecated)
        warn(`npm warn deprecated ${manifest.name}@${manifest.version}: ${manifest.deprecated}\n`);
      tree.set(location, { location, manifest, dev: w.dev, optional: w.optional });
      want(location, manifest.dependencies, w.dev, w.optional);
      want(location, manifest.optionalDependencies, w.dev, true);
      want(location, wasmSibling(manifest) ?? undefined, w.dev, true);
      const peers = Object.fromEntries(
        Object.entries(manifest.peerDependencies ?? {}).filter(
          ([name]) => !manifest.peerDependenciesMeta?.[name]?.optional,
        ),
      );
      // A peer is wanted beside its package, from its parent.
      const parent = location.slice(0, location.lastIndexOf('node_modules/')).replace(/\/$/, '');
      want(parent, peers, w.dev, w.optional);
    }
  }
  return tree;
}

// A tarball's bytes: Cache Storage's copy, else the registry's, checked
// against the integrity the metadata names.
async function tarball(manifest: Manifest): Promise<Uint8Array<ArrayBuffer>> {
  const url = manifest.dist.tarball;
  const cache = await caches.open(CACHE).catch(() => null);
  let response = await cache?.match(url);
  let fresh = false;
  if (!response) {
    response = await fetch(url);
    if (!response.ok)
      throw new NpmError(
        `${manifest.name}@${manifest.version}: ${url} answered ${response.status}`,
      );
    fresh = true;
  }
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  await verify(manifest, bytes);
  if (fresh) await cache?.put(url, new Response(bytes)).catch(() => {});
  return bytes;
}

async function verify(manifest: Manifest, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const integrity = manifest.dist.integrity?.split(/\s+/).find((i) => i.startsWith('sha512-'));
  if (integrity) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes));
    if (btoa(String.fromCharCode(...digest)) !== integrity.slice(7))
      throw new NpmError(
        `${manifest.name}@${manifest.version}: its tarball does not match its integrity`,
      );
  } else if (manifest.dist.shasum) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== manifest.dist.shasum)
      throw new NpmError(
        `${manifest.name}@${manifest.version}: its tarball does not match its shasum`,
      );
  }
}

// A package's files from its tarball into `dir` (its first path part,
// "package/" mostly, dropped); its package.json.
async function unpack(fs: Files, manifest: Manifest, dir: string): Promise<PackageJson> {
  const tar = await gunzip(await tarball(manifest));
  const files: [string, Uint8Array][] = [];
  const dirs = new Set<string>([dir]);
  let json: PackageJson | null = null;
  for (const entry of entries(tar)) {
    if (entry.type !== '0' && entry.type !== '\0') continue;
    const relative = entry.name.split('/').slice(1).join('/');
    if (!relative || relative.split('/').includes('..')) continue;
    const path = `${dir}/${relative}`;
    dirs.add(path.slice(0, path.lastIndexOf('/')));
    files.push([path, entry.body]);
    if (relative === 'package.json') json = JSON.parse(decoder.decode(entry.body));
  }
  await fs.remove(dir).catch(() => {});
  for (const each of [...dirs].sort()) await fs.mkdir(each);
  for (let at = 0; at < files.length; at += 64)
    await Promise.all(files.slice(at, at + 64).map(([path, bytes]) => fs.write(path, bytes)));
  return json ?? { name: manifest.name, version: manifest.version };
}

async function readJson<T>(fs: Files, path: string): Promise<T | null> {
  try {
    return JSON.parse(decoder.decode(await fs.read(path))) as T;
  } catch {
    return null;
  }
}

// The project: the nearest directory up from `cwd` with a package.json.
async function projectRoot(fs: Files, cwd: string): Promise<string | null> {
  for (let dir = cwd; ; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') {
    if ((await fs.stat(`${dir === '/' ? '' : dir}/package.json`)) === 'file') return dir;
    if (dir === '/') return null;
  }
}

// `npm install` in `root`, with `add` (names with optional @spec) added
// to its dependencies (dev: its devDependencies). The number of packages
// it put in place.
async function install(
  fs: Files,
  root: string,
  add: string[],
  options: { dev: boolean; exact: boolean; save: boolean },
  out: (text: string) => void,
): Promise<{ added: number; total: number }> {
  const pkgPath = `${root}/package.json`;
  const pkg: PackageJson = (await readJson<PackageJson>(fs, pkgPath)) ?? {};
  const lock = await readJson<Lock>(fs, `${root}/package-lock.json`);
  let changed = false;
  for (const request of add) {
    const at = request.lastIndexOf('@');
    const [name, spec] =
      at > 0 ? [request.slice(0, at), request.slice(at + 1)] : [request, 'latest'];
    const target = parseSpec(name, spec);
    const manifest = pick(await packument(target.name), target.range);
    if (!manifest) throw new NpmError(`${request}: no version matches`);
    const field = options.dev ? 'devDependencies' : 'dependencies';
    const saved =
      valid(spec) || !validRange(spec) || spec === 'latest' || spec === '*'
        ? `${options.exact ? '' : '^'}${manifest.version}`
        : spec;
    const deps = {
      ...(pkg[field] as Record<string, string> | undefined),
      [name]: target.name !== name ? `npm:${target.name}@${saved}` : saved,
    };
    pkg[field] = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (options.dev) delete pkg.dependencies?.[name];
    else delete pkg.devDependencies?.[name];
    changed = true;
  }
  const tree = await resolveTree(pkg, lock, out);
  let added = 0;
  const scripts: string[] = [];
  const placed = [...tree.values()].sort((a, b) => a.location.length - b.location.length);
  // Unpacked a few at a time; what is there at its version stays.
  const jsons = new Map<string, PackageJson>();
  for (let at = 0; at < placed.length; at += 6) {
    await Promise.all(
      placed.slice(at, at + 6).map(async (p) => {
        const dir = `${root}/${p.location}`;
        const there = await readJson<PackageJson>(fs, `${dir}/package.json`);
        if (there?.version === p.manifest.version && there.name === p.manifest.name) {
          jsons.set(p.location, there);
          return;
        }
        jsons.set(p.location, await unpack(fs, p.manifest, dir));
        added++;
        if (p.manifest.hasInstallScript) scripts.push(`${p.manifest.name}@${p.manifest.version}`);
      }),
    );
  }
  // Bins beside each package (node_modules/.bin), as links to its file.
  for (const p of placed) {
    const json = jsons.get(p.location);
    const parent = `${root}/${p.location.slice(0, p.location.length - p.manifest.name.length - 1)}`;
    for (const [bin, file] of Object.entries(bins(p.manifest.name, json?.bin ?? p.manifest.bin))) {
      const link = `${parent}/.bin/${bin}`;
      await fs.mkdir(`${parent}/.bin`);
      await fs.unlink(link).catch(() => {});
      await fs.symlink(`../${p.manifest.name}/${file.replace(/^\.\//, '')}`, link);
    }
  }
  if (scripts.length)
    out(
      `npm warn install scripts not run (the playground does not run them): ${scripts.join(', ')}\n`,
    );
  if (changed && options.save) await fs.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  if (options.save)
    await fs.write(
      `${root}/package-lock.json`,
      `${JSON.stringify(lockfile(pkg, placed), null, 2)}\n`,
    );
  return { added, total: placed.length };
}

function lockfile(pkg: PackageJson, placed: Placed[]) {
  const packages: Record<string, unknown> = {
    '': {
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies,
      devDependencies: pkg.devDependencies,
      optionalDependencies: pkg.optionalDependencies,
    },
  };
  for (const p of [...placed].sort((a, b) => (a.location < b.location ? -1 : 1))) {
    const m = p.manifest;
    packages[p.location] = {
      version: m.version,
      resolved: m.dist.tarball,
      integrity: m.dist.integrity,
      ...(p.dev ? { dev: true } : {}),
      ...(p.optional ? { optional: true } : {}),
      ...(m.license ? { license: m.license } : {}),
      ...(m.dependencies ? { dependencies: m.dependencies } : {}),
      ...(m.optionalDependencies ? { optionalDependencies: m.optionalDependencies } : {}),
      ...(m.peerDependencies ? { peerDependencies: m.peerDependencies } : {}),
      ...(m.bin ? { bin: bins(m.name, m.bin) } : {}),
      ...(m.engines ? { engines: m.engines } : {}),
      ...(m.os ? { os: m.os } : {}),
      ...(m.cpu ? { cpu: m.cpu } : {}),
      ...(m.hasInstallScript ? { hasInstallScript: true } : {}),
    };
  }
  return { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages };
}

// Another program to its end: its exit status. Its output is ours, and a
// kill of ours is its.
function runProgram(program: Program, process: Process, context: Context): Promise<number> {
  return new Promise((resolve) => {
    let done = false;
    const inner: Process = {
      write: (data) => process.write(data),
      exit: (code = 0) => {
        if (done) return;
        done = true;
        resolve(code);
      },
      onkill: null,
      onowner: null,
    };
    process.onkill = () => inner.onkill?.();
    process.onowner = () => inner.onowner?.();
    Promise.resolve(program(inner, context)).catch((error) => {
      process.write(`${(error as Error).message}\n`);
      inner.exit(1);
    });
  });
}

const quote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

// PATH with every node_modules/.bin from `dir` up.
function binPath(dir: string, path = ''): string {
  const out: string[] = [];
  for (let at = dir; ; at = at.slice(0, at.lastIndexOf('/')) || '/') {
    out.push(`${at === '/' ? '' : at}/node_modules/.bin`);
    if (at === '/') break;
  }
  return [...out, path].filter(Boolean).join(':');
}

// A bin in node_modules/.bin from `dir` up: its path, or null.
async function findBin(fs: Files, dir: string, name: string): Promise<string | null> {
  for (const at of binPath(dir).split(':')) {
    const path = `${at}/${name}`;
    if ((await fs.stat(path)) === 'file') return path;
  }
  return null;
}

const HELP = `npm ${NPM_VERSION} on the playground's Node.js

  npm install [PACKAGE[@VERSION]...] [-D|--save-dev] [-E|--save-exact]
  npm ci                    install exactly as package-lock.json says
  npm run [SCRIPT] [-- ARGS]    (also npm test, npm start)
  npm exec PACKAGE [ARGS]   as npx
  npm init [-y]
  npm create NAME [ARGS]    npm init NAME: npx create-NAME ARGS

Packages come from registry.npmjs.org; install scripts do not run, and
packages with native code only (no WebAssembly build) do not load.
`;

// npm, with the page's programs (node, sh) to run what it runs.
export const npmProgram =
  (programs: () => Record<string, Program>) =>
  async (process: Process, context: Context): Promise<void> => {
    const fs = context.fs as unknown as Files;
    const out = (text: string) => process.write(text);
    const [command = 'help', ...rest] = context.args;
    const flags = new Set(rest.filter((a) => a.startsWith('-')));
    const names = rest.filter((a) => !a.startsWith('-'));
    const started = performance.now();
    const took = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;
    try {
      switch (command) {
        case 'install':
        case 'i':
        case 'add':
        case 'ci': {
          const root = (await projectRoot(fs, context.cwd)) ?? context.cwd;
          if (!(await fs.stat(`${root}/package.json`)))
            await fs.write(`${root}/package.json`, '{}\n');
          if (command === 'ci') await fs.remove(`${root}/node_modules`).catch(() => {});
          const { added, total } = await install(
            fs,
            root,
            command === 'ci' ? [] : names,
            {
              dev: flags.has('-D') || flags.has('--save-dev'),
              exact: flags.has('-E') || flags.has('--save-exact'),
              save: !flags.has('--no-save'),
            },
            out,
          );
          out(
            added
              ? `\nadded ${added} packages, ${total} in all, in ${took()}\n`
              : `\nup to date, ${total} packages, in ${took()}\n`,
          );
          return process.exit(0);
        }
        case 'run':
        case 'run-script':
        case 'test':
        case 't':
        case 'start': {
          const root = await projectRoot(fs, context.cwd);
          if (!root) throw new NpmError('no package.json here or above');
          const pkg = (await readJson<PackageJson>(fs, `${root}/package.json`)) ?? {};
          const scripts = pkg.scripts ?? {};
          const dash = context.args.indexOf('--');
          const name =
            command === 'run' || command === 'run-script'
              ? context.args[1]
              : command === 't'
                ? 'test'
                : command;
          if (!name) {
            out(
              Object.keys(scripts).length
                ? `Scripts in ${pkg.name ?? root}:\n${Object.entries(scripts)
                    .map(([k, v]) => `  ${k}\n    ${v}`)
                    .join('\n')}\n`
                : 'No scripts.\n',
            );
            return process.exit(0);
          }
          if (!(name in scripts)) throw new NpmError(`Missing script: "${name}"`);
          const extra = dash === -1 ? [] : context.args.slice(dash + 1);
          const sh = programs().sh;
          for (const step of [`pre${name}`, name, `post${name}`]) {
            if (!(step in scripts)) continue;
            const line =
              step === name && extra.length
                ? `${scripts[step]} ${extra.map(quote).join(' ')}`
                : scripts[step];
            out(
              `\n> ${pkg.name ?? ''}${pkg.version ? `@${pkg.version}` : ''} ${step}\n> ${line}\n\n`,
            );
            const env = {
              ...context.env,
              PATH: binPath(root, context.env.PATH),
              npm_lifecycle_event: step,
              npm_lifecycle_script: scripts[step],
              npm_package_name: pkg.name ?? '',
              npm_package_version: pkg.version ?? '',
              npm_package_json: `${root}/package.json`,
              npm_config_user_agent: `npm/${NPM_VERSION} node/v24.11.0 linux x64`,
              npm_execpath: '/usr/bin/npm',
              npm_node_execpath: '/usr/bin/node',
              INIT_CWD: context.cwd,
            };
            const code = await runProgram(sh, process, {
              ...context,
              args: ['-c', line],
              cwd: root,
              env,
            });
            if (code !== 0) return process.exit(code);
          }
          return process.exit(0);
        }
        case 'exec':
        case 'x':
          return process.exit(
            await npx(programs, process, { ...context, args: rest.filter((a) => a !== '--') }),
          );
        case 'create':
        case 'init': {
          // An initializer: its create- package's bin, with what follows.
          const at = rest.findIndex((a) => !a.startsWith('-'));
          if (at >= 0) {
            const args = rest.slice(at + 1).filter((a) => a !== '--');
            return process.exit(
              await npx(programs, process, { ...context, args: [initializer(rest[at]), ...args] }),
            );
          }
          if (command === 'create') throw new NpmError('npm create NAME: which initializer');
          const root = context.cwd;
          if (await fs.stat(`${root}/package.json`))
            throw new NpmError('package.json is there already');
          const name = root.split('/').pop() || 'project';
          const pkg = {
            name,
            version: '1.0.0',
            private: true,
            scripts: { test: 'echo "Error: no test specified" && exit 1' },
          };
          await fs.write(`${root}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
          out(`Wrote to ${root}/package.json\n`);
          return process.exit(0);
        }
        case '-v':
        case '--version':
        case 'version':
          out(`${NPM_VERSION}\n`);
          return process.exit(0);
        case 'help':
        case '-h':
        case '--help':
          out(HELP);
          return process.exit(0);
        default:
          throw new NpmError(`${command}: not a command the playground's npm has (npm help)`);
      }
    } catch (error) {
      out(`npm error ${(error as Error).message}\n`);
      return process.exit(1);
    }
  };

// npx PACKAGE[@VERSION] [ARGS]: the project's bin of that name, else the
// package installed into ~/.npm/_npx and its bin. Its exit status.
// npm init's initializer as the package it runs: foo → create-foo,
// @scope → @scope/create, @scope/foo → @scope/create-foo (a version kept).
export function initializer(name: string): string {
  const at = name.lastIndexOf('@');
  const [bare, version] = at > 0 ? [name.slice(0, at), name.slice(at)] : [name, ''];
  if (bare.startsWith('@')) {
    const [scope, rest] = bare.split('/');
    return `${scope}/${rest ? `create-${rest}` : 'create'}${version}`;
  }
  return `create-${bare}${version}`;
}

async function npx(
  programs: () => Record<string, Program>,
  process: Process,
  context: Context,
): Promise<number> {
  const fs = context.fs as unknown as Files;
  const [request, ...args] = context.args.filter((a, i) => i > 0 || !/^(-y|--yes)$/.test(a));
  if (!request) {
    process.write('npx: a package or command to run\n');
    return 1;
  }
  const at = request.lastIndexOf('@');
  const [name, spec] = at > 0 ? [request.slice(0, at), request.slice(at + 1)] : [request, 'latest'];
  let bin = spec === 'latest' ? await findBin(fs, context.cwd, name.split('/').pop()!) : null;
  if (!bin) {
    const home = context.env.HOME ?? '/home/user';
    const dir = `${home}/.npm/_npx/${name.replace('/', '+')}@${spec}`;
    await fs.mkdir(dir);
    if (!(await fs.stat(`${dir}/package.json`))) await fs.write(`${dir}/package.json`, '{}\n');
    const quiet = (_text: string) => {};
    await install(fs, dir, [`${name}@${spec}`], { dev: false, exact: true, save: true }, quiet);
    const json = await readJson<PackageJson>(fs, `${dir}/node_modules/${name}/package.json`);
    const found = bins(name, json?.bin);
    const short = name.split('/').pop()!;
    const chosen = found[short]
      ? short
      : Object.keys(found).length === 1
        ? Object.keys(found)[0]
        : null;
    if (!chosen) {
      process.write(
        `npx: ${name} has no bin to run${Object.keys(found).length ? ` (it has ${Object.keys(found).join(', ')})` : ''}\n`,
      );
      return 1;
    }
    bin = `${dir}/node_modules/.bin/${chosen}`;
  }
  return runProgram(programs().node, process, {
    ...context,
    args: [bin, ...args],
    env: { ...context.env, PATH: binPath(context.cwd, context.env.PATH) },
  });
}

export const npxProgram =
  (programs: () => Record<string, Program>) =>
  async (process: Process, context: Context): Promise<void> => {
    try {
      process.exit(await npx(programs, process, context));
    } catch (error) {
      process.write(`npx error ${(error as Error).message}\n`);
      process.exit(1);
    }
  };
