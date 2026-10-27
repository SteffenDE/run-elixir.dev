// The site manifest (site.json, runtime/build.py; docs/packages.md): the
// packages a site has, their versions, where their files are, and what
// each declares in its package.json's `playground` field. The runtime
// finds the BEAM, its programs and the fs image through it, never by a
// path of the site's own layout: today's site.json is in r/RID/ and points
// beside itself, an npm layout's at /npm/@elixir-playground/NAME@VERSION/.
export const SCOPE = '@elixir-playground';
export const RUNTIME_PACKAGE = `${SCOPE}/runtime`;

// A package.json's `playground` field. Each package fills in what it is.
export interface Playground {
  // The ABI seams the package's files use, each at its version (host.json's
  // `provides` names what the runtime offers).
  abi?: Record<string, number>;
  // Programs by name, each a file of the package's, run with the name as
  // its argv[0] (a multi-call module, such as coreutils.wasm, serves several).
  programs?: Record<string, string>;
  // shell: the terminal's shell (brush.wasm), and the module of its tools
  // (coreutils.wasm), which the page compiles once for every node.
  shell?: string;
  tools?: string;
  // otp-X: its version, the build's beamAbi id, and the emulator's files.
  otp?: string;
  beamAbi?: string;
  beam?: { loader: string; threads: string; wasm: string };
  // elixir-X: its version, and the OTP it runs on (a semver range).
  elixir?: string;
  requires?: { otp?: string };
  // A template: its kind, id (a digest of its files, without its build),
  // label, and the OTP and Elixir it was compiled with.
  template?: { kind: string; id: string; label: string; otp: string; elixir: string };
  // tls: a Node.js process's TLS client and the roots it trusts.
  tls?: { module: string; roots: string };
  // tailscale: the apex's Tailscale node.
  tailscale?: string;
  // claude: the Claude Code versions the preparer was tested with.
  claudeCode?: string;
  // api: the embedding API versions its client speaks.
  apiVersions?: number[];
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

// The filesystem the nodes boot from (fs/: boot images, manifest.json,
// bundles/N.tar, version). One image of several packages' files, recorded
// for exactly the versions in `packages`.
export interface FsImage {
  base: string;
  format: number;
  version: string;
  boots: string[];
  packages: Record<string, string>;
}

// NIF libraries the site bundles (nif/NAME-VERSION.tar), for the BEAM
// build `beamAbi` names.
export interface NifLibraries {
  base: string;
  beamAbi: string;
  libraries: string[];
}

export interface SiteManifest {
  manifest: number;
  packages: Record<string, PackageEntry>;
  fs: FsImage | null;
  nif: NifLibraries | null;
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

// A program's module: its URL, and whether it is the shell's tools'
// multi-call module (coreutils.wasm), which runs on its caller's thread.
export interface Registered {
  url: URL;
  tool: boolean;
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

  // The emulator's loader (beam.mjs), its threads' and its module.
  beam(): { loader: URL; threads: URL; wasm: URL } | null {
    const otp = this.find('beam');
    if (!otp) return null;
    const { loader, threads, wasm } = otp.value;
    return {
      loader: this.file(otp.name, loader),
      threads: this.file(otp.name, threads),
      wasm: this.file(otp.name, wasm),
    };
  }

  // brush.wasm and coreutils.wasm.
  shell(): URL | null {
    const shell = this.find('shell');
    return shell ? this.file(shell.name, shell.value) : null;
  }
  tools(): URL | null {
    const tools = this.find('tools');
    return tools ? this.file(tools.name, tools.value) : null;
  }

  // Every package's programs, by name. A name two packages give is the
  // first one's.
  programs(): Map<string, Registered> {
    const out = new Map<string, Registered>();
    for (const [name, entry] of Object.entries(this.manifest.packages)) {
      const { programs = {}, tools } = entry.playground;
      for (const [program, file] of Object.entries(programs))
        if (!out.has(program))
          out.set(program, { url: this.file(name, file), tool: file === tools });
    }
    return out;
  }

  // A file of the fs image: manifest.json, bundles/N.tar, boot.tar.gz, version.
  fs(path: string): URL {
    const fs = this.manifest.fs;
    if (!fs) throw new Error('this site has no fs image');
    return new URL(path, new URL(fs.base, this.url));
  }

  // A bundled NIF library, or null (the backend's then).
  nif(name: string, version: string): URL | null {
    const nif = this.manifest.nif;
    const library = `${name}-${version}`;
    return nif?.libraries.includes(library)
      ? new URL(`${library}.tar`, new URL(nif.base, this.url))
      : null;
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

  tailscale(): URL | null {
    const tailscale = this.find('tailscale');
    return tailscale ? this.file(tailscale.name, tailscale.value) : null;
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
