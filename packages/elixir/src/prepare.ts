// The elixir package's layer for a build (docs/packages.md, "Elixir"):
// Elixir's precompiled release from builds.hex.pm, with the Hex and rebar3
// that Mix installs for it, as Mix does it, on the site's own OTP (an otp
// package, under Node through the runtime's harness). No OTP or Elixir on
// the machine is needed.
//
//   await prepare({ build: '1.20.4-otp-29', otp: 'node_modules/@elixir-playground/otp-29.1.2', into: 'public/npm/@elixir-playground/elixir@3.0.0' });
//
// It writes versions/BUILD/ below `into`: fs.json (the layer's fs field,
// which create() reads as the descriptor's `layer`), fs/, licenses/, and
// prepared.json (what it was made of: the same again is not made twice).
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { start } from '@elixir-playground/runtime/harness';
import { BUILDS, DEFAULT, buildPath, parseBuild } from './builds.js';
import { writeLayer, type LayerFile, type WrittenLayer } from './layer.js';
import { unzip } from './zip.js';

// Where Mix installs Hex and rebar3 from (HEX_BUILDS_URL), and Elixir's
// builds.
const BUILDS_URL = 'https://builds.hex.pm';
// The applications of Elixir's release that a node loads (build.py's
// ELIXIR_APPS), and its scripts, the package's commands.
const APPS = ['elixir', 'eex', 'ex_unit', 'iex', 'logger', 'mix'];
const SCRIPTS = ['elixir', 'elixirc', 'iex', 'mix'];
// The harness's port that answers Mix's downloads.
const MIRROR_PORT = 4001;
// What a prepared build records (prepared.json); another number makes it
// again.
const FORMAT = 1;

export interface PrepareOptions {
  // An Elixir build, as builds.hex.pm names it (default: builds.ts's DEFAULT).
  build?: string;
  // An otp package's directory, of the OTP major the build is for.
  otp: string;
  // Where versions/BUILD/ goes: the elixir package's directory as the
  // site serves it.
  into: string;
  // Where downloaded releases are kept.
  cache?: string;
  // A build builds.ts does not list, checked against builds.txt.
  untested?: boolean;
  // Make it again, even when prepared.json says it is there.
  force?: boolean;
  log?: (line: string) => void;
}

export interface Prepared {
  build: string;
  elixir: string;
  // The otp package it was made with (name@version), and the Hex and
  // rebar3 Mix installed.
  otp: string;
  hex: string;
  rebar3: string;
  sha256: string;
  layer: WrittenLayer;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

// The build's SHA-256: builds.ts's, or (untested) builds.txt's.
async function checksum(build: string, untested: boolean): Promise<string> {
  if (BUILDS[build]) return BUILDS[build];
  if (!untested)
    throw new Error(
      `Elixir ${build} is not among the builds this package was tested with ` +
        `(${Object.keys(BUILDS).join(', ')}); ask for it as untested to prepare it anyway`,
    );
  const listed = new TextDecoder().decode(await download(`${BUILDS_URL}/builds/elixir/builds.txt`));
  const line = listed.split('\n').find((each) => each.startsWith(`v${build} `));
  if (!line) throw new Error(`Elixir ${build}: not on builds.hex.pm`);
  return line.split(' ')[3];
}

// The release's zip, from the cache or builds.hex.pm, checked.
async function release(build: string, expected: string, cache?: string): Promise<Uint8Array> {
  const kept = cache && join(cache, `elixir-v${build}.zip`);
  if (kept && existsSync(kept)) {
    const bytes = new Uint8Array(readFileSync(kept));
    if (sha256(bytes) === expected) return bytes;
  }
  const url = `${BUILDS_URL}/builds/elixir/v${build}.zip`;
  const bytes = await download(url);
  if (sha256(bytes) !== expected)
    throw new Error(`${url}: SHA-256 ${sha256(bytes)}, not ${expected}`);
  if (kept) {
    mkdirSync(cache!, { recursive: true });
    writeFileSync(kept, bytes);
  }
  return bytes;
}

// Every file below `top`, by its path relative to it.
function walk(top: string): string[] {
  const out: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else out.push(relative(top, path).split('\\').join('/'));
    }
  };
  if (existsSync(top)) visit(top);
  return out;
}

const packageJson = (directory: string) =>
  JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));

