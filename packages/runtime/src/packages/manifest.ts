// The site manifest (site/ID.json, runtime/build.py; docs/packages.md):
// the packages a site has, their versions, where their files are
// (/npm/@elixir-playground/NAME@VERSION/), and what each declares in its
// package.json's `playground` field; and the boot recordings made for
// them. The runtime finds the BEAM, its
// programs and the nodes' files through it, never by a path of its own.
import type { Manifest } from '../wasi/fs';
import type { FsLayer, PackageEntry, Playground, SiteManifest } from './types';

export type {
  Boot,
  FileEntry,
  FsLayer,
  PackageEntry,
  Playground,
  Program,
  SiteManifest,
} from './types';

export const SCOPE = '@elixir-playground';
export const RUNTIME_PACKAGE = `${SCOPE}/runtime`;

// What goes from frame to worker: the manifest and its own URL, which its
// bases are relative to.
export interface SiteRef {
  url: string;
  manifest: SiteManifest;
}

export async function loadManifest(url: string | URL): Promise<SiteRef> {
  const href = new URL(url, globalThis.location?.href).href;
  const response = await fetch(href);
  if (!response.ok) throw new Error(`${href}: ${response.status}`);
  return { url: href, manifest: (await response.json()) as SiteManifest };
}

// A program as the runtime finds it: its module's URL.
export interface Registered {
  url: URL;
  multicall: boolean;
}

// A site manifest's files as URLs.
export class Site {
  readonly manifest: SiteManifest;
  readonly url: URL;

  constructor(ref: SiteRef) {
    this.manifest = ref.manifest;
    this.url = new URL(ref.url);
  }

  // The first package whose `playground` field has `field`.
  find<K extends keyof Playground>(
    field: K,
  ): { name: string; entry: PackageEntry; value: NonNullable<Playground[K]> } | null {
    for (const [name, entry] of Object.entries(this.manifest.packages)) {
      const value = entry.playground[field];
      if (value !== undefined && value !== null)
        return { name, entry, value: value as NonNullable<Playground[K]> };
    }
    return null;
  }

  file(name: string, file: string): URL {
    const entry = this.manifest.packages[name];
    if (!entry) throw new Error(`${name}: not on this site`);
    return new URL(file, new URL(entry.base, this.url));
  }

  // The emulator's loader (beam.mjs) and its module.
  beam(): { loader: URL; wasm: URL } | null {
    const otp = this.find('beam');
    if (!otp) return null;
    const { loader, wasm } = otp.value;
    return { loader: this.file(otp.name, loader), wasm: this.file(otp.name, wasm) };
  }

  // brush.wasm.
  shell(): URL | null {
    const shell = this.find('shell');
    return shell ? this.file(shell.name, shell.value) : null;
  }

  // Every package's programs, by name. A name two packages give is the
  // first one's.
  programs(): Map<string, Registered> {
    const out = new Map<string, Registered>();
    for (const [name, entry] of Object.entries(this.manifest.packages))
      for (const [program, { module, multicall = false }] of Object.entries(
        entry.playground.programs ?? {},
      ))
        if (!out.has(program)) out.set(program, { url: this.file(name, module), multicall });
    return out;
  }

  // The multi-call module (coreutils.wasm), which the exec frame compiles
  // once for every node; null without.
  multicall(): URL | null {
    for (const { url, multicall } of this.programs().values()) if (multicall) return url;
    return null;
  }

  // The packages' fs layers, in the manifest's order, each with the
  // first of the site's bundle numbers that are its (the layers' bundles
  // are numbered one after another).
  layers(): { name: string; layer: FsLayer; first: number }[] {
    const out = [];
    let first = 0;
    for (const [name, entry] of Object.entries(this.manifest.packages)) {
      const layer = entry.playground.fs;
      if (!layer) continue;
      out.push({ name, layer, first });
      first += layer.count;
    }
    return out;
  }

  // The nodes' tree without its bytes: every layer's manifest, its paths
  // below the layer's root (without the leading slash, as the tree lists
  // them), its bundles numbered as the site's. `load` reads one (fetch, or
  // a file).
  async tree(load: (url: URL) => Promise<Manifest> = fetchJson): Promise<Manifest> {
    const layers = await Promise.all(
      this.layers().map(async ({ name, layer, first }) =>
        (await load(this.file(name, layer.manifest))).map(
          ([path, size, mtime, bundle]): Manifest[number] =>
            bundle === undefined
              ? [below(layer.root, path), size, mtime]
              : [below(layer.root, path), size, mtime, first + bundle],
        ),
      ),
    );
    return layers.flat();
  }

