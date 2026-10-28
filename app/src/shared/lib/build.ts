import { loadManifest, type SiteRef } from '@/runtime/packages/manifest';

// What this page's build runs with, as runtime/build.py names it in each
// page: <meta name="playground-runtime">, the runtime package's path
// (/npm/@elixir-playground/runtime@VERSION/: the workers, the frames'
// pages), and <meta name="playground-site">, the site manifest's
// (/site/ID.json, docs/packages.md: the other packages, and where their
// files are). Both are immutable, so a page loaded before a deploy keeps
// loading its own build's files, never a newer one's.
const meta = (name: string) =>
  document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
export const BUILD = meta('playground-runtime') ?? '/';
export const SITE = meta('playground-site') ?? '/site.json';

let site: Promise<SiteRef> | null = null;
export function siteManifest(): Promise<SiteRef> {
  site ??= loadManifest(new URL(SITE, location.href));
  return site;
}
