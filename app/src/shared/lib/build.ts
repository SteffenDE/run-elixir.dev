import type { PackageDescriptor } from '@elixir-playground/api/types';
import {
  loadManifest,
  type Boot,
  type SiteRef,
} from '@elixir-playground/runtime/packages/manifest';

// The site manifest this page's build runs with, as runtime/build.py
// names it in each page: <meta name="playground-site"> (/site/ID.json,
// docs/packages.md: the packages, and where their files are). It is
// immutable, so a page loaded before a deploy keeps loading its own
// build's files, never a newer one's. The runtime package's path is the
// API's (api/runtimePath.ts).
const meta = (name: string) =>
  document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
export const SITE = meta('playground-site') ?? '/site.json';

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