export async function prepare(options: PrepareOptions): Promise<Prepared> {
  const build = options.build ?? DEFAULT;
  const log = options.log ?? ((line: string) => console.error(line));
  const { elixir, otp: major } = parseBuild(build);
  const otpPackage = packageJson(options.otp);
  const otpVersion: string | undefined = otpPackage.playground?.otp;
  if (!otpVersion) throw new Error(`${options.otp}: not an otp package`);
  if (Number(otpVersion.split('.')[0]) !== major)
    throw new Error(`Elixir ${build} is for OTP ${major}, not ${otpPackage.name}`);
  const otp = `${otpPackage.name}@${otpPackage.version}`;
  const sha = await checksum(build, !!options.untested);
  const directory = join(options.into, buildPath(build));
  const record = join(directory, 'prepared.json');
  if (!options.force && existsSync(record)) {
    const before = JSON.parse(readFileSync(record, 'utf8'));
    if (before.format === FORMAT && before.sha256 === sha && before.otp === otp) {
      const { format: _, ...prepared } = before;
      return prepared as Prepared;
    }
  }

  log(`elixir: Elixir ${build} from builds.hex.pm`);
  const zip = await release(build, sha, options.cache);
  const scratch = mkdtempSync(join(tmpdir(), 'elixir-playground-'));
  try {
    const unpacked = join(scratch, 'elixir');
    const files: LayerFile[] = [];
    const texts: Record<string, Uint8Array> = {};
    for (const entry of unzip(zip)) {
      const [top, app, part] = entry.name.split('/');
      let path: string | null = null;
      if (top === 'lib' && APPS.includes(app) && ['ebin', 'priv', 'include'].includes(part))
        path = entry.name;
      else if (top === 'bin' && SCRIPTS.includes(app)) path = entry.name;
      else if (entry.name === 'LICENSE') texts.LICENSE = entry.data;
      if (!path) continue;
      files.push({ path, data: entry.data, executable: top === 'bin' });
      mkdirSync(dirname(join(unpacked, path)), { recursive: true });
      writeFileSync(join(unpacked, path), entry.data);
    }

    // Mix installs Hex and rebar3 into an empty MIX_HOME, from
    // builds.hex.pm through the harness's port: it checks Hex's and
    // rebar3's SHA-512 itself. Below /tmp: the node's own directories
    // are those its tree has when it starts.
    log(`elixir: Hex and rebar3 for Elixir ${elixir} on ${otp}`);
    const root = `/opt/elixir/${elixir}`;
    const output: string[] = [];
    const keep = (bytes: Uint8Array) => output.push(new TextDecoder().decode(bytes));
    const node = await start({
      packages: [options.otp],
      args: [
        '-noshell',
        '-elixir_root',
        `${root}/lib`,
        '-pa',
        `${root}/lib/elixir/ebin`,
        '-user',
        'elixir',
        '-extra',
        '-e',
        'Mix.start(); Mix.Tasks.Local.Hex.run(["--force"]); Mix.Tasks.Local.Rebar.run(["--force"])',
      ],
      mounts: { [root]: unpacked },
      env: { MIX_HOME: '/tmp/mix', HEX_BUILDS_URL: `http://localhost:${MIRROR_PORT}` },
      http: { [MIRROR_PORT]: (path) => `${BUILDS_URL}${path}` },
      stdout: keep,
      stderr: keep,
    });
    node.end();
    const result = await node.done;
    if (result.status !== 0)
      throw new Error(
        `Mix could not install Hex and rebar3 (exit ${result.status}):\n${output.join('')}`,
      );
    const mix = join(scratch, 'mix');
    result.snapshot('/tmp/mix', mix);
    const installed = walk(mix);
    const archives = installed.filter((path) => path.startsWith('archives/'));
    const rebar = installed.find((path) => /^elixir\/[^/]+\/rebar3$/.test(path));
    const hex = archives.map((path) => /^archives\/hex-([^/]+)\//.exec(path)?.[1]).find(Boolean);
    if (!hex || !rebar) throw new Error(`Mix installed no Hex or no rebar3:\n${output.join('')}`);
    for (const path of archives)
      files.push({ path: `mix/${path}`, data: new Uint8Array(readFileSync(join(mix, path))) });
    const rebar3 = new Uint8Array(readFileSync(join(mix, rebar)));
    files.push({ path: 'mix/rebar3', data: rebar3, executable: true });
    const rebarVersion =
      /Rebar3 (\S+)/.exec(new TextDecoder().decode(rebar3.subarray(0, 200)))?.[1] ?? 'unknown';

    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const layer = writeLayer(directory, files, root);
    writeFileSync(join(directory, 'fs.json'), JSON.stringify(layer, null, 1) + '\n');
    // What the layer has, and their licenses (all Apache-2.0).
    mkdirSync(join(directory, 'licenses'), { recursive: true });
    if (texts.LICENSE) writeFileSync(join(directory, 'licenses', 'elixir-LICENSE'), texts.LICENSE);
    writeFileSync(
      join(directory, 'licenses', 'README'),
      [
        `Elixir ${build}, Apache-2.0 (elixir-LICENSE): https://elixir-lang.org, ${BUILDS_URL}/builds/elixir/v${build}.zip`,
        `Hex ${hex}, Apache-2.0: https://hex.pm, as Mix installed it`,
        `rebar3 ${rebarVersion}, Apache-2.0: https://rebar3.org, as Mix installed it`,
        '',
      ].join('\n'),
    );
    const prepared: Prepared = {
      build,
      elixir,
      otp,
      hex,
      rebar3: rebarVersion,
      sha256: sha,
      layer,
    };
    writeFileSync(record, JSON.stringify({ format: FORMAT, ...prepared }, null, 1) + '\n');
    log(`elixir: ${directory} (${files.length} files, Hex ${hex}, rebar3 ${rebarVersion})`);
    return prepared;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
