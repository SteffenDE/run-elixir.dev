// The site manifest (site/ID.json, runtime/build.py; docs/packages.md):
// the packages a site has, their versions, where their files are
// (/npm/@elixir-playground/NAME@VERSION/), and what each declares in its
// package.json's `playground` field; and the boot recordings made for
// them. The runtime finds the BEAM, its
// programs and the nodes' files through it, never by a path of its own.
import type { Manifest } from '../wasi/fs';

export const SCOPE = '@elixir-playground';
export const RUNTIME_PACKAGE = `${SCOPE}/runtime`;

// A package.json's `playground` field. Each package fills in what it is.
export interface Playground {
  // The ABI seams the package's files use, each at its version (host.json's
  // `provides` names what the runtime offers).
  abi?: Record<string, number>;
  // Programs by name, each a module of the package's, run with the name as
  // its argv[0].
  programs?: Record<string, Program>;
  // shell: the terminal's shell (brush.wasm).
  shell?: string;
  // otp-X: its version, the build's beamAbi id, the NIF ABI its libraries
  // are built for ("LAYER-MAJOR.MINOR": the erl_nif layer's protocol and
  // OTP's erl_nif.h, docs/nif.md), and the emulator's files.
  otp?: string;
  beamAbi?: string;
  nifAbi?: string;
  // (The loader's Emscripten glue loads its threads' script, beam.emu.mjs,
  // from beside itself: the package's own layout.)
  beam?: { loader: string; wasm: string };
  // elixir-X: its version, and the OTP it runs on (a semver range).
  elixir?: string;
  requires?: { otp?: string };
  // A template: its kind, id (a digest of its files, without its build),
  // label, and the OTP and Elixir it was compiled with.
  template?: { kind: string; id: string; label: string; otp: string; elixir: string };
  // tls: a Node.js process's TLS client and the roots it trusts.
  tls?: { module: string; roots: string };
  // tailscale: the apex's Tailscale node, and Go's glue for it (the Go
  // that built it has its own: wasm_exec.js).
  tailscale?: { module: string; glue: string };
  // claude: the Claude Code versions the preparer was tested with.
  claudeCode?: string;
  // api: the embedding API versions its client speaks.
  apiVersions?: number[];
  // The package's files in the nodes' tree: a layer of the fs image.
  fs?: FsLayer;
}

// A package's files in the nodes' tree (fs format 2): `manifest` lists
// them, [path, size, mtime, bundle] (wasi/fs.ts Manifest), each `bundle`
// one of the package's `count` tars in `bundles` (N.tar). `version`: a
// digest of the files' paths and bytes.
export interface FsLayer {
  format: number;
  manifest: string;
  bundles: string;
  count: number;
  version: string;
}

export interface FileEntry {
  size: number;
  sha256: string;
}

export interface PackageEntry {
  version: string;
  // Where its files are, relative to site.json.
  base: string;
  files: Record<string, FileEntry>;
  peerDependencies?: Record<string, string>;
  playground: Playground;
}

// What the nodes boot from: gzipped tars of the files IEx and the Phoenix
// server read first (NAME.tar.gz, in `base`), recorded with exactly the
// packages in `packages`, a combination of them, not a package.
export interface Boot {
  base: string;
  images: string[];
  packages: Record<string, string>;
}

export interface SiteManifest {
  manifest: number;
  packages: Record<string, PackageEntry>;
  boot: Boot | null;
}

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

// A program: its module, and whether that is a multi-call one (coreutils.wasm:
// its first argument names the tool), which the exec frame compiles once
// for every node and runs on its caller's thread. Other modules run as
// processes of the worker's table (processes.ts).
export interface Program {
  module: string;
  multicall?: boolean;
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

  // The nodes' tree without its bytes: every layer's manifest, its
  // bundles numbered as the site's. `load` reads one (fetch, or a file).
  async tree(load: (url: URL) => Promise<Manifest> = fetchJson): Promise<Manifest> {
    const layers = await Promise.all(
      this.layers().map(async ({ name, layer, first }) =>
        (await load(this.file(name, layer.manifest))).map(
          ([path, size, mtime, bundle]): Manifest[number] =>
            bundle === undefined ? [path, size, mtime] : [path, size, mtime, first + bundle],
        ),
      ),
    );
    return layers.flat();
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
  boots(): string[] {
    return this.manifest.boot?.images ?? [];
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

  // The OTP and Elixir the site runs: the embedders' contract (embed.md).
  versions(): { otp: string; elixir: string } | null {
    const otp = this.find('otp')?.value;
    const elixir = this.find('elixir')?.value;
    return otp && elixir ? { otp, elixir } : null;
  }

  template(kind: string): { id: string; label: string } | null {
    for (const entry of Object.values(this.manifest.packages)) {
      const template = entry.playground.template;
      if (template?.kind === kind) return { id: template.id, label: template.label };
    }
    return null;
  }
}

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
