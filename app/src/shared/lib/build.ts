import type { PackageDescriptor } from '@/api/types';
import { loadManifest, type Boot, type SiteRef } from '@/runtime/packages/manifest';

// What this page's build runs with, as runtime/build.py names it in each
// page: <meta name="playground-runtime">, the runtime package's path
// (/npm/@elixir-playground/runtime@VERSION/: the workers, the frames'
// pages), and <meta name="playground-site">, the site manifest's
// (/site/ID.json, docs/packages.md: the other packages, and where their
// files are). Both are immutable, so a page loaded before a deploy keeps
// loading its own build's files, never a newer one's. A page that runs a
// project through the API without them names the runtime itself
// (create()'s `runtime`).
const meta = (name: string) =>
  document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
export const SITE = meta('playground-site') ?? '/site.json';

let runtime = meta('playground-runtime') ?? '/';
// The runtime package's path on the usercontent domain (and the apex's).
export const runtimePath = () => runtime;
export function setRuntimePath(path: string): void {
  runtime = path.endsWith('/') ? path : `${path}/`;
}

let site: Promise<SiteRef> | null = null;
export function siteManifest(): Promise<SiteRef> {
  site ??= loadManifest(new URL(SITE, location.href));
  return site;
}

// The site's packages as create() takes them (api/types.ts
// PackageDescriptor), their bases as paths on the usercontent domain (the
// same site's files); and its boot recordings.
export async function sitePackages(): Promise<{
  packages: PackageDescriptor[];
  boot: Boot | null;
}> {
  const ref = await siteManifest();
  const path = (base: string) => new URL(base, ref.url).pathname;
  const { packages, boot } = ref.manifest;
  return {
    packages: Object.entries(packages).map(([name, entry]) => ({
      name,
      ...entry,
      base: path(entry.base),
    })),
    boot: boot ? { ...boot, base: path(boot.base) } : null,
  };
}