  // OTP as installed: its version and its root (the otp package's layer:
  // bin/*.boot, lib/, releases/ below it), which erl starts from.
  otp(): { version: string; root: string } | null {
    const otp = this.find('otp');
    const root = otp?.entry.playground.fs?.root;
    return otp && root ? { version: otp.value, root } : null;
  }

  // Elixir as installed: its version and its root (lib/APP/ebin below it:
  // elixir's launchers' -elixir_root and -pa).
  elixir(): { version: string; root: string } | null {
    const elixir = this.find('elixir');
    const root = elixir?.entry.playground.fs?.root;
    return elixir && root ? { version: elixir.value, root } : null;
  }

  // Every package's commands: /usr/bin/NAME → the file's path in the
  // tree. A name two packages give is the first one's.
  bin(): Map<string, string> {
    const out = new Map<string, string>();
    for (const entry of Object.values(this.manifest.packages)) {
      const root = entry.playground.fs?.root;
      if (!root) continue;
      for (const [name, file] of Object.entries(entry.playground.bin ?? {}))
        if (!out.has(name)) out.set(name, at(root, file));
    }
    return out;
  }

  // The variables the packages give every node (ROOTDIR, MIX_ARCHIVES, …),
  // each an absolute path in the tree.
  environment(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of Object.values(this.manifest.packages)) {
      const root = entry.playground.fs?.root;
      if (!root) continue;
      for (const [name, file] of Object.entries(entry.playground.env ?? {}))
        out[name] ??= at(root, file);
    }
    return out;
  }

  // The site's bundle `n`: its layer's tar.
  bundle(n: number): URL {
    for (const { name, layer, first } of this.layers())
      if (n >= first && n < first + layer.count)
        return this.file(name, `${layer.bundles}${n - first}.tar`);
    throw new Error(`no bundle ${n} on this site`);
  }

  // A boot image (boot, boot-phoenix), and those the site has.
  boot(image: string): URL {
    const boot = this.manifest.boot;
    if (!boot?.images.includes(image)) throw new Error(`this site has no boot image ${image}`);
    return new URL(`${image}.tar.gz`, new URL(boot.base, this.url));
  }
  // Recordings are optional: keep the requested order, loading only
  // images this site provides. Everything else comes from lazy bundles.
  boots(requested?: readonly string[]): string[] {
    const available = this.manifest.boot?.images ?? [];
    return requested ? requested.filter((name) => available.includes(name)) : available;
  }

  // What a project's kept changes were made over: the layers' versions,
  // as one (a kept project drops its template's build when it changes).
  fsVersion(): string {
    return digest(
      this.layers()
        .map(({ name, layer }) => `${name}@${layer.version}`)
        .sort()
        .join('\n'),
    );
  }

  tls(): { module: string; roots: string } | null {
    const tls = this.find('tls');
    return tls
      ? {
          module: this.file(tls.name, tls.value.module).href,
          roots: this.file(tls.name, tls.value.roots).href,
        }
      : null;
  }

  tailscale(): { module: URL; glue: URL } | null {
    const tailscale = this.find('tailscale');
    if (!tailscale) return null;
    const { module, glue } = tailscale.value;
    return { module: this.file(tailscale.name, module), glue: this.file(tailscale.name, glue) };
  }

  // The OTP and Elixir the site runs (create()'s sandbox.runtime).
  versions(): { otp: string; elixir: string } | null {
    const otp = this.find('otp')?.value;
    const elixir = this.find('elixir')?.value;
    return otp && elixir ? { otp, elixir } : null;
  }

  // A template of `kind`: its id and label, and its root in the tree
  // (/work/playground), where its files are.
  template(kind: string): { id: string; label: string; root: string } | null {
    for (const entry of Object.values(this.manifest.packages)) {
      const template = entry.playground.template;
      const root = entry.playground.fs?.root;
      if (template?.kind === kind && root) return { id: template.id, label: template.label, root };
    }
    return null;
  }
}

// A layer's file as the tree lists it: below the layer's root, without
// the leading slash.
const below = (root: string, path: string) => `${root.replace(/^\/+/, '')}/${path}`;

// An absolute path of a layer's file: its root, or `file` below it.
const at = (root: string, file: string) =>
  file === '.' || file === '' ? root : `${root.replace(/\/+$/, '')}/${file}`;

async function fetchJson(url: URL): Promise<Manifest> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as Manifest;
}

// A 64-bit FNV-1a of `text`, as 16 hex digits: a name for it, not a seal.
function digest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
