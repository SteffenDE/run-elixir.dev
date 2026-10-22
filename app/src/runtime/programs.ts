import { entries } from './wasi/fs';
import type { Process, Program, ProgramContext } from './wasi/process';
import type { Vfs } from './vfs';

// A package's NIF library build for make: its tar, why there is none, or
// null.
export type NifSource = (
  name: string,
  version: string,
  say: (text: string) => void,
) => Uint8Array | string | null;

// Programs a playground node can run (open_port, System.cmd), in place of
// the OS's. Each gets its Process (write, exit) and { args, cwd, env }.
// fs: vfs.ts's files (readText).
export const ESBUILD_VERSION = '0.25.4';
export const TAILWIND_VERSION = '4.3.3';

export function esbuild(process: Process, { args }: ProgramContext): void {
  if (args[0] === '--version') {
    process.write(ESBUILD_VERSION + '\n');
    return process.exit(0);
  }
  process.write('esbuild: not yet available in the playground\n');
  process.exit(1);
}

export function tailwind(process: Process, { args }: ProgramContext): void {
  if (args[0] === '--help') {
    process.write(`\u2248 tailwindcss v${TAILWIND_VERSION}\n`);
    return process.exit(0);
  }
  process.write('tailwind: not yet available in the playground\n');
  process.exit(1);
}

// make, as elixir_make runs it to build a Hex package's native code: the
// package's NIF library built to WebAssembly (nif/), from the site
// or the playground's backend, into the app's priv directory (MIX_APP_PATH).
// nif(name, version, say): that build's tar (priv/...), a string saying why
// there is none, or null when nothing has one; say(text) tells the terminal
// how a build it waits for is getting on.
export const make =
  (fs: Vfs, nif: NifSource): Program =>
  (process, { args, cwd, env }) => {
    if (args.length && args.every((target) => target === 'clean')) return process.exit(0);
    const metadata = fs.readText(`${cwd}/hex_metadata.config`) ?? '';
    const field = (key: string) =>
      metadata.match(new RegExp(`\\{<<"${key}">>,\\s*<<"([^"]*)">>\\}`))?.[1];
    const [name, version] = [field('name'), field('version')];
    const app = env.MIX_APP_PATH;
    const say = (text: string) => process.write(`make: ${text}\n`);
    const tar = name && version && app ? nif(name, version, say) : null;
    if (!(tar instanceof Uint8Array)) {
      const what = name ? `${name} ${version}` : cwd;
      say(
        typeof tar === 'string'
          ? tar
          : `there is no WebAssembly build of ${what}'s native code in the playground`,
      );
      return process.exit(2);
    }
    for (const entry of entries(tar)) {
      const path = `${app}/${entry.name.replace(/\/$/, '')}`;
      if (entry.type === '5') fs.mkdir(path);
      else if (entry.type === '0') {
        fs.mkdir(path.slice(0, path.lastIndexOf('/')));
        fs.write(path, entry.body);
      }
    }
    process.write(
      `make: ${name} ${version}'s native code, built to WebAssembly for the playground\n`,
    );
    process.exit(0);
  };

// memsup, os_mon's port program for memory data (memsup.erl; the spawn
// driver frames its {packet, 1}): the node's memory as the system's. Its
// total is what the node's memory may grow to (4 GiB), its free what of
// that the node has not taken yet.
const SHOW_MEM = 1;
const SHOW_SYSTEM_MEM = 2;
const MEM_SYSTEM_TOTAL = 1;
const MEM_TOTAL = 2;
const MEM_FREE = 3;
const MEM_AVAIL = 12;
export const memsup: Program = (process, { memory }) => {
  const encoder = new TextEncoder();
  const packet = (bytes: Uint8Array) => process.write(new Uint8Array([bytes.length, ...bytes]));
  const value = (n: number) => packet(encoder.encode(n.toString(16)));
  const total = 4 * 1024 ** 3;
  const used = () => memory?.buffer.byteLength ?? 0;
  let pending = new Uint8Array(0);
  process.oninput = (bytes) => {
    pending = new Uint8Array([...pending, ...bytes]);
    while (pending.length && pending.length >= 1 + pending[0]) {
      const request = pending[1];
      pending = pending.subarray(1 + pending[0]);
      if (request === SHOW_MEM) {
        value(used());
        value(total);
      } else if (request === SHOW_SYSTEM_MEM) {
        for (const [tag, n] of [
          [MEM_SYSTEM_TOTAL, total],
          [MEM_TOTAL, total],
          [MEM_FREE, total - used()],
          [MEM_AVAIL, total - used()],
        ]) {
          packet(new Uint8Array([tag]));
          value(n);
        }
        packet(new Uint8Array([0]));
      } else return process.exit(0);
    }
  };
  process.onclose = () => process.exit(0);
};
